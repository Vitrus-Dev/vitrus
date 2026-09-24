// packages/core/src/privacy.ts
// Per-site privacy mode.
//
// ═══ WHY THIS IS A SERVER-SIDE FEATURE ═══
// Strict mode is enforced during ingest, NOT in the tracker. Anyone can edit the
// browser script; the server is the only place a guarantee can actually hold.
// This is the same rule the rest of ingest follows: the client proposes, the
// server decides.
//
// Two modes, and the difference is what we REFUSE to store:
//
//   standard — the defaults. Country (from the proxy header), screen size and
//              full referrer are kept. Already cookie-free and without a
//              persistent identifier.
//
//   strict   — for teams whose counsel wants the smallest possible footprint
//              (EU/GDPR, KVKK). Drops data that is either location-adjacent or
//              useful for fingerprinting, and disables cross-day identity
//              entirely. Do Not Track can no longer be overridden.
//
// Strict mode COSTS you something and we say so: no country breakdown, no screen
// sizes, no retention cohorts. A toggle that quietly kept collecting would be
// worse than no toggle at all.

import type { RawEvent, RequestContext, StoredEvent } from "./types.ts";

export type PrivacyMode = "standard" | "strict";

export interface PrivacyPolicy {
  mode: PrivacyMode;
  /** Store the country resolved from the proxy header. */
  storeCountry: boolean;
  /** Store screen dimensions (a fingerprinting surface). */
  storeScreen: boolean;
  /** Keep the referrer query string (can carry personal data in campaign URLs). */
  keepReferrerQuery: boolean;
  /** Allow `identify()` — the precondition for retention. */
  allowIdentity: boolean;
  /** Honour Do Not Track even when the site opts out of it. */
  forceDoNotTrack: boolean;
  /** Maximum number of custom event properties kept. */
  maxProps: number;
}

export const POLICIES: Readonly<Record<PrivacyMode, PrivacyPolicy>> = {
  standard: {
    mode: "standard",
    storeCountry: true,
    storeScreen: true,
    keepReferrerQuery: true,
    allowIdentity: true,
    forceDoNotTrack: false,
    maxProps: 24,
  },
  strict: {
    mode: "strict",
    storeCountry: false,
    storeScreen: false,
    keepReferrerQuery: false,
    allowIdentity: false,
    forceDoNotTrack: true,
    maxProps: 8,
  },
};

export function policyFor(mode: string | undefined | null): PrivacyPolicy {
  return mode === "strict" ? POLICIES.strict : POLICIES.standard;
}

/** What a site loses by turning strict mode on. Shown in the dashboard verbatim. */
export const STRICT_TRADEOFFS = [
  "Country breakdown is empty — the proxy header is discarded on arrival.",
  "Screen sizes are not recorded.",
  "Referrer query strings are stripped; only the hostname and path are kept.",
  "Retention cannot be computed — identify() is ignored, so there are no cohorts.",
  "Do Not Track is always honoured and cannot be overridden per site.",
  "Custom events keep at most 8 properties.",
] as const;

/**
 * Strip the referrer down to origin + path.
 *
 * Campaign URLs regularly carry an email address or a customer id in the query
 * string. In standard mode we keep it because it is often the only way to tell
 * two campaigns apart; in strict mode we throw it away before it is written.
 */
export function stripReferrer(referrer: string): string {
  if (!referrer) return "";
  try {
    const u = new URL(referrer);
    return `${u.origin}${u.pathname}`;
  } catch {
    // Unparseable referrer: keep only the part before the first "?" rather than
    // guessing. Never invent a value.
    const q = referrer.indexOf("?");
    return q === -1 ? referrer : referrer.slice(0, q);
  }
}

/** Apply the policy to an incoming event before validation-derived fields are used. */
export function applyToRaw(raw: RawEvent, policy: PrivacyPolicy): RawEvent {
  if (policy.mode === "standard") return raw;

  const out: RawEvent = { ...raw };
  if (!policy.storeScreen) delete out.screen;
  if (!policy.allowIdentity) delete out.identity;
  if (raw.referrer && !policy.keepReferrerQuery) out.referrer = stripReferrer(raw.referrer);

  if (out.props) {
    const entries = Object.entries(out.props).slice(0, policy.maxProps);
    out.props = Object.fromEntries(entries);
  }
  return out;
}

/** Apply the policy to request-level context (country lives here, not in the body). */
export function applyToContext(ctx: RequestContext, policy: PrivacyPolicy): RequestContext {
  if (policy.storeCountry) return ctx;
  const out = { ...ctx };
  delete out.country;
  // City, subdivision and coordinates are finer than country; a policy that
  // refuses country refuses them too.
  delete out.geo;
  return out;
}

/** Final safety net: clear anything the policy forbids right before the write. */
export function applyToStored(event: StoredEvent, policy: PrivacyPolicy): StoredEvent {
  if (policy.mode === "standard") return event;
  return {
    ...event,
    country: policy.storeCountry ? event.country : "",
    region: policy.storeCountry ? event.region : "",
    regionName: policy.storeCountry ? event.regionName : "",
    city: policy.storeCountry ? event.city : "",
    lat: policy.storeCountry ? event.lat : null,
    lon: policy.storeCountry ? event.lon : null,
    screen: policy.storeScreen ? event.screen : "",
    identity: policy.allowIdentity ? event.identity : "",
  };
}

/**
 * Should this request be dropped for Do Not Track?
 *
 * The browser script already honours DNT by default, but a site can disable that
 * with `data-do-not-track="false"`. In strict mode that override is refused here,
 * on the server, where the site owner cannot reach it.
 */
export function blockedByDoNotTrack(headers: Headers, policy: PrivacyPolicy): boolean {
  if (!policy.forceDoNotTrack) return false;
  const dnt = headers.get("dnt") ?? headers.get("sec-gpc");
  return dnt === "1";
}
