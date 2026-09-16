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
