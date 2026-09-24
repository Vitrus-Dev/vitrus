// packages/server/test/replay.test.ts — session replay works self-hosted, end to end over HTTP.
import { describe, expect, test } from "bun:test";
import { gzipSync } from "bun";
import { SqliteStore, type Site } from "@vitrus/core";
import { dashboardHtml } from "../src/dashboard.ts";
import { createHandler } from "../src/server.ts";

const SITE: Site = { id: "demo", name: "Demo", domain: "example.com", vertical: "landing", createdAt: 0 };
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0 Safari/537.36";
const SNAP = { i: 1, t: "html", a: {}, c: [{ i: 2, t: "body", a: {}, c: [{ i: 3, x: "*****" }] }] };

async function harness() {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.upsertSite(SITE);
  const handle = createHandler({ store, secret: "s" });
  const call = (path: string, init: RequestInit = {}) =>
    handle(new Request(`http://localhost${path}`, { ...init, headers: { "user-agent": CHROME, ...(init.headers ?? {}) } }));
  return { store, call };
}

describe("self-hosted replay", () => {
  test("off until enabled; then a gzip chunk is stored, listed, played back and deleted", async () => {
    const { call } = await harness();
    expect(await (await call("/api/replay/config?site=demo")).json()).toEqual({ record: false, reason: "replay_disabled" });

    const put = await call("/api/replay/settings?site=demo", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    expect(put.status).toBe(200);
    expect(((await (await call("/api/replay/config?site=demo")).json()) as { record: boolean }).record).toBe(true);

    const body = gzipSync(Buffer.from(JSON.stringify([[0, 0, SNAP, 1024, 768, "/"], [800, 3, 3, 10, 10]])));
    const post = await call("/api/replay/chunk?site=demo&page=pageload0001&seq=0&enc=gzip", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body,
    });
    expect(post.status).toBe(204);
    expect(post.headers.get("access-control-allow-origin")).toBe("*");

    const list = (await (await call("/api/replays?site=demo")).json()) as { replays: { id: string; clicks: number; name: string }[] };
    expect(list.replays.length).toBe(1);
    expect(list.replays[0]!.clicks).toBe(1);
    expect(list.replays[0]!.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);

    const id = list.replays[0]!.id;
    const play = (await (await call(`/api/replays/${id}?site=demo`)).json()) as { events: unknown[][] };
    expect(play.events.length).toBe(2);

    expect((await call(`/api/replays/${id}?site=demo`, { method: "DELETE" })).status).toBe(200);
    expect((await call(`/api/replays/${id}?site=demo`)).status).toBe(404);
  });

  test("an unknown site is 404 on every replay endpoint", async () => {
    const { call } = await harness();
    expect((await call("/api/replays?site=nope")).status).toBe(404);
    expect((await call("/api/replay/settings?site=nope")).status).toBe(404);
  });

  test("the self-hosted dashboard ships the replay player", () => {
    const html = dashboardHtml([SITE]);
    expect(html).toContain("vrPlayer");
    expect(html).toContain('sandbox="allow-same-origin"');
    expect(html).not.toContain("allow-scripts");
  });
});
