import { describe, expect, test } from "bun:test";
import { buildBundle, evidenceOf, previousWindow, windowOf } from "../src/metrics/bundle.ts";
import { composeDigest, renderText } from "../src/insight/compose.ts";
import { guardProse } from "../src/insight/guard.ts";
import { METRICS } from "../src/metrics/queries.ts";
import { CHROME, DAY, IPHONE, MIN, freshStore, ingestorFor, send } from "./helpers.ts";
import type { SqliteStore } from "../src/store/sqlite.ts";

const NOW = Date.UTC(2026, 8, 12, 12, 0, 0);
const WIN = windowOf(NOW, 7, "last 7 days");

/** A realistic week: several channels, one bot, one funnel. */
async function seed(store: SqliteStore): Promise<void> {
  const ing = ingestorFor(store);
  const t = (daysAgo: number, minutes = 0) => NOW - daysAgo * DAY + minutes * MIN;

  // 3 ChatGPT visitors (different IPs = different visitors)
  for (let i = 0; i < 3; i++) {
    await send(ing, { now: t(2, i), ip: `10.0.0.${i}`, referrer: "https://chatgpt.com/", url: "/" });
    await send(ing, { now: t(2, i) + MIN, ip: `10.0.0.${i}`, url: "/fiyat" });
  }
  // 1 Perplexity visitor
  await send(ing, { now: t(1), ip: "10.0.1.1", referrer: "https://www.perplexity.ai/search/x", url: "/" });
  // 2 Google organik
  for (let i = 0; i < 2; i++) {
    await send(ing, { now: t(3, i), ip: `10.0.2.${i}`, referrer: "https://www.google.com/", url: "/blog/yazi" });
  }
  // 1 direct mobile visitor: clicks the CTA, abandons the form, rage clicks
  await send(ing, { now: t(1, 5), ip: "10.0.3.1", ua: IPHONE, url: "/" });
  await send(ing, { now: t(1, 6), ip: "10.0.3.1", ua: IPHONE, type: "event", name: "cta_click", url: "/" });
  await send(ing, {
    now: t(1, 7),
    ip: "10.0.3.1",
    ua: IPHONE,
    type: "event",
    name: "form_abandon",
    url: "/kayit",
    props: { field: "telefon" },
  });
  await send(ing, { now: t(1, 8), ip: "10.0.3.1", ua: IPHONE, type: "event", name: "rage_click", url: "/kayit" });
  await send(ing, { now: t(1, 9), ip: "10.0.3.1", ua: IPHONE, type: "event", name: "scroll", url: "/", props: { percent: 80 } });

  // A GPTBot read — must not count as human
  await send(ing, { now: t(1, 30), ip: "10.0.9.9", ua: "Mozilla/5.0 (compatible; GPTBot/1.2)", url: "/fiyat" });
  await send(ing, { now: t(1, 31), ip: "10.0.9.9", ua: "Mozilla/5.0 (compatible; GPTBot/1.2)", url: "/" });

  // 2 visitors in the previous period (for the comparison)
  await send(ing, { now: t(9), ip: "10.1.0.1", ua: CHROME, url: "/" });
  await send(ing, { now: t(10), ip: "10.1.0.2", ua: CHROME, url: "/" });
}

describe("MetricBundle", () => {
  test("human metrics exclude bots, and bot metrics stand apart", async () => {
    const store = await freshStore();
    await seed(store);
    const bundle = await buildBundle(store, {
      siteId: "demo",
      vertical: "landing",
      window: WIN,
      compare: previousWindow(WIN),
      now: NOW,
    });

    // 3 chatgpt + 1 perplexity + 2 google + 1 direct = 7 human visitors
    expect(evidenceOf(bundle, "visitors.unique")?.value).toBe(7);
    expect(evidenceOf(bundle, "ai.sessions")?.value).toBe(4);
    expect(evidenceOf(bundle, "ai.crawler.hits")?.value).toBe(2);

    const sources = evidenceOf(bundle, "ai.sources")?.rows ?? [];
    expect(sources[0]).toMatchObject({ source: "chatgpt", sessions: 3 });
    expect(sources[1]).toMatchObject({ source: "perplexity", sessions: 1 });

    // The page an AI crawler read must not leak into the human page list
    const crawlerPages = evidenceOf(bundle, "ai.crawler.pages")?.rows ?? [];
    expect(crawlerPages.map((r) => r.bot_name)).toEqual(["GPTBot", "GPTBot"]);
  });

  test("every piece of evidence carries its own query and parameters", async () => {
    const store = await freshStore();
    await seed(store);
    const bundle = await buildBundle(store, { siteId: "demo", vertical: "landing", window: WIN, now: NOW });
    for (const e of bundle.evidence) {
      // The real invariant: evidence = the query that ran + its parameters, and
      // every query is bound to THIS site and THIS window. (The parameter ORDER
      // may vary per metric — the time series also takes a bucket size — but the
      // site id and the window bounds must always be among the parameters.)
      expect(e.sql.length).toBeGreaterThan(20);
      expect((e.sql.match(/\?/g) ?? []).length).toBe(e.params.length);
      expect(e.params).toContain("demo");
      // The "live" metric deliberately looks at the last 5 minutes, NOT the
      // window; looking for window bounds there would be wrong.
      if (e.metric !== "live.visitors") expect(e.params).toContain(WIN.from);
    }
  });

  test("the live metric is independent of the window — it looks at the last 5 minutes", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    await send(ing, { now: NOW - 2 * MIN, ip: "10.9.0.1" }); // live
    await send(ing, { now: NOW - 60 * MIN, ip: "10.9.0.2" }); // in the window but not live
    const bundle = await buildBundle(store, { siteId: "demo", vertical: "landing", window: WIN, now: NOW });
    const live = evidenceOf(bundle, "live.visitors");
    expect(live?.value).toBe(1);
    expect(evidenceOf(bundle, "visitors.unique")?.value).toBe(2);
  });

  test("no query embeds a site id outside its parameters (no SQL injection surface)", async () => {
    const store = await freshStore();
    const bundle = await buildBundle(store, { siteId: "demo", vertical: "landing", window: WIN, now: NOW });
    for (const e of bundle.evidence) {
      expect(e.sql).not.toContain("demo");
    }
  });

  test("the comparison window runs the SAME query with different parameters", async () => {
    const store = await freshStore();
    await seed(store);
    const bundle = await buildBundle(store, {
      siteId: "demo",
      vertical: "landing",
      window: WIN,
      compare: previousWindow(WIN),
      now: NOW,
    });
    const v = evidenceOf(bundle, "visitors.unique");
    expect(v?.previous).toBe(2);
    expect(v?.deltaAbs).toBe(5);
    expect(v?.deltaPct).toBe(250);
    expect(v?.previousParams?.[1]).toBe(WIN.from - 7 * DAY);
  });

  test("the landing vertical includes landing metrics, generic does not", async () => {
    const store = await freshStore();
    const landing = await buildBundle(store, { siteId: "demo", vertical: "landing", window: WIN, now: NOW });
    const shopify = await buildBundle(store, { siteId: "demo", vertical: "shopify", window: WIN, now: NOW });
    expect(landing.evidence.some((e) => e.metric === "cta.conversion")).toBe(true);
    expect(shopify.evidence.some((e) => e.metric === "cta.conversion")).toBe(false);
  });

  test("every metric works on an empty database too (no division by zero)", async () => {
    const store = await freshStore();
    const bundle = await buildBundle(store, { siteId: "demo", vertical: "landing", window: WIN, now: NOW });
    expect(bundle.evidence).toHaveLength(METRICS.length);
    expect(evidenceOf(bundle, "bounce.rate")?.value).toBe(0);
    expect(evidenceOf(bundle, "cta.conversion")?.value).toBe(0);
  });
});

describe("composeDigest", () => {
  test("the deterministic digest passes its OWN guard — an invented number is impossible", async () => {
    const store = await freshStore();
    await seed(store);
    const bundle = await buildBundle(store, {
      siteId: "demo",
      vertical: "landing",
      window: WIN,
      compare: previousWindow(WIN),
      now: NOW,
    });
    const digest = composeDigest(bundle);
    const text = renderText(digest);
    const verdict = guardProse(text, bundle, { strictCausality: true });
    expect(verdict.dropped).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  test("every line is tied to at least one piece of evidence", async () => {
    const store = await freshStore();
    await seed(store);
    const bundle = await buildBundle(store, { siteId: "demo", vertical: "landing", window: WIN, now: NOW });
    const digest = composeDigest(bundle);
    for (const line of digest.lines) {
      expect(line.evidence.length).toBeGreaterThan(0);
    }
  });

  test("the AI crawler line carries the 'not human' warning", async () => {
    const store = await freshStore();
    await seed(store);
    const bundle = await buildBundle(store, { siteId: "demo", vertical: "landing", window: WIN, now: NOW });
    const digest = composeDigest(bundle);
    const line = digest.lines.find((l) => l.text.includes("crawler"));
    expect(line?.text).toContain("NOT human visitors");
  });

  test("a percentage swing on a small base produces no 'change' line (the false-positive brake)", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    // 2 visitors previously, 3 now: a 50% rise, but the base is below 20.
    await send(ing, { now: NOW - 9 * DAY, ip: "10.5.0.1" });
    await send(ing, { now: NOW - 10 * DAY, ip: "10.5.0.2" });
    await send(ing, { now: NOW - DAY, ip: "10.5.1.1" });
    await send(ing, { now: NOW - DAY, ip: "10.5.1.2" });
    await send(ing, { now: NOW - DAY, ip: "10.5.1.3" });
    const bundle = await buildBundle(store, {
      siteId: "demo",
      vertical: "landing",
      window: WIN,
      compare: previousWindow(WIN),
      now: NOW,
    });
    const digest = composeDigest(bundle);
    expect(digest.lines.filter((l) => l.kind === "change")).toHaveLength(0);
  });
});
