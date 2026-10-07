// packages/mcp/test/tools-more.test.ts
// The second set of tools: still read-only, still evidence on every answer,
// still the same allow-list.

import { beforeEach, describe, expect, test } from "bun:test";
import { Ingestor, SqliteStore, type Site } from "@vitrus/core";
import { callTool, TOOLS, ToolError, type ToolContext } from "../src/tools.ts";

const NOW = Date.UTC(2026, 9, 7, 12);
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const SITE: Site = { id: "site-a", name: "Alfa", domain: "alfa.example", vertical: "landing", createdAt: 0 };
let store: SqliteStore;
let ctx: ToolContext;

beforeEach(async () => {
  store = new SqliteStore(":memory:");
  await store.init();
  await store.upsertSite(SITE);
  await store.upsertSite({ ...SITE, id: "site-b", domain: "beta.example" });
  const ing = new Ingestor(store, { secret: "s" });
  for (let i = 0; i < 6; i++) {
    const ctxI = { ip: `203.0.113.${i}`, userAgent: i % 2 ? IPHONE : CHROME, now: NOW - 3 * 3_600_000, host: "alfa.example", country: i < 4 ? "DE" : "US" };
    await ing.ingest({ site: "site-a", type: "pageview", url: i < 3 ? "/pricing" : "/", referrer: i < 2 ? "https://chatgpt.com/" : "" }, ctxI);
    if (i < 2) await ing.ingest({ site: "site-a", type: "event", name: "purchase", url: "/checkout", props: { revenue: 29, currency: "USD" } }, { ...ctxI, now: ctxI.now + 60_000 });
  }
  await ing.ingest({ site: "site-a", type: "pageview", url: "/docs" }, { ip: "198.51.100.9", userAgent: CHROME, now: NOW - 60_000, host: "alfa.example" });
  ctx = {
    store, allowedSiteIds: ["site-a"], now: NOW, trackerOrigin: "https://app.vitrus.dev",
    goals: async () => [{ name: "Pricing", type: "page", value: "/pricing" }],
  };
});

describe("more tools", () => {
  test("every tool is declared read-only to the client", () => {
    for (const t of TOOLS) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
    expect(TOOLS.length).toBeGreaterThanOrEqual(15);
  });

  test("query_stats: total, breakdown and daily series, each with its SQL", async () => {
    const total = (await callTool(ctx, "query_stats", { site: "site-a", days: 1 })) as { value: number; evidence: { query: string } };
    expect(total.value).toBe(7);
    expect(total.evidence.query).toContain("COUNT(DISTINCT visitor_id)");
    const by = (await callTool(ctx, "query_stats", { site: "site-a", days: 1, by: "country", metric: "pageviews" })) as { evidence: { rows: { country: string; value: number }[] } };
    expect(by.evidence.rows.find((r) => r.country === "DE")?.value).toBe(4);
    const day = (await callTool(ctx, "query_stats", { site: "site-a", from: "2026-10-06", to: "2026-10-07", by: "day" })) as { evidence: { rows: { day: string }[] } };
    expect(day.evidence.rows.map((r) => r.day)).toContain("2026-10-07");
  });

  test("query_stats filters, and refuses what it cannot do", async () => {
    const f = (await callTool(ctx, "query_stats", { site: "site-a", days: 1, filters: [{ field: "path", value: "/pricing" }] })) as { value: number };
    expect(f.value).toBe(3);
    await expect(callTool(ctx, "query_stats", { site: "site-a", by: "password" })).rejects.toBeInstanceOf(ToolError);
    await expect(callTool(ctx, "query_stats", { site: "site-a", from: "yesterday", to: "today" })).rejects.toBeInstanceOf(ToolError);
  });

  test("realtime, revenue, goals, journeys and the snippet", async () => {
    const rt = (await callTool(ctx, "get_realtime", { site: "site-a" })) as { visitorsNow: number };
    expect(rt.visitorsNow).toBe(1);
    const rev = (await callTool(ctx, "get_revenue", { site: "site-a", days: 1 })) as { currency: string; totals: { revenue: number; orders: number } };
    expect(rev.currency).toBe("USD");
    expect(rev.totals).toMatchObject({ revenue: 58, orders: 2 });
    const goals = (await callTool(ctx, "goal_report", { site: "site-a", days: 1 })) as { goals: { conversions: number }[] };
    expect(goals.goals[0]!.conversions).toBe(3);
    const j = (await callTool(ctx, "get_journeys", { site: "site-a", days: 1, steps: 2 })) as { journeys: unknown[] };
    expect(Array.isArray(j.journeys)).toBe(true);
    const sn = (await callTool(ctx, "get_tracking_snippet", { site: "site-a" })) as { snippet: string };
    expect(sn.snippet).toBe('<script defer data-site="site-a" src="https://app.vitrus.dev/v.js"></script>');
  });

  test("the allow-list holds for every new tool", async () => {
    for (const name of ["get_realtime", "query_stats", "get_revenue", "get_journeys", "list_goals", "goal_report", "get_tracking_snippet"]) {
      await expect(callTool(ctx, name, { site: "site-b" }), name).rejects.toBeInstanceOf(ToolError);
    }
  });
});
