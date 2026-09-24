#!/usr/bin/env bun
// packages/cli/src/cli.ts — the shell around the one-command-install promise.
//
//   vitrus init                     → database + secret salt
//   vitrus site add <name> <domain> → register a site + print the script tag
//   vitrus site ls
//   vitrus start [--port 3000]      → ingest + dashboard
//   vitrus digest <site> [--days 7] [--llm ollama:gemma3:4b]
//   vitrus demo <site>              → generate sample traffic so the dashboard is not empty

import {
  Ingestor,
  OllamaClient,
  OpenAiCompatClient,
  SqliteStore,
  buildBundle,
  composeDigest,
  phraseDigest,
  previousWindow,
  renderText,
  windowOf,
  type LlmClient,
  type Site,
} from "@vitrus/core";
import { startServer } from "@vitrus/server";

const DB = process.env.VITRUS_DB ?? "./vitrus.db";

async function open(): Promise<SqliteStore> {
  const store = new SqliteStore(DB);
  await store.init();
  return store;
}

async function secretOf(store: SqliteStore): Promise<string> {
  let s = await store.getMeta("visitor_secret");
  if (!s) {
    s = crypto.randomUUID() + crypto.randomUUID();
    await store.setMeta("visitor_secret", s);
  }
  return s;
}

function flag(args: string[], name: string, fallback?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}

function newSiteId(domain: string): string {
  const slug = domain.toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 6);
  return `${slug || "site"}-${rand}`;
}

function llmFrom(spec: string | undefined): LlmClient | null {
  if (!spec) return null;
  const [kind, ...rest] = spec.split(":");
  const model = rest.join(":");
  if (kind === "ollama") return new OllamaClient(model || "gemma3:4b", process.env.OLLAMA_URL ?? "http://127.0.0.1:11434");
  if (kind === "openai") {
    const key = process.env.VITRUS_LLM_KEY;
    if (!key) {
      console.error("VITRUS_LLM_KEY is not set — bring your own key.");
      process.exit(1);
    }
    return new OpenAiCompatClient(model, key, process.env.VITRUS_LLM_URL ?? "https://api.openai.com/v1");
  }
  console.error(`unknown llm: ${spec} (ollama:<model> or openai:<model>)`);
  process.exit(1);
}

const HELP = `vitrus — provable analytics

  vitrus init                          prepare the database
  vitrus site add <name> <domain>      add a site  [--vertical landing|shopify|generic]
  vitrus site ls                       list sites
  vitrus start [--port 3000]           ingest + dashboard
  vitrus digest <site-id> [--days 7]   build a summary  [--llm ollama:<model>] [--json]
  vitrus demo <site-id> [--days 7]     generate sample traffic (development only)

Environment: VITRUS_DB (default ./vitrus.db)`;

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }

  if (cmd === "init") {
    const store = await open();
    await secretOf(store);
    console.log(`✓ ${DB} is ready.`);
    console.log(`  next: vitrus site add "My site" example.com`);
    await store.close();
    return;
  }

  if (cmd === "site") {
    const store = await open();
    const sub = args[0];
    if (sub === "add") {
      const name = args[1];
      const domain = args[2];
      if (!name || !domain) {
        console.error('usage: vitrus site add "Name" example.com [--vertical landing]');
        process.exit(1);
      }
      const vertical = (flag(args, "vertical", "landing") ?? "landing") as Site["vertical"];
      const site: Site = { id: newSiteId(domain), name, domain, vertical, createdAt: Date.now() };
      await store.upsertSite(site);
      console.log(`✓ site: ${site.id}  (${site.vertical})\n`);
      console.log("Add this tag to your site's <head>:\n");
      console.log(`  <script defer data-site="${site.id}" src="http://localhost:3000/v.js"></script>\n`);
    } else if (sub === "ls" || !sub) {
      const sites = await store.listSites();
      if (!sites.length) console.log("(no sites)");
      for (const s of sites) console.log(`${s.id}\t${s.name}\t${s.domain}\t${s.vertical}`);
    } else {
      console.error(`unknown subcommand: ${sub}`);
      process.exit(1);
    }
    await store.close();
    return;
  }

  if (cmd === "start") {
    const store = await open();
    const secret = await secretOf(store);
    const port = Number(flag(args, "port", process.env.PORT ?? "3000"));
    const server = await startServer({ store, secret, port });
    console.log(`vitrus → http://localhost:${server.port}   (db: ${DB})`);
    console.log("The dashboard is up; add the script tag to your site and data will start arriving.");
    return; // the process stays alive
  }

  if (cmd === "digest") {
    const siteId = args[0];
    if (!siteId) {
      console.error("usage: vitrus digest <site-id> [--days 7]");
      process.exit(1);
    }
    const store = await open();
    const site = await store.getSite(siteId);
    if (!site) {
      console.error(`no such site: ${siteId}`);
      process.exit(1);
    }
    const days = Number(flag(args, "days", "7"));
    const win = windowOf(Date.now(), days, `last ${days} days`);
    const bundle = await buildBundle(store, {
      siteId: site.id,
      vertical: site.vertical,
      window: win,
      compare: previousWindow(win),
    });
    const llm = llmFrom(flag(args, "llm"));
    const outcome = await phraseDigest(bundle, llm);
    if (args.includes("--json")) {
      console.log(JSON.stringify({ digest: outcome.digest, evidence: bundle.evidence }, null, 2));
    } else {
      console.log(renderText(outcome.digest));
      if (llm) {
        console.log(
          `\n[llm: ${llm.name} · ${outcome.used ? "used" : "skipped"}` +
            (outcome.droppedSentences ? ` · the guard dropped ${outcome.droppedSentences} sentence(s)` : "") +
            "]"
        );
        for (const d of outcome.dropped) console.log(`  ✗ unproven number ${d.numbers.join(", ")}: ${d.sentence}`);
      }
    }
    await store.close();
    return;
  }

  if (cmd === "demo") {
    const siteId = args[0];
    if (!siteId) {
      console.error("usage: vitrus demo <site-id>");
      process.exit(1);
    }
    const store = await open();
    const site = await store.getSite(siteId);
    if (!site) {
      console.error(`no such site: ${siteId}`);
      process.exit(1);
    }
    const n = await seedDemo(store, site, Number(flag(args, "days", "7")));
    console.log(`✓ generated ${n} sample events — dashboard: http://localhost:3000`);
    await store.close();
    return;
  }

  console.error(`unknown command: ${cmd}\n`);
  console.log(HELP);
  process.exit(1);
}

/** Realistic sample traffic so the dashboard is not empty. Development only. */
async function seedDemo(store: SqliteStore, site: Site, days: number): Promise<number> {
  const ing = new Ingestor(store, { secret: await secretOf(store) });
  const now = Date.now();
  const CHROME =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
  const IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const refs = [
    "https://chatgpt.com/",
    "https://www.perplexity.ai/search/x",
    "https://www.google.com/",
    "https://news.ycombinator.com/",
    "",
    "",
  ];
  const paths = ["/", "/pricing", "/blog/why-vitrus", "/signup"];
  // Sample locations, in the shape a proxy with city headers would send
  // (see core/geo.ts), so the globe has something to draw. Real data comes
  // only from proxy headers; nothing here is looked up from an IP.
  const places: [string, string, string, string, number, number][] = [
    ["US", "US-CA", "California", "San Francisco", 37.8, -122.4],
    ["US", "US-NY", "New York", "New York", 40.7, -74.0],
    ["US", "US-TX", "Texas", "Austin", 30.3, -97.7],
    ["DE", "DE-BE", "Berlin", "Berlin", 52.5, 13.4],
    ["GB", "GB-ENG", "England", "London", 51.5, -0.1],
    ["FR", "FR-IDF", "Ile-de-France", "Paris", 48.9, 2.4],
    ["TR", "TR-34", "Istanbul", "Istanbul", 41.0, 29.0],
    ["IN", "IN-KA", "Karnataka", "Bengaluru", 13.0, 77.6],
    ["JP", "JP-13", "Tokyo", "Tokyo", 35.7, 139.7],
    ["BR", "BR-SP", "Sao Paulo", "Sao Paulo", -23.5, -46.6],
    ["AU", "AU-NSW", "New South Wales", "Sydney", -33.9, 151.2],
    ["CA", "CA-ON", "Ontario", "Toronto", 43.7, -79.4],
  ];
  let count = 0;
  let seed = 42;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

  for (let d = days * 2; d >= 0; d--) {
    const visits = 3 + Math.floor(rnd() * 6);
    for (let i = 0; i < visits; i++) {
      const ts = now - d * 86_400_000 + Math.floor(rnd() * 20) * 60_000;
      const ip = `198.51.${d}.${i}`;
      const ua = rnd() > 0.6 ? IPHONE : CHROME;
      const referrer = refs[Math.floor(rnd() * refs.length)] ?? "";
      const path = paths[Math.floor(rnd() * paths.length)] ?? "/";
      const pl = places[Math.floor(rnd() * places.length)]!;
      const ctx = {
        ip,
        userAgent: ua,
        now: ts,
        host: site.domain,
        country: pl[0],
        geo: { region: pl[1], regionName: pl[2], city: pl[3], lat: pl[4], lon: pl[5] },
      };
      await ing.ingest({ site: site.id, type: "pageview", url: path, referrer }, ctx);
      count++;
      // Some sessions go on to a second page — otherwise the bounce rate would be 100%.
      if (rnd() > 0.45) {
        const second = paths[Math.floor(rnd() * paths.length)] ?? "/pricing";
        await ing.ingest(
          { site: site.id, type: "pageview", url: second, referrer: `https://${site.domain}${path}` },
          { ...ctx, now: ts + 70_000 }
        );
        count++;
      }
      if (rnd() > 0.7) {
        await ing.ingest(
          { site: site.id, type: "event", name: "cta_click", url: path, props: { label: "Start free" } },
          { ...ctx, now: ts + 30_000 }
        );
        count++;
      }
      if (rnd() > 0.85) {
        await ing.ingest(
          { site: site.id, type: "event", name: "form_abandon", url: "/signup", props: { field: "phone" } },
          { ...ctx, now: ts + 60_000 }
        );
        count++;
      }
      if (rnd() > 0.93) {
        await ing.ingest(
          { site: site.id, type: "event", name: "signup", url: "/signup" },
          { ...ctx, now: ts + 90_000 }
        );
        count++;
      }
      await ing.ingest(
        { site: site.id, type: "event", name: "scroll", url: path, props: { percent: 25 + Math.floor(rnd() * 75) } },
        { ...ctx, now: ts + 45_000 }
      );
      count++;
    }
    // AI crawler reads
    if (rnd() > 0.5) {
      await ing.ingest(
        { site: site.id, type: "pageview", url: "/blog/why-vitrus" },
        { ip: "52.230.1.1", userAgent: "Mozilla/5.0 (compatible; GPTBot/1.2)", now: now - d * 86_400_000, host: site.domain }
      );
      count++;
    }
  }
  return count;
}

await main(process.argv.slice(2));
