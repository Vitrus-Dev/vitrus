// packages/core/src/metrics/revenue.ts
// Revenue: what people paid, per currency, where it came from and over time.
//
// Definitions, stated once:
//   * A revenue event is any event whose props carry `revenue` (a number ≥ 0)
//     and `currency` (ISO 4217). validate.ts normalises both at ingest; an
//     unusable amount is removed there and its reason kept in
//     `_revenue_rejected`, which `rejected` below counts.
//   * One currency at a time. Amounts in different currencies are NEVER added
//     together and never converted: a conversion rate is a number from
//     somewhere else, and a total built on it could not be checked against
//     anything in this database. `currencies` lists every currency seen; the
//     rest of the result is for the one selected.
//   * An order is one revenue event. Average order value = revenue ÷ orders.
//   * Revenue per visitor = revenue ÷ ALL human visitors in the window, not
//     only the ones who paid — the number that answers "what is a visit worth".
//   * Conversion rate = sessions with at least one revenue event ÷ all human
//     sessions.
//   * Channel, source and campaign are the session's — where the visit that
//     ended in the payment started — not the payment event's own referrer.
//     Page, event, country and device are the payment event's.
//   * People only, like every other number: bots and agents are excluded.
//     Revenue from verified agent sessions is reported separately in
//     `agentRevenue` — an agent that completes a checkout is revenue, but it is
//     not a person, and folding it in would change what "per visitor" means.
//
// Everything that shapes the SQL — the dimension column — comes from a closed
// allow-list; every value is a bound parameter.

import { applyFilters, filterValues, resolvePatternFilters } from "./filters.ts";
import type { Query, Scope, Select } from "./explore.ts";
import { AGENT_SESSION, HUMAN } from "./queries.ts";

export const REVENUE_DIMENSIONS = [
  "channel",
  "source",
  "utm_campaign",
  "name",
  "path",
  "country",
  "device",
] as const;
export type RevenueDimension = (typeof REVENUE_DIMENSIONS)[number];
/** Dimensions read from the session's first event (where the visit came from). */
const ACQUISITION = ["channel", "source", "utm_campaign"] as const;

export class RevenueError extends Error {}

export interface RevenueOptions extends Scope {
  /** ISO 4217. Defaults to the currency with the most revenue in the window. */
  currency?: string;
  by?: string;
  bucketMs: number;
  previous?: { from: number; to: number };
}

export interface RevenueTotals {
  revenue: number;
  orders: number;
  sessions: number;
}

export interface RevenueResult {
  /** Null when no revenue event exists in the window. */
  currency: string | null;
  by: RevenueDimension;
  currencies: Query<{ currency: string; revenue: number; orders: number }>;
  totals: Query<RevenueTotals>;
  previousTotals: RevenueTotals | null;
  visitors: Query<{ visitors: number; sessions: number }>;
  /** Derived; null where the denominator is 0 (never shown as 0). */
  averageOrderValue: number | null;
  revenuePerVisitor: number | null;
  conversionRate: number | null;
  breakdown: Query<{ g: string; revenue: number; orders: number }>;
  series: Query<{ g: number; revenue: number; orders: number }>;
  agentRevenue: Query<{ revenue: number; orders: number }>;
  rejected: Query<{ reason: string; events: number }>;
}

const AMOUNT = `CAST(json_extract(props, '$.revenue') AS REAL)`;
const CURRENCY = `json_extract(props, '$.currency')`;
const HAS_REVENUE = `json_extract(props, '$.revenue') IS NOT NULL`;

async function run<T>(select: Select, label: string, sql: string, params: unknown[]): Promise<Query<T>> {
  const slots = (sql.match(/\?/g) ?? []).length;
  if (slots !== params.length) throw new Error(`${label}: ${slots} placeholders but ${params.length} parameters`);
  return { label, sql, params, rows: await select<T>(sql, params) };
}

/** Money is summed as REAL; round to cents at the edge so 0.1 + 0.2 reads as 0.3. */
function money(n: unknown): number {
  return Math.round(Number(n ?? 0) * 100) / 100;
}

export async function computeRevenue(select: Select, o: RevenueOptions): Promise<RevenueResult> {
  const by = (o.by ?? "channel") as RevenueDimension;
  if (!(REVENUE_DIMENSIONS as readonly string[]).includes(by)) {
    throw new RevenueError(`cannot break revenue down by "${o.by}"`);
  }
  if (o.currency !== undefined && !/^[A-Z]{3}$/.test(o.currency)) {
    throw new RevenueError("currency must be a three-letter ISO 4217 code, e.g. USD");
  }
  const filters = await resolvePatternFilters(select, o.siteId, o.filters ?? []);
  const fv = filterValues(filters, o.siteId);
  const where = applyFilters(`site_id = ? AND ts >= ? AND ts < ?`, filters);
  const win = (from: number, to: number) => [o.siteId, from, to, ...fv];

  const currencies = await run<{ currency: string; revenue: number; orders: number }>(
    select,
    "revenue by currency",
    `SELECT ${CURRENCY} AS currency, ROUND(SUM(${AMOUNT}), 4) AS revenue, COUNT(*) AS orders
       FROM events WHERE ${where} AND ${HUMAN} AND ${HAS_REVENUE}
      GROUP BY currency ORDER BY revenue DESC, currency ASC`,
    win(o.from, o.to)
  );
  const currency = o.currency ?? currencies.rows[0]?.currency ?? null;

  const totalsSql = `SELECT ROUND(COALESCE(SUM(${AMOUNT}), 0), 4) AS revenue, COUNT(*) AS orders,
       COUNT(DISTINCT session_id) AS sessions
  FROM events WHERE ${where} AND ${HUMAN} AND ${HAS_REVENUE} AND ${CURRENCY} = ?`;
  const cur = currency ?? "";
  const totals = await run<RevenueTotals>(select, `revenue in ${cur || "—"}`, totalsSql, [...win(o.from, o.to), cur]);
  let previousTotals: RevenueTotals | null = null;
  if (o.previous && currency) {
    const r = await select<RevenueTotals>(totalsSql, [...win(o.previous.from, o.previous.to), cur]);
    previousTotals = { revenue: money(r[0]?.revenue), orders: Number(r[0]?.orders ?? 0), sessions: Number(r[0]?.sessions ?? 0) };
  }

  const visitors = await run<{ visitors: number; sessions: number }>(
    select,
    "human visitors and sessions",
    `SELECT COUNT(DISTINCT visitor_id) AS visitors, COUNT(DISTINCT session_id) AS sessions
       FROM events WHERE ${where} AND ${HUMAN}`,
    win(o.from, o.to)
  );

  // Acquisition dimensions are the SESSION's, not the purchase event's: a
  // checkout page has no outside referrer, so read per event every order would
  // be "direct". The session's first event says where the visit came from.
  const groupExpr = (ACQUISITION as readonly string[]).includes(by)
    ? `(SELECT f.${by} FROM events f WHERE f.site_id = events.site_id AND f.session_id = events.session_id ORDER BY f.ts ASC LIMIT 1)`
    : by;
  const breakdown = await run<{ g: string; revenue: number; orders: number }>(
    select,
    `revenue in ${cur || "—"} by ${by}`,
    `SELECT ${groupExpr} AS g, ROUND(SUM(${AMOUNT}), 4) AS revenue, COUNT(*) AS orders
       FROM events WHERE ${where} AND ${HUMAN} AND ${HAS_REVENUE} AND ${CURRENCY} = ?
      GROUP BY g ORDER BY revenue DESC, g ASC LIMIT 50`,
    [...win(o.from, o.to), cur]
  );

  const bucketMs = Math.max(60_000, Math.round(o.bucketMs));
  const series = await run<{ g: number; revenue: number; orders: number }>(
    select,
    `revenue in ${cur || "—"} over time`,
    `SELECT CAST((ts - ?) / ? AS INTEGER) AS g, ROUND(SUM(${AMOUNT}), 4) AS revenue, COUNT(*) AS orders
       FROM events WHERE ${where} AND ${HUMAN} AND ${HAS_REVENUE} AND ${CURRENCY} = ?
      GROUP BY g ORDER BY g ASC`,
    [o.from, bucketMs, ...win(o.from, o.to), cur]
  );

  const agentRevenue = await run<{ revenue: number; orders: number }>(
    select,
    `revenue in ${cur || "—"} from verified agent sessions`,
    `SELECT ROUND(COALESCE(SUM(${AMOUNT}), 0), 4) AS revenue, COUNT(*) AS orders
       FROM events WHERE ${where} AND ${AGENT_SESSION} AND ${HAS_REVENUE} AND ${CURRENCY} = ?`,
    [...win(o.from, o.to), cur]
  );

  const rejected = await run<{ reason: string; events: number }>(
    select,
    "revenue amounts rejected at ingest",
    `SELECT json_extract(props, '$._revenue_rejected') AS reason, COUNT(*) AS events
       FROM events WHERE ${where} AND json_extract(props, '$._revenue_rejected') IS NOT NULL
      GROUP BY reason ORDER BY events DESC, reason ASC`,
    win(o.from, o.to)
  );

  const t = totals.rows[0] ?? { revenue: 0, orders: 0, sessions: 0 };
  const revenue = money(t.revenue);
  const orders = Number(t.orders ?? 0);
  const paidSessions = Number(t.sessions ?? 0);
  const v = visitors.rows[0] ?? { visitors: 0, sessions: 0 };
  const allVisitors = Number(v.visitors ?? 0);
  const allSessions = Number(v.sessions ?? 0);

  return {
    currency,
    by,
    currencies,
    totals,
    previousTotals,
    visitors,
    averageOrderValue: orders > 0 ? money(revenue / orders) : null,
    revenuePerVisitor: currency && allVisitors > 0 ? money(revenue / allVisitors) : null,
    conversionRate: currency && allSessions > 0 ? Math.round((paidSessions / allSessions) * 10_000) / 100 : null,
    breakdown,
    series,
    agentRevenue,
    rejected,
  };
}
