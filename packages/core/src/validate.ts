// packages/core/src/validate.ts
// Zero-dependency body validation. Everything from the client is hostile:
// length limits, type checks, nested objects rejected. A rejected event does not
// disappear SILENTLY — the caller is told why (fail-closed, with a reason).

import type { RawEvent } from "./types.ts";

export const LIMITS = {
  site: 64,
  name: 80,
  url: 2048,
  referrer: 2048,
  title: 300,
  screen: 16,
  lang: 35,
  tag: 40,
  identity: 200,
  propKey: 40,
  propValue: 500,
  propCount: 24,
  bodyBytes: 16 * 1024,
} as const;

export type ValidationResult = { ok: true; event: RawEvent } | { ok: false; reason: string };

function str(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.length > max ? v.slice(0, max) : v;
}

export function validateEvent(body: unknown): ValidationResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, reason: "body_not_object" };
  }
  const b = body as Record<string, unknown>;

  const site = str(b.site, LIMITS.site).trim();
  if (!site) return { ok: false, reason: "site_missing" };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(site)) return { ok: false, reason: "site_invalid" };

  const type = b.type === "event" ? "event" : b.type === "pageview" ? "pageview" : null;
  if (!type) return { ok: false, reason: "type_invalid" };

  const url = str(b.url, LIMITS.url).trim();
  if (!url) return { ok: false, reason: "url_missing" };

  const name = str(b.name, LIMITS.name).trim();
  if (type === "event" && !name) return { ok: false, reason: "name_missing" };
  if (name && !/^[A-Za-z0-9_.:-]{1,80}$/.test(name)) return { ok: false, reason: "name_invalid" };

  const props: Record<string, string | number | boolean | null> = {};
  if (b.props !== undefined) {
    if (typeof b.props !== "object" || b.props === null || Array.isArray(b.props)) {
      return { ok: false, reason: "props_not_object" };
    }
    const entries = Object.entries(b.props as Record<string, unknown>);
    if (entries.length > LIMITS.propCount) return { ok: false, reason: "props_too_many" };
    for (const [k, v] of entries) {
      const key = str(k, LIMITS.propKey).trim();
      if (!key) continue;
      if (v === null) props[key] = null;
      else if (typeof v === "string") props[key] = v.slice(0, LIMITS.propValue);
      else if (typeof v === "number") {
        if (!Number.isFinite(v)) return { ok: false, reason: "prop_number_not_finite" };
        props[key] = v;
      } else if (typeof v === "boolean") props[key] = v;
      else return { ok: false, reason: "prop_type_unsupported" };
    }
  }

  const event: RawEvent = {
    site,
    type,
    url,
    props,
  };
  if (name) event.name = name;
  const referrer = str(b.referrer, LIMITS.referrer).trim();
  if (referrer) event.referrer = referrer;
  const title = str(b.title, LIMITS.title).trim();
  if (title) event.title = title;
  const screen = str(b.screen, LIMITS.screen).trim();
  if (screen && /^\d{1,5}x\d{1,5}$/.test(screen)) event.screen = screen;
  const lang = str(b.lang, LIMITS.lang).trim();
  if (lang && /^[A-Za-z-]{2,35}$/.test(lang)) event.lang = lang.toLowerCase();
  const tag = str(b.tag, LIMITS.tag).trim();
  if (tag) event.tag = tag;
  const identity = str(b.identity, LIMITS.identity).trim();
  if (identity) event.identity = identity;
  // `hostname` arrives from the client but is NOT TRUSTED: the server uses the
  // host it observed itself. We still accept the field so the body is not
  // rejected outright (forward compatibility).

  return { ok: true, event };
}
