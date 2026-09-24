// packages/core/src/metrics/explore.ts
// The "look at individual things" reports: sessions, users, one event's
// properties, one error's occurrences, journeys, goals, filter suggestions.
//
// Same contract as the metric bundle, applied to lists: every function returns
// the SQL it ran and the parameters it bound (a `Query`), and the dashboard's
// evidence panel shows exactly that. Dashboard filters are compiled into the
// SQL with the same `applyFilters` every metric uses — no list is ever narrowed
// in the browser.
//
// What these deliberately do NOT do:
//   * No raw user ids. `identity` is the one-way hash from visitor.ts; a site
//     that wants a readable name for a person sends it as a trait, knowingly.
//   * No stack traces. The tracker never sends one (see tracker.ts); an error
//     group is message + file + line.
//   * No cross-day anonymous history. An anonymous visitor id rotates daily, so
//     the "visitors" list is per-day and says so.
//
// Ordering: events are ordered by `ts`, and ties by `rowid` — insertion order.
// Two events of one session in the same millisecond are common (a pageview
// and the event it triggered), and breaking the tie on the random event id
// shuffled timelines and entry pages from one run to the next.

import { applyFilters, filterValues, isPropField, resolvePatternFilters, FilterError, type Filter } from "./filters.ts";
import { HUMAN } from "./queries.ts";

export type Select = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

/** The evidence for a list: the query that ran, its parameters, its rows. */
export interface Query<T = Record<string, unknown>> {
  label: string;
  sql: string;
  params: unknown[];
  rows: T[];
}

export interface Scope {
  siteId: string;
  from: number;
  to: number;
  filters?: readonly Filter[];
}

async function run<T>(select: Select, label: string, sql: string, params: unknown[]): Promise<Query<T>> {
  const slots = (sql.match(/\?/g) ?? []).length;
  if (slots !== params.length) {
    // A misaligned parameter list binds a value to the wrong column and returns
    // a plausible wrong answer. Fail loudly instead.
    throw new Error(`${label}: ${slots} placeholders but ${params.length} parameters`);
  }
  return { label, sql, params, rows: await select<T>(sql, params) };
}

/** Filters with any regex already expanded. */
async function prepared(select: Select, s: Scope): Promise<Filter[]> {
  return resolvePatternFilters(select, s.siteId, s.filters ?? []);
}

/** HUMAN with every column qualified by an alias — needed wherever a join adds columns. */
function humanAs(alias: string): string {
  return HUMAN.replace(/\b(bot_kind|agent_trust)\b/g, `${alias}.$1`);
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

// ——— Sessions ———

export interface SessionRow {
  session_id: string;
  visitor_id: string;
  identity: string;
  started: number;
  ended: number;
  duration: number;
  pageviews: number;
  events: number;
  country: string;
  browser: string;
  os: string;
  device: string;
  screen: string;
  lang: string;
  channel: string;
  source: string;
  referrer_host: string;
  entry_page: string | null;
  exit_page: string | null;
}

export interface SessionListOptions extends Scope {
  limit?: number;
  offset?: number;
  /** Only sessions of this identified user (the identity hash). */
  identity?: string;
  /** Only sessions of this anonymous visitor id (valid for one day). */
  visitor?: string;
}

/**
 * Sessions, most recent first.
 *
 * Filters SELECT sessions; they do not trim them. "Sessions that viewed
 * /pricing" should show each of those sessions whole — its entry page, its
 * length, its other pages — not a session cut down to its /pricing rows. So
 * the filtered window picks session ids, and the aggregates are computed over
 * every event of those sessions.
 */
export async function listSessions(select: Select, o: SessionListOptions): Promise<{ total: Query<{ n: number }>; list: Query<SessionRow> }> {
  const filters = await prepared(select, o);
  const limit = clampInt(o.limit, 1, 200, 50);
  const offset = clampInt(o.offset, 0, 1_000_000, 0);
  const extra: string[] = [];
  const extraParams: unknown[] = [];
  if (o.identity) {
    extra.push("AND identity = ?");
    extraParams.push(o.identity);
  }
  if (o.visitor) {
    extra.push("AND visitor_id = ?");
    extraParams.push(o.visitor);
  }
  const matched = applyFilters(
    `SELECT DISTINCT session_id FROM events
      WHERE site_id = ? AND ts >= ? AND ts < ? AND ${HUMAN} ${extra.join(" ")}`,
    filters
  );
  const matchedParams = [o.siteId, o.from, o.to, ...filterValues(filters, o.siteId), ...extraParams];

  const total = await run<{ n: number }>(select, "Sessions in range", `SELECT COUNT(*) AS n FROM (${matched})`, matchedParams);

  const sql = `WITH matched AS (${matched}),
     s AS (SELECT session_id, MIN(ts) AS started, MAX(ts) AS ended,
                  CAST((MAX(ts) - MIN(ts)) / 1000 AS INTEGER) AS duration,
                  COUNT(*) FILTER (WHERE type = 'pageview') AS pageviews,
                  COUNT(*) FILTER (WHERE type = 'event') AS events,
                  MAX(identity) AS identity
             FROM events
            WHERE site_id = ? AND session_id IN (SELECT session_id FROM matched)
            GROUP BY session_id
            ORDER BY started DESC LIMIT ? OFFSET ?),
     firsts AS (SELECT session_id, visitor_id, country, browser, os, device, screen, lang, channel, source, referrer_host,
                       ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts ASC, rowid ASC) AS rn
                  FROM events WHERE site_id = ? AND session_id IN (SELECT session_id FROM s)),
     pv AS (SELECT session_id, path,
                   ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts ASC, rowid ASC) AS a,
                   ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts DESC, rowid DESC) AS z
              FROM events WHERE site_id = ? AND type = 'pageview' AND session_id IN (SELECT session_id FROM s))
SELECT s.session_id, f.visitor_id, s.identity, s.started, s.ended, s.duration, s.pageviews, s.events,
       f.country, f.browser, f.os, f.device, f.screen, f.lang, f.channel, f.source, f.referrer_host,
       (SELECT path FROM pv WHERE pv.session_id = s.session_id AND pv.a = 1) AS entry_page,
       (SELECT path FROM pv WHERE pv.session_id = s.session_id AND pv.z = 1) AS exit_page
  FROM s JOIN firsts f ON f.session_id = s.session_id AND f.rn = 1
 ORDER BY s.started DESC`;
  const params = [...matchedParams, o.siteId, limit, offset, o.siteId, o.siteId];
  const list = await run<SessionRow>(select, "Sessions", sql, params);
  return { total, list };
}

export interface SessionEvent {
  id: string;
  ts: number;
  type: "pageview" | "event";
  name: string;
  path: string;
  query: string;
  title: string;
  hostname: string;
  referrer_host: string;
  channel: string;
  source: string;
  props: string;
  country: string;
  browser: string;
  os: string;
  device: string;
  screen: string;
  lang: string;
  identity: string;
  visitor_id: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
}

/** Every event of one session, in order. Bounded to the site: a session id from another site returns nothing. */
export async function sessionTimeline(select: Select, siteId: string, sessionId: string): Promise<Query<SessionEvent>> {
  return run<SessionEvent>(
    select,
    "Session timeline",
    `SELECT id, ts, type, name, path, query, title, hostname, referrer_host, channel, source, props,
            country, browser, os, device, screen, lang, identity, visitor_id,
            utm_source, utm_medium, utm_campaign
       FROM events
      WHERE site_id = ? AND session_id = ?
      ORDER BY ts ASC, rowid ASC LIMIT 2000`,
    [siteId, sessionId]
  );
}

// ——— Users ———

export interface UserRow {
  /** The one-way identity hash, or — for anonymous visitors — the daily visitor id. */
  id: string;
  sessions: number;
  pageviews: number;
  events: number;
  first_seen: number;
  last_seen: number;
  country: string;
  device: string;
  browser: string;
  os: string;
}

export interface UserListOptions extends Scope {
  limit?: number;
  offset?: number;
  /**
   * "identified" — people the site named with identify(); stable across days.
   * "anonymous"  — daily visitor ids. The same person on two days is two rows,
   *                and the dashboard says so next to the list.
   */
  kind?: "identified" | "anonymous";
}

export async function listUsers(select: Select, o: UserListOptions): Promise<{ total: Query<{ n: number }>; list: Query<UserRow> }> {
  const filters = await prepared(select, o);
  const limit = clampInt(o.limit, 1, 200, 50);
  const offset = clampInt(o.offset, 0, 1_000_000, 0);
  const key = o.kind === "anonymous" ? "visitor_id" : "identity";
  const who = o.kind === "anonymous" ? "identity = ''" : "identity <> ''";
  const base = applyFilters(
    `SELECT * FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND ${HUMAN} AND ${who}`,
    filters
  );
  const baseParams = [o.siteId, o.from, o.to, ...filterValues(filters, o.siteId)];

  const total = await run<{ n: number }>(
    select,
    o.kind === "anonymous" ? "Anonymous visitors (daily ids)" : "Identified users",
    `SELECT COUNT(DISTINCT ${key}) AS n FROM (${base})`,
    baseParams
  );
  const sql = `WITH ev AS (${base}),
     u AS (SELECT ${key} AS uid, COUNT(DISTINCT session_id) AS sessions,
                  COUNT(*) FILTER (WHERE type = 'pageview') AS pageviews,
                  COUNT(*) FILTER (WHERE type = 'event') AS events,
                  MIN(ts) AS first_seen, MAX(ts) AS last_seen
             FROM ev GROUP BY ${key} ORDER BY last_seen DESC LIMIT ? OFFSET ?),
     latest AS (SELECT ${key} AS lid, country, device, browser, os,
                       ROW_NUMBER() OVER (PARTITION BY ${key} ORDER BY ts DESC, id DESC) AS rn
                  FROM ev WHERE ${key} IN (SELECT uid FROM u))
SELECT u.uid AS id, u.sessions, u.pageviews, u.events, u.first_seen, u.last_seen,
       l.country, l.device, l.browser, l.os
  FROM u JOIN latest l ON l.lid = u.uid AND l.rn = 1
 ORDER BY u.last_seen DESC`;
  const list = await run<UserRow>(select, "Users", sql, [...baseParams, limit, offset]);
  return { total, list };
}

export interface UserProfile {
  summary: Query<{ sessions: number; pageviews: number; events: number; first_seen: number | null; last_seen: number | null }>;
  traits: Query<{ ts: number; props: string }>;
  /** Latest value of each trait, newest identify() wins. Internal keys (leading "_") are left out. */
  merged: Record<string, string | number | boolean | null>;
}

/**
 * One identified user, all time. `identity` is the hash; the raw id was never
 * stored and cannot be shown. Traits are whatever the site passed to
 * `vitrus.identify(id, traits)` — stored as sent, which is why the docs tell
 * site owners not to put anything there their privacy notice does not cover.
 */
export async function userProfile(select: Select, siteId: string, identity: string): Promise<UserProfile> {
  const summary = await run<{ sessions: number; pageviews: number; events: number; first_seen: number | null; last_seen: number | null }>(
    select,
    "User summary",
    `SELECT COUNT(DISTINCT session_id) AS sessions,
            COUNT(*) FILTER (WHERE type = 'pageview') AS pageviews,
            COUNT(*) FILTER (WHERE type = 'event') AS events,
            MIN(ts) AS first_seen, MAX(ts) AS last_seen
       FROM events WHERE site_id = ? AND identity = ? AND ${HUMAN}`,
    [siteId, identity]
  );
  const traits = await run<{ ts: number; props: string }>(
    select,
    "User traits",
    `SELECT ts, props FROM events
      WHERE site_id = ? AND identity = ? AND name = 'identify'
      ORDER BY ts DESC LIMIT 50`,
    [siteId, identity]
  );
  const merged: UserProfile["merged"] = {};
  // Oldest first, so the newest value of each key is the one left standing.
  for (const row of [...traits.rows].reverse()) {
    let p: Record<string, unknown> = {};
    try {
      p = JSON.parse(row.props) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const [k, v] of Object.entries(p)) {
      if (k.startsWith("_")) continue;
      if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") merged[k] = v;
    }
  }
  return { summary, traits, merged };
}

// ——— One custom event ———

export interface EventDetailOptions extends Scope {
  name: string;
  bucketMs: number;
}

export interface EventDetail {
  properties: Query<{ key: string; value: string | null; count: number; sessions: number }>;
  series: Query<{ bucket: number; count: number; sessions: number }>;
  log: Query<{ ts: number; path: string; session_id: string; props: string; country: string; browser: string; os: string; device: string }>;
}

/**
 * Properties, trend and recent occurrences of one event name.
 *
 * Property keys starting with "_" are internal (the ingest pipeline records
 * `_signal`) and are left out of the breakdown — they are not something the
 * site sent.
 */
export async function eventDetail(select: Select, o: EventDetailOptions): Promise<EventDetail> {
  const filters = await prepared(select, o);
  const fv = filterValues(filters, o.siteId);
  const bucketMs = Math.max(60_000, Math.round(o.bucketMs));

  const properties = await run<{ key: string; value: string | null; count: number; sessions: number }>(
    select,
    `Properties of "${o.name}"`,
    applyFilters(
      `SELECT j.key AS key, CAST(j.value AS TEXT) AS value, COUNT(*) AS count, COUNT(DISTINCT e.session_id) AS sessions
         FROM events e, json_each(e.props) j
        WHERE e.site_id = ? AND e.ts >= ? AND e.ts < ? AND ${humanAs("e")} AND e.type = 'event' AND e.name = ?
          AND substr(j.key, 1, 1) <> '_'
        GROUP BY j.key, j.value ORDER BY j.key ASC, count DESC, value ASC LIMIT 500`,
      filters
    ),
    [o.siteId, o.from, o.to, ...fv, o.name]
  );
  const series = await run<{ bucket: number; count: number; sessions: number }>(
    select,
    `"${o.name}" over time`,
    applyFilters(
      `SELECT CAST((ts - ?) / ? AS INTEGER) AS bucket, COUNT(*) AS count, COUNT(DISTINCT session_id) AS sessions
         FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND ${HUMAN} AND type = 'event' AND name = ?
        GROUP BY bucket ORDER BY bucket ASC`,
      filters
    ),
    [o.from, bucketMs, o.siteId, o.from, o.to, ...fv, o.name]
  );
  const log = await run<{ ts: number; path: string; session_id: string; props: string; country: string; browser: string; os: string; device: string }>(
    select,
    `Recent "${o.name}" events`,
    applyFilters(
      `SELECT ts, path, session_id, props, country, browser, os, device
         FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND ${HUMAN} AND type = 'event' AND name = ?
        ORDER BY ts DESC LIMIT 100`,
      filters
    ),
    [o.siteId, o.from, o.to, ...fv, o.name]
  );
  return { properties, series, log };
}

// ——— One error group ———

export interface ErrorOccurrenceOptions extends Scope {
  message: string | null;
  source: string | null;
  line: number | null;
}

/** Individual occurrences of one error group (message + file + line), newest first. */
export async function errorOccurrences(
  select: Select,
  o: ErrorOccurrenceOptions
): Promise<Query<{ ts: number; path: string; session_id: string; browser: string; os: string; device: string; country: string }>> {
  const filters = await prepared(select, o);
  return run(
    select,
    "Error occurrences",
    applyFilters(
      `SELECT ts, path, session_id, browser, os, device, country
         FROM events
        WHERE site_id = ? AND ts >= ? AND ts < ? AND ${HUMAN} AND name = 'error'
          AND json_extract(props, '$.message') IS ? AND json_extract(props, '$.source') IS ?
          AND json_extract(props, '$.line') IS ?
        ORDER BY ts DESC LIMIT 200`,
      filters
    ),
    [o.siteId, o.from, o.to, ...filterValues(filters, o.siteId), o.message, o.source, o.line]
  );
}

// ——— Journeys ———

export const MAX_JOURNEY_STEPS = 8;
export const MAX_JOURNEYS = 100;

export interface JourneyOptions extends Scope {
  /** How many pages deep (2–8). */
  steps?: number;
  /** How many distinct journeys to return (1–100), most common first. */
  limit?: number;
  /**
   * Per-step constraints, index = step. `null`/"" = any page. A value with `*`
   * is a wildcard (`*` = any characters); otherwise an exact path.
   */
  stepFilters?: (string | null)[];
}

export interface JourneyResult extends Query<Record<string, string | number | null>> {
  steps: number;
  /** Sessions with at least one pageview in the window (the base for percentages). */
  totalSessions: number;
}

/**
 * The page paths sessions take, as whole journeys.
 *
 * A journey is the session's pageviews in order with CONSECUTIVE repeats
 * collapsed — a reload of /pricing is not a step from /pricing to /pricing.
 * Sessions shorter than `steps` end early (their later columns are NULL); they
 * are kept, because "left after two pages" is part of the picture. The SQL
 * returns one row per distinct journey with its session count; the dashboard
 * draws the Sankey from exactly these rows.
 */
export async function computeJourneys(select: Select, o: JourneyOptions): Promise<JourneyResult> {
  const filters = await prepared(select, o);
  const steps = clampInt(o.steps, 2, MAX_JOURNEY_STEPS, 4);
  const limit = clampInt(o.limit, 1, MAX_JOURNEYS, 20);
  const cols = Array.from({ length: steps }, (_, i) => `p${i + 1}`);

  const where: string[] = [];
  const whereParams: unknown[] = [];
  (o.stepFilters ?? []).slice(0, steps).forEach((raw, i) => {
    const v = String(raw ?? "").trim();
    if (!v) return;
    if (v.length > 200) throw new FilterError(`step ${i + 1} filter is too long`);
    if (v.includes("*")) {
      where.push(`p${i + 1} LIKE ? ESCAPE '\\'`);
      whereParams.push(v.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, "%"));
    } else {
      where.push(`p${i + 1} = ?`);
      whereParams.push(v);
    }
  });

  const base = applyFilters(
    `SELECT session_id, path, ts, rowid AS rid,
            LAG(path) OVER (PARTITION BY session_id ORDER BY ts ASC, rowid ASC) AS prev
       FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND ${HUMAN} AND type = 'pageview'`,
    filters
  );
  const baseParams = [o.siteId, o.from, o.to, ...filterValues(filters, o.siteId)];

  const sql = `WITH pv AS (${base}),
     steps AS (SELECT session_id, path, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts ASC, rid ASC) AS rn
                 FROM pv WHERE prev IS NULL OR prev <> path),
     j AS (SELECT session_id, ${cols.map((c, i) => `MAX(CASE WHEN rn = ${i + 1} THEN path END) AS ${c}`).join(", ")}
             FROM steps WHERE rn <= ${steps} GROUP BY session_id)
SELECT ${cols.join(", ")}, COUNT(*) AS sessions
  FROM j${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
 GROUP BY ${cols.join(", ")}
 ORDER BY sessions DESC, ${cols.join(", ")} LIMIT ${limit}`;

  // `steps` and `limit` are clamped integers, the only values written into the
  // SQL text; every path is a bound parameter.
  const q = await run<Record<string, string | number | null>>(select, "Journeys", sql, [...baseParams, ...whereParams]);
  const tot = await select<{ n: number }>(
    `SELECT COUNT(DISTINCT session_id) AS n FROM (${base})`,
    baseParams
  );
  return { ...q, steps, totalSessions: Number(tot[0]?.n ?? 0) };
}

// ——— Goals ———

export interface Goal {
  id?: string;
  name: string;
  /** "page" = a pageview matching a path pattern; "event" = a custom event by name. */
  type: "page" | "event";
  /** Path pattern (`*` = one segment, `**` = the rest) or event name. */
  value: string;
  /** Optional: only count events whose property `propKey` equals `propValue`. */
  propKey?: string;
  propValue?: string;
}

export class GoalError extends Error {}

export function validateGoal(g: Partial<Goal>): Goal {
  const type = g.type === "event" ? "event" : g.type === "page" ? "page" : null;
  if (!type) throw new GoalError(`goal type must be "page" or "event"`);
  const value = String(g.value ?? "").trim();
  if (!value) throw new GoalError("a goal needs a value");
  if (value.length > 200) throw new GoalError("goal value is too long");
  if (type === "page" && !value.startsWith("/")) throw new GoalError("a page goal is a path starting with /");
  const name = (String(g.name ?? "").trim() || value).slice(0, 80);
  const out: Goal = { name, type, value };
  if (g.id) out.id = String(g.id);
  const key = String(g.propKey ?? "").trim();
  if (key) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(key)) throw new GoalError("property name may use letters, digits, _ and -");
    out.propKey = key;
    out.propValue = String(g.propValue ?? "").slice(0, 200);
  }
  return out;
}

/** `/blog/*` → a regex. `*` = one segment, `**` = the rest of the path. Built by hand; no user regex. */
export function pathPatternRegex(pattern: string): RegExp {
  const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  let out = "^";
  const parts = pattern.split("**");
  parts.forEach((part, i) => {
    out += part.split("*").map(esc).join("[^/]*");
    if (i < parts.length - 1) out += ".*";
  });
  return new RegExp(out + "$");
}

export interface GoalResult {
  goal: Goal;
  conversions: number;
  sessions: number;
  rate: number;
  /** For wildcard page goals: the paths the pattern matched (bound in the query). */
  matchedPaths?: string[];
  evidence: Query<{ conversions: number; sessions: number; rate: number | null }>;
}

/**
 * Conversions = distinct sessions that reached the goal; rate = conversions /
 * all sessions in the window. Both come out of ONE query, so the rate on the
 * card is the division the evidence shows. A wildcard page goal is expanded to
 * the concrete paths it matches, which are then bound — the evidence lists them.
 */
export async function computeGoal(select: Select, o: Scope & { goal: Goal }): Promise<GoalResult> {
  const g = validateGoal(o.goal);
  const filters = await prepared(select, o);
  const fv = filterValues(filters, o.siteId);
  let cond: string;
  let condParams: unknown[];
  let matchedPaths: string[] | undefined;

  if (g.type === "page") {
    if (g.value.includes("*")) {
      const re = pathPatternRegex(g.value);
      const rows = await select<{ path: string }>(
        `SELECT DISTINCT path FROM events WHERE site_id = ? AND type = 'pageview' LIMIT 20001`,
        [o.siteId]
      );
      if (rows.length > 20_000) throw new GoalError("too many distinct pages to match a wildcard goal against");
      matchedPaths = rows.map((r) => r.path).filter((p) => re.test(p)).sort();
      cond = `type = 'pageview' AND path IN (${matchedPaths.map(() => "?").join(", ")})`;
      condParams = matchedPaths;
    } else {
      cond = `type = 'pageview' AND path = ?`;
      condParams = [g.value];
    }
  } else {
    cond = `type = 'event' AND name = ?`;
    condParams = [g.value];
    if (g.propKey) {
      cond += ` AND CAST(json_extract(props, ?) AS TEXT) = ?`;
      condParams.push(`$."${g.propKey}"`, g.propValue ?? "");
    }
  }

  const sql = applyFilters(
    `SELECT c.conversions, t.sessions,
            ROUND(100.0 * c.conversions / NULLIF(t.sessions, 0), 1) AS rate
       FROM (SELECT COUNT(DISTINCT session_id) AS conversions FROM events
              WHERE site_id = ? AND ts >= ? AND ts < ? AND ${HUMAN} AND ${cond}) c,
            (SELECT COUNT(DISTINCT session_id) AS sessions FROM events
              WHERE site_id = ? AND ts >= ? AND ts < ? AND ${HUMAN}) t`,
    filters
  );
  const params = [o.siteId, o.from, o.to, ...fv, ...condParams, o.siteId, o.from, o.to, ...fv];
  const evidence = await run<{ conversions: number; sessions: number; rate: number | null }>(select, `Goal: ${g.name}`, sql, params);
  const row = evidence.rows[0];
  const out: GoalResult = {
    goal: g,
    conversions: Number(row?.conversions ?? 0),
    sessions: Number(row?.sessions ?? 0),
    rate: Number(row?.rate ?? 0),
    evidence,
  };
  if (matchedPaths) out.matchedPaths = matchedPaths;
  return out;
}

// ——— Filter suggestions ———

const SUGGEST_COLUMN: Readonly<Record<string, { col: string; where?: string }>> = {
  country: { col: "country" },
  region: { col: "region" },
  city: { col: "city" },
  device: { col: "device" },
  browser: { col: "browser" },
  os: { col: "os" },
  channel: { col: "channel" },
  source: { col: "source" },
  lang: { col: "lang" },
  path: { col: "path", where: "type = 'pageview'" },
  title: { col: "title", where: "type = 'pageview'" },
  hostname: { col: "hostname" },
  query: { col: "query" },
  referrer_host: { col: "referrer_host" },
  utm_source: { col: "utm_source" },
  utm_medium: { col: "utm_medium" },
  utm_campaign: { col: "utm_campaign" },
  utm_term: { col: "utm_term" },
  utm_content: { col: "utm_content" },
  screen: { col: "screen" },
  tag: { col: "tag" },
  event: { col: "name", where: "type = 'event'" },
  entry_page: { col: "path", where: "type = 'pageview'" },
  exit_page: { col: "path", where: "type = 'pageview'" },
};

/** Values seen for a field in the window, most common first — for the filter builder's autocomplete. */
export async function filterSuggestions(
  select: Select,
  o: { siteId: string; from: number; to: number; field: string; q?: string }
): Promise<Query<{ value: string; sessions: number }>> {
  const q = String(o.q ?? "").slice(0, 100);
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  if (isPropField(o.field)) {
    const path = `$."${o.field.slice(5)}"`;
    return run(
      select,
      `Values of ${o.field}`,
      `SELECT CAST(json_extract(props, ?) AS TEXT) AS value, COUNT(DISTINCT session_id) AS sessions
         FROM events
        WHERE site_id = ? AND ts >= ? AND ts < ? AND ${HUMAN} AND type = 'event'
          AND json_extract(props, ?) IS NOT NULL AND CAST(json_extract(props, ?) AS TEXT) LIKE ? ESCAPE '\\'
        GROUP BY value ORDER BY sessions DESC, value ASC LIMIT 50`,
      [path, o.siteId, o.from, o.to, path, path, like]
    );
  }
  const spec = SUGGEST_COLUMN[o.field];
  if (!spec) throw new FilterError(`cannot filter on "${o.field}"`);
  return run(
    select,
    `Values of ${o.field}`,
    `SELECT ${spec.col} AS value, COUNT(DISTINCT session_id) AS sessions
       FROM events
      WHERE site_id = ? AND ts >= ? AND ts < ? AND ${HUMAN} AND ${spec.col} <> ''
        ${spec.where ? `AND ${spec.where}` : ""} AND ${spec.col} LIKE ? ESCAPE '\\'
      GROUP BY ${spec.col} ORDER BY sessions DESC, value ASC LIMIT 50`,
    [o.siteId, o.from, o.to, like]
  );
}
