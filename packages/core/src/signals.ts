// packages/core/src/signals.ts
// Layer two of bot detection: what the REQUEST looks like, not what it says.
//
// ═══ THE PROBLEM THIS SOLVES ═══
//
// A user-agent table catches clients that admit what they are. It catches
// nothing that lies, and the loudest complaint about self-hosted analytics is
// exactly that: people report 200 real visitors showing up as 5,000. Plausible's
// cloud has user-agent filtering plus ~32,000 datacenter IP ranges plus
// behavioural analysis; its Community Edition has the user-agent filter alone.
// Umami users have measured a third of their recorded visits as fake.
//
// Ours was one layer too. This is the second, and it is in the Apache-2.0 core
// rather than held back for the paid tier — which is the whole argument for
// calling something open core.
//
// ═══ WHAT THIS DELIBERATELY IS NOT ═══
//
// It is NOT a browser fingerprint. No canvas, no font enumeration, no WebGL
// renderer, no plugin list — all of which are what a "client signals" layer
// usually means, and all of which would undercut the privacy claim this product
// is built on. Every signal below is read from headers the client sent anyway.
//
// It also does not SILENTLY remove anything. Signals are recorded and scored,
// the dashboard shows what is suspected and which signal fired, and excluding
// them is a choice the operator makes and can see in the evidence. Filtering
// invisibly is how a tool ends up unable to explain its own numbers — and
// "rather undercount than guess" cuts both ways: we will not guess someone is a
// robot either.

/** One reason to think a request was not made by a browser. */
export interface Signal {
  /** Which layer noticed. */
  layer: "headers";
  /** Stable identifier, so a score can be explained after the fact. */
  rule: string;
  /** Contribution to the score. Higher means harder to produce by accident. */
  weight: number;
  /** What was actually observed. */
  detail: string;
}

/** Bumped whenever a rule is added or reweighted — a score belongs to a version. */
export const SIGNAL_TABLE_VERSION = "2026-09-19";

/**
 * The score at which we are willing to say "this looks automated".
 *
 * Deliberately high. A single missing header is normal somewhere on the
 * internet — old browsers, privacy extensions, corporate proxies that strip
 * things. Two independent strong signals is a different story.
 */
export const SUSPECT_AT = 5;

export interface HeaderInput {
  /** Lower-cased header names to values, as the server received them. */
  headers: Record<string, string | undefined>;
  /** The user-agent, already extracted. */
  userAgent: string;
}

/** Does this user-agent claim to be a mainstream browser? */
function claimsBrowser(ua: string): boolean {
  const u = ua.toLowerCase();
  return u.includes("mozilla/") && (u.includes("chrome/") || u.includes("safari/") || u.includes("firefox/"));
}

function claimsChromium(ua: string): boolean {
  const u = ua.toLowerCase();
  // Edge, Opera and Brave all carry "chrome/" too, which is what we want:
  // anything Chromium-derived should be sending client hints.
  return u.includes("chrome/") && !u.includes("firefox/");
}

/**
 * Score a request against what a browser making this call would look like.
 *
 * Only applied to clients CLAIMING to be a browser. A request that honestly
 * says `curl/8.4` is already handled by the user-agent table, and running these
 * rules over it would produce a pile of signals that tell nobody anything.
 */
export function headerSignals(input: HeaderInput): Signal[] {
  const h = input.headers;
  const ua = input.userAgent ?? "";
  const out: Signal[] = [];

  // Nothing to contradict: the client is not claiming to be a browser at all.
  if (!claimsBrowser(ua)) return out;

  const add = (rule: string, weight: number, detail: string) =>
    out.push({ layer: "headers", rule, weight, detail });

  // Every browser sends Accept-Language on the requests it makes. Scripted
  // clients that copy a user-agent string almost never bother.
  if (!h["accept-language"]) {
    add("no-accept-language", 3, "claims to be a browser but sent no Accept-Language");
  }

  // Fetch metadata. Chromium has sent these since 2020 and Firefox since 90;
  // Safari added them in 16.4. An older Safari or a stripping proxy is the
  // false-positive case, which is why this is worth 3 and not 5 on its own.
  const hasFetchMeta = Boolean(h["sec-fetch-mode"] || h["sec-fetch-site"] || h["sec-fetch-dest"]);
  if (!hasFetchMeta) {
    add("no-fetch-metadata", 3, "no Sec-Fetch-* headers, which every current browser sends");
  }

  // Client hints are Chromium-only, so this is asked only of Chromium claims.
  if (claimsChromium(ua) && !h["sec-ch-ua"]) {
    add("chromium-without-client-hints", 3, "claims Chrome but sent no Sec-CH-UA");
  }

  // A browser that says it is Chrome on Windows and hints Linux is two
  // different programs. This is the signature Simon Willison spotted on
  // ChatGPT's agent, and it is hard to produce by accident.
  const platform = (h["sec-ch-ua-platform"] ?? "").replace(/"/g, "").toLowerCase();
  if (platform) {
    const u = ua.toLowerCase();
    const claimed =
      u.includes("windows") ? "windows"
      : u.includes("mac os x") || u.includes("macintosh") ? "macos"
      : u.includes("android") ? "android"
      : u.includes("linux") ? "linux"
      : u.includes("iphone") || u.includes("ipad") ? "ios"
      : "";
    const hinted =
      platform === "macos" ? "macos"
      : platform === "windows" ? "windows"
      : platform === "android" ? "android"
      : platform === "linux" ? "linux"
      : platform === "ios" ? "ios"
      : "";
    if (claimed && hinted && claimed !== hinted) {
      add("platform-mismatch", 5, `user-agent says ${claimed}, Sec-CH-UA-Platform says ${hinted}`);
    }
  }

  // A browser sends an Accept header on every request it makes. Its absence
  // means something assembled the request by hand.
  if (!h["accept"]) {
    add("no-accept", 2, "claims to be a browser but sent no Accept header");
  }

  return out;
}

/** The sum of the weights. */
export function score(signals: readonly Signal[]): number {
  return signals.reduce((n, s) => n + s.weight, 0);
}

/** Is this past the bar at which we are willing to say anything at all? */
export function suspected(signals: readonly Signal[]): boolean {
  return score(signals) >= SUSPECT_AT;
}

/**
 * The signals, flattened for storage.
 *
 * A comma-separated list of rule names, not JSON: it lives in one column that
 * the dashboard groups by, and a score with no way to see WHICH rules produced
 * it would be exactly the kind of unexplainable number this product exists to
 * avoid.
 */
export function serializeSignals(signals: readonly Signal[]): string {
  return signals.map((s) => s.rule).join(",");
}

export function parseSignals(raw: string): string[] {
  return raw ? raw.split(",").filter(Boolean) : [];
}

/** Human-readable, for the evidence panel. */
export function describeSignals(signals: readonly Signal[]): string {
  if (signals.length === 0) return "No automation signals.";
  return signals.map((s) => `${s.rule} (+${s.weight}): ${s.detail}`).join("\n");
}
