// packages/core/test/replay.test.ts — session replay, server half. Real store, no mocks.
import { describe, expect, test } from "bun:test";
import { gzipSync } from "bun";
import {
  deleteReplay,
  displayName,
  getReplaySettings,
  ingestReplayChunk,
  listReplays,
  loadReplay,
  purgeExpiredReplays,
  replayConfig,
  sampledIn,
  sanitizeChunk,
  setReplaySettings,
  type ReplayHooks,
} from "../src/replay.ts";
import { CHROME, DAY, MIN, SITE, freshStore, ingestorFor, send } from "./helpers.ts";
import type { SqliteStore } from "../src/store/sqlite.ts";

const SECRET = "test-secret";
const T0 = Date.UTC(2026, 8, 24, 10, 0, 0);
const IP = "203.0.113.7";

const SNAP = {
  i: 1,
  t: "html",
  a: {},
  c: [
    { i: 2, t: "head", a: {}, c: [] },
    { i: 3, t: "body", a: {}, c: [{ i: 4, t: "p", a: {}, c: [{ i: 5, x: "***** *****" }] }, { i: 6, t: "input", a: {}, v: "****" }] },
  ],
};

function body(events: unknown[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(events));
}

function chunk(
  store: SqliteStore,
  o: { now: number; events: unknown[]; page?: string; seq?: number; ip?: string; headers?: Headers; gzip?: boolean; raw?: Uint8Array },
  hooks?: ReplayHooks
) {
  const raw = o.raw ?? body(o.events);
  return ingestReplayChunk(
    store,
    SECRET,
    {
      siteId: SITE.id,
      ip: o.ip ?? IP,
      userAgent: CHROME,
      now: o.now,
      headers: o.headers ?? new Headers(),
      country: "DE",
      pageLoad: o.page ?? "pageloadaaaa",
      seq: o.seq ?? 0,
      body: o.gzip ? gzipSync(Buffer.from(raw)) : raw,
      gzip: !!o.gzip,
    },
    hooks
  );
}

async function enabledStore(extra: Record<string, unknown> = {}): Promise<SqliteStore> {
  const store = await freshStore();
  await setReplaySettings(store, SITE.id, { enabled: true, ...extra }, T0);
  return store;
}

describe("replay settings", () => {
  test("off by default — nothing is recorded until someone turns it on", async () => {
    const store = await freshStore();
    expect((await getReplaySettings(store, SITE.id)).enabled).toBe(false);
    const cfg = await replayConfig(store, SECRET, { siteId: SITE.id, ip: IP, userAgent: CHROME, now: T0, headers: new Headers() });
    expect(cfg).toEqual({ record: false, reason: "replay_disabled" });
    const r = await chunk(store, { now: T0, events: [[0, 0, SNAP, 1280, 800, "/"]] });
    expect(r).toMatchObject({ ok: false, status: 202, reason: "replay_disabled" });
    expect((await store.select(`SELECT * FROM replays`)).length).toBe(0);
  });

  test("out-of-range values are refused with the field named, never clamped", async () => {
    const store = await freshStore();
    await expect(setReplaySettings(store, SITE.id, { retentionDays: 400 }, T0)).rejects.toThrow("retentionDays");
    await expect(setReplaySettings(store, SITE.id, { maxMinutes: 0 }, T0)).rejects.toThrow("maxMinutes");
    await expect(setReplaySettings(store, SITE.id, { sampleRate: 1.5 }, T0)).rejects.toThrow("sampleRate");
    await expect(setReplaySettings(store, SITE.id, { enabled: "yes" }, T0)).rejects.toThrow("enabled");
  });

  test("a strict-privacy site cannot enable replay, and says why", async () => {
    const store = await freshStore({ ...SITE, privacyMode: "strict" });
    await expect(setReplaySettings(store, SITE.id, { enabled: true }, T0)).rejects.toThrow("strict privacy mode");
  });
});

describe("replay config — consent and sampling", () => {
  const req = (headers = new Headers()) => ({ siteId: SITE.id, ip: IP, userAgent: CHROME, now: T0, headers });

  test("enabled: record, with the site's limits", async () => {
    const store = await enabledStore({ maxMinutes: 10, blockMedia: true });
    expect(await replayConfig(store, SECRET, req())).toEqual({ record: true, maxMs: 600_000, blockMedia: true });
  });

  test("Do Not Track and Global Privacy Control are always honoured", async () => {
    const store = await enabledStore();
    expect(await replayConfig(store, SECRET, req(new Headers({ dnt: "1" })))).toMatchObject({ record: false, reason: "do_not_track" });
    expect(await replayConfig(store, SECRET, req(new Headers({ "sec-gpc": "1" })))).toMatchObject({ record: false });
    const r = await chunk(store, { now: T0, events: [[0, 0, SNAP, 1, 1, "/"]], headers: new Headers({ dnt: "1" }) });
    expect(r).toMatchObject({ ok: false, reason: "do_not_track" });
  });

  test("sampling is deterministic per visitor and roughly honours the rate", () => {
    let inside = 0;
    for (let i = 0; i < 2000; i++) {
      const v = (i * 2654435761 >>> 0).toString(16).padStart(8, "0") + "0".repeat(24);
      if (sampledIn(v, 0.25)) inside++;
      expect(sampledIn(v, 0.25)).toBe(sampledIn(v, 0.25));
    }
    expect(inside).toBeGreaterThan(400);
    expect(inside).toBeLessThan(600);
  });
});

describe("replay ingest", () => {
  test("stores a chunk and groups page loads of one visitor into ONE replay", async () => {
    const store = await enabledStore();
    const a = await chunk(store, { now: T0, events: [[0, 0, SNAP, 1280, 800, "/pricing"], [500, 3, 4, 10, 10]] });
    expect(a).toMatchObject({ ok: true, created: true });
    const b = await chunk(store, { now: T0 + 60_000, page: "pageloadbbbb", events: [[0, 0, SNAP, 1280, 800, "/signup"]] });
    expect(b).toMatchObject({ ok: true, created: false });
    const rows = await store.select<{ pages: number; clicks: number; chunks: number; entry_path: string; country: string; viewport: string }>(
      `SELECT * FROM replays`
    );
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ pages: 2, clicks: 1, chunks: 2, entry_path: "/pricing", country: "DE", viewport: "1280x800" });
  });

  test("after 30 minutes of silence a new replay starts", async () => {
    const store = await enabledStore();
    await chunk(store, { now: T0, events: [[0, 0, SNAP, 1, 1, "/"]] });
    const r = await chunk(store, { now: T0 + 31 * MIN, page: "pageloadcccc", events: [[0, 0, SNAP, 1, 1, "/"]] });
    expect(r).toMatchObject({ ok: true, created: true });
    expect((await store.select(`SELECT id FROM replays`)).length).toBe(2);
  });

  test("the maximum length stops a recording", async () => {
    const store = await enabledStore({ maxMinutes: 2 });
    await chunk(store, { now: T0, events: [[0, 0, SNAP, 1, 1, "/"]] });
    await chunk(store, { now: T0 + 1 * MIN, seq: 1, events: [[60_000, 2, 1, 1]] });
    const r = await chunk(store, { now: T0 + 3 * MIN, seq: 2, events: [[180_000, 2, 1, 1]] });
    expect(r).toMatchObject({ ok: false, status: 202, reason: "max_duration_reached" });
  });

  test("a refused new recording is reported, not stored — and an existing one continues", async () => {
    const store = await enabledStore();
    let calls = 0;
    const no: ReplayHooks = {
      admitNewRecording: async () => {
        calls++;
        return { ok: false, reason: "limit_reached" };
      },
    };
    const r = await chunk(store, { now: T0, events: [[0, 0, SNAP, 1, 1, "/"]] }, no);
    expect(r).toMatchObject({ ok: false, status: 429, reason: "limit_reached" });
    expect((await store.select(`SELECT id FROM replays`)).length).toBe(0);

    await chunk(store, { now: T0, ip: "198.51.100.1", events: [[0, 0, SNAP, 1, 1, "/"]] });
    const more = await chunk(store, { now: T0 + 5000, ip: "198.51.100.1", seq: 1, events: [[5000, 2, 1, 1]] }, no);
    expect(more.ok).toBe(true);
    expect(calls).toBe(1); // only asked when a recording would START
  });

  test("gzip bodies are accepted; a decompression bomb is refused", async () => {
    const store = await enabledStore();
    const ok = await chunk(store, { now: T0, gzip: true, events: [[0, 0, SNAP, 1, 1, "/"]] });
    expect(ok.ok).toBe(true);
    const bomb = gzipSync(Buffer.from("[" + " ".repeat(8_000_000) + "]"));
    expect(bomb.byteLength).toBeLessThan(1_000_000);
    const r = await chunk(store, { now: T0 + 1000, seq: 1, events: [], raw: bomb, gzip: false });
    // Sent raw-but-claimed-plain it is simply invalid JSON; claimed as gzip it must hit the ceiling.
    expect(r.ok).toBe(false);
    const r2 = await ingestReplayChunk(store, SECRET, {
      siteId: SITE.id, ip: IP, userAgent: CHROME, now: T0 + 2000, headers: new Headers(),
      pageLoad: "pageloadaaaa", seq: 2, body: bomb, gzip: true,
    });
    expect(r2).toMatchObject({ ok: false, status: 413 });
  });

  test("malformed chunk addresses are refused", async () => {
    const store = await enabledStore();
    expect(await chunk(store, { now: T0, page: "x", events: [] })).toMatchObject({ ok: false, status: 400 });
    expect(await chunk(store, { now: T0, seq: -1, events: [] })).toMatchObject({ ok: false, status: 400 });
  });

  test("the analytics session is linked", async () => {
    const store = await enabledStore();
    const pv = await send(ingestorFor(store), { now: T0 - 1000, url: "/pricing" });
    if (!pv.ok) throw new Error("pageview failed");
    await chunk(store, { now: T0, events: [[0, 0, SNAP, 1, 1, "/pricing"]] });
    const rows = await store.select<{ session_id: string }>(`SELECT session_id FROM replays`);
    expect(rows[0]!.session_id).toBe(pv.event.sessionId);
  });
});

describe("replay sanitising — a forged payload cannot carry a value or a script", () => {
  test("input values are re-masked on arrival, in events and in snapshots", () => {
    const out = sanitizeChunk(
      JSON.stringify([
        [0, 0, { i: 1, t: "input", a: { value: "hunter2" }, v: "hunter2" }, 1, 1, "/"],
        [10, 6, 1, "hunter2"],
        [20, 1, [["a", 1, 0, { i: 2, t: "textarea", v: "hunter2" }]]],
      ])
    )!;
    const s = JSON.stringify(out);
    expect(s).not.toContain("hunter2");
    expect(s).toContain('"*******"');
  });

  test("scripts, handlers and javascript: URLs never survive", () => {
    const out = sanitizeChunk(
      JSON.stringify([
        [
          0,
          0,
          {
            i: 1,
            t: "div",
            a: { onclick: "alert(1)", ONMOUSEOVER: "x()", href: "javascript:alert(1)", class: "ok" },
            c: [
              { i: 2, t: "script", a: {}, c: [{ i: 3, x: "alert(1)" }] },
              { i: 4, t: "iframe", a: { srcdoc: "<script>alert(1)</script>" } },
              { i: 5, t: "a", a: { href: " JaVaScRiPt:alert(1)" } },
            ],
          },
          1,
          1,
          "/",
        ],
        [5, 1, [["at", 1, "onload", "alert(1)"], ["at", 5, "href", "javascript:x"], ["a", 1, 0, { i: 6, t: "script" }]]],
      ])
    )!;
    const s = JSON.stringify(out);
    expect(s).not.toContain("alert");
    expect(s).not.toMatch(/javascript/i);
    expect(s).not.toMatch(/"on[a-z]+"/i);
    expect(s).toContain('"class":"ok"');
  });

  test("not a chunk at all → refused whole", () => {
    expect(sanitizeChunk("{}")).toBeNull();
    expect(sanitizeChunk("nope")).toBeNull();
  });
});

describe("replay reading, deleting and retention", () => {
  async function recorded(): Promise<{ store: SqliteStore; id: string; sessionId: string }> {
    const store = await enabledStore();
    const ing = ingestorFor(store);
    const pv = await send(ing, { now: T0 - 500, url: "/pricing" });
    await send(ing, { now: T0 + 3000, type: "event", name: "signup_click", url: "/pricing" });
    if (!pv.ok) throw new Error("pageview failed");
    const r = await chunk(store, { now: T0 + 1000, events: [[0, 0, SNAP, 1280, 800, "/pricing"], [1000, 3, 4, 5, 5]] });
    await chunk(store, { now: T0 + 6000, seq: 1, events: [[6000, 2, 3, 3], [6000, 8, "TypeError: x"]] });
    if (!r.ok) throw new Error(r.reason);
    return { store, id: r.replayId, sessionId: pv.event.sessionId };
  }

  test("playback events share one clock that starts at zero, with the session's events as markers", async () => {
    const { store, id } = await recorded();
    const p = (await loadReplay(store, SITE.id, id))!;
    expect(p.events[0]![0]).toBe(0);
    expect(p.events.map((e) => e[0])).toEqual([0, 1000, 6000, 6000]);
    expect(p.markers.some((m) => m.label.startsWith("signup_click"))).toBe(true);
    expect(p.replay.name).toBe(displayName(p.replay.visitor_id));
  });

  test("the list carries its SQL, filters narrow it, and it can find a replay by session", async () => {
    const { store, sessionId } = await recorded();
    const all = await listReplays(store, SITE.id, { from: T0 - DAY, to: T0 + DAY }, T0);
    expect(all.total).toBe(1);
    expect(all.sql).toContain("FROM replays WHERE site_id = ?");
    expect((await listReplays(store, SITE.id, { from: T0 - DAY, to: T0 + DAY, minPages: 5 }, T0)).total).toBe(0);
    expect((await listReplays(store, SITE.id, { from: T0 - DAY, to: T0 + DAY, errorsOnly: true }, T0)).total).toBe(1);
    expect((await listReplays(store, SITE.id, { from: T0 - DAY, to: T0 + DAY, sessionId }, T0)).total).toBe(1);
    expect((await listReplays(store, SITE.id, { from: T0 - DAY, to: T0 + DAY, country: "US" }, T0)).total).toBe(0);
  });

  test("another site's id cannot read or delete a replay", async () => {
    const { store, id } = await recorded();
    await store.upsertSite({ ...SITE, id: "other", domain: "other.example" });
    expect(await loadReplay(store, "other", id)).toBeNull();
    expect(await deleteReplay(store, "other", id)).toBe(false);
    expect(await loadReplay(store, SITE.id, id)).not.toBeNull();
  });

  test("deletion removes the replay and every chunk", async () => {
    const { store, id } = await recorded();
    expect(await deleteReplay(store, SITE.id, id)).toBe(true);
    expect((await store.select(`SELECT * FROM replay_chunks`)).length).toBe(0);
    expect(await loadReplay(store, SITE.id, id)).toBeNull();
  });

  test("retention: hidden from the list at once, purged by the sweep", async () => {
    const { store } = await recorded();
    await setReplaySettings(store, SITE.id, { retentionDays: 1 }, T0);
    const later = T0 + 2 * DAY;
    expect((await listReplays(store, SITE.id, { from: T0 - DAY, to: later }, later)).total).toBe(0);
    expect(await purgeExpiredReplays(store, later)).toBe(1);
    expect((await store.select(`SELECT * FROM replay_chunks`)).length).toBe(0);
  });
});

describe("replay bookkeeping — found in a real-browser run", () => {
  test("a one-chunk visit is as long as its content, not zero seconds", async () => {
    const store = await enabledStore();
    await chunk(store, { now: T0, events: [[0, 0, SNAP, 1, 1, "/"], [9500, 3, 4, 1, 1]] });
    const rows = await listReplays(store, SITE.id, { from: T0 - DAY, to: T0 + DAY }, T0);
    expect(rows.replays[0]!.duration_ms).toBe(9500);
  });

  test("a retried chunk is acknowledged but not counted twice", async () => {
    const store = await enabledStore();
    await chunk(store, { now: T0, events: [[0, 0, SNAP, 1, 1, "/"], [100, 3, 4, 1, 1]] });
    const again = await chunk(store, { now: T0 + 50, events: [[0, 0, SNAP, 1, 1, "/"], [100, 3, 4, 1, 1]] });
    expect(again.ok).toBe(true);
    const row = (await store.select<{ clicks: number; chunks: number }>(`SELECT clicks, chunks FROM replays`))[0]!;
    expect(row).toEqual({ clicks: 1, chunks: 1 });
  });

  test("exit summaries are not timeline markers — and the SQL says so", async () => {
    const store = await enabledStore();
    const ing = ingestorFor(store);
    await send(ing, { now: T0 - 100, url: "/" });
    await send(ing, { now: T0 + 500, type: "event", name: "web_vitals", url: "/" });
    await send(ing, { now: T0 + 600, type: "event", name: "signup", url: "/" });
    const r = await chunk(store, { now: T0 + 1000, events: [[0, 0, SNAP, 1, 1, "/"], [1000, 2, 1, 1]] });
    if (!r.ok) throw new Error(r.reason);
    const p = (await loadReplay(store, SITE.id, r.replayId))!;
    expect(p.markers.map((m) => m.label)).toEqual(["/", "signup · /"]);
    expect(p.markersSql).toContain("NOT IN ('web_vitals', 'scroll')");
  });
});
