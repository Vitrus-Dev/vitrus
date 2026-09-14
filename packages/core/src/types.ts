// packages/core/src/types.ts
// The event model. One rule: NO field that arrives from the browser is trusted
// directly — `RawEvent` is what the client claims, `StoredEvent` is what the
// server decided.

/** Traffic channel. `ai` = a human arriving from an AI assistant; an AI crawler never lands here (see bots.ts). */
export type Channel = "direct" | "search" | "ai" | "social" | "referral" | "email" | "paid" | "internal";

/** The raw body the client sent. Every field is optional; validation lives in `validate.ts`. */
export interface RawEvent {
  /** Site public id (the `data-site` attribute on the tracker script). */
  site: string;
  /** "pageview" or a custom event. */
  type: "pageview" | "event";
  /** Custom event name ("cta_click", "form_field_abandon", ...). Empty for a pageview. */
  name?: string;
  /** Full URL or path+query. The origin is normalised server-side. */
  url: string;
  referrer?: string;
  title?: string;
  /** "1920x1080" */
  screen?: string;
  lang?: string;
  /** Release/variant tag (`data-tag`). The browser-side handle for deploy correlation. */
  tag?: string;
  /**
   * The site owner's own user id (`vitrus.identify("user-123")`).
   * The precondition for retention. HASHED on the server; the raw value is never stored.
   */
  identity?: string;
  /** Event payload. Values are scalars; nested objects are rejected (bloat and PII risk). */
  props?: Record<string, string | number | boolean | null>;
}

/** What the server itself observed about the request. The tracker cannot send these — if it does, they are ignored. */
export interface RequestContext {
  ip: string;
  userAgent: string;
  /** Server time (ms). Client time is NEVER used — clock skew corrupts data. */
  now: number;
  /** Host header (used to detect internal referrers). */
  host?: string;
  /**
   * ISO-3166 alpha-2 country code. Comes ONLY FROM A PROXY HEADER (Cloudflare,
   * Vercel, Fly). We do not bundle a GeoIP database — a 60+ MB file plus a
   * monthly update burden breaks the "one-command install" promise on its own.
   * With no proxy in front, this stays empty and the dashboard says so plainly;
   * that beats silently showing the wrong country.
   */
  country?: string;
}

export interface Utm {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
}

/** The record on disk. One row = one event. */
export interface StoredEvent {
  id: string;
  siteId: string;
  /** Daily-salted, cookie-free hash. Becomes a different value tomorrow (see visitor.ts). */
  visitorId: string;
  sessionId: string;
  ts: number;
  type: "pageview" | "event";
  name: string;
  path: string;
  query: string;
  title: string;
  referrer: string;
  referrerHost: string;
  channel: Channel;
  /** Readable source label: "chatgpt", "google", "reddit", a utm_source, or "". */
  source: string;
  utm: Utm;
  device: "desktop" | "mobile" | "tablet" | "bot" | "unknown";
  os: string;
  browser: string;
  screen: string;
  lang: string;
  /** ISO-3166 alpha-2; "" when no proxy header was present. */
  country: string;
  /** Release/variant tag; "" when unset. */
  tag: string;
  /** HASH of the persistent identity ("" when identify was never called). The raw identity is never stored. */
  identity: string;
  /** Which kind of bot, if any (see bots.ts). "" for human traffic. */
  botKind: "" | BotKind;
  botName: string;
  props: Record<string, string | number | boolean | null>;
}

export type BotKind = "ai-crawler" | "search-crawler" | "seo" | "monitor" | "preview" | "generic";

export interface Site {
  id: string;
  name: string;
  domain: string;
  createdAt: number;
  /**
   * Per-site privacy policy. "strict" drops country, screen size, referrer query
   * strings and cross-day identity, and refuses any Do Not Track override.
   * Enforced on the server — see privacy.ts.
   */
  privacyMode?: "standard" | "strict";
  /** Vertical: landing / shopify / generic. Selects the dashboard and digest template. */
  vertical: "landing" | "shopify" | "generic";
}
