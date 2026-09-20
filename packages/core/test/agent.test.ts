// packages/core/test/agent.test.ts
//
// These tests SIGN with a real Ed25519 key and then verify, rather than
// asserting against a fixed string. A hand-written expected-base would drift
// from the code that produces it and both would be wrong together; a round trip
// through actual crypto cannot pass unless the base we build is the base a
// signer would have signed.
//
// The negative cases matter more than the positive one. The word "verified" is
// the strongest thing this product says about anything, so everything that
// could produce it wrongly has a test.

import { describe, expect, test } from "bun:test";
import {
  AgentKeys,
  agentTrust,
  DIRECTORY_PATH,
  jwkThumbprint,
  parseSignature,
  parseSignatureAgent,
  parseSignatureInput,
  signatureBase,
  SKEW_MS,
  verifyAgent,
  type Jwk,
} from "../src/agent.ts";
import { detectBot } from "../src/bots.ts";

const NOW = Date.UTC(2026, 8, 19, 12, 0, 0);
const AUTHORITY = "example.com";
const SIGNER = "https://signer.example";

async function makeSigner() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as unknown as Jwk;
  const keyId = await jwkThumbprint({ kty: jwk.kty, crv: jwk.crv, x: jwk.x });
  return { kp, jwk, keyId };
}

/** Produce the three headers a signing agent would send. */
async function sign(opts: {
  kp: CryptoKeyPair;
  keyId: string;
  authority?: string;
  created?: number;
  expires?: number;
  components?: string[];
  alg?: string;
  signer?: string;
}) {
  const components = opts.components ?? ["@authority", "signature-agent"];
  const created = opts.created ?? Math.floor(NOW / 1000);
  const expires = opts.expires ?? Math.floor(NOW / 1000) + 300;
  const signerHeader = `"${opts.signer ?? SIGNER}"`;
  const rawParams =
    `;created=${created};expires=${expires};keyid="${opts.keyId}";alg="${opts.alg ?? "ed25519"}";tag="web-bot-auth"`;

  const base = signatureBase({
    components,
    rawParams,
    authority: opts.authority ?? AUTHORITY,
    method: "GET",
    path: "/pricing",
    signatureAgentHeader: signerHeader,
  })!;
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, opts.kp.privateKey, new TextEncoder().encode(base));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));

  return {
    base,
    headers: {
      "signature-agent": signerHeader,
      "signature-input": `sig1=(${components.map((c) => `"${c}"`).join(" ")})${rawParams}`,
      signature: `sig1=:${b64}:`,
    } as Record<string, string>,
  };
}

/** A key directory that serves one JWKS, with no network. */
function directory(jwk: Jwk, opts: { status?: number } = {}) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    if (opts.status && opts.status !== 200) return new Response("no", { status: opts.status });
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("structured field parsing", () => {
  test("a signature-input is parsed into components and parameters", () => {
    const si = parseSignatureInput(
      'sig1=("@authority" "signature-agent");created=1700000000;keyid="abc";alg="ed25519";tag="web-bot-auth"'
    )!;
    expect(si.label).toBe("sig1");
    expect(si.components).toEqual(["@authority", "signature-agent"]);
    expect(si.params.keyid).toBe("abc");
    expect(si.params.created).toBe(1700000000);
    // The raw text is kept because the base must be rebuilt byte for byte.
    expect(si.rawParams).toStartWith(";created=");
  });

  test("garbage is refused rather than guessed at", () => {
    // A permissive parser would rebuild a base different from the signer's and
    // then either fail (noise) or — much worse — succeed over the wrong bytes.
    for (const bad of ["", "sig1", "sig1=@authority", 'sig1=("@authority"', 'sig1=(@authority)']) {
      expect(parseSignatureInput(bad), bad).toBeNull();
    }
    expect(parseSignatureInput(null)).toBeNull();
  });

  test("the signature blob is decoded for its own label only", () => {
    expect(parseSignature("sig1=:AAEC:", "sig1")).toEqual(new Uint8Array([0, 1, 2]));
    expect(parseSignature("sig1=:AAEC:", "sig2")).toBeNull();
    expect(parseSignature("sig1=:not base64!:", "sig1")).toBeNull();
  });

  test("signature-agent is unquoted", () => {
    expect(parseSignatureAgent('"https://a.example"')).toBe("https://a.example");
    expect(parseSignatureAgent("https://a.example")).toBe("https://a.example");
    expect(parseSignatureAgent(null)).toBe("");
  });
});

describe("the signature base", () => {
  test("the last line has no trailing newline", () => {
    // One extra newline and every signature on the internet fails against us,
    // silently, and we would conclude that nobody signs.
    const base = signatureBase({
      components: ["@authority"],
      rawParams: ";created=1",
      authority: "example.com",
    })!;
    expect(base).toBe('"@authority": example.com\n"@signature-params": ("@authority");created=1');
    expect(base.endsWith("\n")).toBe(false);
  });

  test("components appear in the order they were signed", () => {
    const base = signatureBase({
      components: ["@method", "@path", "@authority"],
      rawParams: "",
      authority: "example.com",
      method: "GET",
      path: "/x",
    })!;
    expect(base.split("\n").slice(0, 3)).toEqual(['"@method": GET', '"@path": /x', '"@authority": example.com']);
  });

  test("a component we cannot reconstruct refuses the whole base", () => {
    // Returning a partial base would be verifying a signature over bytes the
    // signer never saw.
    expect(signatureBase({ components: ["@query-param"], rawParams: "", authority: "a" })).toBeNull();
    expect(signatureBase({ components: ["@path"], rawParams: "", authority: "a" })).toBeNull();
  });
});

describe("key identity", () => {
  test("the key id is the RFC 7638 thumbprint of the key itself", async () => {
    const { jwk, keyId } = await makeSigner();
    expect(keyId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Derived from the key, not read from the directory's `kid` field, so a
    // directory cannot label one key with another's id.
    const lying: Jwk = { ...jwk, kid: "something-else" };
    expect(await jwkThumbprint({ kty: lying.kty, crv: lying.crv, x: lying.x })).toBe(keyId);
  });

  test("two different keys never share a thumbprint", async () => {
    const a = await makeSigner();
    const b = await makeSigner();
    expect(a.keyId).not.toBe(b.keyId);
  });
});

describe("verifying a real signature", () => {
  test("a correctly signed request is verified, and we can name the signer", async () => {
    const s = await makeSigner();
    const dir = directory(s.jwk);
    const keys = new AgentKeys(dir.impl);
    await keys.load(SIGNER, NOW);

    const req = await sign({ kp: s.kp, keyId: s.keyId });
    const v = await verifyAgent({ headers: req.headers, authority: AUTHORITY, now: NOW, keys });

    expect(v.trust).toBe("verified");
    expect(v.reason).toBe("verified");
    expect(v.signer).toBe(SIGNER);
    expect(v.keyId).toBe(s.keyId);
    expect(dir.calls[0]).toBe(`${SIGNER}${DIRECTORY_PATH}`);
  });

  test("a signature for ANOTHER host does not verify against ours", async () => {
    // Otherwise a signed request captured from one site could be replayed at
    // another and arrive labelled "verified".
    const s = await makeSigner();
    const keys = new AgentKeys(directory(s.jwk).impl);
    await keys.load(SIGNER, NOW);

    const req = await sign({ kp: s.kp, keyId: s.keyId, authority: "someone-else.example" });
    const v = await verifyAgent({ headers: req.headers, authority: AUTHORITY, now: NOW, keys });
    expect(v.trust).toBe("claimed");
    expect(v.reason).toBe("bad_signature");
  });

  test("a tampered signature does not verify", async () => {
    const s = await makeSigner();
    const keys = new AgentKeys(directory(s.jwk).impl);
    await keys.load(SIGNER, NOW);

    const req = await sign({ kp: s.kp, keyId: s.keyId });
    const broken = { ...req.headers, signature: req.headers.signature!.replace(/.(:)$/, "A$1") };
    const v = await verifyAgent({ headers: broken, authority: AUTHORITY, now: NOW, keys });
    expect(v.trust).toBe("claimed");
    expect(["bad_signature", "malformed_signature"]).toContain(v.reason);
  });

  test("another operator's key does not verify this signature", async () => {
    const mine = await makeSigner();
    const theirs = await makeSigner();
    const keys = new AgentKeys(directory(theirs.jwk).impl);
    await keys.load(SIGNER, NOW);

    // Signed by `mine`, but claims `theirs`' key id — which IS in the cache.
    const req = await sign({ kp: mine.kp, keyId: theirs.keyId });
    const v = await verifyAgent({ headers: req.headers, authority: AUTHORITY, now: NOW, keys });
    expect(v.trust).toBe("claimed");
    expect(v.reason).toBe("bad_signature");
  });
});

describe("what must never be called verified", () => {
  const base = async () => {
    const s = await makeSigner();
    const keys = new AgentKeys(directory(s.jwk).impl);
    await keys.load(SIGNER, NOW);
    return { s, keys };
  };

  test("no signature at all", async () => {
    const { keys } = await base();
    const v = await verifyAgent({ headers: { "user-agent": "GPTBot" }, authority: AUTHORITY, now: NOW, keys });
    expect(v.trust).toBe("claimed");
    expect(v.reason).toBe("no_signature");
  });

  test("an expired signature", async () => {
    const { s, keys } = await base();
    const old = Math.floor((NOW - 86_400_000) / 1000);
    const req = await sign({ kp: s.kp, keyId: s.keyId, created: old, expires: old + 300 });
    const v = await verifyAgent({ headers: req.headers, authority: AUTHORITY, now: NOW, keys });
    expect(v.reason).toBe("expired");
  });

  test("a signature dated in the future", async () => {
    const { s, keys } = await base();
    const soon = Math.floor((NOW + 86_400_000) / 1000);
    const req = await sign({ kp: s.kp, keyId: s.keyId, created: soon, expires: soon + 300 });
    const v = await verifyAgent({ headers: req.headers, authority: AUTHORITY, now: NOW, keys });
    expect(v.reason).toBe("not_yet_valid");
  });

  test("small clock skew is tolerated in both directions", async () => {
    const { s, keys } = await base();
    const justExpired = Math.floor((NOW - SKEW_MS / 2) / 1000);
    const req = await sign({ kp: s.kp, keyId: s.keyId, created: justExpired - 300, expires: justExpired });
    const v = await verifyAgent({ headers: req.headers, authority: AUTHORITY, now: NOW, keys });
    // Refusing a signature because two clocks disagree by a minute would make
    // the feature useless in the real world.
    expect(v.trust).toBe("verified");
  });

  test("an algorithm we do not implement", async () => {
    const { s, keys } = await base();
    const req = await sign({ kp: s.kp, keyId: s.keyId, alg: "rsa-pss-sha512" });
    const v = await verifyAgent({ headers: req.headers, authority: AUTHORITY, now: NOW, keys });
    expect(v.reason).toBe("unsupported_alg");
  });

  test("a component we cannot rebuild", async () => {
    const { s, keys } = await base();
    const req = await sign({ kp: s.kp, keyId: s.keyId, components: ["@authority", "@query"] });
    const v = await verifyAgent({ headers: req.headers, authority: AUTHORITY, now: NOW, keys });
    expect(v.reason).toBe("unsupported_component");
  });

  test("a key we have never fetched says SO, rather than implying the signature is bad", async () => {
    const s = await makeSigner();
    const keys = new AgentKeys(directory(s.jwk).impl); // nothing loaded
    const req = await sign({ kp: s.kp, keyId: s.keyId });
    const v = await verifyAgent({ headers: req.headers, authority: AUTHORITY, now: NOW, keys });
    expect(v.reason).toBe("key_not_cached");
    expect(v.detail).toContain("has not been fetched yet");
  });

  test("malformed headers never throw — a bad header must not cost us the event", async () => {
    const { keys } = await base();
    const nasty: Record<string, string>[] = [
      { "signature-input": "((((", signature: "sig1=::" },
      { "signature-input": 'sig1=("@authority")', signature: "nonsense" },
      { "signature-input": 'sig1=("@authority");keyid=""', signature: "sig1=:AAA:" },
    ];
    for (const headers of nasty) {
      const v = await verifyAgent({ headers, authority: AUTHORITY, now: NOW, keys });
      expect(v.trust).toBe("claimed");
    }
  });
});

describe("the key directory", () => {
  test("a plaintext directory is refused — a key you cannot trust proves nothing", async () => {
    const s = await makeSigner();
    const dir = directory(s.jwk);
    const keys = new AgentKeys(dir.impl);
    expect(await keys.load("http://signer.example", NOW)).toBe(0);
    expect(dir.calls).toHaveLength(0);
  });

  test("a directory that errors leaves us with no keys, not with bad ones", async () => {
    const s = await makeSigner();
    const keys = new AgentKeys(directory(s.jwk, { status: 500 }).impl);
    expect(await keys.load(SIGNER, NOW)).toBe(0);
    expect(keys.size).toBe(0);
  });

  test("non-Ed25519 keys in a directory are skipped, not imported", async () => {
    const rsa: Jwk = { kty: "RSA", x: "nope" };
    const impl = (async () => new Response(JSON.stringify({ keys: [rsa] }))) as unknown as typeof fetch;
    const keys = new AgentKeys(impl);
    expect(await keys.load(SIGNER, NOW)).toBe(0);
  });

  test("a refresh is not awaited and is not stampeded", async () => {
    const s = await makeSigner();
    const dir = directory(s.jwk);
    const keys = new AgentKeys(dir.impl);
    keys.refresh(SIGNER, NOW);
    keys.refresh(SIGNER, NOW);
    keys.refresh(SIGNER, NOW);
    await new Promise((r) => setTimeout(r, 30));
    // Three requests from the same operator in the same instant must not become
    // three fetches of the same directory.
    expect(dir.calls).toHaveLength(1);
    expect(keys.find(s.keyId)).toBeDefined();
  });
});

describe("how a signature changes the label", () => {
  test("a verified signature outranks the user-agent table", () => {
    const bot = detectBot("Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)");
    expect(agentTrust(bot, { trust: "verified", reason: "verified", signer: "", keyId: "", detail: "" })).toBe(
      "verified"
    );
  });

  test("an unsigned known bot is CLAIMED — which is all a user-agent can ever be", () => {
    const bot = detectBot("Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)");
    expect(agentTrust(bot, { trust: "claimed", reason: "no_signature", signer: "", keyId: "", detail: "" })).toBe(
      "claimed"
    );
  });

  test("an unsigned browser stays human — absence of a signature is not evidence", () => {
    // Almost no crawler signs yet. Treating unsigned as suspicious would
    // mislabel the whole internet and replace one unprovable claim with another.
    const bot = detectBot(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
    );
    expect(agentTrust(bot, { trust: "claimed", reason: "no_signature", signer: "", keyId: "", detail: "" })).toBe(
      "human"
    );
  });
});
