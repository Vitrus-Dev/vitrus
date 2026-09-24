// packages/tracker/test/player.test.ts
// Round trip: the recorder records a page, the server sanitises the chunk, the
// player rebuilds it. Lives next to the recorder because this package is the
// one with a DOM (happy-dom) available; the player engine itself is in core.

import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { sanitizeChunk } from "../../core/src/replay.ts";
import { REPLAY_PLAYER_JS } from "../../core/src/replay-player.ts";

interface Engine {
  vrBuild(doc: Document, snap: unknown, nodes: Map<number, Node>): void;
  vrMutate(doc: Document, ops: unknown[], nodes: Map<number, Node>): void;
  vrGaps(events: unknown[][], duration: number): [number, number][];
  vrActivity(events: unknown[][], markers: unknown[]): { t: number; k: string; label: string }[];
}

const windows: Window[] = [];
afterEach(async () => {
  for (const w of windows.splice(0)) await w.happyDOM.close();
});

function engine(): Engine {
  return new Function(`${REPLAY_PLAYER_JS}; return { vrBuild, vrMutate, vrGaps, vrActivity };`)() as Engine;
}

function blankDoc(): Document {
  const w = new Window({ url: "about:blank" });
  windows.push(w);
  return w.document as unknown as Document;
}

async function record(html: string, act?: (doc: Document, win: Window) => void): Promise<unknown[][]> {
  const win = new Window({ url: "https://example.com/p" });
  windows.push(win);
  win.document.documentElement.innerHTML = html;
  const beacons: string[] = [];
  const nav = win.navigator as unknown as { sendBeacon: (u: string, d: unknown) => boolean };
  nav.sendBeacon = (_u, d) => {
    beacons.push(String(d));
    return true;
  };
  const fetchMock = (async () => new Response(JSON.stringify({ record: true }))) as unknown as typeof fetch;
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    location: win.location,
    navigator: win.navigator,
    history: win.history,
    innerWidth: 1024,
    innerHeight: 700,
    addEventListener: win.addEventListener.bind(win),
    fetch: fetchMock,
    MutationObserver: win.MutationObserver,
  });
  const code = await Bun.file(new URL("../dist/r.js", import.meta.url)).text();
  const s = win.document.createElement("script");
  s.setAttribute("data-site", "demo");
  s.setAttribute("src", "https://stats.example/r.js");
  Object.defineProperty(win.document, "currentScript", { value: s, configurable: true });
  new Function(code).call(win);
  await new Promise((r) => setTimeout(r, 5));
  if (act) {
    act(win.document as unknown as Document, win);
    await new Promise((r) => setTimeout(r, 5));
  }
  win.dispatchEvent(new win.Event("pagehide"));
  return beacons.flatMap((b) => sanitizeChunk(b) ?? []);
}

describe("replay player — round trip", () => {
  test("the rebuilt page has the structure, the masks, the boxes — and nothing executable", async () => {
    const events = await record(
      `<head><style>p{color:red}</style><script>window.bad=1</script></head>
       <body><h1 data-vitrus-unmask>Hello</h1><p>secret words</p>
       <input type="password" value="pw"><button onclick="bad()">Go</button><div id="host"></div></body>`,
      (doc) => {
        const p = doc.createElement("p");
        p.textContent = "added later";
        doc.getElementById("host")!.appendChild(p);
      }
    );
    const e = engine();
    const doc = blankDoc();
    const nodes = new Map<number, Node>();
    const snap = events.find((x) => x[1] === 0)!;
    e.vrBuild(doc, snap[2], nodes);
    for (const m of events.filter((x) => x[1] === 1)) e.vrMutate(doc, m[2] as unknown[], nodes);

    const html = doc.documentElement.outerHTML;
    expect(html).toContain("Hello");
    expect(html).toContain("****** *****"); // "secret words"
    expect(html).toContain("***** *****"); // "added later", arrived as a mutation
    expect(html).toContain("p{color:red}");
    expect(doc.querySelectorAll("script").length).toBe(0);
    expect(html).not.toContain("onclick");
    expect(doc.querySelectorAll("[data-vr-box]").length).toBe(1); // the password field
    // The frame refuses scripts even if one slipped through.
    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
    expect(csp?.getAttribute("content")).toContain("script-src 'none'");
  });

  test("a forged snapshot cannot plant a script or a handler in the player", () => {
    const e = engine();
    const doc = blankDoc();
    const nodes = new Map<number, Node>();
    // Straight into the player, WITHOUT the server's sanitiser — the builder's own layer.
    e.vrBuild(
      doc,
      {
        i: 1,
        t: "html",
        c: [
          { i: 2, t: "body", a: { onload: "x()" }, c: [
            { i: 3, t: "script", c: [{ i: 4, x: "alert(1)" }] },
            { i: 5, t: "a", a: { href: "javascript:alert(1)", onclick: "x()" } },
          ] },
        ],
      },
      nodes
    );
    e.vrMutate(doc, [["a", 2, 0, { i: 6, t: "script" }], ["at", 5, "onmouseover", "x()"]], nodes);
    const html = doc.documentElement.outerHTML;
    expect(doc.querySelectorAll("script").length).toBe(0);
    expect(html).not.toContain("alert");
    expect(html).not.toMatch(/\son[a-z]+=/);
  });

  test("inactivity is found and the activity list reads like a story", () => {
    const e = engine();
    const events = [
      [0, 0, { i: 1, t: "html" }, 800, 600, "/"],
      [1000, 3, 1, 5, 5],
      [1200, 6, 7, "***"],
      [1500, 6, 7, "****"],
      [30_000, 7, "/signup"],
      [31_000, 8, "TypeError: x"],
    ];
    const gaps = e.vrGaps(events, 31_000);
    expect(gaps.length).toBe(1);
    expect(gaps[0]![0]).toBeGreaterThan(1500);
    expect(gaps[0]![1]).toBeLessThan(30_000);
    const acts = e.vrActivity(events, [{ t: 2000, kind: "event", label: "signup_click · /" }]);
    expect(acts.map((a) => a.k)).toEqual(["nav", "click", "input", "event", "nav", "error"]);
    expect(acts.find((a) => a.k === "input")!.label).toContain("masked");
  });
});
