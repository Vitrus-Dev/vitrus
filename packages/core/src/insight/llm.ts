// packages/core/src/insight/llm.ts
// The LLM layer — OPTIONAL and CONSTRAINED.
//
// Three rules (PIVOT2.md §1):
//   1. The LLM does not produce numbers. It is handed only the computed evidence bundle.
//   2. Its output goes through the guard; any sentence with an unsupported number is dropped.
//   3. If the guard drops anything, we FALL BACK to the deterministic text and the
//      digest is marked "degraded". So the worst an LLM can contribute is
//      "nothing" — never "something wrong".
//
// Provider-agnostic: Ollama (local, no data leaves the server) or any
// OpenAI-compatible endpoint (bring your own key). NEITHER is enabled by default.

import type { MetricBundle } from "../metrics/bundle.ts";
import { composeDigest, renderText, type Digest } from "./compose.ts";
import { guardProse } from "./guard.ts";

export interface LlmClient {
  readonly name: string;
  complete(prompt: string): Promise<string>;
}

export interface PhraseOutcome {
  digest: Digest;
  /** Whether the LLM was called, and how many sentences were dropped if so. */
  used: boolean;
  droppedSentences: number;
  /** The sentences the guard rejected — kept for debugging and for the eval. */
  dropped: { sentence: string; numbers: string[] }[];
}

export function buildPrompt(bundle: MetricBundle, deterministic: Digest): string {
  const facts = bundle.evidence
    .map((e) => {
      if (e.rows.length > 0) {
        const rows = e.rows.slice(0, 5).map((r) => JSON.stringify(r)).join(" ");
        return `- [${e.id}] ${e.label}: ${rows}`;
      }
      const prev = e.previous !== null && e.previous !== undefined ? ` (previous period: ${e.previous})` : "";
      return `- [${e.id}] ${e.label}: ${e.value}${prev}`;
    })
    .join("\n");

  return [
    "You are a web analytics assistant. Write a short summary using the EVIDENCE list below.",
    "",
    "HARD RULES:",
    "1. Never write a number that is NOT in the list. Do NOT compute a new ratio, percentage or total.",
    "2. End every sentence with the evidence ids you used, in square brackets: [e3].",
    "3. Do not claim causation. Never write 'caused' or 'led to'; write 'coincides with' instead.",
    "4. At most 5 sentences. Write in English. No embellishment.",
    "",
    `PERIOD: ${deterministic.window.label}`,
    "",
    "EVIDENCE:",
    facts,
    "",
    "SUMMARY:",
  ].join("\n");
}

/**
 * Re-phrase the deterministic digest with an LLM. If the guard fails, the
 * deterministic text stands — the LLM cannot break the product.
 */
export async function phraseDigest(bundle: MetricBundle, llm: LlmClient | null): Promise<PhraseOutcome> {
  const deterministic = composeDigest(bundle);
  if (!llm) return { digest: deterministic, used: false, droppedSentences: 0, dropped: [] };

  let raw: string;
  try {
    raw = await llm.complete(buildPrompt(bundle, deterministic));
  } catch {
    // If the LLM is unreachable, the product keeps working.
    return { digest: deterministic, used: false, droppedSentences: 0, dropped: [] };
  }

  const verdict = guardProse(raw, bundle, { strictCausality: true });
  if (!verdict.ok || verdict.kept.length === 0) {
    return {
      digest: { ...deterministic, degraded: true },
      used: true,
      droppedSentences: verdict.dropped.length,
      dropped: verdict.dropped,
    };
  }

  // It passed the guard cleanly: use the LLM text as the headline, and KEEP the evidence lines.
  const digest: Digest = {
    ...deterministic,
    headline: verdict.kept[0] ?? deterministic.headline,
    lines: [
      { kind: "headline", text: verdict.text, evidence: bundle.evidence.map((e) => e.id) },
      ...deterministic.lines.filter((l) => l.kind !== "headline"),
    ],
  };
  return { digest, used: true, droppedSentences: 0, dropped: [] };
}

/** Local Ollama client — no data leaves the server. */
export class OllamaClient implements LlmClient {
  readonly name: string;
  constructor(
    private readonly model: string,
    private readonly baseUrl = "http://127.0.0.1:11434"
  ) {
    this.name = `ollama:${model}`;
  }
  async complete(prompt: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt, stream: false, options: { temperature: 0 } }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const json = (await res.json()) as { response?: string };
    return json.response ?? "";
  }
}

/** An OpenAI-compatible endpoint (bring your own key). The cost stays with the user. */
export class OpenAiCompatClient implements LlmClient {
  readonly name: string;
  constructor(
    private readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.openai.com/v1"
  ) {
    this.name = `openai-compat:${model}`;
  }
  async complete(prompt: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`llm ${res.status}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? "";
  }
}

export { renderText };
