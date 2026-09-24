// packages/core/test/performance.test.ts — percentiles, breakdowns, series, compare.
import { beforeEach, expect, test } from "bun:test";
import { freshStore, ingestorFor, CHROME, IPHONE, SITE } from "./helpers.ts";
import type { SqliteStore } from "../src/store/sqlite.ts";
import { computePerformance, PerformanceError } from "../src/metrics/performance.ts";

const NOW = Date.UTC(2026, 8, 19, 12, 0, 0);
let store: SqliteStore;

beforeEach(async () => {
  store = await freshStore();
  const ing = ingestorFor(store);
  // LCP 100..1000 on desktop /, 5000 on mobile /slow; no TTFB anywhere on mobile.
  for (let i = 1; i <= 10; i++) {
    await ing.ingest(
      { site: SITE.id, type: "event", name: "web_vitals", url: "/", props: { lcp: i * 100, ttfb: 50 } },
      { ip: `198.51.100.${i}`, userAgent: CHROME, now: NOW - 3_600_000, host: SITE.domain }
    );
  }
  await ing.ingest(
    { site: SITE.id, type: "event", name: "web_vitals", url: "/slow", props: { lcp: 5000 } },
    { ip: "203.0.113.1", userAgent: IPHONE, now: NOW - 3_600_000, host: SITE.domain }
  );
});

const scope = { siteId: SITE.id, from: NOW - 86_400_000, to: NOW, bucketMs: 3_600_000 };

test("nearest-rank percentiles, per metric, with sample counts", async () => {
  const p50 = await computePerformance((s, p) => store.select(s, p), { ...scope, percentile: 50 });
  expect(p50.overview.lcp.samples).toBe(11);
  expect(p50.overview.lcp.value).toBe(600);
  const p99 = await computePerformance((s, p) => store.select(s, p), { ...scope, percentile: 99 });
  expect(p99.overview.lcp.value).toBe(5000);
  // A metric nobody reported has no value — not 0.
  expect(p99.overview.inp.value).toBeNull();
  expect(p99.overview.inp.samples).toBe(0);
  // Re-running the evidence reproduces the number.
  const e = p99.overview.lcp.evidence;
  expect((await store.select<{ value: number }>(e.sql, e.params))[0]?.value).toBe(5000);
});

test("breakdown by dimension leaves out groups without samples", async () => {
  const r = await computePerformance((s, p) => store.select(s, p), { ...scope, by: "device" });
  const lcp = r.breakdown.lcp.rows;
  expect(lcp.find((x) => x.g === "mobile")?.value).toBe(5000);
  expect(r.breakdown.ttfb.rows.map((x) => x.g)).toEqual(["desktop"]);
});

test("series and previous period", async () => {
  const r = await computePerformance((s, p) => store.select(s, p), {
    ...scope,
    previous: { from: NOW - 2 * 86_400_000, to: NOW - 86_400_000 },
  });
  expect(r.series.lcp.rows.length).toBe(1);
  expect(r.overview.lcp.previous).toBeNull();
});

test("only allow-listed percentiles and dimensions", async () => {
  await expect(computePerformance((s, p) => store.select(s, p), { ...scope, percentile: 42 })).rejects.toThrow(PerformanceError);
  await expect(computePerformance((s, p) => store.select(s, p), { ...scope, by: "props" })).rejects.toThrow(PerformanceError);
});
