// packages/core/src/visitor.ts
// Cookie-free visitor id — Umami's proven idea (not its code).
//
// hash(secret_salt + day + site + ip + user-agent) produces a DIFFERENT value
// tomorrow. The consequence: no persistent identifier, and no retroactive
// joining of a person's history, so the "cookie-free, consent-free measurement"
// claim actually holds technically. The IP is never stored — it is only an
// input to the hash, and the hash is one-way.

import { createHash } from "node:crypto";
import { normalizeIp } from "./ip.ts";

/** YYYY-MM-DD (UTC). The boundary at which the salt rolls over. */
export function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function visitorId(input: {
  secret: string;
  siteId: string;
  ip: string;
  userAgent: string;
  now: number;
}): string {
  const h = createHash("sha256");
  h.update(input.secret);
  h.update("|");
  h.update(dayKey(input.now));
  h.update("|");
  h.update(input.siteId);
  h.update("|");
  // NOT the raw IP — the normalised form. IPv6 privacy extensions rotate the
  // address during the day, so using the full address would count the same
  // person many times over (see ip.ts). The /64 prefix is stable for a
  // subscriber line and is less identifying.
  h.update(normalizeIp(input.ip || ""));
  h.update("|");
  h.update(input.userAgent || "");
  return h.digest("hex").slice(0, 32);
}

/** Session window: 30 minutes after the last event starts a new session (industry standard). */
export const SESSION_WINDOW_MS = 30 * 60 * 1000;

/**
 * PERSISTENT identity — only when the site owner sends one EXPLICITLY
 * (`vitrus.identify("...")`).
 *
 * Why this is a separate function: `visitorId` rotates with a daily salt, so
 * the same person becomes a different value tomorrow. That is a deliberate
 * privacy decision (I7), but it has a price: **cross-day tracking is
 * mathematically impossible**, which means retention CANNOT BE MEASURED for
 * anonymous visitors. Rather than fake it, we open a second path: if the site
 * owner sends their own user id (a logged-in user), that id is hashed
 * persistently and retention is genuinely computed.
 *
 * `dayKey` is NOT used (this has to persist), and the raw value is NOT STORED —
 * even if the site owner sends an email address, only the hash reaches disk.
 * Identifying individual people is out of scope for this product.
 */
export function identityId(input: { secret: string; siteId: string; raw: string }): string {
  const raw = input.raw.trim();
  if (!raw) return "";
  const h = createHash("sha256");
  h.update(input.secret);
  h.update("|identity|");
  h.update(input.siteId);
  h.update("|");
  h.update(preHashIdentity(input.siteId, raw));
  return h.digest("hex").slice(0, 32);
}

/**
 * The first of two hashes, and the one that can run in the BROWSER.
 *
 * `sha256(site + "|" + id)`, lower-case hex. The tracker computes it before
 * anything is sent, so the site owner's user id — often an email address —
 * never crosses the network to us; the server then hashes it again with its
 * secret (`identityId`) before it is written.
 *
 * A value that already has this shape is taken as pre-hashed and passed
 * through; anything else (a server-side SDK, an old tracker, a mobile app
 * posting raw ids) is hashed here first. Both paths therefore land on the SAME
 * stored value, so a person seen by the browser and by your backend is one
 * person.
 *
 * Why the site id is in it: the same email on two of your sites produces two
 * unrelated values. Nobody — including us — can join one person across your
 * apps. The portfolio view adds sites together and says so.
 *
 * Limitation, stated: an unsalted sha256 of a known email can be confirmed by
 * someone who already has that email and the site id. That is why this is
 * only the transport form — what reaches disk is keyed with a secret that
 * never leaves the server.
 */
export function preHashIdentity(siteId: string, raw: string): string {
  if (PRE_HASHED.test(raw)) return raw;
  return createHash("sha256").update(`${siteId}|${raw}`).digest("hex");
}

/** The browser's pre-hash: 64 lower-case hex characters. */
export const PRE_HASHED = /^[0-9a-f]{64}$/;
