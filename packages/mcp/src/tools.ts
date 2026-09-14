// packages/mcp/src/tools.ts
// MCP tools — "analytics your agent can operate", with one difference:
// EVERY ANSWER CARRIES ITS EVIDENCE.
//
// ═══ WHY THIS MATTERS MORE FOR AN AGENT THAN FOR A HUMAN ═══
// A human reading a dashboard can sense when a number looks wrong. An agent
// cannot: it receives a number, writes it into a report, and the error
// propagates with full confidence. So every tool here returns the query, its
// parameters and the raw rows alongside the value. The agent can verify —
// and so can the person reading the agent's output.
//
// Everything here is READ-ONLY. An agent cannot create, delete or reconfigure
// anything. Analytics is a system of record; letting a model mutate it would
// make the record itself untrustworthy. (Rybbit's MCP lets agents create goals;
// we deliberately don't — a record you can write to is not a record.)

import {
  buildBundle,
  composeDigest,
  computeFunnel,
  computeRetention,
  defaultFunnel,
  previousWindow,
  windowOf,
  type Evidence,
  type Store,
} from "@vitrus/core";

export interface ToolContext {
  store: Store;
  /** Sites this caller may read. Resolved by the host BEFORE tools run. */
  allowedSiteIds: readonly string[];
  now?: number;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class ToolError extends Error {}

/** Trim an evidence record for transport: raw rows can be large. */
function evidenceOut(e: Evidence, maxRows = 20) {
  return {
    id: e.id,
    metric: e.metric,
    label: e.label,
    value: e.value,
    previous: e.previous ?? null,
    changePercent: e.deltaPct ?? null,
    query: e.sql,
    params: e.params,
    rows: e.rows.slice(0, maxRows),
    ...(e.rows.length > maxRows ? { rowsTruncated: e.rows.length - maxRows } : {}),
  };
}

const SITE_PROP = {
  site: { type: "string", description: "Site id. Use list_sites first if you do not have one." },
};
const DAYS_PROP = {
  days: { type: "number", description: "Look-back window in days (1-365). Defaults to 7." },
};

export const TOOLS: ToolDef[] = [
  {
    name: "list_sites",
    description:
      "List the sites this caller can read. Returns id, name, domain and privacy mode. " +
      "Start here when you do not already have a site id.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_overview",
    description:
      "Traffic overview for a site: visitors, sessions, pageviews, bounce rate, visit duration, " +
      "channels, top pages and referrers. EVERY metric comes back with the SQL that produced it, " +
      "its parameters and the raw rows — cite or verify them rather than trusting the number alone.",
    inputSchema: {
      type: "object",
      properties: { ...SITE_PROP, ...DAYS_PROP },
      required: ["site"],
    },
  },
  {
    name: "get_ai_traffic",
    description:
      "Traffic from AI assistants, kept separate from AI crawlers. 'AI referral' is a human who " +
      "arrived from ChatGPT/Perplexity/Claude; 'AI crawler' is GPTBot or ClaudeBot READING the site " +
      "and bringing nobody. Crawlers are never counted as visitors. Also returns which pages the " +
      "crawlers read — the only real feedback loop for GEO/AEO work.",
    inputSchema: {
      type: "object",
      properties: { ...SITE_PROP, ...DAYS_PROP },
      required: ["site"],
    },
  },
  {
    name: "get_digest",
    description:
      "The plain-language summary for a period: what happened, what changed, what to do. " +
      "Every sentence lists the evidence ids it rests on. This text is generated deterministically " +
      "from queries, not by a language model — you can quote it safely.",
    inputSchema: {
      type: "object",
      properties: { ...SITE_PROP, ...DAYS_PROP },
      required: ["site"],
    },
  },
  {
    name: "analyze_funnel",
    description:
      "Ordered conversion funnel. Steps are counted IN ORDER: a step only counts if it happened " +
      "after the previous one, so someone who signs up and then visits the pricing page is not a " +
      "conversion. Omit 'steps' to use the site's default funnel.",
    inputSchema: {
      type: "object",
      properties: {
        ...SITE_PROP,
        ...DAYS_PROP,
        steps: {
          type: "array",
          description: "Ordered steps. Each is {type: 'page'|'event', value: string, label?: string}.",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["page", "event"] },
              value: { type: "string" },
              label: { type: "string" },
            },
            required: ["type", "value"],
          },
        },
      },
      required: ["site"],
    },
  },
  {
    name: "get_retention",
    description:
      "Cohort retention matrix. IMPORTANT: this returns available=false for anonymous traffic and " +
      "explains why — visitor ids rotate daily (no cookies), so cross-day tracking is mathematically " +
      "impossible without vitrus.identify(). Do not report a retention number when available=false.",
    inputSchema: {
      type: "object",
      properties: { ...SITE_PROP, ...DAYS_PROP },
      required: ["site"],
    },
  },
  {
    name: "get_web_vitals",
    description:
      "Core Web Vitals from real visits (p75, not average — a few slow visits drag an average and " +
      "hide the problem), plus the slowest pages by LCP.",
    inputSchema: {
      type: "object",
      properties: { ...SITE_PROP, ...DAYS_PROP },
      required: ["site"],
    },
  },
  {
    name: "get_errors",
    description:
      "JavaScript errors captured from real visits, grouped by message and page, with the browsers " +
      "they occur in. Stack traces are never collected (they leak user data), so expect message, " +
      "file and line only.",
    inputSchema: {
      type: "object",
      properties: { ...SITE_PROP, ...DAYS_PROP },
      required: ["site"],
    },
  },
];

function clampDays(v: unknown): number {
  const n = Number(v ?? 7);
  if (!Number.isFinite(n)) return 7;
  return Math.min(365, Math.max(1, Math.round(n)));
}

/**
 * Resolve the site id against the caller's allow-list.
 *
 * An unknown id and a forbidden id produce the SAME error, deliberately: a
 * different message would tell an agent which ids exist, and an agent is a
 * very efficient enumerator.
 */
function resolveSite(ctx: ToolContext, raw: unknown): string {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id || !ctx.allowedSiteIds.includes(id)) {
    throw new ToolError(`site not found: ${id || "(missing)"} — call list_sites to see what you can read`);
  }
  return id;
}

async function bundleFor(ctx: ToolContext, siteId: string, days: number) {
  const now = ctx.now ?? Date.now();
  const site = await ctx.store.getSite(siteId);
  const window = windowOf(now, days, `last ${days} days`);
  return buildBundle(ctx.store, {
    siteId,
    vertical: site?.vertical ?? "generic",
    window,
    compare: previousWindow(window),
    now,
  });
}

function pick(bundle: Awaited<ReturnType<typeof bundleFor>>, metrics: string[]) {
  return bundle.evidence.filter((e) => metrics.includes(e.metric)).map((e) => evidenceOut(e));
}

export async function callTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "list_sites": {
      const sites = [];
      for (const id of ctx.allowedSiteIds) {
        const s = await ctx.store.getSite(id);
        if (s) {
          sites.push({ id: s.id, name: s.name, domain: s.domain, privacyMode: s.privacyMode ?? "standard" });
        }
      }
      return { sites };
    }

    case "get_overview": {
      const site = resolveSite(ctx, args.site);
      const days = clampDays(args.days);
      const bundle = await bundleFor(ctx, site, days);
      return {
        site,
        window: bundle.window,
        note: "Each entry includes the query that produced it. Cite evidence ids when you report a number.",
        metrics: pick(bundle, [
          "visitors.unique",
          "sessions.total",
          "pageviews.total",
          "bounce.rate",
          "visit.duration",
          "views.per_session",
          "channels.sessions",
          "pages.top",
          "referrers.top",
          "entry.pages",
          "exit.pages",
        ]),
      };
    }

    case "get_ai_traffic": {
      const site = resolveSite(ctx, args.site);
      const bundle = await bundleFor(ctx, site, clampDays(args.days));
      return {
        site,
        window: bundle.window,
        note:
          "ai.* metrics are humans arriving FROM an AI assistant. ai.crawler.* are bots READING the " +
          "site and are excluded from visitor counts. Never add the two together.",
        metrics: pick(bundle, [
          "ai.sessions",
          "ai.sources",
          "ai.landing_pages",
          "ai.crawler.hits",
          "ai.crawler.pages",
          "sessions.total",
        ]),
      };
    }

    case "get_digest": {
      const site = resolveSite(ctx, args.site);
      const bundle = await bundleFor(ctx, site, clampDays(args.days));
      const digest = composeDigest(bundle);
      return {
        site,
        window: digest.window,
        lines: digest.lines.map((l) => ({ kind: l.kind, text: l.text, evidence: l.evidence })),
        evidence: bundle.evidence.map((e) => evidenceOut(e, 5)),
        note: "Generated deterministically from queries, not by a language model.",
      };
    }

    case "analyze_funnel": {
      const site = resolveSite(ctx, args.site);
      const days = clampDays(args.days);
      const now = ctx.now ?? Date.now();
      const w = windowOf(now, days, `last ${days} days`);
      const siteRow = await ctx.store.getSite(site);
      const steps = Array.isArray(args.steps) && args.steps.length > 0
        ? (args.steps as never)
        : defaultFunnel(siteRow?.vertical ?? "generic");
      const result = await computeFunnel((sql, params) => ctx.store.select(sql, params), {
        siteId: site,
        from: w.from,
        to: w.to,
        steps,
      });
      return {
        site,
        window: w,
        steps: result.steps,
        conversionRate: result.conversionRate,
        biggestDrop: result.worstStep,
        query: result.sql,
        params: result.params,
        note: "Steps are counted in order; a later step only counts if it happened after the earlier one.",
      };
    }

    case "get_retention": {
      const site = resolveSite(ctx, args.site);
      const days = clampDays(args.days);
      const now = ctx.now ?? Date.now();
      const w = windowOf(now, days, `last ${days} days`);
      const result = await computeRetention((sql, params) => ctx.store.select(sql, params), {
        siteId: site,
        from: w.from,
        to: w.to,
      });
      return { site, window: w, retention: result };
    }

    case "get_web_vitals": {
      const site = resolveSite(ctx, args.site);
      const bundle = await bundleFor(ctx, site, clampDays(args.days));
      return {
        site,
        window: bundle.window,
        note: "p75, not average. Google's Core Web Vitals thresholds are defined on p75.",
        metrics: pick(bundle, ["vitals.p75", "vitals.slow_pages"]),
      };
    }

    case "get_errors": {
      const site = resolveSite(ctx, args.site);
      const bundle = await bundleFor(ctx, site, clampDays(args.days));
      return {
        site,
        window: bundle.window,
        note: "Stack traces are never collected — they routinely carry user data.",
        metrics: pick(bundle, ["errors.total", "errors.top", "errors.browsers"]),
      };
    }

    default:
      throw new ToolError(`unknown tool: ${name}`);
  }
}
