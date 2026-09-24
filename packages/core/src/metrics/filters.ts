// packages/core/src/metrics/filters.ts
// Dashboard filters — "only Germany", "only mobile", "pages containing /blog".
//
// A filter in an evidence-first tool has a constraint the others do not have:
// **the filter must reach the SQL.**
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
// INJECTION: the field name and the operator come from closed allow-lists and
// are the only parts that shape the query; the value is ALWAYS a bound
// parameter. Same rule as the funnel: a user may choose the shape from a fixed
// set, never write it.
//
// Three kinds of field:
//   * row fields      — a column on the event itself (country, path, title…)
//   * session fields  — true of the whole SESSION (entry page, exit page, "did
//                       this event happen in the session"). Compiled into a
//                       `session_id IN (subquery)` so that "sessions that fired
//                       signup" still counts their pageviews, which a plain
//                       `name = 'signup'` predicate would throw away.
//   * pattern ops     — regex. SQLite has no REGEXP function and bun:sqlite
//                       cannot register one, so a regex is EXPANDED: the
//                       distinct values of the column are read, matched here,
//                       and the query receives `col IN (?, ?, …)` with the
//                       matched values bound. The evidence therefore shows the
//                       exact list the regex selected, which is more
//                       inspectable than a regex would have been.

/** The fields a person may filter on. Anything else is refused, not ignored. */
export const FILTER_FIELDS = [
  "country",
  "region",
  "city",
  "device",
  "browser",
  "os",
  "channel",
  "source",
  "lang",
  "path",
  "title",
  "hostname",
  "query",
  "referrer_host",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "screen",
  "tag",
  "event",
  "entry_page",
  "exit_page",
] as const;

export type FilterField = (typeof FILTER_FIELDS)[number];

/**
 * A custom-event PROPERTY: `prop:plan` filters on `props.plan`. The key is
 * checked against a strict pattern and travels as a bound JSON path, never
 * spliced into the SQL. Row-level: it narrows to the events that carry it.
 */
export type PropField = `prop:${string}`;
const PROP_KEY = /^[A-Za-z0-9_-]{1,40}$/;
export function isPropField(s: string): s is PropField {
  return s.startsWith("prop:") && PROP_KEY.test(s.slice(5));
}
function propPath(f: Filter): string {
  return `$."${f.field.slice(5)}"`;
}
/** The label a person reads: "Country", or "Property plan". */
export function fieldLabel(field: string): string {
  if (isPropField(field)) return `Property ${field.slice(5)}`;
  return isFilterField(field) ? FILTER_LABELS[field] : field;
}

/** Operators. The first one is the default and the only one the legacy wire form knows. */
export const FILTER_OPS = ["is", "is_not", "contains", "not_contains", "starts_with", "regex", "not_regex"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface Filter {
  field: FilterField | PropField;
  value: string;
  /** Defaults to "is". Left off by the legacy parser so old links round-trip unchanged. */
  op?: FilterOp;
  /**
   * For regex operators only: the column values the pattern matched, filled in
   * by `resolvePatternFilters` before the SQL is built. Never read from a URL.
   */
  matched?: string[];
}

/** Human labels, so the dashboard and the API agree on what a field is called. */
export const FILTER_LABELS: Readonly<Record<FilterField, string>> = {
  country: "Country",
  region: "Region",
  city: "City",
  device: "Device",
  browser: "Browser",
  os: "Operating system",
  channel: "Channel",
  source: "Source",
  lang: "Language",
  path: "Page",
  title: "Page title",
  hostname: "Hostname",
  query: "Query string",
  referrer_host: "Referrer",
  utm_source: "UTM source",
  utm_medium: "UTM medium",
  utm_campaign: "Campaign",
  utm_term: "UTM term",
  utm_content: "UTM content",
  screen: "Screen size",
  tag: "Tag",
  event: "Event in session",
  entry_page: "Entry page",
  exit_page: "Exit page",
};

export const OP_LABELS: Readonly<Record<FilterOp, string>> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  regex: "matches regex",
  not_regex: "does not match regex",
};

/**
 * The column a field reads. Row fields read their own column; session fields
 * name the column their subquery tests. Fixed strings — the only identifiers
 * that ever reach the SQL from this file.
 */
const COLUMN: Readonly<Record<FilterField, string>> = {
  country: "country",
  region: "region",
  city: "city",
  device: "device",
  browser: "browser",
  os: "os",
  channel: "channel",
  source: "source",
  lang: "lang",
  path: "path",
  title: "title",
  hostname: "hostname",
  query: "query",
  referrer_host: "referrer_host",
  utm_source: "utm_source",
  utm_medium: "utm_medium",
  utm_campaign: "utm_campaign",
  utm_term: "utm_term",
  utm_content: "utm_content",
  screen: "screen",
  tag: "tag",
  event: "name",
  entry_page: "path",
  exit_page: "path",
};

const SESSION_FIELDS: ReadonlySet<FilterField> = new Set(["event", "entry_page", "exit_page"]);

export function isFilterField(s: string): s is FilterField {
  return (FILTER_FIELDS as readonly string[]).includes(s);
}

export function isFilterOp(s: string): s is FilterOp {
  return (FILTER_OPS as readonly string[]).includes(s);
}

export class FilterError extends Error {}

/** How many filters may be applied at once. */
export const MAX_FILTERS = 8;
/** Longest accepted filter value. */
export const MAX_FILTER_VALUE = 200;
/**
 * A regex is expanded against the distinct values of a column. Past this many
 * distinct values the expansion is refused rather than truncated — a truncated
 * list would silently drop matches and under-report.
 */
export const MAX_PATTERN_CANDIDATES = 20_000;

function opOf(f: Filter): FilterOp {
  return f.op ?? "is";
}

function checkOne(field: string, op: string, value: string): Filter {
  if (!isFilterField(field) && !isPropField(field)) throw new FilterError(`cannot filter on "${field}"`);
  if (!isFilterOp(op)) throw new FilterError(`unknown filter operator "${op}"`);
  if (!value) throw new FilterError(`filter "${field}" has no value`);
  if (value.length > MAX_FILTER_VALUE) throw new FilterError(`filter "${field}" value is too long`);
  if (op === "regex" || op === "not_regex") checkRegex(value);
  return op === "is" ? { field, value } : { field, op, value };
}

/**
 * Refuse a regex that could hang the process.
 *
 * JavaScript regexes backtrack, and a pattern like `(a+)+$` against a long
 * path takes exponential time — on the single process that also serves ingest.
 * The heuristic below rejects a quantified group that itself contains a
 * quantifier, which is the shape every classic catastrophic pattern has. It is
 * deliberately conservative: it also refuses some harmless patterns, and the
 * error says what to write instead.
 */
function checkRegex(value: string): void {
  try {
    new RegExp(value);
  } catch {
    throw new FilterError(`"${value}" is not a valid regular expression`);
  }
  if (/\([^)]*[+*}][^)]*\)\s*[+*{]/.test(value)) {
    throw new FilterError(
      `regex "${value}" nests one repetition inside another, which can take exponential time — ` +
        `use "contains" or a flatter pattern`
    );
  }
}

/**
 * Parse filters from the query string.
 *
 * Two wire forms:
 *   * JSON: `[{"field":"path","op":"contains","value":"/blog"}]` — what the
 *     dashboard sends, because a value may contain a comma.
 *   * Legacy: `country:DE,device:mobile`, optionally `path:contains:/blog`.
 *
 * Refuses an unknown field rather than dropping it. A silently ignored filter
 * shows the user a narrowed heading over unnarrowed numbers, which is the exact
 * failure mode this file exists to prevent.
 */
export function parseFilters(raw: string | null | undefined): Filter[] {
  if (!raw || !raw.trim()) return [];
  const text = raw.trim();
  const out: Filter[] = [];

  if (text.startsWith("[")) {
    let list: unknown;
    try {
      list = JSON.parse(text);
    } catch {
      throw new FilterError("filters are not valid JSON");
    }
    if (!Array.isArray(list)) throw new FilterError("filters must be a list");
    for (const item of list) {
      if (typeof item !== "object" || item === null) throw new FilterError("malformed filter");
      const o = item as Record<string, unknown>;
      const field = String(o.field ?? "").trim();
      const op = String(o.op ?? "is").trim();
      const value = String(o.value ?? "").trim();
      out.push(checkOne(field, op, value));
    }
  } else {
    for (const part of text.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const at = trimmed.indexOf(":");
      if (at < 1) throw new FilterError(`malformed filter: "${trimmed}" (expected field:value)`);
      let field = trimmed.slice(0, at).trim();
      let rest = trimmed.slice(at + 1).trim();
      // `prop:plan:pro` — the property key is the second segment.
      if (field === "prop") {
        const k = rest.indexOf(":");
        if (k < 1) throw new FilterError(`malformed property filter: "${trimmed}" (expected prop:key:value)`);
        field = `prop:${rest.slice(0, k)}`;
        rest = rest.slice(k + 1).trim();
      }
      let op = "is";
      const second = rest.indexOf(":");
      if (second > 0 && isFilterOp(rest.slice(0, second))) {
        op = rest.slice(0, second);
        rest = rest.slice(second + 1).trim();
      }
      out.push(checkOne(field, op, rest));
    }
  }
  if (out.length > MAX_FILTERS) throw new FilterError(`too many filters (max ${MAX_FILTERS})`);
  return out;
}

/** Back to the legacy wire format, so a link can carry the current view. */
export function serializeFilters(filters: readonly Filter[]): string {
  return filters.map((f) => (opOf(f) === "is" ? `${f.field}:${f.value}` : `${f.field}:${opOf(f)}:${f.value}`)).join(",");
}

/**
 * Every window predicate in our metric SQL, in the two shapes it takes.
 *
 * `site_id = ? AND ts >= ? AND ts < ?` is the normal one; the live-visitor
 * metric has no upper bound. Table aliases are allowed because the funnel's
 * subquery writes `e.site_id`. The optional tail is greedy, so the longer form
 * always wins and the bounded window is never mistaken for the unbounded one.
 *
 * The session-level subqueries this file writes contain `site_id = ?` WITHOUT
 * `ts >= ?`, so they never match this pattern and are never filtered twice.
 */
const WINDOW_RE = /(\w+\.)?site_id = \? AND (\w+\.)?ts >= \?( AND (\w+\.)?ts < \?)?/g;

/** The value comparison for one operator, against a column expression. */
function predicate(col: string, f: Filter): string {
  switch (opOf(f)) {
    case "is":
      return `${col} = ?`;
    case "is_not":
      return `${col} <> ?`;
    case "contains":
      return `${col} LIKE ? ESCAPE '\\'`;
    case "not_contains":
      return `${col} NOT LIKE ? ESCAPE '\\'`;
    case "starts_with":
      return `${col} LIKE ? ESCAPE '\\'`;
    case "regex":
    case "not_regex": {
      const n = f.matched?.length;
      if (n === undefined) throw new FilterError(`regex filter on "${f.field}" was not resolved before compiling`);
      const list = Array.from({ length: n }, () => "?").join(", ");
      return `${col} ${opOf(f) === "regex" ? "IN" : "NOT IN"} (${list})`;
    }
  }
}

function likeEscape(v: string): string {
  return v.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The bound values one filter contributes, in placeholder order. */
function valuesOf(f: Filter, siteId: string): unknown[] {
  const own: unknown[] =
    opOf(f) === "contains" || opOf(f) === "not_contains"
      ? [`%${likeEscape(f.value)}%`]
      : opOf(f) === "starts_with"
        ? [`${likeEscape(f.value)}%`]
        : opOf(f) === "regex" || opOf(f) === "not_regex"
          ? [...(f.matched ?? [])]
          : [f.value];
  if (isPropField(f.field)) return [propPath(f), ...own];
  return SESSION_FIELDS.has(f.field as FilterField) ? [siteId, ...own] : own;
}

/**
 * The SQL for one filter, with the table alias of the window it follows.
 *
 * Session fields become a subquery over the whole site (no time bound): an
 * entry page is a fact about the session, and a session that began a minute
 * before the window still began on that page.
 */
function clauseOf(f: Filter, p: string): string {
  if (isPropField(f.field)) return predicate(`CAST(json_extract(${p}props, ?) AS TEXT)`, f);
  const col = COLUMN[f.field as FilterField];
  if (f.field === "event") {
    return `${p}session_id IN (SELECT session_id FROM events WHERE site_id = ? AND type = 'event' AND ${predicate(col, f)})`;
  }
  if (f.field === "entry_page" || f.field === "exit_page") {
    // SQLite returns the bare column from the row that produced MIN()/MAX(),
    // which is exactly "the path of the first (last) pageview". Documented
    // behaviour, not an accident: https://sqlite.org/lang_select.html#bareagg
    const agg = f.field === "entry_page" ? "MIN(ts)" : "MAX(ts)";
    return (
      `${p}session_id IN (SELECT session_id FROM (SELECT session_id, path, ${agg} FROM events ` +
      `WHERE site_id = ? AND type = 'pageview' GROUP BY session_id) WHERE ${predicate(col, f)})`
    );
  }
  return predicate(`${p}${col}`, f);
}

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
    return match + filters.map((f) => ` AND ${clauseOf(f, p)}`).join("");
  });
}

/**
 * The values, in the order `applyFilters` placed their placeholders.
 *
 * `siteId` is needed by session fields, whose subquery is bounded to the site
 * like every other query. Omitting it is only safe when no session field is in
 * use, so it is required whenever one is — a missing tenant bound must fail
 * loudly, never bind `undefined` and match nothing (or everything).
 */
export function filterValues(filters: readonly Filter[], siteId?: string): unknown[] {
  const out: unknown[] = [];
  for (const f of filters) {
    if (SESSION_FIELDS.has(f.field as FilterField) && !siteId) {
      throw new FilterError(`filter "${f.field}" needs the site id to bound its subquery`);
    }
    out.push(...valuesOf(f, siteId ?? ""));
  }
  return out;
}

/** How many window predicates a statement has — one filter block per predicate. */
export function windowCount(sql: string): number {
  return (sql.match(WINDOW_RE) ?? []).length;
}

/** "Country = DE, Page contains /blog" — for a heading, and for the digest. */
export function describeFilters(filters: readonly Filter[]): string {
  return filters
    .map((f) => {
      const op = opOf(f);
      return op === "is" ? `${fieldLabel(f.field)} = ${f.value}` : `${fieldLabel(f.field)} ${OP_LABELS[op]} ${f.value}`;
    })
    .join(", ");
}

/**
 * Expand regex filters into the values they match.
 *
 * Reads the distinct values of the column for this site, runs the pattern here,
 * and returns new filter objects carrying `matched`. The candidate query is
 * bounded to the site like every other query, and it refuses — rather than
 * truncates — a column with too many distinct values.
 */
export async function resolvePatternFilters(
  select: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>,
  siteId: string,
  filters: readonly Filter[]
): Promise<Filter[]> {
  const out: Filter[] = [];
  for (const f of filters) {
    const op = opOf(f);
    if (op !== "regex" && op !== "not_regex") {
      out.push(f);
      continue;
    }
    const prop = isPropField(f.field);
    const col = prop ? `CAST(json_extract(props, ?) AS TEXT)` : COLUMN[f.field as FilterField];
    const rows = (
      await select<{ v: string | null }>(
        `SELECT DISTINCT ${col} AS v FROM events WHERE site_id = ? LIMIT ${MAX_PATTERN_CANDIDATES + 1}`,
        prop ? [propPath(f), siteId] : [siteId]
      )
    ).filter((r) => r.v !== null);
    if (rows.length > MAX_PATTERN_CANDIDATES) {
      throw new FilterError(
        `"${fieldLabel(f.field)}" has more than ${MAX_PATTERN_CANDIDATES} distinct values, too many to match a ` +
          `regex against — use "contains" or "starts with" instead`
      );
    }
    const re = new RegExp(f.value);
    const matched = rows.map((r) => String(r.v ?? "")).filter((v) => re.test(v)).sort();
    out.push({ ...f, matched });
  }
  return out;
}
