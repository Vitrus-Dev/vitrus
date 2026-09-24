// packages/core/src/types.ts
// The event model. One rule: NO field that arrives from the browser is trusted
// directly — `RawEvent` is what the client claims, `StoredEvent` is what the
// server decided.

/** Traffic channel. `ai` = a human arriving from an AI assistant; an AI crawler never lands here (see bots.ts). */
import type { AgentTrust } from "./agent.ts";

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
  /**
   * The page's own hostname, as the browser reported it. Client-reported, so
   * it has exactly the trust of `url`: good for telling production from a
   * staging copy that shares a site id, useless as proof of anything.
   */
  hostname?: string;
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
  /**
   * Sub-country location, from the SAME proxy as `country` (see core/geo.ts,
   * `geoFromHeaders`). Every field optional and usually absent: on Cloudflare
   * it needs the "Add visitor location headers" managed transform. Coordinates
   * are already rounded to 0.1° by the time they get here.
   */
  geo?: {
    region?: string;
    regionName?: string;
    city?: string;
    lat?: number | null;
    lon?: number | null;
  };
  /**
   * What the ORIGIN saw, when the caller is a server rather than a browser.
   *
   * A Web Bot Auth signature travels on the page request; JavaScript never
   * sees one, so this arrives only from the server-side ingest path. Typed as
   * `unknown` here to keep the event model free of the verifier's types — the
   * ingest layer narrows it (see ingest.ts, AgentContext).
   */
  agent?: unknown;
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
  /** Hostname the page was served on ("" when unknown). See RawEvent.hostname. */
  hostname: string;
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
  /**
   * ISO-3166-2 subdivision with country prefix ("US-TX"); "" when the proxy
   * sent none. Optional on the type so code that builds events by hand (seeds,
   * tests) does not have to know about it; the store writes "" for absent.
   */
  region?: string;
  /** Subdivision name as the proxy spelled it; "" when absent. */
  regionName?: string;
  /** City name as the proxy spelled it; "" when absent. */
  city?: string;
  /** Rounded to 0.1° (city precision, deliberately); null when unknown — never 0. */
  lat?: number | null;
  lon?: number | null;
  /** Release/variant tag; "" when unset. */
  tag: string;
  /** HASH of the persistent identity ("" when identify was never called). The raw identity is never stored. */
  identity: string;
  /** Which kind of bot, if any (see bots.ts). "" for human traffic. */
  botKind: "" | BotKind;
  botName: string;
  /**
   * How well we know what this client is.
   *
   * `claimed` is what a user-agent can ever be worth — the client's own
   * sentence about itself. `verified` means a Web Bot Auth signature was
   * checked against the operator's published key (see agent.ts). The two are
   * never merged, because the distinction is the product.
   */
  agentTrust: AgentTrust;
  /** The key directory that vouched for a verified agent; "" otherwise. */
  agentSigner: string;
  /**
   * Automation signals the request carried, as a comma-separated rule list.
   *
   * NOT a verdict. These are recorded so a suspicion can be explained later,
   * and they do not remove anything from anyone's numbers by themselves —
   * excluding them is a choice the operator makes and can see. See signals.ts.
   */
  botSignals: string;
  /** Sum of the signal weights. 0 for everything that looks like a browser. */
  botScore: number;
  props: Record<string, string | number | boolean | null>;
}

/**
 * What kind of non-human client this is.
 *
 * `ai-crawler` and `ai-agent` are deliberately separate. A crawler reads in
 * bulk with nobody waiting; an agent fetch happens because a person asked a
 * question thirty seconds ago. Summed together they answer neither "is a model
 * indexing me" nor "am I being consulted".
 *
 * A third case has no entry here at all: an agentic BROWSER (ChatGPT Atlas,
 * Operator) runs JavaScript and sends an ordinary Chrome user-agent, so no
 * table can name it. It is identified by its signature instead — see agent.ts
 * and the AGENT_SESSION filter in metrics/queries.ts.
 */
export type BotKind = "ai-crawler" | "ai-agent" | "search-crawler" | "seo" | "monitor" | "preview" | "generic";

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
