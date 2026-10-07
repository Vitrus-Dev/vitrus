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
  applyFilters,
  buildBundle,
  composeDigest,
  computeFunnel,
  computeGoal,
  computeJourneys,
  computeRetention,
  computeRevenue,
  defaultFunnel,
  filterValues,
  HUMAN,
  parseFilters,
  previousWindow,
  resolvePatternFilters,
  REVENUE_DIMENSIONS,
  windowOf,
  type Evidence,
  type Filter,
  type Goal,
  type Store,
} from "@vitrus/core";

export interface ToolContext {
  store: Store;
  /** Sites this caller may read. Resolved by the host BEFORE tools run. */
  allowedSiteIds: readonly string[];
  now?: number;
  /**
   * Saved goals for a site. Goals are stored by the host (the cloud keeps
   * them per site), so the host lends a reader; without one, list_goals says
   * there are none and goal_report takes goals as arguments.
   */
  goals?: (siteId: string) => Promise<Goal[]>;
  /** Where the tracker is served, for get_tracking_snippet (e.g. https://app.vitrus.dev). */
  trackerOrigin?: string;
}

export interface ToolDef {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** MCP tool annotations: every tool here only reads. */
  annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
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
  days: { type: "number", description: "Look-back window in days (1-365). Defaults to 7. Ignored when from/to are given." },
};
const RANGE_PROP = {
  ...DAYS_PROP,
  from: { type: "string", description: "Start date, YYYY-MM-DD (UTC, inclusive). Use with 'to' for an exact range." },
  to: { type: "string", description: "End date, YYYY-MM-DD (UTC, inclusive)." },
};
const FILTERS_PROP = {
  filters: {
    type: "array",
    description:
      "Optional filters, all must match. Each is {field, op, value}. field: country, region, city, device, browser, os, " +
      "channel, source, lang, path, title, hostname, query, referrer_host, utm_source, utm_medium, utm_campaign, " +
      "utm_term, utm_content, screen, tag, event, entry_page, exit_page, or prop:<key>. op: is, is_not, contains, " +
      "not_contains, starts_with, regex, not_regex.",
    items: {
      type: "object",
      properties: { field: { type: "string" }, op: { type: "string" }, value: { type: "string" } },
      required: ["field", "value"],
    },
  },
};
/** Dimensions query_stats can break down by, and the column each reads. */
const DIMENSIONS: Readonly<Record<string, string>> = {
  path: "path", title: "title", hostname: "hostname", channel: "channel", source: "source",
  referrer_host: "referrer_host", country: "country", region: "region", city: "city", device: "device",
  browser: "browser", os: "os", lang: "lang", screen: "screen", utm_source: "utm_source",
  utm_medium: "utm_medium", utm_campaign: "utm_campaign", utm_term: "utm_term", utm_content: "utm_content",
  tag: "tag", event: "name",
};
const METRICS: Readonly<Record<string, string>> = {
  visitors: "COUNT(DISTINCT visitor_id)",
  sessions: "COUNT(DISTINCT session_id)",
  pageviews: "SUM(CASE WHEN type = 'pageview' THEN 1 ELSE 0 END)",
  events: "SUM(CASE WHEN type = 'event' THEN 1 ELSE 0 END)",
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
  {
    name: "get_realtime",
    title: "Who is on the site now",
    description:
      "Live: people seen in the last 5 minutes, and the pages they are on and where they came from. " +
      "Humans only (bots and AI crawlers excluded). Each figure comes with its query.",
    inputSchema: { type: "object", properties: { ...SITE_PROP }, required: ["site"] },
  },
  {
    name: "query_stats",
    title: "Flexible stats query",
    description:
      "The general query: one metric (visitors, sessions, pageviews or events), optionally broken down by a " +
      "dimension (path, channel, source, referrer_host, country, city, device, browser, os, utm_*, event, …) " +
      "or by 'day' for a time series, with optional filters and an exact date range. Returns the rows AND the SQL " +
      "that produced them. Use this for anything the dedicated tools do not answer.",
    inputSchema: {
      type: "object",
      properties: {
        ...SITE_PROP,
        ...RANGE_PROP,
        ...FILTERS_PROP,
        metric: { type: "string", enum: Object.keys(METRICS), description: "Defaults to visitors." },
        by: { type: "string", enum: [...Object.keys(DIMENSIONS), "day"], description: "Breakdown dimension, or 'day'. Omit for a single total." },
        limit: { type: "number", description: "Rows for a breakdown (1-100). Defaults to 10." },
      },
      required: ["site"],
    },
  },
  {
    name: "get_revenue",
    title: "Revenue",
    description:
      "Revenue from events that carry revenue + currency: totals, orders, average order value, revenue per visitor, " +
      "conversion rate, and a breakdown. Per currency — amounts are NEVER converted between currencies. Acquisition " +
      "dimensions (channel, source, campaign) are where the visit began, not the checkout page.",
    inputSchema: {
      type: "object",
      properties: {
        ...SITE_PROP,
        ...RANGE_PROP,
        ...FILTERS_PROP,
        by: { type: "string", enum: [...REVENUE_DIMENSIONS], description: "Breakdown. Defaults to channel." },
        currency: { type: "string", description: "ISO 4217, e.g. USD. Defaults to the currency with the most revenue." },
      },
      required: ["site"],
    },
  },
  {
    name: "get_journeys",
    title: "User journeys",
    description:
      "The most common page paths through the site, in order (a Sankey's data). Optionally pin steps: " +
      "stepFilters[i] is an exact path or a pattern with * for step i.",
    inputSchema: {
      type: "object",
      properties: {
        ...SITE_PROP,
        ...RANGE_PROP,
        steps: { type: "number", description: "How many pages deep (2-8). Defaults to 4." },
        limit: { type: "number", description: "How many journeys (1-100). Defaults to 20." },
        stepFilters: { type: "array", items: { type: ["string", "null"] }, description: "Per-step path or pattern; null = any." },
      },
      required: ["site"],
    },
  },
  {
    name: "list_goals",
    title: "Saved goals",
    description: "The goals saved for a site (page patterns or custom events). Use goal_report for their conversions.",
    inputSchema: { type: "object", properties: { ...SITE_PROP }, required: ["site"] },
  },
  {
    name: "goal_report",
    title: "Goal conversions",
    description:
      "Conversions and conversion rate for the site's saved goals — or for goals you pass in. A conversion is a " +
      "session that reached the goal at least once; the rate is over all sessions in the range. Each comes with its query.",
    inputSchema: {
      type: "object",
      properties: {
        ...SITE_PROP,
        ...RANGE_PROP,
        goals: {
          type: "array",
          description: "Optional ad-hoc goals: {name, type: 'page'|'event', value}. Page values may use * and **.",
          items: {
            type: "object",
            properties: { name: { type: "string" }, type: { type: "string", enum: ["page", "event"] }, value: { type: "string" } },
            required: ["type", "value"],
          },
        },
      },
      required: ["site"],
    },
  },
  {
    name: "get_tracking_snippet",
    title: "Install snippet",
    description: "The script tag to add to the site's <head>, and how to send custom events and revenue.",
    inputSchema: { type: "object", properties: { ...SITE_PROP }, required: ["site"] },
  },
];
for (const t of TOOLS) t.annotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

/** A window from either from/to dates or a look-back in days. */
function rangeOf(ctx: ToolContext, args: Record<string, unknown>): { from: number; to: number; label: string } {
  const now = ctx.now ?? Date.now();
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof args.from === "string" || typeof args.to === "string") {
    if (!re.test(String(args.from ?? "")) || !re.test(String(args.to ?? ""))) {
      throw new ToolError("from and to must both be dates like 2026-09-30");
    }
    const from = Date.parse(String(args.from) + "T00:00:00Z");
    const to = Date.parse(String(args.to) + "T00:00:00Z") + 86_400_000;
    if (!(from < to)) throw new ToolError("from must be on or before to");
    if (to - from > 366 * 86_400_000) throw new ToolError("a range can be at most a year");
    return { from, to: Math.min(to, now), label: String(args.from) + " to " + String(args.to) };
  }
  const days = clampDays(args.days);
  const w = windowOf(now, days, "last " + days + " days");
  return { from: w.from, to: w.to, label: w.label };
}

async function filtersOf(ctx: ToolContext, siteId: string, raw: unknown): Promise<Filter[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ToolError("filters must be an array of {field, op, value}");
  const norm = raw.map((f) => ({ op: "is", ...(f as object) }));
  try {
    return await resolvePatternFilters((sql, params) => ctx.store.select(sql, params), siteId, parseFilters(JSON.stringify(norm)));
  } catch (e) {
    throw new ToolError(e instanceof Error ? e.message : "invalid filters");
  }
}

function queryOut(q: { label?: string; sql: string; params: unknown[]; rows: unknown[] }, maxRows = 50) {
  return {
    ...(q.label ? { label: q.label } : {}),
    query: q.sql,
    params: q.params,
    rows: q.rows.slice(0, maxRows),
    ...(q.rows.length > maxRows ? { rowsTruncated: q.rows.length - maxRows } : {}),
  };
}

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

    case "get_realtime": {
      const site = resolveSite(ctx, args.site);
      const now = ctx.now ?? Date.now();
      const since = now - 5 * 60_000;
      const sel = (sql: string, params: unknown[]) => ctx.store.select(sql, params);
      const run = async (label: string, sql: string, params: unknown[]) => ({ label, sql, params, rows: await sel(sql, params) });
      const visitors = await run(
        "People seen in the last 5 minutes",
        "SELECT COUNT(DISTINCT visitor_id) AS visitors FROM events WHERE site_id = ? AND ts >= ? AND " + HUMAN,
        [site, since]
      );
      const pages = await run(
        "Pages they are on",
        "SELECT path, COUNT(DISTINCT visitor_id) AS visitors FROM events WHERE site_id = ? AND ts >= ? AND type = 'pageview' AND " + HUMAN +
          " GROUP BY path ORDER BY visitors DESC LIMIT 10",
        [site, since]
      );
      const sources = await run(
        "Where they came from",
        "SELECT channel, COUNT(DISTINCT visitor_id) AS visitors FROM events WHERE site_id = ? AND ts >= ? AND " + HUMAN +
          " GROUP BY channel ORDER BY visitors DESC LIMIT 10",
        [site, since]
      );
      return {
        site,
        asOf: new Date(now).toISOString(),
        visitorsNow: Number((visitors.rows[0] as { visitors?: number } | undefined)?.visitors ?? 0),
        evidence: [queryOut(visitors), queryOut(pages), queryOut(sources)],
      };
    }

    case "query_stats": {
      const site = resolveSite(ctx, args.site);
      const range = rangeOf(ctx, args);
      const metric = String(args.metric ?? "visitors");
      const expr = METRICS[metric];
      if (!expr) throw new ToolError("metric must be one of: " + Object.keys(METRICS).join(", "));
      const by = args.by === undefined || args.by === null || args.by === "" ? null : String(args.by);
      if (by !== null && by !== "day" && !DIMENSIONS[by]) throw new ToolError("cannot break down by " + by);
      const limit = Math.max(1, Math.min(100, Math.round(Number(args.limit ?? 10)) || 10));
      const filters = await filtersOf(ctx, site, args.filters);
      const where = applyFilters("site_id = ? AND ts >= ? AND ts < ?", filters) + " AND " + HUMAN;
      const params: unknown[] = [site, range.from, range.to, ...filterValues(filters, site)];
      let sql: string;
      if (by === null) {
        sql = "SELECT " + expr + " AS value FROM events WHERE " + where;
      } else if (by === "day") {
        sql = "SELECT date(ts / 1000, 'unixepoch') AS day, " + expr + " AS value FROM events WHERE " + where + " GROUP BY day ORDER BY day";
      } else {
        const col = DIMENSIONS[by] as string;
        sql = "SELECT " + col + " AS " + by + ", " + expr + " AS value FROM events WHERE " + where +
          (by === "event" ? " AND type = 'event'" : "") + " GROUP BY " + col + " ORDER BY value DESC LIMIT " + limit;
      }
      const rows = await ctx.store.select(sql, params);
      return {
        site,
        window: { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString(), label: range.label },
        metric,
        by,
        ...(by === null ? { value: Number((rows[0] as { value?: number } | undefined)?.value ?? 0) } : {}),
        evidence: queryOut({ sql, params, rows }, 100),
        note: "Humans only: bots, AI crawlers and agent sessions are excluded. Cite the query when you report a number.",
      };
    }

    case "get_revenue": {
      const site = resolveSite(ctx, args.site);
      const range = rangeOf(ctx, args);
      const filters = await filtersOf(ctx, site, args.filters);
      try {
        const r = await computeRevenue((sql, params) => ctx.store.select(sql, params), {
          siteId: site,
          from: range.from,
          to: range.to,
          filters,
          by: args.by === undefined ? undefined : String(args.by),
          currency: args.currency === undefined ? undefined : String(args.currency).toUpperCase(),
          bucketMs: 86_400_000,
          previous: { from: range.from - (range.to - range.from), to: range.from },
        });
        return {
          site,
          window: range.label,
          currency: r.currency,
          totals: r.totals.rows[0] ?? null,
          previousTotals: r.previousTotals,
          averageOrderValue: r.averageOrderValue,
          revenuePerVisitor: r.revenuePerVisitor,
          conversionRate: r.conversionRate,
          by: r.by,
          evidence: [queryOut(r.currencies), queryOut(r.totals), queryOut(r.breakdown), queryOut(r.agentRevenue), queryOut(r.rejected)],
          note: r.currency === null ? "No revenue events in this range." : "Amounts are in " + r.currency + " only; other currencies are listed separately and never converted.",
        };
      } catch (e) {
        throw new ToolError(e instanceof Error ? e.message : "revenue query failed");
      }
    }

    case "get_journeys": {
      const site = resolveSite(ctx, args.site);
      const range = rangeOf(ctx, args);
      const r = await computeJourneys((sql, params) => ctx.store.select(sql, params), {
        siteId: site,
        from: range.from,
        to: range.to,
        steps: args.steps === undefined ? 4 : Number(args.steps),
        limit: args.limit === undefined ? 20 : Number(args.limit),
        stepFilters: Array.isArray(args.stepFilters) ? (args.stepFilters as (string | null)[]) : undefined,
      });
      return { site, window: range.label, journeys: r.rows, evidence: queryOut(r, 0) };
    }

    case "list_goals": {
      const site = resolveSite(ctx, args.site);
      const goals = ctx.goals ? await ctx.goals(site) : [];
      return { site, goals, ...(goals.length ? {} : { note: "No saved goals. goal_report also accepts goals as arguments." }) };
    }

    case "goal_report": {
      const site = resolveSite(ctx, args.site);
      const range = rangeOf(ctx, args);
      const goals: Goal[] = Array.isArray(args.goals) && args.goals.length
        ? (args.goals as Goal[]).map((g, i) => ({ name: g.name || "Goal " + (i + 1), type: g.type, value: String(g.value ?? "") }))
        : ctx.goals ? await ctx.goals(site) : [];
      if (!goals.length) throw new ToolError("no goals: save some in the dashboard, or pass goals: [{type, value}]");
      const out = [];
      for (const goal of goals.slice(0, 20)) {
        try {
          const r = await computeGoal((sql, params) => ctx.store.select(sql, params), { siteId: site, from: range.from, to: range.to, goal });
          out.push({ goal: r.goal, conversions: r.conversions, sessions: r.sessions, rate: r.rate, evidence: queryOut(r.evidence) });
        } catch (e) {
          out.push({ goal, error: e instanceof Error ? e.message : "could not compute" });
        }
      }
      return { site, window: range.label, goals: out };
    }

    case "get_tracking_snippet": {
      const site = resolveSite(ctx, args.site);
      const origin = (ctx.trackerOrigin ?? "https://YOUR-VITRUS-HOST").replace(/\/$/, "");
      return {
        site,
        snippet: '<script defer data-site="' + site + '" src="' + origin + '/v.js"></script>',
        customEvent: 'vitrus("signup", { plan: "pro" })',
        revenue: 'vitrus("purchase", { revenue: 29, currency: "USD" })',
        identify: 'vitrus.identify("user-123")  // makes retention possible; the id is hashed, never stored raw',
        note: "Cookie-free: no consent banner needed. Put the tag in <head> on every page.",
      };
    }

    default:
      throw new ToolError(`unknown tool: ${name}`);
  }
}
