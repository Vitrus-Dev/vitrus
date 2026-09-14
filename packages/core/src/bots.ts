// packages/core/src/bots.ts
// Bot detection — DETERMINISTIC, a versioned table. No LLM.
//
// The critical distinction (most tools conflate these):
//   AI CRAWLER  = GPTBot/ClaudeBot/PerplexityBot → READS the site, no human present. It is a bot.
//   AI REFERRAL = a real browser with a chatgpt.com referrer → brings a HUMAN. It is NOT a bot.
// Show them together and the "I have AI traffic" claim is both inflated and misread.
//
// The table version is deliberately part of the data model: a classification
// depends on the table that produced it, so which version labelled a row is
// part of the evidence.

import type { BotKind } from "./types.ts";

export const BOT_TABLE_VERSION = "2026-09-13";

export interface BotRule {
  /** Lower-case substring searched for inside the UA, or a regex. */
  match: string | RegExp;
  name: string;
  kind: BotKind;
}

/** Order matters: the first match wins (specific → generic). */
export const BOT_RULES: readonly BotRule[] = [
  // — AI crawlers / model training & retrieval agents —
  { match: "gptbot", name: "GPTBot", kind: "ai-crawler" },
  { match: "oai-searchbot", name: "OAI-SearchBot", kind: "ai-crawler" },
  { match: "chatgpt-user", name: "ChatGPT-User", kind: "ai-crawler" },
  { match: "claudebot", name: "ClaudeBot", kind: "ai-crawler" },
  { match: "claude-web", name: "Claude-Web", kind: "ai-crawler" },
  { match: "claude-user", name: "Claude-User", kind: "ai-crawler" },
  { match: "anthropic-ai", name: "anthropic-ai", kind: "ai-crawler" },
  { match: "perplexitybot", name: "PerplexityBot", kind: "ai-crawler" },
  { match: "perplexity-user", name: "Perplexity-User", kind: "ai-crawler" },
  { match: "google-extended", name: "Google-Extended", kind: "ai-crawler" },
  { match: "googleother", name: "GoogleOther", kind: "ai-crawler" },
  { match: "bytespider", name: "Bytespider", kind: "ai-crawler" },
  { match: "ccbot", name: "CCBot", kind: "ai-crawler" },
  { match: "meta-externalagent", name: "Meta-ExternalAgent", kind: "ai-crawler" },
  { match: "applebot-extended", name: "Applebot-Extended", kind: "ai-crawler" },
  { match: "amazonbot", name: "Amazonbot", kind: "ai-crawler" },
  { match: "cohere-ai", name: "cohere-ai", kind: "ai-crawler" },
  { match: "diffbot", name: "Diffbot", kind: "ai-crawler" },
  { match: "youbot", name: "YouBot", kind: "ai-crawler" },
  { match: "timpibot", name: "Timpibot", kind: "ai-crawler" },
  { match: "img2dataset", name: "img2dataset", kind: "ai-crawler" },

  // — Search engine crawlers —
  { match: "googlebot", name: "Googlebot", kind: "search-crawler" },
  { match: "bingbot", name: "bingbot", kind: "search-crawler" },
  { match: "duckduckbot", name: "DuckDuckBot", kind: "search-crawler" },
  { match: "yandexbot", name: "YandexBot", kind: "search-crawler" },
  { match: "baiduspider", name: "Baiduspider", kind: "search-crawler" },
  { match: "applebot", name: "Applebot", kind: "search-crawler" },
  { match: "slurp", name: "Yahoo! Slurp", kind: "search-crawler" },

  // — SEO / marketing crawlers —
  { match: "ahrefsbot", name: "AhrefsBot", kind: "seo" },
  { match: "semrushbot", name: "SemrushBot", kind: "seo" },
  { match: "mj12bot", name: "MJ12bot", kind: "seo" },
  { match: "dotbot", name: "DotBot", kind: "seo" },
  { match: "petalbot", name: "PetalBot", kind: "seo" },
  { match: "screaming frog", name: "Screaming Frog", kind: "seo" },
  { match: "dataforseobot", name: "DataForSeoBot", kind: "seo" },

  // — Link preview (social share cards) —
  { match: "facebookexternalhit", name: "facebookexternalhit", kind: "preview" },
  { match: "twitterbot", name: "Twitterbot", kind: "preview" },
  { match: "slackbot", name: "Slackbot", kind: "preview" },
  { match: "discordbot", name: "Discordbot", kind: "preview" },
  { match: "telegrambot", name: "TelegramBot", kind: "preview" },
  { match: "whatsapp", name: "WhatsApp", kind: "preview" },
  { match: "linkedinbot", name: "LinkedInBot", kind: "preview" },
  { match: "embedly", name: "Embedly", kind: "preview" },

  // — Monitoring / uptime —
  { match: "uptimerobot", name: "UptimeRobot", kind: "monitor" },
  { match: "pingdom", name: "Pingdom", kind: "monitor" },
  { match: "betteruptime", name: "Better Uptime", kind: "monitor" },
  { match: "statuscake", name: "StatusCake", kind: "monitor" },
  { match: "lighthouse", name: "Lighthouse", kind: "monitor" },
  { match: "chrome-lighthouse", name: "Lighthouse", kind: "monitor" },
  { match: "gtmetrix", name: "GTmetrix", kind: "monitor" },

  // — Generic automation signatures (last: far too broad) —
  { match: "headlesschrome", name: "HeadlessChrome", kind: "generic" },
  { match: "phantomjs", name: "PhantomJS", kind: "generic" },
  { match: "puppeteer", name: "Puppeteer", kind: "generic" },
  { match: "playwright", name: "Playwright", kind: "generic" },
  { match: "python-requests", name: "python-requests", kind: "generic" },
  { match: "axios/", name: "axios", kind: "generic" },
  { match: "node-fetch", name: "node-fetch", kind: "generic" },
  { match: "curl/", name: "curl", kind: "generic" },
  { match: "wget", name: "Wget", kind: "generic" },
  { match: "go-http-client", name: "Go-http-client", kind: "generic" },
  { match: "java/", name: "Java", kind: "generic" },
  { match: /\bbot\b/, name: "generic bot", kind: "generic" },
  { match: "crawler", name: "generic crawler", kind: "generic" },
  { match: "spider", name: "generic spider", kind: "generic" },
];

export interface BotVerdict {
  isBot: boolean;
  kind: "" | BotKind;
  name: string;
  tableVersion: string;
}

const HUMAN: BotVerdict = { isBot: false, kind: "", name: "", tableVersion: BOT_TABLE_VERSION };

/**
 * The bot verdict for a UA. An empty UA counts as a bot: real browsers always
 * send one, so an empty UA is either a script or a tool hiding itself — counting
 * it as human would inflate the numbers silently.
 */
export function detectBot(userAgent: string): BotVerdict {
  const ua = (userAgent || "").toLowerCase().trim();
  if (ua === "") return { isBot: true, kind: "generic", name: "empty user-agent", tableVersion: BOT_TABLE_VERSION };
  for (const rule of BOT_RULES) {
    const hit = typeof rule.match === "string" ? ua.includes(rule.match) : rule.match.test(ua);
    if (hit) return { isBot: true, kind: rule.kind, name: rule.name, tableVersion: BOT_TABLE_VERSION };
  }
  return HUMAN;
}
