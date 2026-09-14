import { describe, expect, test } from "bun:test";
import { classifyReferrer, parseUtm, hostOf, aiSourceOf } from "../src/referrers.ts";

describe("parseUtm", () => {
  test("lower-cases the utm fields", () => {
    const utm = parseUtm("?utm_source=ChatGPT.com&utm_medium=Referral&utm_campaign=Launch");
    expect(utm.source).toBe("chatgpt.com");
    expect(utm.medium).toBe("referral");
    expect(utm.campaign).toBe("launch");
  });

  test("gclid/fbclid count as paid when utm_medium is absent", () => {
    expect(parseUtm("?gclid=abc").medium).toBe("cpc");
    expect(parseUtm("?fbclid=xyz").medium).toBe("cpc");
  });

  test("the ref= shorthand stands in for utm_source", () => {
    expect(parseUtm("?ref=producthunt").source).toBe("producthunt");
  });
});

describe("hostOf", () => {
  test("strips www and accepts input without a scheme", () => {
    expect(hostOf("https://www.Google.com/search?q=1")).toBe("google.com");
    expect(hostOf("chatgpt.com")).toBe("chatgpt.com");
    expect(hostOf("")).toBe("");
    expect(hostOf("::::")).toBe("");
  });
});

describe("classifyReferrer", () => {
  const cases: {
    name: string;
    referrer: string;
    query: string;
    expect: { channel: string; source: string; signal: string };
  }[] = [
    {
      name: "ChatGPT referrer → ai",
      referrer: "https://chatgpt.com/",
      query: "",
      expect: { channel: "ai", source: "chatgpt", signal: "referrer" },
    },
    {
      name: "ChatGPT utm, no referrer → ai (the case GA4 calls direct)",
      referrer: "",
      query: "?utm_source=chatgpt.com",
      expect: { channel: "ai", source: "chatgpt", signal: "utm_source" },
    },
    {
      name: "Perplexity subdomain → ai",
      referrer: "https://www.perplexity.ai/search/abc",
      query: "",
      expect: { channel: "ai", source: "perplexity", signal: "referrer" },
    },
    {
      name: "Gemini → ai",
      referrer: "https://gemini.google.com/app",
      query: "",
      expect: { channel: "ai", source: "gemini", signal: "referrer" },
    },
    {
      name: "Google organik → search",
      referrer: "https://www.google.com/",
      query: "",
      expect: { channel: "search", source: "google", signal: "referrer" },
    },
    {
      name: "Google + gclid → paid",
      referrer: "https://www.google.com/",
      query: "?gclid=123",
      expect: { channel: "paid", source: "google", signal: "utm_medium" },
    },
    {
      name: "Hacker News → social",
      referrer: "https://news.ycombinator.com/item?id=1",
      query: "",
      expect: { channel: "social", source: "hackernews", signal: "referrer" },
    },
    {
      name: "Gmail → email",
      referrer: "https://mail.google.com/mail/u/0",
      query: "",
      expect: { channel: "email", source: "gmail", signal: "referrer" },
    },
    {
      name: "Unrecognised site → referral",
      referrer: "https://blog.acme.dev/yazi",
      query: "",
      expect: { channel: "referral", source: "blog.acme.dev", signal: "referrer" },
    },
    {
      name: "No signal at all → direct",
      referrer: "",
      query: "",
      expect: { channel: "direct", source: "", signal: "none" },
    },
    {
      name: "utm_medium=email, referrer yok → email",
      referrer: "",
      query: "?utm_source=newsletter&utm_medium=email",
      expect: { channel: "email", source: "newsletter", signal: "utm_medium" },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const v = classifyReferrer({
        referrer: c.referrer,
        utm: parseUtm(c.query),
        selfHost: "example.com",
      });
      expect(v.channel).toBe(c.expect.channel as never);
      expect(v.source).toBe(c.expect.source);
      expect(v.signal).toBe(c.expect.signal as never);
    });
  }

  test("our own host counts as internal (in-session navigation is not a source)", () => {
    const v = classifyReferrer({ referrer: "https://www.example.com/fiyat", utm: {}, selfHost: "example.com" });
    expect(v.channel).toBe("internal");
  });

  test("observation (referrer) beats assertion (utm) — a mislabelled link cannot corrupt the channel", () => {
    const v = classifyReferrer({
      referrer: "https://news.ycombinator.com/",
      utm: parseUtm("?utm_source=newsletter&utm_medium=email"),
      selfHost: "example.com",
    });
    expect(v.channel).toBe("social");
    expect(v.source).toBe("hackernews");
  });

  test("aiSourceOf also recognises bare names", () => {
    expect(aiSourceOf("chatgpt")).toBe("chatgpt");
    expect(aiSourceOf("CLAUDE.AI")).toBe("claude");
    expect(aiSourceOf("acme")).toBeUndefined();
  });
});
