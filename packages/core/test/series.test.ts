// packages/core/test/series.test.ts
// The time series — the most visible part of the dashboard, and therefore where
// a silent error is most expensive. Three claims under test:
//   1. Empty buckets are filled with ZERO (a day with no traffic is not erased from the chart).
//   2. Bucket size follows the window (24h → hours, 30d → days).
//   3. The series total AGREES with the scalar metrics — chart and card state the same fact.

import { describe, expect, test } from "bun:test";
import { bucketFor, buildBundle, evidenceOf, windowOf, MAX_SERIES_POINTS } from "../src/metrics/bundle.ts";
import { composeDigest, renderText } from "../src/insight/compose.ts";
import { guardProse } from "../src/insight/guard.ts";
import { DAY, MIN, freshStore, ingestorFor, send } from "./helpers.ts";

const NOW = Date.UTC(2026, 8, 12, 12, 0, 0);

describe("bucketFor", () => {
  test("picks the bucket from the window length", () => {
    expect(bucketFor(windowOf(NOW, 1))).toBe(3_600_000); // 1 day → hours
    expect(bucketFor(windowOf(NOW, 7))).toBe(86_400_000); // 7 days → days
    expect(bucketFor(windowOf(NOW, 30))).toBe(86_400_000); // 30 days → days
    expect(bucketFor(windowOf(NOW, 180))).toBe(7 * 86_400_000); // 180 days → weeks
  });

  test("a very short window buckets by minute", () => {
    const w = { from: NOW - 3_600_000, to: NOW, label: "last hour" };
    expect(bucketFor(w)).toBe(60_000);
  });
});

describe("timeseries", () => {
  test("empty buckets are filled with ZERO — a day with no traffic is not erased", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    // Only 2 days have data; a 7-day window must still produce 7 points.
    await send(ing, { now: NOW - 5 * DAY, ip: "10.0.0.1" });
    await send(ing, { now: NOW - 1 * DAY, ip: "10.0.0.2" });

    const bundle = await buildBundle(store, {
      siteId: "demo",
      vertical: "landing",
      window: windowOf(NOW, 7),
      now: NOW,
    });
    const series = evidenceOf(bundle, "timeseries")?.series ?? [];
    expect(series).toHaveLength(7);
    expect(series.filter((p) => p.views > 0)).toHaveLength(2);
    expect(series.filter((p) => p.views === 0)).toHaveLength(5);
  });

  test("points are in time order and evenly spaced", async () => {
    const store = await freshStore();
    const bundle = await buildBundle(store, {
      siteId: "demo",
      vertical: "landing",
      window: windowOf(NOW, 7),
      now: NOW,
    });
    const series = evidenceOf(bundle, "timeseries")?.series ?? [];
    for (let i = 1; i < series.length; i++) {
      expect(series[i]!.ts - series[i - 1]!.ts).toBe(DAY);
    }
  });

  test("the series total AGREES with the scalar metrics — chart and card say the same thing", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    for (let i = 0; i < 6; i++) {
      await send(ing, { now: NOW - (i % 3) * DAY - MIN, ip: `10.1.0.${i}` });
    }
    await send(ing, { now: NOW - MIN, ip: "10.1.0.0", type: "event", name: "cta_click" });

    const bundle = await buildBundle(store, {
      siteId: "demo",
      vertical: "landing",
      window: windowOf(NOW, 7),
      now: NOW,
    });
    const series = evidenceOf(bundle, "timeseries")?.series ?? [];
    const totalViews = series.reduce((a, p) => a + p.views, 0);
    const totalEvents = series.reduce((a, p) => a + p.events, 0);

    expect(totalViews).toBe(evidenceOf(bundle, "pageviews.total")?.value ?? -1);
    expect(totalEvents).toBeGreaterThan(0);
  });

  test("bots DO NOT enter the series (same filter as the human metrics)", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    await send(ing, { now: NOW - MIN, ip: "10.2.0.1" });
    await send(ing, { now: NOW - MIN, ip: "52.0.0.1", ua: "Mozilla/5.0 (compatible; GPTBot/1.2)" });

    const bundle = await buildBundle(store, {
      siteId: "demo",
      vertical: "landing",
      window: windowOf(NOW, 7),
      now: NOW,
    });
    const series = evidenceOf(bundle, "timeseries")?.series ?? [];
    expect(series.reduce((a, p) => a + p.views, 0)).toBe(1);
  });

  test("the point count is capped — a huge window does not bloat the JSON", async () => {
    const store = await freshStore();
    const bundle = await buildBundle(store, {
      siteId: "demo",
      vertical: "landing",
      window: windowOf(NOW, 3650),
      now: NOW,
    });
    const series = evidenceOf(bundle, "timeseries")?.series ?? [];
    expect(series.length).toBeLessThanOrEqual(MAX_SERIES_POINTS);
  });

  test("series values are in the guard's allowed set — 'N views on that day' can be written", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    for (let i = 0; i < 3; i++) await send(ing, { now: NOW - DAY, ip: `10.3.0.${i}` });

    const bundle = await buildBundle(store, {
      siteId: "demo",
      vertical: "landing",
      window: windowOf(NOW, 7),
      now: NOW,
    });
    const peak = Math.max(...(evidenceOf(bundle, "timeseries")?.series ?? []).map((p) => p.views));
    expect(peak).toBe(3);
    expect(bundle.allowedNumbers).toContain(peak);
  });
});

describe("the peak line", () => {
  test("a clear peak is stated and PASSES the guard", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    // 8 visits on one day, 1 on the others → a clear peak.
    for (let i = 0; i < 8; i++) await send(ing, { now: NOW - 3 * DAY, ip: `10.20.0.${i}` });
    await send(ing, { now: NOW - 5 * DAY, ip: "10.20.1.1" });
    await send(ing, { now: NOW - 1 * DAY, ip: "10.20.1.2" });

    const bundle = await buildBundle(store, {
      siteId: "demo",
      vertical: "landing",
      window: windowOf(NOW, 7),
      now: NOW,
    });
    const digest = composeDigest(bundle);
    const peak = digest.lines.find((l) => l.kind === "peak");
    expect(peak).toBeDefined();
    expect(peak?.text).toContain("8 views");

    // A fractional average must not break the guard — this line carries exactly that risk.
    const verdict = guardProse(renderText(digest), bundle, { strictCausality: true });
    expect(verdict.dropped).toEqual([]);
  });

  test("on flat traffic NO peak line is written — not every maximum is news", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    for (let d = 1; d <= 5; d++) await send(ing, { now: NOW - d * DAY, ip: `10.21.0.${d}` });

    const bundle = await buildBundle(store, {
      siteId: "demo",
      vertical: "landing",
      window: windowOf(NOW, 7),
      now: NOW,
    });
    expect(composeDigest(bundle).lines.find((l) => l.kind === "peak")).toBeUndefined();
  });

  test("the date label is INDEPENDENT of locale (deterministic text)", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    for (let i = 0; i < 8; i++) await send(ing, { now: Date.UTC(2026, 8, 9, 12), ip: `10.22.0.${i}` });
    await send(ing, { now: Date.UTC(2026, 8, 11, 12), ip: "10.22.1.1" });
    await send(ing, { now: Date.UTC(2026, 8, 10, 12), ip: "10.22.1.2" });

    const bundle = await buildBundle(store, {
      siteId: "demo",
      vertical: "landing",
      window: windowOf(NOW, 7),
      now: NOW,
    });
    const peak = composeDigest(bundle).lines.find((l) => l.kind === "peak");
    expect(peak?.text).toContain("Sep");
  });
});

describe("core metrics", () => {
  test("visit duration is the span between a session's first and last event", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    // One visitor: minute 0 and minute 4 → 240s
    await send(ing, { now: NOW - 10 * MIN, ip: "10.4.0.1" });
    await send(ing, { now: NOW - 6 * MIN, ip: "10.4.0.1", url: "/pricing" });

    const bundle = await buildBundle(store, {
      siteId: "demo",
      vertical: "landing",
      window: windowOf(NOW, 7),
      now: NOW,
    });
    expect(evidenceOf(bundle, "visit.duration")?.value).toBe(240);
  });

  test("a single-event session counts as 0s and IS INCLUDED in the average", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    await send(ing, { now: NOW - 10 * MIN, ip: "10.5.0.1" });
    await send(ing, { now: NOW - 6 * MIN, ip: "10.5.0.1", url: "/x" }); // 240s
    await send(ing, { now: NOW - 5 * MIN, ip: "10.5.0.2" }); // 0s
    const bundle = await buildBundle(store, {
      siteId: "demo",
      vertical: "landing",
      window: windowOf(NOW, 7),
      now: NOW,
    });
    expect(evidenceOf(bundle, "visit.duration")?.value).toBe(120); // (240+0)/2
  });

  test("entry and exit pages are a session's first and last page", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    await send(ing, { now: NOW - 10 * MIN, ip: "10.6.0.1", url: "/" });
    await send(ing, { now: NOW - 9 * MIN, ip: "10.6.0.1", url: "/pricing" });
    await send(ing, { now: NOW - 8 * MIN, ip: "10.6.0.1", url: "/signup" });

    const bundle = await buildBundle(store, {
      siteId: "demo",
      vertical: "landing",
      window: windowOf(NOW, 7),
      now: NOW,
    });
    expect(evidenceOf(bundle, "entry.pages")?.rows[0]).toMatchObject({ path: "/", sessions: 1 });
    expect(evidenceOf(bundle, "exit.pages")?.rows[0]).toMatchObject({ path: "/signup", sessions: 1 });
  });

  test("browser/OS/language breakdowns work", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    await send(ing, { now: NOW - MIN, ip: "10.7.0.1" });
    const bundle = await buildBundle(store, {
      siteId: "demo",
      vertical: "landing",
      window: windowOf(NOW, 7),
      now: NOW,
    });
    expect(evidenceOf(bundle, "browsers.sessions")?.rows[0]).toMatchObject({ browser: "Chrome" });
    expect(evidenceOf(bundle, "os.sessions")?.rows[0]).toMatchObject({ os: "macOS" });
  });

  test("the UTM campaign report only lists tagged traffic", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    await send(ing, { now: NOW - MIN, ip: "10.8.0.1", url: "/?utm_source=newsletter&utm_medium=email&utm_campaign=september" });
    await send(ing, { now: NOW - MIN, ip: "10.8.0.2", url: "/" }); // untagged

    const bundle = await buildBundle(store, {
      siteId: "demo",
      vertical: "landing",
      window: windowOf(NOW, 7),
      now: NOW,
    });
    const rows = evidenceOf(bundle, "utm.campaigns")?.rows ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "newsletter", medium: "email", campaign: "september", sessions: 1 });
  });

  test("country comes from a proxy header; with no header the table stays EMPTY (nothing invented)", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    await send(ing, { now: NOW - MIN, ip: "10.9.1.1" }); // no header
    const bundle = await buildBundle(store, {
      siteId: "demo",
      vertical: "landing",
      window: windowOf(NOW, 7),
      now: NOW,
    });
    expect(evidenceOf(bundle, "countries.sessions")?.rows).toHaveLength(0);
  });

  test("a country header is normalised (upper case, 2 characters)", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    await ing.ingest(
      { site: "demo", type: "pageview", url: "/" },
      { ip: "10.9.2.1", userAgent: "Mozilla/5.0 Chrome/131.0", now: NOW - MIN, country: "tr" }
    );
    const bundle = await buildBundle(store, {
      siteId: "demo",
      vertical: "landing",
      window: windowOf(NOW, 7),
      now: NOW,
    });
    expect(evidenceOf(bundle, "countries.sessions")?.rows[0]).toMatchObject({ country: "TR", sessions: 1 });
  });
});
