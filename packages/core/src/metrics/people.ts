// packages/core/src/metrics/people.ts
// One app's signed-in users, one row each: status, actions, active days,
// visits, joined, last active — and, opened, their actions by day and their
// recent visits.
//
// ═══ A ROW IS A HASH, NOT A PERSON ═══
// What the server holds for a user is the identity hash (visitor.ts): no
// email, no name. This file returns that hash and counts about it. The
// dashboard shows each row under a stable made-up name derived from the hash
// ("Amber Falcon"), so a list is readable without anyone — including the
// site owner looking at it — learning who the person is.
//
// ═══ DEFINITIONS ═══
//   active day   a UTC day with at least one human event carrying the identity
//   visit        a session (30 minutes of inactivity ends one; visitor.ts)
//   action       a custom event the site sent, other than the automatic ones
//                the tracker sends on its own (scroll, web vitals, errors,
//                clicks…) and the lifecycle calls themselves (identify,
//                signup, login, logout, plan). A purchase IS an action.
//   status       returning       active on two or more days
//                one_time        one day, at least one action
//                signed_up_only  one day, no action
//
// All-time by design (since the oldest identified event on record): "has this
// person ever come back" is not a question a 7-day window answers. The result
// carries `dataFrom` so the page can say how far back it sees — activity from
// before Vitrus was installed, or before a retention period purged it, is not
// known and is never guessed.
//
// Everything that shapes the SQL is a constant here or an allow-listed sort;
// every value is a bound parameter.

import type { Query, Select } from "./explore.ts";
import { HUMAN } from "./queries.ts";

/** Events the tracker or the lifecycle API sends by itself: not "actions". */
export const NON_ACTIONS = [
  "pageview", "identify", "signup", "login", "logout", "plan", "renewal", "app_open",
  "scroll", "web_vitals", "error", "form_submit", "form_abandon",
  "outbound_click", "file_download", "rage_click", "cta_click",
] as const;
const NON_ACTION_SQL = `(${NON_ACTIONS.map((n) => `'${n}'`).join(", ")})`;
const IS_ACTION = `type = 'event' AND name NOT IN ${NON_ACTION_SQL}`;
const PLAN = `json_extract(props, '$.plan')`;

export const PEOPLE_SEGMENTS = ["all", "returning", "one_time", "signed_up_only"] as const;
export type PeopleSegment = (typeof PEOPLE_SEGMENTS)[number];
export const PEOPLE_SORTS = { last_active: "last_ts DESC", joined: "first_ts DESC", actions: "actions DESC", active_days: "days DESC", visits: "visits DESC" } as const;
export type PeopleSort = keyof typeof PEOPLE_SORTS;
export const PEOPLE_PAGE_MAX = 100;
const IDS_MAX = 200;
const DAY_MS = 86_400_000;

export class PeopleError extends Error {}

export interface PeopleOptions {
  siteId: string;
  now: number;
  segment?: string;
  sort?: string;
  /** Only people on this plan ("" = everyone). */
  plan?: string;
  /** Only these identity hashes — how the dashboard searches names it holds locally. */
  ids?: readonly string[];
  limit?: number;
  offset?: number;
}

export interface PersonRow {
  identity: string;
  /** A made-up, stable display name (aliasOf). Not the person's name: there is none here. */
  alias: string;
  status: "returning" | "one_time" | "signed_up_only";
  actions: number;
  days: number;
  visits: number;
  first_ts: number;
  last_ts: number;
  plan: string | null;
  /** Up to three most frequent actions: name → count. */
  top: { name: string; n: number }[];
}

export interface PeopleResult {
  summary: Query<{
    known: number; returning: number; returning_users?: number; one_time: number; signed_up_only: number;
    active_7d: number; active_30d: number; new_30d: number; new_30d_returned: number;
  }>;
  /** How many rows the current segment/plan/ids selection holds. */
  total: number;
  list: Query<Omit<PersonRow, "top">>;
  top: Query<{ identity: string; name: string; n: number }>;
  plans: Query<{ plan: string; users: number }>;
  /** Oldest identified event on record: the start of what is known. Null with no data. */
  dataFrom: number | null;
}

async function run<T>(select: Select, label: string, sql: string, params: unknown[]): Promise<Query<T>> {
  const slots = (sql.match(/\?/g) ?? []).length;
  if (slots !== params.length) throw new Error(`${label}: ${slots} placeholders but ${params.length} parameters`);
  return { label, sql, params, rows: await select<T>(sql, params) };
}

const n = (v: unknown): number => Number(v ?? 0) || 0;

const ADJ = [
  "Amber", "Azure", "Bold", "Brave", "Bright", "Calm", "Clever", "Coral", "Crisp", "Dapper", "Eager", "Fancy",
  "Gentle", "Golden", "Happy", "Hazel", "Indigo", "Jolly", "Keen", "Lively", "Lucky", "Mellow", "Misty", "Noble",
  "Olive", "Plucky", "Quiet", "Rapid", "Rosy", "Rustic", "Sandy", "Silver", "Sleek", "Snowy", "Sunny", "Swift",
  "Tidy", "Velvet", "Vivid", "Witty", "Zesty", "Breezy", "Cosmic", "Dusky", "Frosty", "Lunar", "Polar", "Solar",
] as const;
const ANIMAL = [
  "Falcon", "Otter", "Fox", "Heron", "Lynx", "Panda", "Badger", "Beaver", "Bison", "Crane", "Dolphin", "Eagle",
  "Ferret", "Gecko", "Hare", "Ibis", "Jaguar", "Koala", "Lemur", "Marten", "Newt", "Ocelot", "Owl", "Puffin",
  "Quail", "Raven", "Seal", "Swan", "Tapir", "Turtle", "Viper", "Walrus", "Wombat", "Yak", "Zebra", "Bear",
  "Robin", "Moth", "Whale", "Wolf", "Orca", "Kiwi", "Llama", "Mole", "Pelican", "Sparrow", "Stork", "Toucan",
] as const;

/**
 * A stable made-up name for an identity hash: "Amber Falcon · 3f9a2c".
 *
 * Read off the hash itself, so it is the same on every page and for every
 * member, and says nothing about the person: it cannot be turned back into
 * the hash, let alone into an id. Two people CAN share the two words (48 × 48
 * combinations), which is why the six hex characters follow them.
 */
export function aliasOf(identity: string): string {
  const a = Number.parseInt(identity.slice(0, 4), 16) || 0;
  const b = Number.parseInt(identity.slice(4, 8), 16) || 0;
  return `${ADJ[a % ADJ.length]} ${ANIMAL[b % ANIMAL.length]} · ${identity.slice(0, 6)}`;
}

const HASH = /^[0-9a-f]{32}$/;

function peopleCte(): string {
  // SQLite bare-column semantics: with MAX(CASE …) the `plan` is read from the
  // row holding the maximum — each person's latest plan (see lifecycle.ts).
  return `WITH ev AS (
  SELECT identity, ts, type, name, session_id, props FROM events
   WHERE site_id = ? AND identity <> '' AND ${HUMAN}
),
p AS (
  SELECT identity,
         MIN(ts) AS first_ts, MAX(ts) AS last_ts,
         COUNT(DISTINCT CAST(ts / 86400000 AS INTEGER)) AS days,
         COUNT(DISTINCT session_id) AS visits,
         SUM(CASE WHEN ${IS_ACTION} THEN 1 ELSE 0 END) AS actions
    FROM ev GROUP BY identity
),
pl AS (
  SELECT identity, ${PLAN} AS plan, MAX(ts) AS plan_ts FROM ev WHERE ${PLAN} IS NOT NULL GROUP BY identity
),
people AS (
  SELECT p.*, pl.plan,
         CASE WHEN p.days >= 2 THEN 'returning' WHEN p.actions > 0 THEN 'one_time' ELSE 'signed_up_only' END AS status
    FROM p LEFT JOIN pl ON pl.identity = p.identity
)`;
}

export async function listPeople(select: Select, o: PeopleOptions): Promise<PeopleResult> {
  const segment = (o.segment ?? "all") as PeopleSegment;
  if (!(PEOPLE_SEGMENTS as readonly string[]).includes(segment)) throw new PeopleError(`segment must be one of ${PEOPLE_SEGMENTS.join(", ")}`);
  const sortKey = (o.sort ?? "last_active") as PeopleSort;
  if (!(sortKey in PEOPLE_SORTS)) throw new PeopleError(`sort must be one of ${Object.keys(PEOPLE_SORTS).join(", ")}`);
  const ids = (o.ids ?? []).filter((x) => HASH.test(x)).slice(0, IDS_MAX);
  if (o.ids && o.ids.length && !ids.length) throw new PeopleError("ids must be identity hashes (32 hex characters)");
  const limit = Math.min(PEOPLE_PAGE_MAX, Math.max(1, Math.round(o.limit ?? 50)));
  const offset = Math.max(0, Math.round(o.offset ?? 0));
  const cte = peopleCte();

  const summary = await run<PeopleResult["summary"]["rows"][number]>(
    select,
    "users by status, active in the last 7 and 30 days, new in the last 30",
    `${cte}
SELECT COUNT(*) AS known,
       COALESCE(SUM(status = 'returning'), 0) AS returning_users,
       COALESCE(SUM(status = 'one_time'), 0) AS one_time,
       COALESCE(SUM(status = 'signed_up_only'), 0) AS signed_up_only,
       COALESCE(SUM(last_ts >= ?), 0) AS active_7d,
       COALESCE(SUM(last_ts >= ?), 0) AS active_30d,
       COALESCE(SUM(first_ts >= ?), 0) AS new_30d,
       COALESCE(SUM(first_ts >= ? AND days >= 2), 0) AS new_30d_returned
  FROM people`,
    [o.siteId, o.now - 7 * DAY_MS, o.now - 30 * DAY_MS, o.now - 30 * DAY_MS, o.now - 30 * DAY_MS]
  );
  const s = summary.rows[0];
  summary.rows = [{
    known: n(s?.known), returning: n(s?.returning_users), one_time: n(s?.one_time), signed_up_only: n(s?.signed_up_only),
    active_7d: n(s?.active_7d), active_30d: n(s?.active_30d), new_30d: n(s?.new_30d), new_30d_returned: n(s?.new_30d_returned),
  }];

  const where: string[] = [];
  const wp: unknown[] = [];
  if (segment !== "all") { where.push("status = ?"); wp.push(segment); }
  if (o.plan) { where.push("plan = ?"); wp.push(String(o.plan).toLowerCase()); }
  if (ids.length) { where.push(`identity IN (${ids.map(() => "?").join(", ")})`); wp.push(...ids); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const count = await select<{ n: number }>(`${cte}\nSELECT COUNT(*) AS n FROM people ${w}`, [o.siteId, ...wp]);
  const list = await run<Omit<PersonRow, "top">>(
    select,
    "users, one row each",
    `${cte}
SELECT identity, status, actions, days, visits, first_ts, last_ts, plan
  FROM people ${w}
 ORDER BY ${PEOPLE_SORTS[sortKey]}, identity ASC
 LIMIT ? OFFSET ?`,
    [o.siteId, ...wp, limit, offset]
  );
  for (const r of list.rows) {
    r.actions = n(r.actions); r.days = n(r.days); r.visits = n(r.visits);
    r.first_ts = n(r.first_ts); r.last_ts = n(r.last_ts);
    r.alias = aliasOf(r.identity);
  }

  const pageIds = list.rows.map((r) => r.identity);
  const top = pageIds.length
    ? await run<{ identity: string; name: string; n: number }>(
        select,
        "actions per user, by event name",
        `SELECT identity, name, COUNT(*) AS n FROM events
          WHERE site_id = ? AND identity IN (${pageIds.map(() => "?").join(", ")}) AND ${HUMAN} AND ${IS_ACTION}
          GROUP BY identity, name ORDER BY identity, n DESC, name ASC`,
        [o.siteId, ...pageIds]
      )
    : { label: "actions per user, by event name", sql: "", params: [], rows: [] };

  const plans = await run<{ plan: string; users: number }>(
    select,
    "users by current plan",
    `${cte}\nSELECT plan, COUNT(*) AS users FROM people WHERE plan IS NOT NULL GROUP BY plan ORDER BY users DESC, plan ASC LIMIT 20`,
    [o.siteId]
  );

  const first = await select<{ t: number | null }>(`SELECT MIN(ts) AS t FROM events WHERE site_id = ? AND identity <> ''`, [o.siteId]);

  return {
    summary,
    total: n(count[0]?.n),
    list,
    top,
    plans,
    dataFrom: first[0]?.t === null || first[0]?.t === undefined ? null : Number(first[0].t),
  };
}

export interface PersonDetail {
  byDay: Query<{ day: number; total: number; name: string; n: number }>;
  visits: Query<{ session_id: string; started: number; ended: number; pages: number; actions: number }>;
}

/** One user, opened: actions by day (latest 14 active days) and the latest 10 visits. */
export async function personDetail(select: Select, siteId: string, identity: string): Promise<PersonDetail> {
  if (!HASH.test(identity)) throw new PeopleError("identity must be an identity hash (32 hex characters)");
  const byDay = await run<{ day: number; total: number; name: string; n: number }>(
    select,
    "this user's actions by day",
    `WITH a AS (
  SELECT CAST(ts / 86400000 AS INTEGER) * 86400000 AS day, name FROM events
   WHERE site_id = ? AND identity = ? AND ${HUMAN} AND ${IS_ACTION}
),
days AS (SELECT day, COUNT(*) AS total FROM a GROUP BY day ORDER BY day DESC LIMIT 14)
SELECT days.day, days.total, a.name, COUNT(*) AS n
  FROM days JOIN a ON a.day = days.day
 GROUP BY days.day, a.name ORDER BY days.day DESC, n DESC, a.name ASC`,
    [siteId, identity]
  );
  const visits = await run<{ session_id: string; started: number; ended: number; pages: number; actions: number }>(
    select,
    "this user's latest visits",
    `SELECT session_id, MIN(ts) AS started, MAX(ts) AS ended,
            SUM(CASE WHEN type = 'pageview' THEN 1 ELSE 0 END) AS pages,
            SUM(CASE WHEN ${IS_ACTION} THEN 1 ELSE 0 END) AS actions
       FROM events WHERE site_id = ? AND identity = ? AND ${HUMAN}
      GROUP BY session_id ORDER BY started DESC LIMIT 10`,
    [siteId, identity]
  );
  return { byDay, visits };
}
