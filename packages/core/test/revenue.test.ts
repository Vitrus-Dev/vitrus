// packages/core/test/revenue.test.ts — per-currency totals, no conversion, derived
// ratios with honest denominators, rejected amounts counted, evidence reruns.
import { beforeEach, expect, test } from "bun:test";
import { freshStore, ingestorFor, CHROME, SITE } from "./helpers.ts";
import type { SqliteStore } from "../src/store/sqlite.ts";
import { computeRevenue, RevenueError } from "../src/metrics/revenue.ts";
import type { Select } from "../src/metrics/explore.ts";
import { validateEvent } from "../src/validate.ts";

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const HOUR = 3_600_000;
let store: SqliteStore;
const sel: Select = (s, p) => store.select(s, p);

async function visit(ip: string, props?: Record<string, unknown>, at = NOW - HOUR, name = "purchase") {
  const ing = ingestorFor(store);
  const ctx = { ip, userAgent: CHROME, now: at, host: SITE.domain };
  await ing.ingest({ site: SITE.id, type: "pageview", url: "/checkout" }, ctx);
  if (props) await ing.ingest({ site: SITE.id, type: "event", name, url: "/checkout", props }, { ...ctx, now: at + 1000 });
}

beforeEach(async () => {
  store = await freshStore();
  // 5 visitors: three pay in USD (one pays twice), one pays in EUR, one does not pay.
  await visit("198.51.100.1", { revenue: 10.1, currency: "usd" });
  await visit("198.51.100.2", { revenue: "20.2", currency: "USD" });
  await visit("198.51.100.3", { revenue: 0.3, currency: "USD" });
  await visit("198.51.100.3", { revenue: 5, currency: "USD" }, NOW - HOUR + 60_000, "upsell");
  await visit("198.51.100.4", { revenue: 99, currency: "EUR" });
  await visit("198.51.100.5");
  // Unusable amounts: the events are kept, the amounts are not.
  await visit("198.51.100.6", { revenue: -3, currency: "USD" });
  await visit("198.51.100.7", { revenue: 12 });
});

const scope = { siteId: SITE.id, from: NOW - 86_400_000, to: NOW, bucketMs: HOUR };

test("validate normalises amount and currency, and keeps a reason for what it rejects", () => {
  const ok = validateEvent({ site: "s", type: "event", name: "p", url: "/", props: { revenue: "19.990001", currency: " eur " } });
  expect(ok.ok && ok.event.props).toEqual({ revenue: 19.99, currency: "EUR" });
  for (const [props, reason] of [
    [{ revenue: "12,5", currency: "USD" }, "amount_not_a_number"],
    [{ revenue: -1, currency: "USD" }, "amount_negative"],
    [{ revenue: 2e9, currency: "USD" }, "amount_too_large"],
    [{ revenue: 5 }, "currency_missing"],
    [{ revenue: 5, currency: "dollars" }, "currency_invalid"],
  ] as const) {
    const r = validateEvent({ site: "s", type: "event", name: "p", url: "/", props });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.event.props?.revenue).toBeUndefined();
      expect(r.event.props?._revenue_rejected).toBe(reason);
    }
  }
});

test("defaults to the largest currency, never adds currencies together", async () => {
  const r = await computeRevenue(sel, scope);
  expect(r.currencies.rows.map((c) => c.currency)).toEqual(["EUR", "USD"]);
  expect(r.currency).toBe("EUR");
  expect(r.totals.rows[0]?.revenue).toBe(99);

  const usd = await computeRevenue(sel, { ...scope, currency: "USD" });
  expect(usd.totals.rows[0]?.revenue).toBe(35.6);
  expect(usd.totals.rows[0]?.orders).toBe(4);
  expect(usd.averageOrderValue).toBe(8.9);
  // All 7 human visitors count in "per visitor", not only the 4 who paid in any currency.
  expect(usd.visitors.rows[0]?.visitors).toBe(7);
  expect(usd.revenuePerVisitor).toBe(5.09);
  // 3 of 7 sessions paid in USD.
  expect(usd.conversionRate).toBe(42.86);
});

test("breakdown by event name and a series, both reproducible from the evidence", async () => {
  const r = await computeRevenue(sel, { ...scope, currency: "USD", by: "name" });
  expect(r.breakdown.rows).toEqual([
    { g: "purchase", revenue: 30.6, orders: 3 },
    { g: "upsell", revenue: 5, orders: 1 },
  ]);
  expect(r.series.rows.reduce((a, b) => a + b.revenue, 0)).toBeCloseTo(35.6, 6);
  const e = r.totals;
  expect((await store.select<{ revenue: number }>(e.sql, e.params))[0]?.revenue).toBe(35.6);
});

test("channel is where the visit started, not the checkout page's referrer", async () => {
  const ing = ingestorFor(store);
  const ctx = { ip: "198.51.100.40", userAgent: CHROME, now: NOW - HOUR, host: SITE.domain };
  await ing.ingest({ site: SITE.id, type: "pageview", url: "/", referrer: "https://www.google.com/" }, ctx);
  await ing.ingest({ site: SITE.id, type: "pageview", url: "/checkout", referrer: `https://${SITE.domain}/` }, { ...ctx, now: ctx.now + 5000 });
  await ing.ingest(
    { site: SITE.id, type: "event", name: "purchase", url: "/checkout", props: { revenue: 100, currency: "GBP" } },
    { ...ctx, now: ctx.now + 9000 }
  );
  const r = await computeRevenue(sel, { ...scope, currency: "GBP", by: "channel" });
  expect(r.breakdown.rows.map((x) => x.g)).toEqual(["search"]);
  const byPage = await computeRevenue(sel, { ...scope, currency: "GBP", by: "path" });
  expect(byPage.breakdown.rows.map((x) => x.g)).toEqual(["/checkout"]);
});

test("rejected amounts are counted by reason, not silently dropped", async () => {
  const r = await computeRevenue(sel, scope);
  expect(r.rejected.rows).toEqual([
    { reason: "amount_negative", events: 1 },
    { reason: "currency_missing", events: 1 },
  ]);
});

test("no revenue in the window: no currency, and ratios are null, not 0", async () => {
  const empty = await freshStore();
  const r = await computeRevenue(((s, p) => empty.select(s, p)) as Select, scope);
  expect(r.currency).toBeNull();
  expect(r.averageOrderValue).toBeNull();
  expect(r.revenuePerVisitor).toBeNull();
  expect(r.conversionRate).toBeNull();
});

test("previous period is the same query on the earlier window", async () => {
  const r = await computeRevenue(sel, { ...scope, currency: "USD", previous: { from: NOW - 2 * 86_400_000, to: NOW - 86_400_000 } });
  expect(r.previousTotals).toEqual({ revenue: 0, orders: 0, sessions: 0 });
});

test("only allow-listed dimensions and ISO codes", async () => {
  await expect(computeRevenue(sel, { ...scope, by: "props" })).rejects.toThrow(RevenueError);
  await expect(computeRevenue(sel, { ...scope, currency: "usd" })).rejects.toThrow(RevenueError);
});
