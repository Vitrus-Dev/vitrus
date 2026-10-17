// packages/core/test/heatmap.test.ts
// Heatmaps from recordings. The claims:
//   1. A click lands where it was on the PAGE: viewport point + scroll, x as a
//      fraction of the width; page views are split by path and device class.
//   2. Scroll reach counts how many views got at least that far down.
//   3. The page drawn underneath is the latest snapshot of that page/device;
//      a client-side navigation counts but has no snapshot of its own.
//   4. Nothing recorded → an empty, honest answer, not an error.

import { gzipSync } from "bun";
import { describe, expect, test } from "bun:test";
import { computeHeatmap, deviceOf, HeatmapError, SCROLL_BIN } from "../src/heatmap.ts";
import { DAY, SITE, freshStore } from "./helpers.ts";
import type { SqliteStore } from "../src/store/sqlite.ts";

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const SNAP = (label: string) => ({ i: 1, t: "html", c: [{ i: 2, t: "body", c: [{ i: 3, x: label }] }] });

async function record(store: SqliteStore, id: string, at: number, loads: unknown[][][]) {
  await store.exec(`INSERT INTO replays (id, site_id, visitor_id, started_at, last_at) VALUES (?, ?, 'v', ?, ?)`, [id, SITE.id, at, at + 60_000]);
  let n = 0;
  for (const events of loads) {
    const body = gzipSync(Buffer.from(JSON.stringify(events)));
    await store.exec(`INSERT INTO replay_chunks (replay_id, site_id, page_load, seq, ts, t_last, bytes, body) VALUES (?, ?, ?, 0, ?, 0, ?, ?)`,
      [id, SITE.id, `pl-${n++}`, at, body.byteLength, body]);
  }
}

const heat = (store: SqliteStore, o: Record<string, string> = {}) => computeHeatmap(store, { siteId: SITE.id, from: NOW - 7 * DAY, to: NOW, ...o });

describe("computeHeatmap", () => {
  test("device classes follow the viewport width", () => {
    expect(deviceOf(1440)).toBe("desktop");
    expect(deviceOf(800)).toBe("tablet");
    expect(deviceOf(390)).toBe("mobile");
  });

  test("clicks land at viewport point + scroll; views split by path and device; latest snapshot wins", async () => {
    const store = await freshStore();
    // Desktop, /pricing: a click at the top, then a scroll and a click lower down.
    await record(store, "r1", NOW - 2 * DAY, [[
      [0, 0, SNAP("old"), 1250, 800, "/pricing"],
      [100, 3, 5, 500, 100],
      [200, 4, 0, 0, 1200],
      [300, 3, 6, 250, 100],
    ]]);
    // A newer desktop view of /pricing that never scrolls, and a mobile view.
    await record(store, "r2", NOW - DAY, [
      [[0, 0, SNAP("new"), 1250, 800, "/pricing"], [50, 3, 5, 500, 100]],
      [[0, 0, SNAP("m"), 390, 700, "/pricing"], [10, 3, 5, 195, 50]],
    ]);
    // Desktop home page, then a client-side navigation to /pricing (no new snapshot).
    await record(store, "r3", NOW - 3 * DAY, [[
      [0, 0, SNAP("home"), 1250, 800, "/"],
      [100, 7, "/pricing"],
      [200, 3, 9, 100, 300],
    ]]);

    const r = await heat(store, { path: "/pricing" });
    expect(r.device).toBe("desktop");
    expect(r.recordings).toBe(3);
    expect(r.views).toBe(3);
    expect(r.spaViews).toBe(1);
    expect(r.clicks).toBe(4);
    const cells = Object.fromEntries(r.points.map(([x, y, n]) => [`${x},${y}`, n]));
    expect(cells["0.4,104"]).toBe(2); // the same spot in two views (y rounds to the nearest 8 px)
    expect(cells["0.2,1304"]).toBe(1); // 100 + 1200 scrolled
    expect(cells["0.08,304"]).toBe(1);
    // Reach: all 3 views saw the first 800 px; only one got to 2000.
    expect(r.reach[0]).toBe(3);
    expect(r.reach[Math.floor(1900 / SCROLL_BIN)]).toBe(1);
    expect(r.snapshot?.snap).toEqual(SNAP("new"));
    expect(r.snapshot?.width).toBe(1250);
    // The page picker for desktop: /pricing (3 views) before / (1).
    expect(r.pages).toEqual([{ path: "/pricing", views: 3 }, { path: "/", views: 1 }]);

    const m = await heat(store, { path: "/pricing", device: "mobile" });
    expect(m.views).toBe(1);
    expect(m.points).toEqual([[0.5, 48, 1]]);
    expect(m.snapshot?.snap).toEqual(SNAP("m"));
    expect(r.evidence.sql).toContain("FROM replays");
  });

  test("without a path it picks the most-viewed page; nothing recorded is an empty answer", async () => {
    const empty = await heat(await freshStore());
    expect(empty).toMatchObject({ path: null, views: 0, clicks: 0, snapshot: null, points: [], reach: [] });
    await expect(heat(await freshStore(), { device: "watch" })).rejects.toThrow(HeatmapError);
  });
});
