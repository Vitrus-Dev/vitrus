// packages/core/test/countries.test.ts
// The country table is DATA, and data with no test rots quietly: a dot in the
// wrong hemisphere is a wrong claim on a page whose whole argument is that its
// claims are checkable.

import { describe, expect, test } from "bun:test";
import { COUNTRIES, countryName, countryPoint } from "../src/countries.ts";

describe("country table", () => {
  test("every code is a valid ISO-3166 alpha-2 shape", () => {
    for (const code of Object.keys(COUNTRIES)) {
      expect(code, `bad code: ${code}`).toMatch(/^[A-Z]{2}$/);
    }
  });

  test("every coordinate is on the planet", () => {
    for (const [code, c] of Object.entries(COUNTRIES)) {
      expect(c.lat, `${code} latitude`).toBeGreaterThanOrEqual(-90);
      expect(c.lat, `${code} latitude`).toBeLessThanOrEqual(90);
      expect(c.lon, `${code} longitude`).toBeGreaterThanOrEqual(-180);
      expect(c.lon, `${code} longitude`).toBeLessThanOrEqual(180);
      expect(c.name.length, `${code} name`).toBeGreaterThan(1);
    }
  });

  test("no country sits at 0,0 — that is the Gulf of Guinea, and it is what a missing value looks like", () => {
    for (const [code, c] of Object.entries(COUNTRIES)) {
      expect(c.lat === 0 && c.lon === 0, `${code} is at null island`).toBe(false);
    }
  });

  test("spot checks land in the right hemisphere", () => {
    // Enough to catch a transposed lat/lon or a dropped minus sign, which is
    // how this kind of table usually breaks.
    const cases: [string, "N" | "S", "E" | "W"][] = [
      ["TR", "N", "E"], ["US", "N", "W"], ["BR", "S", "W"], ["AU", "S", "E"],
      ["ZA", "S", "E"], ["JP", "N", "E"], ["GB", "N", "W"], ["AR", "S", "W"],
      ["IN", "N", "E"], ["NZ", "S", "E"], ["CA", "N", "W"], ["EG", "N", "E"],
    ];
    for (const [code, ns, ew] of cases) {
      const p = countryPoint(code);
      expect(p, `${code} missing`).not.toBeNull();
      expect(ns === "N" ? p!.lat > 0 : p!.lat < 0, `${code} wrong N/S`).toBe(true);
      expect(ew === "E" ? p!.lon > 0 : p!.lon < 0, `${code} wrong E/W`).toBe(true);
    }
  });

  test("a few centroids are roughly where they should be", () => {
    const near = (code: string, lat: number, lon: number) => {
      const p = countryPoint(code)!;
      expect(Math.abs(p.lat - lat), `${code} lat`).toBeLessThan(6);
      expect(Math.abs(p.lon - lon), `${code} lon`).toBeLessThan(6);
    };
    near("TR", 39, 35);
    near("DE", 51, 9);
    near("SG", 1.3, 103.8);
    near("IS", 65, -18);
    near("CL", -30, -71);
  });

  test("an unknown code degrades to the code itself rather than throwing", () => {
    expect(countryName("ZZ")).toBe("ZZ");
    expect(countryPoint("ZZ")).toBeNull();
  });

  test("lookups are case-insensitive — proxies are not consistent about casing", () => {
    expect(countryName("tr")).toBe("Turkiye");
    expect(countryPoint("de")).not.toBeNull();
  });

  test("it covers the countries a real deployment actually sees", () => {
    // Not exhaustive coverage — the globe reports what it could not plot — but
    // the common ones must never be missing.
    for (const code of ["US", "GB", "DE", "FR", "TR", "IN", "BR", "CA", "AU", "JP", "NL", "ES", "IT", "PL", "RU", "CN"]) {
      expect(COUNTRIES[code], `missing: ${code}`).toBeDefined();
    }
    expect(Object.keys(COUNTRIES).length).toBeGreaterThan(180);
  });
});
