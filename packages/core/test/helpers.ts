// packages/core/test/helpers.ts — tests run against a REAL store, no mocks.
import { Ingestor } from "../src/ingest.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import type { RawEvent, Site } from "../src/types.ts";

export const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
export const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

export const SITE: Site = {
  id: "demo",
  name: "Demo",
  domain: "example.com",
  vertical: "landing",
  createdAt: 0,
};

export async function freshStore(site: Site = SITE): Promise<SqliteStore> {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.upsertSite(site);
  return store;
}

export function ingestorFor(store: SqliteStore): Ingestor {
  return new Ingestor(store, { secret: "test-secret" });
}

export interface SendOpts {
  ua?: string;
  ip?: string;
  now: number;
  referrer?: string;
  url?: string;
  name?: string;
  props?: RawEvent["props"];
  type?: "pageview" | "event";
}

export async function send(ing: Ingestor, o: SendOpts) {
  const body: RawEvent = {
    site: SITE.id,
    type: o.type ?? "pageview",
    url: o.url ?? "/",
  };
  if (o.referrer) body.referrer = o.referrer;
  if (o.name) body.name = o.name;
  if (o.props) body.props = o.props;
  return ing.ingest(body, {
    ip: o.ip ?? "203.0.113.7",
    userAgent: o.ua ?? CHROME,
    now: o.now,
    host: SITE.domain,
  });
}

export const DAY = 86_400_000;
export const MIN = 60_000;
