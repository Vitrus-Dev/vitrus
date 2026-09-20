// packages/core/test/signals.test.ts
//
// The test that matters most here is the one that says a real browser scores
// ZERO. Calling a visitor a robot is worse than missing a robot: the visitor
// disappears from the customer's numbers and nobody ever finds out. So the
// false-positive cases below are the point, and the true positives come second.

import { describe, expect, test } from "bun:test";
import {
  describeSignals,
  headerSignals,
  parseSignals,
  score,
  serializeSignals,
  SUSPECT_AT,
  suspected,
} from "../src/signals.ts";

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";
const SAFARI_OLD =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Safari/605.1.15";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/** What a current Chromium actually sends on a fetch to our endpoint. */
const chromiumHeaders = (over: Record<string, string | undefined> = {}) => ({
  accept: "*/*",
  "accept-language": "en-GB,en;q=0.9",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "cross-site",
  "sec-fetch-dest": "empty",
  "sec-ch-ua": '"Chromium";v="140", "Not=A?Brand";v="24"',
  "sec-ch-ua-platform": '"macOS"',
  ...over,
});

describe("a real browser must score zero", () => {
  test("current Chromium on macOS", () => {
    expect(headerSignals({ headers: chromiumHeaders(), userAgent: CHROME })).toEqual([]);
  });

  test("current Chromium on Windows", () => {
    const h = chromiumHeaders({ "sec-ch-ua-platform": '"Windows"' });
    expect(headerSignals({ headers: h, userAgent: CHROME_WIN })).toEqual([]);
  });

  test("Firefox, which sends no client hints at all", () => {
    // Client hints are Chromium-only. Asking Firefox for them and scoring it
    // when it declines would flag every Firefox user on the internet.
    const h = {
      accept: "*/*",
      "accept-language": "en-US,en;q=0.5",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "cross-site",
      "sec-fetch-dest": "empty",
    };
    expect(headerSignals({ headers: h, userAgent: FIREFOX })).toEqual([]);
  });

  test("an iPhone", () => {
    const h = {
      accept: "*/*",
      "accept-language": "en-GB",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "cross-site",
    };
    expect(headerSignals({ headers: h, userAgent: IPHONE })).toEqual([]);
  });

  test("an older Safari without Sec-Fetch-* is noticed but NOT accused", () => {
    // Safari only added fetch metadata in 16.4. One missing header is normal
    // somewhere on the internet, so it must not reach the bar on its own.
    const s = headerSignals({ headers: { accept: "*/*", "accept-language": "en" }, userAgent: SAFARI_OLD });
    expect(s.map((x) => x.rule)).toEqual(["no-fetch-metadata"]);
    expect(suspected(s)).toBe(false);
  });

  test("a privacy extension stripping ONE header does not reach the bar", () => {
    for (const drop of ["accept-language", "accept", "sec-ch-ua"]) {
      const h = chromiumHeaders({ [drop]: undefined });
      const s = headerSignals({ headers: h, userAgent: CHROME });
      expect(suspected(s), `dropping ${drop} alone must not accuse anyone`).toBe(false);
    }
  });
});

describe("a client that is not claiming to be a browser is left alone", () => {
  test("curl produces no signals — the user-agent table already has it", () => {
    // Running browser-consistency rules over an honest script produces a pile
    // of signals that tell nobody anything.
    expect(headerSignals({ headers: {}, userAgent: "curl/8.4.0" })).toEqual([]);
    expect(headerSignals({ headers: {}, userAgent: "python-requests/2.32" })).toEqual([]);
    expect(headerSignals({ headers: {}, userAgent: "" })).toEqual([]);
  });

  test("a self-declared crawler is left to the user-agent table too", () => {
    expect(headerSignals({ headers: {}, userAgent: "Mozilla/5.0 (compatible; GPTBot/1.0)" })).toEqual([]);
  });
});

describe("what should be caught", () => {
  test("a script wearing a Chrome user-agent and nothing else", () => {
    // The shape of most of the traffic inflating self-hosted dashboards.
    const s = headerSignals({ headers: {}, userAgent: CHROME });
    expect(suspected(s)).toBe(true);
    expect(s.map((x) => x.rule).sort()).toEqual([
      "chromium-without-client-hints",
      "no-accept",
      "no-accept-language",
      "no-fetch-metadata",
    ]);
  });

  test("a user-agent and a platform hint that disagree", () => {
    // Two different programs. Hard to produce by accident, so it reaches the
    // bar on its own.
    const h = chromiumHeaders({ "sec-ch-ua-platform": '"Linux"' });
    const s = headerSignals({ headers: h, userAgent: CHROME_WIN });
    expect(s.map((x) => x.rule)).toEqual(["platform-mismatch"]);
    expect(score(s)).toBeGreaterThanOrEqual(SUSPECT_AT);
    expect(s[0]?.detail).toContain("windows");
    expect(s[0]?.detail).toContain("linux");
  });

  test("two weak signals together do reach the bar", () => {
    const h = chromiumHeaders({ "accept-language": undefined, "sec-fetch-mode": undefined, "sec-fetch-site": undefined, "sec-fetch-dest": undefined });
    expect(suspected(headerSignals({ headers: h, userAgent: CHROME }))).toBe(true);
  });
});

describe("a score has to be explainable", () => {
  test("every signal carries the rule, the weight and what was observed", () => {
    const s = headerSignals({ headers: {}, userAgent: CHROME });
    for (const sig of s) {
      expect(sig.layer).toBe("headers");
      expect(sig.rule).toMatch(/^[a-z-]+$/);
      expect(sig.weight).toBeGreaterThan(0);
      expect(sig.detail.length).toBeGreaterThan(10);
    }
  });

  test("the stored form round-trips, so a score can be explained later", () => {
    const s = headerSignals({ headers: {}, userAgent: CHROME });
    const raw = serializeSignals(s);
    expect(parseSignals(raw)).toEqual(s.map((x) => x.rule));
    expect(parseSignals("")).toEqual([]);
  });

  test("it describes itself for the evidence panel", () => {
    const text = describeSignals(headerSignals({ headers: {}, userAgent: CHROME }));
    expect(text).toContain("no-accept-language");
    expect(text).toContain("+3");
    expect(describeSignals([])).toBe("No automation signals.");
  });
});

describe("no fingerprinting", () => {
  test("the module reads headers only — nothing about the device", () => {
    // A "client signals" layer usually means canvas, fonts, WebGL and plugin
    // lists. All of those would undercut the privacy claim this product is
    // built on, so none of them are here and the absence is pinned.
    const src = Bun.file(new URL("../src/signals.ts", import.meta.url));
    return src.text().then((raw) => {
      // Comments stripped first: the file EXPLAINS that it avoids canvas and
      // plugin lists, and a whole-file search fails on that explanation. A test
      // that trips over its own subject's prose has bitten this codebase twice.
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const banned of ["canvas", "WebGL", "plugins", "getContext", "fonts", "screen.", "navigator."]) {
        expect(code.includes(banned), `fingerprinting surface appeared: ${banned}`).toBe(false);
      }
    });
  });
});
