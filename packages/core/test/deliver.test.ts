// packages/core/test/deliver.test.ts
// Digest delivery. The most critical claim: NOTHING IS SENT TWICE, and because a
// failed delivery is never written to the ledger, the next tick retries it.

import { describe, expect, test } from "bun:test";
import { composeDigest } from "../src/insight/compose.ts";
import { buildBundle, previousWindow, windowOf } from "../src/metrics/bundle.ts";
import {
  addSubscription,
  alreadySent,
  deliveryKey,
  emailHtml,
  emailSubject,
  listSubscriptions,
  migrateDelivery,
  periodStart,
  removeSubscription,
  slackBlocks,
  tick,
  windowForPeriod,
  worthSending,
  type Subscription,
  type TickOutcome,
} from "../src/index.ts";
import { DAY, MIN, SITE, freshStore, ingestorFor, send } from "./helpers.ts";
import type { SqliteStore } from "../src/store/sqlite.ts";
import type { Digest } from "../src/insight/compose.ts";

const NOW = Date.UTC(2026, 8, 12, 12, 0, 0); // Cumartesi

async function storeWithDelivery(): Promise<SqliteStore> {
  const store = await freshStore();
  await migrateDelivery(store);
  return store;
}

async function realDigest(store: SqliteStore): Promise<{ digest: Digest; visitors: number }> {
  const win = windowOf(NOW, 7, "last 7 days");
  const bundle = await buildBundle(store, {
    siteId: SITE.id,
    vertical: "landing",
    window: win,
    compare: previousWindow(win),
    now: NOW,
  });
  const visitors = bundle.evidence.find((e) => e.metric === "visitors.unique")?.value ?? 0;
  return { digest: composeDigest(bundle), visitors };
}

describe("periodStart", () => {
  test("a weekly period aligns to MONDAY 00:00 UTC", () => {
    const p = periodStart(NOW, "weekly");
    const d = new Date(p);
    expect(d.getUTCDay()).toBe(1); // Pazartesi
    expect(d.getUTCHours()).toBe(0);
    expect(p).toBeLessThanOrEqual(NOW);
  });

  test("different moments in the same week give the SAME period — no drift", () => {
    const mon = Date.UTC(2026, 8, 7, 0, 0, 1);
    const fri = Date.UTC(2026, 8, 11, 23, 59);
    expect(periodStart(mon, "weekly")).toBe(periodStart(fri, "weekly"));
  });

  test("the following week is a different period", () => {
    expect(periodStart(NOW, "weekly")).not.toBe(periodStart(NOW + 7 * DAY, "weekly"));
  });

  test("a daily period aligns to the start of the day", () => {
    const p = periodStart(NOW, "daily");
    expect(new Date(p).getUTCHours()).toBe(0);
  });

  test("the window looks BACK from the period — we never summarise the future", () => {
    const p = periodStart(NOW, "weekly");
    const w = windowForPeriod(p, "weekly");
    expect(w.to).toBe(p);
    expect(w.to - w.from).toBe(7 * DAY);
  });
});

describe("abonelikler", () => {
  test("eklenir, listelenir, silinir", async () => {
    const store = await storeWithDelivery();
    const sub = await addSubscription(store, { siteId: SITE.id, kind: "slack", target: "https://hooks.slack/x" }, NOW);
    expect((await listSubscriptions(store, SITE.id))).toHaveLength(1);
    await removeSubscription(store, sub.id);
    expect((await listSubscriptions(store, SITE.id))).toHaveLength(0);
  });
});

describe("worthSending", () => {
  test("with no visitors NOTHING IS SENT — notification fatigue", async () => {
    const store = await storeWithDelivery();
    const { digest } = await realDigest(store);
    expect(worthSending(digest, 0)).toBe(false);
  });

  test("with data, it is sent", async () => {
    const store = await storeWithDelivery();
    const ing = ingestorFor(store);
    for (let i = 0; i < 3; i++) await send(ing, { now: NOW - DAY, ip: `10.0.0.${i}` });
    const { digest, visitors } = await realDigest(store);
    expect(worthSending(digest, visitors)).toBe(true);
  });
});

describe("tick — double-send protection", () => {
  async function harness() {
    const store = await storeWithDelivery();
    const ing = ingestorFor(store);
    for (let i = 0; i < 4; i++) await send(ing, { now: NOW - 2 * DAY, ip: `10.1.0.${i}` });
    await send(ing, { now: NOW - 2 * DAY + MIN, ip: "10.1.0.0", type: "event", name: "cta_click" });
    await addSubscription(store, { siteId: SITE.id, kind: "slack", target: "https://hooks/x" }, NOW);
    return store;
  }

  function deps(store: SqliteStore, deliver: (s: Subscription, d: Digest) => Promise<{ ok: boolean; error?: string }>) {
    return {
      store,
      now: NOW,
      build: async () => realDigest(store),
      deliver,
    };
  }

  test("the first tick sends, the second SKIPS", async () => {
    const store = await harness();
    const sent: string[] = [];
    const d = deps(store, async (s) => {
      sent.push(s.id);
      return { ok: true };
    });

    const first = await tick(d);
    expect(first[0]?.status).toBe("sent");

    const second = await tick(d);
    expect(second[0]?.status).toBe("skipped");
    if (second[0]?.status === "skipped") expect(second[0].reason).toBe("already_sent");

    expect(sent).toHaveLength(1); // it really was sent once
  });

  test("a FAILED delivery is NOT written to the ledger — the next tick retries", async () => {
    const store = await harness();
    let attempt = 0;
    const failing = deps(store, async () => {
      attempt++;
      return { ok: false, error: "slack_500" };
    });

    const first = await tick(failing);
    expect(first[0]?.status).toBe("failed");

    // The ledger must be empty, otherwise that week would be lost permanently.
    const sub = (await listSubscriptions(store))[0] as Subscription;
    expect(await alreadySent(store, deliveryKey(sub, periodStart(NOW, "weekly")))).toBe(false);

    const second = await tick(failing);
    expect(second[0]?.status).toBe("failed");
    expect(attempt).toBe(2); // it really was retried
  });

  test("once the error clears, delivery completes and is written to the ledger", async () => {
    const store = await harness();
    let fail = true;
    const d = deps(store, async () => (fail ? { ok: false, error: "down" } : { ok: true }));

    expect((await tick(d))[0]?.status).toBe("failed");
    fail = false;
    expect((await tick(d))[0]?.status).toBe("sent");
    expect((await tick(d))[0]?.status).toBe("skipped");
  });

  test("an empty period is not sent and is NOT logged (so late-arriving data is not missed)", async () => {
    const store = await storeWithDelivery();
    await addSubscription(store, { siteId: SITE.id, kind: "email", target: "a@b.co" }, NOW);
    const outcomes: TickOutcome[] = await tick({
      store,
      now: NOW,
      build: async () => realDigest(store),
      deliver: async () => ({ ok: true }),
    });
    expect(outcomes[0]?.status).toBe("skipped");
    if (outcomes[0]?.status === "skipped") expect(outcomes[0].reason).toBe("empty");

    const sub = (await listSubscriptions(store))[0] as Subscription;
    expect(await alreadySent(store, deliveryKey(sub, periodStart(NOW, "weekly")))).toBe(false);
  });

  test("a site subscribed to two channels gets BOTH (separate keys)", async () => {
    const store = await harness();
    await addSubscription(store, { siteId: SITE.id, kind: "email", target: "a@b.co" }, NOW);
    const targets: string[] = [];
    const out = await tick(
      deps(store, async (s) => {
        targets.push(s.kind);
        return { ok: true };
      })
    );
    expect(out.filter((o) => o.status === "sent")).toHaveLength(2);
    expect(targets.sort()).toEqual(["email", "slack"]);
  });
});

describe("channel formats", () => {
  async function sampleDigest(): Promise<Digest> {
    const store = await storeWithDelivery();
    const ing = ingestorFor(store);
    for (let i = 0; i < 3; i++) {
      await send(ing, { now: NOW - DAY, ip: `10.2.0.${i}`, referrer: "https://chatgpt.com/" });
    }
    return (await realDigest(store)).digest;
  }

  test("Slack blocks carry a header and an evidence link", async () => {
    const digest = await sampleDigest();
    const payload = slackBlocks(digest, "https://app.vitrus.dev") as { blocks: { type: string }[] };
    expect(payload.blocks[0]?.type).toBe("header");
    expect(JSON.stringify(payload)).toContain("app.vitrus.dev/app?site=");
  });

  test("the email subject derives from the digest's EVIDENCE-BACKED headline", async () => {
    const digest = await sampleDigest();
    const subject = emailSubject(digest);
    expect(subject).toStartWith("Vitrus · ");
    expect(subject.length).toBeLessThanOrEqual(140);
  });

  test("the email HTML is escaped and links to the evidence", async () => {
    const digest = await sampleDigest();
    const html = emailHtml(digest, "https://app.vitrus.dev");
    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain("See the evidence");
    expect(html).not.toMatch(/<script/i);
  });

  test("a degraded digest is stated PLAINLY to the user", async () => {
    const digest = { ...(await sampleDigest()), degraded: true };
    expect(emailHtml(digest, "https://x")).toContain("could not be verified");
    expect(JSON.stringify(slackBlocks(digest, "https://x"))).toContain("could not be verified");
  });
});
