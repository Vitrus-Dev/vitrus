// packages/core/test/lifecycle.test.ts
// The lifecycle numbers, and the privacy claims they rest on:
//   1. A user id is hashed before it is stored, the browser pre-hash and the
//      server's own hash land on the SAME value, and no raw id reaches disk.
//   2. Personal data in properties is removed at the door, counted, and the
//      event is kept.
//   3. Growth accounting adds up: active = retained + new + resurrected,
//      previous = retained + churned — on data built so every bucket is known.
//   4. What cannot be measured is null with a reason, never 0.
//   5. The portfolio's per-site people columns equal lifecycle's.

import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { computeLifecycle } from "../src/metrics/lifecycle.ts";
import { computePortfolio } from "../src/metrics/portfolio.ts";
import { isPersonalKey, isPersonalValue, normalizePlan, scrubProps } from "../src/pii.ts";
import { identityId, preHashIdentity } from "../src/visitor.ts";
import { CHROME, DAY, SITE, freshStore, ingestorFor } from "./helpers.ts";
import type { Ingestor } from "../src/ingest.ts";
import type { RawEvent } from "../src/types.ts";
import type { SqliteStore } from "../src/store/sqlite.ts";

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const FROM = NOW - 7 * DAY;

async function act(ing: Ingestor, who: string, now: number, extra: Partial<RawEvent> = {}, site = SITE.id) {
  const r = await ing.ingest(
    { site, type: "pageview", url: "/app", identity: who, ...extra },
    { ip: `198.51.100.${who.length}`, userAgent: CHROME, now, host: SITE.domain }
  );
  if (!r.ok) throw new Error(r.reason);
  return r.event;
}

const life = (store: SqliteStore, from = FROM, to = NOW) =>
  computeLifecycle((sql, params) => store.select(sql, params), { siteId: SITE.id, from, to, bucketMs: DAY });

describe("pii.ts", () => {
  test("drops personal keys whatever their spelling, keeps neighbours that only look alike", () => {
    for (const k of ["email", "Email", "e_mail", "user-email", "phone_number", "firstName", "IP", "tckn", "password", "Date_Of_Birth"]) {
      expect(isPersonalKey(k), k).toBe(true);
    }
    for (const k of ["plan", "plan_name", "email_opt_in", "role", "company_size", "seats"]) expect(isPersonalKey(k), k).toBe(false);
  });

  test("drops values that are an email or an international phone number, not order ids", () => {
    expect(isPersonalValue("ayse@example.com")).toBe(true);
    expect(isPersonalValue("+90 532 123 45 67")).toBe(true);
    expect(isPersonalValue("+1 (415) 555-0100")).toBe(true);
    expect(isPersonalValue("1234567890123")).toBe(false);
    expect(isPersonalValue("ORD-2026-0001")).toBe(false);
    expect(isPersonalValue("pro")).toBe(false);
    expect(isPersonalValue(42)).toBe(false);
  });

  test("scrubProps removes and counts, and leaves internal keys alone", () => {
    const p: Record<string, string | number | boolean | null> = { email: "a@b.co", contact: "a@b.co", plan: "pro", _signal: "x" };
    expect(scrubProps(p)).toBe(2);
    expect(p).toEqual({ plan: "pro", _signal: "x" });
  });

  test("plans are normalised to a label, and anything else is rejected with a reason", () => {
    const a: Record<string, string | number | boolean | null> = { plan: "  Pro " };
    normalizePlan(a);
    expect(a.plan).toBe("pro");
    const b: Record<string, string | number | boolean | null> = { plan: "the pro plan, monthly" };
    normalizePlan(b);
    expect(b.plan).toBeUndefined();
    expect(b._plan_rejected).toBe("plan_not_a_label");
  });
});

describe("the identity, end to end", () => {
  test("the browser pre-hash and a raw id from a server land on the same stored value", () => {
    const browser = createHash("sha256").update(`${SITE.id}|user-42`).digest("hex");
    expect(preHashIdentity(SITE.id, "user-42")).toBe(browser);
    expect(identityId({ secret: "s", siteId: SITE.id, raw: browser })).toBe(identityId({ secret: "s", siteId: SITE.id, raw: "user-42" }));
  });

  test("no raw id and no personal property reaches disk; the event is kept and the removal counted", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    await act(ing, "ayse@example.com", NOW - 1000, {
      type: "event",
      name: "identify",
      props: { email: "ayse@example.com", phone: "+90 532 123 45 67", plan: "PRO", contact: "ayse@example.com" },
    });
    const rows = await store.select<{ identity: string; props: string }>(`SELECT identity, props FROM events`);
    expect(rows).toHaveLength(1);
    const disk = JSON.stringify(rows);
    expect(disk).not.toContain("ayse");
    expect(disk).not.toContain("532");
    const props = JSON.parse(rows[0]!.props);
    expect(props.plan).toBe("pro");
    expect(props._pii_dropped).toBe(3);
    // It arrived raw (not browser-hashed), so the privacy check can say so.
    expect(props._id_raw).toBe(true);
  });

  test("a browser-hashed id is not flagged as raw", async () => {
    const store = await freshStore();
    const ev = await act(ingestorFor(store), preHashIdentity(SITE.id, "u1"), NOW - 1000);
    expect(ev.props._id_raw).toBeUndefined();
  });
});

describe("computeLifecycle", () => {
  test("with nobody identified it says why and how to fix it, and shows no zeros", async () => {
    const store = await freshStore();
    await ingestorFor(store).ingest({ site: SITE.id, type: "pageview", url: "/" }, { ip: "1.2.3.4", userAgent: CHROME, now: NOW - 1000 });
    const r = await life(store);
    expect(r.available).toBe(false);
    if (r.available) return;
    expect(r.reason).toBe("no_identity");
    expect(r.remedy).toContain("vitrus.identify(user.id)");
    expect(r.sql).toContain("identity <> ''");
  });

  test("strict mode reports strict_mode, not an empty page", async () => {
    const store = await freshStore();
    const r = await computeLifecycle((s, p) => store.select(s, p), { siteId: SITE.id, from: FROM, to: NOW, bucketMs: DAY, privacyMode: "strict" });
    expect(r.available).toBe(false);
    if (!r.available) expect(r.reason).toBe("strict_mode");
  });

  test("growth accounting: every bucket is known in advance and the identities add up", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    const prev = FROM - 3 * DAY; // inside the previous window
    const old = FROM - 30 * DAY; // before it
    // retained: active in both windows
    await act(ing, "ret-1", prev); await act(ing, "ret-1", NOW - DAY);
    await act(ing, "ret-2", prev); await act(ing, "ret-2", NOW - 2 * DAY);
    // churned: previous window only
    await act(ing, "gone-1", prev);
    await act(ing, "gone-2", prev); await act(ing, "gone-2", prev + 3600_000);
    await act(ing, "gone-3", prev);
    // resurrected: seen long ago, quiet in the previous window, back now
    await act(ing, "back-1", old); await act(ing, "back-1", NOW - 3 * DAY);
    // new: first ever seen inside this window (one of them twice)
    await act(ing, "new-1", NOW - 6 * DAY); await act(ing, "new-1", NOW - DAY);
    await act(ing, "new-2", NOW - 2 * DAY);
    await act(ing, "new-3", NOW - 1000);
    // a bot carrying an identity never counts
    await ing.ingest({ site: SITE.id, type: "pageview", url: "/", identity: "bot-1" },
      { ip: "9.9.9.9", userAgent: "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)", now: NOW - 1000 });

    const r = await life(store);
    expect(r.available).toBe(true);
    if (!r.available) return;
    const a = r.accounting.rows[0]!;
    expect(a).toMatchObject({ active: 6, prev_active: 5, new_users: 3, retained: 2, resurrected: 1, churned: 3 });
    expect(a.active).toBe(a.retained + a.new_users + a.resurrected);
    expect(a.prev_active).toBe(a.retained + a.churned);
    expect(r.gained).toBe(4);
    expect(r.lost).toBe(3);
    expect(r.net).toBe(1);
    expect(r.quickRatio).toBe(1.33);
    expect(r.retainedRate).toBe(40);
    // The evidence is the SQL that ran, with its parameters.
    expect(r.accounting.sql).toContain("GROUP BY identity");
    expect(r.accounting.params).toContain(SITE.id);
  });

  test("one-and-done counts only people who had a week to come back, and is null for a short range", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    const from = NOW - 30 * DAY;
    await act(ing, "once-1", NOW - 20 * DAY);
    await act(ing, "once-2", NOW - 15 * DAY);
    await act(ing, "twice", NOW - 20 * DAY); await act(ing, "twice", NOW - 12 * DAY);
    await act(ing, "too-new", NOW - 2 * DAY); // first seen < 7 days ago: not eligible
    const r = await life(store, from, NOW);
    if (!r.available) throw new Error("expected data");
    expect(r.oneAndDone.rows[0]).toEqual({ eligible: 3, one_day: 2 });
    expect(r.oneAndDoneRate).toBe(66.7);

    const short = await life(store, NOW - 3 * DAY, NOW);
    if (!short.available) throw new Error("expected data");
    expect(short.oneAndDoneRate).toBeNull();
    expect(short.oneAndDoneNote).toContain("longer than 7 days");
  });

  test("plans: current distribution, became paying and stopped paying", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    const ev = (who: string, plan: string, t: number) => act(ing, who, t, { type: "event", name: "plan", props: { plan } });
    await ev("a", "free", FROM - DAY); await ev("a", "pro", NOW - 2 * DAY); // upgrade in range
    await ev("b", "Pro", NOW - 3 * DAY); // first plan already paid: counts as became paying
    await ev("c", "pro", FROM - 2 * DAY); await ev("c", "cancelled", NOW - DAY); // stopped paying
    await ev("d", "free", NOW - DAY); // free, no move
    await ev("e", "team", FROM - 5 * DAY); await ev("e", "team", NOW - DAY); // paid, unchanged
    await act(ing, "f", NOW - DAY, { type: "event", name: "signup" });
    await act(ing, "f", NOW - DAY + 1000, { type: "event", name: "login" });

    const r = await life(store);
    if (!r.available) throw new Error("expected data");
    const plans = Object.fromEntries(r.plans.rows.map((x) => [x.plan, x.users]));
    expect(plans).toEqual({ pro: 2, team: 1, free: 1, cancelled: 1 });
    expect(r.upgrades.rows).toEqual([{ plan: "pro", users: 2 }]);
    expect(r.downgrades.rows).toEqual([{ plan: "cancelled", users: 1 }]);
    const evs = Object.fromEntries(r.events.rows.map((x) => [x.name, x.users]));
    expect(evs).toEqual({ login: 1, signup: 1 });
  });

  test("the privacy check counts raw ids and removed personal data in the range", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    await act(ing, "raw-id", NOW - 1000, { type: "event", name: "identify", props: { email: "x@y.io" } });
    await act(ing, preHashIdentity(SITE.id, "hashed"), NOW - 1000);
    const r = await life(store);
    if (!r.available) throw new Error("expected data");
    expect(r.privacy.rows[0]).toEqual({ raw_ids: 1, pii_dropped: 1, plan_rejected: 0 });
  });
});

describe("computePortfolio", () => {
  test("per-site people columns equal lifecycle's, totals add sites, strict sites are null not 0", async () => {
    const store = await freshStore();
    await store.upsertSite({ id: "second", name: "Second", domain: "two.example", vertical: "generic", createdAt: 0 });
    await store.upsertSite({ id: "locked", name: "Locked", domain: "three.example", vertical: "generic", createdAt: 0 });
    const ing = ingestorFor(store);
    await act(ing, "p1", FROM - 2 * DAY); await act(ing, "p1", NOW - DAY);
    await act(ing, "p2", NOW - DAY, { type: "event", name: "signup", props: { plan: "free" } });
    await act(ing, "p2", NOW - 1000, { type: "event", name: "plan", props: { plan: "pro", revenue: 29, currency: "USD" } });
    await act(ing, "p3", FROM - 2 * DAY);
    // the same person on the second site is a different identity there
    await act(ing, "p1", NOW - DAY, {}, "second");
    await act(ing, "q1", NOW - DAY, { type: "event", name: "purchase", props: { revenue: 10, currency: "USD" } }, "second");

    const sites = [
      { id: SITE.id, name: "Demo", domain: SITE.domain },
      { id: "second", name: "Second", domain: "two.example" },
      { id: "locked", name: "Locked", domain: "three.example" },
    ];
    const p = await computePortfolio((s, prm) => store.select(s, prm), { sites, from: FROM, to: NOW, strict: ["locked"] });
    const one = p.rows[0]!;
    const l = await life(store);
    if (!l.available) throw new Error("expected data");
    const acc = l.accounting.rows[0]!;
    expect(one.people).toEqual({
      known: acc.known, active: acc.active, newUsers: acc.new_users, resurrected: acc.resurrected, churned: acc.churned, prevActive: acc.prev_active,
    });
    expect(one.signups).toBe(1);
    expect(one.becamePaying).toBe(1);
    expect(one.paying).toBe(1);
    expect(p.rows[1]!.people?.active).toBe(2);
    expect(p.rows[2]!.people).toBeNull();
    expect(p.totals.active).toBe(acc.active + 2);
    expect(p.totals.revenue).toEqual([{ currency: "USD", revenue: 39, orders: 2 }]);
    expect(p.evidence.people.sql).toContain("GROUP BY site_id, identity");
  });

  test("an empty workspace is valid SQL and all zeros only where zero was measured", async () => {
    const store = await freshStore();
    const p = await computePortfolio((s, prm) => store.select(s, prm), { sites: [], from: FROM, to: NOW });
    expect(p.rows).toEqual([]);
    expect(p.totals.sites).toBe(0);
  });
});
