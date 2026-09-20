// packages/core/src/metrics/queries.ts
// Deterministic metric definitions. Every metric = {id, label, SQL, params}.
// The SQL is KEPT as a string because it IS the evidence: when a user asks
// "where did this number come from", what we show them is exactly the query
// written here.
//
// Two rules:
//  1. Human metrics ALWAYS filter on `bot_kind = ''`. Forget that filter in one
//     place and the number inflates silently — which is why the `HUMAN` constant
//     is used, never copy-pasted.
//  2. Bot metrics are separate metrics (the AI-crawler panel) and are never
//     summed together with human metrics.

/**
 * What counts as a person.
 *
 * Two exclusions, and the second one is new. A known bot is excluded by its
 * user-agent as it always was. An **agent session** is excluded by its
 * signature: an agentic browser (ChatGPT Atlas, OpenAI Operator) runs
 * JavaScript, reaches this beacon and sends an ordinary Chrome user-agent, so
 * no bot table can catch it — but it signs its requests, and a request that
 * cryptographically proves it is ChatGPT is not a visitor.
 *
 * Everyone else handles this differently and, we think, wrongly: Umami and
 * Plausible discard such traffic, Rybbit blocks it, GA4 counts it as a person.
 * Discarding is wrong because an agent that completes a checkout is revenue;
 * counting it as human is wrong because an agent that bounces is not a UX
 * problem. So it is neither dropped nor merged — see AGENT_SESSION.
 *
 * Written as `= 'human'` rather than `<> 'verified'` on purpose: a request that
 * carried a signature we could not verify is not a person either, and the
 * looser form counted the first request from every signing agent — once per key
 * cache lifetime — as a visitor.
 *
 * Changing this one constant moves every human metric at once, which is the
 * reason it is a constant and never copy-pasted.
 */
export const HUMAN = `bot_kind = '' AND agent_trust = 'human'`;

/**
 * A browser session driven by an agent on someone's behalf.
 *
 * Browser-shaped (no bot user-agent) AND cryptographically proven to be an
 * agent. Deliberately narrow: an agent browsing without a signature is
 * indistinguishable from a person, and we would rather undercount than guess.
 * The documentation says so rather than implying this number is a total.
 */
export const AGENT_SESSION = `bot_kind = '' AND agent_trust = 'verified'`;

/**
 * The bar at which a request carries enough automation signals to be worth
 * mentioning. Mirrors SUSPECT_AT in signals.ts — the number lives in both
 * places because one is TypeScript and one is SQL, and a test pins them equal.
 */
export const SUSPECT_SCORE = 5;

/**
 * `HUMAN`, minus the requests that look automated.
 *
 * NOT the default. The reason people ask for this is real — self-hosters report
 * 200 real visitors showing up as 5,000 — but applying it silently would make
 * the product unable to explain its own numbers, and it would sometimes delete
 * a real visitor who happens to use an unusual browser. So it is a choice the
 * operator makes per request, the dashboard says when it is on, and the
 * evidence panel shows the predicate that did it.
 */
export const HUMAN_STRICT = `${HUMAN} AND bot_score < ${SUSPECT_SCORE}`;

export type MetricKind = "scalar" | "rows" | "series";
export type MetricUnit = "count" | "percent" | "seconds" | "ratio";

export interface ParamContext {
  siteId: string;
  from: number;
  to: number;
  /** Time-series bucket size (ms). Derived from the length of the window. */
  bucketMs: number;
  /** Start of the "live" window (now - 5 min). */
  liveFrom: number;
  now: number;
  /**
   * Values for the active dashboard filters, in declaration order.
   *
   * A custom parameter builder must append these after ITS window predicate,
   * because `applyFilters` puts the placeholders immediately after the same
   * predicate and only the builder knows where that is in its own list.
   */
  filterValues: unknown[];
}

export interface MetricDef {
  id: string;
  label: string;
  kind: MetricKind;
  unit: MetricUnit;
  /** Default parameter order: site_id, from, to (repeated once per `?` in the SQL). */
  sql: string;
  /**
   * Custom parameter builder. Metrics like the time series and "live" need
   * inputs other than the window triple; the evidence is still stored as
   * `{sql, params}`, so transparency is intact — only where the parameters came
   * from differs.
   */
  params?: (ctx: ParamContext) => unknown[];
  /** Vertical filter: which kind of site this metric is meaningful for. */
  verticals?: ("landing" | "shopify" | "generic")[];
  /** When true, no `compare` window is computed (meaningless for series and live metrics). */
  noCompare?: boolean;
}

const WINDOW = `site_id = ? AND ts >= ? AND ts < ?`;

export const METRICS: readonly MetricDef[] = [
  // ——— Time series: the heart of the dashboard ———
  // One query returns three series (views · visitors · events); the bucket size
  // arrives as a parameter (hours over a 24h window, days over a long one).
  // Empty buckets are NOT produced in SQL — the caller fills the axis, otherwise
  // every query would have to build a calendar table.
  {
    id: "timeseries",
    label: "Time series",
    kind: "series",
    unit: "count",
    noCompare: true,
    sql: `SELECT CAST((ts - ?) / ? AS INTEGER) AS bucket,
                 COUNT(*) FILTER (WHERE type = 'pageview')      AS views,
                 COUNT(DISTINCT visitor_id)                     AS visitors,
                 COUNT(DISTINCT session_id)                     AS sessions,
                 COUNT(*) FILTER (WHERE type = 'event')         AS events
            FROM events
           WHERE site_id = ? AND ts >= ? AND ts < ? AND ${HUMAN}
           GROUP BY bucket ORDER BY bucket ASC`,
    params: (c) => [c.from, c.bucketMs, c.siteId, c.from, c.to, ...c.filterValues],
  },
  {
    id: "live.visitors",
    label: "Online now",
    kind: "scalar",
    unit: "count",
    noCompare: true,
    sql: `SELECT COUNT(DISTINCT visitor_id) AS value
            FROM events WHERE site_id = ? AND ts >= ? AND ${HUMAN}`,
    params: (c) => [c.siteId, c.liveFrom, ...c.filterValues],
  },
  {
    id: "visitors.unique",
    label: "Unique visitors",
    kind: "scalar",
    unit: "count",
    sql: `SELECT COUNT(DISTINCT visitor_id) AS value FROM events WHERE ${WINDOW} AND ${HUMAN}`,
  },
  {
    id: "sessions.total",
    label: "Sessions",
    kind: "scalar",
    unit: "count",
    sql: `SELECT COUNT(DISTINCT session_id) AS value FROM events WHERE ${WINDOW} AND ${HUMAN}`,
  },
  {
    id: "pageviews.total",
    label: "Pageviews",
    kind: "scalar",
    unit: "count",
    sql: `SELECT COUNT(*) AS value FROM events WHERE ${WINDOW} AND ${HUMAN} AND type = 'pageview'`,
  },
  {
    id: "bounce.rate",
    label: "Bounce rate",
    kind: "scalar",
    unit: "percent",
    sql: `SELECT CASE WHEN COUNT(*) = 0 THEN 0
                 ELSE ROUND(100.0 * SUM(CASE WHEN views = 1 THEN 1 ELSE 0 END) / COUNT(*), 1) END AS value
            FROM (SELECT session_id, COUNT(*) AS views
                    FROM events
                   WHERE ${WINDOW} AND ${HUMAN} AND type = 'pageview'
                   GROUP BY session_id)`,
  },
  {
    // Visit duration = the span between a session's first and last event. A
    // single-event session counts as 0s and IS INCLUDED IN THE AVERAGE (Umami
    // and Litlyx do the same). Excluding them would push the number up and it
    // would no longer deserve the name "average".
    id: "visit.duration",
    label: "Average visit duration",
    kind: "scalar",
    unit: "seconds",
    sql: `SELECT COALESCE(ROUND(AVG(span), 0), 0) AS value
            FROM (SELECT (MAX(ts) - MIN(ts)) / 1000.0 AS span
                    FROM events
                   WHERE ${WINDOW} AND ${HUMAN}
                   GROUP BY session_id)`,
  },
  {
    id: "views.per_session",
    label: "Pages per session",
    kind: "scalar",
    unit: "ratio",
    sql: `SELECT CASE WHEN s.n = 0 THEN 0 ELSE ROUND(1.0 * v.n / s.n, 2) END AS value
            FROM (SELECT COUNT(DISTINCT session_id) AS n FROM events WHERE ${WINDOW} AND ${HUMAN}) s,
                 (SELECT COUNT(*) AS n FROM events WHERE ${WINDOW} AND ${HUMAN} AND type = 'pageview') v`,
  },
  {
    id: "channels.sessions",
    label: "Channel breakdown (sessions)",
    kind: "rows",
    unit: "count",
    sql: `SELECT channel, COUNT(DISTINCT session_id) AS sessions
            FROM events WHERE ${WINDOW} AND ${HUMAN}
           GROUP BY channel ORDER BY sessions DESC, channel ASC`,
  },
  {
    id: "ai.sessions",
    label: "Sessions from AI assistants",
    kind: "scalar",
    unit: "count",
    sql: `SELECT COUNT(DISTINCT session_id) AS value
            FROM events WHERE ${WINDOW} AND ${HUMAN} AND channel = 'ai'`,
  },
  {
    id: "ai.sources",
    label: "AI source breakdown",
    kind: "rows",
    unit: "count",
    sql: `SELECT source, COUNT(DISTINCT session_id) AS sessions
            FROM events WHERE ${WINDOW} AND ${HUMAN} AND channel = 'ai'
           GROUP BY source ORDER BY sessions DESC, source ASC`,
  },
  {
    id: "ai.landing_pages",
    label: "Landing pages for AI traffic",
    kind: "rows",
    unit: "count",
    sql: `SELECT path, COUNT(DISTINCT session_id) AS sessions
            FROM events WHERE ${WINDOW} AND ${HUMAN} AND channel = 'ai' AND type = 'pageview'
           GROUP BY path ORDER BY sessions DESC, path ASC LIMIT 10`,
  },
  {
    id: "ai.crawler.hits",
    label: "AI crawler requests (not human)",
    kind: "scalar",
    unit: "count",
    sql: `SELECT COUNT(*) AS value
            FROM events WHERE ${WINDOW} AND bot_kind = 'ai-crawler'`,
  },
  {
    id: "ai.crawler.pages",
    label: "Pages AI crawlers read",
    kind: "rows",
    unit: "count",
    sql: `SELECT path, bot_name, COUNT(*) AS hits
            FROM events WHERE ${WINDOW} AND bot_kind = 'ai-crawler'
           GROUP BY path, bot_name ORDER BY hits DESC, path ASC LIMIT 10`,
  },
  {
    id: "pages.top",
    label: "Top pages",
    kind: "rows",
    unit: "count",
    sql: `SELECT path, COUNT(*) AS views, COUNT(DISTINCT session_id) AS sessions
            FROM events WHERE ${WINDOW} AND ${HUMAN} AND type = 'pageview'
           GROUP BY path ORDER BY views DESC, path ASC LIMIT 10`,
  },
  {
    id: "referrers.top",
    label: "Top referrers",
    kind: "rows",
    unit: "count",
    sql: `SELECT referrer_host, COUNT(DISTINCT session_id) AS sessions
            FROM events WHERE ${WINDOW} AND ${HUMAN} AND referrer_host <> ''
           GROUP BY referrer_host ORDER BY sessions DESC, referrer_host ASC LIMIT 10`,
  },
  {
    id: "events.top",
    label: "Custom events",
    kind: "rows",
    unit: "count",
    sql: `SELECT name, COUNT(*) AS count
            FROM events WHERE ${WINDOW} AND ${HUMAN} AND type = 'event'
           GROUP BY name ORDER BY count DESC, name ASC LIMIT 15`,
  },
  {
    id: "devices.sessions",
    label: "Devices",
    kind: "rows",
    unit: "count",
    sql: `SELECT device, COUNT(DISTINCT session_id) AS sessions
            FROM events WHERE ${WINDOW} AND ${HUMAN}
           GROUP BY device ORDER BY sessions DESC, device ASC`,
  },
  {
    id: "browsers.sessions",
    label: "Browsers",
    kind: "rows",
    unit: "count",
    sql: `SELECT browser, COUNT(DISTINCT session_id) AS sessions
            FROM events WHERE ${WINDOW} AND ${HUMAN}
           GROUP BY browser ORDER BY sessions DESC, browser ASC LIMIT 10`,
  },
  {
    id: "os.sessions",
    label: "Operating systems",
    kind: "rows",
    unit: "count",
    sql: `SELECT os, COUNT(DISTINCT session_id) AS sessions
            FROM events WHERE ${WINDOW} AND ${HUMAN}
           GROUP BY os ORDER BY sessions DESC, os ASC LIMIT 10`,
  },
  {
    id: "screens.sessions",
    label: "Screen sizes",
    kind: "rows",
    unit: "count",
    sql: `SELECT screen, COUNT(DISTINCT session_id) AS sessions
            FROM events WHERE ${WINDOW} AND ${HUMAN} AND screen <> ''
           GROUP BY screen ORDER BY sessions DESC, screen ASC LIMIT 10`,
  },
  {
    id: "languages.sessions",
    label: "Languages",
    kind: "rows",
    unit: "count",
    sql: `SELECT lang, COUNT(DISTINCT session_id) AS sessions
            FROM events WHERE ${WINDOW} AND ${HUMAN} AND lang <> ''
           GROUP BY lang ORDER BY sessions DESC, lang ASC LIMIT 10`,
  },
  {
    // Country comes ONLY FROM A PROXY HEADER (Cloudflare/Vercel/Fly). We do not
    // bundle a GeoIP database: a 60+ MB file plus a monthly update burden breaks
    // the one-command-install promise. With no proxy in front, this table stays
    // empty and the dashboard says so plainly — silently showing the wrong
    // country is worse.
    id: "countries.sessions",
    label: "Countries",
    kind: "rows",
    unit: "count",
    sql: `SELECT country, COUNT(DISTINCT session_id) AS sessions
            FROM events WHERE ${WINDOW} AND ${HUMAN} AND country <> ''
           GROUP BY country ORDER BY sessions DESC, country ASC LIMIT 15`,
  },
  {
    id: "entry.pages",
    label: "Entry pages",
    kind: "rows",
    unit: "count",
    sql: `SELECT path, COUNT(*) AS sessions
            FROM (SELECT session_id, path, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts ASC, id ASC) AS rn
                    FROM events WHERE ${WINDOW} AND ${HUMAN} AND type = 'pageview')
           WHERE rn = 1 GROUP BY path ORDER BY sessions DESC, path ASC LIMIT 10`,
  },
  {
    id: "exit.pages",
    label: "Exit pages",
    kind: "rows",
    unit: "count",
    sql: `SELECT path, COUNT(*) AS sessions
            FROM (SELECT session_id, path, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts DESC, id DESC) AS rn
                    FROM events WHERE ${WINDOW} AND ${HUMAN} AND type = 'pageview')
           WHERE rn = 1 GROUP BY path ORDER BY sessions DESC, path ASC LIMIT 10`,
  },
  {
    id: "utm.campaigns",
    label: "UTM campaigns",
    kind: "rows",
    unit: "count",
    sql: `SELECT utm_source AS source, utm_medium AS medium, utm_campaign AS campaign,
                 COUNT(DISTINCT session_id) AS sessions
            FROM events
           WHERE ${WINDOW} AND ${HUMAN} AND (utm_source <> '' OR utm_campaign <> '')
           GROUP BY utm_source, utm_medium, utm_campaign
           ORDER BY sessions DESC, campaign ASC LIMIT 15`,
  },
  // ——— Automation signals (layer two) ———
  // Recorded, never self-applying. The dashboard shows what WOULD be excluded
  // and which rule fired, and excluding it is the operator's decision.
  {
    id: "bots.suspected",
    label: "Visitors with automation signals",
    kind: "scalar",
    unit: "count",
    // Predicate written out rather than composed from HUMAN on purpose: strict
    // mode rewrites every occurrence of HUMAN, which here would turn into
    // `bot_score < 5 AND bot_score >= 5` and report zero suspects forever.
    sql: `SELECT COUNT(DISTINCT visitor_id) AS value FROM events
           WHERE ${WINDOW} AND bot_score >= ${SUSPECT_SCORE}
             AND agent_trust = 'human' AND bot_kind = ''`,
  },
  {
    id: "bots.signal_rules",
    label: "Which signal fired",
    kind: "rows",
    unit: "count",
    sql: `SELECT bot_signals AS signals, bot_score AS score,
                 COUNT(*) AS events, COUNT(DISTINCT visitor_id) AS visitors
            FROM events
           WHERE ${WINDOW} AND bot_kind = '' AND bot_signals <> ''
           GROUP BY bot_signals, bot_score
           ORDER BY events DESC LIMIT 15`,
  },

  // ——— Agent sessions ———
  // The traffic class every other tool gets wrong: an agentic browser driving a
  // real session. Not dropped (an agent that checks out is revenue), not merged
  // with people (an agent that bounces is not a UX problem).
  {
    id: "agent.sessions",
    label: "Agent sessions",
    kind: "scalar",
    unit: "count",
    sql: `SELECT COUNT(DISTINCT session_id) AS value FROM events
           WHERE ${WINDOW} AND ${AGENT_SESSION}`,
  },
  {
    id: "agent.pageviews",
    label: "Pages read by agents",
    kind: "scalar",
    unit: "count",
    sql: `SELECT COUNT(*) AS value FROM events
           WHERE ${WINDOW} AND ${AGENT_SESSION} AND type = 'pageview'`,
  },
  {
    id: "agent.operators",
    label: "Who the agents belong to",
    kind: "rows",
    unit: "count",
    sql: `SELECT agent_signer AS operator,
                 COUNT(DISTINCT session_id) AS sessions,
                 COUNT(*) AS events
            FROM events
           WHERE ${WINDOW} AND ${AGENT_SESSION}
           GROUP BY agent_signer ORDER BY sessions DESC LIMIT 10`,
  },
  {
    id: "agent.pages",
    label: "Pages agents visit",
    kind: "rows",
    unit: "count",
    sql: `SELECT path, COUNT(*) AS views, COUNT(DISTINCT session_id) AS sessions
            FROM events
           WHERE ${WINDOW} AND ${AGENT_SESSION} AND type = 'pageview'
           GROUP BY path ORDER BY views DESC LIMIT 10`,
  },
  {
    id: "agent.events",
    label: "What agents did",
    kind: "rows",
    unit: "count",
    sql: `SELECT name, COUNT(*) AS count
            FROM events
           WHERE ${WINDOW} AND ${AGENT_SESSION} AND type = 'event'
           GROUP BY name ORDER BY count DESC LIMIT 10`,
  },

  // ——— Verified agent identity ———
  // Every other tool in this category reports "GPTBot read 4,120 pages" when
  // what it knows is "4,120 requests said they were GPTBot". These two metrics
  // keep those apart, because the difference is the product.
  {
    id: "agents.verified",
    label: "Verified agent requests",
    kind: "scalar",
    unit: "count",
    sql: `SELECT COUNT(*) AS value FROM events
           WHERE ${WINDOW} AND agent_trust = 'verified'`,
  },
  {
    id: "agents.claimed",
    label: "Self-declared bot requests",
    kind: "scalar",
    unit: "count",
    sql: `SELECT COUNT(*) AS value FROM events
           WHERE ${WINDOW} AND agent_trust = 'claimed'`,
  },
  {
    id: "agents.by_signer",
    label: "Agents that proved who they are",
    kind: "rows",
    unit: "count",
    sql: `SELECT agent_signer AS signer, bot_name AS agent, COUNT(*) AS hits,
                 COUNT(DISTINCT path) AS pages
            FROM events
           WHERE ${WINDOW} AND agent_trust = 'verified' AND agent_signer <> ''
           GROUP BY agent_signer, bot_name
           ORDER BY hits DESC LIMIT 15`,
  },
  {
    id: "agents.unverified_bots",
    label: "Bots we could not verify",
    kind: "rows",
    unit: "count",
    sql: `SELECT bot_name AS agent, bot_kind AS kind, COUNT(*) AS hits
            FROM events
           WHERE ${WINDOW} AND agent_trust = 'claimed'
           GROUP BY bot_name, bot_kind
           ORDER BY hits DESC LIMIT 15`,
  },

  // ——— Core Web Vitals ———
  // p75, NOT the average: in web performance a handful of slow visits drags the
  // mean around and manufactures a "nothing is wrong" illusion. Google's own
  // thresholds are defined on p75 too.
  {
    id: "vitals.p75",
    label: "Core Web Vitals (p75)",
    kind: "rows",
    unit: "count",
    sql: `SELECT
            ROUND(MAX(CASE WHEN rn_lcp = target_lcp THEN lcp END), 0) AS lcp,
            ROUND(MAX(CASE WHEN rn_inp = target_inp THEN inp END), 0) AS inp,
            ROUND(MAX(CASE WHEN rn_cls = target_cls THEN cls END), 3) AS cls
          FROM (
            SELECT lcp, inp, cls,
                   ROW_NUMBER() OVER (ORDER BY lcp) AS rn_lcp,
                   ROW_NUMBER() OVER (ORDER BY inp) AS rn_inp,
                   ROW_NUMBER() OVER (ORDER BY cls) AS rn_cls,
                   CAST(0.75 * COUNT(*) OVER () AS INTEGER) + 1 AS target_lcp,
                   CAST(0.75 * COUNT(*) OVER () AS INTEGER) + 1 AS target_inp,
                   CAST(0.75 * COUNT(*) OVER () AS INTEGER) + 1 AS target_cls
              FROM (SELECT
                      CAST(json_extract(props,'$.lcp') AS REAL) AS lcp,
                      CAST(json_extract(props,'$.inp') AS REAL) AS inp,
                      CAST(json_extract(props,'$.cls') AS REAL) AS cls
                    FROM events
                   WHERE ${WINDOW} AND ${HUMAN} AND name = 'web_vitals')
             WHERE lcp IS NOT NULL)`,
  },
  {
    id: "vitals.slow_pages",
    label: "Slowest pages (mean LCP)",
    kind: "rows",
    unit: "count",
    sql: `SELECT path,
                 ROUND(AVG(CAST(json_extract(props,'$.lcp') AS REAL)), 0) AS lcp,
                 COUNT(*) AS samples
            FROM events
           WHERE ${WINDOW} AND ${HUMAN} AND name = 'web_vitals'
             AND json_extract(props,'$.lcp') IS NOT NULL
           GROUP BY path HAVING samples >= 3
           ORDER BY lcp DESC, path ASC LIMIT 10`,
  },

  // ——— Error tracking ———
  {
    id: "errors.total",
    label: "JavaScript errors",
    kind: "scalar",
    unit: "count",
    sql: `SELECT COUNT(*) AS value FROM events WHERE ${WINDOW} AND ${HUMAN} AND name = 'error'`,
  },
  {
    id: "errors.top",
    label: "Most frequent errors",
    kind: "rows",
    unit: "count",
    sql: `SELECT json_extract(props,'$.message') AS message,
                 json_extract(props,'$.path') AS path,
                 COUNT(*) AS hits,
                 COUNT(DISTINCT session_id) AS sessions
            FROM events
           WHERE ${WINDOW} AND ${HUMAN} AND name = 'error'
           GROUP BY message, path ORDER BY hits DESC LIMIT 10`,
  },
  {
    id: "errors.browsers",
    label: "Browsers where errors occur",
    kind: "rows",
    unit: "count",
    sql: `SELECT browser, os, COUNT(*) AS hits
            FROM events WHERE ${WINDOW} AND ${HUMAN} AND name = 'error'
           GROUP BY browser, os ORDER BY hits DESC LIMIT 8`,
  },

  // — Specific to the landing-page vertical —
  {
    id: "cta.clicks",
    label: "CTA clicks",
    kind: "scalar",
    unit: "count",
    verticals: ["landing", "generic"],
    sql: `SELECT COUNT(*) AS value
            FROM events WHERE ${WINDOW} AND ${HUMAN} AND name = 'cta_click'`,
  },
  {
    id: "cta.conversion",
    label: "CTA click rate per session",
    kind: "scalar",
    unit: "percent",
    verticals: ["landing", "generic"],
    sql: `SELECT CASE WHEN s.sessions = 0 THEN 0
                 ELSE ROUND(100.0 * c.sessions / s.sessions, 1) END AS value
            FROM (SELECT COUNT(DISTINCT session_id) AS sessions FROM events WHERE ${WINDOW} AND ${HUMAN}) s,
                 (SELECT COUNT(DISTINCT session_id) AS sessions FROM events WHERE ${WINDOW} AND ${HUMAN} AND name = 'cta_click') c`,
  },
  {
    id: "form.abandon_fields",
    label: "Fields where forms are abandoned",
    kind: "rows",
    unit: "count",
    verticals: ["landing", "generic"],
    sql: `SELECT json_extract(props, '$.field') AS field, COUNT(*) AS abandons
            FROM events WHERE ${WINDOW} AND ${HUMAN} AND name = 'form_abandon'
           GROUP BY field ORDER BY abandons DESC, field ASC LIMIT 10`,
  },
  {
    id: "scroll.depth",
    label: "Average scroll depth (%)",
    kind: "scalar",
    unit: "percent",
    verticals: ["landing", "generic"],
    sql: `SELECT COALESCE(ROUND(AVG(CAST(json_extract(props, '$.percent') AS REAL)), 1), 0) AS value
            FROM events WHERE ${WINDOW} AND ${HUMAN} AND name = 'scroll'`,
  },
  {
    id: "rage.clicks",
    label: "Rage clicks",
    kind: "scalar",
    unit: "count",
    verticals: ["landing", "generic"],
    sql: `SELECT COUNT(*) AS value
            FROM events WHERE ${WINDOW} AND ${HUMAN} AND name = 'rage_click'`,
  },
  {
    id: "signups.total",
    label: "Signup / conversion events",
    kind: "scalar",
    unit: "count",
    verticals: ["landing", "generic"],
    sql: `SELECT COUNT(*) AS value
            FROM events WHERE ${WINDOW} AND ${HUMAN} AND name IN ('signup', 'waitlist', 'conversion')`,
  },
  {
    id: "signups.by_channel",
    label: "Signups by channel",
    kind: "rows",
    unit: "count",
    verticals: ["landing", "generic"],
    sql: `SELECT channel, COUNT(*) AS signups
            FROM events WHERE ${WINDOW} AND ${HUMAN} AND name IN ('signup', 'waitlist', 'conversion')
           GROUP BY channel ORDER BY signups DESC, channel ASC`,
  },
];

export function metricsFor(vertical: "landing" | "shopify" | "generic"): MetricDef[] {
  return METRICS.filter((m) => !m.verticals || m.verticals.includes(vertical));
}

export function metricById(id: string): MetricDef | undefined {
  return METRICS.find((m) => m.id === id);
}
