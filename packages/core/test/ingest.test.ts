import { describe, expect, test } from "bun:test";
import { splitUrl } from "../src/ingest.ts";
import { visitorId } from "../src/visitor.ts";
import { CHROME, DAY, MIN, SITE, freshStore, ingestorFor, send } from "./helpers.ts";

describe("splitUrl", () => {
  test("a hash-router route is kept, an in-page anchor is not", () => {
    expect(splitUrl("/#/settings").path).toBe("/#/settings");
    expect(splitUrl("/docs#install").path).toBe("/docs");
  });

  test("splits path/query, drops the fragment, normalises the trailing slash", () => {
    expect(splitUrl("https://example.com/fiyat/?a=1#x")).toEqual({ path: "/fiyat", query: "?a=1", host: "example.com" });
    expect(splitUrl("/")).toMatchObject({ path: "/" });
    expect(splitUrl("/blog/yazi")).toMatchObject({ path: "/blog/yazi", query: "" });
  });

  test("malformed input does not crash; the result is always a path starting with '/'", () => {
    for (const bad of ["::::", "http://", "", "javascript:alert(1)", "%%%"]) {
      expect(splitUrl(bad).path.startsWith("/")).toBe(true);
    }
  });
});

describe("visitorId", () => {
  test("the identity changes when the day changes (no persistent identifier)", () => {
    const base = { secret: "s", siteId: "demo", ip: "1.2.3.4", userAgent: CHROME };
    const day1 = visitorId({ ...base, now: Date.UTC(2026, 8, 12, 10) });
    const day1b = visitorId({ ...base, now: Date.UTC(2026, 8, 12, 23) });
    const day2 = visitorId({ ...base, now: Date.UTC(2026, 8, 13, 1) });
    expect(day1).toBe(day1b);
    expect(day1).not.toBe(day2);
  });

  test("a different IP produces a different identity", () => {
    const now = Date.UTC(2026, 8, 12, 10);
    const a = visitorId({ secret: "s", siteId: "demo", ip: "1.1.1.1", userAgent: CHROME, now });
    const b = visitorId({ secret: "s", siteId: "demo", ip: "2.2.2.2", userAgent: CHROME, now });
    expect(a).not.toBe(b);
  });
});

describe("Ingestor", () => {
  const T0 = Date.UTC(2026, 8, 12, 10, 0, 0);

  test("bilinmeyen site 404 ile reddedilir", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    const res = await ing.ingest({ site: "yok", type: "pageview", url: "/" }, { ip: "1.1.1.1", userAgent: CHROME, now: T0 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });

  test("an invalid body is rejected with a reason", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    const bad = await ing.ingest({ site: SITE.id, type: "event", url: "/" }, { ip: "1.1.1.1", userAgent: CHROME, now: T0 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("name_missing");
  });

  test("a second event within 30 min is the SAME session; later is a new one", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    const a = await send(ing, { now: T0, url: "/" });
    const b = await send(ing, { now: T0 + 10 * MIN, url: "/fiyat" });
    const c = await send(ing, { now: T0 + 45 * MIN, url: "/fiyat" });
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (a.ok && b.ok && c.ok) {
      expect(b.event.sessionId).toBe(a.event.sessionId);
      expect(c.event.sessionId).not.toBe(a.event.sessionId);
    }
  });

  test("a visit arriving from ChatGPT is written to the ai channel", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    const r = await send(ing, { now: T0, referrer: "https://chatgpt.com/" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.event.channel).toBe("ai");
      expect(r.event.source).toBe("chatgpt");
      expect(r.event.botKind).toBe("");
    }
  });

  test("GPTBot is labelled as a bot but NOT DISCARDED (for the GEO panel)", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    const r = await send(ing, { now: T0, ua: "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.event.botKind).toBe("ai-crawler");
      expect(r.event.botName).toBe("GPTBot");
      expect(r.event.device).toBe("bot");
      expect(r.event.channel).not.toBe("ai"); // a crawler is NOT an AI REFERRAL
    }
    const rows = await store.select<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE bot_kind = 'ai-crawler'`);
    expect(rows[0]?.n).toBe(1);
  });

  test("client time is ignored — the server clock is what is written", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    const r = await ing.ingest(
      { site: SITE.id, type: "pageview", url: "/", ts: 0 } as unknown,
      { ip: "9.9.9.9", userAgent: CHROME, now: T0 }
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event.ts).toBe(T0);
  });

  test("the signal behind the channel verdict is stored as evidence", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    const r = await send(ing, { now: T0, url: "/?utm_source=chatgpt.com" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event.props._signal).toBe("utm_source");
  });

  test("the same visitor counts as new the next day (the daily salt)", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    const a = await send(ing, { now: T0 });
    const b = await send(ing, { now: T0 + DAY });
    if (a.ok && b.ok) expect(a.event.visitorId).not.toBe(b.event.visitorId);
  });
});

describe("splitUrl and protocol-relative references", () => {
  test("a protocol-relative url is a URL, not a path", () => {
    // Stored raw it became the literal path "//host/page", which then showed up
    // in the top-pages table as a page that does not exist. Production had one.
    expect(splitUrl("//example.com/pricing", "example.com")).toEqual({
      path: "/pricing",
      query: "",
      host: "example.com",
    });
  });

  test("the host in a protocol-relative url is honoured, not the fallback", () => {
    expect(splitUrl("//other.example/p", "example.com").host).toBe("other.example");
  });

  test("ordinary forms are unchanged", () => {
    expect(splitUrl("https://example.com/a", "example.com").path).toBe("/a");
    expect(splitUrl("/a", "example.com").path).toBe("/a");
    expect(splitUrl("a", "example.com").path).toBe("/a");
    expect(splitUrl("https://example.com/a/", "example.com").path).toBe("/a");
    expect(splitUrl("https://example.com/", "example.com").path).toBe("/");
  });

  test("nonsense still degrades to the root rather than throwing", () => {
    expect(splitUrl("://///", "example.com").path).toBe("/");
  });
});
