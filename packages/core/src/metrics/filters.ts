// packages/core/src/metrics/filters.ts
// Dashboard filters — "only Germany", "only mobile", "only AI traffic".
//
// This was the largest hole in the product: every rival can slice a report and
// we could not slice anything. But a filter in an evidence-first tool has a
// constraint the others do not have: **the filter must reach the SQL.**
//
// Filtering the rows in the browser would be far easier and would quietly break
// the only thing this product sells. The number on the card would say 412, the
// evidence panel would show the query that produced 3,100, and the person who
// clicked the badge to check would find the two disagree. One such discovery
// costs more than the feature is worth.
//
// So the filter is compiled into every metric's WHERE clause, and the modified
// SQL — with its bound parameters — is what the evidence panel shows.
//
// INJECTION: the field name comes from a closed allow-list and is the only part
// that shapes the query; the value is ALWAYS a bound parameter. Same rule as the
// funnel: a user may choose the shape from a fixed set, never write it.

/** The columns a person may filter on. Anything else is refused, not ignored. */
export const FILTER_FIELDS = [
  "country",
  "device",
  "browser",
  "os",
  "channel",
  "source",
  "lang",
  "path",
  "referrer_host",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "tag",
] as const;

export type FilterField = (typeof FILTER_FIELDS)[number];

export interface Filter {
  field: FilterField;
  value: string;
}

/** Human labels, so the dashboard and the API agree on what a field is called. */
export const FILTER_LABELS: Readonly<Record<FilterField, string>> = {
  country: "Country",
  device: "Device",
  browser: "Browser",
  os: "Operating system",
  channel: "Channel",
  source: "Source",
  lang: "Language",
  path: "Page",
  referrer_host: "Referrer",
  utm_source: "UTM source",
  utm_medium: "UTM medium",
  utm_campaign: "Campaign",
  tag: "Tag",
};

export function isFilterField(s: string): s is FilterField {
  return (FILTER_FIELDS as readonly string[]).includes(s);
}

export class FilterError extends Error {}

/** How many filters may be applied at once. */
export const MAX_FILTERS = 8;
/** Longest accepted filter value. */
export const MAX_FILTER_VALUE = 200;

/**
 * Parse filters from the query string form `country:DE,device:mobile`.
 *
 * Refuses an unknown field rather than dropping it. A silently ignored filter
 * shows the user a narrowed heading over unnarrowed numbers, which is the exact
 * failure mode this file exists to prevent.
 */
export function parseFilters(raw: string | null | undefined): Filter[] {
  if (!raw) return [];
  const out: Filter[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf(":");
    if (at < 1) throw new FilterError(`malformed filter: "${trimmed}" (expected field:value)`);
    const field = trimmed.slice(0, at).trim();
    const value = trimmed.slice(at + 1).trim();
    if (!isFilterField(field)) throw new FilterError(`cannot filter on "${field}"`);
    if (!value) throw new FilterError(`filter "${field}" has no value`);
    if (value.length > MAX_FILTER_VALUE) throw new FilterError(`filter "${field}" value is too long`);
    out.push({ field, value });
  }
  if (out.length > MAX_FILTERS) throw new FilterError(`too many filters (max ${MAX_FILTERS})`);
  return out;
}

/** Back to the wire format, so a link can carry the current view. */
export function serializeFilters(filters: readonly Filter[]): string {
  return filters.map((f) => `${f.field}:${f.value}`).join(",");
}

/**
 * Every window predicate in our metric SQL, in the two shapes it takes.
 *
 * `site_id = ? AND ts >= ? AND ts < ?` is the normal one; the live-visitor
 * metric has no upper bound. Table aliases are allowed because the funnel's
 * subquery writes `e.site_id`. The optional tail is greedy, so the longer form
 * always wins and the bounded window is never mistaken for the unbounded one.
 */
const WINDOW_RE = /(\w+\.)?site_id = \? AND (\w+\.)?ts >= \?( AND (\w+\.)?ts < \?)?/g;

/**
 * Compile the filters into the SQL.
 *
 * Returns the modified statement. The caller supplies the values through
 * `filterValues`, once per window predicate — `paramsFor` knows how many there
 * are because it counts the same predicates.
 */
export function applyFilters(sql: string, filters: readonly Filter[]): string {
  if (filters.length === 0) return sql;
  return sql.replace(WINDOW_RE, (match, prefix?: string) => {
    const p = prefix ?? "";
    const clause = filters.map((f) => ` AND ${p}${f.field} = ?`).join("");
    return match + clause;
  });
}

/** The values, in the order `applyFilters` placed their placeholders. */
export function filterValues(filters: readonly Filter[]): string[] {
  return filters.map((f) => f.value);
}

/** How many window predicates a statement has — one filter block per predicate. */
export function windowCount(sql: string): number {
  return (sql.match(WINDOW_RE) ?? []).length;
}

/** "Country = DE, Device = mobile" — for a heading, and for the digest. */
export function describeFilters(filters: readonly Filter[]): string {
  return filters.map((f) => `${FILTER_LABELS[f.field]} = ${f.value}`).join(", ");
}
