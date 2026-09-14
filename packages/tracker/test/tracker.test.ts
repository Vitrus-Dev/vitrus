// packages/tracker/test/tracker.test.ts
// Loads the tracker in a REAL DOM (happy-dom) and exercises its behaviour.
// The critical claims: a form VALUE is never sent, SPA navigation is counted,
// the rage-click threshold works, and the tracker never throws.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

interface Sent {
  url: string;
  body: Record<string, unknown>;
}

let win: Window;
let sent: Sent[];

async function loadTracker(attrs: Record<string, string> = {}): Promise<void> {
  const code = await Bun.file(new URL("../dist/v.js", import.meta.url)).text();
  const doc = win.document as unknown as Document;
  const script = doc.createElement("script");
  script.setAttribute("data-site", attrs["data-site"] ?? "demo");
  script.setAttribute("src", attrs.src ?? "http://localhost:3000/v.js");
  for (const [k, v] of Object.entries(attrs)) script.setAttribute(k, v);
  doc.head.appendChild(script);
  // happy-dom does not set currentScript automatically; pin it during evaluation.
  Object.defineProperty(doc, "currentScript", { value: script, configurable: true });
  new Function(code).call(win);
}

beforeEach(() => {
  sent = [];
  win = new Window({ url: "https://example.com/" });
  const w = win as unknown as {
    fetch: typeof fetch;
    navigator: { sendBeacon?: (url: string, data: unknown) => boolean };
  };
  w.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  // Disable sendBeacon so every path is observable through fetch.
  w.navigator.sendBeacon = undefined;

  Object.assign(globalThis, {
    window: win,
    document: win.document,
    location: win.location,
    navigator: win.navigator,
    screen: win.screen,
    history: win.history,
    addEventListener: win.addEventListener.bind(win),
    fetch: w.fetch,
    localStorage: win.localStorage,
  });
  win.localStorage.clear();
});

afterEach(async () => {
  await win.happyDOM.close();
});

describe("tracker", () => {
  test("sends exactly one pageview on load", async () => {
    await loadTracker();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("http://localhost:3000/api/collect");
    expect(sent[0]?.body).toMatchObject({ site: "demo", type: "pageview", url: "/" });
  });

  test("sends NOTHING when data-site is missing", async () => {
    const doc = win.document as unknown as Document;
    const script = doc.createElement("script");
    script.setAttribute("src", "http://localhost:3000/v.js");
    doc.head.appendChild(script);
    Object.defineProperty(doc, "currentScript", { value: script, configurable: true });
    const code = await Bun.file(new URL("../dist/v.js", import.meta.url)).text();
    new Function(code).call(win);
    expect(sent).toHaveLength(0);
  });

  test("a pushState SPA navigation counts as a new pageview", async () => {
    await loadTracker();
    win.history.pushState({}, "", "/fiyat");
    expect(sent.filter((s) => s.body.type === "pageview")).toHaveLength(2);
    expect(sent[sent.length - 1]?.body.url).toBe("/fiyat");
  });

  test("pushState to the same path does not produce a second pageview", async () => {
    await loadTracker();
    win.history.pushState({}, "", "/fiyat");
    win.history.pushState({}, "", "/fiyat");
    expect(sent.filter((s) => s.body.type === "pageview")).toHaveLength(2);
  });

  test("window.vitrus() sends a custom event", async () => {
    await loadTracker();
    (win as unknown as { vitrus: (n: string, p?: Record<string, unknown>) => void }).vitrus("signup", { plan: "pro" });
    const last = sent[sent.length - 1];
    expect(last?.body).toMatchObject({ type: "event", name: "signup" });
    expect((last?.body.props as Record<string, unknown>)?.plan).toBe("pro");
  });

  test("on form abandonment the FIELD NAME is sent, the VALUE never is", async () => {
    await loadTracker();
    const doc = win.document as unknown as Document;
    doc.body.innerHTML = `<form><input name="telefon" type="tel"></form>`;
    const input = doc.querySelector("input") as HTMLInputElement;
    input.value = "5551234567"; // must stay private
    input.dispatchEvent(new win.Event("focusin", { bubbles: true }) as unknown as Event);
    win.dispatchEvent(new win.Event("pagehide") as never);

    const abandon = sent.find((s) => s.body.name === "form_abandon");
    expect(abandon).toBeDefined();
    expect((abandon?.body.props as Record<string, unknown>)?.field).toBe("telefon");
    expect(JSON.stringify(sent)).not.toContain("5551234567");
  });

  test("a password field is never tracked at all", async () => {
    await loadTracker();
    const doc = win.document as unknown as Document;
    doc.body.innerHTML = `<form><input name="sifre" type="password"></form>`;
    (doc.querySelector("input") as HTMLInputElement).dispatchEvent(
      new win.Event("focusin", { bubbles: true }) as unknown as Event
    );
    win.dispatchEvent(new win.Event("pagehide") as never);
    expect(sent.find((s) => s.body.name === "form_abandon")).toBeUndefined();
  });

  test("no abandonment event is produced when the form was submitted", async () => {
    await loadTracker();
    const doc = win.document as unknown as Document;
    doc.body.innerHTML = `<form><input name="email"></form>`;
    (doc.querySelector("input") as HTMLInputElement).dispatchEvent(
      new win.Event("focusin", { bubbles: true }) as unknown as Event
    );
    (doc.querySelector("form") as HTMLFormElement).dispatchEvent(
      new win.Event("submit", { bubbles: true }) as unknown as Event
    );
    win.dispatchEvent(new win.Event("pagehide") as never);
    expect(sent.find((s) => s.body.name === "form_abandon")).toBeUndefined();
  });

  test("a data-vitrus-cta click produces cta_click", async () => {
    await loadTracker();
    const doc = win.document as unknown as Document;
    doc.body.innerHTML = `<button data-vitrus-cta>Start free</button>`;
    (doc.querySelector("button") as HTMLButtonElement).dispatchEvent(
      new win.MouseEvent("click", { bubbles: true }) as unknown as Event
    );
    const cta = sent.find((s) => s.body.name === "cta_click");
    expect(cta).toBeDefined();
    expect((cta?.body.props as Record<string, unknown>)?.label).toBe("Start free");
  });

  test("an external link produces outbound_click, an internal one does not", async () => {
    await loadTracker();
    const doc = win.document as unknown as Document;
    doc.body.innerHTML = `<a id="out" href="https://github.com/x">external</a><a id="in" href="/pricing">internal</a>`;
    (doc.querySelector("#out") as HTMLElement).dispatchEvent(
      new win.MouseEvent("click", { bubbles: true }) as unknown as Event
    );
    (doc.querySelector("#in") as HTMLElement).dispatchEvent(
      new win.MouseEvent("click", { bubbles: true }) as unknown as Event
    );
    const outbound = sent.filter((s) => s.body.name === "outbound_click");
    expect(outbound).toHaveLength(1);
    expect((outbound[0]?.body.props as Record<string, unknown>)?.host).toBe("github.com");
  });

  test("rage click: 3 clicks on the same spot fire, 2 do not", async () => {
    await loadTracker();
    const doc = win.document as unknown as Document;
    doc.body.innerHTML = `<div id="t">click</div>`;
    const el = doc.querySelector("#t") as HTMLElement;
    const click = (x: number, y: number) =>
      el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, clientX: x, clientY: y }) as unknown as Event);

    click(10, 10);
    click(12, 11);
    expect(sent.filter((s) => s.body.name === "rage_click")).toHaveLength(0);
    click(11, 12);
    expect(sent.filter((s) => s.body.name === "rage_click")).toHaveLength(1);
  });

  test("clicks far apart do not count as rage", async () => {
    await loadTracker();
    const doc = win.document as unknown as Document;
    doc.body.innerHTML = `<div id="t">click</div>`;
    const el = doc.querySelector("#t") as HTMLElement;
    for (const [x, y] of [
      [10, 10],
      [300, 300],
      [600, 600],
    ]) {
      el.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, clientX: x, clientY: y }) as unknown as Event
      );
    }
    expect(sent.filter((s) => s.body.name === "rage_click")).toHaveLength(0);
  });

  test("the body carries only whitelisted fields; no cookie, no stored identifier", async () => {
    await loadTracker();
    // This list is deliberately STRICT: adding a field breaks this test and
    // forces a decision. A privacy claim is only defensible when the exact list
    // of what is sent is known.
    const keys = Object.keys(sent[0]?.body ?? {}).sort();
    expect(keys).toEqual(["hostname", "lang", "referrer", "screen", "site", "title", "type", "url"]);
    const code = await Bun.file(new URL("../dist/v.js", import.meta.url)).text();
    expect(code).not.toContain("document.cookie");
    // localStorage is touched in exactly ONE place: the "exclude my own visits"
    // flag. That value is the literal string "1", it is never sent, and it is
    // not an identifier. Any second use would mean we had quietly started
    // storing something about the visitor — so the count is pinned here.
    expect([...code.matchAll(/localStorage/g)]).toHaveLength(3);
    expect(code).toContain("vitrus.ignore");
  });

  test("with Do Not Track on, NOTHING is sent", async () => {
    Object.defineProperty(win.navigator, "doNotTrack", { value: "1", configurable: true });
    (globalThis as unknown as { navigator: Navigator }).navigator = win.navigator as unknown as Navigator;
    await loadTracker();
    expect(sent).toHaveLength(0);
  });

  test("data-do-not-track=false allows DNT to be overridden", async () => {
    Object.defineProperty(win.navigator, "doNotTrack", { value: "1", configurable: true });
    (globalThis as unknown as { navigator: Navigator }).navigator = win.navigator as unknown as Navigator;
    await loadTracker({ "data-do-not-track": "false" });
    expect(sent).toHaveLength(1);
  });

  test("data-tag is added to the body (the release/variant marker)", async () => {
    await loadTracker({ "data-tag": "v2" });
    expect(sent[0]?.body.tag).toBe("v2");
  });

  test("a same-origin referrer is NOT SENT — our own page is not a source", async () => {
    Object.defineProperty(win.document, "referrer", {
      value: "https://example.com/onceki",
      configurable: true,
    });
    (globalThis as unknown as { document: Document }).document = win.document as unknown as Document;
    await loadTracker();
    expect(sent[0]?.body.referrer).toBe("");
  });

  test("an external referrer is preserved", async () => {
    Object.defineProperty(win.document, "referrer", {
      value: "https://chatgpt.com/",
      configurable: true,
    });
    (globalThis as unknown as { document: Document }).document = win.document as unknown as Document;
    await loadTracker();
    expect(sent[0]?.body.referrer).toBe("https://chatgpt.com/");
  });

  test("data-vitrus-event-* attributes become event properties", async () => {
    await loadTracker();
    const doc = win.document as unknown as Document;
    doc.body.innerHTML =
      `<button data-vitrus="purchase" data-vitrus-event-plan="pro" data-vitrus-event-slot="hero">Buy</button>`;
    (doc.querySelector("button") as HTMLButtonElement).dispatchEvent(
      new win.MouseEvent("click", { bubbles: true }) as unknown as Event
    );
    const ev = sent.find((s) => s.body.name === "purchase");
    expect(ev).toBeDefined();
    const props = ev?.body.props as Record<string, unknown>;
    expect(props.plan).toBe("pro");
    expect(props.slot).toBe("hero");
  });

  test("the tracker never throws even when fetch blows up", async () => {
    const boom = () => {
      throw new Error("no network");
    };
    (globalThis as unknown as { fetch: unknown }).fetch = boom;
    (win as unknown as { fetch: unknown }).fetch = boom;
    await loadTracker(); // if it throws, the test fails
    expect(true).toBe(true);
  });
});

describe("path patterns", () => {
  test("a skipped path sends NOTHING at all", async () => {
    win.happyDOM.setURL("https://example.com/admin/users");
    await loadTracker({ "data-skip-patterns": '["/admin/**"]' });
    expect(sent).toHaveLength(0);
  });

  test("skipping is per page — other pages are still measured", async () => {
    win.happyDOM.setURL("https://example.com/pricing");
    await loadTracker({ "data-skip-patterns": '["/admin/**"]' });
    expect(sent).toHaveLength(1);
  });

  test("a skipped page is silent for custom events too, not just pageviews", async () => {
    win.happyDOM.setURL("https://example.com/admin/users");
    await loadTracker({ "data-skip-patterns": '["/admin/**"]' });
    (win as unknown as { vitrus: (n: string) => void }).vitrus("cta_click");
    expect(sent).toHaveLength(0);
  });

  test("`*` matches exactly one segment", async () => {
    win.happyDOM.setURL("https://example.com/a/b/c");
    await loadTracker({ "data-skip-patterns": '["/a/*"]' });
    // "/a/*" is two segments after the root; "/a/b/c" is three — no match.
    expect(sent).toHaveLength(1);
  });

  test("a masked segment never leaves the browser", async () => {
    win.happyDOM.setURL("https://example.com/invoice/8841/pdf");
    await loadTracker({ "data-mask-patterns": '["/invoice/*/pdf"]' });
    expect(sent[0]?.body.url).toBe("/invoice/*/pdf");
    expect(JSON.stringify(sent)).not.toContain("8841");
  });

  test("`**` masks the whole tail", async () => {
    win.happyDOM.setURL("https://example.com/u/ayse@example.com/settings");
    await loadTracker({ "data-mask-patterns": '["/u/**"]' });
    expect(sent[0]?.body.url).toBe("/u/**");
    expect(JSON.stringify(sent)).not.toContain("ayse@example.com");
  });

  test("the masked path is also used in event props, not just the pageview url", async () => {
    win.happyDOM.setURL("https://example.com/invoice/8841/pdf");
    await loadTracker({ "data-mask-patterns": '["/invoice/*/pdf"]' });
    const doc = win.document as unknown as Document;
    doc.body.innerHTML = `<button data-vitrus-cta>Download</button>`;
    (doc.querySelector("[data-vitrus-cta]") as HTMLElement).click();
    const cta = sent.find((x) => x.body.name === "cta_click");
    expect((cta?.body.props as Record<string, unknown>)?.path).toBe("/invoice/*/pdf");
    expect(JSON.stringify(sent)).not.toContain("8841");
  });

  test("a query string survives masking — only path segments are masked", async () => {
    win.happyDOM.setURL("https://example.com/invoice/8841/pdf?utm_source=newsletter");
    await loadTracker({ "data-mask-patterns": '["/invoice/*/pdf"]' });
    expect(sent[0]?.body.url).toBe("/invoice/*/pdf?utm_source=newsletter");
  });

  test("a malformed pattern attribute is ignored, never a crash", async () => {
    await loadTracker({ "data-skip-patterns": "not json at all" });
    expect(sent).toHaveLength(1);
  });
});

describe("excluding your own visits", () => {
  test("?vitrus_ignore=1 stops this browser being measured", async () => {
    win.happyDOM.setURL("https://example.com/?vitrus_ignore=1");
    await loadTracker();
    expect(sent).toHaveLength(0);
    expect(win.localStorage.getItem("vitrus.ignore")).toBe("1");
  });

  test("the exclusion persists on later visits without the parameter", async () => {
    win.localStorage.setItem("vitrus.ignore", "1");
    await loadTracker();
    expect(sent).toHaveLength(0);
  });

  test("?vitrus_ignore=0 turns measurement back on", async () => {
    win.localStorage.setItem("vitrus.ignore", "1");
    win.happyDOM.setURL("https://example.com/?vitrus_ignore=0");
    await loadTracker();
    expect(sent).toHaveLength(1);
    expect(win.localStorage.getItem("vitrus.ignore")).toBeNull();
  });

  test("the stored flag is not an identifier — it is the literal string \"1\"", async () => {
    win.happyDOM.setURL("https://example.com/?vitrus_ignore=1");
    await loadTracker();
    expect(Object.keys(win.localStorage)).toEqual(["vitrus.ignore"]);
    expect(win.localStorage.getItem("vitrus.ignore")).toBe("1");
  });
});
