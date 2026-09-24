// packages/core/test/explore.test.ts
// Sessions, users, event properties, error occurrences, journeys, goals.
// Every list returns the query that produced it; the tests re-run that query
// and check the same rows come back, and check the site bound holds.

import { beforeEach, describe, expect, test } from "bun:test";
import { freshStore, ingestorFor, CHROME, IPHONE, SITE } from "./helpers.ts";
import type { SqliteStore } from "../src/store/sqlite.ts";
import {
  computeGoal,
  computeJourneys,
  errorOccurrences,
  eventDetail,
  filterSuggestions,
  GoalError,
  listSessions,
  listUsers,
  pathPatternRegex,
  sessionTimeline,
  userProfile,
  validateGoal,
} from "../src/metrics/explore.ts";
import { parseFilters } from "../src/metrics/filters.ts";
import type { RawEvent } from "../src/types.ts";

const NOW = Date.UTC(2026, 8, 19, 12, 0, 0);
const T = NOW - 3_600_000;
let store: SqliteStore;
const sel = <R,>(sql: string, p?: unknown[]) => store.select<R>(sql, p);

async function hit(ip: string, ua: string, at: number, body: Partial<RawEvent>) {
  const r = await ingestorFor(store).ingest(
    { site: SITE.id, type: "pageview", url: "/", ...body } as RawEvent,
    { ip, userAgent: ua, now: at, host: SITE.domain, country: "DE" }
  );
  if (!r.ok) throw new Error(r.reason);
  return r.event;
}

beforeEach(async () => {
  store = await freshStore();
  // A (identified): / → /pricing → /pricing (reload) → /signup, plan=pro
  await hit("198.51.100.1", CHROME, T, { url: "/", identity: "user-1" });
  await hit("198.51.100.1", CHROME, T + 1000, { url: "/pricing", identity: "user-1" });
  await hit("198.51.100.1", CHROME, T + 2000, { url: "/pricing", identity: "user-1" });
  await hit("198.51.100.1", CHROME, T + 3000, { url: "/signup", identity: "user-1" });
  await hit("198.51.100.1", CHROME, T + 4000, {
    type: "event",
    name: "signup",
    props: { plan: "pro" },
    identity: "user-1",
  });
  await hit("198.51.100.1", CHROME, T + 4500, {
    type: "event",
    name: "identify",
    props: { name: "Ada", company: "Acme" },
    identity: "user-1",
  });
  // B (anonymous): / → /pricing, an error
  await hit("203.0.113.2", IPHONE, T, { url: "/" });
  await hit("203.0.113.2", IPHONE, T + 1000, { url: "/pricing" });
  await hit("203.0.113.2", IPHONE, T + 1500, {
    type: "event",
    name: "error",
    url: "/pricing",
    props: { message: "x is undefined", source: "app.js", line: 3 },
  });
  // C (anonymous): /blog/a, signup plan=free
  await hit("203.0.113.3", CHROME, T, { url: "/blog/a" });
  await hit("203.0.113.3", CHROME, T + 500, { type: "event", name: "signup", props: { plan: "free" }, url: "/blog/a" });
});

const scope = { siteId: SITE.id, from: NOW - 7 * 86_400_000, to: NOW };

describe("sessions", () => {
  test("lists sessions whole, newest first, with entry and exit pages", async () => {
    const { total, list } = await listSessions(sel, scope);
    expect(total.rows[0]?.n).toBe(3);
    const a = list.rows.find((r) => r.identity !== "")!;
    expect(a.pageviews).toBe(4);
    expect(a.events).toBe(2);
    expect(a.entry_page).toBe("/");
    expect(a.exit_page).toBe("/signup");
    expect(a.duration).toBe(4);
    // The evidence re-runs to the same rows.
    expect(await store.select<unknown>(list.sql, list.params)).toEqual(list.rows as unknown[]);
  });

  test("a filter selects sessions but keeps them whole", async () => {
    const { list } = await listSessions(sel, { ...scope, filters: parseFilters("path:/signup") });
    expect(list.rows.length).toBe(1);
    // Not cut down to its /signup row.
    expect(list.rows[0]!.pageviews).toBe(4);
  });

  test("the timeline is every event in order, and a foreign site sees nothing", async () => {
    const { list } = await listSessions(sel, scope);
    const id = list.rows.find((r) => r.identity !== "")!.session_id;
    const tl = await sessionTimeline(sel, SITE.id, id);
    expect(tl.rows.map((r) => r.path)).toEqual(["/", "/pricing", "/pricing", "/signup", "/", "/"]);
    const leak = await sessionTimeline(sel, "someone-else", id);
    expect(leak.rows).toEqual([]);
  });

  test("paging is bounded", async () => {
    const { list } = await listSessions(sel, { ...scope, limit: 1, offset: 1 });
    expect(list.rows.length).toBe(1);
    const huge = await listSessions(sel, { ...scope, limit: 10_000 });
    expect(huge.list.params).toContain(200);
  });
});

describe("users", () => {
  test("identified users are the hash, never the raw id", async () => {
    const { total, list } = await listUsers(sel, scope);
    expect(total.rows[0]?.n).toBe(1);
    expect(list.rows[0]!.id).not.toBe("user-1");
    expect(list.rows[0]!.sessions).toBe(1);
    expect(list.rows[0]!.pageviews).toBe(4);
  });

  test("anonymous visitors are listed separately", async () => {
    const { total } = await listUsers(sel, { ...scope, kind: "anonymous" });
    expect(total.rows[0]?.n).toBe(2);
  });

  test("the profile merges traits, newest wins, and keeps internal keys out", async () => {
    const { list } = await listUsers(sel, scope);
    const p = await userProfile(sel, SITE.id, list.rows[0]!.id);
    expect(p.merged).toEqual({ name: "Ada", company: "Acme" });
    expect(p.summary.rows[0]?.sessions).toBe(1);
    // Another site cannot read this profile by guessing the hash.
    const other = await userProfile(sel, "other", list.rows[0]!.id);
    expect(other.summary.rows[0]?.sessions).toBe(0);
  });

  test("user sessions filter by identity", async () => {
    const { list: users } = await listUsers(sel, scope);
    const { list } = await listSessions(sel, { ...scope, identity: users.rows[0]!.id });
    expect(list.rows.length).toBe(1);
  });
});

describe("events", () => {
  test("properties break down by key and value, without internal keys", async () => {
    const d = await eventDetail(sel, { ...scope, name: "signup", bucketMs: 3_600_000 });
    expect(d.properties.rows).toEqual([
      { key: "plan", value: "free", count: 1, sessions: 1 },
      { key: "plan", value: "pro", count: 1, sessions: 1 },
    ]);
    expect(d.log.rows.length).toBe(2);
    expect(d.series.rows.reduce((n, r) => n + r.count, 0)).toBe(2);
  });

  test("filters reach the property breakdown", async () => {
    const d = await eventDetail(sel, { ...scope, name: "signup", bucketMs: 3_600_000, filters: parseFilters("device:desktop,path:/") });
    expect(d.properties.sql).toContain("e.device = ?");
    expect(d.properties.rows).toEqual([{ key: "plan", value: "pro", count: 1, sessions: 1 }]);
  });
});

describe("errors", () => {
  test("occurrences of one group", async () => {
    const q = await errorOccurrences(sel, { ...scope, message: "x is undefined", source: "app.js", line: 3 });
    expect(q.rows.length).toBe(1);
    expect(q.rows[0]!.path).toBe("/pricing");
    const none = await errorOccurrences(sel, { ...scope, message: "x is undefined", source: "other.js", line: 3 });
    expect(none.rows.length).toBe(0);
  });
});

describe("journeys", () => {
  test("consecutive repeats collapse, short sessions end early", async () => {
    const j = await computeJourneys(sel, { ...scope, steps: 3 });
    expect(j.totalSessions).toBe(3);
    const a = j.rows.find((r) => r.p3 === "/signup")!;
    expect(a).toMatchObject({ p1: "/", p2: "/pricing", p3: "/signup", sessions: 1 });
    const c = j.rows.find((r) => r.p1 === "/blog/a")!;
    expect(c.p2).toBeNull();
    expect(await store.select<unknown>(j.sql, j.params)).toEqual(j.rows as unknown[]);
  });

  test("per-step filters are bound, and wildcards work", async () => {
    const j = await computeJourneys(sel, { ...scope, steps: 2, stepFilters: [null, "/pri*"] });
    expect(j.rows.map((r) => r.sessions)).toEqual([2]);
    expect(j.sql).toContain("p2 LIKE ?");
    expect(j.sql).not.toContain("/pri");
  });

  test("steps and limit are clamped integers", async () => {
    const j = await computeJourneys(sel, { ...scope, steps: 99, limit: -5 });
    expect(j.steps).toBe(8);
    expect(j.sql).toContain("LIMIT 1");
  });
});

describe("goals", () => {
  test("page goal with a wildcard is expanded and bound", async () => {
    const g = await computeGoal(sel, { ...scope, goal: { name: "Blog", type: "page", value: "/blog/*" } });
    expect(g.conversions).toBe(1);
    expect(g.sessions).toBe(3);
    expect(g.rate).toBe(33.3);
    expect(g.matchedPaths).toEqual(["/blog/a"]);
  });

  test("event goal with a property condition", async () => {
    const g = await computeGoal(sel, {
      ...scope,
      goal: { name: "Pro signup", type: "event", value: "signup", propKey: "plan", propValue: "pro" },
    });
    expect(g.conversions).toBe(1);
    const rows = await store.select<{ conversions: number }>(g.evidence.sql, g.evidence.params);
    expect(rows[0]?.conversions).toBe(1);
  });

  test("goal validation", () => {
    expect(() => validateGoal({ type: "page", value: "pricing" })).toThrow(GoalError);
    expect(() => validateGoal({ type: "event", value: "x", propKey: "a b" })).toThrow(GoalError);
    expect(pathPatternRegex("/docs/**").test("/docs/a/b")).toBe(true);
    expect(pathPatternRegex("/blog/*").test("/blog/a/b")).toBe(false);
  });
});

describe("event-property filters", () => {
  test("prop:key narrows to events carrying that value, bound as a JSON path", async () => {
    const d = await eventDetail(sel, { ...scope, name: "signup", bucketMs: 3_600_000, filters: parseFilters("prop:plan:pro") });
    expect(d.log.rows.length).toBe(1);
    expect(d.log.sql).toContain("json_extract(props, ?)");
    expect(d.log.params).toContain('$."plan"');
    const r = await eventDetail(sel, {
      ...scope, name: "signup", bucketMs: 3_600_000,
      filters: parseFilters(JSON.stringify([{ field: "prop:plan", op: "regex", value: "^fr" }])),
    });
    expect(r.log.rows.length).toBe(1);
  });

  test("a property key that is not a plain name is refused", () => {
    expect(() => parseFilters(JSON.stringify([{ field: "prop:a') OR 1=1 --", value: "x" }]))).toThrow();
  });

  test("suggestions for a property", async () => {
    const q = await filterSuggestions(sel, { ...scope, field: "prop:plan" });
    expect(q.rows.map((r) => r.value).sort()).toEqual(["free", "pro"]);
  });
});

describe("suggestions", () => {
  test("values for a field, most common first", async () => {
    const q = await filterSuggestions(sel, { ...scope, field: "path", q: "pri" });
    expect(q.rows).toEqual([{ value: "/pricing", sessions: 2 }]);
    await expect(filterSuggestions(sel, { ...scope, field: "password" })).rejects.toThrow();
  });
});
