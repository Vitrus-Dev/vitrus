// packages/core/src/metrics/lifecycle.ts
// User lifecycle: who is new, who stayed, who came back, who was lost, who
// started paying — counted, never listed, from one extra line of code.
//
// ═══ WHAT IT NEEDS ═══
//   vitrus.identify(user.id)              — required; on every page while signed in
//   vitrus("signup") / vitrus("login")    — optional; counted as events
//   vitrus("plan", { plan: "pro" })       — optional; plan moves
//
// The id is hashed in the browser, hashed again with a server secret, and is
// per site (visitor.ts). No email, no name, no list of people leaves this
// file: every result is a count.
//
// ═══ DEFINITIONS, STATED ONCE ═══
// A person is ACTIVE in a window when at least one human event in it carries
// their identity. Comparing the window with the one before it (same length,
// directly before) — the growth accounting used by most subscription teams:
//
//   new          active now, first ever seen inside this window
//   retained     active now and in the previous window
//   resurrected  active now, NOT in the previous window, seen before it
//   churned      active in the previous window, NOT now          ("lost")
//
//   active now = retained + new + resurrected
//   previous   = retained + churned
//   gained     = new + resurrected;  net = gained − churned
//   quick ratio = gained ÷ churned   (null when nobody churned — not ∞, not 0)
//
// ONE-AND-DONE: of the people first seen in this window AND at least 7 days
// before its end (so each had a week to come back), how many were active on
// one UTC day only. With no one that old in the window it is null, with the
// reason — "0%" would claim a measurement that was not made.
//
// PLANS: the latest `plan` a person carried (on any event) is their plan.
// "Became paying" = a move into a plan that is not in FREE_PLANS from no plan
// or a free one; "downgraded" = the reverse. Plan labels are the site owner's
// own words, normalised to lower case at ingest (pii.ts).
//
// ═══ LIMITATIONS ═══
//   * "First seen" can only look as far back as the data does. With a
//     retention period set, a person whose earliest events were purged is
//     counted as new again when they return. The result carries the earliest
//     event's timestamp (`dataFrom`) so the page can say how far back it sees.
//   * Identities are per site by construction; this file never joins sites.
//   * Days are UTC days: a session from 23:50 to 00:10 is two active days.
//   * Filters (country, page, …) are deliberately NOT applied: "was this
//     person active" has no sensible answer for "only the visits from Germany".
//
// Everything that shapes the SQL is a constant in this file; every value is a
// bound parameter.

import type { Query, Select } from "./explore.ts";
import { HUMAN } from "./queries.ts";

export const ONE_AND_DONE_DAYS = 7;
const DAY_MS = 86_400_000;

/** Plans that do not pay. Lower case; ingest normalises plans to lower case. */
export const FREE_PLANS = ["free", "trial", "none", "cancelled", "canceled", "expired", "inactive"] as const;
const FREE_SQL = `(${FREE_PLANS.map((p) => `'${p}'`).join(", ")})`;
const PLAN = `json_extract(props, '$.plan')`;

/** The lifecycle events this page counts on their own. */
export const LIFECYCLE_EVENTS = ["signup", "login", "logout"] as const;

export interface LifecycleOptions {
  siteId: string;
  from: number;
  to: number;
  bucketMs: number;
  /** The site's privacy mode: strict ignores identify(), so there is nothing to count. */
  privacyMode?: "standard" | "strict";
}

export interface Accounting {
  known: number;
  active: number;
  prev_active: number;
  new_users: number;
  retained: number;
  resurrected: number;
  churned: number;
}

export interface LifecycleAvailable {
  available: true;
  window: { from: number; to: number; previousFrom: number };
  accounting: Query<Accounting>;
  /** Derived from `accounting`; null where a denominator is 0. */
  gained: number;
  lost: number;
  net: number;
  quickRatio: number | null;
  /** % of the previous window's active people still active now. */
  retainedRate: number | null;
  oneAndDone: Query<{ eligible: number; one_day: number }>;
  oneAndDoneRate: number | null;
  /** Why `oneAndDoneRate` is null, when it is. */
  oneAndDoneNote: string | null;
  events: Query<{ name: string; events: number; users: number }>;
  plans: Query<{ plan: string; users: number }>;
  upgrades: Query<{ plan: string; users: number }>;
  downgrades: Query<{ plan: string; users: number }>;
  series: Query<{ g: number; active: number }>;
  newSeries: Query<{ g: number; new_users: number }>;
  privacy: Query<{ raw_ids: number; pii_dropped: number; plan_rejected: number }>;
  /** Earliest identified event on record — how far back "first seen" can look. */
  dataFrom: number | null;
}

export interface LifecycleUnavailable {
  available: false;
  reason: "no_identity" | "strict_mode";
  message: string;
  remedy: string;
  sql: string;
  params: unknown[];
}

export type LifecycleResult = LifecycleAvailable | LifecycleUnavailable;

async function run<T>(select: Select, label: string, sql: string, params: unknown[]): Promise<Query<T>> {
  const slots = (sql.match(/\?/g) ?? []).length;
  if (slots !== params.length) throw new Error(`${label}: ${slots} placeholders but ${params.length} parameters`);
  return { label, sql, params, rows: await select<T>(sql, params) };
}

const n = (v: unknown): number => Number(v ?? 0) || 0;

export const ACCOUNTING_SQL = `WITH people AS (
  SELECT identity,
         MIN(ts) AS first_ts,
         MAX(CASE WHEN ts >= ? AND ts < ? THEN 1 ELSE 0 END) AS cur,
         MAX(CASE WHEN ts >= ? AND ts < ? THEN 1 ELSE 0 END) AS prev
    FROM events
   WHERE site_id = ? AND ts < ? AND identity <> '' AND ${HUMAN}
   GROUP BY identity
)
SELECT COUNT(*) AS known,
       COALESCE(SUM(cur), 0) AS active,
       COALESCE(SUM(prev), 0) AS prev_active,
       COALESCE(SUM(CASE WHEN cur = 1 AND first_ts >= ? THEN 1 ELSE 0 END), 0) AS new_users,
       COALESCE(SUM(CASE WHEN cur = 1 AND prev = 1 THEN 1 ELSE 0 END), 0) AS retained,
       COALESCE(SUM(CASE WHEN cur = 1 AND prev = 0 AND first_ts < ? THEN 1 ELSE 0 END), 0) AS resurrected,
       COALESCE(SUM(CASE WHEN cur = 0 AND prev = 1 THEN 1 ELSE 0 END), 0) AS churned
  FROM people`;

export async function computeLifecycle(select: Select, o: LifecycleOptions): Promise<LifecycleResult> {
  const span = o.to - o.from;
  const pfrom = o.from - span;

  if (o.privacyMode === "strict") {
    return {
      available: false,
      reason: "strict_mode",
      message:
        "This site is in strict privacy mode, which ignores identify() — so there are no users to count, only anonymous daily visitors.",
      remedy: "Switch the site to standard privacy mode in Settings if your privacy notice covers a hashed user id.",
      sql: "",
      params: [],
    };
  }

  const accParams = [o.from, o.to, pfrom, o.from, o.siteId, o.to, o.from, o.from];
  const accounting = await run<Accounting>(select, "people: new, retained, resurrected, churned", ACCOUNTING_SQL, accParams);
  const a = accounting.rows[0];
  const acc: Accounting = {
    known: n(a?.known),
    active: n(a?.active),
    prev_active: n(a?.prev_active),
    new_users: n(a?.new_users),
    retained: n(a?.retained),
    resurrected: n(a?.resurrected),
    churned: n(a?.churned),
  };
  accounting.rows = [acc];

  if (acc.known === 0) {
    return {
      available: false,
      reason: "no_identity",
      message:
        "No signed-in users on this site yet. Visitors are anonymous by design — our visitor id changes every day — " +
        "so who stayed and who left can only be counted for people your app identifies.",
      remedy:
        "Add one line where your app knows the user is signed in: `vitrus.identify(user.id)`. " +
        "The id is hashed in the browser before it is sent and hashed again before it is stored; no email or name is kept.",
      sql: ACCOUNTING_SQL,
      params: accParams,
    };
  }

  const gained = acc.new_users + acc.resurrected;
  const lost = acc.churned;

  // One-and-done: the cohort that has had a full week to come back.
  const cutoff = o.to - ONE_AND_DONE_DAYS * DAY_MS;
  const oneSql = `WITH firsts AS (
  SELECT identity, MIN(ts) AS first_ts, COUNT(DISTINCT CAST(ts / 86400000 AS INTEGER)) AS days
    FROM events
   WHERE site_id = ? AND ts < ? AND identity <> '' AND ${HUMAN}
   GROUP BY identity
)
SELECT COUNT(*) AS eligible, COALESCE(SUM(CASE WHEN days = 1 THEN 1 ELSE 0 END), 0) AS one_day
  FROM firsts WHERE first_ts >= ? AND first_ts < ?`;
  const oneAndDone = await run<{ eligible: number; one_day: number }>(
    select,
    `people first seen at least ${ONE_AND_DONE_DAYS} days ago, by active days`,
    oneSql,
    [o.siteId, o.to, o.from, cutoff]
  );
  const od = { eligible: n(oneAndDone.rows[0]?.eligible), one_day: n(oneAndDone.rows[0]?.one_day) };
  oneAndDone.rows = [od];
  let oneAndDoneRate: number | null = null;
  let oneAndDoneNote: string | null = null;
  if (cutoff <= o.from) {
    oneAndDoneNote = `Needs a range longer than ${ONE_AND_DONE_DAYS} days: only people who have had a full week to come back are counted.`;
  } else if (od.eligible === 0) {
    oneAndDoneNote = `Nobody was first seen in this range at least ${ONE_AND_DONE_DAYS} days before its end.`;
  } else {
    oneAndDoneRate = Math.round((od.one_day / od.eligible) * 1000) / 10;
  }

  const events = await run<{ name: string; events: number; users: number }>(
    select,
    "signups, logins and logouts",
    `SELECT name, COUNT(*) AS events, COUNT(DISTINCT CASE WHEN identity <> '' THEN identity END) AS users
       FROM events
      WHERE site_id = ? AND ts >= ? AND ts < ? AND ${HUMAN} AND name IN ('signup', 'login', 'logout')
      GROUP BY name ORDER BY name ASC`,
    [o.siteId, o.from, o.to]
  );

  // SQLite: with MAX() in the select list, the bare `plan` column comes from
  // the row that holds the maximum — the person's latest plan. Documented
  // behaviour ("bare columns in an aggregate query"), relied on deliberately.
  const plans = await run<{ plan: string; users: number }>(
    select,
    "people by current plan",
    `SELECT plan, COUNT(*) AS users FROM (
  SELECT identity, ${PLAN} AS plan, MAX(ts) AS last_ts
    FROM events
   WHERE site_id = ? AND ts < ? AND identity <> '' AND ${HUMAN} AND ${PLAN} IS NOT NULL
   GROUP BY identity
)
GROUP BY plan ORDER BY users DESC, plan ASC LIMIT 20`,
    [o.siteId, o.to]
  );

  const changes = `WITH changes AS (
  SELECT identity, ts, ${PLAN} AS plan,
         LAG(${PLAN}) OVER (PARTITION BY identity ORDER BY ts) AS before
    FROM events
   WHERE site_id = ? AND ts < ? AND identity <> '' AND ${HUMAN} AND ${PLAN} IS NOT NULL
)`;
  const upgrades = await run<{ plan: string; users: number }>(
    select,
    "became paying, by the plan they moved to",
    `${changes}
SELECT plan, COUNT(DISTINCT identity) AS users FROM changes
 WHERE ts >= ? AND plan NOT IN ${FREE_SQL} AND (before IS NULL OR before IN ${FREE_SQL})
 GROUP BY plan ORDER BY users DESC, plan ASC`,
    [o.siteId, o.to, o.from]
  );
  const downgrades = await run<{ plan: string; users: number }>(
    select,
    "stopped paying, by the plan they moved to",
    `${changes}
SELECT plan, COUNT(DISTINCT identity) AS users FROM changes
 WHERE ts >= ? AND plan IN ${FREE_SQL} AND before IS NOT NULL AND before NOT IN ${FREE_SQL}
 GROUP BY plan ORDER BY users DESC, plan ASC`,
    [o.siteId, o.to, o.from]
  );

  const bucketMs = Math.max(60_000, Math.round(o.bucketMs));
  const series = await run<{ g: number; active: number }>(
    select,
    "active people over time",
    `SELECT CAST((ts - ?) / ? AS INTEGER) AS g, COUNT(DISTINCT identity) AS active
       FROM events
      WHERE site_id = ? AND ts >= ? AND ts < ? AND identity <> '' AND ${HUMAN}
      GROUP BY g ORDER BY g ASC`,
    [o.from, bucketMs, o.siteId, o.from, o.to]
  );
  const newSeries = await run<{ g: number; new_users: number }>(
    select,
    "new people over time",
    `SELECT CAST((first_ts - ?) / ? AS INTEGER) AS g, COUNT(*) AS new_users FROM (
  SELECT identity, MIN(ts) AS first_ts
    FROM events
   WHERE site_id = ? AND ts < ? AND identity <> '' AND ${HUMAN}
   GROUP BY identity
) WHERE first_ts >= ?
GROUP BY g ORDER BY g ASC`,
    [o.from, bucketMs, o.siteId, o.to, o.from]
  );

  const privacy = await run<{ raw_ids: number; pii_dropped: number; plan_rejected: number }>(
    select,
    "privacy check: raw ids, personal data removed, rejected plans",
    `SELECT COALESCE(SUM(CASE WHEN json_extract(props, '$._id_raw') THEN 1 ELSE 0 END), 0) AS raw_ids,
       COALESCE(SUM(json_extract(props, '$._pii_dropped')), 0) AS pii_dropped,
       COALESCE(SUM(CASE WHEN json_extract(props, '$._plan_rejected') IS NOT NULL THEN 1 ELSE 0 END), 0) AS plan_rejected
  FROM events WHERE site_id = ? AND ts >= ? AND ts < ?`,
    [o.siteId, o.from, o.to]
  );
  const pv = privacy.rows[0];
  privacy.rows = [{ raw_ids: n(pv?.raw_ids), pii_dropped: n(pv?.pii_dropped), plan_rejected: n(pv?.plan_rejected) }];

  const first = await select<{ t: number | null }>(
    `SELECT MIN(ts) AS t FROM events WHERE site_id = ? AND identity <> ''`,
    [o.siteId]
  );

  return {
    available: true,
    window: { from: o.from, to: o.to, previousFrom: pfrom },
    accounting,
    gained,
    lost,
    net: gained - lost,
    quickRatio: lost > 0 ? Math.round((gained / lost) * 100) / 100 : null,
    retainedRate: acc.prev_active > 0 ? Math.round((acc.retained / acc.prev_active) * 1000) / 10 : null,
    oneAndDone,
    oneAndDoneRate,
    oneAndDoneNote,
    events,
    plans,
    upgrades,
    downgrades,
    series,
    newSeries,
    privacy,
    dataFrom: first[0]?.t === null || first[0]?.t === undefined ? null : Number(first[0].t),
  };
}
