// packages/core/src/replay.ts
// Session replay — the server half: settings, chunk ingest, storage, listing,
// playback data, deletion and retention.
//
// ═══ WHY THIS EXISTS NOW (and was "never" before) ═══
// The decision log long said replay would not be built because storage and privacy
// cost more than the rest of the product. The owner reversed that on
// 2026-09-24 on three conditions, and each one is enforced HERE rather than
// in the browser, because anyone can edit a browser script:
//
//   1. OPT-IN, OFF BY DEFAULT. A site records nothing until someone with
//      admin rights turns it on. The recorder asks `/api/replay/config` before
//      recording and every chunk is checked again on arrival.
//   2. EVERYTHING MASKED BY DEFAULT. The recorder masks text and inputs (see
//      tracker/src/replay.ts). On arrival we re-mask every input value, drop
//      <script> nodes, `on*` handlers and `javascript:` URLs — so a forged
//      payload can neither carry a typed value in the input channel nor turn
//      the player into a script host.
//   3. DO NOT TRACK AND GLOBAL PRIVACY CONTROL ARE ALWAYS HONOURED, and a site
//      in strict privacy mode cannot enable replay at all.
//
// Grouping: a recording belongs to the same daily-salted visitor hash the
// pageview uses (visitor.ts) and the same 30-minute window, so several page
// loads become ONE replay without any identifier stored in the browser. The
// analytics session is linked when it can be found (`session_id`), which is
// what lets the timeline show the session's custom events.
//
// KNOWN LIMITS (also in the docs):
//   - Page TEXT cannot be re-masked here: only the page knows which subtree it
//     marked `data-vitrus-unmask`. Text masking is a recorder guarantee.
//   - Timing across page loads is reconstructed from server arrival time, so a
//     page boundary can be off by the network latency of one chunk.

import { gzipSync, gunzipSync } from "bun";
import { policyFor } from "./privacy.ts";
import type { Store } from "./store/store.ts";
import { parseUa } from "./ua.ts";
import { SESSION_WINDOW_MS, visitorId } from "./visitor.ts";

export const REPLAY_DDL = `
CREATE TABLE IF NOT EXISTS replay_settings (
  site_id        TEXT PRIMARY KEY,
  enabled        INTEGER NOT NULL DEFAULT 0,
  sample_rate    REAL    NOT NULL DEFAULT 1,
  max_minutes    INTEGER NOT NULL DEFAULT 30,
  retention_days INTEGER NOT NULL DEFAULT 30,
  block_media    INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS replays (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL,
  -- The analytics session this recording belongs to; '' until one is found.
  session_id  TEXT NOT NULL DEFAULT '',
  -- The same daily-salted hash the pageview uses. Never an IP.
  visitor_id  TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  last_at     INTEGER NOT NULL,
  chunks      INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  events      INTEGER NOT NULL DEFAULT 0,
  pages       INTEGER NOT NULL DEFAULT 0,
  clicks      INTEGER NOT NULL DEFAULT 0,
  inputs      INTEGER NOT NULL DEFAULT 0,
  errors      INTEGER NOT NULL DEFAULT 0,
  gaps        INTEGER NOT NULL DEFAULT 0,
  entry_path  TEXT NOT NULL DEFAULT '',
  country     TEXT NOT NULL DEFAULT '',
  device      TEXT NOT NULL DEFAULT 'unknown',
  browser     TEXT NOT NULL DEFAULT 'unknown',
  os          TEXT NOT NULL DEFAULT 'unknown',
  viewport    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS replay_chunks (
  replay_id  TEXT NOT NULL,
  site_id    TEXT NOT NULL,
  page_load  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  t_last     INTEGER NOT NULL,
  bytes      INTEGER NOT NULL,
  -- gzip of the sanitised event array (JSON).
  body       BLOB NOT NULL,
  PRIMARY KEY (replay_id, page_load, seq)
);

CREATE INDEX IF NOT EXISTS idx_replays_site_started ON replays (site_id, started_at);
CREATE INDEX IF NOT EXISTS idx_replays_site_visitor ON replays (site_id, visitor_id, last_at);
CREATE INDEX IF NOT EXISTS idx_replays_site_session ON replays (site_id, session_id);
CREATE INDEX IF NOT EXISTS idx_replay_chunks_site   ON replay_chunks (site_id);
`;

export async function migrateReplay(store: Store): Promise<void> {
  await store.exec(REPLAY_DDL);
}

// ——— Settings ———

export interface ReplaySettings {
  enabled: boolean;
  /** 0..1 — the share of visitors recorded. Decided per visitor per day, deterministically. */
  sampleRate: number;
  /** A recording stops after this many minutes. */
  maxMinutes: number;
  /** Recordings older than this are deleted. */
  retentionDays: number;
  /** Replace every image with a grey box, on top of the always-boxed iframes, canvas and video. */
  blockMedia: boolean;
}

/** Off. Everything else is what you get the moment someone turns it on. */
export const DEFAULT_REPLAY_SETTINGS: Readonly<ReplaySettings> = {
  enabled: false,
  sampleRate: 1,
  maxMinutes: 30,
  retentionDays: 30,
  blockMedia: false,
};

export const REPLAY_BOUNDS = {
  maxMinutes: [1, 120],
  retentionDays: [1, 90],
} as const;

export class ReplayError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400
  ) {
    super(message);
  }
}

interface SettingsRow {
  enabled: number;
  sample_rate: number;
  max_minutes: number;
  retention_days: number;
  block_media: number;
}

export async function getReplaySettings(store: Store, siteId: string): Promise<ReplaySettings> {
  const rows = await store.select<SettingsRow>(
    `SELECT enabled, sample_rate, max_minutes, retention_days, block_media FROM replay_settings WHERE site_id = ?`,
    [siteId]
  );
  const r = rows[0];
  if (!r) return { ...DEFAULT_REPLAY_SETTINGS };
  return {
    enabled: r.enabled === 1,
    sampleRate: r.sample_rate,
    maxMinutes: r.max_minutes,
    retentionDays: r.retention_days,
    blockMedia: r.block_media === 1,
  };
}

/**
 * Validate and store. A value out of range is REFUSED with the field named,
 * never clamped: a retention of 400 days silently becoming 90 is a setting the
 * person believes they have and do not.
 */
export async function setReplaySettings(
  store: Store,
  siteId: string,
  patch: Partial<Record<keyof ReplaySettings, unknown>>,
  now: number
): Promise<ReplaySettings> {
  const site = await store.getSite(siteId);
  if (!site) throw new ReplayError("site not found", 404);
  const cur = await getReplaySettings(store, siteId);
  const next: ReplaySettings = { ...cur };

  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") throw new ReplayError("enabled must be true or false");
    next.enabled = patch.enabled;
  }
  if (patch.sampleRate !== undefined) {
    const n = Number(patch.sampleRate);
    if (typeof patch.sampleRate !== "number" || !Number.isFinite(n) || n <= 0 || n > 1) {
      throw new ReplayError("sampleRate must be a number above 0 and at most 1");
    }
    next.sampleRate = n;
  }
  for (const key of ["maxMinutes", "retentionDays"] as const) {
    if (patch[key] === undefined) continue;
    const n = patch[key];
    const [lo, hi] = REPLAY_BOUNDS[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < lo || n > hi) {
      throw new ReplayError(`${key} must be a whole number from ${lo} to ${hi}`);
    }
    next[key] = n;
  }
  if (patch.blockMedia !== undefined) {
    if (typeof patch.blockMedia !== "boolean") throw new ReplayError("blockMedia must be true or false");
    next.blockMedia = patch.blockMedia;
  }

  // Strict privacy mode exists for teams whose counsel wants the smallest
  // possible footprint. A screen recording is the opposite of that, so the two
  // cannot be combined — and saying so beats a toggle that silently does nothing.
  if (next.enabled && site.privacyMode === "strict") {
    throw new ReplayError("session replay cannot be enabled while the site is in strict privacy mode", 409);
  }

  await store.exec(
    `INSERT INTO replay_settings (site_id, enabled, sample_rate, max_minutes, retention_days, block_media, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(site_id) DO UPDATE SET enabled = excluded.enabled, sample_rate = excluded.sample_rate,
       max_minutes = excluded.max_minutes, retention_days = excluded.retention_days,
       block_media = excluded.block_media, updated_at = excluded.updated_at`,
    [siteId, next.enabled ? 1 : 0, next.sampleRate, next.maxMinutes, next.retentionDays, next.blockMedia ? 1 : 0, now]
  );
  return next;
}

// ——— Request context ———

export interface ReplayRequest {
  siteId: string;
  ip: string;
  userAgent: string;
  now: number;
  headers: Headers;
  country?: string;
}

/**
 * Do Not Track and Global Privacy Control, always honoured for recordings.
 *
 * For aggregate counts a site can turn its DNT check off (`data-do-not-track`
 * = "false"). That override deliberately does NOT reach replay: a recording of
 * one person's visit is not an aggregate.
 */
export function replayOptedOut(headers: Headers): boolean {
  const dnt = headers.get("dnt");
  return dnt === "1" || headers.get("sec-gpc") === "1";
}

/** Deterministic per visitor per day: the same browser gets the same answer on every page load. */
export function sampledIn(visitor: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const n = parseInt(visitor.slice(0, 8), 16);
  return Number.isFinite(n) && n / 0x1_0000_0000 < rate;
}

export type ReplayVerdict =
  | { record: true; maxMs: number; blockMedia: boolean }
  | { record: false; reason: string };

/** What the recorder is told before it records anything. Fails closed. */
export async function replayConfig(store: Store, secret: string, req: ReplayRequest): Promise<ReplayVerdict> {
  const site = await store.getSite(req.siteId);
  if (!site) return { record: false, reason: "site_unknown" };
  if (site.privacyMode === "strict") return { record: false, reason: "strict_privacy_mode" };
  const s = await getReplaySettings(store, req.siteId);
  if (!s.enabled) return { record: false, reason: "replay_disabled" };
  if (replayOptedOut(req.headers)) return { record: false, reason: "do_not_track" };
  const vid = visitorId({ secret, siteId: req.siteId, ip: req.ip, userAgent: req.userAgent, now: req.now });
  if (!sampledIn(vid, s.sampleRate)) return { record: false, reason: "not_sampled" };
  return { record: true, maxMs: s.maxMinutes * 60_000, blockMedia: s.blockMedia };
}

// ——— Decoding and sanitising a chunk ———

export const REPLAY_LIMITS = {
  /** Bytes on the wire (compressed or not). */
  maxBodyBytes: 1_000_000,
  /** Bytes after decompression — a gzip bomb stops here. */
  maxDecodedBytes: 4_000_000,
  maxEventsPerChunk: 20_000,
  maxNodes: 60_000,
  maxDepth: 400,
  /** Events returned to the player for one replay. */
  maxPlaybackEvents: 250_000,
} as const;

/** Decompress with a hard ceiling. `gunzipSync` has no limit, so a stream is counted instead. */
export async function decodeChunk(body: Uint8Array, gzip: boolean): Promise<string | null> {
  if (body.byteLength > REPLAY_LIMITS.maxBodyBytes) return null;
  if (!gzip) return new TextDecoder().decode(body);
  try {
    const stream = new Blob([new Uint8Array(body)]).stream().pipeThrough(new DecompressionStream("gzip"));
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > REPLAY_LIMITS.maxDecodedBytes) {
        await reader.cancel();
        return null;
      }
      parts.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(parts));
  } catch {
    return null;
  }
}

/** Each non-space character becomes "*": the recorder's mask, applied again on arrival. */
export function maskValue(s: string): string {
  return s.replace(/\S/g, "*");
}

const DANGEROUS_TAGS = new Set(["script", "noscript", "iframe", "frame", "object", "embed", "template", "base"]);

function safeAttr(name: string, value: unknown): string | null {
  if (typeof value !== "string" || value.length > 20_000) return null;
  const n = name.toLowerCase();
  if (!/^[a-z_:][\w:.-]*$/i.test(name)) return null;
  if (n.startsWith("on") || n === "srcdoc" || n === "value" || n === "formaction") return null;
  if (/^\s*(javascript|vbscript|data:text\/html)/i.test(value)) return null;
  return value;
}

interface Budget {
  nodes: number;
}

/**
 * Rebuild a serialised node from what we recognise, and nothing else.
 * Unknown keys are dropped; scripts and handlers never survive; an input
 * value is re-masked whatever the client sent.
 */
function cleanNode(raw: unknown, depth: number, budget: Budget): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || depth > REPLAY_LIMITS.maxDepth) return null;
  if (++budget.nodes > REPLAY_LIMITS.maxNodes) return null;
  const n = raw as Record<string, unknown>;
  const i = n.i;
  if (typeof i !== "number" || !Number.isInteger(i) || i <= 0) return null;
  if (typeof n.x === "string") return { i, x: n.x.slice(0, 200_000) };
  if (typeof n.t !== "string" || !/^[a-z][a-z0-9:-]{0,40}$/i.test(n.t)) return null;
  const tag = n.t.toLowerCase();
  const out: Record<string, unknown> = { i, t: tag };
  if (n.s === 1) out.s = 1;
  if (DANGEROUS_TAGS.has(tag) && !Array.isArray(n.b)) {
    // An iframe arrives as a box from the recorder; anything else claiming to
    // be one is replaced by an empty box rather than rendered.
    out.b = [0, 0];
    return out;
  }
  if (Array.isArray(n.b)) {
    out.b = [Math.max(0, Math.min(20_000, Number(n.b[0]) || 0)), Math.max(0, Math.min(20_000, Number(n.b[1]) || 0))];
    const cls = (n.a as Record<string, unknown> | undefined)?.class;
    if (typeof cls === "string") out.a = { class: cls.slice(0, 500) };
    return out;
  }
  if (n.a && typeof n.a === "object") {
    const a: Record<string, string> = {};
    for (const [k, v] of Object.entries(n.a as Record<string, unknown>)) {
      const s = safeAttr(k, v);
      if (s !== null) a[k] = s;
    }
    out.a = a;
  }
  if (typeof n.v === "boolean") out.v = n.v;
  else if (typeof n.v === "string") out.v = maskValue(n.v.slice(0, 10_000));
  if (Array.isArray(n.c)) {
    const c: unknown[] = [];
    for (const ch of n.c) {
      const s = cleanNode(ch, depth + 1, budget);
      if (s) c.push(s);
    }
    if (c.length) out.c = c;
  }
  return out;
}

const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);

/** Event types. The recorder's wire format; the player reads the same numbers. */
export const REPLAY_EVENT = {
  snapshot: 0,
  mutation: 1,
  move: 2,
  click: 3,
  scroll: 4,
  viewport: 5,
  input: 6,
  navigation: 7,
  error: 8,
  gap: 9,
} as const;

function cleanOp(op: unknown, budget: Budget): unknown[] | null {
  if (!Array.isArray(op)) return null;
  const kind = op[0];
  if (kind === "r") return int(op[1]) ? ["r", int(op[1])] : null;
  if (kind === "t") return int(op[1]) && typeof op[2] === "string" ? ["t", int(op[1]), op[2].slice(0, 200_000)] : null;
  if (kind === "at") {
    const id = int(op[1]);
    if (!id || typeof op[2] !== "string") return null;
    if (op[3] === null) return safeAttr(op[2], "") === null ? null : ["at", id, op[2], null];
    const v = safeAttr(op[2], op[3]);
    return v === null ? null : ["at", id, op[2], v];
  }
  if (kind === "a") {
    const parent = int(op[1]);
    const next = int(op[2]) ?? 0;
    const node = cleanNode(op[3], 0, budget);
    return parent && node ? ["a", parent, next, node] : null;
  }
  return null;
}

/**
 * Parse and sanitise a chunk. Returns null when it is not a replay chunk at all
 * (the whole chunk is refused); individual malformed events are dropped.
 */
export function sanitizeChunk(json: string): unknown[][] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length > REPLAY_LIMITS.maxEventsPerChunk) return null;
  const budget: Budget = { nodes: 0 };
  const out: unknown[][] = [];
  for (const e of raw) {
    if (!Array.isArray(e)) continue;
    const t = int(e[0]);
    const type = e[1];
    if (t === null || t < 0 || typeof type !== "number") continue;
    switch (type) {
      case REPLAY_EVENT.snapshot: {
        const node = cleanNode(e[2], 0, budget);
        if (node) out.push([t, 0, node, int(e[3]) ?? 0, int(e[4]) ?? 0, typeof e[5] === "string" ? e[5].slice(0, 500) : ""]);
        break;
      }
      case REPLAY_EVENT.mutation: {
        if (!Array.isArray(e[2])) break;
        const ops = e[2].map((op) => cleanOp(op, budget)).filter((x): x is unknown[] => x !== null);
        if (ops.length) out.push([t, 1, ops]);
        break;
      }
      case REPLAY_EVENT.move:
      case REPLAY_EVENT.viewport:
        out.push([t, type, int(e[2]) ?? 0, int(e[3]) ?? 0]);
        break;
      case REPLAY_EVENT.click:
      case REPLAY_EVENT.scroll:
        out.push([t, type, int(e[2]) ?? 0, int(e[3]) ?? 0, int(e[4]) ?? 0]);
        break;
      case REPLAY_EVENT.input: {
        const id = int(e[2]);
        if (!id) break;
        // The input channel only ever carries a mask or a checkbox state —
        // whatever the client claims, a typed value does not get stored.
        const v = typeof e[3] === "boolean" ? e[3] : maskValue(String(e[3] ?? "").slice(0, 10_000));
        out.push([t, 6, id, v]);
        break;
      }
      case REPLAY_EVENT.navigation:
        if (typeof e[2] === "string") out.push([t, 7, e[2].slice(0, 500)]);
        break;
      case REPLAY_EVENT.error:
        if (typeof e[2] === "string") out.push([t, 8, e[2].slice(0, 200)]);
        break;
      case REPLAY_EVENT.gap:
        if (typeof e[2] === "string") out.push([t, 9, e[2].slice(0, 60)]);
        break;
    }
  }
  return out;
}

// ——— Ingest ———

export interface ReplayHooks {
  /**
   * Asked once, when a chunk would START a new recording. The hosted product
   * meters recordings here; self-hosted has no hook and admits everything.
   * A refusal is returned to the recorder (which stops) with its reason.
   */
  admitNewRecording?: (siteId: string, now: number) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Told after a chunk is stored — for byte accounting. */
  afterStore?: (siteId: string, bytes: number, now: number) => Promise<void>;
}

export type ReplayIngestResult =
  | { ok: true; replayId: string; created: boolean }
  | { ok: false; status: 400 | 404 | 413 | 202 | 429; reason: string };

export interface ReplayChunkInput extends ReplayRequest {
  pageLoad: string;
  seq: number;
  body: Uint8Array;
  gzip: boolean;
}

const lastPurge = new WeakMap<Store, number>();

export async function ingestReplayChunk(
  store: Store,
  secret: string,
  input: ReplayChunkInput,
  hooks: ReplayHooks = {}
): Promise<ReplayIngestResult> {
  const { siteId, now } = input;
  if (!/^[A-Za-z0-9]{8,64}$/.test(input.pageLoad) || !Number.isInteger(input.seq) || input.seq < 0 || input.seq > 1_000_000) {
    return { ok: false, status: 400, reason: "invalid_chunk_address" };
  }
  const site = await store.getSite(siteId);
  if (!site) return { ok: false, status: 404, reason: "site_unknown" };
  // 202 for every deliberate "no": the request was fine, we chose not to keep
  // it, and the recorder stops rather than retrying.
  if (site.privacyMode === "strict") return { ok: false, status: 202, reason: "strict_privacy_mode" };
  const settings = await getReplaySettings(store, siteId);
  if (!settings.enabled) return { ok: false, status: 202, reason: "replay_disabled" };
  if (replayOptedOut(input.headers)) return { ok: false, status: 202, reason: "do_not_track" };

  const vid = visitorId({ secret, siteId, ip: input.ip, userAgent: input.userAgent, now });
  if (!sampledIn(vid, settings.sampleRate)) return { ok: false, status: 202, reason: "not_sampled" };

  if (input.body.byteLength > REPLAY_LIMITS.maxBodyBytes) return { ok: false, status: 413, reason: "chunk_too_large" };
  const json = await decodeChunk(input.body, input.gzip);
  if (json === null) return { ok: false, status: 413, reason: "chunk_undecodable_or_too_large" };
  const events = sanitizeChunk(json);
  if (!events) return { ok: false, status: 400, reason: "invalid_chunk" };
  if (!events.length) return { ok: true, replayId: "", created: false };

  const maxMs = settings.maxMinutes * 60_000;
  const open = await store.select<{ id: string; started_at: number }>(
    `SELECT id, started_at FROM replays WHERE site_id = ? AND visitor_id = ? AND last_at >= ?
      ORDER BY last_at DESC LIMIT 1`,
    [siteId, vid, now - SESSION_WINDOW_MS]
  );
  let replayId = open[0]?.id ?? "";
  let created = false;
  if (open[0] && now - open[0].started_at > maxMs) {
    return { ok: false, status: 202, reason: "max_duration_reached" };
  }
  // The latest client time in this chunk. The chunk describes the `tLast` ms
  // BEFORE it arrived, so a new recording started at `now - tLast`, not `now` —
  // otherwise a one-chunk visit would show as zero seconds long.
  const tLast = events.reduce((m, e) => Math.max(m, e[0] as number), 0);

  // A retried chunk (the response was lost, the recorder sent it again) is
  // acknowledged without being counted twice.
  if (replayId) {
    const dup = await store.select(
      `SELECT 1 FROM replay_chunks WHERE replay_id = ? AND page_load = ? AND seq = ?`,
      [replayId, input.pageLoad, input.seq]
    );
    if (dup.length) return { ok: true, replayId, created: false };
  }

  // The pageview usually lands before the first chunk; when it has not, the
  // link is filled in by a later chunk (see the UPDATE below).
  const sessionId = (await store.findSession(siteId, vid, now - SESSION_WINDOW_MS)) ?? "";

  if (!replayId) {
    if (hooks.admitNewRecording) {
      const admit = await hooks.admitNewRecording(siteId, now);
      if (!admit.ok) return { ok: false, status: 429, reason: admit.reason };
    }
    const policy = policyFor(site.privacyMode);
    const ua = parseUa(input.userAgent);
    const snap = events.find((e) => e[1] === REPLAY_EVENT.snapshot);
    replayId = crypto.randomUUID();
    created = true;
    await store.exec(
      `INSERT INTO replays (id, site_id, session_id, visitor_id, started_at, last_at, entry_path, country, device, browser, os, viewport)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        replayId,
        siteId,
        sessionId,
        vid,
        now - Math.min(tLast, maxMs),
        now,
        snap ? String(snap[5] ?? "") : "",
        policy.storeCountry ? (input.country ?? "").toUpperCase().slice(0, 2) : "",
        ua.device,
        ua.browser,
        ua.os,
        snap ? `${snap[3]}x${snap[4]}` : "",
      ]
    );
  }

  const stored = gzipSync(Buffer.from(JSON.stringify(events)));
  const count = (type: number) => events.filter((e) => e[1] === type).length;
  await store.exec(
    `INSERT OR IGNORE INTO replay_chunks (replay_id, site_id, page_load, seq, ts, t_last, bytes, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [replayId, siteId, input.pageLoad, input.seq, now, tLast, stored.byteLength, stored]
  );
  await store.exec(
    `UPDATE replays SET last_at = ?, chunks = chunks + 1, bytes = bytes + ?, events = events + ?,
       pages = pages + ?, clicks = clicks + ?, inputs = inputs + ?, errors = errors + ?, gaps = gaps + ?,
       session_id = CASE WHEN session_id = '' THEN ? ELSE session_id END
     WHERE id = ? AND site_id = ?`,
    [
      now,
      stored.byteLength,
      events.length,
      count(REPLAY_EVENT.snapshot) + count(REPLAY_EVENT.navigation),
      count(REPLAY_EVENT.click),
      count(REPLAY_EVENT.input),
      count(REPLAY_EVENT.error),
      count(REPLAY_EVENT.gap),
      sessionId,
      replayId,
      siteId,
    ]
  );
  if (hooks.afterStore) await hooks.afterStore(siteId, stored.byteLength, now);

  // Retention runs from the write path, at most hourly per process — the
  // self-hosted server has no scheduler, and a setting that promises deletion
  // has to delete without one.
  if (now - (lastPurge.get(store) ?? 0) > 3_600_000) {
    lastPurge.set(store, now);
    await purgeExpiredReplays(store, now);
  }
  return { ok: true, replayId, created };
}

/** Delete recordings past their site's retention (30 days for a site that never saved settings). */
export async function purgeExpiredReplays(store: Store, now: number): Promise<number> {
  const expired = `SELECT r.id FROM replays r LEFT JOIN replay_settings s ON s.site_id = r.site_id
     WHERE r.started_at < ? - COALESCE(s.retention_days, ${DEFAULT_REPLAY_SETTINGS.retentionDays}) * 86400000`;
  const rows = await store.select<{ id: string }>(expired, [now]);
  if (!rows.length) return 0;
  await store.exec(`DELETE FROM replay_chunks WHERE replay_id IN (${expired})`, [now]);
  await store.exec(`DELETE FROM replays WHERE id IN (${expired})`, [now]);
  return rows.length;
}

// ——— Reading ———

export interface ReplayListFilters {
  from: number;
  to: number;
  minDurationMs?: number;
  minPages?: number;
  country?: string;
  device?: string;
  browser?: string;
  sessionId?: string;
  errorsOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface ReplayRow {
  id: string;
  session_id: string;
  visitor_id: string;
  started_at: number;
  last_at: number;
  duration_ms: number;
  pages: number;
  clicks: number;
  inputs: number;
  errors: number;
  gaps: number;
  events: number;
  bytes: number;
  entry_path: string;
  country: string;
  device: string;
  browser: string;
  os: string;
  viewport: string;
  /** A generated, stable-for-the-day name. Not a person — a label for a hash. */
  name: string;
}

const ROW_COLUMNS = `id, session_id, visitor_id, started_at, last_at, (last_at - started_at) AS duration_ms,
  pages, clicks, inputs, errors, gaps, events, bytes, entry_path, country, device, browser, os, viewport`;

/**
 * The list, with the query that produced it. The count shown above the list
 * is a number like any other in this product, so it comes with its SQL.
 */
export async function listReplays(
  store: Store,
  siteId: string,
  f: ReplayListFilters,
  now: number
): Promise<{ replays: ReplayRow[]; total: number; sql: string; params: unknown[]; retentionDays: number }> {
  const settings = await getReplaySettings(store, siteId);
  // Past retention a recording is gone even if the purge has not run yet.
  const floor = Math.max(f.from, now - settings.retentionDays * 86_400_000);
  const where = ["site_id = ?", "started_at >= ?", "started_at < ?"];
  const params: unknown[] = [siteId, floor, f.to];
  if (f.minDurationMs) {
    where.push("(last_at - started_at) >= ?");
    params.push(f.minDurationMs);
  }
  if (f.minPages) {
    where.push("pages >= ?");
    params.push(f.minPages);
  }
  if (f.errorsOnly) where.push("errors > 0");
  for (const [col, v] of [
    ["country", f.country],
    ["device", f.device],
    ["browser", f.browser],
    ["session_id", f.sessionId],
  ] as const) {
    if (v) {
      where.push(`${col} = ?`);
      params.push(v);
    }
  }
  const limit = Math.min(200, Math.max(1, f.limit ?? 50));
  const offset = Math.max(0, f.offset ?? 0);
  const sql = `SELECT ${ROW_COLUMNS} FROM replays WHERE ${where.join(" AND ")} ORDER BY started_at DESC LIMIT ? OFFSET ?`;
  const rows = await store.select<Omit<ReplayRow, "name">>(sql, [...params, limit, offset]);
  const totalSql = `SELECT COUNT(*) AS n FROM replays WHERE ${where.join(" AND ")}`;
  const total = (await store.select<{ n: number }>(totalSql, params))[0]?.n ?? 0;
  return {
    replays: rows.map((r) => ({ ...r, name: displayName(r.visitor_id) })),
    total,
    sql: totalSql,
    params,
    retentionDays: settings.retentionDays,
  };
}

export interface ReplayMarker {
  t: number;
  kind: "pageview" | "event" | "error";
  label: string;
}

export interface ReplayPlayback {
  replay: ReplayRow;
  /** Events with `t` relative to the start of the recording (ms). */
  events: unknown[][];
  /** The analytics events of the linked session, on the same clock. */
  markers: ReplayMarker[];
  truncated: boolean;
  markersSql: string;
}

export async function loadReplay(store: Store, siteId: string, id: string): Promise<ReplayPlayback | null> {
  const rows = await store.select<Omit<ReplayRow, "name">>(
    `SELECT ${ROW_COLUMNS} FROM replays WHERE id = ? AND site_id = ?`,
    [id, siteId]
  );
  const row = rows[0];
  if (!row) return null;
  const chunks = await store.select<{ page_load: string; seq: number; ts: number; t_last: number; body: Uint8Array }>(
    `SELECT page_load, seq, ts, t_last, body FROM replay_chunks WHERE replay_id = ? AND site_id = ? ORDER BY ts, page_load, seq`,
    [id, siteId]
  );

  // Client timestamps are relative to each page load's own start; the server's
  // arrival time pins each page load to one clock. The earliest estimate wins:
  // it is the one with the least network delay in it.
  const offsets = new Map<string, number>();
  for (const c of chunks) {
    const o = c.ts - c.t_last;
    const cur = offsets.get(c.page_load);
    if (cur === undefined || o < cur) offsets.set(c.page_load, o);
  }
  const all: unknown[][] = [];
  let truncated = false;
  for (const c of chunks) {
    const events = JSON.parse(new TextDecoder().decode(gunzipSync(new Uint8Array(c.body)))) as unknown[][];
    const off = offsets.get(c.page_load) ?? c.ts;
    for (const e of events) {
      if (all.length >= REPLAY_LIMITS.maxPlaybackEvents) {
        truncated = true;
        break;
      }
      e[0] = off + (e[0] as number);
      all.push(e);
    }
  }
  all.sort((a, b) => (a[0] as number) - (b[0] as number));
  const start = (all[0]?.[0] as number | undefined) ?? row.started_at;
  for (const e of all) e[0] = (e[0] as number) - start;
  const end = start + ((all[all.length - 1]?.[0] as number | undefined) ?? 0);

  // web_vitals and scroll are exit summaries the tracker sends as the page
  // closes: they mark nothing a viewer is looking for, so they are left out —
  // in the SQL, so the query shown is the one that decided.
  const markersSql = `SELECT ts, type, name, path FROM events
    WHERE site_id = ? AND session_id = ? AND ts >= ? AND ts <= ?
      AND name NOT IN ('web_vitals', 'scroll') ORDER BY ts LIMIT 2000`;
  const markers: ReplayMarker[] = [];
  if (row.session_id) {
    const evs = await store.select<{ ts: number; type: string; name: string; path: string }>(markersSql, [
      siteId,
      row.session_id,
      start - 5_000,
      end + 5_000,
    ]);
    for (const e of evs) {
      markers.push({
        t: Math.max(0, e.ts - start),
        kind: e.type === "pageview" ? "pageview" : e.name === "error" ? "error" : "event",
        label: e.type === "pageview" ? e.path : `${e.name} · ${e.path}`,
      });
    }
  }
  return { replay: { ...row, name: displayName(row.visitor_id) }, events: all, markers, truncated, markersSql };
}

/** Delete one recording. False when it does not exist on THIS site — the caller answers 404 either way. */
export async function deleteReplay(store: Store, siteId: string, id: string): Promise<boolean> {
  const rows = await store.select<{ id: string }>(`SELECT id FROM replays WHERE id = ? AND site_id = ?`, [id, siteId]);
  if (!rows[0]) return false;
  await store.exec(`DELETE FROM replay_chunks WHERE replay_id = ? AND site_id = ?`, [id, siteId]);
  await store.exec(`DELETE FROM replays WHERE id = ? AND site_id = ?`, [id, siteId]);
  return true;
}

/** Delete every recording of a site — used when replay is switched off with "delete existing". */
export async function deleteAllReplays(store: Store, siteId: string): Promise<number> {
  const n = (await store.select<{ n: number }>(`SELECT COUNT(*) AS n FROM replays WHERE site_id = ?`, [siteId]))[0]?.n ?? 0;
  await store.exec(`DELETE FROM replay_chunks WHERE site_id = ?`, [siteId]);
  await store.exec(`DELETE FROM replays WHERE site_id = ?`, [siteId]);
  return n;
}

// ——— Generated names ———
//
// A list of forty hex hashes is unreadable, so each recording gets a name the
// way Rybbit's replay list does. It is derived from the daily visitor hash, so
// it changes tomorrow like the hash does, and it names nobody.

const ADJ = [
  "Amber", "Azure", "Brisk", "Calm", "Coral", "Crimson", "Dusky", "Eager", "Fleet", "Gentle",
  "Golden", "Hazel", "Indigo", "Jade", "Keen", "Lively", "Lunar", "Mellow", "Misty", "Noble",
  "Olive", "Pale", "Quiet", "Rapid", "Rustic", "Sable", "Silver", "Sunny", "Tidal", "Umber",
  "Velvet", "Wild",
];
const ANIMAL = [
  "Albatross", "Badger", "Beaver", "Bison", "Crane", "Dolphin", "Falcon", "Ferret", "Finch", "Fox",
  "Gecko", "Heron", "Ibex", "Jackal", "Koala", "Lemur", "Lynx", "Marten", "Moose", "Newt",
  "Ocelot", "Otter", "Owl", "Panda", "Puffin", "Quail", "Raven", "Seal", "Stoat", "Tapir",
  "Walrus", "Wren",
];

export function displayName(visitor: string): string {
  const a = parseInt(visitor.slice(0, 4), 16) || 0;
  const b = parseInt(visitor.slice(4, 8), 16) || 0;
  return `${ADJ[a % ADJ.length]} ${ANIMAL[b % ANIMAL.length]}`;
}
