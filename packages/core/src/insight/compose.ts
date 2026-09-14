// packages/core/src/insight/compose.ts
// The digest composer — FULLY DETERMINISTIC. No LLM.
//
// This file produces the product's "what happened → why → what to do" output
// from evidence records, using templates. The LLM layer (llm.ts) does not
// REPLACE this, it writes on top of it, and if its output cannot pass the guard
// we fall back to the text produced here. So in the worst case the product still
// answers correctly, just less fluently.

import type { Evidence, MetricBundle } from "../metrics/bundle.ts";
import { evidenceOf } from "../metrics/bundle.ts";

export type LineKind = "headline" | "change" | "peak" | "ai" | "funnel" | "quality" | "action";

export interface DigestLine {
  kind: LineKind;
  text: string;
  /** The evidence ids that produced this sentence ("e3"). Clickable in the dashboard. */
  evidence: string[];
}

export interface Digest {
  siteId: string;
  vertical: string;
  window: { from: number; to: number; label: string };
  generatedAt: number;
  headline: string;
  lines: DigestLine[];
  /** True when an LLM was used and the guard dropped sentences — shown to the user. */
  degraded: boolean;
  /** A summary of the evidence bundle behind the digest (how many metrics). */
  evidenceCount: number;
}

/** Number format: "," for thousands, "." for decimals. The guard can parse this. */
export function fmt(n: number, digits = 0): string {
  const fixed = n.toFixed(digits);
  const [intPart = "0", decPart] = fixed.split(".");
  const neg = intPart.startsWith("-");
  const digitsOnly = neg ? intPart.slice(1) : intPart;
  const grouped = digitsOnly.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const head = (neg ? "-" : "") + grouped;
  return decPart ? `${head}.${decPart}` : head;
}

/**
 * Percentage format. A decimal only WHEN IT MATTERS: "0.0%" and "100.0%" are
 * noise, "33.3%" is information.
 *
 * The sign is dropped here on purpose — the sentence carries the direction as a
 * word ("up 12%", "down 12%"), so "down -12%" can never happen.
 */
function pct(n: number): string {
  const a = Math.abs(n);
  const rounded = Math.round(a * 10) / 10;
  return `${fmt(a, Number.isInteger(rounded) ? 0 : 1)}%`;
}

/** Write a metric value according to its unit: percentages with "%", counts plain. */
function valueText(value: number, unit: string): string {
  return unit === "percent" ? pct(value) : fmt(value, 0);
}

function changeWord(delta: number): string {
  return delta >= 0 ? "up" : "down";
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * A date label ("12 Sep"). `toLocaleDateString` is NOT USED: its output depends
 * on the locale of the machine running it, so the same code would produce one
 * string on the server and another in a test — and the text the guard sees has
 * to be deterministic.
 */
function dayLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function topRow(e: Evidence | undefined): Record<string, unknown> | undefined {
  return e?.rows[0];
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Significance thresholds: on a small base, a percentage swing is noise (the false-positive brake). */
const MIN_BASE = 20;
const MIN_DELTA_PCT = 15;

export function composeDigest(bundle: MetricBundle): Digest {
  const lines: DigestLine[] = [];
  const visitors = evidenceOf(bundle, "visitors.unique");
  const sessions = evidenceOf(bundle, "sessions.total");
  const views = evidenceOf(bundle, "pageviews.total");

  // — Headline —
  const v = visitors?.value ?? 0;
  let headline = `${bundle.window.label}: ${fmt(v)} unique visitors, ${fmt(sessions?.value ?? 0)} sessions, ${fmt(views?.value ?? 0)} pageviews.`;
  if (visitors?.deltaPct !== null && visitors?.deltaPct !== undefined && (visitors.previous ?? 0) >= MIN_BASE) {
    headline += ` Visitors are ${changeWord(visitors.deltaPct)} ${pct(visitors.deltaPct)} against the previous period.`;
  }
  lines.push({ kind: "headline", text: headline, evidence: ids([visitors, sessions, views]) });

  // — Significant changes (only when the base is large enough) —
  for (const e of bundle.evidence) {
    if (e.metric === "visitors.unique") continue;
    if (e.value === null || e.previous === null || e.previous === undefined) continue;
    if (e.deltaPct === null || e.deltaPct === undefined) continue;
    if (Math.abs(e.deltaPct) < MIN_DELTA_PCT) continue;
    if (e.unit === "count" && e.previous < MIN_BASE) continue;
    lines.push({
      kind: "change",
      text: `${e.label}: ${valueText(e.value, e.unit)} — previous period ${valueText(e.previous, e.unit)}, ${changeWord(e.deltaPct)} ${pct(e.deltaPct)}.`,
      evidence: [e.id],
    });
  }

  // — Peak day (the EVIDENCE-BACKED version of the sentence across Litlyx's top bar) —
  // Only stated when the peak is clearly above the mean: every window has a
  // maximum, but not every maximum is news.
  const series = evidenceOf(bundle, "timeseries")?.series ?? [];
  if (series.length >= 3) {
    const peak = series.reduce((a, p) => (p.views > a.views ? p : a), series[0] as (typeof series)[number]);
    const total = series.reduce((a, p) => a + p.views, 0);
    const mean = total / series.length;
    if (peak.views > 0 && mean > 0 && peak.views >= mean * 1.5) {
      lines.push({
        kind: "peak",
        text: `Busiest period was ${dayLabel(peak.ts)}: ${fmt(peak.views)} views, ${fmt(peak.visitors)} visitors (period average ${fmt(mean, 0)}).`,
        evidence: ids([evidenceOf(bundle, "timeseries")]),
      });
    }
  }

  // — AI traffic (the wedge on display) —
  const ai = evidenceOf(bundle, "ai.sessions");
  const aiSources = evidenceOf(bundle, "ai.sources");
  const crawler = evidenceOf(bundle, "ai.crawler.hits");
  const crawlerPages = evidenceOf(bundle, "ai.crawler.pages");
  if ((ai?.value ?? 0) > 0) {
    const share = sessions?.value ? (ai!.value! / sessions.value) * 100 : 0;
    const top = topRow(aiSources);
    const topText = top ? ` Mostly ${String(top.source)} (${fmt(num(top.sessions) ?? 0)} sessions).` : "";
    lines.push({
      kind: "ai",
      text: `${fmt(ai!.value ?? 0)} sessions arrived from AI assistants — ${pct(share)} of all sessions.${topText}`,
      evidence: ids([ai, aiSources, sessions]),
    });
  }
  if ((crawler?.value ?? 0) > 0) {
    const top = topRow(crawlerPages);
    const topText = top ? ` Most-read page: ${String(top.path)} (${String(top.bot_name)}, ${fmt(num(top.hits) ?? 0)} requests).` : "";
    lines.push({
      kind: "ai",
      text: `AI crawlers made ${fmt(crawler!.value ?? 0)} requests — these are NOT human visitors and are not included in the visitor count.${topText}`,
      evidence: ids([crawler, crawlerPages]),
    });
  }

  // — The landing funnel —
  const ctaConv = evidenceOf(bundle, "cta.conversion");
  const signups = evidenceOf(bundle, "signups.total");
  const abandon = evidenceOf(bundle, "form.abandon_fields");
  const rage = evidenceOf(bundle, "rage.clicks");
  if (ctaConv && ctaConv.value !== null) {
    lines.push({
      kind: "funnel",
      text: `Share of sessions with a CTA click: ${pct(ctaConv.value)}. Signup events: ${fmt(signups?.value ?? 0)}.`,
      evidence: ids([ctaConv, signups]),
    });
  }
  const worstField = topRow(abandon);
  if (worstField && (num(worstField.abandons) ?? 0) > 0) {
    lines.push({
      kind: "funnel",
      text: `The field where forms are abandoned most is "${String(worstField.field)}" — left ${fmt(num(worstField.abandons) ?? 0)} times at this field.`,
      evidence: ids([abandon]),
    });
  }
  if ((rage?.value ?? 0) > 0) {
    lines.push({
      kind: "quality",
      text: `${fmt(rage!.value ?? 0)} rage clicks recorded (a sign of an element that is not responding).`,
      evidence: ids([rage]),
    });
  }

  // — Actions: rule-driven, nothing invented —
  for (const a of actionsFor(bundle)) lines.push(a);

  return {
    siteId: bundle.siteId,
    vertical: bundle.vertical,
    window: bundle.window,
    generatedAt: bundle.generatedAt,
    headline,
    lines,
    degraded: false,
    evidenceCount: bundle.evidence.length,
  };
}

function ids(list: (Evidence | undefined)[]): string[] {
  return list.filter((e): e is Evidence => !!e).map((e) => e.id);
}

/** Suggested actions are a rule table; each one is tied to a piece of evidence. */
function actionsFor(bundle: MetricBundle): DigestLine[] {
  const out: DigestLine[] = [];
  const bounce = evidenceOf(bundle, "bounce.rate");
  const ctaConv = evidenceOf(bundle, "cta.conversion");
  const abandon = evidenceOf(bundle, "form.abandon_fields");
  const ai = evidenceOf(bundle, "ai.sessions");
  const crawler = evidenceOf(bundle, "ai.crawler.hits");

  if (bounce?.value !== null && bounce?.value !== undefined && bounce.value >= 70) {
    out.push({
      kind: "action",
      text: `Bounce rate is ${pct(bounce.value)}. Compare the promise on the entry page with what the incoming traffic expects to find.`,
      evidence: [bounce.id],
    });
  }
  if (ctaConv?.value !== null && ctaConv?.value !== undefined && ctaConv.value < 5) {
    out.push({
      kind: "action",
      text: `CTA click rate is low at ${pct(ctaConv.value)}. Check the CTA's visibility on mobile and whether it sits above the fold.`,
      evidence: [ctaConv.id],
    });
  }
  const field = topRow(abandon);
  if (field) {
    out.push({
      kind: "action",
      text: `Consider removing the "${String(field.field)}" field or making it optional; cutting the number of form fields lowers abandonment directly.`,
      evidence: abandon ? [abandon.id] : [],
    });
  }
  if ((crawler?.value ?? 0) > 0 && (ai?.value ?? 0) === 0) {
    out.push({
      kind: "action",
      text: `AI crawlers are reading the site but no clicks are arriving from AI assistants yet — the pages being read may lack clear answers or quotable definitions.`,
      evidence: ids([crawler, ai]),
    });
  }
  return out;
}

/** Plain text for Slack/email. Evidence ids travel in square brackets. */
export function renderText(digest: Digest): string {
  const head = `Vitrus — ${digest.window.label}`;
  const body = digest.lines.map((l) => `• ${l.text}${l.evidence.length ? ` [${l.evidence.join(", ")}]` : ""}`).join("\n");
  const foot = digest.degraded
    ? "\n\n(Note: some sentences were removed because they could not be verified against the evidence.)"
    : "";
  return `${head}\n\n${body}${foot}`;
}
