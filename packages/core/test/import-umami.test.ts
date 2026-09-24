// packages/core/test/import-umami.test.ts — Umami CSV → events: mapping, idempotent
// re-import, no overlap with native data, removable, wrong file writes nothing.
import { beforeEach, expect, test } from "bun:test";
import { freshStore, SITE } from "./helpers.ts";
import type { SqliteStore } from "../src/store/sqlite.ts";
import { ImportError, importUmamiCsv, parseCsv, removeImport } from "../src/import-umami.ts";

let store: SqliteStore;
beforeEach(async () => {
  store = await freshStore();
});

const HEAD =
  "website_id,session_id,visit_id,event_id,hostname,browser,os,device,screen,language,country,region,city,url_path,url_query," +
  "utm_source,utm_medium,utm_campaign,utm_content,utm_term,referrer_path,referrer_query,referrer_domain,page_title,gclid,fbclid," +
  "msclkid,ttclid,li_fat_id,twclid,event_type,event_name,tag,distinct_id,created_at,job_id";
function row(o: Partial<Record<string, string>>): string {
  const d: Record<string, string> = {
    website_id: "w", session_id: "s1", visit_id: "v1", event_id: "e1", hostname: "example.com", browser: "chrome",
    os: "Mac OS", device: "laptop", screen: "1440x900", language: "en-US", country: "DE", region: "BE", city: "Berlin",
    url_path: "/", url_query: "", utm_source: "", utm_medium: "", utm_campaign: "", utm_content: "", utm_term: "",
    referrer_path: "", referrer_query: "", referrer_domain: "", page_title: "Home", gclid: "", fbclid: "", msclkid: "",
    ttclid: "", li_fat_id: "", twclid: "", event_type: "1", event_name: "", tag: "", distinct_id: "",
    created_at: "2026-03-01 10:00:00", job_id: "",
  };
  const v = { ...d, ...o };
  return HEAD.split(",").map((k) => {
    const x = v[k] ?? "";
    return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
  }).join(",");
}
const csv = (...rows: string[]) => [HEAD, ...rows].join("\r\n") + "\r\n";
const opts = (batchId = "b1", stopAt: number | null = null) => ({ siteId: SITE.id, selfHost: "example.com", batchId, stopAt });

test("RFC 4180: quotes, doubled quotes, commas and newlines inside a field", () => {
  const rows = [...parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\r\n')];
  expect(rows).toEqual([["a", "b"], ["x, y", 'say "hi"\nthere']]);
});

test("maps Umami's naming onto ours: visit → session, session → visitor", async () => {
  const s = await importUmamiCsv(
    store,
    csv(
      row({ event_id: "e1", referrer_domain: "www.google.com", referrer_path: "/search" }),
      row({ event_id: "e2", url_path: "/pricing", referrer_domain: "example.com", created_at: "2026-03-01 10:01:00" }),
      row({ event_id: "e3", event_type: "2", event_name: "signup", url_path: "/pricing", created_at: "2026-03-01 10:02:00" }),
      row({ event_id: "e4", session_id: "s2", visit_id: "v9", browser: "ios", os: "iOS", device: "mobile", created_at: "2026-03-02 09:00:00" })
    ),
    opts()
  );
  expect(s.imported).toBe(4);
  expect(s.skipped).toEqual({});
  expect(s.from).toBe(Date.UTC(2026, 2, 1, 10, 0, 0));
  const ev = await store.select<Record<string, unknown>>(
    `SELECT id, type, name, path, channel, source, browser, os, device, country, region, city, session_id, visitor_id FROM events ORDER BY ts`
  );
  expect(ev[0]).toMatchObject({ id: "umami:e1", type: "pageview", channel: "search", source: "google", browser: "Chrome", os: "macOS", device: "desktop", country: "DE", region: "DE-BE", city: "Berlin" });
  expect(ev[1]).toMatchObject({ channel: "internal" });
  expect(ev[2]).toMatchObject({ type: "event", name: "signup" });
  expect(ev[3]).toMatchObject({ browser: "Safari", os: "iOS", device: "mobile" });
  // Same Umami visit → one session; a different Umami session → a different visitor.
  expect(new Set(ev.slice(0, 3).map((e) => e.session_id)).size).toBe(1);
  expect(ev[3]!.visitor_id).not.toBe(ev[0]!.visitor_id);
  expect(String(ev[0]!.session_id)).toStartWith("umami-");
});

test("importing the same file twice adds nothing, and says so", async () => {
  const file = csv(row({ event_id: "e1" }), row({ event_id: "e2", created_at: "2026-03-01 10:05:00" }));
  await importUmamiCsv(store, file, opts("b1"));
  const again = await importUmamiCsv(store, file, opts("b2"));
  expect(again.imported).toBe(0);
  expect(again.skipped.already_imported).toBe(2);
  expect((await store.select<{ n: number }>(`SELECT COUNT(*) AS n FROM events`))[0]?.n).toBe(2);
});

test("rows from when Vitrus was already collecting are skipped, not double-counted", async () => {
  const s = await importUmamiCsv(
    store,
    csv(row({ event_id: "old" }), row({ event_id: "new", created_at: "2026-04-01 00:00:00" })),
    opts("b1", Date.UTC(2026, 2, 15))
  );
  expect(s.imported).toBe(1);
  expect(s.skipped.overlaps_vitrus_data).toBe(1);
});

test("bad rows are counted by reason; a wrong file writes nothing", async () => {
  const s = await importUmamiCsv(
    store,
    csv(row({ event_id: "a", created_at: "yesterday" }), row({ event_id: "b", event_type: "7" }), row({ event_id: "c", event_type: "2", event_name: "" })),
    opts()
  );
  expect(s.imported).toBe(0);
  expect(s.skipped).toEqual({ bad_timestamp: 1, unknown_event_type: 1, event_without_name: 1 });
  await expect(importUmamiCsv(store, "date,visitors,pageviews\n2026-03-01,4,9\n", opts())).rejects.toThrow(ImportError);
  await expect(importUmamiCsv(store, "date,visitors\n", opts())).rejects.toThrow(/missing columns event_id, session_id/);
});

test("a batch can be removed, and only that batch", async () => {
  await importUmamiCsv(store, csv(row({ event_id: "e1" })), opts("b1"));
  await importUmamiCsv(store, csv(row({ event_id: "e2", created_at: "2026-03-01 11:00:00" })), opts("b2"));
  expect(await removeImport(store, SITE.id, "b1")).toBe(1);
  const left = await store.select<{ id: string }>(`SELECT id FROM events`);
  expect(left.map((r) => r.id)).toEqual(["umami:e2"]);
});
