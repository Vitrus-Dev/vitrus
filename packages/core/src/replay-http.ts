// packages/core/src/replay-http.ts
// The HTTP surface of session replay, shared by the self-hosted server and the
// hosted product so the two cannot drift. Two halves:
//
//   replayPublicRoute — what the visitor's browser calls: the recorder script,
//     its config, and chunk ingest. No authentication (like /api/collect).
//
//   replaySiteApi — what the dashboard calls, for a site id the CALLER has
//     already authorised. It never resolves access itself: the self-hosted
//     server has one operator, and the hosted product passes only a site id
//     that came out of `resolveSite()` (an unknown site and someone else's
//     site then look the same: 404). Writes call `requireWrite()` first.

import { countryFromHeaders } from "./geo.ts";
import {
  REPLAY_LIMITS,
  ReplayError,
  deleteAllReplays,
  deleteReplay,
  getReplaySettings,
  ingestReplayChunk,
  listReplays,
  loadReplay,
  replayConfig,
  setReplaySettings,
  type ReplayHooks,
} from "./replay.ts";
import type { Store } from "./store/store.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}

function clientIp(req: Request): string {
  // Cloudflare's header first. Behind Cloudflare -> Caddy, x-forwarded-for is
  // rewritten by Caddy to the address that connected to IT — a Cloudflare edge
  // that changes from request to request — so one page visit was hashed into
  // up to three visitors (pageview, click, web vitals), each its own session.
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") || "0.0.0.0";
}

export interface PublicReplayOptions {
  store: Store;
  secret: string;
  /** dist/r.js on disk. */
  recorderPath: string;
  hooks?: ReplayHooks;
  now?: number;
}

/** Returns a Response for the replay's public endpoints, or null if the path is not one of them. */
export async function replayPublicRoute(req: Request, url: URL, o: PublicReplayOptions): Promise<Response | null> {
  const path = url.pathname;
  const now = o.now ?? Date.now();

  if (path === "/r.js") {
    const file = Bun.file(o.recorderPath);
    if (!(await file.exists())) {
      return new Response("// replay recorder is not built: run bun run build:tracker", {
        status: 404,
        headers: { "content-type": "application/javascript" },
      });
    }
    return new Response(file, {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "public, max-age=3600",
        ...CORS,
      },
    });
  }

  if (path === "/api/replay/config" && req.method === "GET") {
    const verdict = await replayConfig(o.store, o.secret, {
      siteId: url.searchParams.get("site") ?? "",
      ip: clientIp(req),
      userAgent: req.headers.get("user-agent") ?? "",
      now,
      headers: req.headers,
    });
    // Short cache: turning replay OFF has to take effect within minutes, not
    // an hour. `no-store` would cost a request on every page view.
    return json(verdict, 200, { ...CORS, "cache-control": "private, max-age=60" });
  }

  if (path === "/api/replay/chunk" && req.method === "POST") {
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > REPLAY_LIMITS.maxBodyBytes) return json({ ok: false, reason: "chunk_too_large" }, 413, CORS);
    const body = new Uint8Array(await req.arrayBuffer());
    const res = await ingestReplayChunk(
      o.store,
      o.secret,
      {
        siteId: url.searchParams.get("site") ?? "",
        pageLoad: url.searchParams.get("page") ?? "",
        seq: Number(url.searchParams.get("seq") ?? -1),
        gzip: url.searchParams.get("enc") === "gzip",
        body,
        ip: clientIp(req),
        userAgent: req.headers.get("user-agent") ?? "",
        now,
        headers: req.headers,
        country: countryFromHeaders(req.headers),
      },
      o.hooks
    );
    if (res.ok) return new Response(null, { status: 204, headers: CORS });
    return json({ ok: false, reason: res.reason, stop: true }, res.status, CORS);
  }

  return null;
}

export interface SiteReplayOptions {
  store: Store;
  /** Already authorised by the caller. */
  siteId: string;
  /** Throws when the caller may not change settings or delete. */
  requireWrite: () => void;
  now?: number;
  /** Extra fields for the list response (the hosted product adds its usage). */
  extra?: () => Promise<Record<string, unknown>>;
}

const DAY = 86_400_000;

/**
 * `/api/replays` (list), `/api/replays/:id` (playback, DELETE) and
 * `/api/replay/settings` (GET, PUT). Null when the path is none of these.
 */
export async function replaySiteApi(req: Request, url: URL, o: SiteReplayOptions): Promise<Response | null> {
  const path = url.pathname;
  const now = o.now ?? Date.now();

  if (path === "/api/replay/settings") {
    if (req.method === "GET") return json({ settings: await getReplaySettings(o.store, o.siteId) });
    if (req.method === "PUT" || req.method === "POST") {
      o.requireWrite();
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") return json({ ok: false, reason: "invalid_json" }, 400);
      try {
        const settings = await setReplaySettings(o.store, o.siteId, body, now);
        // Turning replay off can also delete what was recorded — asked for
        // explicitly, never implied: "off" alone keeps recordings until their
        // retention runs out, and the dashboard says so.
        let deleted = 0;
        if (body.deleteExisting === true) deleted = await deleteAllReplays(o.store, o.siteId);
        return json({ ok: true, settings, deleted });
      } catch (e) {
        if (e instanceof ReplayError) return json({ ok: false, reason: e.message }, e.status);
        throw e;
      }
    }
    return null;
  }

  if (path === "/api/replays" && req.method === "GET") {
    const q = url.searchParams;
    const days = Math.min(90, Math.max(1, Math.round(Number(q.get("days") ?? 7)) || 7));
    const list = await listReplays(
      o.store,
      o.siteId,
      {
        from: now - days * DAY,
        to: now + 60_000,
        minDurationMs: Math.max(0, Number(q.get("minDuration") ?? 0) || 0) * 1000,
        minPages: Math.max(0, Number(q.get("minPages") ?? 0) || 0),
        country: (q.get("country") ?? "").toUpperCase().slice(0, 2) || undefined,
        device: q.get("device") || undefined,
        browser: q.get("browser") || undefined,
        sessionId: q.get("session") || undefined,
        errorsOnly: q.get("errors") === "1",
        limit: Number(q.get("limit") ?? 50) || 50,
        offset: Number(q.get("offset") ?? 0) || 0,
      },
      now
    );
    const settings = await getReplaySettings(o.store, o.siteId);
    return json({ ...list, settings, ...(o.extra ? await o.extra() : {}) });
  }

  const m = path.match(/^\/api\/replays\/([0-9a-f-]{36})$/);
  if (m) {
    const id = m[1] as string;
    if (req.method === "GET") {
      const p = await loadReplay(o.store, o.siteId, id);
      return p ? json(p) : json({ ok: false, reason: "replay not found" }, 404);
    }
    if (req.method === "DELETE") {
      o.requireWrite();
      return (await deleteReplay(o.store, o.siteId, id))
        ? json({ ok: true })
        : json({ ok: false, reason: "replay not found" }, 404);
    }
  }
  return null;
}
