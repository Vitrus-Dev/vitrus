// packages/core/test/retention.test.ts
// Retention — the place this product has to be most honest.
//
// The most important test: on anonymous traffic NO retention is produced. The
// visitor id changes every day, so emitting a "returning users" number would
// present the unmeasured as measured. We return the reason and the remedy instead.

import { describe, expect, test } from "bun:test";
import { computeRetention } from "../src/metrics/retention.ts";
import { identityId } from "../src/visitor.ts";
import { DAY, MIN, SITE, freshStore, ingestorFor } from "./helpers.ts";
import type { SqliteStore } from "../src/store/sqlite.ts";
import type { Ingestor } from "../src/ingest.ts";

const NOW = Date.UTC(2026, 8, 12, 12, 0, 0);
const FROM = NOW - 10 * DAY;

function run(store: SqliteStore) {
  return computeRetention((sql, params) => store.select(sql, params), {
    siteId: SITE.id,
    from: FROM,
    to: NOW,
  });
}

/** Send an identified visit (as if the site owner had called identify()). */
async function visit(ing: Ingestor, who: string, now: number, ip = "203.0.113.1") {
  return ing.ingest(
    { site: SITE.id, type: "pageview", url: "/", identity: who },
    { ip, userAgent: "Mozilla/5.0 Chrome/131.0", now }
  );
}

describe("the identity hash", () => {
  test("PERSISTENT: unchanged across days (unlike visitorId)", () => {
    const a = identityId({ secret: "s", siteId: "demo", raw: "user-1" });
    const b = identityId({ secret: "s", siteId: "demo", raw: "user-1" });
    expect(a).toBe(b);
    expect(a).not.toBe("");
  });

  test("it is per-site — the same user cannot be joined across two sites", () => {
    const a = identityId({ secret: "s", siteId: "site-a", raw: "user-1" });
    const b = identityId({ secret: "s", siteId: "site-b", raw: "user-1" });
    expect(a).not.toBe(b);
  });

  test("the raw identity never reaches DISK", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    await visit(ing, "ahmet@example.com", NOW - MIN);
    const rows = await store.select<{ identity: string }>(`SELECT identity FROM events`);
    expect(rows[0]?.identity).not.toContain("@");
    expect(rows[0]?.identity).not.toContain("ahmet");
    expect(rows[0]?.identity).toHaveLength(32);
  });

  test("without identify(), the identity stays empty", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    await ing.ingest(
      { site: SITE.id, type: "pageview", url: "/" },
      { ip: "1.1.1.1", userAgent: "Mozilla/5.0 Chrome/131.0", now: NOW }
    );
    const rows = await store.select<{ identity: string }>(`SELECT identity FROM events`);
    expect(rows[0]?.identity).toBe("");
  });
});

describe("computeRetention", () => {
  test("NOT produced on anonymous traffic — the reason and the remedy come back", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    for (let d = 0; d < 5; d++) {
      await ing.ingest(
        { site: SITE.id, type: "pageview", url: "/" },
        { ip: `10.0.0.${d}`, userAgent: "Mozilla/5.0 Chrome/131.0", now: NOW - d * DAY }
      );
    }
    const res = await run(store);
    expect(res.available).toBe(false);
    if (!res.available) {
      expect(res.reason).toBe("no_identity");
      // We never leave a silently empty table: the reason and the remedy must be in the text.
      expect(res.message).toContain("changes every day");
      expect(res.remedy).toContain("identify");
      // The evidence is still there: we can show which query came back empty.
      expect(res.sql).toContain("SELECT");
    }
  });

  test("with identified users it produces a cohort matrix", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    const cohortDay = NOW - 5 * DAY;
    // 4 users arrive for the first time on the same day
    for (let i = 0; i < 4; i++) await visit(ing, `u${i}`, cohortDay, `10.1.0.${i}`);
    // 2 of them return the next day
    await visit(ing, "u0", cohortDay + DAY, "10.1.0.0");
    await visit(ing, "u1", cohortDay + DAY, "10.1.0.1");
    // 1 returns 3 days later
    await visit(ing, "u0", cohortDay + 3 * DAY, "10.1.0.0");

    const res = await run(store);
    expect(res.available).toBe(true);
    if (!res.available) return;

    expect(res.identified).toBe(4);
    const cohort = res.cohorts[0];
    expect(cohort?.size).toBe(4);
    expect(cohort?.cells[0]).toMatchObject({ offset: 0, users: 4, rate: 100 });
    expect(cohort?.cells[1]).toMatchObject({ offset: 1, users: 2, rate: 50 });
    expect(cohort?.cells[2]).toMatchObject({ offset: 2, users: 0, rate: 0 });
    expect(cohort?.cells[3]).toMatchObject({ offset: 3, users: 1, rate: 25 });
  });

  test("no cell reaches into the FUTURE — the unmeasured must not look like 0%", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    // The cohort is yesterday: only offsets 0 and 1 are measurable, 2..7 have not happened.
    await visit(ing, "dun", NOW - DAY, "10.2.0.1");
    const res = await run(store);
    expect(res.available).toBe(true);
    if (!res.available) return;
    const cohort = res.cohorts.at(-1);
    expect(cohort?.cells.length).toBeLessThanOrEqual(2);
    expect(cohort?.cells.every((c) => c.offset <= 1)).toBe(true);
  });

  test("the cohort day = the day the user was FIRST seen", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    await visit(ing, "erken", NOW - 6 * DAY, "10.3.0.1");
    await visit(ing, "erken", NOW - 2 * DAY, "10.3.0.1");
    await visit(ing, "gec", NOW - 2 * DAY, "10.3.0.2");

    const res = await run(store);
    if (!res.available) throw new Error("matris beklendi");
    expect(res.cohorts).toHaveLength(2);
    expect(res.cohorts[0]?.size).toBe(1); // the cohort from 6 days ago
    expect(res.cohorts[1]?.size).toBe(1); // the cohort from 2 days ago
    // "early" does NOT count toward the second cohort; it returns at offset 4 in its own.
    expect(res.cohorts[0]?.cells.find((c) => c.offset === 4)?.users).toBe(1);
  });

  test("the average curve is computed from the cohorts that could be measured", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    const day = NOW - 5 * DAY;
    for (let i = 0; i < 10; i++) await visit(ing, `e${i}`, day, `10.4.0.${i}`);
    for (let i = 0; i < 3; i++) await visit(ing, `e${i}`, day + DAY, `10.4.0.${i}`);

    const res = await run(store);
    if (!res.available) throw new Error("matris beklendi");
    expect(res.curve[0]).toMatchObject({ offset: 0, rate: 100 });
    expect(res.curve[1]).toMatchObject({ offset: 1, rate: 30 });
  });

  test("botlar kohorta girmez", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    await ing.ingest(
      { site: SITE.id, type: "pageview", url: "/", identity: "bot-user" },
      { ip: "52.0.0.1", userAgent: "Mozilla/5.0 (compatible; GPTBot/1.2)", now: NOW - 2 * DAY }
    );
    const res = await run(store);
    expect(res.available).toBe(false);
  });
});
