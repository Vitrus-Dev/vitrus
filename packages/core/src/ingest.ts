// packages/core/src/ingest.ts
// The ingest pipeline: validate → bot verdict → UA → URL/UTM → channel →
// visitor/session → write.
//
// DECISION: bot traffic is LABELLED (`bot_kind`), never DISCARDED. Umami and
// Plausible throw bots away; we keep them because "which of my pages is GPTBot
// reading" is a FEATURE of this product (the GEO/AEO feedback loop). Human
// metrics are always computed with a `bot_kind = ''` filter — the risk of the
// two mixing is closed off at the query layer, not at ingest.

import { agentTrust, verifyAgent, type AgentKeys, type AgentVerdict } from "./agent.ts";
import { detectBot } from "./bots.ts";
import { headerSignals, score, serializeSignals } from "./signals.ts";
import { classifyReferrer, parseUtm } from "./referrers.ts";
import type { RawEvent, RequestContext, StoredEvent } from "./types.ts";
import { parseUa } from "./ua.ts";
import { SESSION_WINDOW_MS, identityId, visitorId } from "./visitor.ts";
import type { Store } from "./store/store.ts";
import { validateEvent } from "./validate.ts";
import { applyToContext, applyToRaw, applyToStored, blockedByDoNotTrack, policyFor } from "./privacy.ts";

/**
 * Everything the ORIGIN saw about the request, when the caller is a server.
 *
 * The browser beacon can supply none of this — a Web Bot Auth signature lives
 * on the page request, which JavaScript never sees. So these arrive only from
 * the server-side ingest path, and their absence is the normal case.
 */
export interface AgentContext {
  /** Verbatim request headers, lower-cased keys. */
  headers?: Record<string, string | undefined>;
  /** The host the request was addressed to — what "@authority" must equal. */
  authority?: string;
  method?: string;
  path?: string;
  /** The operator key cache. Without it nothing can be verified. */
  keys?: AgentKeys;
}

export interface IngestOptions {
  /** The secret salt for the visitor hash. Generated at install time, kept in the meta table. */
  secret: string;
  /** Accept an unregistered site id (a dev convenience). Default: no. */
  allowUnknownSites?: boolean;
  /** Request headers, for strict-mode Do Not Track enforcement. */
  headers?: Headers;
}

export type IngestResult =
  | { ok: true; event: StoredEvent }
  | { ok: false; reason: string; status: 400 | 404 | 202 };

/** Split a URL into path + query. The fragment (#) is dropped: it never reaches the server anyway, and is noise if it does. */
export function splitUrl(raw: string, fallbackHost = "localhost"): { path: string; query: string; host: string } {
  let u: URL;
  try {
    // A protocol-relative reference ("//host/path") is a URL, not a path: left
    // alone it was stored as the literal path "//host/path", which then appears
    // in the top-pages table as a page that does not exist. The browser script
    // sends `location.href` and never produces one, but server-side ingest
    // takes a url from the caller, and some frameworks hand out exactly this.
    const absolute = raw.includes("://")
      ? raw
      : raw.startsWith("//")
        ? `https:${raw}`
        : `https://${fallbackHost}${raw.startsWith("/") ? "" : "/"}${raw}`;
    u = new URL(absolute);
  } catch {
    return { path: "/", query: "", host: fallbackHost };
  }
  let path = u.pathname || "/";
  // Normalise the trailing slash: "/pricing/" and "/pricing" are the same page (except at the root).
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  // A hash-router route ("#/settings", sent only when the site opted in with
  // data-hash="true") IS the page in such an app, so it is kept. Any other
  // fragment is an in-page anchor and is dropped as before.
  if (u.hash.startsWith("#/")) path += u.hash;
  return { path, query: u.search, host: u.hostname.toLowerCase().replace(/^www\./, "") };
}

/** The sub-country fields of an event, cleaned. Absent → "" / null, never 0. */
function geoFields(ctx: RequestContext): Pick<StoredEvent, "region" | "regionName" | "city" | "lat" | "lon"> {
  const g = ctx.geo;
  const country = (ctx.country ?? "").toUpperCase().slice(0, 2);
  if (!g || !country) return { region: "", regionName: "", city: "", lat: null, lon: null };
  const region = typeof g.region === "string" && g.region.startsWith(`${country}-`) ? g.region.slice(0, 6) : "";
  const num = (v: unknown, limit: number): number | null =>
    typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= limit ? Math.round(v * 10) / 10 : null;
  let lat = num(g.lat, 90);
  let lon = num(g.lon, 180);
  if (lat === null || lon === null) {
    lat = null;
    lon = null;
  }
  return {
    region,
    regionName: String(g.regionName ?? "").slice(0, 80),
    city: String(g.city ?? "").slice(0, 80),
    lat,
    lon,
  };
}

export class Ingestor {
  constructor(
    private readonly store: Store,
    private readonly opts: IngestOptions
  ) {}

  async ingest(body: unknown, ctxIn: RequestContext): Promise<IngestResult> {
    let ctx = ctxIn;
    const parsed = validateEvent(body);
    if (!parsed.ok) return { ok: false, reason: parsed.reason, status: 400 };
    let raw: RawEvent = parsed.event;

    const site = await this.store.getSite(raw.site);
    if (!site && !this.opts.allowUnknownSites) return { ok: false, reason: "site_unknown", status: 404 };

    // Per-site privacy policy. Enforced HERE, on the server: the browser script
    // can be edited by anyone, so a guarantee made in the client is not a
    // guarantee. See privacy.ts.
    const policy = policyFor(site?.privacyMode);
    if (this.opts.headers && blockedByDoNotTrack(this.opts.headers, policy)) {
      return { ok: false, reason: "do_not_track", status: 202 };
    }
    raw = applyToRaw(raw, policy);
    ctx = applyToContext(ctx, policy);

    const bot = detectBot(ctx.userAgent);

    // A user-agent is the client's sentence about itself; a signature is proof.
    // Verification only ever PROMOTES a label (see agent.ts) — a missing
    // signature never makes a visitor suspicious, because almost nothing signs
    // yet and "unsigned means fake" would be a second unprovable claim.
    let agent: AgentVerdict | null = null;
    const agentCtx = (ctx.agent ?? null) as AgentContext | null;

    // Layer two: does this request LOOK like the browser it claims to be? Only
    // recorded — it changes no number on its own (see signals.ts).
    const signals = headerSignals({
      headers: (agentCtx?.headers ?? {}) as Record<string, string | undefined>,
      userAgent: ctx.userAgent,
    });
    if (agentCtx?.keys && agentCtx.headers) {
      agent = await verifyAgent({
        headers: agentCtx.headers,
        authority: agentCtx.authority ?? site?.domain ?? ctx.host ?? "",
        method: agentCtx.method,
        path: agentCtx.path,
        now: ctx.now,
        keys: agentCtx.keys,
      });
    }
    const ua = parseUa(ctx.userAgent);
    const { path, query, host } = splitUrl(raw.url, site?.domain || ctx.host || "localhost");
    const utm = parseUtm(query);
    const selfHost = site?.domain || host;
    const ref = classifyReferrer({ referrer: raw.referrer ?? "", utm, selfHost });

    const vid = visitorId({
      secret: this.opts.secret,
      siteId: raw.site,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      now: ctx.now,
    });

    const existing = await this.store.findSession(raw.site, vid, ctx.now - SESSION_WINDOW_MS);
    const sessionId = existing ?? crypto.randomUUID();

    const event: StoredEvent = {
      id: crypto.randomUUID(),
      siteId: raw.site,
      visitorId: vid,
      sessionId,
      ts: ctx.now,
      type: raw.type,
      name: raw.type === "pageview" ? "pageview" : (raw.name ?? "event"),
      path,
      query,
      title: raw.title ?? "",
      hostname: raw.hostname ?? "",
      referrer: raw.referrer ?? "",
      referrerHost: ref.referrerHost,
      channel: ref.channel,
      source: ref.source,
      utm,
      device: bot.isBot ? "bot" : ua.device,
      os: ua.os,
      browser: ua.browser,
      screen: raw.screen ?? "",
      lang: raw.lang ?? "",
      country: (ctx.country ?? "").toUpperCase().slice(0, 2),
      // Sub-country location is only meaningful under the country it came
      // with; without a country it is dropped rather than stored orphaned.
      ...geoFields(ctx),
      tag: raw.tag ?? "",
      identity: identityId({ secret: this.opts.secret, siteId: raw.site, raw: raw.identity ?? "" }),
      botKind: bot.kind,
      botName: bot.name,
      agentTrust: agent ? agentTrust(bot, agent) : bot.isBot ? "claimed" : "human",
      agentSigner: agent?.trust === "verified" ? agent.signer : "",
      botSignals: serializeSignals(signals),
      botScore: score(signals),
      props: { ...(raw.props ?? {}), _signal: ref.signal },
    };

    const stored = applyToStored(event, policy);
    await this.store.insertEvent(stored);
    return { ok: true, event: stored };
  }
}
