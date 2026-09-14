// packages/mcp/test/mcp.test.ts
// MCP surface. The two claims that matter:
//   1. Every answer carries its evidence — an agent can verify, not just trust.
//   2. It is READ-ONLY and site access is enforced per call.

import { beforeEach, describe, expect, test } from "bun:test";
import { Ingestor, SqliteStore, type Site } from "@vitrus/core";
import { callTool, TOOLS, ToolError, type ToolContext } from "../src/tools.ts";
import { handleRpc, MCP_PROTOCOL_VERSION } from "../src/server.ts";

const NOW = Date.UTC(2026, 8, 14, 12);
const DAY = 86_400_000;
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0 Safari/537.36";

const SITE_A: Site = { id: "site-a", name: "Alfa", domain: "alfa.example", vertical: "landing", createdAt: 0 };
const SITE_B: Site = { id: "site-b", name: "Beta", domain: "beta.example", vertical: "landing", createdAt: 0 };

let store: SqliteStore;
let ctx: ToolContext;

async function seed(siteId: string, count: number, opts: { referrer?: string; ua?: string } = {}) {
  const ing = new Ingestor(store, { secret: "s" });
  for (let i = 0; i < count; i++) {
    await ing.ingest(
      { site: siteId, type: "pageview", url: "/", referrer: opts.referrer ?? "" },
      { ip: `203.0.113.${i}`, userAgent: opts.ua ?? CHROME, now: NOW - DAY }
    );
  }
}

beforeEach(async () => {
  store = new SqliteStore(":memory:");
  await store.init();
  await store.upsertSite(SITE_A);
  await store.upsertSite(SITE_B);
  ctx = { store, allowedSiteIds: ["site-a"], now: NOW };
});

describe("protocol", () => {
  test("initialize returns version, capabilities and usage instructions", async () => {
    const res = (await handleRpc(ctx, { jsonrpc: "2.0", id: 1, method: "initialize" })) as {
      result: { protocolVersion: string; serverInfo: { name: string }; instructions: string };
    };
    expect(res.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(res.result.serverInfo.name).toBe("vitrus");
    // The instructions tell the model how to behave with evidence.
    expect(res.result.instructions).toContain("cite the evidence id");
  });

  test("tools/list returns every tool with a schema", async () => {
    const res = (await handleRpc(ctx, { id: 2, method: "tools/list" })) as {
      result: { tools: { name: string; inputSchema: unknown }[] };
    };
    expect(res.result.tools.length).toBe(TOOLS.length);
    for (const t of res.result.tools) {
      expect(t.inputSchema).toBeDefined();
      expect(t.name.length).toBeGreaterThan(2);
    }
  });

  test("initialized notification produces no response", async () => {
    expect(await handleRpc(ctx, { method: "notifications/initialized" })).toBeNull();
  });

  test("unknown method returns a JSON-RPC error", async () => {
    const res = (await handleRpc(ctx, { id: 9, method: "does/not/exist" })) as { error: { code: number } };
    expect(res.error.code).toBe(-32601);
  });

  test("tool failure comes back as isError, not a protocol error", async () => {
    // The model should SEE the message and retry, rather than the call exploding.
    const res = (await handleRpc(ctx, {
      id: 3,
      method: "tools/call",
      params: { name: "get_overview", arguments: { site: "site-b" } },
    })) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0]?.text).toContain("site not found");
  });
});

describe("access control", () => {
  test("a site outside the allow-list is refused", async () => {
    expect(callTool(ctx, "get_overview", { site: "site-b" })).rejects.toThrow(ToolError);
  });

  test("an unknown id and a forbidden id give the SAME message", async () => {
    // A different message would let an agent enumerate which ids exist.
    const msg = async (site: string): Promise<string> =>
      callTool(ctx, "get_overview", { site }).then(
        () => "",
        (e: Error) => e.message
      );
    const forbidden = await msg("site-b");
    const missing = await msg("no-such-site");
    expect(forbidden.replace("site-b", "X")).toBe(missing.replace("no-such-site", "X"));
  });

  test("list_sites only returns permitted sites", async () => {
    const out = (await callTool(ctx, "list_sites", {})) as { sites: { id: string }[] };
    expect(out.sites).toHaveLength(1);
    expect(out.sites[0]?.id).toBe("site-a");
  });

  test("there is NO write tool — analytics is a record, not a scratchpad", async () => {
    const names = TOOLS.map((t) => t.name);
    for (const verb of ["create", "delete", "update", "set", "add", "remove", "write"]) {
      expect(names.some((n) => n.startsWith(verb)), `write-ish tool: ${verb}`).toBe(false);
    }
  });
});

describe("evidence in every answer", () => {
  test("get_overview returns the query and params for each metric", async () => {
    await seed("site-a", 4);
    const out = (await callTool(ctx, "get_overview", { site: "site-a" })) as {
      metrics: { metric: string; value: number | null; query: string; params: unknown[] }[];
    };
    expect(out.metrics.length).toBeGreaterThan(5);
    for (const m of out.metrics) {
      expect(m.query, `${m.metric} has no query`).toContain("SELECT");
      expect(m.params).toContain("site-a");
    }
    const visitors = out.metrics.find((m) => m.metric === "visitors.unique");
    expect(visitors?.value).toBe(4);
  });

  test("get_digest carries evidence ids on every line", async () => {
    await seed("site-a", 5, { referrer: "https://chatgpt.com/" });
    const out = (await callTool(ctx, "get_digest", { site: "site-a" })) as {
      lines: { text: string; evidence: string[] }[];
      evidence: { id: string; query: string }[];
    };
    expect(out.lines.length).toBeGreaterThan(0);
    for (const l of out.lines) expect(l.evidence.length).toBeGreaterThan(0);
    // Every cited id must actually exist in the evidence list.
    const ids = new Set(out.evidence.map((e) => e.id));
    for (const l of out.lines) for (const id of l.evidence) expect(ids.has(id)).toBe(true);
  });

  test("funnel returns the generated query with parameterised steps", async () => {
    await seed("site-a", 3);
    const out = (await callTool(ctx, "analyze_funnel", { site: "site-a" })) as {
      steps: { sessions: number }[];
      query: string;
      params: unknown[];
    };
    expect(out.query).toContain("WITH s0");
    expect(out.params).toContain("site-a");
    // Step values are parameters, never inlined.
    expect(out.query).not.toContain("cta_click");
  });
});

describe("honesty in tool output", () => {
  test("AI crawlers are separated from AI referrals and the note says so", async () => {
    await seed("site-a", 3, { referrer: "https://chatgpt.com/" });
    await seed("site-a", 2, { ua: "Mozilla/5.0 (compatible; GPTBot/1.2)" });

    const out = (await callTool(ctx, "get_ai_traffic", { site: "site-a" })) as {
      note: string;
      metrics: { metric: string; value: number | null }[];
    };
    const referrals = out.metrics.find((m) => m.metric === "ai.sessions")?.value;
    const crawlers = out.metrics.find((m) => m.metric === "ai.crawler.hits")?.value;
    expect(referrals).toBe(3);
    expect(crawlers).toBe(2);
    expect(out.note).toContain("Never add the two together");
  });

  test("retention says it CANNOT be computed rather than returning zeros", async () => {
    await seed("site-a", 5);
    const out = (await callTool(ctx, "get_retention", { site: "site-a" })) as {
      retention: { available: boolean; reason?: string; remedy?: string };
    };
    expect(out.retention.available).toBe(false);
    expect(out.retention.reason).toBe("no_identity");
    expect(out.retention.remedy).toContain("identify");
  });

  test("the retention tool description warns the model not to estimate", () => {
    const tool = TOOLS.find((t) => t.name === "get_retention");
    expect(tool?.description).toContain("Do not report a retention number");
  });

  test("web vitals note explains p75 instead of average", async () => {
    const out = (await callTool(ctx, "get_web_vitals", { site: "site-a" })) as { note: string };
    expect(out.note).toContain("p75");
  });

  test("error tool states that stack traces are not collected", async () => {
    const out = (await callTool(ctx, "get_errors", { site: "site-a" })) as { note: string };
    expect(out.note).toContain("Stack traces are never collected");
  });
});

describe("input handling", () => {
  test("days is clamped to a sane range", async () => {
    await seed("site-a", 1);
    const out = (await callTool(ctx, "get_overview", { site: "site-a", days: 99999 })) as {
      window: { from: number; to: number };
    };
    expect(Math.round((out.window.to - out.window.from) / DAY)).toBe(365);
  });

  test("a missing site id is refused, not defaulted", async () => {
    expect(callTool(ctx, "get_overview", {})).rejects.toThrow(ToolError);
  });

  test("unknown tool name is refused", async () => {
    expect(callTool(ctx, "drop_database", {})).rejects.toThrow(ToolError);
  });
});
