// packages/core/src/metrics/retention.ts
// Retention (the cohort matrix) — and why it CANNOT BE MEASURED on anonymous traffic.
//
// ═══ IMPORTANT: THE PLACE THIS PRODUCT HAS TO BE MOST HONEST ═══
//
// Our visitor id is generated with a daily salt (I7): the same person becomes a
// DIFFERENT value tomorrow. That is a deliberate privacy decision, but it has a
// mathematical consequence: **cross-day tracking of an anonymous visitor is
// impossible.** A sentence like "30% of last week's visitors came back" CANNOT
// BE CONSTRUCTED from anonymous data.
//
// Most competitors solve this either with a persistent identifier (a cookie, or
// an unsalted IP hash — both weaken the "consent-free measurement" claim) or by
// quietly counting it wrong. We take a third path: **we say what we cannot
// measure, and we open the path that would let us measure it.**
//
//   `vitrus.identify("user-123")` → the site owner supplies their own user id
//   (a logged-in user). That id is hashed PERSISTENTLY and retention is
//   genuinely computed. The raw identity never reaches disk.
//
// Which is why availability is always checked first: with no identity there is
// no matrix, and what comes back instead is the reason and the remedy.

export interface RetentionCell {
  /** Days after the cohort day (0 = the cohort day itself). */
  offset: number;
  /** How many people returned on that day. */
  users: number;
  /** As a share of the cohort size (%). */
  rate: number;
}

export interface RetentionCohort {
  /** The cohort day (UTC start-of-day, ms). */
  day: number;
  /** How many people were seen for the FIRST TIME on that day. */
  size: number;
  cells: RetentionCell[];
}

export interface RetentionResult {
  available: true;
  cohorts: RetentionCohort[];
  /** The average across all cohorts (offset → %). For drawing the curve. */
  curve: { offset: number; rate: number }[];
  /** How many people were identified (the base the matrix rests on). */
  identified: number;
  sql: string;
  params: unknown[];
}

export interface RetentionUnavailable {
  available: false;
  /** Machine-readable reason. */
  reason: "no_identity";
  /** The explanation shown to the user — we never LEAVE a silently empty table. */
  message: string;
  /** What to do about it. */
  remedy: string;
  sql: string;
  params: unknown[];
}

export const MAX_COHORTS = 12;
export const MAX_OFFSET = 7;
const DAY_MS = 86_400_000;

/** Round down to the UTC start of day. */
function dayStart(ts: number): number {
  return Math.floor(ts / DAY_MS) * DAY_MS;
}

interface FirstSeenRow {
  identity: string;
  first_ts: number;
}

interface ActivityRow {
  identity: string;
  day: number;
}

const FIRST_SEEN_SQL = `SELECT identity, MIN(ts) AS first_ts
                          FROM events
                         WHERE site_id = ? AND ts >= ? AND ts < ? AND bot_kind = '' AND identity <> ''
                         GROUP BY identity`;

const ACTIVITY_SQL = `SELECT DISTINCT identity, CAST(ts / 86400000 AS INTEGER) * 86400000 AS day
                        FROM events
                       WHERE site_id = ? AND ts >= ? AND ts < ? AND bot_kind = '' AND identity <> ''`;

export interface RetentionQuery {
  siteId: string;
  from: number;
  to: number;
  maxOffset?: number;
}

export async function computeRetention(
  select: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>,
  q: RetentionQuery
): Promise<RetentionResult | RetentionUnavailable> {
  const params = [q.siteId, q.from, q.to];
  const maxOffset = Math.min(MAX_OFFSET, Math.max(1, q.maxOffset ?? MAX_OFFSET));

  const firstSeen = await select<FirstSeenRow>(FIRST_SEEN_SQL, params);

  if (firstSeen.length === 0) {
    return {
      available: false,
      reason: "no_identity",
      message:
        "Retention cannot be computed: no identified users on this site. " +
        "Our visitor id is a hash that changes every day (we use no cookies), " +
        "so cross-day tracking of anonymous traffic is mathematically impossible.",
      remedy:
        'Call `vitrus.identify("your-user-id")` when a user signs in. ' +
        "The identity is hashed on the server; the raw value is never stored.",
      sql: FIRST_SEEN_SQL,
      params,
    };
  }

  const activity = await select<ActivityRow>(ACTIVITY_SQL, params);

  // identity → cohort day
  const cohortOf = new Map<string, number>();
  for (const r of firstSeen) cohortOf.set(r.identity, dayStart(Number(r.first_ts)));

  // cohort day → member count
  const cohortSize = new Map<number, number>();
  for (const day of cohortOf.values()) cohortSize.set(day, (cohortSize.get(day) ?? 0) + 1);

  // (cohort day, offset) → set of people who returned
  const buckets = new Map<string, Set<string>>();
  for (const a of activity) {
    const cohort = cohortOf.get(a.identity);
    if (cohort === undefined) continue;
    const offset = Math.round((Number(a.day) - cohort) / DAY_MS);
    if (offset < 0 || offset > maxOffset) continue;
    const key = `${cohort}:${offset}`;
    let set = buckets.get(key);
    if (!set) {
      set = new Set();
      buckets.set(key, set);
    }
    set.add(a.identity);
  }

  const days = [...cohortSize.keys()].sort((a, b) => b - a).slice(0, MAX_COHORTS).sort((a, b) => a - b);

  const cohorts: RetentionCohort[] = days.map((day) => {
    const size = cohortSize.get(day) ?? 0;
    const cells: RetentionCell[] = [];
    for (let offset = 0; offset <= maxOffset; offset++) {
      // No cell is produced for the future: writing "0% returned" for days past
      // the end of the window would present the unmeasured as measured.
      if (day + offset * DAY_MS >= q.to) break;
      const users = buckets.get(`${day}:${offset}`)?.size ?? 0;
      cells.push({ offset, users, rate: size === 0 ? 0 : Math.round((users / size) * 1000) / 10 });
    }
    return { day, size, cells };
  });

  // The average curve: for each offset, a weighted mean over the cohorts that were ABLE TO MEASURE that offset.
  const curve: { offset: number; rate: number }[] = [];
  for (let offset = 0; offset <= maxOffset; offset++) {
    let users = 0;
    let base = 0;
    for (const c of cohorts) {
      const cell = c.cells.find((x) => x.offset === offset);
      if (!cell) continue;
      users += cell.users;
      base += c.size;
    }
    if (base > 0) curve.push({ offset, rate: Math.round((users / base) * 1000) / 10 });
  }

  return {
    available: true,
    cohorts,
    curve,
    identified: firstSeen.length,
    sql: `${FIRST_SEEN_SQL}\n\n-- and --\n\n${ACTIVITY_SQL}`,
    params,
  };
}
