// packages/core/src/referrers.ts
// Channel classification — DETERMINISTIC, a versioned table, no LLM.
//
// This is the product's first wedge: roughly 70% of AI referral traffic lands in
// GA4's "direct" bucket. ChatGPT appends `utm_source=chatgpt.com`; Gemini and
// Perplexity mostly do not. So classification looks at THREE signals in order:
// utm → referrer host → (failing both) direct.
//
// The result is measured by an eval set (eval/ai-referrer). Change the table and
// the eval re-runs, which turns "going stale quietly" into a CI failure.

import type { Channel, Utm } from "./types.ts";

export const REFERRER_TABLE_VERSION = "2026-09-13";

/** Host suffix → readable source name. Matches an exact host or a `.`-delimited suffix. */
type HostTable = Readonly<Record<string, string>>;

/** AI assistants that send humans (NOT crawlers — those live in bots.ts). */
export const AI_HOSTS: HostTable = {
  "chatgpt.com": "chatgpt",
  "chat.openai.com": "chatgpt",
  "openai.com": "chatgpt",
  "perplexity.ai": "perplexity",
  "www.perplexity.ai": "perplexity",
  "claude.ai": "claude",
  "gemini.google.com": "gemini",
  "bard.google.com": "gemini",
  "aistudio.google.com": "gemini",
  "copilot.microsoft.com": "copilot",
  "m365.cloud.microsoft": "copilot",
  "you.com": "you",
  "phind.com": "phind",
  "poe.com": "poe",
  "grok.com": "grok",
  "x.ai": "grok",
  "mistral.ai": "mistral",
  "chat.mistral.ai": "mistral",
  "deepseek.com": "deepseek",
  "chat.deepseek.com": "deepseek",
  "kagi.com": "kagi",
  "andisearch.com": "andi",
  "iask.ai": "iask",
  "komo.ai": "komo",
};

export const SEARCH_HOSTS: HostTable = {
  "google.com": "google",
  "google.com.tr": "google",
  "bing.com": "bing",
  "duckduckgo.com": "duckduckgo",
  "yandex.com": "yandex",
  "yandex.ru": "yandex",
  "search.brave.com": "brave",
  "ecosia.org": "ecosia",
  "startpage.com": "startpage",
  "baidu.com": "baidu",
  "yahoo.com": "yahoo",
  "search.marginalia.nu": "marginalia",
};

export const SOCIAL_HOSTS: HostTable = {
  "x.com": "x",
  "twitter.com": "x",
  "t.co": "x",
  "linkedin.com": "linkedin",
  "lnkd.in": "linkedin",
  "facebook.com": "facebook",
  "l.facebook.com": "facebook",
  "instagram.com": "instagram",
  "reddit.com": "reddit",
  "out.reddit.com": "reddit",
  "news.ycombinator.com": "hackernews",
  "producthunt.com": "producthunt",
  "youtube.com": "youtube",
  "youtu.be": "youtube",
  "tiktok.com": "tiktok",
  "threads.net": "threads",
  "bsky.app": "bluesky",
  "mastodon.social": "mastodon",
  "medium.com": "medium",
  "dev.to": "devto",
  "discord.com": "discord",
  "t.me": "telegram",
  "github.com": "github",
  "stackoverflow.com": "stackoverflow",
};

export const EMAIL_HOSTS: HostTable = {
  "mail.google.com": "gmail",
  "outlook.live.com": "outlook",
  "outlook.office.com": "outlook",
  "mail.yahoo.com": "yahoo-mail",
  "mail.proton.me": "proton",
  "substack.com": "substack",
};

/** The channel each utm_medium value maps to. */
const MEDIUM_CHANNEL: Readonly<Record<string, Channel>> = {
  cpc: "paid",
  ppc: "paid",
  paid: "paid",
  paidsearch: "paid",
  paid_search: "paid",
  paid_social: "paid",
  display: "paid",
  banner: "paid",
  retargeting: "paid",
  email: "email",
  newsletter: "email",
  mail: "email",
  social: "social",
  organic: "search",
  referral: "referral",
  affiliate: "referral",
};

export interface ReferrerVerdict {
  channel: Channel;
  /** Readable source: "chatgpt", "google", "reddit", a utm_source, or the referrer host. */
  source: string;
  referrerHost: string;
  /** Which signal produced the verdict — shown in the evidence panel, so it is not a guess. */
  signal: "internal" | "utm_source" | "utm_medium" | "referrer" | "none";
  tableVersion: string;
}

export function parseUtm(query: string): Utm {
  const p = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  const get = (k: string): string | undefined => {
    const v = p.get(k);
    return v && v.trim() !== "" ? v.trim().toLowerCase() : undefined;
  };
  const utm: Utm = {};
  const source = get("utm_source") ?? get("ref") ?? get("source");
  const medium = get("utm_medium");
  const campaign = get("utm_campaign");
  const term = get("utm_term");
  const content = get("utm_content");
  if (source) utm.source = source;
  if (medium) utm.medium = medium;
  if (campaign) utm.campaign = campaign;
  if (term) utm.term = term;
  if (content) utm.content = content;
  // Ad platform click ids: proof the visit was paid even when no utm is present.
  if (!utm.medium && (p.has("gclid") || p.has("fbclid") || p.has("msclkid") || p.has("ttclid"))) {
    utm.medium = "cpc";
  }
  return utm;
}

export function hostOf(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url.includes("://") ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function lookup(table: HostTable, host: string): string | undefined {
  if (!host) return undefined;
  const direct = table[host];
  if (direct) return direct;
  // Subdomains: "chat.chatgpt.com" → "chatgpt.com"
  for (const key of Object.keys(table)) {
    if (host === key || host.endsWith(`.${key}`)) return table[key];
  }
  return undefined;
}

/** Table precedence — only consulted for SUFFIX matches. */
const TABLES: readonly (readonly [Channel, HostTable])[] = [
  ["ai", AI_HOSTS],
  ["email", EMAIL_HOSTS],
  ["search", SEARCH_HOSTS],
  ["social", SOCIAL_HOSTS],
];

/**
 * Host → (channel, source).
 *
 * Two phases, and the ORDER MATTERS (a test caught this): exact match first,
 * suffix second. Otherwise `mail.google.com` matched the "google.com" suffix and
 * came out as `search` — even though it has an exact match in the EMAIL table.
 * Within the suffix phase the LONGEST key wins: the most specific definition is
 * the correct one.
 */
function matchHost(host: string): { channel: Channel; source: string } | undefined {
  if (!host) return undefined;
  for (const [channel, table] of TABLES) {
    const exact = table[host];
    if (exact) return { channel, source: exact };
  }
  let best: { channel: Channel; source: string; keyLength: number } | undefined;
  for (const [channel, table] of TABLES) {
    for (const key of Object.keys(table)) {
      if (host.endsWith(`.${key}`) && (!best || key.length > best.keyLength)) {
        best = { channel, source: table[key] as string, keyLength: key.length };
      }
    }
  }
  return best ? { channel: best.channel, source: best.source } : undefined;
}

/** Whether a source name or host is an AI assistant (covers `utm_source=chatgpt.com`). */
export function aiSourceOf(value: string): string | undefined {
  const v = value.toLowerCase().trim();
  if (!v) return undefined;
  const byHost = lookup(AI_HOSTS, v.replace(/^www\./, ""));
  if (byHost) return byHost;
  // Bare names such as utm_source=chatgpt / claude / perplexity
  const names = new Set(Object.values(AI_HOSTS));
  return names.has(v) ? v : undefined;
}

/**
 * The channel verdict. The precedence is deliberate:
 *   1) internal (our own host) — navigation within a session is not a source
 *   2) utm_source carries an AI name → ai   (ChatGPT appends `utm_source=chatgpt.com`)
 *   3) referrer host tables          → ai / search / social / email / referral
 *   4) utm_medium                    → paid / email / social / ...
 *   5) a bare utm_source             → referral (tagged, but an unrecognised campaign)
 *   6) none of the above             → direct
 * Putting 3 ahead of 4 is intentional: the referrer is something we actually
 * observed, while utm is a claim made by whoever wrote the link. Observation
 * beats assertion.
 */
export function classifyReferrer(input: {
  referrer: string;
  utm: Utm;
  selfHost?: string;
}): ReferrerVerdict {
  const referrerHost = hostOf(input.referrer);
  const self = (input.selfHost || "").toLowerCase().replace(/^www\./, "");
  const base = { referrerHost, tableVersion: REFERRER_TABLE_VERSION };

  if (referrerHost && self && (referrerHost === self || referrerHost.endsWith(`.${self}`))) {
    return { ...base, channel: "internal", source: "", signal: "internal" };
  }

  if (input.utm.source) {
    const ai = aiSourceOf(input.utm.source);
    if (ai) return { ...base, channel: "ai", source: ai, signal: "utm_source" };
  }

  if (referrerHost) {
    const hit = matchHost(referrerHost);
    if (hit) {
      // With a paid-click marker present, search/social become paid (the source is kept).
      const paid = input.utm.medium ? MEDIUM_CHANNEL[input.utm.medium] === "paid" : false;
      const channel: Channel = paid && (hit.channel === "search" || hit.channel === "social") ? "paid" : hit.channel;
      return { ...base, channel, source: hit.source, signal: channel === "paid" ? "utm_medium" : "referrer" };
    }
  }

  if (input.utm.medium) {
    const ch = MEDIUM_CHANNEL[input.utm.medium];
    if (ch) return { ...base, channel: ch, source: input.utm.source || referrerHost, signal: "utm_medium" };
  }

  if (referrerHost) return { ...base, channel: "referral", source: referrerHost, signal: "referrer" };
  if (input.utm.source) return { ...base, channel: "referral", source: input.utm.source, signal: "utm_source" };

  return { ...base, channel: "direct", source: "", signal: "none" };
}
