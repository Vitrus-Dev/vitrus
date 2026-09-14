// packages/core/src/store/sqlite.ts
// bun:sqlite implementasyonu. Kurulacak servis yok; dosya (veya ":memory:") yeter.
// Tests run against a REAL store — no mocks. A mocked store hides schema errors.

import { Database } from "bun:sqlite";
import type { Site, StoredEvent } from "../types.ts";
import { SCHEMA_VERSION, type Store } from "./store.ts";

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sites (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  domain     TEXT NOT NULL,
  vertical   TEXT NOT NULL DEFAULT 'generic',
  privacy_mode TEXT NOT NULL DEFAULT 'standard',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  site_id       TEXT NOT NULL,
  visitor_id    TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  type          TEXT NOT NULL,
  name          TEXT NOT NULL,
  path          TEXT NOT NULL,
  query         TEXT NOT NULL DEFAULT '',
  title         TEXT NOT NULL DEFAULT '',
  referrer      TEXT NOT NULL DEFAULT '',
  referrer_host TEXT NOT NULL DEFAULT '',
  channel       TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT '',
  utm_source    TEXT NOT NULL DEFAULT '',
  utm_medium    TEXT NOT NULL DEFAULT '',
  utm_campaign  TEXT NOT NULL DEFAULT '',
  utm_term      TEXT NOT NULL DEFAULT '',
  utm_content   TEXT NOT NULL DEFAULT '',
  device        TEXT NOT NULL DEFAULT 'unknown',
  os            TEXT NOT NULL DEFAULT 'unknown',
  browser       TEXT NOT NULL DEFAULT 'unknown',
  screen        TEXT NOT NULL DEFAULT '',
  lang          TEXT NOT NULL DEFAULT '',
  country       TEXT NOT NULL DEFAULT '',
  tag           TEXT NOT NULL DEFAULT '',
  identity      TEXT NOT NULL DEFAULT '',
  bot_kind      TEXT NOT NULL DEFAULT '',
  bot_name      TEXT NOT NULL DEFAULT '',
  props         TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_events_site_ts       ON events (site_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_site_sess     ON events (site_id, session_id);
CREATE INDEX IF NOT EXISTS idx_events_site_vis_ts   ON events (site_id, visitor_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_site_chan_ts  ON events (site_id, channel, ts);
CREATE INDEX IF NOT EXISTS idx_events_site_name_ts  ON events (site_id, name, ts);
CREATE INDEX IF NOT EXISTS idx_events_site_bot_ts   ON events (site_id, bot_kind, ts);
CREATE INDEX IF NOT EXISTS idx_events_site_ident_ts ON events (site_id, identity, ts);
`;

interface SiteRow {
  id: string;
  name: string;
  domain: string;
  vertical: string;
  privacy_mode?: string;
  created_at: number;
}

export class SqliteStore implements Store {
  private db: Database;

  constructor(path = ":memory:") {
    this.db = new Database(path, { create: true });
  }

  async init(): Promise<void> {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(DDL);
    const current = await this.getMeta("schema_version");
    if (current === null) await this.setMeta("schema_version", SCHEMA_VERSION);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async upsertSite(site: Site): Promise<void> {
    this.db
      .query(
        `INSERT INTO sites (id, name, domain, vertical, privacy_mode, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, domain = excluded.domain,
           vertical = excluded.vertical, privacy_mode = excluded.privacy_mode`
      )
      .run(site.id, site.name, site.domain, site.vertical, site.privacyMode ?? "standard", site.createdAt);
  }

  async getSite(id: string): Promise<Site | null> {
    const row = this.db.query<SiteRow, [string]>(`SELECT * FROM sites WHERE id = ?`).get(id);
    return row ? toSite(row) : null;
  }

  async listSites(): Promise<Site[]> {
    const rows = this.db.query<SiteRow, []>(`SELECT * FROM sites ORDER BY created_at ASC`).all();
    return rows.map(toSite);
  }

  async findSession(siteId: string, visitorId: string, sinceTs: number): Promise<string | null> {
    const row = this.db
      .query<{ session_id: string }, [string, string, number]>(
        `SELECT session_id FROM events
          WHERE site_id = ? AND visitor_id = ? AND ts >= ?
          ORDER BY ts DESC LIMIT 1`
      )
      .get(siteId, visitorId, sinceTs);
    return row?.session_id ?? null;
  }

  async insertEvent(event: StoredEvent): Promise<void> {
    this.stmtInsert().run(...(eventParams(event) as never[]));
  }

  async insertEvents(events: StoredEvent[]): Promise<void> {
    const stmt = this.stmtInsert();
    const tx = this.db.transaction((list: StoredEvent[]) => {
      for (const e of list) stmt.run(...(eventParams(e) as never[]));
    });
    tx(events);
  }

  async select<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.query(sql).all(...(params as never[])) as T[];
  }

  async exec(sql: string, params: unknown[] = []): Promise<void> {
    if (params.length === 0) this.db.exec(sql);
    else this.db.query(sql).run(...(params as never[]));
  }

  async getMeta(key: string): Promise<string | null> {
    const row = this.db.query<{ value: string }, [string]>(`SELECT value FROM meta WHERE key = ?`).get(key);
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.db
      .query(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  private insertStmt: ReturnType<Database["query"]> | null = null;
  private stmtInsert() {
    if (!this.insertStmt) {
      this.insertStmt = this.db.query(
        `INSERT OR IGNORE INTO events
          (id, site_id, visitor_id, session_id, ts, type, name, path, query, title,
           referrer, referrer_host, channel, source,
           utm_source, utm_medium, utm_campaign, utm_term, utm_content,
           device, os, browser, screen, lang, country, tag, identity, bot_kind, bot_name, props)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
    }
    return this.insertStmt;
  }
}

function toSite(row: SiteRow): Site {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    vertical: (row.vertical as Site["vertical"]) ?? "generic",
    privacyMode: row.privacy_mode === "strict" ? "strict" : "standard",
    createdAt: row.created_at,
  };
}

function eventParams(e: StoredEvent): unknown[] {
  return [
    e.id,
    e.siteId,
    e.visitorId,
    e.sessionId,
    e.ts,
    e.type,
    e.name,
    e.path,
    e.query,
    e.title,
    e.referrer,
    e.referrerHost,
    e.channel,
    e.source,
    e.utm.source ?? "",
    e.utm.medium ?? "",
    e.utm.campaign ?? "",
    e.utm.term ?? "",
    e.utm.content ?? "",
    e.device,
    e.os,
    e.browser,
    e.screen,
    e.lang,
    e.country,
    e.tag,
    e.identity,
    e.botKind,
    e.botName,
    JSON.stringify(e.props ?? {}),
  ];
}
