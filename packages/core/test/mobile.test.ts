// packages/core/test/mobile.test.ts
// What native SDKs (Swift, Dart/Flutter) rely on:
//   1. A daily device nonce replaces IP + UA in the visitor hash — two phones
//      behind one carrier IP with the same app user-agent stay two visitors —
//      and the day still rotates the value whatever the nonce is.
//   2. `ago` back-dates an offline event by a bounded amount, from server time.
//   3. The SDK user-agent is bucketed as an app (device, OS, "iOS app").
//   4. A batch is one site's queue, at most BATCH_MAX events.

import { describe, expect, test } from "bun:test";
import { BATCH_MAX, validateBatch, validateEvent } from "../src/validate.ts";
import { parseUa } from "../src/ua.ts";
import { deviceVisitorId } from "../src/visitor.ts";
import { DAY, SITE, freshStore, ingestorFor } from "./helpers.ts";

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const SDK_UA = "Vitrus-iOS/0.1 (iPhone; iOS 18.0) Tallyhook/2.3";
const N1 = "a1b2c3d4e5f6a7b8c9d0";
const N2 = "ffeeddccbbaa99887766";

describe("native SDK ingest", () => {
  test("two phones behind one carrier IP and one app user-agent are two visitors with a nonce", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    const ctx = { ip: "100.64.0.1", userAgent: SDK_UA, now: NOW };
    const a = await ing.ingest({ site: SITE.id, type: "pageview", url: "/screen/Home", nonce: N1 }, ctx);
    const b = await ing.ingest({ site: SITE.id, type: "pageview", url: "/screen/Home", nonce: N2 }, ctx);
    const c = await ing.ingest({ site: SITE.id, type: "pageview", url: "/screen/Home" }, ctx);
    const d = await ing.ingest({ site: SITE.id, type: "pageview", url: "/screen/Home" }, ctx);
    if (!a.ok || !b.ok || !c.ok || !d.ok) throw new Error("ingest failed");
    expect(a.event.visitorId).not.toBe(b.event.visitorId);
    // Without a nonce the browser recipe merges them — the reason the nonce exists.
    expect(c.event.visitorId).toBe(d.event.visitorId);
    expect(a.event.device).toBe("mobile");
    expect(a.event.browser).toBe("iOS app");
  });

  test("the day still rotates the device hash, whatever the nonce", () => {
    const today = deviceVisitorId({ secret: "s", siteId: SITE.id, nonce: N1, now: NOW });
    const tomorrow = deviceVisitorId({ secret: "s", siteId: SITE.id, nonce: N1, now: NOW + DAY });
    expect(today).not.toBe(tomorrow);
  });

  test("ago back-dates from server time and keeps the event in its own session", async () => {
    const store = await freshStore();
    const ing = ingestorFor(store);
    const r = await ing.ingest({ site: SITE.id, type: "event", name: "invoice_sent", url: "/screen/Invoices", nonce: N1, ago: 3 * 3_600_000 },
      { ip: "1.2.3.4", userAgent: SDK_UA, now: NOW });
    if (!r.ok) throw new Error(r.reason);
    expect(r.event.ts).toBe(NOW - 3 * 3_600_000);
    const later = await ing.ingest({ site: SITE.id, type: "pageview", url: "/screen/Home", nonce: N1 }, { ip: "1.2.3.4", userAgent: SDK_UA, now: NOW });
    if (!later.ok) throw new Error(later.reason);
    expect(later.event.sessionId).not.toBe(r.event.sessionId);
  });

  test("bad ages are refused; a malformed nonce is dropped, not fatal", () => {
    expect(validateEvent({ site: "s", type: "pageview", url: "/", ago: -1 })).toEqual({ ok: false, reason: "ago_invalid" });
    expect(validateEvent({ site: "s", type: "pageview", url: "/", ago: 2 * DAY })).toEqual({ ok: false, reason: "ago_too_old" });
    const v = validateEvent({ site: "s", type: "pageview", url: "/", nonce: "short" });
    expect(v.ok && v.event.nonce).toBe(undefined);
  });

  test("SDK user-agents are bucketed as apps", () => {
    expect(parseUa("Vitrus-Dart/0.1 (iPad; iOS 17.4)")).toEqual({ device: "tablet", os: "iOS", browser: "iOS app" });
    expect(parseUa("Vitrus-Dart/0.1 (Pixel 8; Android 14)")).toEqual({ device: "mobile", os: "Android", browser: "Android app" });
    expect(parseUa("Vitrus-Swift/0.1 (Mac; macOS 15.1)")).toEqual({ device: "desktop", os: "macOS", browser: "macOS app" });
  });

  test("a batch is one site, at most BATCH_MAX events", () => {
    const ev = (site: string) => ({ site, type: "pageview", url: "/" });
    expect(validateBatch({ events: [ev("a"), ev("a")] })).toMatchObject({ ok: true, site: "a" });
    expect(validateBatch({ events: [ev("a"), ev("b")] })).toEqual({ ok: false, reason: "batch_mixed_sites" });
    expect(validateBatch({ events: Array.from({ length: BATCH_MAX + 1 }, () => ev("a")) })).toEqual({ ok: false, reason: "batch_too_large" });
    expect(validateBatch({ events: [] })).toEqual({ ok: false, reason: "events_missing" });
  });
});
