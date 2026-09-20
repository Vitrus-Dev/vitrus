// packages/core/test/agent-session.test.ts
//
// An agentic browser (ChatGPT Atlas, OpenAI Operator) is a real Chrome session
// driven by an agent. It runs our script, reaches the beacon, and sends an
// ordinary Chrome user-agent — observed verbatim as
// "Mozilla/5.0 (Macintosh; …) Chrome/138.0.0.0 Safari/537.36". No bot table can
// name it. What it does send is `Signature-Agent: "https://chatgpt.com"`.
//
// So the property under test is: a signed browser session is counted as ITS OWN
// class — never dropped, never merged into the human numbers, and never lumped
// in with crawlers.

import { beforeEach, describe, expect, test } from "bun:test";
import { buildBundle, windowOf } from "../src/metrics/bundle.ts";
import { computeFunnel } from "../src/metrics/funnel.ts";
import { AGENT_SESSION, HUMAN } from "../src/metrics/queries.ts";
import { detectBot } from "../src/bots.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import type { StoredEvent } from "../src/types.ts";

const NOW = Date.UTC(2026, 8, 19, 12, 0, 0);
const SITE = "s1";

/** The exact user agent ChatGPT's agent was observed sending. */
const AGENT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

let store: SqliteStore;

function ev(over: Partial<StoredEvent> & { sessionId: string }): StoredEvent {
  return {
    id: crypto.randomUUID(),
    siteId: SITE,
    visitorId: over.sessionId,
    ts: NOW - 3_600_000,
    type: "pageview",
    name: "pageview",
    path: "/",
    query: "",
    title: "",
    referrer: "",
    referrerHost: "",
    channel: "direct",
    source: "",
    utm: {},
    device: "desktop",
    os: "macOS",
    browser: "Chrome",
    screen: "",
    lang: "en",
    country: "",
    tag: "",
    identity: "",
    botKind: "",
    botName: "",
    agentTrust: "human",
    agentSigner: "",
    props: {},
    ...over,
  } as StoredEvent;
}

beforeEach(async () => {
  store = new SqliteStore(":memory:");
  await store.init();
  await store.upsertSite({ id: SITE, name: "S", domain: "s.example", vertical: "landing", createdAt: 0 });

  await store.insertEvents([
    // Two people.
    ev({ sessionId: "h1", path: "/" }),
    ev({ sessionId: "h2", path: "/" }),
    // One agent session that browses and converts.
    ev({ sessionId: "a1", path: "/", agentTrust: "verified", agentSigner: "https://chatgpt.com" }),
    ev({ sessionId: "a1", path: "/pricing", agentTrust: "verified", agentSigner: "https://chatgpt.com" }),
    ev({
      sessionId: "a1",
      path: "/pricing",
      type: "event",
      name: "signup",
      agentTrust: "verified",
      agentSigner: "https://chatgpt.com",
    }),
    // A plain crawler, for contrast.
    ev({ sessionId: "c1", path: "/", botKind: "ai-crawler", botName: "GPTBot", agentTrust: "claimed" }),
  ]);
});

const win = () => windowOf(NOW, 7, "last 7 days");
const bundle = () => buildBundle(store, { siteId: SITE, window: win(), now: NOW });
const valueOf = async (metric: string) => (await bundle()).evidence.find((e) => e.metric === metric)?.value;

describe("the user agent cannot name an agentic browser", () => {
  test("ChatGPT's agent looks exactly like Chrome to the bot table", () => {
    const v = detectBot(AGENT_UA);
    // Which is precisely why the signature, not this table, decides.
    expect(v.isBot).toBe(false);
  });

  test("a user-triggered fetch is its own kind, not a bulk crawler", () => {
    // A person asked a question thirty seconds ago; nobody is waiting behind
    // GPTBot. Summing them answers neither question.
    expect(detectBot("Mozilla/5.0 (compatible; ChatGPT-User/1.0)").kind).toBe("ai-agent");
    expect(detectBot("Mozilla/5.0 (compatible; GPTBot/1.0)").kind).toBe("ai-crawler");
  });
});

describe("an agent session is not a person", () => {
  test("it is excluded from unique visitors", async () => {
    // Two humans and one agent. Counting the agent would be GA4's behaviour.
    expect(await valueOf("visitors.unique")).toBe(2);
  });

  test("it is excluded from sessions and pageviews", async () => {
    expect(await valueOf("sessions.total")).toBe(2);
    expect(await valueOf("pageviews.total")).toBe(2);
  });

  test("the human filter and the agent filter never overlap", async () => {
    const rows = await store.select<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events WHERE (${HUMAN}) AND (${AGENT_SESSION})`
    );
    // If they could both be true the two reports would double-count.
    expect(rows[0]?.n).toBe(0);
  });

  test("it is not lumped in with crawlers either", async () => {
    // The crawler metric counts bot_kind rows; an agent session has none.
    expect(await valueOf("ai.crawler.hits")).toBe(1);
  });
});

describe("but it is not thrown away", () => {
  test("agent sessions are counted in their own metric", async () => {
    // Umami and Plausible discard this traffic; Rybbit blocks it. An agent that
    // completes a checkout is revenue, so discarding it loses a real number.
    expect(await valueOf("agent.sessions")).toBe(1);
    expect(await valueOf("agent.pageviews")).toBe(2);
  });

  test("we can say which operator the agent belonged to", async () => {
    const e = (await bundle()).evidence.find((x) => x.metric === "agent.operators")!;
    expect(e.rows[0]?.operator).toBe("https://chatgpt.com");
    expect(e.rows[0]?.sessions).toBe(1);
  });

  test("the pages an agent read are visible", async () => {
    const e = (await bundle()).evidence.find((x) => x.metric === "agent.pages")!;
    expect(e.rows.map((r) => r.path).sort()).toEqual(["/", "/pricing"]);
  });

  test("what the agent DID is visible", async () => {
    const e = (await bundle()).evidence.find((x) => x.metric === "agent.events")!;
    expect(e.rows[0]?.name).toBe("signup");
  });

  test("every agent metric carries its query, like every other number", async () => {
    for (const m of ["agent.sessions", "agent.pageviews", "agent.operators", "agent.pages"]) {
      const e = (await bundle()).evidence.find((x) => x.metric === m)!;
      expect(e.sql, m).toContain("agent_trust = 'verified'");
    }
  });
});

describe("can an agent complete the funnel?", () => {
  const steps = [
    { type: "page" as const, value: "/pricing" },
    { type: "event" as const, value: "signup" },
  ];
  const run = (audience?: "human" | "agent") =>
    computeFunnel((sql, params) => store.select(sql, params), {
      siteId: SITE,
      from: win().from,
      to: win().to,
      steps,
      ...(audience ? { audience } : {}),
    });

  test("the agent funnel converts where the human funnel is empty", async () => {
    const agent = await run("agent");
    const human = await run();
    // The whole question an e-commerce site will have to answer in 2027, and it
    // cannot even be asked if agent traffic is dropped, blocked or merged.
    expect(agent.steps[0]?.sessions).toBe(1);
    expect(agent.steps[1]?.sessions).toBe(1);
    expect(human.steps[0]?.sessions).toBe(0);
  });

  test("the default audience is human, so existing callers are unchanged", async () => {
    const a = await run();
    const b = await run("human");
    expect(a.steps.map((s) => s.sessions)).toEqual(b.steps.map((s) => s.sessions));
  });

  test("the human funnel no longer counts an agent conversion as a person's", async () => {
    // This file used to inline `bot_kind = ''` instead of the HUMAN constant,
    // which was harmless until agent sessions existed and then silently wrong.
    const human = await run();
    expect(human.sql).toContain("agent_trust = 'human'");
  });

  test("the generated SQL is the evidence, for either audience", async () => {
    const agent = await run("agent");
    expect(agent.sql).toContain("agent_trust = 'verified'");
    // Step values are still parameters; only the audience shapes the query.
    expect(agent.sql).not.toContain("/pricing");
    expect(agent.params).toContain("/pricing");
  });
});

describe("a signature we could not verify is still not a person", () => {
  test("an unverifiable signed request is excluded from the human count", async () => {
    // The first request from every signing agent lands before its key
    // directory has been fetched. A person's browser does not send
    // Signature-Input, so counting that one as a visitor would be wrong —
    // and it is exactly once per operator per cache lifetime, i.e. often
    // enough to matter and rare enough to go unnoticed.
    await store.insertEvents([
      ev({ sessionId: "pending", path: "/", agentTrust: "claimed", agentSigner: "" }),
    ]);
    const b = await buildBundle(store, { siteId: SITE, window: win(), now: NOW });
    expect(b.evidence.find((e) => e.metric === "visitors.unique")?.value).toBe(2);
  });

  test("and it is not counted as an agent session either — we do not know yet", async () => {
    await store.insertEvents([
      ev({ sessionId: "pending", path: "/", agentTrust: "claimed", agentSigner: "" }),
    ]);
    const b = await buildBundle(store, { siteId: SITE, window: win(), now: NOW });
    expect(b.evidence.find((e) => e.metric === "agent.sessions")?.value).toBe(1);
    // It shows up in "self-declared" instead, with the honest label.
    expect(b.evidence.find((e) => e.metric === "agents.claimed")?.value).toBe(2);
  });
});
