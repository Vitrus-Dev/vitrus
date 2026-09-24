// packages/tracker/src/replay.ts
// The session-replay recorder. A SEPARATE file (built to dist/r.js), loaded by
// the core tracker only when the page opts in with `data-replay` — a visitor on
// a site without replay never downloads a byte of it.
//
// Written by hand rather than with rrweb: rrweb is ~40 KB gzipped and a runtime
// dependency (see CLAUDE.md, "zero runtime dependencies"). What we need is a
// DOM snapshot, a MutationObserver and a handful of listeners; the format below
// is ours and the player that reads it lives in core/replay-player.ts.
//
// ═══ PRIVACY DEFAULTS — the reason this file exists at all ═══
// Recording a screen means recording what a person typed and read. So the
// defaults are the opposite of most replay tools:
//
//   - EVERY text node is masked: each non-space character becomes "*". The
//     layout survives (same length, same line breaks), the words do not.
//     Only a subtree marked `data-vitrus-unmask` is recorded as written.
//   - EVERY input value is masked, always — `data-vitrus-unmask` does not
//     reach form values. Password fields, credit-card fields (autocomplete
//     "cc-*"), one-time codes, and anything inside `data-vitrus-block` are
//     never captured at all: the player draws a grey box of the same size.
//   - Text-bearing attributes (placeholder, title, alt, aria-label, value) are
//     masked the same way; `data-*` values that look like identifiers (an
//     "@", a run of five digits, anything long) are masked.
//   - <script> and <noscript> are never recorded, nor any `on*` handler or a
//     `javascript:` URL. iframes, canvas, video and audio are grey boxes;
//     images too with `data-replay-block-media="true"` or the site setting.
//   - Do Not Track is honoured unconditionally here (the core tracker's
//     `data-do-not-track="false"` opt-out does not apply to recordings), no
//     cookie or storage is written, and nothing identifying is generated in
//     the browser — the server groups chunks with the same daily-salted hash
//     the pageview uses.
//
// KNOWN BLIND SPOTS (also in the docs): shadow DOM contents, cross-origin
// iframes, <canvas> drawing, and CSS rules added through CSSOM `insertRule`
// AFTER the first snapshot (some CSS-in-JS libraries do this) are not
// recorded. The server enforces input masking again on arrival; it cannot
// re-mask page text, because only the page knows what `data-vitrus-unmask`
// covered.

type Ev = unknown[];
interface Snap {
  i: number;
  t?: string;
  a?: Record<string, string>;
  c?: Snap[];
  x?: string;
  b?: [number, number];
  s?: 1;
  v?: string | boolean;
}

(function () {
  const doc = document;
  const script = doc.currentScript as HTMLScriptElement | null;
  if (!script) return;
  const attr = (n: string) => script.getAttribute(n);
  const site = attr("data-site") || "";
  if (!site) return;
  const host = (attr("data-host") || new URL(script.src, location.href).origin).replace(/\/$/, "");

  // Do Not Track: ALWAYS honoured for recordings. The core tracker lets a site
  // turn its DNT check off for aggregate counts; a recording of one person's
  // visit is a different thing, and that override does not reach it.
  const dnt = navigator.doNotTrack || (window as { doNotTrack?: string }).doNotTrack;
  if (dnt === "1" || dnt === "yes") return;
  if (typeof MutationObserver !== "function") return;

  const skipPatterns = list(attr("data-skip-patterns"));
  const maskPatterns = list(attr("data-mask-patterns"));
  let blockMedia = attr("data-replay-block-media") === "true";

  const ids = new WeakMap<Node, number>();
  let nextId = 1;
  let q: Ev[] = [];
  let t0 = Date.now();
  let seq = 0;
  let stopped = false;
  let maxMs = 30 * 60 * 1000;
  const rid = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/-/g, "");
  let failures = 0;
  let pending: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observer: MutationObserver | null = null;
  /** Payloads above this are not sent: a gap marker is, so the player can say so. */
  const MAX_CHUNK = 900_000;

  const MASKED_ATTRS = /^(placeholder|title|alt|aria-label|aria-description|aria-valuetext|label|summary|content)$/;
  const URL_ATTRS = /^(href|src|srcset|poster|action|xlink:href|background)$/;
  const BOX_TAGS = /^(IFRAME|FRAME|CANVAS|VIDEO|AUDIO|OBJECT|EMBED)$/;
  const MEDIA_TAGS = /^(IMG|PICTURE|SVG|image)$/;

  function list(raw: string | null): string[] {
    try {
      const v = JSON.parse(raw || "[]");
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  function matches(path: string, pattern: string): boolean {
    const p = path.split("/");
    const r = pattern.split("/");
    for (let i = 0; i < r.length; i++) {
      if (r[i] === "**") return true;
      if (i >= p.length) return false;
      if (r[i] !== "*" && r[i] !== p[i]) return false;
    }
    return p.length === r.length;
  }

  /** The path as the pageview reports it: mask patterns applied (as tracker.ts does), no query, no fragment. */
  function pagePath(): string {
    const path = location.pathname;
    for (const pattern of maskPatterns) {
      if (!matches(path, pattern)) continue;
      const p = path.split("/");
      const r = pattern.split("/");
      const out: string[] = [];
      for (let i = 0; i < p.length; i++) {
        if (r[i] === "**") return `${out.join("/")}/**`;
        out.push(r[i] === "*" ? "*" : (p[i] as string));
      }
      return out.join("/");
    }
    return path;
  }

  const skipped = () => skipPatterns.some((p) => matches(location.pathname, p));

  /** Same length, same line breaks, no words. */
  function mask(s: string): string {
    return s.replace(/\S/g, "*");
  }

  function unmasked(n: Node): boolean {
    const el = (n.nodeType === 1 ? n : n.parentNode) as Element | null;
    return !!(el && el.closest && el.closest("[data-vitrus-unmask]"));
  }

  /** Never captured at all — the player draws a grey box of the same size. */
  function sensitive(el: Element): boolean {
    if (el.closest("[data-vitrus-block]")) return true;
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && el.tagName !== "SELECT") return false;
    const type = (el.getAttribute("type") || "").toLowerCase();
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    return type === "password" || /\bcc-|one-time-code/.test(ac);
  }

  function boxed(el: Element): boolean {
    return sensitive(el) || BOX_TAGS.test(el.tagName) || (blockMedia && MEDIA_TAGS.test(el.tagName));
  }

  function ignored(n: Node): boolean {
    if (n.nodeType === 8 || n.nodeType === 7) return true; // comments, processing instructions
    if (n.nodeType !== 1) return false;
    const tag = (n as Element).tagName;
    return tag === "SCRIPT" || tag === "NOSCRIPT" || tag === "TEMPLATE";
  }

  function url(v: string, keepQuery: boolean): string | null {
    const s = v.trim();
    if (/^(javascript|vbscript|data:text\/html)/i.test(s)) return null;
    if (/^(mailto|tel|sms):/i.test(s)) return null;
    try {
      const u = new URL(s, location.href);
      if (!keepQuery) {
        u.search = "";
        u.hash = "";
      }
      return u.href;
    } catch {
      return null;
    }
  }

  function attrValue(el: Element, name: string, value: string): string | null {
    if (/^on/i.test(name) || name === "srcdoc" || name === "value" || name === "nonce" || name === "integrity") return null;
    if (MASKED_ATTRS.test(name)) return unmasked(el) ? value : mask(value);
    if (URL_ATTRS.test(name)) {
      if (name === "srcset") return value.split(",").map((part) => {
        const [u, d] = part.trim().split(/\s+/);
        return (url(u || "", true) || "") + (d ? " " + d : "");
      }).join(", ");
      // Anchors lose query and fragment: they render nothing, and a link is
      // where a token or an email address in a URL usually sits.
      return url(value, el.tagName !== "A");
    }
    if (name.startsWith("data-") && !unmasked(el)) {
      return /^[\w\-:. ]{0,40}$/.test(value) && !/\d{5}/.test(value) ? value : mask(value);
    }
    return value;
  }

  function inputValue(el: Element): string | boolean | undefined {
    const i = el as HTMLInputElement;
    if (el.tagName === "INPUT" && (i.type === "checkbox" || i.type === "radio")) return i.checked;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return mask(String(i.value || ""));
    return undefined;
  }

  function idOf(n: Node): number {
    let id = ids.get(n);
    if (!id) {
      id = nextId++;
      ids.set(n, id);
    }
    return id;
  }

  function serialize(n: Node): Snap | null {
    if (ignored(n)) return null;
    if (n.nodeType === 3) {
      const parent = n.parentNode as Element | null;
      const raw = n.textContent || "";
      const tag = parent ? parent.tagName : "";
      // CSS is not a person's words. Everything else is masked unless a site
      // explicitly unmasked the subtree — and a textarea's text IS its value.
      const text = tag === "STYLE" ? raw : tag !== "TEXTAREA" && unmasked(n) ? raw : mask(raw);
      return { i: idOf(n), x: text };
    }
    if (n.nodeType !== 1) return null;
    const el = n as Element;
    const out: Snap = { i: idOf(el), t: el.tagName.toLowerCase() };
    if (el.namespaceURI === "http://www.w3.org/2000/svg") out.s = 1;
    if (boxed(el)) {
      const r = el.getBoundingClientRect();
      out.b = [Math.round(r.width), Math.round(r.height)];
      const cls = el.getAttribute("class");
      if (cls) out.a = { class: cls };
      return out;
    }
    const a: Record<string, string> = {};
    for (const at of Array.from(el.attributes)) {
      const v = attrValue(el, at.name, at.value);
      if (v !== null) a[at.name] = v;
    }
    out.a = a;
    const v = inputValue(el);
    if (v !== undefined) out.v = v;
    const c: Snap[] = [];
    for (let ch = el.firstChild; ch; ch = ch.nextSibling) {
      const s = serialize(ch);
      if (s) c.push(s);
    }
    // A stylesheet filled through CSSOM has rules but no text; take the rules.
    if (el.tagName === "STYLE" && !c.length) {
      try {
        const rules = Array.from((el as HTMLStyleElement).sheet?.cssRules || [])
          .map((r) => r.cssText)
          .join("\n");
        if (rules) c.push({ i: nextId++, x: rules });
      } catch {
        /* a cross-origin sheet cannot be read; nothing to add */
      }
    }
    if (c.length) out.c = c;
    return out;
  }

  function push(e: Ev): void {
    if (stopped) return;
    // Nothing from a skipped page — not a click, not a keystroke's length.
    if (e[1] !== 9 && e[1] !== 7 && e[1] !== 0 && skipped()) return;
    if (Date.now() - t0 > maxMs) return stop();
    q.push(e);
  }

  const now = () => Date.now() - t0;

  function full(): void {
    const snap = serialize(doc.documentElement);
    if (snap) push([now(), 0, snap, innerWidth, innerHeight, pagePath()]);
  }

  /** The target's nearest recorded element: blocked subtrees and scripts are not addressable. */
  function recordable(n: Node | null): boolean {
    for (let p: Node | null = n; p; p = p.parentNode) {
      if (ignored(p)) return false;
      if (p.nodeType === 1 && p !== n && boxed(p as Element)) return false;
    }
    return true;
  }

  function onMutations(records: MutationRecord[]): void {
    if (skipped()) return;
    const ops: unknown[] = [];
    for (const r of records) {
      const target = r.target;
      if (!recordable(target) || !ids.has(target)) continue;
      // A boxed element's inside was never recorded, so it cannot change.
      if (target.nodeType === 1 && boxed(target as Element)) continue;
      if (r.type === "childList") {
        r.removedNodes.forEach((n) => {
          const id = ids.get(n);
          if (id) ops.push(["r", id]);
        });
        r.addedNodes.forEach((n) => {
          // Serialised from the CURRENT tree. If a later record in this batch
          // moved or removed it, that record says so; a node that has since left
          // the document is not sent at all.
          if (!doc.documentElement.contains(n) || ignored(n)) return;
          const parent = n.parentNode;
          if (!parent || !ids.has(parent) || !recordable(n)) return;
          const had = ids.get(n);
          if (had) ops.push(["r", had]);
          let next = n.nextSibling;
          while (next && !ids.has(next)) next = next.nextSibling;
          const s = serialize(n);
          if (s) ops.push(["a", ids.get(parent), next ? ids.get(next) : 0, s]);
        });
      } else if (r.type === "characterData") {
        const s = serialize(target);
        if (s) ops.push(["t", s.i, s.x]);
      } else if (r.type === "attributes" && r.attributeName) {
        const el = target as Element;
        const raw = el.getAttribute(r.attributeName);
        ops.push(["at", ids.get(el), r.attributeName, raw === null ? null : attrValue(el, r.attributeName, raw)]);
      }
    }
    if (ops.length) push([now(), 1, ops]);
  }

  // — Throttled streams: pointer and scroll positions —
  let lastMove = 0;
  const scrolls = new Map<Node, number>();

  function listen(): void {
    const on = (type: string, fn: (e: Event) => void) => addEventListener(type, fn, { capture: true, passive: true });
    on("pointermove", (e) => {
      const t = now();
      if (t - lastMove < 50) return;
      lastMove = t;
      const m = e as PointerEvent;
      push([t, 2, Math.round(m.clientX), Math.round(m.clientY)]);
    });
    on("click", (e) => {
      const m = e as MouseEvent;
      push([now(), 3, ids.get(m.target as Node) || 0, Math.round(m.clientX), Math.round(m.clientY)]);
    });
    on("scroll", (e) => {
      const target = (e.target === doc ? doc : e.target) as Node;
      const t = now();
      if (t - (scrolls.get(target) || -1e9) < 100) return;
      scrolls.set(target, t);
      setTimeout(() => {
        if (target === doc) push([now(), 4, 0, Math.round(scrollX), Math.round(scrollY)]);
        else {
          const el = target as Element;
          const id = ids.get(el);
          if (id && recordable(el)) push([now(), 4, id, Math.round(el.scrollLeft), Math.round(el.scrollTop)]);
        }
      }, 100);
    });
    on("resize", () => push([now(), 5, innerWidth, innerHeight]));
    const input = (e: Event) => {
      const el = e.target as Element;
      if (!el || !ids.has(el) || !recordable(el) || boxed(el)) return;
      const v = inputValue(el);
      if (v !== undefined) push([now(), 6, ids.get(el), v]);
    };
    on("input", input);
    on("change", input);
    on("error", (e) => {
      const msg = (e as ErrorEvent).message;
      if (msg) push([now(), 8, String(msg).slice(0, 160)]);
    });
    on("popstate", nav);
    for (const kind of ["pushState", "replaceState"] as const) {
      const orig = history[kind];
      history[kind] = function (this: History, ...args: unknown[]) {
        const r = (orig as (...a: unknown[]) => unknown).apply(this, args);
        nav();
        return r;
      } as typeof history.pushState;
    }
    addEventListener("visibilitychange", () => {
      if (doc.visibilityState === "hidden") flush(true);
    });
    addEventListener("pagehide", () => flush(true));
  }

  let lastPath = "";
  let wasSkipped = false;
  function nav(): void {
    const p = pagePath();
    if (p === lastPath) return;
    lastPath = p;
    // A skipped page records nothing — and the page after it needs a fresh
    // snapshot, because the tree changed while we were not listening.
    if (skipped()) {
      wasSkipped = true;
      return push([now(), 9, "skipped_page"]);
    }
    push([now(), 7, p]);
    if (wasSkipped) {
      wasSkipped = false;
      full();
    }
  }

  function stop(): void {
    if (stopped) return;
    flush();
    stopped = true;
    if (observer) observer.disconnect();
    if (timer) clearTimeout(timer);
  }

  function flush(unloading?: boolean): void {
    if (q.length) {
      let body = JSON.stringify(q);
      q = [];
      if (body.length > MAX_CHUNK) body = JSON.stringify([[now(), 9, "chunk_too_large"]]);
      pending.push(body);
    }
    if (unloading) {
      // The page is going away: no time for compression or retries. The beacon
      // is fire-and-forget; whatever it cannot carry is lost, and the player
      // shows the recording ending there.
      for (const b of pending) {
        try {
          navigator.sendBeacon && navigator.sendBeacon(endpoint(false), b);
        } catch {
          /* never break the page */
        }
      }
      pending = [];
      return;
    }
    void drain();
  }

  function endpoint(gzip: boolean): string {
    return `${host}/api/replay/chunk?site=${encodeURIComponent(site)}&page=${rid}&seq=${seq++}${gzip ? "&enc=gzip" : ""}`;
  }

  let draining = false;
  async function drain(): Promise<void> {
    if (draining || !pending.length) return;
    draining = true;
    try {
      while (pending.length) {
        const body = pending[0] as string;
        let payload: BodyInit = body;
        let gzip = false;
        if (typeof CompressionStream === "function") {
          try {
            payload = await new Response(
              new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"))
            ).blob();
            gzip = true;
          } catch {
            payload = body;
          }
        }
        let res: Response;
        try {
          // text/plain keeps this a "simple" request: no CORS preflight per chunk.
          res = await fetch(endpoint(gzip), {
            method: "POST",
            body: payload,
            headers: { "content-type": "text/plain" },
            credentials: "omit",
            mode: "cors",
            keepalive: false,
          });
        } catch {
          res = new Response(null, { status: 599 });
        }
        if (res.status === 204 || res.status === 200) {
          pending.shift();
          failures = 0;
          continue;
        }
        if (res.status < 500 && res.status !== 408) {
          // The server said no on purpose (disabled, not sampled, too long,
          // over the plan) — and counted it. Retrying would only repeat that.
          pending = [];
          stopped = true;
          if (observer) observer.disconnect();
          break;
        }
        // Network trouble: back off exponentially, keep the chunk, and give
        // up after a bounded backlog rather than growing without limit.
        failures++;
        if (pending.length > 20) {
          pending = [JSON.stringify([[now(), 9, "network_backlog_dropped"]])];
        }
        setTimeout(() => void drain(), Math.min(60_000, 1000 * 2 ** failures));
        break;
      }
    } finally {
      draining = false;
    }
  }

  function tick(): void {
    flush();
    if (!stopped) timer = setTimeout(tick, 5000);
  }

  function start(): void {
    t0 = Date.now();
    lastPath = pagePath();
    if (skipped()) {
      wasSkipped = true;
      push([0, 9, "skipped_page"]);
    } else full();
    observer = new MutationObserver(onMutations);
    observer.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    listen();
    // The first chunk leaves quickly so a short visit still has a snapshot.
    timer = setTimeout(tick, 1000);
  }

  // The server decides: enabled for this site, sampled in for this visitor
  // (deterministically, from the daily hash — no storage needed), and for how
  // long. A failed or negative answer means no recording. Fail closed.
  fetch(`${host}/api/replay/config?site=${encodeURIComponent(site)}`, { credentials: "omit", mode: "cors" })
    .then((r) => (r.ok ? r.json() : null))
    .then((c: { record?: boolean; maxMs?: number; blockMedia?: boolean } | null) => {
      if (!c || c.record !== true) return;
      if (c.maxMs) maxMs = c.maxMs;
      if (c.blockMedia) blockMedia = true;
      start();
    })
    .catch(() => {
      /* no config, no recording */
    });
})();
