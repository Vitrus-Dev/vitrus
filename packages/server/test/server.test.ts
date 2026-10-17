import { describe, expect, test } from "bun:test";
import { SqliteStore, type Site } from "@vitrus/core";
import { dashboardHtml } from "../src/dashboard.ts";
import { clientIp, createHandler } from "../src/server.ts";

const SITE: Site = { id: "demo", name: "Demo", domain: "example.com", vertical: "landing", createdAt: 0 };
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

async function harness() {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.upsertSite(SITE);
  return { store, handle: createHandler({ store, secret: "s" }) };
}

function collect(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/collect", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": CHROME, ...headers },
    body: JSON.stringify(body),
  });
}

describe("clientIp", () => {
  test("x-vitrus-client-ip wins: behind a customer's proxy, cf-connecting-ip is the proxy", () => {
    const req = new Request("http://x/", {
      headers: { "x-vitrus-client-ip": "198.51.100.9", "cf-connecting-ip": "203.0.113.7" },
    });
    expect(clientIp(req)).toBe("198.51.100.9");
  });

  test("prefers cf-connecting-ip: behind Cloudflare -> Caddy, x-forwarded-for is the edge", () => {
    const req = new Request("http://x/", {
      headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "172.70.1.1" },
    });
    expect(clientIp(req)).toBe("203.0.113.7");
  });

  test("takes the FIRST value of x-forwarded-for (the proxy chain)", () => {
    const req = new Request("http://x/", { headers: { "x-forwarded-for": "203.0.113.1, 10.0.0.1" } });
    expect(clientIp(req)).toBe("203.0.113.1");
  });
  test("falls back when the header is absent", () => {
    expect(clientIp(new Request("http://x/"))).toBe("0.0.0.0");
  });
});

describe("the HTTP surface", () => {
  test("/health", async () => {
    const { handle } = await harness();
    const res = await handle(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("collect returns 204 and the event is written", async () => {
    const { handle, store } = await harness();
    const res = await handle(collect({ site: "demo", type: "pageview", url: "/fiyat" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const rows = await store.select<{ n: number }>(`SELECT COUNT(*) AS n FROM events`);
    expect(rows[0]?.n).toBe(1);
  });

  test("/api/d is the same ingest as /api/collect (blocklists match the long name)", async () => {
    const { store, handle } = await harness();
    const req = new Request("http://localhost/api/d", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": CHROME },
      body: JSON.stringify({ site: "demo", type: "pageview", url: "/" }),
    });
    expect((await handle(req)).status).toBeLessThan(300);
    const rows = await store.select<{ n: number }>(`SELECT COUNT(*) AS n FROM events`);
    expect(rows[0]?.n).toBe(1);
  });

  test("an unknown site is 404, an invalid body is 400", async () => {
    const { handle } = await harness();
    expect((await handle(collect({ site: "yok", type: "pageview", url: "/" }))).status).toBe(404);
    expect((await handle(collect({ site: "demo", type: "pageview" }))).status).toBe(400);
  });

  test("a malformed JSON body does not crash it", async () => {
    const { handle } = await harness();
    const req = new Request("http://localhost/api/collect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bozuk",
    });
    const res = await handle(req);
    expect(res.status).toBe(400);
  });

  test("an OPTIONS preflight returns 204 with CORS headers", async () => {
    const { handle } = await harness();
    const res = await handle(new Request("http://localhost/api/collect", { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  test("/api/stats returns the bundle together with its evidence", async () => {
    const { handle } = await harness();
    await handle(collect({ site: "demo", type: "pageview", url: "/" }, { referrer: "" }));
    const res = await handle(new Request("http://localhost/api/stats?site=demo&days=7"));
    const bundle = (await res.json()) as {
      evidence: { metric: string; sql: string; params: unknown[]; series?: unknown[] }[];
    };
    expect(bundle.evidence.length).toBeGreaterThan(5);
    // Every piece of evidence carries its own query and parameters bound to
    // THIS site. (Parameter ORDER varies per metric — the time series also takes
    // a bucket size — so we check for presence, not position.)
    for (const e of bundle.evidence) {
      expect(e.sql).toContain("SELECT");
      expect(e.params).toContain("demo");
    }
    const series = bundle.evidence.find((e) => e.metric === "timeseries");
    expect(series?.series?.length).toBeGreaterThan(0);
  });

  test("/api/digest carries evidence ids in its text form", async () => {
    const { handle } = await harness();
    await handle(collect({ site: "demo", type: "pageview", url: "/" }));
    const res = await handle(new Request("http://localhost/api/digest?site=demo&days=7&format=text"));
    const text = await res.text();
    // Every line carries at least one evidence id — which id depends on metric
    // order, so we match a pattern rather than a literal.
    expect(text).toMatch(/\[e\d+/);
  });

  test("the days parameter is clamped (1..365)", async () => {
    const { handle } = await harness();
    const res = await handle(new Request("http://localhost/api/stats?site=demo&days=99999"));
    const b = (await res.json()) as { window: { from: number; to: number } };
    const days = Math.round((b.window.to - b.window.from) / 86_400_000);
    expect(days).toBe(365);
  });

  test("the dashboard HTML contains the site picker", async () => {
    const { handle } = await harness();
    const html = await (await handle(new Request("http://localhost/"))).text();
    expect(html).toContain("<select id=\"site\"");
    expect(html).toContain("Demo");
  });

  test("bilinmeyen yol 404 JSON", async () => {
    const { handle } = await harness();
    expect((await handle(new Request("http://localhost/yok"))).status).toBe(404);
  });
});

describe("the self-hosted dashboard shows the whole engine", () => {
  const html = dashboardHtml([
    { id: "s1", name: "Site", domain: "site.example", vertical: "landing", createdAt: 0 },
  ]);

  test("the tab carries the Vitrus icon, inline", () => {
    expect(html).toContain('<link rel="icon" href="data:image/svg+xml,');
  });

  test("it renders the sections the documentation promises", () => {
    // The open-core claim is that no metric is held back from this repository.
    // The engine always computed these; for a while only the screen was missing,
    // which makes the claim look false to the one person who checked.
    // The headings are built by the page's own script from this table, so the
    // table is what there is to assert on.
    for (const section of [
      "Traffic",
      "AI",
      "Agents",
      "Traffic quality",
      "Behaviour",
      "Performance",
      "Errors",
      "Audience",
    ]) {
      expect(html, `section missing: ${section}`).toContain(`["${section}",`);
    }
  });

  test("Web Vitals and error grouping are on the page, not only in the API", () => {
    for (const m of ["vitals.p75", "vitals.slow_pages", "errors.top", "errors.browsers"]) {
      expect(html, `metric missing: ${m}`).toContain(m);
    }
  });

  test("a metric no section claims still renders rather than vanishing", () => {
    expect(html).toContain('"More"');
    expect(html).toContain("listed[e.metric]");
  });

  test("a SCALAR no card claims also renders — the other half of that promise", () => {
    // The rows catch-all existed; the cards had none, so a scalar the engine
    // computed but CARDS did not name was simply absent from the self-hosted
    // page while an equivalent rows metric fell through to "More". The claim
    // "no metric is held back" only held for half the bundle.
    expect(html).toContain("CARDS.indexOf(e.metric) === -1");
    expect(html).toContain("CARDS.concat(extra)");
  });

  test("the agent and traffic-quality metrics reach the page", () => {
    // These are the v0.3.0 additions; they are in the Apache-2.0 core, so they
    // have to be visible to somebody running only this repository.
    for (const m of [
      "agent.sessions",
      "agent.operators",
      "agent.pages",
      "agents.by_signer",
      "agents.unverified_bots",
      "bots.suspected",
      "bots.signal_rules",
    ]) {
      expect(html, `metric missing: ${m}`).toContain(m);
    }
  });

  test("every table keeps its evidence control", () => {
    expect(html).toContain("showEvidence");
    expect(html).toContain("Query that ran");
  });

  test("row values are escaped, never interpolated raw", () => {
    expect(html).toContain("escapeHtml(String(r[c]");
  });
});

describe("VITRUS_PASSWORD", () => {
  test("dashboard and read API need the password; tracker and ingest stay public", async () => {
    const { SqliteStore } = await import("@vitrus/core");
    const { createHandler } = await import("../src/server.ts");
    const store = new SqliteStore(":memory:");
    await store.init();
    await store.upsertSite({ id: "s1", name: "S", domain: "s.example", vertical: "landing", createdAt: Date.now() });
    const h = createHandler({ store, secret: "x", password: "hunter2-long" });
    expect((await h(new Request("http://l/"))).status).toBe(401);
    expect((await h(new Request("http://l/api/stats?site=s1"))).status).toBe(401);
    expect((await h(new Request("http://l/api/replay/settings?site=s1", { method: "PUT", body: "{}" }))).status).toBe(401);
    const wrong = { authorization: "Basic " + btoa("admin:nope") };
    expect((await h(new Request("http://l/api/sites", { headers: wrong }))).status).toBe(401);
    const right = { authorization: "Basic " + btoa("anyone:hunter2-long") };
    expect((await h(new Request("http://l/api/sites", { headers: right }))).status).toBe(200);
    const ingest = await h(new Request("http://l/api/d", { method: "POST", headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 Chrome/131.0" }, body: JSON.stringify({ site: "s1", type: "pageview", url: "/" }) }));
    expect(ingest.status).toBe(204);
    expect((await h(new Request("http://l/health"))).status).toBe(200);
  });
});

describe("lifecycle and portfolio", () => {
  test("/api/lifecycle counts identified people and never returns a raw id", async () => {
    const { handle } = await harness();
    for (const who of ["ayse@example.com", "u2"]) {
      expect((await handle(collect({ site: "demo", type: "event", name: "signup", url: "/app", identity: who, props: { plan: "free", email: who } }))).status).toBe(204);
    }
    // The window ends at "now", exclusive: an event written in this very millisecond is not in it yet.
    await Bun.sleep(5);
    const res = await handle(new Request("http://localhost/api/lifecycle?site=demo&days=7"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("ayse");
    const body = JSON.parse(text) as { lifecycle: { available: boolean; accounting: { rows: { active: number; new_users: number }[] }; privacy: { rows: { pii_dropped: number }[] } } };
    expect(body.lifecycle.available).toBe(true);
    expect(body.lifecycle.accounting.rows[0]).toMatchObject({ active: 2, new_users: 2 });
    expect(body.lifecycle.privacy.rows[0]!.pii_dropped).toBe(2);
  });

  test("/api/portfolio lists every site, and both routes sit behind the dashboard password", async () => {
    const store = new SqliteStore(":memory:");
    await store.init();
    await store.upsertSite(SITE);
    await store.upsertSite({ id: "two", name: "Two", domain: "two.example", vertical: "generic", createdAt: 0 });
    const handle = createHandler({ store, secret: "s", password: "pw" });
    expect((await handle(new Request("http://localhost/api/portfolio"))).status).toBe(401);
    expect((await handle(new Request("http://localhost/api/lifecycle?site=demo"))).status).toBe(401);
    const auth = { authorization: `Basic ${btoa("x:pw")}` };
    const res = await handle(new Request("http://localhost/api/portfolio?days=30", { headers: auth }));
    const body = (await res.json()) as { portfolio: { rows: { site: { id: string } }[] } };
    expect(body.portfolio.rows.map((r) => r.site.id).sort()).toEqual(["demo", "two"]);
  });
});

describe("people", () => {
  test("/api/people lists users as hashes with made-up names; a bad sort is a 400", async () => {
    const { handle } = await harness();
    await handle(collect({ site: "demo", type: "event", name: "invoice_sent", url: "/app", identity: "ayse@example.com" }));
    await Bun.sleep(5);
    const res = await handle(new Request("http://localhost/api/people?site=demo"));
    const text = await res.text();
    expect(text).not.toContain("ayse");
    const body = JSON.parse(text) as { people: { list: { rows: { alias: string; status: string; actions: number }[] } } };
    expect(body.people.list.rows[0]).toMatchObject({ status: "one_time", actions: 1 });
    expect(body.people.list.rows[0]!.alias).toMatch(/ · [0-9a-f]{6}$/);
    expect((await handle(new Request("http://localhost/api/people?site=demo&sort=email"))).status).toBe(400);
  });
});

describe("heatmaps", () => {
  test("/api/heatmap answers on a self-hosted install with no plan check; a bad device is a 400", async () => {
    const { handle } = await harness();
    const r = await handle(new Request("http://localhost/api/heatmap?site=demo"));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { heatmap: { recordings: number } }).heatmap.recordings).toBe(0);
    expect((await handle(new Request("http://localhost/api/heatmap?site=demo&device=watch"))).status).toBe(400);
  });
});

describe("batch ingest", () => {
  test("/api/batch stores each valid event, reports the refused ones, and needs no password", async () => {
    const store = new SqliteStore(":memory:");
    await store.init();
    await store.upsertSite(SITE);
    const handle = createHandler({ store, secret: "s", password: "pw" });
    const ev = (extra: Record<string, unknown> = {}) => ({ site: "demo", type: "pageview", url: "/screen/Home", nonce: "a1b2c3d4e5f6a7b8c9d0", ...extra });
    const res = await handle(new Request("http://localhost/api/batch", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Vitrus-iOS/0.1 (iPhone; iOS 18.0)" },
      body: JSON.stringify({ events: [ev({ ago: 60_000 }), ev({ ago: -5 }), ev({ type: "event", name: "invoice_sent" })] }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, accepted: 2, rejected: [{ index: 1, reason: "ago_invalid" }] });
    const rows = await store.select<{ browser: string }>(`SELECT browser FROM events`);
    expect(rows.map((r) => r.browser)).toEqual(["iOS app", "iOS app"]);
    const mixed = await handle(new Request("http://localhost/api/batch", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [ev(), { ...ev(), site: "other" }] }),
    }));
    expect(mixed.status).toBe(400);
  });
});
