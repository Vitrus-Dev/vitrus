// packages/core/test/signals-pipeline.test.ts
//
// signals.test.ts covers the RULES. This covers what happens to them after:
// that they survive ingest, survive storage, survive an upgrade of an existing
// database — and above all that they change no number until somebody asks.
//
// The last one is the property worth defending. A detection layer that quietly
// removes traffic is indistinguishable, from the customer's side, from a bug
// that loses traffic. So "the default totals are byte-identical with and
// without the layer" is pinned below, and it should stay pinned.

import { describe, expect, test } from "bun:test";
import { Ingestor } from "../src/ingest.ts";
import { buildBundle, windowOf } from "../src/metrics/bundle.ts";
import { HUMAN, HUMAN_STRICT, METRICS, SUSPECT_SCORE } from "../src/metrics/queries.ts";
import { SUSPECT_AT } from "../src/signals.ts";
import { SqliteStore } from "../src/store/sqlite.ts";

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const SITE = "s1";
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const REAL_BROWSER = {
  accept: "*/*",
  "accept-language": "en-GB,en;q=0.9",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "cross-site",
  "sec-fetch-dest": "empty",
  "sec-ch-ua": '"Chromium";v="140"',
  "sec-ch-ua-platform": '"macOS"',
};

/** The events table exactly as it was before this layer existed. */
const LEGACY_EVENTS = `CREATE TABLE events (
  id TEXT PRIMARY KEY, site_id TEXT NOT NULL, visitor_id TEXT NOT NULL,
  session_id TEXT NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL,
  name TEXT NOT NULL, path TEXT NOT NULL, query TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '', referrer TEXT NOT NULL DEFAULT '',
  referrer_host TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '', utm_source TEXT NOT NULL DEFAULT '',
  utm_medium TEXT NOT NULL DEFAULT '', utm_campaign TEXT NOT NULL DEFAULT '',
  utm_term TEXT NOT NULL DEFAULT '', utm_content TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '', os TEXT NOT NULL DEFAULT '',
  browser TEXT NOT NULL DEFAULT '', screen TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '',
  tag TEXT NOT NULL DEFAULT '', identity TEXT NOT NULL DEFAULT '',
  bot_kind TEXT NOT NULL DEFAULT '', bot_name TEXT NOT NULL DEFAULT '',
  props TEXT NOT NULL DEFAULT '{}'
)`;

async function fresh() {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.upsertSite({ id: SITE, name: "S", domain: "s.example", vertical: "landing", createdAt: 0 });
  return store;
}

function ingestor(store: SqliteStore) {
  return new Ingestor(store, { secret: "salt" });
}

async function send(
  store: SqliteStore,
  headers: Record<string, string | undefined>,
  over: { ip?: string; path?: string } = {}
) {
  return ingestor(store).ingest(
    { site: SITE, type: "pageview", url: `https://s.example${over.path ?? "/"}` },
    {
      ip: over.ip ?? "203.0.113.9",
      userAgent: CHROME,
      now: NOW - 60_000,
      host: "s.example",
      agent: { headers },
    }
  );
}

describe("the two halves of the bar agree", () => {
  test("the SQL threshold equals the TypeScript threshold", () => {
    // One is a number in a query string and one is a constant in a module;
    // nothing but this test stops them drifting apart, and a drift would mean
    // the dashboard disagreeing with the ingest that produced it.
    expect(SUSPECT_SCORE).toBe(SUSPECT_AT);
  });
});

describe("signals survive the pipeline", () => {
  test("a real browser stores an empty signal list and a zero score", async () => {
    const store = await fresh();
    const res = await send(store, REAL_BROWSER);
    expect(res.ok).toBe(true);
    const rows = await store.select<{ bot_signals: string; bot_score: number }>(
      "SELECT bot_signals, bot_score FROM events"
    );
    expect(rows[0]?.bot_signals).toBe("");
    expect(rows[0]?.bot_score).toBe(0);
  });

  test("a script wearing a Chrome user-agent stores which rules fired", async () => {
    const store = await fresh();
    await send(store, {});
    const rows = await store.select<{ bot_signals: string; bot_score: number }>(
      "SELECT bot_signals, bot_score FROM events"
    );
    // Not just a score: the score without the rule names is a number nobody
    // can check, which is the thing this product refuses to ship.
    expect(rows[0]?.bot_signals.split(",").sort()).toEqual([
      "chromium-without-client-hints",
      "no-accept",
      "no-accept-language",
      "no-fetch-metadata",
    ]);
    expect(rows[0]?.bot_score).toBeGreaterThanOrEqual(SUSPECT_SCORE);
  });

  test("it is still labelled a human visit — the layer accuses nobody at ingest", async () => {
    const store = await fresh();
    await send(store, {});
    const rows = await store.select<{ agent_trust: string; bot_kind: string; device: string }>(
      "SELECT agent_trust, bot_kind, device FROM events"
    );
    // Rewriting agent_trust here would hide the event from the default view
    // with no way for the operator to find out. The verdict stays separate
    // from the observation on purpose.
    expect(rows[0]?.agent_trust).toBe("human");
    expect(rows[0]?.bot_kind).toBe("");
    expect(rows[0]?.device).not.toBe("bot");
  });
});

describe("nothing is removed unless asked", () => {
  test("default totals are identical whether or not signals fired", async () => {
    const clean = await fresh();
    const dirty = await fresh();
    for (const [store, headers] of [
      [clean, REAL_BROWSER],
      [dirty, {}],
    ] as const) {
      await send(store, headers, { ip: "198.51.100.1" });
      await send(store, headers, { ip: "198.51.100.2" });
    }
    const win = windowOf(NOW, 7, "last 7 days");
    const a = await buildBundle(clean, { siteId: SITE, window: win, now: NOW });
    const b = await buildBundle(dirty, { siteId: SITE, window: win, now: NOW });
    const value = (x: typeof a, m: string) => x.evidence.find((e) => e.metric === m)?.value;
    for (const m of ["visitors.unique", "sessions.total", "pageviews.total"]) {
      expect(value(b, m), `${m} must not change just because a signal fired`).toBe(value(a, m));
    }
  });

  test("but the suspects are counted, so the operator can see them", async () => {
    const store = await fresh();
    await send(store, {}, { ip: "198.51.100.1" });
    await send(store, REAL_BROWSER, { ip: "198.51.100.2" });
    const b = await buildBundle(store, { siteId: SITE, window: windowOf(NOW, 7, "last 7 days"), now: NOW });
    expect(b.evidence.find((e) => e.metric === "bots.suspected")?.value).toBe(1);
  });

  test("and the breakdown names the rule, not just a total", async () => {
    const store = await fresh();
    await send(store, {}, { ip: "198.51.100.1" });
    const b = await buildBundle(store, { siteId: SITE, window: windowOf(NOW, 7, "last 7 days"), now: NOW });
    const e = b.evidence.find((x) => x.metric === "bots.signal_rules")!;
    expect(String(e.rows[0]?.signals)).toContain("no-accept-language");
    expect(e.rows[0]?.visitors).toBe(1);
  });
});

describe("strict mode is opt-in and shows its work", () => {
  const win = () => windowOf(NOW, 7, "last 7 days");

  test("asking for it excludes the suspects", async () => {
    const store = await fresh();
    await send(store, {}, { ip: "198.51.100.1" });
    await send(store, REAL_BROWSER, { ip: "198.51.100.2" });
    const normal = await buildBundle(store, { siteId: SITE, window: win(), now: NOW });
    const strict = await buildBundle(store, { siteId: SITE, window: win(), now: NOW, strictBots: true });
    expect(normal.evidence.find((e) => e.metric === "visitors.unique")?.value).toBe(2);
    expect(strict.evidence.find((e) => e.metric === "visitors.unique")?.value).toBe(1);
  });

  test("the evidence carries the predicate that did the excluding", async () => {
    const store = await fresh();
    await send(store, REAL_BROWSER);
    const strict = await buildBundle(store, { siteId: SITE, window: win(), now: NOW, strictBots: true });
    const e = strict.evidence.find((x) => x.metric === "visitors.unique")!;
    // The user can read the query and see exactly why a visitor is missing.
    expect(e.sql).toContain(`bot_score < ${SUSPECT_SCORE}`);
  });

  test("off by default — the same call without the flag keeps everyone", async () => {
    const store = await fresh();
    await send(store, REAL_BROWSER);
    const b = await buildBundle(store, { siteId: SITE, window: win(), now: NOW });
    expect(b.evidence.find((x) => x.metric === "visitors.unique")!.sql).not.toContain("bot_score");
  });

  test("strict mode never turns the suspect count itself into zero", async () => {
    // HUMAN_STRICT is a textual rewrite of HUMAN. A metric whose predicate
    // happened to match HUMAN verbatim became `bot_score < 5 AND bot_score >= 5`
    // — always zero, and the one number the operator was looking at.
    const store = await fresh();
    await send(store, {});
    const strict = await buildBundle(store, { siteId: SITE, window: win(), now: NOW, strictBots: true });
    expect(strict.evidence.find((e) => e.metric === "bots.suspected")?.value).toBe(1);
  });

  test("no metric contains a contradictory score predicate after the rewrite", async () => {
    for (const def of METRICS) {
      const rewritten = def.sql.split(HUMAN).join(HUMAN_STRICT);
      const contradiction = rewritten.includes("bot_score <") && rewritten.includes("bot_score >=");
      expect(contradiction, `${def.id} rewrites into a query that can never match`).toBe(false);
    }
  });
});

describe("an existing database upgrades without losing its data", () => {
  test("a table created before the columns existed gains them", async () => {
    // The production failure this guards: CREATE TABLE IF NOT EXISTS does not
    // reconcile columns, so a new column is missing on every box that already
    // had the table. It cost a 500 on every site creation for a day.
    const store = new SqliteStore(":memory:");
    await store.exec(LEGACY_EVENTS);
    await store.exec(
      `INSERT INTO events (id, site_id, visitor_id, session_id, ts, type, name, path)
       VALUES ('old','${SITE}','v','s',${NOW - 60_000},'pageview','pageview','/')`
    );

    await store.init();

    const cols = await store.select<{ name: string }>("PRAGMA table_info(events)");
    const names = cols.map((c) => c.name);
    expect(names).toContain("bot_signals");
    expect(names).toContain("bot_score");

    // The pre-existing row is still there and defaults to "no signals", which
    // is the honest reading: we did not observe anything about it.
    const rows = await store.select<{ bot_signals: string; bot_score: number }>(
      "SELECT bot_signals, bot_score FROM events WHERE id = 'old'"
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.bot_score).toBe(0);
  });

  test("the upgraded database can then be queried for suspects", async () => {
    // Ordering regression: an index over a column the migration had not added
    // yet crashed the service into a restart loop on boot.
    const store = new SqliteStore(":memory:");
    await store.exec(LEGACY_EVENTS);
    await store.init();
    const rows = await store.select<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events WHERE bot_score >= ${SUSPECT_SCORE}`
    );
    expect(rows[0]?.n).toBe(0);
  });
});
