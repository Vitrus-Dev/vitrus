// packages/tracker/test/replay.test.ts
// The session-replay recorder in a REAL DOM (happy-dom).
//
// These tests are the privacy guarantees in executable form. Each secret below
// is planted in the page and then searched for in EVERYTHING the recorder
// sends. If a password, a typed value, a card number or a blocked element's
// text ever appears in a payload, a test here fails — that is the point.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { gunzipSync } from "bun";
import { Window } from "happy-dom";

let win: Window;
let posted: { url: string; body: string }[];
let beacons: { url: string; body: string }[];
let configCalls: number;
let config: Record<string, unknown> | null;

const SECRETS = {
  password: "hunter2-PASSWORD",
  typedPassword: "typed-into-password",
  typed: "typed-secret-value",
  card: "4111111111111111",
  prefilled: "prefilled@example.com",
  pageText: "Alice Smith",
  blocked: "blocked-subtree-secret",
  script: "inlineScriptSecret",
  handler: "stealEverything",
  token: "tok_abc123",
  placeholder: "Your personal email",
  late: "Late added secret",
  lateBlocked: "late-blocked-secret",
  dataEmail: "person@example.org",
};

const PAGE = `
  <head><title>Account of ${SECRETS.pageText}</title><style>.x{color:red}</style>
    <script>var ${SECRETS.script} = 1;</script></head>
  <body>
    <h1 data-vitrus-unmask>Public headline</h1>
    <p>Welcome back, ${SECRETS.pageText}</p>
    <form>
      <input id="pw" type="password" value="${SECRETS.password}">
      <input id="txt" type="text" placeholder="${SECRETS.placeholder}" value="${SECRETS.prefilled}">
      <input id="cc" autocomplete="cc-number" value="${SECRETS.card}">
      <input id="chk" type="checkbox">
      <textarea id="ta">${SECRETS.prefilled}</textarea>
    </form>
    <div id="blk" data-vitrus-block><span>${SECRETS.blocked}</span></div>
    <div data-vitrus-unmask><input id="un" value="${SECRETS.prefilled}"></div>
    <a id="lnk" href="https://example.com/reset?token=${SECRETS.token}#frag">reset</a>
    <button onclick="${SECRETS.handler}()" data-user="${SECRETS.dataEmail}" data-state="open">Go</button>
    <img src="https://example.com/a.png">
    <iframe src="https://third.example/embed"></iframe>
    <div id="host"></div>
  </body>`;

async function tick(ms = 0): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function loadRecorder(attrs: Record<string, string> = {}): Promise<void> {
  const code = await Bun.file(new URL("../dist/r.js", import.meta.url)).text();
  const doc = win.document as unknown as Document;
  const script = doc.createElement("script");
  script.setAttribute("data-site", "demo");
  script.setAttribute("src", "http://localhost:3000/r.js");
  for (const [k, v] of Object.entries(attrs)) script.setAttribute(k, v);
  Object.defineProperty(doc, "currentScript", { value: script, configurable: true });
  new Function(code).call(win);
  // Config fetch resolves, recorder starts.
  await tick(5);
}

/** Everything sent so far, as one string (gzip bodies decoded). */
function everything(): string {
  return [...posted, ...beacons].map((p) => p.body).join("\n");
}

function unload(): void {
  win.dispatchEvent(new win.Event("pagehide"));
}

beforeEach(() => {
  posted = [];
  beacons = [];
  configCalls = 0;
  config = { record: true, maxMs: 60_000 };
  win = new Window({ url: "https://example.com/account" });
  win.document.documentElement.innerHTML = PAGE;
  const w = win as unknown as {
    fetch: typeof fetch;
    navigator: { sendBeacon?: (url: string, data: unknown) => boolean; doNotTrack?: string };
  };
  w.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/replay/config")) {
      configCalls++;
      return new Response(JSON.stringify(config), { status: 200 });
    }
    const raw = init?.body;
    let body = "";
    if (raw instanceof Blob) {
      const buf = new Uint8Array(await raw.arrayBuffer());
      body = u.includes("enc=gzip") ? new TextDecoder().decode(gunzipSync(buf)) : new TextDecoder().decode(buf);
    } else body = String(raw ?? "");
    posted.push({ url: u, body });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  w.navigator.sendBeacon = (url: string, data: unknown) => {
    beacons.push({ url, body: String(data) });
    return true;
  };
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    location: win.location,
    navigator: win.navigator,
    history: win.history,
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    addEventListener: win.addEventListener.bind(win),
    fetch: w.fetch,
    MutationObserver: win.MutationObserver,
  });
});

afterEach(async () => {
  await win.happyDOM.close();
});

describe("replay recorder — privacy guarantees", () => {
  test("a snapshot is recorded and sent", async () => {
    await loadRecorder();
    unload();
    const events = JSON.parse(beacons[0]!.body) as unknown[][];
    expect(events[0]![1]).toBe(0);
    expect(beacons[0]!.url).toContain("/api/replay/chunk?site=demo");
  });

  test("NO secret ever appears in any payload — snapshot, mutations, input, unload", async () => {
    await loadRecorder();
    const doc = win.document;

    // Typing into every kind of field.
    const pw = doc.getElementById("pw") as unknown as HTMLInputElement;
    pw.value = SECRETS.typedPassword;
    pw.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
    const txt = doc.getElementById("txt") as unknown as HTMLInputElement;
    txt.value = SECRETS.typed;
    txt.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
    const cc = doc.getElementById("cc") as unknown as HTMLInputElement;
    cc.value = SECRETS.card + "9";
    cc.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
    const un = doc.getElementById("un") as unknown as HTMLInputElement;
    un.value = SECRETS.typed;
    un.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);

    // Content arriving after the snapshot, including inside a blocked element.
    const p = doc.createElement("p");
    p.textContent = SECRETS.late;
    doc.getElementById("host")!.appendChild(p);
    const inner = doc.createElement("em");
    inner.textContent = SECRETS.lateBlocked;
    doc.getElementById("blk")!.appendChild(inner);
    // A password field added later, then an attribute change on the password field.
    const pw2 = doc.createElement("input");
    pw2.setAttribute("type", "password");
    pw2.setAttribute("value", SECRETS.password);
    doc.getElementById("host")!.appendChild(pw2);
    pw.setAttribute("value", SECRETS.password + "2");
    await tick(5);

    unload();
    const all = everything();
    expect(all.length).toBeGreaterThan(200);
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(all.includes(secret), `leaked ${name}: ${secret}`).toBe(false);
    }
    // Typing into a password field sends nothing at all — not even a masked
    // value, whose length would still say something. Only the two ordinary
    // fields produced input events.
    const inputs = [...beacons, ...posted]
      .flatMap((b) => JSON.parse(b.body) as unknown[][])
      .filter((e) => e[1] === 6);
    expect(inputs.length).toBe(2);
  });

  test("text is masked to the same length, and only data-vitrus-unmask is readable", async () => {
    await loadRecorder();
    unload();
    const all = everything();
    expect(all).toContain("Public headline");
    expect(all).toContain("******* ***** ***** *****"); // "Welcome back, Alice Smith" → same shape
    expect(all).not.toContain("Welcome");
  });

  test("unmask never reaches input values", async () => {
    await loadRecorder();
    unload();
    expect(everything()).not.toContain(SECRETS.prefilled);
  });

  test("password, card and blocked elements become boxes with no content", async () => {
    await loadRecorder();
    unload();
    const snap = (JSON.parse(beacons[0]!.body) as unknown[][])[0]![2] as Record<string, unknown>;
    const boxes: Record<string, unknown>[] = [];
    const walk = (n: Record<string, unknown>) => {
      if (n.b) boxes.push(n);
      for (const c of (n.c as Record<string, unknown>[] | undefined) ?? []) walk(c);
    };
    walk(snap);
    const tags = boxes.map((b) => b.t).sort();
    // password + card + blocked div + iframe
    expect(tags).toEqual(["div", "iframe", "input", "input"]);
    for (const b of boxes) {
      expect(b.c).toBeUndefined();
      expect(b.v).toBeUndefined();
    }
  });

  test("scripts, event handlers and link tokens are never recorded", async () => {
    await loadRecorder();
    unload();
    const all = everything();
    expect(all).not.toContain('"t":"script"');
    expect(all).not.toContain("onclick");
    expect(all).toContain("https://example.com/reset"); // the link, without query or fragment
    expect(all).not.toContain("#frag");
  });

  test("identifier-like data-* values are masked, state tokens kept", async () => {
    await loadRecorder();
    unload();
    const all = everything();
    expect(all).toContain('"data-state":"open"');
    expect(all).not.toContain(SECRETS.dataEmail);
  });

  test("images are recorded by default", async () => {
    await loadRecorder();
    unload();
    expect(everything()).toContain("a.png");
  });

  test("data-replay-block-media boxes images", async () => {
    await loadRecorder({ "data-replay-block-media": "true" });
    unload();
    expect(everything()).not.toContain("a.png");
  });

  test("the server's blockMedia setting boxes images too", async () => {
    config = { record: true, blockMedia: true };
    await loadRecorder();
    unload();
    expect(everything()).not.toContain("a.png");
  });
});

describe("replay recorder — consent and control", () => {
  test("Do Not Track: nothing is fetched, nothing is recorded", async () => {
    Object.defineProperty(win.navigator, "doNotTrack", { value: "1", configurable: true });
    await loadRecorder({ "data-do-not-track": "false" });
    unload();
    expect(configCalls).toBe(0);
    expect(everything()).toBe("");
  });

  test("the server says no: nothing is recorded", async () => {
    config = { record: false, reason: "replay_disabled" };
    await loadRecorder();
    unload();
    expect(configCalls).toBe(1);
    expect(beacons.length + posted.length).toBe(0);
  });

  test("a failed config request records nothing (fail closed)", async () => {
    config = null;
    await loadRecorder();
    unload();
    expect(beacons.length + posted.length).toBe(0);
  });

  test("a skipped path records no snapshot and no interaction", async () => {
    await loadRecorder({ "data-skip-patterns": '["/account"]' });
    const txt = win.document.getElementById("txt") as unknown as HTMLInputElement;
    txt.value = "x";
    txt.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
    unload();
    const events = beacons.flatMap((b) => JSON.parse(b.body) as unknown[][]);
    expect(events.some((e) => e[1] === 0)).toBe(false);
    expect(events.some((e) => e[1] === 6)).toBe(false);
    expect(events.some((e) => e[1] === 9 && e[2] === "skipped_page")).toBe(true);
  });

  test("mask patterns apply to the recorded path", async () => {
    await win.happyDOM.close();
    win = new Window({ url: "https://example.com/invoice/8841/pdf" });
    win.document.documentElement.innerHTML = PAGE;
    Object.assign(globalThis, { window: win, document: win.document, location: win.location, addEventListener: win.addEventListener.bind(win), history: win.history, navigator: win.navigator, MutationObserver: win.MutationObserver });
    (win as unknown as { navigator: { sendBeacon: unknown } }).navigator.sendBeacon = (url: string, data: unknown) => {
      beacons.push({ url, body: String(data) });
      return true;
    };
    (win as unknown as { fetch: unknown }).fetch = globalThis.fetch;
    await loadRecorder({ "data-mask-patterns": '["/invoice/*/pdf"]' });
    unload();
    const all = everything();
    expect(all).toContain("/invoice/*/pdf");
    expect(all).not.toContain("8841");
  });

  test("writes no cookie and no storage", async () => {
    await loadRecorder();
    unload();
    expect(win.document.cookie).toBe("");
    expect(win.localStorage.length).toBe(0);
    expect(win.sessionStorage.length).toBe(0);
  });
});

describe("replay recorder — transport", () => {
  test("chunks are gzip-compressed when CompressionStream exists", async () => {
    await loadRecorder();
    // The first scheduled flush happens after one second.
    await tick(1100);
    expect(posted.length).toBeGreaterThan(0);
    expect(posted[0]!.url).toContain("enc=gzip");
    const events = JSON.parse(posted[0]!.body) as unknown[][];
    expect(events[0]![1]).toBe(0);
  });

  test("a deliberate refusal from the server stops recording", async () => {
    await loadRecorder();
    const w = win as unknown as { fetch: typeof fetch };
    let chunkCalls = 0;
    const refuse = (async () => {
      chunkCalls++;
      return new Response(JSON.stringify({ ok: false, reason: "max_duration_reached" }), { status: 202 });
    }) as unknown as typeof fetch;
    w.fetch = refuse;
    Object.assign(globalThis, { fetch: refuse });
    await tick(1100);
    expect(chunkCalls).toBe(1);
    // After a refusal nothing more is queued or sent, even on unload.
    win.document.getElementById("host")!.appendChild(win.document.createElement("p"));
    await tick(5);
    unload();
    expect(beacons.length).toBe(0);
  });
});

describe("the core tracker loads the recorder only on opt-in", () => {
  async function loadTracker(attrs: Record<string, string>): Promise<void> {
    const code = await Bun.file(new URL("../dist/v.js", import.meta.url)).text();
    const doc = win.document as unknown as Document;
    const script = doc.createElement("script");
    script.setAttribute("data-site", "demo");
    script.setAttribute("src", "https://stats.example/v.js");
    for (const [k, v] of Object.entries(attrs)) script.setAttribute(k, v);
    doc.head.appendChild(script);
    Object.defineProperty(doc, "currentScript", { value: script, configurable: true });
    Object.assign(globalThis, { screen: win.screen, localStorage: win.localStorage });
    new Function(code).call(win);
  }
  const recorderTags = () =>
    Array.from(win.document.querySelectorAll("script")).filter((s) => (s.getAttribute("src") || "").endsWith("/r.js"));

  test("no data-replay: the recorder is never requested", async () => {
    await loadTracker({});
    expect(recorderTags().length).toBe(0);
  });

  test("data-replay: one recorder tag, from the same host, with the same site and patterns", async () => {
    await loadTracker({ "data-replay": "", "data-mask-patterns": '["/u/*"]' });
    const tags = recorderTags();
    expect(tags.length).toBe(1);
    expect(tags[0]!.getAttribute("src")).toBe("https://stats.example/r.js");
    expect(tags[0]!.getAttribute("data-site")).toBe("demo");
    expect(tags[0]!.getAttribute("data-mask-patterns")).toBe('["/u/*"]');
  });

  test("data-host is respected", async () => {
    await loadTracker({ "data-replay": "", "data-host": "https://collector.example" });
    expect(recorderTags()[0]!.getAttribute("src")).toBe("https://collector.example/r.js");
  });

  test("Do Not Track stops the tracker before the recorder is ever loaded", async () => {
    Object.defineProperty(win.navigator, "doNotTrack", { value: "1", configurable: true });
    await loadTracker({ "data-replay": "" });
    expect(recorderTags().length).toBe(0);
  });
});
