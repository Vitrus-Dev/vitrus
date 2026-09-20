// packages/core/src/metrics/bundle.ts
// MetricBundle — the product's backbone.
//
// The rule: NUMBERS DO NOT COME OUT OF AN LLM. They are
// computed here first, by deterministic queries; the LLM is handed only this
// bundle and is FORBIDDEN from producing a new number (insight/guard.ts enforces
// this fail-closed).
//
// Every piece of evidence explains itself: {sql, params, window, value}. When a
// user asks "where did this number come from", what they get is not a
// manufactured explanation but the query that actually ran.

import type { Store } from "../store/store.ts";
import { applyFilters, filterValues, windowCount, type Filter } from "./filters.ts";
import { HUMAN, HUMAN_STRICT, metricsFor, type MetricDef, type MetricUnit, type ParamContext } from "./queries.ts";

export interface TimeWindow {
  from: number;
  to: number;
  label: string;
}

export interface SeriesPoint {
  /** Start of the bucket (ms). */
  ts: number;
  views: number;
  visitors: number;
  sessions: number;
  events: number;
}

export interface Evidence {
  /** Short id for citation in prose: "e1", "e2"... */
  id: string;
  metric: string;
  label: string;
  unit: MetricUnit;
  sql: string;
  params: unknown[];
  window: TimeWindow;
  /** Set when kind = "scalar". */
  value: number | null;
  /** Set when kind = "rows". */
  rows: Record<string, unknown>[];
  /** Set when kind = "series" — with empty buckets already FILLED (see fillSeries). */
  series?: SeriesPoint[];
  /** When a comparison window was given: the same SQL, different parameters. */
  previous?: number | null;
  previousParams?: unknown[];
  /** (value - previous) / previous * 100, rounded to one decimal. null when previous = 0. */
  deltaPct?: number | null;
  deltaAbs?: number | null;
}

export interface MetricBundle {
  siteId: string;
  vertical: "landing" | "shopify" | "generic";
  window: TimeWindow;
  compare: TimeWindow | null;
  generatedAt: number;
  evidence: Evidence[];
  /** The numbers allowed to appear in prose (the guard consumes this). */
  allowedNumbers: number[];
}

export function windowOf(to: number, days: number, label = `last ${days} days`): TimeWindow {
  return { from: to - days * 86_400_000, to, label };
}

/** The preceding window of equal length. */
export function previousWindow(w: TimeWindow, label = "previous period"): TimeWindow {
  const span = w.to - w.from;
  return { from: w.from - span, to: w.from, label };
}

/**
 * Time-series bucket size. Target: ~24-90 points on screen.
 * Hard-coding "day" would produce a single column over a 24-hour window.
 */
export function bucketFor(w: TimeWindow): number {
  const span = w.to - w.from;
  if (span <= 2 * 3_600_000) return 60_000; // ≤2h   → minutes
  if (span <= 3 * 86_400_000) return 3_600_000; // ≤3d   → hours
  if (span <= 90 * 86_400_000) return 86_400_000; // ≤90d  → days
  return 7 * 86_400_000; // beyond → weeks
}

/** The "live" window: the last 5 minutes (industry standard). */
export const LIVE_WINDOW_MS = 5 * 60_000;

function contextFor(siteId: string, w: TimeWindow, now: number, filters: readonly Filter[]): ParamContext {
  return {
    siteId,
    from: w.from,
    to: w.to,
    bucketMs: bucketFor(w),
    liveFrom: now - LIVE_WINDOW_MS,
    now,
    filterValues: filterValues(filters),
  };
}

/**
 * Parameters for a metric, in the order its placeholders appear.
 *
 * With filters active the statement has extra placeholders — one block per
 * window predicate, appended immediately after it (see filters.ts). The count
 * is checked against the FILTERED sql rather than the original, so a mistake
 * here fails loudly at build time instead of binding the wrong value to the
 * wrong column and returning a plausible number.
 */
function paramsFor(
  def: MetricDef,
  siteId: string,
  w: TimeWindow,
  now: number,
  filters: readonly Filter[],
  filteredSql: string
): unknown[] {
  const slots = (filteredSql.match(/\?/g) ?? []).length;
  const values = filterValues(filters);

  // Custom builder: time-series and live metrics need inputs other than the
  // window triple. They append the filter values themselves, because only they
  // know where their own placeholders sit.
  if (def.params) {
    const out = def.params(contextFor(siteId, w, now, filters));
    if (out.length !== slots) {
      throw new Error(`metric ${def.id}: ${slots} placeholders but ${out.length} parameters produced`);
    }
    return out;
  }

  const windows = windowCount(def.sql);
  const expected = windows * (3 + values.length);
  if (slots !== expected) {
    throw new Error(
      `metric ${def.id}: ${slots} placeholders but ${windows} window predicate(s) with ` +
        `${values.length} filter(s) account for ${expected} — the WINDOW template is broken`
    );
  }
  const out: unknown[] = [];
  for (let i = 0; i < windows; i++) out.push(siteId, w.from, w.to, ...values);
  return out;
}

function numberOf(row: Record<string, unknown> | undefined): number | null {
  if (!row) return null;
  const v = row.value;
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export async function buildBundle(
  store: Store,
  opts: {
    siteId: string;
    vertical?: "landing" | "shopify" | "generic";
    window: TimeWindow;
    compare?: TimeWindow | null;
    now?: number;
    /** Compiled into every metric's WHERE clause, never applied in the browser. */
    filters?: readonly Filter[];
    /**
     * Also exclude requests carrying automation signals.
     *
     * Off by default and never applied silently: the swapped predicate is
     * visible in the evidence panel, so the number and the query still agree.
     */
    strictBots?: boolean;
  }
): Promise<MetricBundle> {
  const vertical = opts.vertical ?? "generic";
  const filters = opts.filters ?? [];
  const defs = metricsFor(vertical);
  const compare = opts.compare ?? null;
  const evidence: Evidence[] = [];

  const now = opts.now ?? Date.now();
  let n = 0;
  for (const def of defs) {
    n++;
    // The FILTERED statement is what runs and what the evidence panel shows.
    // Showing the unfiltered one would mean the query on screen does not
    // produce the number next to it.
    // Strict mode swaps the human predicate itself, so the query the user can
    // click on is the query that produced the number they are looking at.
    const base = opts.strictBots ? def.sql.split(HUMAN).join(HUMAN_STRICT) : def.sql;
    const sql = applyFilters(base, filters);
    const params = paramsFor(def, opts.siteId, opts.window, now, filters, sql);
    const rows = await store.select<Record<string, unknown>>(sql, params);

    const e: Evidence = {
      id: `e${n}`,
      metric: def.id,
      label: def.label,
      unit: def.unit,
      sql,
      params,
      window: opts.window,
      value: def.kind === "scalar" ? numberOf(rows[0]) : null,
      rows: def.kind === "rows" ? rows : [],
    };

    if (def.kind === "series") {
      e.series = fillSeries(rows, opts.window);
    }

    if (compare && def.kind === "scalar" && !def.noCompare) {
      const prevParams = paramsFor(def, opts.siteId, compare, now, filters, sql);
      const prevRows = await store.select<Record<string, unknown>>(sql, prevParams);
      const prev = numberOf(prevRows[0]);
      e.previousParams = prevParams;
      e.previous = prev;
      if (e.value !== null && prev !== null) {
        e.deltaAbs = round(e.value - prev, 1);
        e.deltaPct = prev === 0 ? null : round(((e.value - prev) / prev) * 100, 1);
      } else {
        e.deltaAbs = null;
        e.deltaPct = null;
      }
    }

    evidence.push(e);
  }

  return {
    siteId: opts.siteId,
    vertical,
    window: opts.window,
    compare,
    generatedAt: opts.now ?? Date.now(),
    evidence,
    allowedNumbers: collectAllowed(evidence, opts.window, compare),
  };
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/**
 * Fill sparse buckets with ZERO.
 *
 * SQL returns only the buckets that HAVE data. Plot that raw and days with no
 * traffic vanish from the chart, leaving a flat line — an impression of
 * "uninterrupted traffic" that is a false claim. The filling happens here, not
 * in SQL: otherwise every query would have to build a calendar table.
 *
 * Capped at 400 points: beyond that an SVG is unreadable and the JSON bloats.
 */
export const MAX_SERIES_POINTS = 400;

function fillSeries(rows: Record<string, unknown>[], w: TimeWindow): SeriesPoint[] {
  const bucketMs = bucketFor(w);
  const count = Math.min(MAX_SERIES_POINTS, Math.max(1, Math.ceil((w.to - w.from) / bucketMs)));
  const byBucket = new Map<number, Record<string, unknown>>();
  for (const r of rows) {
    const b = Number(r.bucket);
    if (Number.isFinite(b)) byBucket.set(b, r);
  }
  const out: SeriesPoint[] = [];
  for (let i = 0; i < count; i++) {
    const r = byBucket.get(i);
    out.push({
      ts: w.from + i * bucketMs,
      views: Number(r?.views ?? 0),
      visitors: Number(r?.visitors ?? 0),
      sessions: Number(r?.sessions ?? 0),
      events: Number(r?.events ?? 0),
    });
  }
  return out;
}

/**
 * The RAW numbers allowed to appear in prose: values from the evidence plus
 * window information. POLICY — rounding, absolute values, "0 and 100 are always
 * free" — does NOT live here; it is applied in the guard
 * (insight/guard.ts `expandAllowed`), so the policy stays in one place.
 */
function collectAllowed(evidence: Evidence[], w: TimeWindow, compare: TimeWindow | null): number[] {
  const set = new Set<number>();
  const add = (v: unknown): void => {
    if (typeof v !== "number" || !Number.isFinite(v)) return;
    set.add(v);
  };

  for (const e of evidence) {
    add(e.value);
    add(e.previous);
    add(e.deltaPct);
    add(e.deltaAbs);
    for (const row of e.rows) for (const v of Object.values(row)) add(v);
    // Series points are evidence too: a sentence like "106 visits on 12 Nov"
    // has to be able to pass the guard. The timestamp itself is not added — that
    // is a date, not a measurement.
    for (const p of e.series ?? []) {
      add(p.views);
      add(p.visitors);
      add(p.sessions);
      add(p.events);
    }
  }

  // Window information
  const days = Math.round((w.to - w.from) / 86_400_000);
  add(days);
  for (const d of [new Date(w.from), new Date(w.to - 1)]) {
    add(d.getUTCDate());
    add(d.getUTCMonth() + 1);
    add(d.getUTCFullYear());
  }
  if (compare) add(Math.round((compare.to - compare.from) / 86_400_000));

  return [...set].sort((a, b) => a - b);
}

/** Shortcut: find evidence by metric id. */
export function evidenceOf(bundle: MetricBundle, metricId: string): Evidence | undefined {
  return bundle.evidence.find((e) => e.metric === metricId);
}
