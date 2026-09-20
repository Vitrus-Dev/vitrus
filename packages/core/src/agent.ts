// packages/core/src/agent.ts
// Verified agent identity — Web Bot Auth over RFC 9421 HTTP Message Signatures.
//
// ═══ WHY THIS IS THE POINT OF THE PRODUCT ═══
//
// Every analytics tool in this category identifies a bot by reading its
// user-agent string. A user-agent is a sentence the client wrote about itself.
// When a dashboard says "GPTBot read 4,120 pages" what it actually knows is
// "4,120 requests said they were GPTBot", and nothing in the industry
// distinguishes the two.
//
// This product's whole argument is that a number should arrive with the thing
// that proves it. A cryptographic signature is proof. A user-agent is a claim.
// So we report them as different states and never merge them:
//
//   verified   the request carried a signature we checked against the operator's
//              published key. We can name the signer.
//   claimed    the user-agent matches a known bot, and nothing was signed.
//   human      neither.
//
// `verified` is a floor, never a ceiling: an unsigned request is NOT evidence of
// fakery. Most crawlers do not sign yet. Saying "unsigned means fake" would be
// inventing a second unprovable claim to replace the first one, and the docs
// say this in as many words.
//
// ═══ WHAT IS IMPLEMENTED, AND WHAT IS NOT ═══
//
// Web Bot Auth is an IETF Internet-Draft, not an RFC. RFC 9421 (HTTP Message
// Signatures) underneath it IS a ratified standard. We implement exactly the
// profile Web Bot Auth uses and refuse everything else rather than guessing:
//
//   · algorithm      ed25519 only. Anything else → `unsupported_alg`.
//   · components     "@authority" and "signature-agent" (plus "@method" and
//                    "@path" when present). An unknown component → `unsupported_component`,
//                    because a signature we cannot reconstruct is not one we may call valid.
//   · parameters     created, expires, keyid, alg, nonce, tag.
//   · key discovery  the JWKS at <signature-agent>/.well-known/http-message-signatures-directory.
//   · key id         the RFC 7638 JWK thumbprint, so a directory that rotates keys
//                    cannot be tricked into matching the wrong one.
//
// Notably NOT implemented: multiple signatures per request (we verify the first
// that names our profile), `@signature-params` derived components beyond the
// list above, and RSA/ECDSA. Each of those would be a new branch that no
// current signer exercises, i.e. untested code standing between a request and
// the word "verified".

import type { BotVerdict } from "./bots.ts";

/** How much clock skew to tolerate on `created` / `expires`, in ms. */
export const SKEW_MS = 5 * 60_000;

/** Where an operator publishes its keys, per the Web Bot Auth directory draft. */
export const DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";

export type AgentTrust = "verified" | "claimed" | "human";

/** Why a request was NOT verified. Stored, shown, and never summarised away. */
export type AgentReason =
  | "no_signature"
  | "malformed_signature"
  | "unsupported_alg"
  | "unsupported_component"
  | "unknown_signer"
  | "key_not_cached"
  | "expired"
  | "not_yet_valid"
  | "bad_signature"
  | "verified";

export interface AgentVerdict {
  trust: AgentTrust;
  reason: AgentReason;
  /** The directory that vouches for the key, when there was one. */
  signer: string;
  /** The key that verified it, when one did. */
  keyId: string;
  /** Human-readable, for the evidence panel. */
  detail: string;
}

export interface Jwk {
  kty: string;
  crv?: string;
  x?: string;
  kid?: string;
  alg?: string;
}

// ——————————————————————————————————————————————————————————————
// Structured-field parsing — only the shapes this profile produces.
// ——————————————————————————————————————————————————————————————

export interface SignatureInput {
  label: string;
  components: string[];
  params: Record<string, string | number>;
  /** The literal parameter text, needed byte-for-byte for the signature base. */
  rawParams: string;
}

/**
 * Parse `Signature-Input: sig1=("@authority" "signature-agent");created=...;keyid="..."`.
 *
 * Returns null on anything it does not recognise. A permissive parser here is a
 * way to accept a signature over a base we reconstructed differently from the
 * signer — which would either fail verification (noise) or, worse, succeed over
 * the wrong bytes.
 */
export function parseSignatureInput(header: string | null): SignatureInput | null {
  if (!header) return null;
  const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*\(([^)]*)\)\s*(;.*)?$/.exec(header.trim());
  if (!m) return null;
  const label = m[1] as string;
  const inner = (m[2] ?? "").trim();
  const rawParams = (m[3] ?? "").trim();

  const components: string[] = [];
  for (const tok of inner.split(/\s+/)) {
    if (!tok) continue;
    const c = /^"([^"]+)"$/.exec(tok);
    if (!c) return null; // an unquoted component is not this profile
    components.push(c[1] as string);
  }

  const params: Record<string, string | number> = {};
  for (const part of rawParams.split(";")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq < 1) return null;
    const key = p.slice(0, eq).trim();
    const val = p.slice(eq + 1).trim();
    if (/^"(.*)"$/.test(val)) params[key] = val.slice(1, -1);
    else if (/^-?\d+$/.test(val)) params[key] = Number(val);
    else params[key] = val;
  }
  return { label, components, params, rawParams };
}

/** Parse `Signature: sig1=:base64:` for the given label. */
export function parseSignature(header: string | null, label: string): Uint8Array | null {
  if (!header) return null;
  const re = new RegExp(`(?:^|,)\\s*${label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*=\\s*:([A-Za-z0-9+/=]+):`);
  const m = re.exec(header);
  if (!m) return null;
  try {
    const bin = atob(m[1] as string);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** `Signature-Agent: "https://signer.example"` — a structured String. */
export function parseSignatureAgent(header: string | null): string {
  if (!header) return "";
  const raw = header.trim();
  const m = /^"(.*)"$/.exec(raw);
  return (m ? (m[1] as string) : raw).trim();
}

/** Components we know how to reconstruct. Anything else is refused, not guessed. */
const SUPPORTED_COMPONENTS = new Set(["@authority", "@method", "@path", "signature-agent"]);

export interface BaseInput {
  components: string[];
  rawParams: string;
  authority: string;
  method?: string;
  path?: string;
  signatureAgentHeader?: string;
}

/**
 * Build the RFC 9421 signature base.
 *
 * Every line is `"name": value\n`; the last line is `"@signature-params": …`
 * with NO trailing newline. That detail is the whole ballgame — one extra
 * newline and every signature in the world fails against us, silently, and we
 * would conclude that nobody signs.
 */
export function signatureBase(input: BaseInput): string | null {
  const lines: string[] = [];
  for (const c of input.components) {
    if (!SUPPORTED_COMPONENTS.has(c)) return null;
    let value: string | undefined;
    if (c === "@authority") value = input.authority;
    else if (c === "@method") value = input.method;
    else if (c === "@path") value = input.path;
    else if (c === "signature-agent") value = input.signatureAgentHeader;
    if (value === undefined) return null;
    lines.push(`"${c}": ${value}`);
  }
  lines.push(`"@signature-params": (${input.components.map((c) => `"${c}"`).join(" ")})${input.rawParams}`);
  return lines.join("\n");
}

// ——————————————————————————————————————————————————————————————
// Keys
// ——————————————————————————————————————————————————————————————

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * RFC 7638 JWK thumbprint — the key id Web Bot Auth uses.
 *
 * Derived from the key itself rather than taken from the directory's `kid`
 * field, so a directory cannot label one key with another's id and have us
 * accept a signature under the wrong name.
 */
export async function jwkThumbprint(jwk: Jwk): Promise<string> {
  // The canonical form for OKP: the required members, lexicographic, no spaces.
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return bytesToB64url(new Uint8Array(digest));
}

/** An Ed25519 public key, ready to verify with. */
export async function importEd25519(jwk: Jwk): Promise<CryptoKey | null> {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) return null;
  try {
    return await crypto.subtle.importKey(
      "raw",
      b64urlToBytes(jwk.x).slice().buffer as ArrayBuffer,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
  } catch {
    return null;
  }
}

/**
 * The keys an operator publishes, cached.
 *
 * Fetching a directory on the ingest path is out of the question — it is the
 * hottest code in the product and a slow signer would become our latency. So a
 * cache miss does NOT block: the request is reported as `key_not_cached` with
 * that exact reason, a refresh is kicked off, and the next request from the
 * same operator verifies. Reporting "unverified" when the truthful answer is
 * "we have not fetched the key yet" is why the reason is a separate field from
 * the verdict.
 */
export class AgentKeys {
  private byThumbprint = new Map<string, CryptoKey>();
  private signers = new Map<string, number>();
  private inFlight = new Set<string>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    /** How long a directory is trusted before it is fetched again. */
    private readonly ttlMs = 6 * 3_600_000
  ) {}

  get size(): number {
    return this.byThumbprint.size;
  }

  find(keyId: string): CryptoKey | undefined {
    return this.byThumbprint.get(keyId);
  }

  knows(signer: string, now: number): boolean {
    const at = this.signers.get(signer);
    return at !== undefined && now - at < this.ttlMs;
  }

  /** Load a directory's keys. Returns how many were usable. */
  async load(signer: string, now: number): Promise<number> {
    let origin: string;
    try {
      const u = new URL(signer);
      // HTTPS only: a key fetched over plaintext can be replaced in transit,
      // and a key you cannot trust cannot make anything "verified".
      if (u.protocol !== "https:") return 0;
      origin = u.origin;
    } catch {
      return 0;
    }

    const res = await this.fetchImpl(`${origin}${DIRECTORY_PATH}`, {
      headers: { accept: "application/http-message-signatures-directory+json, application/json" },
    });
    if (!res.ok) return 0;
    const body = (await res.json()) as { keys?: Jwk[] };
    let n = 0;
    for (const jwk of body.keys ?? []) {
      const key = await importEd25519(jwk);
      if (!key) continue;
      this.byThumbprint.set(await jwkThumbprint(jwk), key);
      n++;
    }
    this.signers.set(signer, now);
    return n;
  }

  /** Refresh in the background; never awaited by the ingest path. */
  refresh(signer: string, now: number): void {
    if (this.inFlight.has(signer)) return;
    this.inFlight.add(signer);
    void this.load(signer, now)
      .catch(() => {
        /* a signer that cannot be reached stays unverified; that is the honest state */
      })
      .finally(() => this.inFlight.delete(signer));
  }
}

// ——————————————————————————————————————————————————————————————
// The verdict
// ——————————————————————————————————————————————————————————————

export interface VerifyInput {
  /** The request's headers, as the origin server saw them. */
  headers: Record<string, string | undefined>;
  /** The host the request was addressed to — what "@authority" must equal. */
  authority: string;
  method?: string;
  path?: string;
  now: number;
  keys: AgentKeys;
}

const DETAIL: Record<AgentReason, string> = {
  no_signature: "The request carried no Web Bot Auth signature.",
  malformed_signature: "The signature headers could not be parsed as RFC 9421 structured fields.",
  unsupported_alg: "Signed with an algorithm this build does not verify (only ed25519 is accepted).",
  unsupported_component: "Signed over a component we cannot reconstruct, so the base could not be rebuilt.",
  unknown_signer: "The Signature-Agent directory published no usable Ed25519 key for this key id.",
  key_not_cached: "The signer's key directory has not been fetched yet; the next request will verify.",
  expired: "The signature's expiry has passed.",
  not_yet_valid: "The signature is dated in the future beyond the accepted clock skew.",
  bad_signature: "The signature did not verify against the signer's published key.",
  verified: "Signature verified against the operator's published Ed25519 key.",
};

function verdict(trust: AgentTrust, reason: AgentReason, signer = "", keyId = ""): AgentVerdict {
  return { trust, reason, signer, keyId, detail: DETAIL[reason] };
}

/**
 * Verify a request's Web Bot Auth signature.
 *
 * Never throws: an unverifiable request is a normal outcome, not an error, and
 * an exception on the ingest path would turn a malformed header into data loss.
 */
export async function verifyAgent(input: VerifyInput): Promise<AgentVerdict> {
  const h = input.headers;
  const agentHeader = h["signature-agent"];
  const signer = parseSignatureAgent(agentHeader ?? null);
  const inputHeader = h["signature-input"];
  const sigHeader = h["signature"];

  if (!inputHeader || !sigHeader) return verdict("claimed", "no_signature");

  const si = parseSignatureInput(inputHeader);
  if (!si) return verdict("claimed", "malformed_signature", signer);

  const alg = String(si.params.alg ?? "").toLowerCase();
  if (alg && alg !== "ed25519") return verdict("claimed", "unsupported_alg", signer);

  const created = typeof si.params.created === "number" ? si.params.created * 1000 : null;
  const expires = typeof si.params.expires === "number" ? si.params.expires * 1000 : null;
  if (expires !== null && input.now > expires + SKEW_MS) return verdict("claimed", "expired", signer);
  if (created !== null && created - SKEW_MS > input.now) return verdict("claimed", "not_yet_valid", signer);

  const keyId = String(si.params.keyid ?? "");
  if (!keyId) return verdict("claimed", "malformed_signature", signer);

  const base = signatureBase({
    components: si.components,
    rawParams: si.rawParams,
    authority: input.authority,
    method: input.method,
    path: input.path,
    signatureAgentHeader: agentHeader,
  });
  if (base === null) return verdict("claimed", "unsupported_component", signer);

  const sig = parseSignature(sigHeader, si.label);
  if (!sig) return verdict("claimed", "malformed_signature", signer);

  let key = input.keys.find(keyId);
  if (!key) {
    // Not cached. Say exactly that rather than implying the signature is bad,
    // and fetch in the background so the next one from this operator verifies.
    if (signer) input.keys.refresh(signer, input.now);
    return verdict("claimed", "key_not_cached", signer, keyId);
  }

  let ok = false;
  try {
    // `.slice()` hands WebCrypto an ArrayBuffer rather than a possibly-shared
    // view, which the DOM typings refuse.
    ok = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      sig.slice().buffer as ArrayBuffer,
      new TextEncoder().encode(base).slice().buffer as ArrayBuffer
    );
  } catch {
    ok = false;
  }
  if (!ok) return verdict("claimed", "bad_signature", signer, keyId);
  return verdict("verified", "verified", signer, keyId);
}

/**
 * Combine the signature verdict with the user-agent table.
 *
 * The rule: a signature can PROMOTE a request to `verified`, and nothing can
 * demote a human to a bot on the strength of a missing signature. Almost no
 * crawler signs yet, so treating "unsigned" as suspicious would mislabel the
 * whole internet — and replace an unprovable claim with a different one.
 */
export function agentTrust(bot: BotVerdict, sig: AgentVerdict): AgentTrust {
  if (sig.trust === "verified") return "verified";
  // A signature was ATTEMPTED. A person's browser does not send Signature-Input,
  // so whatever this is, it is not a visitor — even though we could not verify
  // it (most often because the operator's key directory has not been fetched
  // yet). Without this line the first request from every signing agent, once
  // per cache lifetime, would be counted as a human.
  if (sig.reason !== "no_signature") return "claimed";
  return bot.isBot ? "claimed" : "human";
}
