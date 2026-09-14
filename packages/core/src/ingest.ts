// packages/core/src/ingest.ts
// The ingest pipeline: validate → bot verdict → UA → URL/UTM → channel →
// visitor/session → write.
//
// DECISION: bot traffic is LABELLED (`bot_kind`), never DISCARDED. Umami and
// Plausible throw bots away; we keep them because "which of my pages is GPTBot
// reading" is a FEATURE of this product (the GEO/AEO feedback loop). Human
// metrics are always computed with a `bot_kind = ''` filter — the risk of the
// two mixing is closed off at the query layer, not at ingest.

import { detectBot } from "./bots.ts";
import { classifyReferrer, parseUtm } from "./referrers.ts";
import type { RawEvent, RequestContext, StoredEvent } from "./types.ts";
import { parseUa } from "./ua.ts";
import { SESSION_WINDOW_MS, identityId, visitorId } from "./visitor.ts";
import type { Store } from "./store/store.ts";
import { validateEvent } from "./validate.ts";
import { applyToContext, applyToRaw, applyToStored, blockedByDoNotTrack, policyFor } from "./privacy.ts";

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
    u = new URL(raw.includes("://") ? raw : `https://${fallbackHost}${raw.startsWith("/") ? "" : "/"}${raw}`);
  } catch {
    return { path: "/", query: "", host: fallbackHost };
  }
  let path = u.pathname || "/";
  // Normalise the trailing slash: "/pricing/" and "/pricing" are the same page (except at the root).
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return { path, query: u.search, host: u.hostname.toLowerCase().replace(/^www\./, "") };
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
      tag: raw.tag ?? "",
      identity: identityId({ secret: this.opts.secret, siteId: raw.site, raw: raw.identity ?? "" }),
      botKind: bot.kind,
      botName: bot.name,
      props: { ...(raw.props ?? {}), _signal: ref.signal },
    };

    const stored = applyToStored(event, policy);
    await this.store.insertEvent(stored);
    return { ok: true, event: stored };
  }
}
