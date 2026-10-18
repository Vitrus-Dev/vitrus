// packages/core/src/metrics/portfolio.ts
// Every site in one table: traffic, people, plans and money, side by side.
//
// One query per measure, grouped by site — not one query per site — so a
// workspace with 30 apps costs the same handful of queries as one with 3, and
// each column's evidence is a single SQL statement the reader can check.
//
// ═══ WHAT THE TOTALS MEAN ═══
// Counts are ADDED across sites. The same person signed in to two of your
// apps is two people here, and that is not an oversight: identities are
// hashed per site (visitor.ts, preHashIdentity), so no one — us included —
// can join one person across your apps. Visitors are daily-salted per site
// too. The page says this next to the total.
//
// Money is added per currency and never converted (revenue.ts explains why).
//
// The people columns use the same growth accounting as lifecycle.ts; the two
// are pinned equal by a test.

import type { Query, Select } from "./explore.ts";
import { FREE_PLANS } from "./lifecycle.ts";
import { HUMAN } from "./queries.ts";

export const PORTFOLIO_MAX_SITES = 100;
const FREE_SQL = `(${FREE_PLANS.map((p) => `'${p}'`).join(", ")})`;
const PLAN = `json_extract(props, '$.plan')`;

export interface PortfolioSite {
  id: string;
  name: string;
  domain: string;
}

export interface PortfolioOptions {
  sites: readonly PortfolioSite[];
  from: number;
  to: number;
  /** Site ids in strict privacy mode: their people columns are reported as not measurable, never as 0. */
  strict?: readonly string[];
}

export interface PortfolioRow {
  site: PortfolioSite;
  visitors: number;
  pageviews: number;
  prevVisitors: number;
  /** Null for a site in strict mode: identify() is ignored there, so there is nothing to count. */
  people: {
    known: number;
    active: number;
    newUsers: number;
    resurrected: number;
    churned: number;
    prevActive: number;
  } | null;
  signups: number;
  becamePaying: number;
  stoppedPaying: number;
  paying: number;
  revenue: { currency: string; revenue: number; orders: number }[];
  /** Visitors per bucket across the range (`window.bucket` ms each, UTC-aligned), oldest first. */
  series: number[];
  /** Signed-in people active per bucket, same buckets as `series`. Null where people are not measured (strict mode). */
  userSeries: number[] | null;
  /** Visitors per platform. A visitor seen on two platforms counts on both. */
  platforms: Record<Platform, number>;
}

export type Platform = "web" | "ios" | "android" | "app";
export const PLATFORMS: readonly Platform[] = ["web", "ios", "android", "app"];
const DAY = 86400000;
/** Up to ~3 months a point per day; longer ranges get a point per week so the line stays readable. */
export const bucketOf = (span: number): number => (span <= 92 * DAY ? DAY : 7 * DAY);

export interface PortfolioResult {
  window: { from: number; to: number; previousFrom: number; bucket: number; bucketFrom: number };
  rows: PortfolioRow[];
  totals: {
    sites: number;
    visitors: number;
    prevVisitors: number;
    active: number;
    newUsers: number;
    churned: number;
    signups: number;
    becamePaying: number;
    paying: number;
    revenue: { currency: string; revenue: number; orders: number }[];
  };
  /** One entry per column: the query that produced it. */
  evidence: Record<"traffic" | "previous" | "people" | "events" | "plans" | "paying" | "revenue" | "series" | "userSeries" | "platforms", Query>;
}

export class PortfolioError extends Error {}

async function run<T>(select: Select, label: string, sql: string, params: unknown[]): Promise<Query<T>> {
  const slots = (sql.match(/\?/g) ?? []).length;
  if (slots !== params.length) throw new Error(`${label}: ${slots} placeholders but ${params.length} parameters`);
  return { label, sql, params, rows: await select<T>(sql, params) };
}

const n = (v: unknown): number => Number(v ?? 0) || 0;

export async function computePortfolio(select: Select, o: PortfolioOptions): Promise<PortfolioResult> {
  if (o.sites.length > PORTFOLIO_MAX_SITES) throw new PortfolioError(`a portfolio holds at most ${PORTFOLIO_MAX_SITES} sites`);
  const span = o.to - o.from;
  const pfrom = o.from - span;
  const ids = o.sites.map((s) => s.id);
  const empty = ids.length === 0;
  // An empty IN () is a syntax error in SQLite; a never-matching id keeps the SQL valid and the evidence honest.
  const inList = empty ? "(?)" : `(${ids.map(() => "?").join(", ")})`;
  const idParams = empty ? ["\u0000none"] : ids;

  const traffic = await run<{ site_id: string; visitors: number; pageviews: number }>(
    select,
    "visitors and pageviews per site",
    `SELECT site_id, COUNT(DISTINCT visitor_id) AS visitors, SUM(CASE WHEN type = 'pageview' THEN 1 ELSE 0 END) AS pageviews
       FROM events WHERE site_id IN ${inList} AND ts >= ? AND ts < ? AND ${HUMAN}
      GROUP BY site_id`,
    [...idParams, o.from, o.to]
  );
  const previous = await run<{ site_id: string; visitors: number }>(
    select,
    "visitors per site, previous period",
    `SELECT site_id, COUNT(DISTINCT visitor_id) AS visitors
       FROM events WHERE site_id IN ${inList} AND ts >= ? AND ts < ? AND ${HUMAN}
      GROUP BY site_id`,
    [...idParams, pfrom, o.from]
  );
  const people = await run<{
    site_id: string; known: number; active: number; prev_active: number; new_users: number; resurrected: number; churned: number;
  }>(
    select,
    "people per site: active, new, resurrected, churned",
    `WITH people AS (
  SELECT site_id, identity,
         MIN(ts) AS first_ts,
         MAX(CASE WHEN ts >= ? AND ts < ? THEN 1 ELSE 0 END) AS cur,
         MAX(CASE WHEN ts >= ? AND ts < ? THEN 1 ELSE 0 END) AS prev
    FROM events
   WHERE site_id IN ${inList} AND ts < ? AND identity <> '' AND ${HUMAN}
   GROUP BY site_id, identity
)
SELECT site_id,
       COUNT(*) AS known,
       SUM(cur) AS active,
       SUM(prev) AS prev_active,
       SUM(CASE WHEN cur = 1 AND first_ts >= ? THEN 1 ELSE 0 END) AS new_users,
       SUM(CASE WHEN cur = 1 AND prev = 0 AND first_ts < ? THEN 1 ELSE 0 END) AS resurrected,
       SUM(CASE WHEN cur = 0 AND prev = 1 THEN 1 ELSE 0 END) AS churned
  FROM people GROUP BY site_id`,
    [o.from, o.to, pfrom, o.from, ...idParams, o.to, o.from, o.from]
  );
  const events = await run<{ site_id: string; signups: number }>(
    select,
    "signup events per site",
    `SELECT site_id, COUNT(*) AS signups
       FROM events WHERE site_id IN ${inList} AND ts >= ? AND ts < ? AND ${HUMAN} AND name = 'signup'
      GROUP BY site_id`,
    [...idParams, o.from, o.to]
  );
  const plans = await run<{ site_id: string; became: number; stopped: number }>(
    select,
    "plan moves per site",
    `WITH changes AS (
  SELECT site_id, identity, ts, ${PLAN} AS plan,
         LAG(${PLAN}) OVER (PARTITION BY site_id, identity ORDER BY ts) AS before
    FROM events
   WHERE site_id IN ${inList} AND ts < ? AND identity <> '' AND ${HUMAN} AND ${PLAN} IS NOT NULL
)
SELECT site_id,
       COUNT(DISTINCT CASE WHEN plan NOT IN ${FREE_SQL} AND (before IS NULL OR before IN ${FREE_SQL}) THEN identity END) AS became,
       COUNT(DISTINCT CASE WHEN plan IN ${FREE_SQL} AND before IS NOT NULL AND before NOT IN ${FREE_SQL} THEN identity END) AS stopped
  FROM changes WHERE ts >= ? GROUP BY site_id`,
    [...idParams, o.to, o.from]
  );
  // Bare-column MAX(): the plan on each person's latest plan-carrying event (see lifecycle.ts).
  const paying = await run<{ site_id: string; paying: number }>(
    select,
    "people on a paid plan per site, at the end of the range",
    `SELECT site_id, SUM(CASE WHEN plan NOT IN ${FREE_SQL} THEN 1 ELSE 0 END) AS paying FROM (
  SELECT site_id, identity, ${PLAN} AS plan, MAX(ts) AS last_ts
    FROM events
   WHERE site_id IN ${inList} AND ts < ? AND identity <> '' AND ${HUMAN} AND ${PLAN} IS NOT NULL
   GROUP BY site_id, identity
) GROUP BY site_id`,
    [...idParams, o.to]
  );
  const revenue = await run<{ site_id: string; currency: string; revenue: number; orders: number }>(
    select,
    "revenue per site and currency",
    `SELECT site_id, json_extract(props, '$.currency') AS currency,
            ROUND(SUM(CAST(json_extract(props, '$.revenue') AS REAL)), 4) AS revenue, COUNT(*) AS orders
       FROM events WHERE site_id IN ${inList} AND ts >= ? AND ts < ? AND ${HUMAN} AND json_extract(props, '$.revenue') IS NOT NULL
      GROUP BY site_id, currency ORDER BY revenue DESC`,
    [...idParams, o.from, o.to]
  );

  const bucket = bucketOf(span);
  const bucketFrom = Math.floor(o.from / bucket) * bucket;
  const buckets = Math.max(1, Math.ceil((o.to - bucketFrom) / bucket));
  const series = await run<{ site_id: string; b: number; visitors: number }>(
    select,
    "visitors per site and day (or week, past three months)",
    `SELECT site_id, CAST((ts - ?) / ? AS INTEGER) AS b, COUNT(DISTINCT visitor_id) AS visitors
       FROM events WHERE site_id IN ${inList} AND ts >= ? AND ts < ? AND ${HUMAN}
      GROUP BY site_id, b`,
    [bucketFrom, bucket, ...idParams, o.from, o.to]
  );
  const userSeries = await run<{ site_id: string; b: number; users: number }>(
    select,
    "signed-in people active per site and day (or week)",
    `SELECT site_id, CAST((ts - ?) / ? AS INTEGER) AS b, COUNT(DISTINCT identity) AS users
       FROM events WHERE site_id IN ${inList} AND ts >= ? AND ts < ? AND identity <> '' AND ${HUMAN}
      GROUP BY site_id, b`,
    [bucketFrom, bucket, ...idParams, o.from, o.to]
  );
  // The SDKs send "Vitrus-iOS/…", which ua.ts files under the browser "iOS app" — so app traffic needs no extra column.
  const platforms = await run<{ site_id: string; platform: Platform; visitors: number }>(
    select,
    "visitors per site and platform",
    `SELECT site_id,
            CASE WHEN browser = 'iOS app' THEN 'ios' WHEN browser = 'Android app' THEN 'android'
                 WHEN browser = 'App' OR browser LIKE '% app' THEN 'app' ELSE 'web' END AS platform,
            COUNT(DISTINCT visitor_id) AS visitors
       FROM events WHERE site_id IN ${inList} AND ts >= ? AND ts < ? AND ${HUMAN}
      GROUP BY site_id, platform`,
    [...idParams, o.from, o.to]
  );

  const by = <T extends { site_id: string }>(q: Query<T>) => new Map(q.rows.map((r) => [r.site_id, r]));
  const tMap = by(traffic), pMap = by(previous), peMap = by(people), eMap = by(events), plMap = by(plans), payMap = by(paying);
  const strict = new Set(o.strict ?? []);

  const rows: PortfolioRow[] = o.sites.map((site) => {
    const t = tMap.get(site.id), pe = peMap.get(site.id), pl = plMap.get(site.id);
    return {
      site,
      visitors: n(t?.visitors),
      pageviews: n(t?.pageviews),
      prevVisitors: n(pMap.get(site.id)?.visitors),
      people: strict.has(site.id)
        ? null
        : {
            known: n(pe?.known),
            active: n(pe?.active),
            newUsers: n(pe?.new_users),
            resurrected: n(pe?.resurrected),
            churned: n(pe?.churned),
            prevActive: n(pe?.prev_active),
          },
      signups: n(eMap.get(site.id)?.signups),
      becamePaying: n(pl?.became),
      stoppedPaying: n(pl?.stopped),
      paying: n(payMap.get(site.id)?.paying),
      revenue: revenue.rows
        .filter((r) => r.site_id === site.id && r.currency)
        .map((r) => ({ currency: r.currency, revenue: Math.round(n(r.revenue) * 100) / 100, orders: n(r.orders) })),
      series: Array.from({ length: buckets }, () => 0),
      userSeries: strict.has(site.id) ? null : Array.from({ length: buckets }, () => 0),
      platforms: { web: 0, ios: 0, android: 0, app: 0 },
    };
  });

  const rowOf = new Map(rows.map((r) => [r.site.id, r]));
  for (const r of series.rows) {
    const row = rowOf.get(r.site_id);
    const i = n(r.b);
    if (row && i >= 0 && i < row.series.length) row.series[i] = n(r.visitors);
  }
  for (const r of userSeries.rows) {
    const us = rowOf.get(r.site_id)?.userSeries;
    const i = n(r.b);
    if (us && i >= 0 && i < us.length) us[i] = n(r.users);
  }
  for (const r of platforms.rows) {
    const row = rowOf.get(r.site_id);
    if (row && r.platform in row.platforms) row.platforms[r.platform] = n(r.visitors);
  }

  const cur = new Map<string, { revenue: number; orders: number }>();
  for (const r of rows) {
    for (const x of r.revenue) {
      const c = cur.get(x.currency) ?? { revenue: 0, orders: 0 };
      c.revenue += x.revenue;
      c.orders += x.orders;
      cur.set(x.currency, c);
    }
  }
  const sum = (f: (r: PortfolioRow) => number) => rows.reduce((a, r) => a + f(r), 0);

  return {
    window: { from: o.from, to: o.to, previousFrom: pfrom, bucket, bucketFrom },
    rows,
    totals: {
      sites: rows.length,
      visitors: sum((r) => r.visitors),
      prevVisitors: sum((r) => r.prevVisitors),
      active: sum((r) => r.people?.active ?? 0),
      newUsers: sum((r) => r.people?.newUsers ?? 0),
      churned: sum((r) => r.people?.churned ?? 0),
      signups: sum((r) => r.signups),
      becamePaying: sum((r) => r.becamePaying),
      paying: sum((r) => r.paying),
      revenue: [...cur.entries()]
        .map(([currency, v]) => ({ currency, revenue: Math.round(v.revenue * 100) / 100, orders: v.orders }))
        .sort((a, b) => b.revenue - a.revenue),
    },
    evidence: { traffic, previous, people, events, plans, paying, revenue, series, userSeries, platforms },
  };
}
