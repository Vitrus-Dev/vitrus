// packages/core/src/metrics/performance.ts
// Core Web Vitals at a chosen percentile — overall, against the previous
// period, by dimension and over time.
//
// Definitions, stated once:
//   * The tracker sends one `web_vitals` event per page, on exit, from
//     browsers that support PerformanceObserver (see tracker.ts). A metric a
//     browser cannot measure is simply absent from that event.
//   * Percentile = nearest rank on the sorted samples: the value at rank
//     min(n, floor(p·n) + 1) — the same rank formula `vitals.p75` in the
//     bundle uses. (That older metric only counts events that carried an LCP;
//     here every vital is ranked over the events that carried IT, so INP/CLS
//     can differ slightly when some pages reported no LCP.)
//   * A group with no samples has no percentile — it is left out, never 0.
//
// Everything that shapes the SQL — the metric column, the dimension column,
// the percentile — comes from a closed allow-list or is a bound parameter.

import { applyFilters, filterValues, resolvePatternFilters } from "./filters.ts";
import type { Query, Scope, Select } from "./explore.ts";
import { HUMAN } from "./queries.ts";

export const VITAL_KEYS = ["lcp", "inp", "cls", "fcp", "ttfb"] as const;
export type VitalKey = (typeof VITAL_KEYS)[number];
export const PERCENTILES = [50, 75, 90, 99] as const;
export const PERF_DIMENSIONS = ["path", "device", "browser", "os", "country"] as const;
export type PerfDimension = (typeof PERF_DIMENSIONS)[number];

export class PerformanceError extends Error {}

export interface PerformanceOptions extends Scope {
  percentile?: number;
  by?: string;
  bucketMs: number;
  /** The comparison window (same length, immediately before). */
  previous?: { from: number; to: number };
}

export interface VitalSummary {
  value: number | null;
  samples: number;
  previous: number | null;
  previousSamples: number;
  evidence: Query<{ value: number | null; samples: number }>;
}

export interface PerformanceResult {
  percentile: number;
  by: PerfDimension;
  overview: Record<VitalKey, VitalSummary>;
  breakdown: Record<VitalKey, Query<{ g: string; value: number | null; samples: number }>>;
  series: Record<VitalKey, Query<{ g: number; value: number | null; samples: number }>>;
}

/**
 * One percentile query. `group` is either null (overall), a dimension column,
 * or the bucket expression; its parameters (if any) come first because it is
 * the first thing in the innermost SELECT.
 */
function percentileSql(metric: VitalKey, group: { expr: string; params: unknown[] } | null, filtersSql: string) {
  const g = group ? `${group.expr} AS g, ` : "";
  const part = group ? "PARTITION BY g " : "";
  const sql = `SELECT ${group ? "g, " : ""}ROUND(MAX(CASE WHEN rn = MIN(n, CAST(? * n AS INTEGER) + 1) THEN val END), 3) AS value,
       MAX(n) AS samples
  FROM (SELECT ${group ? "g, " : ""}val,
               ROW_NUMBER() OVER (${part}ORDER BY val) AS rn,
               COUNT(*) OVER (${group ? "PARTITION BY g" : ""}) AS n
          FROM (SELECT ${g}CAST(json_extract(props, '$.${metric}') AS REAL) AS val
                  FROM events
                 WHERE ${filtersSql} AND ${HUMAN} AND name = 'web_vitals')
         WHERE val IS NOT NULL)${group ? "\n GROUP BY g" : ""}`;
  return sql;
}

async function run<T>(select: Select, label: string, sql: string, params: unknown[]): Promise<Query<T>> {
  const slots = (sql.match(/\?/g) ?? []).length;
  if (slots !== params.length) throw new Error(`${label}: ${slots} placeholders but ${params.length} parameters`);
  return { label, sql, params, rows: await select<T>(sql, params) };
}

export async function computePerformance(select: Select, o: PerformanceOptions): Promise<PerformanceResult> {
  const pct = Number(o.percentile ?? 75);
  if (!(PERCENTILES as readonly number[]).includes(pct)) {
    throw new PerformanceError(`percentile must be one of ${PERCENTILES.join(", ")}`);
  }
  const by = (o.by ?? "path") as PerfDimension;
  if (!(PERF_DIMENSIONS as readonly string[]).includes(by)) {
    throw new PerformanceError(`cannot break performance down by "${o.by}"`);
  }
  const p = pct / 100;
  const filters = await resolvePatternFilters(select, o.siteId, o.filters ?? []);
  const fv = filterValues(filters, o.siteId);
  const where = applyFilters(`site_id = ? AND ts >= ? AND ts < ?`, filters);
  const win = (from: number, to: number) => [o.siteId, from, to, ...fv];

  const overview = {} as PerformanceResult["overview"];
  const breakdown = {} as PerformanceResult["breakdown"];
  const series = {} as PerformanceResult["series"];

  for (const m of VITAL_KEYS) {
    const sql = percentileSql(m, null, where);
    const cur = await run<{ value: number | null; samples: number }>(select, `${m} p${pct}`, sql, [p, ...win(o.from, o.to)]);
    let previous: number | null = null;
    let previousSamples = 0;
    if (o.previous) {
      const prev = await select<{ value: number | null; samples: number | null }>(sql, [p, ...win(o.previous.from, o.previous.to)]);
      previous = prev[0]?.value ?? null;
      previousSamples = Number(prev[0]?.samples ?? 0);
    }
    overview[m] = {
      value: cur.rows[0]?.value ?? null,
      samples: Number(cur.rows[0]?.samples ?? 0),
      previous,
      previousSamples,
      evidence: cur,
    };

    const bsql = percentileSql(m, { expr: by, params: [] }, where) + `\n ORDER BY samples DESC, g ASC LIMIT 50`;
    breakdown[m] = await run(select, `${m} p${pct} by ${by}`, bsql, [p, ...win(o.from, o.to)]);

    const bucketMs = Math.max(60_000, Math.round(o.bucketMs));
    const ssql = percentileSql(m, { expr: `CAST((ts - ?) / ? AS INTEGER)`, params: [o.from, bucketMs] }, where) + `\n ORDER BY g ASC`;
    series[m] = await run(select, `${m} p${pct} over time`, ssql, [p, o.from, bucketMs, ...win(o.from, o.to)]);
  }
  return { percentile: pct, by, overview, breakdown, series };
}
