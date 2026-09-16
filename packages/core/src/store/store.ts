// packages/core/src/store/store.ts
// The storage interface.
//
// DECISION (a deliberate deviation from the original plan): it said "start with
// Postgres"; we start with SQLite. The rationale: the product's first promise is
// a genuinely one-command install, and with SQLite the number of services to
// install is ZERO (bun:sqlite is embedded). That is more than enough for the
// 50-100K pageviews/month target. To keep the door to Postgres open, this
// interface is ASYNC from day one: the SQLite implementation returns resolved
// values, and when a Postgres implementation lands, callers DO NOT CHANGE.
//
// `select` deliberately takes raw SQL: a MetricBundle's evidence IS "the query
// that ran" (see metrics/bundle.ts). Hide the query behind an ORM and the
// evidence disappears.

import type { Site, StoredEvent } from "../types.ts";

export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;

  upsertSite(site: Site): Promise<void>;
  getSite(id: string): Promise<Site | null>;
  listSites(): Promise<Site[]>;

  /** The session id of the most recent event newer than `sinceTs` (used to decide the session window). */
  findSession(siteId: string, visitorId: string, sinceTs: number): Promise<string | null>;

  insertEvent(event: StoredEvent): Promise<void>;
  insertEvents(events: StoredEvent[]): Promise<void>;

  /** The metric engine's only door to the data. Result rows are plain objects. */
  select<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * A statement that returns no rows (INSERT/UPDATE/DELETE/DDL).
   *
   * Why it exists: the cloud layer keeps its own tables (orgs, memberships,
   * quota) in the SAME database — not opening a second connection or service is
   * part of the one-command-install promise. This LEAKS NO multi-tenancy
   * knowledge into core: core has no idea what `exec` is running, it only offers
   * a SQL pipe.
   */
  exec(sql: string, params?: unknown[]): Promise<void>;

  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}

export const SCHEMA_VERSION = "1";
