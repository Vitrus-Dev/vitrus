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

  if (Object.prototype.hasOwnProperty.call(props, "revenue")) normalizeRevenue(props);

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
  // `hostname` arrives from the client and is stored as the client said it —
  // the same trust as the url it came with. Anything that is not a plausible
  // hostname is dropped rather than stored, so the hostnames table can never
  // become a place to smuggle arbitrary text.
  const hostname = str(b.hostname, 253).trim().toLowerCase();
  if (hostname && /^[a-z0-9.-]{1,253}$/.test(hostname)) event.hostname = hostname.replace(/^www\./, "");

  return { ok: true, event };
}

/** Largest single amount accepted. Above it is almost certainly a unit mistake (cents sent as units). */
export const REVENUE_MAX = 1_000_000_000;

/**
 * `revenue` + `currency` on an event (see metrics/revenue.ts), normalised once
 * at the door so every query can trust the shape: `revenue` a finite number
 * ≥ 0 rounded to 4 places, `currency` an upper-case ISO 4217 code.
 *
 * An invalid amount does NOT reject the event — the event happened; only its
 * amount is unusable. The amount is removed and the reason is kept in
 * `_revenue_rejected`, so the revenue page can say "12 purchases carried an
 * amount we could not accept, because …" instead of quietly reporting less.
 *
 * No currency conversion, here or anywhere: an exchange rate is a number from
 * somewhere else, and summing EUR into USD would put an unprovable figure in
 * the total.
 */
function normalizeRevenue(props: Record<string, string | number | boolean | null>): void {
  const raw = props.revenue;
  let amount = NaN;
  if (typeof raw === "number") amount = raw;
  else if (typeof raw === "string" && /^\s*\d+(\.\d+)?\s*$/.test(raw)) amount = Number(raw);
  const currency = String(props.currency ?? "").trim().toUpperCase();
  let reason = "";
  if (!Number.isFinite(amount)) reason = "amount_not_a_number";
  else if (amount < 0) reason = "amount_negative";
  else if (amount > REVENUE_MAX) reason = "amount_too_large";
  else if (!currency) reason = "currency_missing";
  else if (!/^[A-Z]{3}$/.test(currency)) reason = "currency_invalid";
  if (reason) {
    delete props.revenue;
    props._revenue_rejected = reason;
    return;
  }
  props.revenue = Math.round(amount * 10_000) / 10_000;
  props.currency = currency;
}
