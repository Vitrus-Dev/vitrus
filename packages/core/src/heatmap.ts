// packages/core/src/heatmap.ts
// Click and scroll heatmaps, built from the session recordings a site already
// keeps (replay.ts) — so the browser script does not grow by a byte, and a
// site that never turned replay on records nothing new for this either.
//
// ═══ WHERE THE NUMBERS COME FROM ═══
// The recorder sends, per page load, a full snapshot of the (masked) DOM with
// the viewport size and the page path, then clicks (viewport coordinates),
// document scrolls and resizes. Here, for each page view:
//
//   device     from the viewport width: desktop ≥ 1024, tablet ≥ 640, else mobile
//   a click    → x as a FRACTION of the viewport width (clientX + scrollX) / width,
//                y in document pixels (clientY + scrollY)
//   scroll     → the deepest pixel the view reached: max(scrollY + viewport height)
//
// The page behind the heat is the latest masked snapshot of that page on that
// device class, drawn in the same sandboxed frame the replay player uses.
//
// ═══ LIMITATIONS, STATED ═══
//   * Only recorded visits count, so the map is a SAMPLE: the share the site
//     records (sample rate, opt-in) and nothing else. The result says how many
//     recordings and page views it read.
//   * x is scaled by width and y is not. That is right for layouts that are
//     centred or fluid across one device class and wrong for content that
//     reflows a lot between, say, 1100 px and 1900 px. Grouping by device class
//     is what keeps that error small; it does not remove it.
//   * A single-page app's later routes have no fresh snapshot (the recorder
//     sends mutations, not a new page), so they count clicks and scroll but are
//     drawn over no page — the result says so.
//   * The most recent RECORDINGS_MAX recordings in the range are read. A busy
//     site's map covers its latest recordings, not every one.
//
// This is not SQL alone: the recordings are compressed JSON. The query that
// chose them is returned as evidence, with the counts of what was read.

import { gunzipSync } from "bun";
import type { Store } from "./store/store.ts";
import type { Query } from "./metrics/explore.ts";

export type HeatDevice = "desktop" | "tablet" | "mobile";
export const HEAT_DEVICES: readonly HeatDevice[] = ["desktop", "tablet", "mobile"];
export const RECORDINGS_MAX = 300;
/** Click cells: 1/250 of the width across, 8 px down. */
const X_STEP = 0.004;
const Y_STEP = 8;
/** Scroll reach is reported in bins of this many pixels. */
export const SCROLL_BIN = 100;
const SNAPSHOT_MAX_BYTES = 2_000_000;

export class HeatmapError extends Error {}

export function deviceOf(width: number): HeatDevice {
  return width >= 1024 ? "desktop" : width >= 640 ? "tablet" : "mobile";
}

export interface HeatmapOptions {
  siteId: string;
  from: number;
  to: number;
  /** The page; defaults to the most-viewed recorded page for the device. */
  path?: string;
  device?: string;
}

export interface HeatmapResult {
  path: string | null;
  device: HeatDevice;
  /** Recorded page views per path for this device, most viewed first (the page picker). */
  pages: { path: string; views: number }[];
  recordings: number;
  views: number;
  clicks: number;
  /** [x fraction of width, y px, clicks] — one per cell that was clicked. */
  points: [number, number, number][];
  /** Per bin of `bin` px: how many of `views` reached at least that far down. */
  reach: number[];
  bin: number;
  /** The page to draw under the heat; null when no view of it has a snapshot. */
  snapshot: { snap: unknown; width: number; height: number; at: number } | null;
  /** Page views of this page that came from client-side navigation (no snapshot of their own). */
  spaViews: number;
  evidence: Query<{ id: string; started_at: number }>;
  /** True when more recordings exist in the range than were read. */
  truncated: boolean;
}

interface View {
  path: string;
  device: HeatDevice;
  clicks: [number, number][];
  bottom: number;
  snap: unknown;
  width: number;
  height: number;
  at: number;
  spa: boolean;
}

const RECORDINGS_SQL = `SELECT id, started_at FROM replays
 WHERE site_id = ? AND started_at >= ? AND started_at < ?
 ORDER BY started_at DESC LIMIT ?`;

export async function computeHeatmap(store: Store, o: HeatmapOptions): Promise<HeatmapResult> {
  const device = (o.device ?? "desktop") as HeatDevice;
  if (!HEAT_DEVICES.includes(device)) throw new HeatmapError(`device must be one of ${HEAT_DEVICES.join(", ")}`);
  const params = [o.siteId, o.from, o.to, RECORDINGS_MAX + 1];
  const recs = await store.select<{ id: string; started_at: number }>(RECORDINGS_SQL, params);
  const truncated = recs.length > RECORDINGS_MAX;
  const read = recs.slice(0, RECORDINGS_MAX);

  const views: View[] = [];
  for (const rec of read) {
    const chunks = await store.select<{ page_load: string; seq: number; body: Uint8Array }>(
      `SELECT page_load, seq, body FROM replay_chunks WHERE replay_id = ? AND site_id = ? ORDER BY page_load, seq`,
      [rec.id, o.siteId]
    );
    let load = "";
    let cur: View | null = null;
    let vw = 0, vh = 0, sx = 0, sy = 0;
    const close = () => {
      if (cur) views.push(cur);
      cur = null;
    };
    const open = (path: string, snap: unknown, spa: boolean) => {
      close();
      cur = { path, device: deviceOf(vw), clicks: [], bottom: vh, snap, width: vw, height: vh, at: rec.started_at, spa };
    };
    for (const c of chunks) {
      if (c.page_load !== load) { close(); load = c.page_load; vw = 0; vh = 0; sx = 0; sy = 0; }
      let events: unknown[][];
      try {
        events = JSON.parse(new TextDecoder().decode(gunzipSync(new Uint8Array(c.body)))) as unknown[][];
      } catch {
        continue; // one unreadable chunk does not stop the map
      }
      for (const e of events) {
        const type = e[1];
        if (type === 0) {
          vw = Number(e[3]) || 0; vh = Number(e[4]) || 0; sx = 0; sy = 0;
          open(String(e[5] ?? "/"), e[2], false);
        } else if (type === 7) {
          sy = 0;
          open(String(e[2] ?? "/"), null, true);
        } else if (type === 5) {
          vw = Number(e[2]) || vw; vh = Number(e[3]) || vh;
        } else if (type === 4 && Number(e[2]) === 0) {
          sx = Number(e[3]) || 0; sy = Number(e[4]) || 0;
          const v = cur as View | null;
          if (v) v.bottom = Math.max(v.bottom, sy + vh);
        } else if (type === 3) {
          const v = cur as View | null;
          if (v && vw > 0) v.clicks.push([(Number(e[3]) + sx) / vw, Number(e[4]) + sy]);
        }
      }
    }
    close();
  }

  const forDevice = views.filter((v) => v.device === device && v.width > 0);
  const counts = new Map<string, number>();
  for (const v of forDevice) counts.set(v.path, (counts.get(v.path) ?? 0) + 1);
  const pages = [...counts.entries()].map(([path, n]) => ({ path, views: n })).sort((a, b) => b.views - a.views || a.path.localeCompare(b.path)).slice(0, 100);
  const path = o.path ?? pages[0]?.path ?? null;
  const mine = path === null ? [] : forDevice.filter((v) => v.path === path);

  const cells = new Map<string, [number, number, number]>();
  let clicks = 0;
  for (const v of mine) {
    for (const [x, y] of v.clicks) {
      if (!(x >= 0 && x <= 1.05) || !(y >= 0)) continue;
      const cx = Math.round(Math.min(1, x) / X_STEP) * X_STEP;
      const cy = Math.round(y / Y_STEP) * Y_STEP;
      const k = `${cx}|${cy}`;
      const cell = cells.get(k) ?? [Math.round(cx * 1000) / 1000, cy, 0];
      cell[2]++;
      cells.set(k, cell);
      clicks++;
    }
  }

  const deepest = mine.reduce((m, v) => Math.max(m, v.bottom), 0);
  const bins = Math.min(400, Math.ceil(deepest / SCROLL_BIN));
  const reach: number[] = [];
  for (let b = 0; b < bins; b++) reach.push(mine.filter((v) => v.bottom >= b * SCROLL_BIN).length);

  let snapshot: HeatmapResult["snapshot"] = null;
  for (const v of mine) {
    if (!v.snap) continue;
    if (JSON.stringify(v.snap).length > SNAPSHOT_MAX_BYTES) continue;
    if (!snapshot || v.at > snapshot.at) snapshot = { snap: v.snap, width: v.width, height: v.height, at: v.at };
  }

  return {
    path,
    device,
    pages,
    recordings: read.length,
    views: mine.length,
    clicks,
    points: [...cells.values()].sort((a, b) => b[2] - a[2]).slice(0, 8000),
    reach,
    bin: SCROLL_BIN,
    snapshot,
    spaViews: mine.filter((v) => v.spa).length,
    evidence: { label: "recordings read for the heatmap", sql: RECORDINGS_SQL, params, rows: read },
    truncated,
  };
}
