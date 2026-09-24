// City, subdivision and coordinates from proxy headers — and the globe report.
//
// The rules under test: fields come from ONE provider; coordinates are rounded
// to 0.1° and kept only as a pair; "unknown" stays empty/null and is never 0;
// strict privacy drops all of it; filters reach the SQL.

import { describe, expect, test } from "bun:test";
import { geoFromHeaders } from "../src/geo.ts";
import { buildGeoReport, GEO_SESSION_LIMIT } from "../src/metrics/geo.ts";
import { windowOf } from "../src/metrics/bundle.ts";
import { Ingestor } from "../src/ingest.ts";
import { CHROME, freshStore, ingestorFor, SITE } from "./helpers.ts";

const CF_BERLIN = {
  "cf-ipcountry": "DE",
  "cf-ipcity": "Berlin",
  "cf-region": "Land Berlin",
  "cf-region-code": "BE",
  "cf-iplatitude": "52.52437",
  "cf-iplongitude": "13.41053",
};

describe("geoFromHeaders", () => {
  test("Cloudflare's managed-transform headers become a full location", () => {
    const g = geoFromHeaders(new Headers(CF_BERLIN));
    expect(g).toEqual({
      country: "DE",
      region: "DE-BE",
      regionName: "Land Berlin",
      city: "Berlin",
      lat: 52.5,
      lon: 13.4,
    });
  });

  test("coordinates are rounded to 0.1 degree — city precision, deliberately", () => {
    const g = geoFromHeaders(new Headers({ ...CF_BERLIN, "cf-iplatitude": "-33.86785", "cf-iplongitude": "151.20732" }));
    expect(g.lat).toBe(-33.9);
    expect(g.lon).toBe(151.2);
  });

  test("country only (the Cloudflare default) leaves the rest empty and null, never 0", () => {
    const g = geoFromHeaders(new Headers({ "cf-ipcountry": "TR" }));
    expect(g).toEqual({ country: "TR", region: "", regionName: "", city: "", lat: null, lon: null });
  });

  test("half a coordinate is no coordinate, and (0, 0) is a failed lookup", () => {
    expect(geoFromHeaders(new Headers({ ...CF_BERLIN, "cf-iplongitude": "" })).lat).toBeNull();
    const zero = geoFromHeaders(new Headers({ ...CF_BERLIN, "cf-iplatitude": "0", "cf-iplongitude": "0" }));
    expect(zero.lat).toBeNull();
    expect(zero.lon).toBeNull();
    expect(geoFromHeaders(new Headers({ ...CF_BERLIN, "cf-iplatitude": "95" })).lat).toBeNull();
    expect(geoFromHeaders(new Headers({ ...CF_BERLIN, "cf-iplatitude": "abc" })).lat).toBeNull();
  });

  test("Vercel's URL-encoded city is decoded", () => {
    const g = geoFromHeaders(
      new Headers({
        "x-vercel-ip-country": "BR",
        "x-vercel-ip-country-region": "SP",
        "x-vercel-ip-city": "S%C3%A3o%20Paulo",
        "x-vercel-ip-latitude": "-23.5475",
        "x-vercel-ip-longitude": "-46.63611",
      })
    );
    expect(g.city).toBe("São Paulo");
    expect(g.region).toBe("BR-SP");
    expect(g.lat).toBe(-23.5);
  });

  test("fields are never stitched together from two providers", () => {
    // A Cloudflare country with a Vercel city is a place that does not exist.
    const g = geoFromHeaders(new Headers({ "cf-ipcountry": "DE", "x-vercel-ip-city": "Paris" }));
    expect(g.country).toBe("DE");
    expect(g.city).toBe("");
  });

  test("placeholder country codes are not a country, and take their city with them", () => {
    const g = geoFromHeaders(new Headers({ "cf-ipcountry": "XX", "cf-ipcity": "Nowhere" }));
    expect(g.country).toBe("");
    expect(g.city).toBe("");
  });

  test("a region code that is not an ISO 3166-2 suffix is dropped", () => {
    expect(geoFromHeaders(new Headers({ ...CF_BERLIN, "cf-region-code": "not a code" })).region).toBe("");
  });

  test("markup in a city header cannot reach the page", () => {
    const g = geoFromHeaders(new Headers({ ...CF_BERLIN, "cf-ipcity": "<img src=x onerror=1>Berlin" }));
    expect(g.city).not.toContain("<");
  });
});

async function ingestWith(ing: Ingestor, headers: Record<string, string>, ip: string, now: number, url = "/") {
  const h = new Headers(headers);
  const g = geoFromHeaders(h);
  return ing.ingest(
    { site: SITE.id, type: "pageview", url },
    { ip, userAgent: CHROME, now, host: SITE.domain, country: g.country, geo: g }
  );
}

describe("ingest stores the location", () => {
  test("city, region and rounded coordinates reach the row; the IP does not", async () => {
    const store = await freshStore();
    const res = await ingestWith(ingestorFor(store), CF_BERLIN, "198.51.100.23", Date.now());
    expect(res.ok).toBe(true);
    const rows = await store.select<Record<string, unknown>>(`SELECT * FROM events`);
    expect(rows[0]?.city).toBe("Berlin");
    expect(rows[0]?.region).toBe("DE-BE");
    expect(rows[0]?.lat).toBe(52.5);
    expect(rows[0]?.lon).toBe(13.4);
    expect(JSON.stringify(rows[0])).not.toContain("198.51.100.23");
  });

  test("with country only, lat/lon are stored as NULL, not 0", async () => {
    const store = await freshStore();
    await ingestWith(ingestorFor(store), { "cf-ipcountry": "TR" }, "198.51.100.24", Date.now());
    const rows = await store.select<{ lat: number | null; city: string }>(`SELECT lat, city FROM events`);
    expect(rows[0]?.lat).toBeNull();
    expect(rows[0]?.city).toBe("");
  });

  test("strict privacy drops city, region and coordinates along with country", async () => {
    const store = await freshStore({ ...SITE, privacyMode: "strict" });
    await ingestWith(ingestorFor(store), CF_BERLIN, "198.51.100.25", Date.now());
    const rows = await store.select<Record<string, unknown>>(
      `SELECT country, region, region_name, city, lat, lon FROM events`
    );
    expect(rows[0]).toEqual({ country: "", region: "", region_name: "", city: "", lat: null, lon: null });
  });

  test("a region belonging to another country is refused", async () => {
    const store = await freshStore();
    await ingestorFor(store).ingest(
      { site: SITE.id, type: "pageview", url: "/" },
      { ip: "198.51.100.26", userAgent: CHROME, now: Date.now(), country: "DE", geo: { region: "US-TX" } }
    );
    const rows = await store.select<{ region: string }>(`SELECT region FROM events`);
    expect(rows[0]?.region).toBe("");
  });
});

describe("buildGeoReport", () => {
  async function seeded() {
    const store = await freshStore();
    const ing = ingestorFor(store);
    const now = Date.now() - 60_000;
    await ingestWith(ing, CF_BERLIN, "198.51.100.1", now, "/pricing");
    await ingestWith(ing, CF_BERLIN, "198.51.100.1", now + 1000, "/signup");
    await ingestWith(
      ing,
      { "cf-ipcountry": "US", "cf-ipcity": "Tulsa", "cf-region-code": "OK", "cf-region": "Oklahoma", "cf-iplatitude": "36.15", "cf-iplongitude": "-95.99" },
      "198.51.100.2",
      now
    );
    await ingestWith(ing, { "cf-ipcountry": "TR" }, "198.51.100.3", now);
    await ingestWith(ing, {}, "198.51.100.4", now);
    return store;
  }

  test("coverage separates 'no visitors' from 'no city headers'", async () => {
    const store = await seeded();
    const r = await buildGeoReport((s, p) => store.select(s, p), { siteId: SITE.id, window: windowOf(Date.now(), 1) });
    const cov = r.evidence.find((e) => e.metric === "geo.coverage")!;
    expect(cov.rows[0]).toEqual({ sessions: 4, with_country: 3, with_region: 2, with_city: 2, with_coords: 2 });
    expect(cov.value).toBe(4);
  });

  test("every result is evidence with the SQL that produced it", async () => {
    const store = await seeded();
    const r = await buildGeoReport((s, p) => store.select(s, p), { siteId: SITE.id, window: windowOf(Date.now(), 1) });
    expect(r.evidence.map((e) => e.id)).toEqual(["g1", "g2", "g3", "g4", "g5"]);
    for (const e of r.evidence) {
      expect(e.sql).toContain("FROM events");
      expect(e.params[0]).toBe(SITE.id);
    }
    expect(r.sessionLimit).toBe(GEO_SESSION_LIMIT);
  });

  test("the session list carries entry, exit, counts and first-event location", async () => {
    const store = await seeded();
    const r = await buildGeoReport((s, p) => store.select(s, p), { siteId: SITE.id, window: windowOf(Date.now(), 1) });
    const rows = r.evidence.find((e) => e.metric === "geo.sessions")!.rows;
    expect(rows).toHaveLength(4);
    const berlin = rows.find((x) => x.city === "Berlin")!;
    expect(berlin.pageviews).toBe(2);
    expect(berlin.entry).toBe("/pricing");
    expect(berlin.exit).toBe("/signup");
    expect(berlin.lat).toBe(52.5);
    expect(Number(berlin.ended) - Number(berlin.started)).toBe(1000);
    const none = rows.find((x) => x.country === "");
    expect(none?.lat).toBeNull();
  });

  test("regions and points group by code and 0.1-degree cell", async () => {
    const store = await seeded();
    const r = await buildGeoReport((s, p) => store.select(s, p), { siteId: SITE.id, window: windowOf(Date.now(), 1) });
    const regions = r.evidence.find((e) => e.metric === "geo.regions")!.rows;
    expect(regions.map((x) => x.region).sort()).toEqual(["DE-BE", "US-OK"]);
    expect(regions.find((x) => x.region === "US-OK")?.region_name).toBe("Oklahoma");
    const points = r.evidence.find((e) => e.metric === "geo.points")!.rows;
    expect(points).toHaveLength(2);
    // All countries — not the bundle's top 15.
    expect(r.evidence.find((e) => e.metric === "geo.countries")!.sql).not.toContain("LIMIT");
  });

  test("filters are compiled into the SQL, with their values bound", async () => {
    const store = await seeded();
    const r = await buildGeoReport((s, p) => store.select(s, p), {
      siteId: SITE.id,
      window: windowOf(Date.now(), 1),
      filters: [{ field: "country", value: "US" }],
    });
    for (const e of r.evidence) {
      expect(e.sql).toContain("country = ?");
      expect(e.params).toContain("US");
    }
    expect(r.evidence.find((e) => e.metric === "geo.coverage")!.rows[0]?.sessions).toBe(1);
  });

  test("strict mode swaps the human predicate visibly", async () => {
    const store = await seeded();
    const r = await buildGeoReport((s, p) => store.select(s, p), {
      siteId: SITE.id,
      window: windowOf(Date.now(), 1),
      strictBots: true,
    });
    for (const e of r.evidence) expect(e.sql).toContain("bot_score <");
  });
});
