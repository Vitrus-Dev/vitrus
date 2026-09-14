// packages/server/src/server.ts
// A single process: ingest + the query API + the tracker script + the dashboard.
// There is NO second service to install (see the decision in store/store.ts).

import {
  Ingestor,
  SqliteStore,
  computeFunnel,
  computeRetention,
  countryFromHeaders,
  defaultFunnel,
  FunnelError,
  buildBundle,
  composeDigest,
  previousWindow,
  renderText,
  windowOf,
  type Site,
  type Store,
} from "@vitrus/core";
import { dashboardHtml } from "./dashboard.ts";

export interface ServerOptions {
  store: Store;
  /** The secret salt for the visitor hash. */
  secret: string;
  port?: number;
  /** Path to the tracker script on disk (the build output). */
  trackerPath?: string;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}

/** The real client IP. Behind a proxy, the FIRST value of x-forwarded-for is used. */
export function clientIp(req: Request, fallback = "0.0.0.0"): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || fallback;
}

export function createHandler(opts: ServerOptions): (req: Request) => Promise<Response> {
  const ingestor = new Ingestor(opts.store, { secret: opts.secret });
  const trackerPath = opts.trackerPath ?? new URL("../../tracker/dist/v.js", import.meta.url).pathname;

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (path === "/health") {
      return json({ ok: true, service: "vitrus", ts: Date.now() });
    }

    // — Tracker script'i —
    if (path === "/v.js" || path === "/vitrus.js") {
      const file = Bun.file(trackerPath);
      if (!(await file.exists())) {
        return new Response("// tracker not built: bun run build:tracker", {
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

    // — Ingest —
    if (path === "/api/collect" && req.method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ ok: false, reason: "invalid_json" }, 400, CORS);
      }
      const res = await ingestor.ingest(body, {
        ip: clientIp(req),
        userAgent: req.headers.get("user-agent") ?? "",
        now: Date.now(),
        host: url.hostname,
        country: countryFromHeaders(req.headers),
      });
      if (!res.ok) return json({ ok: false, reason: res.reason }, res.status, CORS);
      // The body is deliberately empty: the tracker never reads the response, so why spend the bytes.
      return new Response(null, { status: 204, headers: CORS });
    }

    // — Siteler —
    if (path === "/api/sites" && req.method === "GET") {
      return json({ sites: await opts.store.listSites() });
    }

    // — The metric bundle (with evidence) —
    if (path === "/api/stats") {
      const siteId = url.searchParams.get("site") ?? "";
      const days = clampDays(url.searchParams.get("days"));
      const site = await opts.store.getSite(siteId);
      if (!site) return json({ ok: false, reason: "site_unknown" }, 404);
      const bundle = await bundleFor(opts.store, site, days);
      return json(bundle);
    }

    // — Digest (deterministik; LLM yok) —
    if (path === "/api/digest") {
      const siteId = url.searchParams.get("site") ?? "";
      const days = clampDays(url.searchParams.get("days"));
      const site = await opts.store.getSite(siteId);
      if (!site) return json({ ok: false, reason: "site_unknown" }, 404);
      const bundle = await bundleFor(opts.store, site, days);
      const digest = composeDigest(bundle);
      if (url.searchParams.get("format") === "text") {
        return new Response(renderText(digest), { headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      return json({ digest, evidence: bundle.evidence });
    }

    // — Huni —
    if (path === "/api/funnel") {
      const siteId = url.searchParams.get("site") ?? "";
      const site = await opts.store.getSite(siteId);
      if (!site) return json({ ok: false, reason: "site_unknown" }, 404);
      const days = clampDays(url.searchParams.get("days"));
      const win = windowOf(Date.now(), days, `last ${days} days`);
      let steps = defaultFunnel(site.vertical);
      const raw = url.searchParams.get("steps");
      if (raw) {
        try {
          steps = JSON.parse(raw);
        } catch {
          return json({ ok: false, reason: "steps_invalid_json" }, 400);
        }
      }
      try {
        const funnel = await computeFunnel((sql, params) => opts.store.select(sql, params), {
          siteId: site.id,
          from: win.from,
          to: win.to,
          steps,
        });
        return json({ funnel, window: win, steps });
      } catch (e) {
        if (e instanceof FunnelError) return json({ ok: false, reason: e.message }, 400);
        throw e;
      }
    }

    // — Retention —
    if (path === "/api/retention") {
      const siteId = url.searchParams.get("site") ?? "";
      const site = await opts.store.getSite(siteId);
      if (!site) return json({ ok: false, reason: "site_unknown" }, 404);
      const days = clampDays(url.searchParams.get("days"));
      const win = windowOf(Date.now(), days, `last ${days} days`);
      const retention = await computeRetention((sql, params) => opts.store.select(sql, params), {
        siteId: site.id,
        from: win.from,
        to: win.to,
      });
      return json({ retention, window: win });
    }

    // — Panel —
    if (path === "/" || path === "/index.html") {
      const sites = await opts.store.listSites();
      return new Response(dashboardHtml(sites), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return json({ ok: false, reason: "not_found" }, 404);
  };
}

function clampDays(raw: string | null): number {
  const n = Number(raw ?? 7);
  if (!Number.isFinite(n)) return 7;
  return Math.min(365, Math.max(1, Math.round(n)));
}

async function bundleFor(store: Store, site: Site, days: number) {
  const win = windowOf(Date.now(), days, `last ${days} days`);
  return buildBundle(store, {
    siteId: site.id,
    vertical: site.vertical,
    window: win,
    compare: previousWindow(win),
  });
}

export async function startServer(opts: ServerOptions) {
  const handle = createHandler(opts);
  const server = Bun.serve({
    port: opts.port ?? 3000,
    fetch: handle,
  });
  return server;
}

/** Direct execution via `bun run src/server.ts`. */
if (import.meta.main) {
  const dbPath = process.env.VITRUS_DB ?? "./vitrus.db";
  const store = new SqliteStore(dbPath);
  await store.init();
  let secret = await store.getMeta("visitor_secret");
  if (!secret) {
    secret = crypto.randomUUID() + crypto.randomUUID();
    await store.setMeta("visitor_secret", secret);
  }
  const port = Number(process.env.PORT ?? 3000);
  const server = await startServer({ store, secret, port });
  console.log(`vitrus → http://localhost:${server.port}  (db: ${dbPath})`);
}
