// packages/core/test/funnel.test.ts
// Funnels — the metric most easily counted wrong in silence. Three claims:
//   1. ORDER matters: step N must come after step N-1.
//   2. Step values are NEVER embedded in the SQL (no injection surface).
//   3. A repeated event does not push the funnel forward.

import { describe, expect, test } from "bun:test";
import { buildFunnelSql, computeFunnel, defaultFunnel, FunnelError, validateSteps } from "../src/metrics/funnel.ts";
import { DAY, MIN, freshStore, ingestorFor, send } from "./helpers.ts";
import type { SqliteStore } from "../src/store/sqlite.ts";

const NOW = Date.UTC(2026, 8, 12, 12, 0, 0);
const FROM = NOW - 7 * DAY;

const STEPS = [
  { type: "page" as const, value: "/", label: "Ana sayfa" },
  { type: "event" as const, value: "cta_click", label: "CTA" },
  { type: "event" as const, value: "signup", label: "Signup" },
];

function run(store: SqliteStore, steps = STEPS) {
  return computeFunnel((sql, params) => store.select(sql, params), {
    siteId: "demo",
    from: FROM,
    to: NOW,
    steps,
  });
}

describe("validateSteps", () => {
  test("requires at least 2 steps", () => {
    expect(() => validateSteps([{ type: "page", value: "/" }])).toThrow(FunnelError);
  });
  test("rejects more than 8 steps", () => {
    const many = Array.from({ length: 9 }, () => ({ type: "page" as const, value: "/" }));
    expect(() => validateSteps(many)).toThrow(FunnelError);
  });
  test("rejects an empty value and an invalid type", () => {
    expect(() => validateSteps([{ type: "page", value: "  " }, { type: "page", value: "/" }])).toThrow(FunnelError);
    expect(() =>
      validateSteps([{ type: "sihir" as never, value: "x" }, { type: "page", value: "/" }])
    ).toThrow(FunnelError);
  });
  test("falls back to the value when there is no label", () => {
    const out = validateSteps([{ type: "page", value: "/fiyat" }, { type: "event", value: "signup" }]);
    expect(out[0]?.label).toBe("/fiyat");
  });
});

describe("buildFunnelSql", () => {
  test("step values are NEVER embedded in the SQL — all are parameters", () => {
    const { sql } = buildFunnelSql([
      { type: "page", value: "/gizli-sayfa" },
      { type: "event", value: "gizli_olay" },
    ]);
    expect(sql).not.toContain("/gizli-sayfa");
    expect(sql).not.toContain("gizli_olay");
    expect((sql.match(/\?/g) ?? []).length).toBe(8); // 2 steps × 4 parameters
  });

  test("an injection attempt does not change the shape of the SQL", async () => {
    const store = await freshStore();
    const evil = `' OR 1=1 --`;
    const res = await run(store, [
      { type: "page" as const, value: evil, label: "evil 1" },
      { type: "event" as const, value: evil, label: "evil 2" },
    ]);
    expect(res.sql).not.toContain("OR 1=1");
    expect(res.steps[0]?.sessions).toBe(0);
  });
});

describe("computeFunnel", () => {
  test("ordered funnel: a session following the whole path counts at every step", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    const ip = "10.0.0.1";
    await send(ing, { now: NOW - 10 * MIN, ip, url: "/" });
    await send(ing, { now: NOW - 9 * MIN, ip, type: "event", name: "cta_click", url: "/" });
    await send(ing, { now: NOW - 8 * MIN, ip, type: "event", name: "signup", url: "/kayit" });

    const res = await run(store);
    expect(res.steps.map((s) => s.sessions)).toEqual([1, 1, 1]);
    expect(res.conversionRate).toBe(100);
  });

  test("ORDER matters: signing up then viewing the home page is NOT a conversion", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    const ip = "10.0.0.2";
    // Wrong order: signup first, then the home page, then the CTA
    await send(ing, { now: NOW - 10 * MIN, ip, type: "event", name: "signup", url: "/kayit" });
    await send(ing, { now: NOW - 9 * MIN, ip, url: "/" });
    await send(ing, { now: NOW - 8 * MIN, ip, type: "event", name: "cta_click", url: "/" });

    const res = await run(store);
    // Home page ✓, CTA ✓ (after the home page), signup ✗ (it came BEFORE the CTA)
    expect(res.steps.map((s) => s.sessions)).toEqual([1, 1, 0]);
    expect(res.conversionRate).toBe(0);
  });

  test("a session that drops in the middle is not counted in later steps", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    for (let i = 0; i < 5; i++) {
      const ip = `10.1.0.${i}`;
      await send(ing, { now: NOW - 20 * MIN, ip, url: "/" });
      if (i < 3) await send(ing, { now: NOW - 19 * MIN, ip, type: "event", name: "cta_click", url: "/" });
      if (i < 1) await send(ing, { now: NOW - 18 * MIN, ip, type: "event", name: "signup", url: "/kayit" });
    }
    const res = await run(store);
    expect(res.steps.map((s) => s.sessions)).toEqual([5, 3, 1]);
    expect(res.steps[1]?.dropped).toBe(2);
    expect(res.steps[2]?.dropped).toBe(2);
    expect(res.conversionRate).toBe(20);
    expect(res.worstStep?.index).toBe(1); // on a tie the first one wins
  });

  test("rate maths: step rate against the previous step, total rate against the first", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    for (let i = 0; i < 4; i++) {
      const ip = `10.2.0.${i}`;
      await send(ing, { now: NOW - 20 * MIN, ip, url: "/" });
      if (i < 2) await send(ing, { now: NOW - 19 * MIN, ip, type: "event", name: "cta_click", url: "/" });
      if (i < 1) await send(ing, { now: NOW - 18 * MIN, ip, type: "event", name: "signup", url: "/kayit" });
    }
    const res = await run(store);
    expect(res.steps[0]?.stepRate).toBe(100);
    expect(res.steps[1]?.stepRate).toBe(50); // 2/4
    expect(res.steps[2]?.stepRate).toBe(50); // 1/2
    expect(res.steps[2]?.totalRate).toBe(25); // 1/4
  });

  test("a repeated event does not push the funnel forward", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    const ip = "10.3.0.1";
    await send(ing, { now: NOW - 20 * MIN, ip, url: "/" });
    await send(ing, { now: NOW - 19 * MIN, ip, url: "/" }); // saw the home page again
    await send(ing, { now: NOW - 18 * MIN, ip, type: "event", name: "cta_click", url: "/" });
    await send(ing, { now: NOW - 17 * MIN, ip, type: "event", name: "signup", url: "/kayit" });
    const res = await run(store);
    expect(res.steps.map((s) => s.sessions)).toEqual([1, 1, 1]);
  });

  test("bots DO NOT enter the funnel", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    await send(ing, { now: NOW - 20 * MIN, ip: "52.0.0.1", ua: "Mozilla/5.0 (compatible; GPTBot/1.2)", url: "/" });
    const res = await run(store);
    expect(res.steps[0]?.sessions).toBe(0);
  });

  test("no division by zero on empty data", async () => {
    const store = await freshStore();
    const res = await run(store);
    expect(res.conversionRate).toBe(0);
    expect(res.worstStep).toBeNull();
    expect(res.steps.every((s) => s.sessions === 0)).toBe(true);
  });

  test("it carries evidence: the generated query and its parameters", async () => {
    const store = await freshStore();
    const res = await run(store);
    expect(res.sql).toContain("WITH s0");
    expect(res.params).toContain("demo");
    expect(res.params).toContain("/");
    expect(res.params).toContain("cta_click");
    expect((res.sql.match(/\?/g) ?? []).length).toBe(res.params.length);
  });

  test("events outside the window are not counted", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    const ip = "10.4.0.1";
    await send(ing, { now: FROM - DAY, ip, url: "/" });
    const res = await run(store);
    expect(res.steps[0]?.sessions).toBe(0);
  });
});

describe("defaultFunnel", () => {
  test("the user sees a first funnel without configuring anything", () => {
    expect(defaultFunnel("landing").length).toBeGreaterThanOrEqual(3);
    expect(defaultFunnel("shopify")[0]?.value).toBe("checkout_started");
    expect(defaultFunnel("shopify").at(-1)?.value).toBe("checkout_completed");
  });
});
