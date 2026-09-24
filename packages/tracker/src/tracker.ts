// packages/tracker/src/tracker.ts
// The browser script. A one-line install:
//   <script defer data-site="SITE_ID" src="https://.../v.js"></script>
//
// Design rules:
//  - NO cookies. No identifier is ever stored in the browser: the visitor id is
//    derived server-side from a daily salt. The one exception is the local
//    "exclude my own visits" flag, which holds the literal string "1" and is
//    never sent anywhere — see IGNORE_KEY below.
//  - No personal data is collected: a form FIELD name is sent, its VALUE never is.
//  - Exit events go out via `sendBeacon` (fetch is cancelled as the page unloads).
//  - No error ever escapes into the page; the tracker can die and the site keeps working.

interface Payload {
  site: string;
  type: "pageview" | "event";
  name?: string;
  url: string;
  referrer?: string;
  title?: string;
  screen?: string;
  lang?: string;
  hostname?: string;
  tag?: string;
  identity?: string;
  props?: Record<string, string | number | boolean | null>;
}

declare global {
  interface Window {
    vitrus?: {
      (name: string, props?: Record<string, string | number | boolean | null>): void;
      /**
       * The precondition for retention — see core/metrics/retention.ts.
       * Optional traits are sent once as an "identify" event and stored as
       * sent: only pass what your privacy notice covers.
       */
      identify?: (id: string, traits?: Record<string, string | number | boolean | null>) => void;
    };
  }
}

(function () {
  const doc = document;
  const script = doc.currentScript as HTMLScriptElement | null;
  if (!script) return;

  const site = script.getAttribute("data-site") || "";
  if (!site) return;
  const endpoint =
    script.getAttribute("data-host") || new URL(script.src, location.href).origin;
  const collect = endpoint.replace(/\/$/, "") + "/api/collect";
  const autoTrack = script.getAttribute("data-auto") !== "false";
  // The tag: a release/variant marker ("v2", "experiment-b"). The browser-side
  // handle for deploy correlation — the same idea as Umami's `data-tag`.
  const tag = script.getAttribute("data-tag") || "";
  // Hash-routed single-page apps (`#/settings`) navigate without changing the
  // path. With `data-hash="true"` the route after "#/" is part of the page;
  // the server keeps a fragment only when it starts with "#/", so an ordinary
  // in-page anchor (#pricing) never becomes a separate page.
  const hashMode = script.getAttribute("data-hash") === "true";

  // Do Not Track is RESPECTED by default. It can be disabled with
  // `data-do-not-track="false"`, but the default stays on — if a privacy stance
  // is more than a marketing line, it has to show up in the default.
  const dnt = navigator.doNotTrack || (window as { doNotTrack?: string }).doNotTrack;
  if (script.getAttribute("data-do-not-track") !== "false" && (dnt === "1" || dnt === "yes")) return;

  // — Path patterns —
  //
  // `data-skip-patterns`: paths that are never measured at all.
  // `data-mask-patterns`: paths measured, but with the identifying segment
  //   replaced before it leaves the browser.
  //
  // Masking matters more than it looks. A path like `/invoice/8841/pdf` or
  // `/u/ayse@example.com` puts personal data in the analytics database, and no
  // amount of policy text removes it once written. `/invoice/*/pdf` keeps the
  // page grouping useful and drops the identifier at the source — the only place
  // where dropping it is actually a guarantee.
  //
  // Syntax: `*` matches one segment, `**` matches the rest of the path.
  const skipPatterns = jsonList(script.getAttribute("data-skip-patterns"));
  const maskPatterns = jsonList(script.getAttribute("data-mask-patterns"));

  // — Exclude your own visits —
  //
  // Opening your own site all day pollutes your own numbers. Visit any page with
  // `?vitrus_ignore=1` once and this browser stops being measured; `=0` turns it
  // back on. This is the one place a local flag is written, and it holds no
  // personal data: the value is the literal string "1". It is stored under a
  // clearly named key so anyone can find and delete it.
  const IGNORE_KEY = "vitrus.ignore";
  try {
    const q = new URLSearchParams(location.search).get("vitrus_ignore");
    if (q === "1") localStorage.setItem(IGNORE_KEY, "1");
    else if (q === "0") localStorage.removeItem(IGNORE_KEY);
    if (localStorage.getItem(IGNORE_KEY) === "1") return;
  } catch {
    // Private mode or storage disabled: there is simply no exclusion. Never a crash.
  }

  // — Session replay: opt-in, and a separate file —
  // `data-replay` loads the recorder (r.js) lazily; a site without it pays zero
  // bytes. The recorder gets this tag's attributes (same site, host and path
  // patterns) and asks the server whether replay is enabled before recording.
  // Placed after the Do Not Track and self-exclusion checks: both stop it too.
  if (script.hasAttribute("data-replay")) {
    const r = doc.createElement("script");
    for (const a of Array.from(script.attributes)) r.setAttribute(a.name, a.value);
    r.src = collect.slice(0, -12) + "/r.js";
    doc.head.appendChild(r);
  }

  let lastPath = "";
  let identity = "";
  let maxScroll = 0;
  let touchedField = "";
  let formSubmitted = false;
  /** True while the current page matches a skip pattern. Nothing leaves the browser. */
  let pageSkipped = false;

  function send(p: Payload, beacon?: boolean): void {
    // The skip check lives HERE rather than at each call site: a skipped page
    // must be silent for pageviews, custom events, the exit summary and Web
    // Vitals alike. One gate, no way to forget one of them.
    if (pageSkipped) return;
    try {
      const body = JSON.stringify(p);
      if (beacon && navigator.sendBeacon) {
        navigator.sendBeacon(collect, new Blob([body], { type: "application/json" }));
        return;
      }
      fetch(collect, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
        credentials: "omit",
        mode: "cors",
      }).catch(noop);
    } catch {
      noop();
    }
  }

  function noop(): void {
    /* the tracker never breaks the page */
  }

  /** A JSON string array attribute. Anything malformed becomes an empty list, never a crash. */
  function jsonList(raw: string | null): string[] {
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  /**
   * Match a path against a pattern. `*` = one segment, `**` = the rest.
   * Built by hand rather than with a regex from user input: a pattern like
   * `/(a+)+$` in an attribute would be a denial-of-service on the visitor's own
   * browser. Segment comparison cannot backtrack.
   */
  function matches(path: string, pattern: string): boolean {
    const p = path.split("/");
    const q = pattern.split("/");
    for (let i = 0; i < q.length; i++) {
      if (q[i] === "**") return true;
      if (i >= p.length) return false;
      if (q[i] !== "*" && q[i] !== p[i]) return false;
    }
    return p.length === q.length;
  }

  /** Replace the segments a mask pattern covers with `*`. */
  function maskPath(path: string): string {
    for (const pattern of maskPatterns) {
      if (!matches(path, pattern)) continue;
      const p = path.split("/");
      const q = pattern.split("/");
      const out: string[] = [];
      for (let i = 0; i < p.length; i++) {
        const seg = q[i];
        if (seg === "**") return `${out.join("/")}/**`;
        out.push(seg === "*" ? "*" : (p[i] as string));
      }
      return out.join("/");
    }
    return path;
  }

  function skipped(path: string): boolean {
    return skipPatterns.some((pattern) => matches(path, pattern));
  }

  function base(): Payload {
    const p: Payload = {
      site,
      type: "pageview",
      url: maskPath(location.pathname) + location.search + (hashMode && location.hash.indexOf("#/") === 0 ? location.hash : ""),
      // A same-origin referrer is NOT SENT: arriving from our own page is
      // navigation, not a "source". The server treats it as internal too;
      // cleaning it in both layers protects us when host matching slips behind a
      // proxy.
      referrer: sameOrigin(doc.referrer) ? "" : doc.referrer || "",
      title: doc.title || "",
      screen: screen.width + "x" + screen.height,
      lang: navigator.language || "",
      hostname: location.hostname,
    };
    if (tag) p.tag = tag;
    // The identity is only sent when the site owner called identify(). It is
    // never persisted: it is lost on reload and is expected to be set again —
    // storing it would weaken the consent-free claim.
    if (identity) p.identity = identity;
    return p;
  }

  function sameOrigin(url: string): boolean {
    if (!url) return false;
    try {
      return new URL(url).origin === location.origin;
    } catch {
      return false;
    }
  }

  function pageview(): void {
    const path = location.pathname + location.search + (hashMode ? location.hash : "");
    if (path === lastPath) return;
    // Order matters: flush the previous page's exit summary while `pageSkipped`
    // still describes THAT page, and only then switch to the new one.
    flushExit();
    lastPath = path;
    pageSkipped = skipped(location.pathname);
    maxScroll = 0;
    touchedField = "";
    formSubmitted = false;
    send(base());
  }

  function event(name: string, props?: Payload["props"], beacon?: boolean): void {
    const p = base();
    p.type = "event";
    p.name = name;
    if (props) p.props = props;
    send(p, beacon);
  }

  // — SPA navigation —
  function patch(kind: "pushState" | "replaceState"): void {
    const orig = history[kind];
    history[kind] = function (this: History, ...args: unknown[]) {
      const r = (orig as (...a: unknown[]) => unknown).apply(this, args);
      pageview();
      return r;
    } as typeof history.pushState;
  }
  patch("pushState");
  patch("replaceState");
  addEventListener("popstate", pageview);
  if (hashMode) addEventListener("hashchange", pageview);

  if (!autoTrack) {
    exposeApi();
    pageview();
    return;
  }

  // — Scroll depth: ONE event per page (on exit), no noise —
  addEventListener(
    "scroll",
    () => {
      const h = doc.documentElement;
      const total = h.scrollHeight - h.clientHeight;
      if (total <= 0) return;
      const pct = Math.round(((h.scrollTop || doc.body.scrollTop) / total) * 100);
      if (pct > maxScroll) maxScroll = Math.min(100, pct);
    },
    { passive: true }
  );

  // — Form field abandonment: the FIELD NAME goes out, the VALUE never does —
  addEventListener(
    "focusin",
    (e) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        const el = t as HTMLInputElement;
        if (el.type === "password" || el.type === "hidden") return;
        touchedField = el.name || el.id || el.getAttribute("placeholder") || tag.toLowerCase();
      }
    },
    true
  );
  addEventListener(
    "submit",
    (e) => {
      formSubmitted = true;
      // Autocapture: which form was submitted. FIELD VALUES ARE NOT SENT —
      // only the form's name/id and how many fields it has.
      const f = e.target as HTMLFormElement | null;
      if (!f || f.tagName !== "FORM") return;
      event("form_submit", {
        form: f.getAttribute("name") || f.id || f.getAttribute("action") || "form",
        fields: f.elements ? f.elements.length : 0,
        path: maskPath(location.pathname),
      });
    },
    true
  );

  // — CTA and outbound link clicks —
  addEventListener(
    "click",
    (e) => {
      // Rage detection runs FIRST and on EVERY click: rage is usually aimed at
      // something that does NOT respond (a div that looks clickable, a frozen
      // image). Putting this inside the link/button branch missed exactly the
      // case it exists to catch.
      rage(e as MouseEvent);

      const t = (e.target as HTMLElement | null)?.closest?.("[data-vitrus],a,button") as HTMLElement | null;
      if (!t) return;
      const custom = t.getAttribute("data-vitrus");
      if (custom) {
        // `data-vitrus-event-*` attributes become event properties — the way to
        // define an event from HTML without writing code (Umami's most-used
        // feature). <button data-vitrus="purchase" data-vitrus-event-plan="pro">
        const props: Record<string, string> = { label: (t.textContent || "").trim().slice(0, 60) };
        for (const name of t.getAttributeNames()) {
          const m = name.match(/^data-vitrus-event-([\w-]+)$/);
          if (m && m[1]) props[m[1]] = (t.getAttribute(name) || "").slice(0, 200);
        }
        event(custom, props);
        return;
      }
      if (t.hasAttribute("data-vitrus-cta")) {
        event("cta_click", { label: (t.textContent || "").trim().slice(0, 60), path: maskPath(location.pathname) });
        return;
      }
      const href = (t as HTMLAnchorElement).href;
      if (href && t.tagName === "A") {
        try {
          const u = new URL(href, location.href);
          if (u.origin !== location.origin) {
            event("outbound_click", { host: u.hostname, path: maskPath(location.pathname) });
          } else if (/\.(pdf|zip|dmg|exe|msi|pkg|csv|xlsx?|docx?|pptx?|mp3|mp4|mov|gz|rar|7z|apk|epub)$/i.test(u.pathname)) {
            // A same-site file download. The file's PATH is sent (masked like
            // any path), never its query string.
            event("file_download", { file: maskPath(u.pathname), path: maskPath(location.pathname) });
          }
        } catch {
          noop();
        }
      }
    },
    true
  );

  // — Rage click: 3+ clicks on the same spot within 800 ms —
  let clicks: { x: number; y: number; t: number }[] = [];
  function rage(e: MouseEvent): void {
    const now = Date.now();
    clicks = clicks.filter((c) => now - c.t < 800);
    clicks.push({ x: e.clientX, y: e.clientY, t: now });
    if (clicks.length >= 3) {
      const first = clicks[0];
      if (!first) return;
      const near = clicks.every((c) => Math.abs(c.x - first.x) < 30 && Math.abs(c.y - first.y) < 30);
      if (near) {
        clicks = [];
        const el = e.target as HTMLElement | null;
        event("rage_click", {
          path: maskPath(location.pathname),
          tag: el ? el.tagName.toLowerCase() : "",
        });
      }
    }
  }

  // ——— Web Vitals ———
  // Core Web Vitals from real visits. PerformanceObserver is already in the
  // browser; we add no library (the web-vitals package would be ~2 KB more, and
  // the whole tracker is currently around 2 KB).
  //
  // Each metric is sent ONCE per page, on exit: LCP and CLS keep changing
  // throughout a visit, so sending early means recording the wrong value.
  const vitals: Record<string, number> = {};

  function observe(type: string, cb: (e: PerformanceEntry & Record<string, number>) => void): void {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) cb(e as PerformanceEntry & Record<string, number>);
      }).observe({ type, buffered: true } as PerformanceObserverInit);
    } catch {
      noop(); // unsupported entry type: move on quietly, never affect the page
    }
  }

  if (typeof PerformanceObserver === "function") {
    observe("largest-contentful-paint", (e) => {
      vitals.lcp = Math.round(e.startTime);
    });
    observe("paint", (e) => {
      if (e.name === "first-contentful-paint") vitals.fcp = Math.round(e.startTime);
    });
    observe("layout-shift", (e) => {
      // A shift caused by user input does not count (per the spec).
      if (!e.hadRecentInput) vitals.cls = Math.round(((vitals.cls ?? 0) + (e.value ?? 0)) * 1000) / 1000;
    });
    observe("event", (e) => {
      // An approximation of INP: the longest interaction delay.
      const d = e.duration;
      if (d && d > (vitals.inp ?? 0)) vitals.inp = Math.round(d);
    });
    observe("navigation", (e) => {
      if (e.responseStart) vitals.ttfb = Math.round(e.responseStart);
    });
  }

  // ——— Error tracking ———
  // Message + file + line are sent; THE STACK IS NOT. Stack traces routinely
  // carry user data (URLs, form values captured in closures) and would weaken
  // our privacy claim. The same error is reported once per page.
  const seenErrors = new Set<string>();

  function reportError(message: string, source: string, line: number | string): void {
    const key = message + "|" + source + "|" + line;
    if (seenErrors.has(key) || seenErrors.size > 10) return;
    seenErrors.add(key);
    event("error", {
      message: String(message).slice(0, 200),
      source: String(source).slice(0, 200),
      line: Number(line) || 0,
      path: maskPath(location.pathname),
    });
  }

  addEventListener("error", (e) => {
    const ev = e as ErrorEvent;
    if (!ev.message) return; // a resource load error: no message, pure noise
    reportError(ev.message, ev.filename || "", ev.lineno || 0);
  });
  addEventListener("unhandledrejection", (e) => {
    const reason = (e as PromiseRejectionEvent).reason;
    const msg = reason instanceof Error ? reason.message : String(reason);
    reportError("Unhandled rejection: " + msg, "", 0);
  });

  // — The exit summary: scroll + form abandonment —
  function flushExit(): void {
    if (maxScroll > 0) event("scroll", { percent: maxScroll, path: maskPath(lastPath || location.pathname) }, true);
    // Vitals are one event per page: LCP and CLS keep changing during a visit,
    // so sending early would record the wrong value.
    if (Object.keys(vitals).length > 0) {
      event("web_vitals", { ...vitals, path: maskPath(lastPath || location.pathname) }, true);
      for (const k of Object.keys(vitals)) delete vitals[k];
    }
    if (touchedField && !formSubmitted) {
      event("form_abandon", { field: touchedField, path: maskPath(lastPath || location.pathname) }, true);
    }
    maxScroll = 0;
    touchedField = "";
  }

  addEventListener("visibilitychange", () => {
    if (doc.visibilityState === "hidden") flushExit();
  });
  addEventListener("pagehide", flushExit);

  exposeApi();
  pageview();

  function exposeApi(): void {
    const api = ((n: string, p?: Payload["props"]) => event(n, p)) as NonNullable<Window["vitrus"]>;
    api.identify = (id: string, traits?: Payload["props"]): void => {
      identity = String(id ?? "").slice(0, 200);
      if (identity && traits) event("identify", traits);
    };
    window.vitrus = api;
  }
})();
