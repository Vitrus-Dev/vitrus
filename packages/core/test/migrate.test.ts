// packages/core/test/migrate.test.ts
// Schema migration on a database that already exists.
//
// This file exists because of a production outage: `sites.privacy_mode` was
// added to the DDL, `CREATE TABLE IF NOT EXISTS` did nothing on the live
// database, and every attempt to add a site failed with a 500 for a day.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "../src/store/sqlite.ts";
import type { Site } from "../src/types.ts";

const SITE: Site = { id: "s1", name: "Site", domain: "site.example", vertical: "landing", createdAt: 1 };

/** A database in the shape it had BEFORE privacy_mode was introduced. */
function legacyDb(path: string): void {
  const db = new Database(path, { create: true });
  db.exec(`CREATE TABLE sites (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT NOT NULL,
    vertical TEXT NOT NULL DEFAULT 'generic', created_at INTEGER NOT NULL)`);
  db.exec(`INSERT INTO sites (id, name, domain, vertical, created_at)
           VALUES ('old', 'Old site', 'old.example', 'landing', 1)`);
  db.close();
}

describe("adding a column to a table that already shipped", () => {
  test("upsertSite works on a database created before privacy_mode existed", async () => {
    const path = `/tmp/vitrus-migrate-${crypto.randomUUID().slice(0, 8)}.db`;
    legacyDb(path);

    const store = new SqliteStore(path);
    await store.init();

    // Before the fix this threw: "table sites has no column named privacy_mode".
    // In production it surfaced as `internal_error` with no hint what was wrong.
    await store.upsertSite(SITE);
    const back = await store.getSite("s1");
    expect(back?.domain).toBe("site.example");

    await store.close();
  });

  test("the existing row survives and gets the default", async () => {
    const path = `/tmp/vitrus-migrate-${crypto.randomUUID().slice(0, 8)}.db`;
    legacyDb(path);

    const store = new SqliteStore(path);
    await store.init();

    const rows = await store.select<{ id: string; privacy_mode: string }>(
      `SELECT id, privacy_mode FROM sites WHERE id = 'old'`
    );
    // Not dropped and recreated — the row is still there, with the default.
    expect(rows[0]?.id).toBe("old");
    expect(rows[0]?.privacy_mode).toBe("standard");

    await store.close();
  });

  test("running init twice does not fail on the added column", async () => {
    const path = `/tmp/vitrus-migrate-${crypto.randomUUID().slice(0, 8)}.db`;
    legacyDb(path);

    const a = new SqliteStore(path);
    await a.init();
    await a.close();

    // A restart must not crash on boot. `ALTER TABLE ... ADD COLUMN` throws if
    // the column is already there, so the check has to happen every time.
    const b = new SqliteStore(path);
    await b.init();
    await b.upsertSite(SITE);
    await b.close();
  });

  test("a fresh database already has every column, and the migration is a no-op", async () => {
    const store = new SqliteStore(":memory:");
    await store.init();
    await store.upsertSite(SITE);
    const cols = await store.select<{ name: string }>(`PRAGMA table_info(sites)`);
    expect(cols.map((c) => c.name)).toContain("privacy_mode");
    await store.close();
  });
});

describe("a legacy events table", () => {
  /** The events table as it was BEFORE agent_trust and agent_signer existed. */
  function legacyEvents(path: string): void {
    const db = new Database(path, { create: true });
    db.exec(`CREATE TABLE events (
      id TEXT PRIMARY KEY, site_id TEXT NOT NULL, visitor_id TEXT NOT NULL,
      session_id TEXT NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL,
      name TEXT NOT NULL, path TEXT NOT NULL, query TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', referrer TEXT NOT NULL DEFAULT '',
      referrer_host TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '', utm_source TEXT NOT NULL DEFAULT '',
      utm_medium TEXT NOT NULL DEFAULT '', utm_campaign TEXT NOT NULL DEFAULT '',
      utm_term TEXT NOT NULL DEFAULT '', utm_content TEXT NOT NULL DEFAULT '',
      device TEXT NOT NULL DEFAULT 'unknown', os TEXT NOT NULL DEFAULT 'unknown',
      browser TEXT NOT NULL DEFAULT 'unknown', screen TEXT NOT NULL DEFAULT '',
      lang TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '',
      tag TEXT NOT NULL DEFAULT '', identity TEXT NOT NULL DEFAULT '',
      bot_kind TEXT NOT NULL DEFAULT '', bot_name TEXT NOT NULL DEFAULT '',
      props TEXT NOT NULL DEFAULT '{}')`);
    db.exec(`INSERT INTO events (id, site_id, visitor_id, session_id, ts, type, name, path, channel)
             VALUES ('e1','s1','v1','sess1',1,'pageview','pageview','/','direct')`);
    db.close();
  }

  test("init succeeds on a database that predates the agent columns", async () => {
    // Production found this one: the new index on events(agent_trust) shipped in
    // the same release as the column, `CREATE TABLE IF NOT EXISTS` did nothing
    // on the live table, and every start crashed with "no such column". A fresh
    // install was fine, which is exactly why the first test missed it.
    const path = `/tmp/vitrus-events-${crypto.randomUUID().slice(0, 8)}.db`;
    legacyEvents(path);

    const store = new SqliteStore(path);
    await store.init();

    const cols = await store.select<{ name: string }>(`PRAGMA table_info(events)`);
    expect(cols.map((c) => c.name)).toContain("agent_trust");
    expect(cols.map((c) => c.name)).toContain("agent_signer");
    await store.close();
  });

  test("the index that needed the new column exists afterwards", async () => {
    const path = `/tmp/vitrus-events-${crypto.randomUUID().slice(0, 8)}.db`;
    legacyEvents(path);
    const store = new SqliteStore(path);
    await store.init();
    const idx = await store.select<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'`
    );
    // Creating it before the migration is what crashed; skipping it entirely
    // would be the other easy wrong fix.
    expect(idx.map((i) => i.name)).toContain("idx_events_site_trust_ts");
    await store.close();
  });

  test("the existing row survives and defaults to human", async () => {
    const path = `/tmp/vitrus-events-${crypto.randomUUID().slice(0, 8)}.db`;
    legacyEvents(path);
    const store = new SqliteStore(path);
    await store.init();
    const rows = await store.select<{ id: string; agent_trust: string }>(
      `SELECT id, agent_trust FROM events`
    );
    expect(rows[0]?.id).toBe("e1");
    expect(rows[0]?.agent_trust).toBe("human");
    await store.close();
  });

  test("the location columns are added, and an old row's coordinates are NULL, not 0", async () => {
    // (0, 0) is a real place. An old row's location is UNKNOWN, and the globe
    // must not plot every pre-migration session in the Gulf of Guinea.
    const path = `/tmp/vitrus-events-${crypto.randomUUID().slice(0, 8)}.db`;
    legacyEvents(path);
    const store = new SqliteStore(path);
    await store.init();
    const cols = (await store.select<{ name: string }>(`PRAGMA table_info(events)`)).map((c) => c.name);
    for (const c of ["region", "region_name", "city", "lat", "lon"]) expect(cols).toContain(c);
    const rows = await store.select<{ city: string; lat: number | null; lon: number | null }>(
      `SELECT city, lat, lon FROM events WHERE id = 'e1'`
    );
    expect(rows[0]).toEqual({ city: "", lat: null, lon: null });
    await store.close();
  });

  test("a restart on the migrated database does not crash", async () => {
    const path = `/tmp/vitrus-events-${crypto.randomUUID().slice(0, 8)}.db`;
    legacyEvents(path);
    const a = new SqliteStore(path);
    await a.init();
    await a.close();
    const b = new SqliteStore(path);
    await b.init();
    await b.close();
  });
});
