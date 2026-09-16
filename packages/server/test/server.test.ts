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

  test("it renders the sections the documentation promises", () => {
    // The open-core claim is that no metric is held back from this repository.
    // The engine always computed these; for a while only the screen was missing,
    // which makes the claim look false to the one person who checked.
    // The headings are built by the page's own script from this table, so the
    // table is what there is to assert on.
    for (const section of ["Traffic", "AI", "Behaviour", "Performance", "Errors", "Audience"]) {
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

  test("every table keeps its evidence control", () => {
    expect(html).toContain("showEvidence");
    expect(html).toContain("Query that ran");
  });

  test("row values are escaped, never interpolated raw", () => {
    expect(html).toContain("escapeHtml(String(r[c]");
  });
});
