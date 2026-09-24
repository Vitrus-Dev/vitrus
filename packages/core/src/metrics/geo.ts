// packages/core/src/metrics/geo.ts
// The globe's data: where sessions came from, at every precision the proxy
// gave us, each number with the query that produced it.
//
// This is a separate report from the MetricBundle for two reasons. The bundle
// feeds the digest and the numeric guard, and a 5,000-row session list is
// neither a digest input nor a set of numbers prose should be allowed to cite.
// And the globe is opened far less often than the overview; every other page
// should not pay for its queries.
//
// Same rules as the bundle, though: every result is an Evidence {sql, params,
// window, rows}; filters are compiled into the SQL (filters.ts), never applied
// in the browser; strict mode swaps the human predicate visibly.
//
// FAIL CLOSED. City, subdivision and coordinates exist only when the proxy
// sends them (core/geo.ts). `geo.coverage` counts how many sessions carry each
// level, so the dashboard can say "none of your sessions have a city — here is
// how to turn it on" instead of drawing an empty map and letting the reader
// conclude nobody came.

import { applyFilters, filterValues, windowCount, type Filter } from "./filters.ts";
import type { Evidence, TimeWindow } from "./bundle.ts";
import { HUMAN, HUMAN_STRICT } from "./queries.ts";

type Select = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

const WINDOW = "site_id = ? AND ts >= ? AND ts < ?";

/**
 * How many sessions the globe receives at most.
 *
 * The timeline and the session list are drawn in the browser from this list.
 * It is the MOST RECENT sessions, and when there are more the dashboard says
 * "showing the latest 5,000 of 12,400" — a cap that is not stated is a number
 * that is quietly wrong.
 */
export const GEO_SESSION_LIMIT = 5000;
/** Distinct coordinate cells. At 0.1° there are rarely more than a few thousand. */
export const GEO_POINT_LIMIT = 5000;

interface GeoDef {
  id: string;
  label: string;
  sql: string;
}

export const GEO_METRICS: readonly GeoDef[] = [
  {
    id: "geo.coverage",
    label: "Location coverage",
    // One row: how many sessions carry each level of location. This is what
    // lets the page tell "no visitors" apart from "no city headers".
    sql: `SELECT COUNT(DISTINCT session_id) AS sessions,
                 COUNT(DISTINCT CASE WHEN country <> '' THEN session_id END) AS with_country,
                 COUNT(DISTINCT CASE WHEN region <> '' THEN session_id END) AS with_region,
                 COUNT(DISTINCT CASE WHEN city <> '' THEN session_id END) AS with_city,
                 COUNT(DISTINCT CASE WHEN lat IS NOT NULL THEN session_id END) AS with_coords
            FROM events WHERE ${WINDOW} AND ${HUMAN}`,
  },
  {
    id: "geo.countries",
    label: "Sessions by country",
    // No LIMIT, unlike countries.sessions in the bundle: a choropleth that
    // shades the top fifteen and leaves the rest grey says the rest had nothing.
    sql: `SELECT country, COUNT(DISTINCT session_id) AS sessions
            FROM events WHERE ${WINDOW} AND ${HUMAN} AND country <> ''
           GROUP BY country ORDER BY sessions DESC, country ASC`,
  },
  {
    id: "geo.regions",
    label: "Sessions by subdivision",
    sql: `SELECT region, MAX(region_name) AS region_name, COUNT(DISTINCT session_id) AS sessions
            FROM events WHERE ${WINDOW} AND ${HUMAN} AND region <> ''
           GROUP BY region ORDER BY sessions DESC, region ASC LIMIT ${GEO_POINT_LIMIT}`,
  },
  {
    id: "geo.points",
    label: "Sessions by coordinate (0.1 degree cells)",
    sql: `SELECT lat, lon, MAX(city) AS city, MAX(country) AS country, COUNT(DISTINCT session_id) AS sessions
            FROM events WHERE ${WINDOW} AND ${HUMAN} AND lat IS NOT NULL AND lon IS NOT NULL
           GROUP BY lat, lon ORDER BY sessions DESC, lat ASC, lon ASC LIMIT ${GEO_POINT_LIMIT}`,
  },
  {
    id: "geo.sessions",
    label: "Recent sessions with location",
    // Location, device and source are the session's FIRST event — where it
    // started. Entry is the first path, exit the last. A session that crosses
    // the window edge is cut at the edge, like every other metric here.
    sql: `SELECT session_id,
                 MIN(ts) AS started, MAX(ts) AS ended,
                 SUM(CASE WHEN type = 'pageview' THEN 1 ELSE 0 END) AS pageviews,
                 SUM(CASE WHEN type = 'event' THEN 1 ELSE 0 END) AS events,
                 MAX(CASE WHEN rn_first = 1 THEN country END) AS country,
                 MAX(CASE WHEN rn_first = 1 THEN region END) AS region,
                 MAX(CASE WHEN rn_first = 1 THEN region_name END) AS region_name,
                 MAX(CASE WHEN rn_first = 1 THEN city END) AS city,
                 MAX(CASE WHEN rn_first = 1 THEN lat END) AS lat,
                 MAX(CASE WHEN rn_first = 1 THEN lon END) AS lon,
                 MAX(CASE WHEN rn_first = 1 THEN browser END) AS browser,
                 MAX(CASE WHEN rn_first = 1 THEN os END) AS os,
                 MAX(CASE WHEN rn_first = 1 THEN device END) AS device,
                 MAX(CASE WHEN rn_first = 1 THEN channel END) AS channel,
                 MAX(CASE WHEN rn_first = 1 THEN source END) AS source,
                 MAX(CASE WHEN rn_first = 1 THEN referrer_host END) AS referrer_host,
                 MAX(CASE WHEN rn_first = 1 THEN path END) AS entry,
                 MAX(CASE WHEN rn_last = 1 THEN path END) AS exit
            FROM (SELECT session_id, ts, type, path, country, region, region_name, city, lat, lon,
                         browser, os, device, channel, source, referrer_host,
                         ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts ASC, id ASC) AS rn_first,
                         ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts DESC, id DESC) AS rn_last
                    FROM events WHERE ${WINDOW} AND ${HUMAN})
           GROUP BY session_id ORDER BY started DESC, session_id ASC LIMIT ${GEO_SESSION_LIMIT}`,
  },
];

export interface GeoReport {
  siteId: string;
  window: TimeWindow;
  evidence: Evidence[];
  /** The ceiling on `geo.sessions`, so the page can state it when it is hit. */
  sessionLimit: number;
  generatedAt: number;
}

/**
 * Run every geo query. Evidence ids are `g1`…`g5` so they cannot collide with
 * the bundle's `e#` when both are on screen.
 */
export async function buildGeoReport(
  select: Select,
  opts: {
    siteId: string;
    window: TimeWindow;
    filters?: readonly Filter[];
    strictBots?: boolean;
    now?: number;
  }
): Promise<GeoReport> {
  const filters = opts.filters ?? [];
  const values = filterValues(filters);
  const evidence: Evidence[] = [];
  let n = 0;
  for (const def of GEO_METRICS) {
    n++;
    const base = opts.strictBots ? def.sql.split(HUMAN).join(HUMAN_STRICT) : def.sql;
    const sql = applyFilters(base, filters);
    const windows = windowCount(base);
    const params: unknown[] = [];
    for (let i = 0; i < windows; i++) params.push(opts.siteId, opts.window.from, opts.window.to, ...values);
    // Same self-check as the bundle: a placeholder count that does not match
    // would bind the wrong value to the wrong column and return a plausible
    // number. Fail loudly instead.
    const slots = (sql.match(/\?/g) ?? []).length;
    if (slots !== params.length) {
      throw new Error(`geo metric ${def.id}: ${slots} placeholders but ${params.length} parameters`);
    }
    const rows = await select(sql, params);
    evidence.push({
      id: `g${n}`,
      metric: def.id,
      label: def.label,
      unit: "count",
      sql,
      params,
      window: opts.window,
      value: def.id === "geo.coverage" ? Number(rows[0]?.sessions ?? 0) : null,
      rows,
    });
  }
  return {
    siteId: opts.siteId,
    window: opts.window,
    evidence,
    sessionLimit: GEO_SESSION_LIMIT,
    generatedAt: opts.now ?? Date.now(),
  };
}
