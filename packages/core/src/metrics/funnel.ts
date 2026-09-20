// packages/core/src/metrics/funnel.ts
// Funnels — the first USER-DEFINED metric.
//
// Until now every metric was a fixed definition (the `METRICS` list). A funnel
// is different: the user writes the steps, so the SQL is GENERATED at runtime.
// That does not break the "evidence = the query that ran" principle — the
// generated query is stored verbatim and shown in the dashboard. The only thing
// that could break it is injection: step VALUES are never embedded in the SQL,
// they always travel as `?`. The only things that shape the query are the step
// COUNT and the step TYPE (which comes from a fixed union).
//
// ORDERED funnel: step N must have happened AFTER step N-1. Unordered counting
// ("this session touched both /pricing and signup") is easier but wrong: someone
// who signs up and then browses the pricing page counts as "converted" and the
// funnel inflates.

import { AGENT_SESSION, HUMAN } from "./queries.ts";

export type FunnelStepType = "page" | "event";

export interface FunnelStep {
  type: FunnelStepType;
  /** For `page`, the path (exact match); for `event`, the event name. */
  value: string;
  /** The name shown in the dashboard; falls back to `value`. */
  label?: string;
}

export interface FunnelStepResult {
  index: number;
  label: string;
  type: FunnelStepType;
  value: string;
  /** Sessions that reached this step. */
  sessions: number;
  /** Continuation rate against the previous step (%). 100 on the first step. */
  stepRate: number;
  /** Continuation rate against the first step (%). */
  totalRate: number;
  /** Sessions lost at this step (previous step - this step). */
  dropped: number;
}

export interface FunnelResult {
  steps: FunnelStepResult[];
  /** Reached the last step / reached the first step (%). */
  conversionRate: number;
  /** The step with the largest loss (highest `dropped`). null when all are 0. */
  worstStep: FunnelStepResult | null;
  /** The evidence: the generated query and its parameters. */
  sql: string;
  params: unknown[];
}

export const MAX_FUNNEL_STEPS = 8;

export class FunnelError extends Error {}

export function validateSteps(steps: FunnelStep[]): FunnelStep[] {
  if (!Array.isArray(steps) || steps.length < 2) {
    throw new FunnelError("a funnel needs at least 2 steps");
  }
  if (steps.length > MAX_FUNNEL_STEPS) {
    throw new FunnelError(`a funnel takes at most ${MAX_FUNNEL_STEPS} steps`);
  }
  return steps.map((s, i) => {
    if (s.type !== "page" && s.type !== "event") {
      throw new FunnelError(`step ${i + 1}: type must be "page" or "event"`);
    }
    const value = String(s.value ?? "").trim();
    if (!value) throw new FunnelError(`step ${i + 1}: value cannot be empty`);
    if (value.length > 200) throw new FunnelError(`step ${i + 1}: value is too long`);
    return { type: s.type, value, label: String(s.label ?? "").trim() || value };
  });
}

/**
 * Build the ordered-funnel query.
 *
 * Each step is a CTE: it finds the first match AFTER the previous step's
 * timestamp. `MIN(ts)` is used so that a repeated event within the same session
 * cannot push the funnel forward (visit /pricing twice and the second visit does
 * not count).
 */
export function buildFunnelSql(steps: FunnelStep[], audience: Audience = "human"): { sql: string; shape: FunnelStepType[] } {
  const ctes: string[] = [];
  const selects: string[] = [];

  // The audience predicate comes from the SAME constants every other metric
  // uses. This file used to inline `bot_kind = ''`, which was a copy of the
  // human filter — and once agent sessions existed that copy was wrong: an
  // agent completing a checkout was counted as a human conversion.
  const who = audience === "agent" ? AGENT_SESSION : HUMAN;
  const whoAliased = who.replace(/\b(bot_kind|agent_trust)\b/g, "e.$1");

  steps.forEach((step, i) => {
    // The column and the row type come from a FIXED union (NOT user input) —
    // they are the only things that may be embedded in the SQL. The step VALUE
    // always travels as `?`.
    const col = step.type === "page" ? "path" : "name";
    const rowType = step.type === "page" ? "pageview" : "event";

    if (i === 0) {
      ctes.push(
        `s0 AS (SELECT session_id, MIN(ts) AS t FROM events
                 WHERE site_id = ? AND ts >= ? AND ts < ? AND ${who}
                   AND type = '${rowType}' AND ${col} = ?
                 GROUP BY session_id)`
      );
    } else {
      ctes.push(
        `s${i} AS (SELECT e.session_id, MIN(e.ts) AS t FROM events e
                    JOIN s${i - 1} p ON p.session_id = e.session_id AND e.ts >= p.t
                   WHERE e.site_id = ? AND e.ts >= ? AND e.ts < ? AND ${whoAliased}
                     AND e.type = '${rowType}' AND e.${col} = ?
                   GROUP BY e.session_id)`
      );
    }
    selects.push(`(SELECT COUNT(*) FROM s${i}) AS step${i}`);
  });

  const sql = `WITH ${ctes.join(",\n     ")}\nSELECT ${selects.join(", ")}`;
  return { sql, shape: steps.map((s) => s.type) };
}

/**
 * Whose funnel this is.
 *
 * "Can an agent complete my checkout?" is a question every e-commerce site will
 * have to answer, and it cannot be asked at all if agent traffic is discarded
 * (Umami, Plausible), blocked (Rybbit) or merged into the human funnel (GA4).
 * The two are computed the same way and shown side by side; they are never
 * added together, because an agent that bounces is not a UX problem and an
 * agent that converts is not a person.
 */
export type Audience = "human" | "agent";

export interface FunnelQuery {
  siteId: string;
  from: number;
  to: number;
  steps: FunnelStep[];
  /** Defaults to "human" — the existing behaviour for every existing caller. */
  audience?: Audience;
}

export async function computeFunnel(
  select: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>,
  q: FunnelQuery
): Promise<FunnelResult> {
  const steps = validateSteps(q.steps);
  const { sql } = buildFunnelSql(steps, q.audience ?? "human");

  const params: unknown[] = [];
  for (const step of steps) params.push(q.siteId, q.from, q.to, step.value);

  const rows = await select<Record<string, number>>(sql, params);
  const row = rows[0] ?? {};

  const counts = steps.map((_, i) => Number(row[`step${i}`] ?? 0));
  const first = counts[0] ?? 0;

  const results: FunnelStepResult[] = steps.map((step, i) => {
    const sessions = counts[i] ?? 0;
    const prev = i === 0 ? sessions : (counts[i - 1] ?? 0);
    return {
      index: i,
      label: step.label ?? step.value,
      type: step.type,
      value: step.value,
      sessions,
      stepRate: i === 0 ? 100 : prev === 0 ? 0 : round1((sessions / prev) * 100),
      totalRate: first === 0 ? 0 : round1((sessions / first) * 100),
      dropped: i === 0 ? 0 : Math.max(0, prev - sessions),
    };
  });

  const last = results[results.length - 1];
  const worst = results.reduce<FunnelStepResult | null>(
    (a, s) => (s.dropped > 0 && (!a || s.dropped > a.dropped) ? s : a),
    null
  );

  return {
    steps: results,
    conversionRate: first === 0 || !last ? 0 : round1((last.sessions / first) * 100),
    worstStep: worst,
    sql,
    params,
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * A default funnel per vertical. The user should see their first funnel without
 * configuring anything — a "define a funnel first" screen is where most tools
 * get abandoned.
 */
export function defaultFunnel(vertical: "landing" | "shopify" | "generic"): FunnelStep[] {
  if (vertical === "shopify") {
    return [
      { type: "event", value: "checkout_started", label: "Started checkout" },
      { type: "event", value: "checkout_address", label: "Entered address" },
      { type: "event", value: "checkout_shipping", label: "Chose shipping" },
      { type: "event", value: "checkout_payment", label: "Entered payment details" },
      { type: "event", value: "checkout_completed", label: "Purchased" },
    ];
  }
  return [
    { type: "page", value: "/", label: "Home page" },
    { type: "event", value: "cta_click", label: "Clicked the CTA" },
    { type: "event", value: "signup", label: "Signed up" },
  ];
}
