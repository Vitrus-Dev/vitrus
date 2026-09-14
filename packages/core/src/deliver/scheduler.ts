// packages/core/src/deliver/scheduler.ts
// The digest scheduler.
//
// ═══ THE MOST IMPORTANT PROPERTY: NEVER SEND TWICE ═══
// Receiving the weekly summary twice is worse than not receiving it at all: the
// first time you conclude the tool is broken, the second time you unsubscribe.
// So every delivery is written to a LEDGER keyed by
// `<site>:<channel>:<target>:<period>`.
//
// The ledger rule:
//   **A FAILED DELIVERY IS NEVER WRITTEN TO THE LEDGER.** If it were, a network
//   error would turn into a permanent "sent" record and the user would never see
//   that week. By not writing it, the next tick tries again.
//
// The second rule: **AN EMPTY DIGEST IS NOT SENT.** Emailing "0 visitors" about
// a site with no traffic is notification fatigue, and it gets the tool muted.

import type { Store } from "../store/store.ts";
import type { Digest } from "../insight/compose.ts";

export const DELIVERY_DDL = `
CREATE TABLE IF NOT EXISTS digest_subscriptions (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- slack | email | webhook
  target      TEXT NOT NULL,
  -- 'weekly' | 'daily'
  cadence     TEXT NOT NULL DEFAULT 'weekly',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

-- The delivery ledger. If the key collides, the delivery is SKIPPED.
CREATE TABLE IF NOT EXISTS digest_log (
  key         TEXT PRIMARY KEY,       -- <site>:<kind>:<target>:<periodStart>
  site_id     TEXT NOT NULL,
  sent_at     INTEGER NOT NULL,
  lines       INTEGER NOT NULL,
  degraded    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_digest_subs_site ON digest_subscriptions (site_id, enabled);
CREATE INDEX IF NOT EXISTS idx_digest_log_site  ON digest_log (site_id, sent_at);
`;

export type Cadence = "weekly" | "daily";

export interface Subscription {
  id: string;
  siteId: string;
  kind: "slack" | "email" | "webhook";
  target: string;
  cadence: Cadence;
  enabled: boolean;
  createdAt: number;
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/**
 * The start of a period. For weekly, MONDAY 00:00 UTC.
 *
 * Why a fixed boundary: "7 days after the last delivery" drifts — one late
 * server start and the digest goes out slightly later every week until it lands
 * on an arbitrary day. A calendar boundary is fixed, and two servers running at
 * the same moment produce the same key.
 */
export function periodStart(now: number, cadence: Cadence): number {
  if (cadence === "daily") return Math.floor(now / DAY_MS) * DAY_MS;
  // 1 Jan 1970 was a Thursday; shift to align the week to Monday.
  const shifted = now + 3 * DAY_MS;
  return Math.floor(shifted / WEEK_MS) * WEEK_MS - 3 * DAY_MS;
}

/** The data window this period covers (from the previous period start to this one). */
export function windowForPeriod(period: number, cadence: Cadence): { from: number; to: number } {
  const span = cadence === "daily" ? DAY_MS : WEEK_MS;
  return { from: period - span, to: period };
}

export function deliveryKey(sub: Subscription, period: number): string {
  return `${sub.siteId}:${sub.kind}:${sub.target}:${period}`;
}

export async function migrateDelivery(store: Store): Promise<void> {
  await store.exec(DELIVERY_DDL);
}

export async function addSubscription(
  store: Store,
  input: { siteId: string; kind: Subscription["kind"]; target: string; cadence?: Cadence },
  now: number
): Promise<Subscription> {
  const sub: Subscription = {
    id: `sub_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    siteId: input.siteId,
    kind: input.kind,
    target: input.target,
    cadence: input.cadence ?? "weekly",
    enabled: true,
    createdAt: now,
  };
  await store.exec(
    `INSERT INTO digest_subscriptions (id, site_id, kind, target, cadence, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
    [sub.id, sub.siteId, sub.kind, sub.target, sub.cadence, sub.createdAt]
  );
  return sub;
}

interface SubRow {
  id: string;
  site_id: string;
  kind: string;
  target: string;
  cadence: string;
  enabled: number;
  created_at: number;
}

function toSub(r: SubRow): Subscription {
  return {
    id: r.id,
    siteId: r.site_id,
    kind: r.kind as Subscription["kind"],
    target: r.target,
    cadence: r.cadence as Cadence,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
  };
}

export async function listSubscriptions(store: Store, siteId?: string): Promise<Subscription[]> {
  const rows = siteId
    ? await store.select<SubRow>(`SELECT * FROM digest_subscriptions WHERE site_id = ? ORDER BY created_at`, [siteId])
    : await store.select<SubRow>(`SELECT * FROM digest_subscriptions WHERE enabled = 1 ORDER BY created_at`);
  return rows.map(toSub);
}

export async function removeSubscription(store: Store, id: string): Promise<void> {
  await store.exec(`DELETE FROM digest_subscriptions WHERE id = ?`, [id]);
}

export async function alreadySent(store: Store, key: string): Promise<boolean> {
  const rows = await store.select<{ key: string }>(`SELECT key FROM digest_log WHERE key = ?`, [key]);
  return rows.length > 0;
}

/** Called ONLY after a successful delivery. */
export async function recordSent(store: Store, key: string, siteId: string, digest: Digest, now: number): Promise<void> {
  await store.exec(
    `INSERT OR IGNORE INTO digest_log (key, site_id, sent_at, lines, degraded) VALUES (?, ?, ?, ?, ?)`,
    [key, siteId, now, digest.lines.length, digest.degraded ? 1 : 0]
  );
}

/**
 * Whether a digest is worth sending.
 *
 * An empty digest is not sent. The test is not "line count" but whether there is
 * DATA: the deterministic composer produces a headline even for a site with no
 * traffic ("0 visitors, 0 sessions"), and that line alone does not deserve an
 * email.
 */
export function worthSending(digest: Digest, visitors: number): boolean {
  if (visitors <= 0) return false;
  return digest.lines.length > 1;
}

export type TickOutcome =
  | { status: "sent"; key: string }
  | { status: "skipped"; key: string; reason: "already_sent" | "empty" | "disabled" }
  | { status: "failed"; key: string; error: string };

export interface TickDeps {
  store: Store;
  now: number;
  /** The digest builder — given a window, returns the digest plus the visitor count. */
  build: (siteId: string, from: number, to: number) => Promise<{ digest: Digest; visitors: number }>;
  /** The channel sender. On failure it returns `{ok:false}` and the ledger is NOT written. */
  deliver: (sub: Subscription, digest: Digest) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * One tick: walks every enabled subscription and sends the ones whose period has
 * arrived and which have not been sent yet.
 */
export async function tick(deps: TickDeps): Promise<TickOutcome[]> {
  const subs = await listSubscriptions(deps.store);
  const out: TickOutcome[] = [];

  for (const sub of subs) {
    if (!sub.enabled) {
      out.push({ status: "skipped", key: sub.id, reason: "disabled" });
      continue;
    }
    const period = periodStart(deps.now, sub.cadence);
    const key = deliveryKey(sub, period);

    if (await alreadySent(deps.store, key)) {
      out.push({ status: "skipped", key, reason: "already_sent" });
      continue;
    }

    const win = windowForPeriod(period, sub.cadence);
    const { digest, visitors } = await deps.build(sub.siteId, win.from, win.to);

    if (!worthSending(digest, visitors)) {
      // An empty period is NOT written to the ledger: if data arrives later
      // (late ingest), the next tick looks again. It just is not retried within
      // this same tick.
      out.push({ status: "skipped", key, reason: "empty" });
      continue;
    }

    const res = await deps.deliver(sub, digest);
    if (!res.ok) {
      // We do NOT write to the ledger — the next tick retries.
      out.push({ status: "failed", key, error: res.error ?? "unknown" });
      continue;
    }

    await recordSent(deps.store, key, sub.siteId, digest, deps.now);
    out.push({ status: "sent", key });
  }

  return out;
}
