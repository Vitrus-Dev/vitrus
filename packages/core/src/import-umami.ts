// packages/core/src/import-umami.ts
// Import history from an Umami CSV export — one row per event.
//
// Why Umami and not (yet) Plausible: Umami exports EVENTS, the same grain we
// store, so an imported row is a row we could have collected ourselves and
// every metric's SQL stays true for it. Plausible exports daily AGGREGATES;
// turning "412 visitors on 3 March" into 412 invented visits would put numbers
// in the database that no one observed. That needs its own table, not this.
//
// Decisions, stated once:
//   * Idempotent. An event's id is `umami:<event_id>` and the store inserts
//     with OR IGNORE, so importing the same file twice adds nothing.
//   * No overlap. Rows at or after `stopAt` (the first event Vitrus collected
//     for the site) are skipped and counted: the same visit from two tools
//     would be counted twice.
//   * Removable. Every row carries `_import` (the batch id) in props, which the
//     dashboard hides like every `_` key; deleting a batch deletes exactly it.
//   * Umami's "session" is a visitor across visits (IP + UA + a monthly salt)
//     and its "visit" is a 30-minute session — ours are named the other way
//     round, so visit_id → session_id and session_id → visitor_id, both hashed
//     with a per-batch prefix so they can never collide with a native id.
//   * Channel and source are re-derived with OUR referrer table, so imported
//     and native traffic are classified by the same rules.
//   * Humans only: Umami drops bots at collection, so there is nothing to
//     classify; agent trust is `human` because that is all Umami kept.
//   * Unknown columns are ignored; a missing required column rejects the file
//     with the column's name, before anything is written.

import { classifyReferrer, parseUtm } from "./referrers.ts";
import type { Store } from "./store/store.ts";
import type { StoredEvent } from "./types.ts";

export const IMPORT_MAX_ROWS = 2_000_000;
const REQUIRED = ["event_id", "session_id", "created_at", "url_path", "event_type"] as const;

export class ImportError extends Error {}

/** RFC 4180: commas, quotes doubled inside quoted fields, CRLF or LF, newlines inside quotes. */
export function* parseCsv(text: string): Generator<string[]> {
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const n = text.length;
  if (text.charCodeAt(0) === 0xfeff) i = 1; // BOM
  while (i < n) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      quoted = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      row.push(field);
      field = "";
      if (c === "\r" && text[i + 1] === "\n") i++;
      i++;
      if (row.length > 1 || row[0] !== "") yield row;
      row = [];
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") yield row;
  }
}

async function hash(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Umami timestamps are UTC "YYYY-MM-DD HH:MM:SS[.fff]" (or ISO). */
function parseTs(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:?\d{2})?$/.exec(s.trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? "." + m[7].slice(0, 3).padEnd(3, "0") : ""}${m[8] ?? "Z"}`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

const BROWSERS: Record<string, string> = {
  chrome: "Chrome", "chromium-webview": "Chrome", crios: "Chrome", "edge-chromium": "Edge", edge: "Edge", "edge-ios": "Edge",
  firefox: "Firefox", fxios: "Firefox", safari: "Safari", ios: "Safari", "ios-webview": "Safari",
  opera: "Opera", samsung: "Samsung Internet", brave: "Brave", vivaldi: "Vivaldi", yandexbrowser: "Yandex", facebook: "Facebook",
};
function browserOf(b: string): string {
  const k = b.trim().toLowerCase();
  return BROWSERS[k] ?? (k ? k.charAt(0).toUpperCase() + k.slice(1) : "unknown");
}
function osOf(o: string): string {
  const s = o.trim().toLowerCase();
  if (!s) return "unknown";
  if (s.startsWith("mac")) return "macOS";
  if (s.startsWith("windows")) return "Windows";
  if (s === "ios") return "iOS";
  if (s.startsWith("android")) return "Android";
  if (s.includes("chrome os") || s === "chromeos") return "ChromeOS";
  if (s.includes("linux") || s.includes("ubuntu")) return "Linux";
  return o.trim();
}
function deviceOf(d: string): StoredEvent["device"] {
  const s = d.trim().toLowerCase();
  if (s === "mobile") return "mobile";
  if (s === "tablet") return "tablet";
  if (s === "desktop" || s === "laptop") return "desktop";
  return "unknown";
}

export interface UmamiImportOptions {
  siteId: string;
  /** The site's own domain, for internal-referrer detection. */
  selfHost: string;
  batchId: string;
  /** Skip rows at or after this time (the first event Vitrus collected). */
  stopAt: number | null;
}

export interface ImportSummary {
  batchId: string;
  imported: number;
  skipped: Record<string, number>;
  from: number | null;
  to: number | null;
}

/**
 * Parse and write. Rows go to the store in batches of 1000; validation of the
 * header happens before the first write, so a wrong file writes nothing.
 */
export async function importUmamiCsv(store: Store, csv: string, o: UmamiImportOptions): Promise<ImportSummary> {
  const rows = parseCsv(csv);
  const head = rows.next();
  if (head.done) throw new ImportError("the file is empty");
  const cols = (head.value as string[]).map((c) => c.trim().toLowerCase());
  const missing = REQUIRED.filter((c) => !cols.includes(c));
  if (missing.length) {
    throw new ImportError(
      `this does not look like an Umami export: missing column${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`
    );
  }
  const at = (name: string) => cols.indexOf(name);
  const idx = Object.fromEntries(
    [
      "event_id", "session_id", "visit_id", "created_at", "url_path", "url_query", "referrer_domain", "referrer_path",
      "referrer_query", "page_title", "hostname", "event_type", "event_name", "browser", "os", "device", "screen",
      "language", "country", "region", "city", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "tag",
    ].map((k) => [k, at(k)])
  ) as Record<string, number>;
  const get = (r: string[], k: string) => {
    const i = idx[k] ?? -1;
    return i >= 0 ? (r[i] ?? "").trim() : "";
  };

  const summary: ImportSummary = { batchId: o.batchId, imported: 0, skipped: {}, from: null, to: null };
  const skip = (why: string) => {
    summary.skipped[why] = (summary.skipped[why] ?? 0) + 1;
  };
  let buffer: StoredEvent[] = [];
  let seen = 0;
  const flush = async () => {
    if (!buffer.length) return;
    await store.insertEvents(buffer);
    buffer = [];
  };

  for (const r of rows) {
    if (++seen > IMPORT_MAX_ROWS) {
      skip("over_row_limit");
      continue;
    }
    const ts = parseTs(get(r, "created_at"));
    if (ts === null) {
      skip("bad_timestamp");
      continue;
    }
    if (o.stopAt !== null && ts >= o.stopAt) {
      skip("overlaps_vitrus_data");
      continue;
    }
    const eventId = get(r, "event_id");
    const umamiSession = get(r, "session_id");
    if (!eventId || !umamiSession) {
      skip("missing_id");
      continue;
    }
    const type = get(r, "event_type") === "2" ? "event" : get(r, "event_type") === "1" ? "pageview" : null;
    if (!type) {
      skip("unknown_event_type");
      continue;
    }
    const name = type === "event" ? get(r, "event_name").slice(0, 80) : "pageview";
    if (type === "event" && !name) {
      skip("event_without_name");
      continue;
    }
    const query = get(r, "url_query").replace(/^\?/, "");
    const rawUtm = parseUtm(query);
    const utm = {
      source: get(r, "utm_source").toLowerCase() || rawUtm.source,
      medium: get(r, "utm_medium").toLowerCase() || rawUtm.medium,
      campaign: get(r, "utm_campaign").toLowerCase() || rawUtm.campaign,
      term: get(r, "utm_term").toLowerCase() || rawUtm.term,
      content: get(r, "utm_content").toLowerCase() || rawUtm.content,
    };
    for (const k of Object.keys(utm) as (keyof typeof utm)[]) if (!utm[k]) delete utm[k];
    const refDomain = get(r, "referrer_domain");
    const referrer = refDomain
      ? `https://${refDomain}${get(r, "referrer_path") || "/"}${get(r, "referrer_query") ? "?" + get(r, "referrer_query").replace(/^\?/, "") : ""}`
      : "";
    const ref = classifyReferrer({ referrer, utm, selfHost: o.selfHost });
    const country = get(r, "country").toUpperCase().slice(0, 2);
    const region = get(r, "region");
    const visit = get(r, "visit_id") || umamiSession;

    buffer.push({
      id: `umami:${eventId}`,
      siteId: o.siteId,
      visitorId: await hash(`umami-visitor:${o.siteId}:${umamiSession}`),
      sessionId: `umami-${await hash(`umami-visit:${o.siteId}:${visit}`)}`,
      ts,
      type,
      name,
      path: (get(r, "url_path") || "/").slice(0, 500),
      query: query.slice(0, 500),
      title: get(r, "page_title").slice(0, 300),
      hostname: get(r, "hostname").toLowerCase().slice(0, 200),
      referrer: referrer.slice(0, 500),
      referrerHost: ref.referrerHost,
      channel: ref.channel,
      source: ref.source,
      utm,
      device: deviceOf(get(r, "device")),
      os: osOf(get(r, "os")),
      browser: browserOf(get(r, "browser")),
      screen: get(r, "screen").slice(0, 20),
      lang: get(r, "language").toLowerCase().slice(0, 20),
      country: /^[A-Z]{2}$/.test(country) ? country : "",
      region: country && region ? (region.includes("-") ? region : `${country}-${region}`).toUpperCase().slice(0, 10) : "",
      regionName: "",
      city: country ? get(r, "city").slice(0, 80) : "",
      lat: null,
      lon: null,
      tag: get(r, "tag").slice(0, 60),
      identity: "",
      botKind: "",
      botName: "",
      agentTrust: "human",
      agentSigner: "",
      botSignals: "",
      botScore: 0,
      props: { _import: o.batchId },
    });
    summary.imported++;
    summary.from = summary.from === null ? ts : Math.min(summary.from, ts);
    summary.to = summary.to === null ? ts : Math.max(summary.to, ts);
    if (buffer.length >= 1000) await flush();
  }
  await flush();
  // What the rows above attempted is not what was written: OR IGNORE drops an
  // event already imported (by an earlier batch, which keeps it). The truth is
  // what the database now holds under THIS batch id.
  const written = await store.select<{ n: number; lo: number | null; hi: number | null }>(
    `SELECT COUNT(*) AS n, MIN(ts) AS lo, MAX(ts) AS hi FROM events WHERE site_id = ? AND json_extract(props, '$._import') = ?`,
    [o.siteId, o.batchId]
  );
  const n = Number(written[0]?.n ?? 0);
  if (summary.imported > n) summary.skipped.already_imported = summary.imported - n;
  summary.imported = n;
  summary.from = written[0]?.lo ?? null;
  summary.to = written[0]?.hi ?? null;
  return summary;
}

/** Deletes exactly one batch's rows for one site. Returns how many were removed. */
export async function removeImport(store: Store, siteId: string, batchId: string): Promise<number> {
  const before = await store.select<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE site_id = ? AND json_extract(props, '$._import') = ?`,
    [siteId, batchId]
  );
  await store.exec(`DELETE FROM events WHERE site_id = ? AND json_extract(props, '$._import') = ?`, [siteId, batchId]);
  return Number(before[0]?.n ?? 0);
}
