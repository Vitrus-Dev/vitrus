// packages/core/test/people.test.ts
// One app's users, one row each. The claims:
//   1. Status follows the stated rules (returning / one-time / signed up only),
//      and the summary counts equal the rows.
//   2. Automatic and lifecycle events are not "actions"; a purchase is.
//   3. A row carries a hash and a made-up name — never the id that was sent.
//   4. Bad input (segment, sort, ids) is refused, not ignored.

import { describe, expect, test } from "bun:test";
import { aliasOf, listPeople, personDetail, PeopleError } from "../src/metrics/people.ts";
import { CHROME, DAY, SITE, freshStore, ingestorFor } from "./helpers.ts";
import type { Ingestor } from "../src/ingest.ts";
import type { RawEvent } from "../src/types.ts";
import type { SqliteStore } from "../src/store/sqlite.ts";

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

async function ev(ing: Ingestor, who: string, t: number, extra: Partial<RawEvent> = {}, ip = "198.51.100.1") {
  const r = await ing.ingest({ site: SITE.id, type: "pageview", url: "/app", identity: who, ...extra }, { ip, userAgent: CHROME, now: t, host: SITE.domain });
  if (!r.ok) throw new Error(r.reason);
}
const people = (store: SqliteStore, o: Record<string, unknown> = {}) =>
  listPeople((s, p) => store.select(s, p), { siteId: SITE.id, now: NOW, ...o });

async function seed() {
  const store = await freshStore();
  const ing = ingestorFor(store);
  // returning: two days, lessons and an AI edit, on the pro plan
  await ev(ing, "ayse@example.com", NOW - 20 * DAY, { type: "event", name: "signup", props: { plan: "free" } });
  await ev(ing, "ayse@example.com", NOW - 20 * DAY + 60_000, { type: "event", name: "lesson_created" });
  await ev(ing, "ayse@example.com", NOW - 2 * DAY, { type: "event", name: "ai_edit" });
  await ev(ing, "ayse@example.com", NOW - 2 * DAY + 60_000, { type: "event", name: "ai_edit" });
  await ev(ing, "ayse@example.com", NOW - 2 * DAY + 90_000, { type: "event", name: "plan", props: { plan: "pro" } });
  // one-time: one day, one purchase (an action), automatic events that are not
  await ev(ing, "u2", NOW - 10 * DAY, { type: "event", name: "purchase", props: { revenue: 9, currency: "USD" } });
  await ev(ing, "u2", NOW - 10 * DAY + 1000, { type: "event", name: "scroll", props: { percent: 80 } });
  // signed up only: one day, only lifecycle and automatic events
  await ev(ing, "u3", NOW - 3 * DAY, { type: "event", name: "signup" });
  await ev(ing, "u3", NOW - 3 * DAY + 1000, { type: "event", name: "web_vitals", props: { lcp: 1200 } });
  await ev(ing, "u3", NOW - 3 * DAY + 2000, { type: "event", name: "login" });
  return store;
}

describe("listPeople", () => {
  test("status, actions, days and visits follow the stated rules; the summary equals the rows", async () => {
    const store = await seed();
    const r = await people(store);
    const s = r.summary.rows[0]!;
    expect(s).toMatchObject({ known: 3, returning: 1, one_time: 1, signed_up_only: 1, active_7d: 2, active_30d: 3, new_30d: 3, new_30d_returned: 1 });
    expect(r.total).toBe(3);
    const by = Object.fromEntries(r.list.rows.map((x) => [x.status, x]));
    expect(by.returning).toMatchObject({ actions: 3, days: 2, visits: 2, plan: "pro" });
    expect(by.one_time).toMatchObject({ actions: 1, days: 1 });
    expect(by.signed_up_only).toMatchObject({ actions: 0, days: 1, plan: null });
    // Sorted by last active, newest first.
    expect(r.list.rows.map((x) => x.status)).toEqual(["returning", "signed_up_only", "one_time"]);
    // Top actions per row, most frequent first.
    const top = r.top.rows.filter((x) => x.identity === by.returning!.identity);
    expect(top).toEqual([
      { identity: by.returning!.identity, name: "ai_edit", n: 2 },
      { identity: by.returning!.identity, name: "lesson_created", n: 1 },
    ]);
    expect(r.dataFrom).toBe(NOW - 20 * DAY);
  });

  test("a row is a hash and a made-up name; the id that was sent appears nowhere", async () => {
    const store = await seed();
    const r = await people(store);
    expect(JSON.stringify(r)).not.toContain("ayse");
    for (const row of r.list.rows) {
      expect(row.identity).toMatch(/^[0-9a-f]{32}$/);
      expect(row.alias).toBe(aliasOf(row.identity));
      expect(row.alias).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ · [0-9a-f]{6}$/);
    }
  });

  test("segments, plan, ids and sort narrow the list; the total follows", async () => {
    const store = await seed();
    expect((await people(store, { segment: "returning" })).list.rows).toHaveLength(1);
    expect((await people(store, { plan: "pro" })).total).toBe(1);
    const all = await people(store);
    const one = all.list.rows[1]!.identity;
    const only = await people(store, { ids: [one] });
    expect(only.list.rows.map((x) => x.identity)).toEqual([one]);
    expect((await people(store, { sort: "actions" })).list.rows[0]!.status).toBe("returning");
    expect((await people(store, { sort: "joined" })).list.rows[0]!.status).toBe("signed_up_only");
  });

  test("bad input is refused, not ignored", async () => {
    const store = await seed();
    await expect(people(store, { segment: "vip" })).rejects.toThrow(PeopleError);
    await expect(people(store, { sort: "email" })).rejects.toThrow(PeopleError);
    await expect(people(store, { ids: ["ayse@example.com"] })).rejects.toThrow(PeopleError);
  });

  test("an empty site is a valid, empty answer with no data date", async () => {
    const store = await freshStore();
    const r = await people(store);
    expect(r.summary.rows[0]!.known).toBe(0);
    expect(r.list.rows).toEqual([]);
    expect(r.dataFrom).toBeNull();
  });
});

describe("personDetail", () => {
  test("actions by day and recent visits, newest first; automatic events left out", async () => {
    const store = await seed();
    const id = (await people(store, { segment: "returning" })).list.rows[0]!.identity;
    const d = await personDetail((s, p) => store.select(s, p), SITE.id, id);
    const days = [...new Set(d.byDay.rows.map((x) => x.day))];
    expect(days).toEqual([Math.floor((NOW - 2 * DAY) / DAY) * DAY, Math.floor((NOW - 20 * DAY) / DAY) * DAY]);
    expect(d.byDay.rows[0]).toMatchObject({ total: 2, name: "ai_edit", n: 2 });
    expect(d.visits.rows).toHaveLength(2);
    expect(d.visits.rows[0]!.started).toBeGreaterThan(d.visits.rows[1]!.started);
    await expect(personDetail((s, p) => store.select(s, p), SITE.id, "nope")).rejects.toThrow(PeopleError);
  });
});
