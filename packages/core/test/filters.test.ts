// packages/core/test/filters.test.ts
//
// The property under test is not "does filtering work" — it is **does the
// evidence still match the number**. A filter applied in the browser would pass
// a naive test and destroy the only thing this product sells: the user clicks
// the badge to check a number and finds the query returns something else.

import { beforeEach, describe, expect, test } from "bun:test";
import { freshStore, ingestorFor, CHROME, IPHONE, SITE } from "./helpers.ts";
import type { SqliteStore } from "../src/store/sqlite.ts";
import { buildBundle, windowOf } from "../src/metrics/bundle.ts";
import {
  applyFilters,
  describeFilters,
  FilterError,
  parseFilters,
  serializeFilters,
  windowCount,
  type Filter,
} from "../src/metrics/filters.ts";

const NOW = Date.UTC(2026, 8, 19, 12, 0, 0);

let store: SqliteStore;

/**
 * Events go in through the real ingest path, not straight into the table.
 * Device and browser are derived from the user agent there, so a fixture that
 * wrote the columns directly could disagree with what production produces.
 * Distinct IPs are what make distinct visitors — the id is a hash of them.
 */
async function seed(): Promise<void> {
  store = await freshStore();
  const ing = ingestorFor(store);
  const at = NOW - 3_600_000;
  const people: [string, string, string][] = [
    ["198.51.100.1", CHROME, "DE"],
    ["198.51.100.2", CHROME, "DE"],
    ["198.51.100.3", CHROME, "DE"],
    ["203.0.113.1", IPHONE, "TR"],
    ["203.0.113.2", IPHONE, "TR"],
    ["192.0.2.9", IPHONE, "DE"],
  ];
  for (const [ip, ua, country] of people) {
    await ing.ingest(
      { site: SITE.id, type: "pageview", url: "/" },
      { ip, userAgent: ua, now: at, host: SITE.domain, country }
    );
  }
}

beforeEach(seed);

describe("parsing", () => {
  test("field:value pairs, comma separated", () => {
    expect(parseFilters("country:DE,device:mobile")).toEqual([
      { field: "country", value: "DE" },
      { field: "device", value: "mobile" },
    ]);
  });

  test("nothing at all is not an error", () => {
    expect(parseFilters(null)).toEqual([]);
    expect(parseFilters("")).toEqual([]);
    expect(parseFilters("  ")).toEqual([]);
  });

  test("a value containing a colon survives — paths and URLs have them", () => {
    expect(parseFilters("path:/a:b")).toEqual([{ field: "path", value: "/a:b" }]);
  });

  test("an unknown field is REFUSED, not dropped", () => {
    // Silently ignoring it would show a narrowed heading over unnarrowed
    // numbers, which is the whole failure this file exists to prevent.
    expect(() => parseFilters("password_hash:x")).toThrow(FilterError);
    expect(() => parseFilters("country:DE,nonsense:1")).toThrow(FilterError);
  });

  test("malformed input is refused", () => {
    expect(() => parseFilters("country")).toThrow(FilterError);
    expect(() => parseFilters(":DE")).toThrow(FilterError);
    expect(() => parseFilters("country:")).toThrow(FilterError);
  });

  test("absurd input is bounded", () => {
    expect(() => parseFilters(`path:${"x".repeat(500)}`)).toThrow(FilterError);
    expect(() => parseFilters(Array.from({ length: 20 }, () => "country:DE").join(","))).toThrow(FilterError);
  });

  test("it round-trips through the wire format", () => {
    const f = parseFilters("country:DE,device:mobile");
    expect(parseFilters(serializeFilters(f))).toEqual(f);
  });

  test("it describes itself for a heading", () => {
    expect(describeFilters(parseFilters("country:DE,device:mobile"))).toBe("Country = DE, Device = mobile");
  });
});

describe("compiling into SQL", () => {
  const f: Filter[] = [{ field: "country", value: "DE" }];

  test("no filters leaves the statement untouched", () => {
    const sql = "SELECT 1 FROM events WHERE site_id = ? AND ts >= ? AND ts < ?";
    expect(applyFilters(sql, [])).toBe(sql);
  });

  test("the predicate lands immediately after the window", () => {
    const sql = "SELECT 1 FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND bot_kind = ''";
    expect(applyFilters(sql, f)).toBe(
      "SELECT 1 FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND country = ? AND bot_kind = ''"
    );
  });

  test("the unbounded live window is filtered too", () => {
    const sql = "SELECT 1 FROM events WHERE site_id = ? AND ts >= ? AND bot_kind = ''";
    expect(applyFilters(sql, f)).toBe(
      "SELECT 1 FROM events WHERE site_id = ? AND ts >= ? AND country = ? AND bot_kind = ''"
    );
  });

  test("the bounded window is never mistaken for the unbounded one", () => {
    // The optional tail is greedy, so `ts < ?` is consumed by the same match
    // and the filter does not land between `ts >= ?` and `ts < ?`.
    const sql = "WHERE site_id = ? AND ts >= ? AND ts < ?";
    expect(applyFilters(sql, f)).toBe("WHERE site_id = ? AND ts >= ? AND ts < ? AND country = ?");
    expect(windowCount(sql)).toBe(1);
  });

  test("a table alias is carried onto the filter column", () => {
    const sql = "WHERE e.site_id = ? AND e.ts >= ? AND e.ts < ?";
    expect(applyFilters(sql, f)).toBe("WHERE e.site_id = ? AND e.ts >= ? AND e.ts < ? AND e.country = ?");
  });

  test("every window predicate in a statement gets the filter", () => {
    const sql = "SELECT (SELECT 1 WHERE site_id = ? AND ts >= ? AND ts < ?) WHERE site_id = ? AND ts >= ? AND ts < ?";
    expect(windowCount(sql)).toBe(2);
    const out = applyFilters(sql, f);
    expect((out.match(/country = \?/g) ?? []).length).toBe(2);
  });

  test("the value is never written into the SQL", () => {
    const nasty: Filter[] = [{ field: "country", value: "DE' OR 1=1 --" }];
    const out = applyFilters("WHERE site_id = ? AND ts >= ? AND ts < ?", nasty);
    expect(out).not.toContain("OR 1=1");
    expect(out).toContain("country = ?");
  });
});

describe("the bundle actually narrows, and its evidence proves it", () => {
  const win = () => windowOf(NOW, 7, "last 7 days");

  test("unfiltered counts everyone", async () => {
    const b = await buildBundle(store, { siteId: SITE.id, window: win(), now: NOW });
    const v = b.evidence.find((e) => e.metric === "visitors.unique");
    expect(v?.value).toBe(6);
  });

  test("one filter narrows the number", async () => {
    const b = await buildBundle(store, {
      siteId: SITE.id,
      window: win(),
      now: NOW,
      filters: parseFilters("country:DE"),
    });
    expect(b.evidence.find((e) => e.metric === "visitors.unique")?.value).toBe(4);
  });

  test("two filters are ANDed", async () => {
    const b = await buildBundle(store, {
      siteId: SITE.id,
      window: win(),
      now: NOW,
      filters: parseFilters("country:DE,device:mobile"),
    });
    expect(b.evidence.find((e) => e.metric === "visitors.unique")?.value).toBe(1);
  });

  test("THE EVIDENCE SHOWS THE FILTERED QUERY — not the one we would have run", async () => {
    // This is the test that matters. A browser-side filter passes every
    // assertion above and fails this one, and the first person to click the
    // badge to check a number would find the query and the number disagree.
    const filters = parseFilters("country:DE");
    const b = await buildBundle(store, { siteId: SITE.id, window: win(), now: NOW, filters });
    for (const e of b.evidence) {
      expect(e.sql, `${e.metric} shows an unfiltered query`).toContain("country = ?");
      expect(e.params, `${e.metric} does not bind the filter value`).toContain("DE");
    }
  });

  test("re-running the evidence exactly reproduces the number on the card", async () => {
    const b = await buildBundle(store, {
      siteId: SITE.id,
      window: win(),
      now: NOW,
      filters: parseFilters("country:DE,device:mobile"),
    });
    const e = b.evidence.find((x) => x.metric === "visitors.unique")!;
    // Run the stored sql with the stored params, the way a sceptical user would.
    const rows = await store.select<{ value: number }>(e.sql, e.params);
    expect(e.value).not.toBeNull();
    expect(rows[0]?.value).toBe(e.value as number);
  });

  test("the comparison window is filtered the same way", async () => {
    const w = win();
    const b = await buildBundle(store, {
      siteId: SITE.id,
      window: w,
      compare: { from: w.from - (w.to - w.from), to: w.from, label: "previous" },
      now: NOW,
      filters: parseFilters("country:DE"),
    });
    const e = b.evidence.find((x) => x.metric === "visitors.unique")!;
    // Comparing a filtered period against an unfiltered one would manufacture a
    // dramatic delta out of nothing.
    expect(e.previousParams).toContain("DE");
  });

  test("row metrics narrow too", async () => {
    const b = await buildBundle(store, {
      siteId: SITE.id,
      window: win(),
      now: NOW,
      filters: parseFilters("country:TR"),
    });
    const devices = b.evidence.find((e) => e.metric === "devices.sessions");
    expect(devices?.rows.map((r) => r.device)).toEqual(["mobile"]);
  });

  test("the time series narrows — its custom parameter builder binds the filter", async () => {
    // The series metric builds its own parameter list; if it forgot to append
    // the filter values the placeholders and values would misalign and SQLite
    // would bind the country to the bucket size.
    const b = await buildBundle(store, {
      siteId: SITE.id,
      window: win(),
      now: NOW,
      filters: parseFilters("country:TR"),
    });
    const s = b.evidence.find((e) => e.metric === "timeseries")!;
    expect(s.sql).toContain("country = ?");
    expect(s.params).toContain("TR");
    const total = (s.series ?? []).reduce((n, p) => n + p.visitors, 0);
    expect(total).toBe(2);
  });

  test("a filter that matches nothing returns zero, not everything", async () => {
    const b = await buildBundle(store, {
      siteId: SITE.id,
      window: win(),
      now: NOW,
      filters: parseFilters("country:JP"),
    });
    expect(b.evidence.find((e) => e.metric === "visitors.unique")?.value).toBe(0);
  });

  test("bot traffic stays excluded whatever the filter says", async () => {
    await ingestorFor(store).ingest(
      { site: SITE.id, type: "pageview", url: "/" },
      {
        ip: "192.0.2.50",
        userAgent: "Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)",
        now: NOW - 3_600_000,
        host: SITE.domain,
        country: "DE",
      }
    );
    const b = await buildBundle(store, {
      siteId: SITE.id,
      window: win(),
      now: NOW,
      filters: parseFilters("country:DE"),
    });
    // The HUMAN predicate is not something a filter may loosen.
    expect(b.evidence.find((e) => e.metric === "visitors.unique")?.value).toBe(4);
  });
});
