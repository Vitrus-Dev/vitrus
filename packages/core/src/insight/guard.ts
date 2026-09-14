// packages/core/src/insight/guard.ts
// THE NUMERIC GUARD — the gatekeeper of this product's one real difference.
//
// "Attach a query id to every claim" is NOT enough: a model can cite the right
// id and still invent the wrong number. So the gate stands at the exit instead:
// EVERY number in the LLM's prose must be in the set the MetricBundle allows.
// A sentence containing a number that is not gets DROPPED (fail-closed) and the
// digest is flagged as degraded.
//
// "No evidence" and "evidence CANNOT EXIST" are different things; in the second
// case the model does not get to speak at all.

import type { MetricBundle } from "../metrics/bundle.ts";

export interface NumberToken {
  raw: string;
  /** More than one reading when the locale separator is ambiguous (see `interpret`). */
  candidates: number[];
  ambiguous: boolean;
}

export interface GuardResult {
  ok: boolean;
  /** The text made up of proven sentences only. */
  text: string;
  kept: string[];
  dropped: { sentence: string; numbers: string[] }[];
  /** Causal-language violations (writing correlation as if it were causation). */
  causalityViolations: { sentence: string; phrase: string }[];
}

/**
 * Verbs FORBIDDEN in a correlation sentence. We may say "coincides with"; we may
 * not say "caused" — a false causal claim destroys trust in this product in one
 * shot.
 */
const CAUSAL_PHRASES = [
  "caused",
  "causes",
  "caused by",
  "led to",
  "resulted in",
  "broke",
  "due to",
  "because of",
  "thanks to",
  "responsible for",
];

/** Context markers where the causality lock applies (deploy/commit/release sentences). */
const CORRELATION_CONTEXT = ["commit", "deploy", "theme", "release", "version", "rollout"];

const CITATION_RE = /\[(?:e\d+(?:\s*,\s*e\d+)*)\]/gi;
const ISO_DATE_RE = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/g;
const TIME_RE = /\b\d{1,2}:\d{2}\b/g;
// Paths and URLs are LABELS, not measurements: the 10 inside "/blog/10-tips"
// carries no claim. It must not drop the sentence just for being absent from the
// evidence set.
const PATH_RE = /(?:https?:\/\/)?\/[^\s"'<>,;]*/g;
// A digit right after a letter or digit is not counted ("GPT-4", "e12", "utm_5").
const NUMBER_RE = /(?<![\p{L}\d_-])[+-]?\d[\d.,]*/gu;

export function extractNumbers(text: string): NumberToken[] {
  const cleaned = text
    .replace(CITATION_RE, " ")
    .replace(ISO_DATE_RE, " ")
    .replace(TIME_RE, " ")
    .replace(PATH_RE, " ");
  const out: NumberToken[] = [];
  for (const m of cleaned.matchAll(NUMBER_RE)) {
    const raw = m[0].replace(/[.,]+$/, "");
    if (raw === "" || raw === "+" || raw === "-") continue;
    const tok = interpret(raw);
    if (tok.candidates.length > 0) out.push(tok);
  }
  return out;
}

/**
 * Ambiguity: "1.234" is one-point-two-three-four in en-US and one thousand two
 * hundred thirty-four in most of Europe. Picking one reading produces silent
 * errors, so BOTH readings are produced and the number is accepted when ONE of
 * them is in the evidence set. The concession is deliberate: we relax
 * fail-closed by one step for separator ambiguity, and in exchange we never drop
 * correctly written text by mistake. The ambiguity is flagged on the token.
 */
function interpret(raw: string): NumberToken {
  const neg = raw.startsWith("-");
  const body = raw.replace(/^[+-]/, "");
  const lastDot = body.lastIndexOf(".");
  const lastComma = body.lastIndexOf(",");
  const sign = neg ? -1 : 1;
  const cands = new Set<number>();
  let ambiguous = false;

  const asDecimal = (sep: "." | ","): number | null => {
    const other = sep === "." ? "," : ".";
    const s = body.split(other).join("").replace(sep, ".");
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const asGrouping = (): number | null => {
    const s = body.replace(/[.,]/g, "");
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  if (lastDot === -1 && lastComma === -1) {
    const n = Number(body);
    if (Number.isFinite(n)) cands.add(sign * n);
  } else if (lastDot !== -1 && lastComma !== -1) {
    // Both present: the LAST one is the decimal separator (true in both locales).
    const dec = asDecimal(lastDot > lastComma ? "." : ",");
    if (dec !== null) cands.add(sign * dec);
  } else {
    const sep: "." | "," = lastDot !== -1 ? "." : ",";
    const after = body.length - body.lastIndexOf(sep) - 1;
    const dec = asDecimal(sep);
    const grp = asGrouping();
    if (after === 3) {
      // "1.234" / "1,234" — readable as either grouping or a decimal.
      if (grp !== null) cands.add(sign * grp);
      if (dec !== null) cands.add(sign * dec);
      ambiguous = cands.size > 1;
    } else if (dec !== null) {
      cands.add(sign * dec);
    }
  }

  return { raw, candidates: [...cands], ambiguous };
}

function splitSentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function checkCausality(text: string): { sentence: string; phrase: string }[] {
  const out: { sentence: string; phrase: string }[] = [];
  for (const s of splitSentences(text)) {
    const low = s.toLowerCase();
    if (!CORRELATION_CONTEXT.some((c) => low.includes(c))) continue;
    for (const p of CAUSAL_PHRASES) {
      if (low.includes(p)) out.push({ sentence: s, phrase: p });
    }
  }
  return out;
}

/**
 * Filter prose against the evidence set. A sentence with an unsupported number
 * is dropped. With `strictCausality` on, a sentence with a causality violation
 * is dropped too.
 */
function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/**
 * The allowance policy lives in ONE place: here.
 *
 * Derived from the raw evidence values:
 *  - absolute value ("down 18%" when the delta is -18)
 *  - rounding to 0/1/2 decimals (evidence of 42.47, prose writes "42.5")
 *  - 0 and 100 are always free ("none", "100%" need no evidence)
 *
 * This expansion sits in the guard, NOT in the bundle builder: policy belongs in
 * the layer that enforces it. (In the first version it lived in the bundle, and
 * the eval caught it with two wrongly dropped sentences — the eval set proved
 * its own reason for existing.)
 */
export function expandAllowed(values: readonly number[]): Set<number> {
  const set = new Set<number>([0, 100]);
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    for (const base of [v, Math.abs(v)]) {
      for (const d of [0, 1, 2]) set.add(round(base, d));
      set.add(base);
    }
  }
  return set;
}

export function guardProse(
  prose: string,
  bundle: Pick<MetricBundle, "allowedNumbers">,
  opts: { strictCausality?: boolean } = {}
): GuardResult {
  const allowed = expandAllowed(bundle.allowedNumbers);
  const kept: string[] = [];
  const dropped: GuardResult["dropped"] = [];
  const causality = checkCausality(prose);
  const causalSentences = new Set(causality.map((c) => c.sentence));

  for (const sentence of splitSentences(prose)) {
    const bad: string[] = [];
    for (const tok of extractNumbers(sentence)) {
      if (!tok.candidates.some((c) => allowed.has(c))) bad.push(tok.raw);
    }
    const causalHit = opts.strictCausality !== false && causalSentences.has(sentence);
    if (bad.length > 0) dropped.push({ sentence, numbers: bad });
    else if (causalHit) dropped.push({ sentence, numbers: [] });
    else kept.push(sentence);
  }

  return {
    ok: dropped.length === 0,
    text: kept.join(" "),
    kept,
    dropped,
    causalityViolations: causality,
  };
}
