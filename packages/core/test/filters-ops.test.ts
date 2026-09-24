// packages/core/test/filters-ops.test.ts
//
// Operators, session-level fields and regex expansion. The property under test
// is the same one filters.test.ts guards: the number and the evidence agree,
// because re-running the stored SQL with the stored params reproduces it.

import { beforeEach, describe, expect, test } from "bun:test";
import { freshStore, ingestorFor, CHROME, IPHONE, SITE } from "./helpers.ts";
import type { SqliteStore } from "../src/store/sqlite.ts";
import { buildBundle, windowOf, WindowError } from "../src/metrics/bundle.ts";
import { FilterError, parseFilters, serializeFilters, describeFilters } from "../src/metrics/filters.ts";

const NOW = Date.UTC(2026, 8, 19, 12, 0, 0);
let store: SqliteStore;

async function pv(ip: string, ua: string, url: string, at: number, title = "") {
  await ingestorFor(store).ingest(
    { site: SITE.id, type: "pageview", url, title, hostname: "example.com" },
    { ip, userAgent: ua, now: at, host: SITE.domain, country: "DE" }
  );
}
async function ev(ip: string, ua: string, name: string, at: number) {
  await ingestorFor(store).ingest(
    { site: SITE.id, type: "event", name, url: "/" },
    { ip, userAgent: ua, now: at, host: SITE.domain, country: "DE" }
  );
}

beforeEach(async () => {
  store = await freshStore();
  const t = NOW - 3_600_000;
  // A: / → /blog/one → signup
  await pv("198.51.100.1", CHROME, "/", t, "Home");
  await pv("198.51.100.1", CHROME, "/blog/one", t + 1000, "One");
  await ev("198.51.100.1", CHROME, "signup", t + 2000);
  // B: /blog/two → /pricing
  await pv("198.51.100.2", CHROME, "/blog/two", t, "Two");
  await pv("198.51.100.2", CHROME, "/pricing", t + 1000, "Pricing");
  // C: /pricing only
  await pv("203.0.113.3", IPHONE, "/pricing", t, "Pricing");
});

const win = () => windowOf(NOW, 7);
const value = async (filters: string, id = "sessions.total") => {
  const b = await buildBundle(store, { siteId: SITE.id, window: win(), now: NOW, filters: parseFilters(filters) });
  return b.evidence.find((e) => e.metric === id)!;
};

describe("parsing operators", () => {
  test("legacy field:op:value", () => {
    expect(parseFilters("path:contains:/blog")).toEqual([{ field: "path", op: "contains", value: "/blog" }]);
  });
  test("JSON form, where values may contain commas", () => {
    expect(parseFilters(JSON.stringify([{ field: "title", op: "is_not", value: "a, b" }]))).toEqual([
      { field: "title", op: "is_not", value: "a, b" },
    ]);
  });
  test("an unknown operator is refused", () => {
    expect(() => parseFilters(JSON.stringify([{ field: "path", op: "sounds_like", value: "x" }]))).toThrow(FilterError);
  });
  test("an invalid regex is refused, with the pattern named", () => {
    expect(() => parseFilters(JSON.stringify([{ field: "path", op: "regex", value: "(" }]))).toThrow(/not a valid/);
  });
  test("a catastrophic regex is refused before it can run", () => {
    expect(() => parseFilters(JSON.stringify([{ field: "path", op: "regex", value: "(a+)+$" }]))).toThrow(/exponential/);
  });
  test("round trip and description", () => {
    const f = parseFilters("path:contains:/blog,country:DE");
    expect(parseFilters(serializeFilters(f))).toEqual(f);
    expect(describeFilters(f)).toBe("Page contains /blog, Country = DE");
  });
});

describe("operators narrow, and the evidence reproduces the number", () => {
  test("is_not", async () => {
    const e = await value(`device:is_not:mobile`);
    expect(e.value).toBe(2);
    expect(e.sql).toContain("device <> ?");
  });

  test("contains is case-insensitive and escapes LIKE wildcards", async () => {
    expect((await value("path:contains:/BLOG")).value).toBe(2);
    // An underscore is a literal, not "any character".
    expect((await value("path:contains:_")).value).toBe(0);
  });

  test("not_contains", async () => {
    // Every event of session A and B carries a path; only C has none containing "blog"
    // on any row... but filters are row-level: A's "/" row and B's "/pricing" row match.
    const e = await value("path:not_contains:/blog", "pageviews.total");
    expect(e.value).toBe(3);
  });

  test("starts_with", async () => {
    expect((await value("path:starts_with:/pri", "pageviews.total")).value).toBe(2);
  });

  test("regex is expanded to the matching values, bound as parameters", async () => {
    const e = await value(JSON.stringify([{ field: "path", op: "regex", value: "^/blog/(one|two)$" }]), "pageviews.total");
    expect(e.value).toBe(2);
    expect(e.sql).toContain("path IN (?, ?)");
    expect(e.params).toContain("/blog/one");
    expect(e.params).toContain("/blog/two");
    const rows = await store.select<{ value: number }>(e.sql, e.params);
    expect(rows[0]?.value).toBe(2);
  });

  test("a regex that matches nothing returns zero, not everything", async () => {
    const e = await value(JSON.stringify([{ field: "path", op: "regex", value: "^/nowhere$" }]));
    expect(e.value).toBe(0);
    expect(e.sql).toContain("path IN ()");
  });

  test("the bundle reports which values a regex matched", async () => {
    const b = await buildBundle(store, {
      siteId: SITE.id,
      window: win(),
      now: NOW,
      filters: parseFilters(JSON.stringify([{ field: "path", op: "regex", value: "blog" }])),
    });
    expect(b.filters[0]?.matched).toEqual(["/blog/one", "/blog/two"]);
  });
});

describe("session-level fields keep the whole session", () => {
  test("event: sessions that fired signup — with ALL their pageviews", async () => {
    const e = await value("event:signup", "pageviews.total");
    // Session A had two pageviews; a row-level `name = 'signup'` would have
    // counted zero pageviews.
    expect(e.value).toBe(2);
    expect(e.sql).toContain("session_id IN (SELECT session_id FROM events WHERE site_id = ?");
    // The subquery is bounded to the site like every other query.
    expect(e.params.filter((p) => p === SITE.id).length).toBeGreaterThanOrEqual(2);
    const rows = await store.select<{ value: number }>(e.sql, e.params);
    expect(rows[0]?.value).toBe(2);
  });

  test("entry_page and exit_page", async () => {
    expect((await value("entry_page:/pricing")).value).toBe(1);
    expect((await value("exit_page:/pricing")).value).toBe(2);
    expect((await value("entry_page:is_not:/pricing")).value).toBe(2);
  });

  test("a session subquery never reads another site", async () => {
    await store.upsertSite({ ...SITE, id: "other" });
    await ingestorFor(store).ingest(
      { site: "other", type: "event", name: "signup", url: "/" },
      { ip: "198.51.100.2", userAgent: CHROME, now: NOW - 3_000_000, host: SITE.domain }
    );
    // Visitor B fired signup on ANOTHER site; it must not qualify here.
    expect((await value("event:signup")).value).toBe(1);
  });
});

describe("new breakdowns", () => {
  test("page titles and hostnames", async () => {
    const b = await buildBundle(store, { siteId: SITE.id, window: win(), now: NOW });
    const titles = b.evidence.find((e) => e.metric === "titles.top")!;
    expect(titles.rows[0]).toMatchObject({ title: "Pricing", views: 2 });
    const hosts = b.evidence.find((e) => e.metric === "hostnames.top")!;
    expect(hosts.rows[0]).toMatchObject({ hostname: "example.com", views: 5 });
  });

  test("time on page excludes the last page of a session instead of calling it 0s", async () => {
    const b = await buildBundle(store, { siteId: SITE.id, window: win(), now: NOW });
    const pages = b.evidence.find((e) => e.metric === "pages.detail")!;
    const home = pages.rows.find((r) => r.path === "/")!;
    expect(home.avg_time).toBe(1);
    const pricing = pages.rows.find((r) => r.path === "/pricing")!;
    // Both /pricing views were exits: there is no time to average.
    expect(pricing.avg_time).toBeNull();
    expect(pricing.exits).toBe(2);
  });

  test("weekday × hour uses the viewer's offset", async () => {
    const utc = await buildBundle(store, { siteId: SITE.id, window: win(), now: NOW });
    const plus3 = await buildBundle(store, { siteId: SITE.id, window: win(), now: NOW, tzOffsetMinutes: 180 });
    const h = (b: typeof utc) => b.evidence.find((e) => e.metric === "heatmap.weekhour")!.rows[0]!.hour as number;
    expect((h(plus3) - h(utc) + 24) % 24).toBe(3);
  });

  test("session-quality series matches the scalar definitions and leaves empty buckets NULL", async () => {
    const b = await buildBundle(store, { siteId: SITE.id, window: win(), now: NOW, granularity: "hour" });
    const s = b.evidence.find((e) => e.metric === "timeseries.sessions")!;
    const filled = s.series!.filter((p) => p.sessions > 0);
    expect(filled.length).toBe(1);
    expect(filled[0]!.bounce_rate).toBe(33.3);
    const empty = s.series!.find((p) => p.sessions === 0)!;
    expect(empty.bounce_rate).toBeNull();
    expect(s.bucketMs).toBe(3_600_000);
  });

  test("a series with a compare window carries the previous period, bucket for bucket", async () => {
    const w = win();
    const b = await buildBundle(store, {
      siteId: SITE.id,
      window: w,
      compare: { from: w.from - (w.to - w.from), to: w.from, label: "prev" },
      now: NOW,
    });
    const s = b.evidence.find((e) => e.metric === "timeseries")!;
    expect(s.previousSeries?.length).toBe(s.series?.length);
    expect(s.previousSeries?.every((p) => p.views === 0)).toBe(true);
  });

  test("a granularity too fine for the range is refused, not silently coarsened", async () => {
    await expect(
      buildBundle(store, { siteId: SITE.id, window: windowOf(NOW, 30), now: NOW, granularity: "minute" })
    ).rejects.toThrow(WindowError);
  });
});
