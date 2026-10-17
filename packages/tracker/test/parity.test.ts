// packages/tracker/test/parity.test.ts
// File downloads, hash routing and identify() traits — in a real DOM.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Window } from "happy-dom";
import { isPersonalKey } from "../../core/src/pii.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const tick = () => new Promise((r) => setTimeout(r, 15));

let win: Window;
let sent: { body: Record<string, unknown> }[];

async function load(attrs: Record<string, string> = {}): Promise<void> {
  const code = await Bun.file(new URL("../dist/v.js", import.meta.url)).text();
  const doc = win.document as unknown as Document;
  const script = doc.createElement("script");
  script.setAttribute("data-site", "demo");
  script.setAttribute("src", "http://localhost:3000/v.js");
  for (const [k, v] of Object.entries(attrs)) script.setAttribute(k, v);
  doc.head.appendChild(script);
  Object.defineProperty(doc, "currentScript", { value: script, configurable: true });
  new Function(code).call(win);
}

beforeEach(() => {
  sent = [];
  win = new Window({ url: "https://example.com/" });
  const w = win as unknown as { fetch: typeof fetch; navigator: { sendBeacon?: unknown } };
  w.fetch = (async (_url: string, init?: RequestInit) => {
    sent.push({ body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  w.navigator.sendBeacon = undefined;
  Object.assign(globalThis, {
    window: win, document: win.document, location: win.location, navigator: win.navigator,
    screen: win.screen, history: win.history, addEventListener: win.addEventListener.bind(win),
    fetch: w.fetch, localStorage: win.localStorage,
  });
  win.localStorage.clear();
});

afterEach(async () => {
  await win.happyDOM.close();
});

function click(sel: string): void {
  const doc = win.document as unknown as Document;
  (doc.querySelector(sel) as HTMLElement).dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
}

describe("parity features", () => {
  test("a same-site file link is a file_download with the path only, never the query", async () => {
    await load();
    const doc = win.document as unknown as Document;
    doc.body.innerHTML = `<a id="f" href="/files/price-list.pdf?token=secret">pdf</a><a id="p" href="/pricing">page</a>`;
    click("#f");
    click("#p");
    const dl = sent.filter((s) => s.body.name === "file_download");
    expect(dl).toHaveLength(1);
    expect((dl[0]!.body.props as Record<string, unknown>).file).toBe("/files/price-list.pdf");
    expect(JSON.stringify(dl[0]!.body)).not.toContain("secret");
  });

  test("hash routing is off by default: a #/route is not a new page", async () => {
    await load();
    win.location.hash = "#/settings";
    win.dispatchEvent(new win.Event("hashchange"));
    expect(sent.filter((s) => s.body.type === "pageview")).toHaveLength(1);
  });

  test("with data-hash=true a #/route change is a pageview carrying the route", async () => {
    await load({ "data-hash": "true" });
    win.location.hash = "#/settings";
    win.dispatchEvent(new win.Event("hashchange"));
    const pvs = sent.filter((s) => s.body.type === "pageview");
    expect(pvs).toHaveLength(2);
    expect(pvs[1]!.body.url).toBe("/#/settings");
  });

  test("identify(id, traits) sends the traits once, with the id hashed in the browser", async () => {
    await load();
    const v = (win as unknown as { vitrus: { identify: (id: string, t?: Record<string, unknown>) => void } }).vitrus;
    v.identify("user-7", { plan: "pro" });
    await tick();
    const ev = sent.filter((s) => s.body.name === "identify");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.body.identity).toBe(sha("demo|user-7"));
    expect((ev[0]!.body.props as Record<string, unknown>).plan).toBe("pro");
    v.identify("user-7");
    await tick();
    expect(sent.filter((s) => s.body.name === "identify")).toHaveLength(1);
    // The raw id is in no payload at all.
    expect(JSON.stringify(sent)).not.toContain("user-7");
  });

  test("the page's hostname travels with every event", async () => {
    await load();
    expect(sent[0]!.body.hostname).toBe("example.com");
  });
});

describe("identity and personal data stay in the browser", () => {
  test("a call queued by the loader stub before the script arrived is replayed, and the first pageview carries the hashed id", async () => {
    const w = win as unknown as { vitrus: ((...a: unknown[]) => void) & { q?: unknown[][] } };
    // The documented stub: window.vitrus=window.vitrus||function(){(vitrus.q=vitrus.q||[]).push(arguments)}
    const stub = function (...a: unknown[]) { (stub.q = stub.q || []).push(a); } as ((...a: unknown[]) => void) & { q?: unknown[][] };
    w.vitrus = stub;
    w.vitrus("identify", "ayse@example.com", { plan: "free" });
    w.vitrus("signup");
    await load();
    await tick();
    const pv = sent.find((s) => s.body.type === "pageview")!;
    expect(pv.body.identity).toBe(sha("demo|ayse@example.com"));
    expect(sent.some((s) => s.body.name === "signup")).toBe(true);
    expect(JSON.stringify(sent)).not.toContain("ayse");
  });

  test("properties that name or look like personal data never leave the page", async () => {
    await load();
    const v = (win as unknown as { vitrus: (n: string, p?: Record<string, unknown>) => void }).vitrus;
    v("signup", { email: "a@b.co", Phone_Number: "x", contact: "a@b.co", mobile: "+90 532 111 22 33", plan: "pro", seats: 3 });
    await tick();
    const ev = sent.find((s) => s.body.name === "signup")!;
    expect(ev.body.props).toEqual({ Phone_Number: "x", plan: "pro", seats: 3 });
  });

  test("every key the browser drops is one the server drops too (the browser list is the short one)", async () => {
    await load();
    const keys = ["email", "mail", "phone", "first_name", "lastName", "full-name", "surname", "address", "password", "pass", "token", "ip", "tckn"];
    const v = (win as unknown as { vitrus: (n: string, p?: Record<string, unknown>) => void }).vitrus;
    v("probe", Object.fromEntries(keys.map((k) => [k, "v"])));
    await tick();
    expect(sent.find((s) => s.body.name === "probe")!.body.props).toEqual({});
    for (const k of keys) expect(isPersonalKey(k), k).toBe(true);
  });

  test("without WebCrypto (a plain-http page) the id is not sent at all — never raw", async () => {
    const real = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { value: { getRandomValues: real.getRandomValues.bind(real) }, configurable: true });
    try {
      await load();
      (win as unknown as { vitrus: { identify: (id: string) => void } }).vitrus.identify("user-9");
      (win as unknown as { vitrus: (n: string) => void }).vitrus("after");
      await tick();
      const ev = sent.find((s) => s.body.name === "after")!;
      expect(ev.body.identity).toBeUndefined();
      expect(JSON.stringify(sent)).not.toContain("user-9");
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: real, configurable: true });
    }
  });
});
