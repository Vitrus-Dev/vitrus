// packages/core/src/replay-player.ts
// The session-replay PLAYER, as browser JavaScript in a string.
//
// It lives in core so that the self-hosted dashboard (the server package) and the
// hosted one at app.vitrus.dev play recordings with the same engine — a player
// in the commercial layer only would make the open-source recorder useless.
// It is a string because both dashboards are single inline-script documents
// with no build step; `gate:inline-js` parses the composed pages.
//
// ═══ SANDBOX ═══
// A recording is rebuilt as DOM inside an <iframe sandbox="allow-same-origin">
// — WITHOUT allow-scripts, so nothing in it can execute: not a <script>, not an
// `on*` handler, not a `javascript:` URL. `allow-same-origin` is what lets this
// page build the DOM from outside; since no script runs inside, the frame never
// gets to use that origin. The server already strips scripts and handlers on
// arrival (core/replay.ts) and the builder skips them again — three layers, so
// a forged chunk would have to beat all three. The frame also takes no pointer
// events (a recorded link cannot be followed), sends no referrer, and carries a
// CSP that forbids scripts, frames, forms and connections.
//
// What does still load: the page's stylesheets, fonts and images, from the
// recorded site's own URLs, so the replay looks like the page. The viewer's
// browser fetches them — the same trade every replay tool makes.
//
// Wire format: see tracker/src/replay.ts. Events are [t, type, ...] with t in
// ms from the start of the recording (the server normalises page loads onto
// one clock).

export const REPLAY_PLAYER_JS = String.raw`
/* ——— Vitrus replay player ——— */
var VR_SVG = "http://www.w3.org/2000/svg";
var VR_XLINK = "http://www.w3.org/1999/xlink";
var VR_ACTIVE = { 0: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1 };
var VR_SPEEDS = [1, 2, 4, 8];

function vrEsc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
  return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function vrClock(ms){ var s = Math.max(0, Math.floor(ms / 1000)); var m = Math.floor(s / 60); s = s % 60; return m + ":" + (s < 10 ? "0" : "") + s; }

/* Build one serialised node into a document. Returns the node, or null for
   anything that must not exist in a replay. Exposed for tests. */
function vrMake(doc, n, nodes){
  if (!n) return null;
  if (typeof n.x === "string") { var tx = doc.createTextNode(n.x); nodes.set(n.i, tx); return tx; }
  var tag = String(n.t || "").toLowerCase();
  if (!tag || tag === "script" || tag === "noscript") return null;
  if (n.b) {
    var box = doc.createElement("div");
    box.className = "vr-box" + (n.a && n.a["class"] ? " " + n.a["class"] : "");
    box.setAttribute("data-vr-box", "");
    box.style.cssText = "display:inline-block;width:" + (n.b[0] | 0) + "px;height:" + (n.b[1] | 0) + "px";
    nodes.set(n.i, box);
    return box;
  }
  var el;
  try { el = n.s === 1 ? doc.createElementNS(VR_SVG, tag) : doc.createElement(tag); } catch (e) { return null; }
  var a = n.a || {};
  for (var k in a) vrSetAttr(el, k, a[k]);
  if (n.v !== undefined) { try { if (typeof n.v === "boolean") el.checked = n.v; else el.value = n.v; } catch (e) {} }
  if (n.c) for (var i = 0; i < n.c.length; i++) { var ch = vrMake(doc, n.c[i], nodes); if (ch) el.appendChild(ch); }
  nodes.set(n.i, el);
  return el;
}

function vrSetAttr(el, k, v){
  if (/^on/i.test(k) || k === "srcdoc" || el.hasAttribute && el.hasAttribute("data-vr-box")) return;
  if (v !== null && /^\s*(javascript|vbscript|data:text\/html)/i.test(String(v))) return;
  try {
    if (v === null) el.removeAttribute(k);
    else if (k.indexOf("xlink:") === 0) el.setAttributeNS(VR_XLINK, k, v);
    else el.setAttribute(k, v);
  } catch (e) { /* an attribute name the DOM refuses is skipped, never fatal */ }
}

/* Replace a document's content with a snapshot. Exposed for tests. */
function vrBuild(doc, snap, nodes){
  nodes.clear();
  var root = vrMake(doc, snap, nodes);
  /* The doctype stays: it came from srcdoc and keeps the frame in standards mode. */
  for (var c = doc.firstChild; c; ) { var nx = c.nextSibling; if (c.nodeType !== 10) doc.removeChild(c); c = nx; }
  if (!root) return;
  if (String(root.nodeName).toLowerCase() !== "html") {
    var html = doc.createElement("html"); html.appendChild(doc.createElement("head"));
    var body = doc.createElement("body"); body.appendChild(root); html.appendChild(body); root = html;
  }
  doc.appendChild(root);
  var head = root.querySelector("head");
  if (!head) { head = doc.createElement("head"); root.insertBefore(head, root.firstChild); }
  var csp = doc.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute("content", "script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; connect-src 'none'; worker-src 'none'");
  head.insertBefore(csp, head.firstChild);
  var st = doc.createElement("style");
  st.textContent = ".vr-box{background:repeating-linear-gradient(45deg,#c7ccd4 0 6px,#bcc2cb 6px 12px)!important;border-radius:2px;vertical-align:middle}";
  head.appendChild(st);
}

/* Apply one mutation op list. Exposed for tests. */
function vrMutate(doc, ops, nodes){
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i], node;
    if (op[0] === "r") { node = nodes.get(op[1]); if (node && node.parentNode) node.parentNode.removeChild(node); }
    else if (op[0] === "a") {
      var parent = nodes.get(op[1]); if (!parent) continue;
      var old = nodes.get(op[3] && op[3].i); if (old && old.parentNode) old.parentNode.removeChild(old);
      node = vrMake(doc, op[3], nodes); if (!node) continue;
      var next = op[2] ? nodes.get(op[2]) : null;
      try { if (next && next.parentNode === parent) parent.insertBefore(node, next); else parent.appendChild(node); } catch (e) {}
    }
    else if (op[0] === "t") { node = nodes.get(op[1]); if (node) node.textContent = op[2]; }
    else if (op[0] === "at") { node = nodes.get(op[1]); if (node && node.nodeType === 1) vrSetAttr(node, op[2], op[3]); }
  }
}

/* Stretches with no user input longer than this are skipped when asked. */
function vrGaps(events, duration){
  var gaps = [], last = 0;
  for (var i = 0; i < events.length; i++) {
    var e = events[i]; if (!VR_ACTIVE[e[1]]) continue;
    if (e[0] - last > 5000) gaps.push([last + 1500, e[0] - 500]);
    last = e[0];
  }
  if (duration - last > 5000) gaps.push([last + 1500, duration]);
  return gaps;
}

/* The activity list: navigation, clicks, typing, errors, gaps, and the
   session's analytics events. Consecutive keystrokes collapse into one line. */
function vrActivity(events, markers){
  var out = [], lastInput = null;
  for (var i = 0; i < events.length; i++) {
    var e = events[i], t = e[0];
    if (e[1] === 0) out.push({ t: t, k: "nav", label: "Page loaded · " + (e[5] || "/") });
    else if (e[1] === 7) out.push({ t: t, k: "nav", label: "Navigated · " + e[2] });
    else if (e[1] === 3) out.push({ t: t, k: "click", label: "Click" });
    else if (e[1] === 6) {
      if (lastInput && lastInput.id === e[2] && t - lastInput.t < 3000) { lastInput.t2 = t; continue; }
      lastInput = { t: t, k: "input", id: e[2], label: typeof e[3] === "boolean" ? (e[3] ? "Checked a box" : "Unchecked a box") : "Typed in a field (masked)" };
      out.push(lastInput);
    }
    else if (e[1] === 8) out.push({ t: t, k: "error", label: "Error · " + e[2] });
    else if (e[1] === 9) out.push({ t: t, k: "gap", label: "Recording gap · " + String(e[2]).replace(/_/g, " ") });
  }
  (markers || []).forEach(function(m){
    if (m.kind === "pageview") return; /* the recorder's own navigation lines cover these */
    out.push({ t: m.t, k: m.kind === "error" ? "error" : "event", label: (m.kind === "error" ? "Error event · " : "Event · ") + m.label });
  });
  out.sort(function(a, b){ return a.t - b.t; });
  return out;
}

var VR_CSS = ".vr{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:12px;outline:none}" +
  "@media (max-width:900px){.vr{grid-template-columns:1fr}}" +
  ".vr-main{min-width:0;border:1px solid var(--line,#2a2f36);border-radius:10px;overflow:hidden;background:var(--panel,#14181d)}" +
  ".vr-top{display:flex;gap:10px;justify-content:space-between;padding:8px 12px;font-size:12px;color:var(--dim,#8b97a5);border-bottom:1px solid var(--line,#2a2f36)}" +
  ".vr-url{font-family:ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  ".vr-stage{position:relative;height:min(62vh,640px);background:repeating-conic-gradient(rgba(127,127,127,.08) 0 25%,transparent 0 50%) 0 0/16px 16px;overflow:hidden}" +
  ".vr-stage iframe{position:absolute;top:0;left:0;border:0;background:#fff;transform-origin:0 0;pointer-events:none}" +
  ".vr-cursor{position:absolute;width:14px;height:14px;margin:-2px 0 0 -2px;pointer-events:none;z-index:2;display:none}" +
  ".vr-cursor:before{content:'';position:absolute;inset:0;border-radius:50%;background:#5bc8af;box-shadow:0 0 0 2px #fff,0 1px 4px rgba(0,0,0,.4)}" +
  ".vr-ripple{position:absolute;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;border:2px solid #e0a458;pointer-events:none;z-index:2;animation:vrr .5s ease-out forwards}" +
  "@keyframes vrr{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}" +
  ".vr-notice{position:absolute;left:50%;top:12px;transform:translateX(-50%);background:rgba(0,0,0,.72);color:#fff;font-size:12px;padding:5px 10px;border-radius:6px;z-index:3;display:none}" +
  ".vr-bar{display:flex;align-items:center;gap:10px;padding:10px 12px;border-top:1px solid var(--line,#2a2f36);flex-wrap:wrap}" +
  ".vr-bar button,.vr-bar select{font:inherit;font-size:12.5px;border:1px solid var(--line,#2a2f36);background:transparent;color:inherit;border-radius:6px;padding:4px 10px;cursor:pointer}" +
  ".vr-track{position:relative;flex:1;min-width:160px;height:22px;cursor:pointer}" +
  ".vr-rail{position:absolute;left:0;right:0;top:9px;height:4px;border-radius:2px;background:var(--line,#2a2f36)}" +
  ".vr-fill{position:absolute;left:0;top:9px;height:4px;border-radius:2px;background:var(--accent,#5bc8af)}" +
  ".vr-gap{position:absolute;top:9px;height:4px;background:repeating-linear-gradient(90deg,rgba(127,127,127,.55) 0 3px,transparent 3px 6px)}" +
  ".vr-mark{position:absolute;top:3px;width:3px;height:16px;margin-left:-1px;border-radius:2px;background:#8b97a5}" +
  ".vr-mark.nav{background:#5b8def}.vr-mark.error{background:#e5534b}.vr-mark.event{background:#a371f7}.vr-mark.click{height:6px;top:14px;background:#e0a458}.vr-mark.gap{background:#6e7681}" +
  ".vr-time{font-variant-numeric:tabular-nums;font-size:12px;color:var(--dim,#8b97a5);min-width:86px;text-align:center}" +
  ".vr-skip{font-size:12px;color:var(--dim,#8b97a5);display:flex;gap:5px;align-items:center}" +
  ".vr-side{border:1px solid var(--line,#2a2f36);border-radius:10px;background:var(--panel,#14181d);padding:10px 0;max-height:calc(min(62vh,640px) + 90px);overflow:auto}" +
  ".vr-side h4{margin:0 12px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim,#8b97a5);font-weight:600}" +
  ".vr-acts{list-style:none;margin:0;padding:0}" +
  ".vr-acts li{display:flex;gap:8px;padding:5px 12px;font-size:12.5px;cursor:pointer;border-left:2px solid transparent}" +
  ".vr-acts li:hover{background:rgba(127,127,127,.08)}.vr-acts li.on{border-left-color:var(--accent,#5bc8af);background:rgba(91,200,175,.08)}" +
  ".vr-acts .t{font-variant-numeric:tabular-nums;color:var(--dim,#8b97a5);min-width:36px}" +
  ".vr-acts .nav{color:#5b8def}.vr-acts .error{color:#e5534b}.vr-acts .event{color:#a371f7}.vr-acts .gap{color:#8b97a5}" +
  ".vr-acts .l{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}";

/* Mount a player into host. data = { events, markers }. Returns a controller. */
function vrPlayer(host, data){
  if (!document.getElementById("vr-css")) {
    var css = document.createElement("style"); css.id = "vr-css"; css.textContent = VR_CSS; (document.head || document.documentElement).appendChild(css);
  }
  var events = data.events || [];
  var duration = events.length ? events[events.length - 1][0] : 0;
  var gaps = vrGaps(events, duration);
  var acts = vrActivity(events, data.markers);
  host.innerHTML =
    '<div class="vr" tabindex="0">' +
      '<div class="vr-main">' +
        '<div class="vr-top"><span class="vr-url">—</span><span class="vr-vp"></span></div>' +
        '<div class="vr-stage"><iframe sandbox="allow-same-origin" referrerpolicy="no-referrer" srcdoc="&lt;!doctype html&gt;&lt;html&gt;&lt;head&gt;&lt;/head&gt;&lt;body&gt;&lt;/body&gt;&lt;/html&gt;" title="Session replay (sandboxed, scripts disabled)"></iframe>' +
          '<div class="vr-cursor"></div><div class="vr-notice"></div></div>' +
        '<div class="vr-bar">' +
          '<button type="button" class="vr-play">Play</button>' +
          '<div class="vr-track"><div class="vr-rail"></div><div class="vr-fill"></div><div class="vr-marks"></div></div>' +
          '<span class="vr-time">0:00 / ' + vrClock(duration) + '</span>' +
          '<select class="vr-speed" title="Playback speed">' + VR_SPEEDS.map(function(s){ return '<option value="' + s + '">' + s + "x</option>"; }).join("") + "</select>" +
          '<label class="vr-skip"><input type="checkbox" class="vr-skipbox" checked> Skip inactivity</label>' +
        "</div>" +
      "</div>" +
      '<aside class="vr-side"><h4>Activity</h4><ol class="vr-acts">' +
        acts.map(function(a, i){ return '<li data-i="' + i + '" data-t="' + a.t + '"><span class="t">' + vrClock(a.t) + '</span><span class="l ' + a.k + '">' + vrEsc(a.label) + "</span></li>"; }).join("") +
        (acts.length ? "" : '<li><span class="l">No activity recorded.</span></li>') +
      "</ol></aside>" +
    "</div>";

  var q = function(s){ return host.querySelector(s); };
  var frame = q("iframe"), stage = q(".vr-stage"), cursor = q(".vr-cursor"), notice = q(".vr-notice");
  var nodes = new Map();
  var st = { t: 0, idx: 0, playing: false, speed: 1, skip: true, vw: 1280, vh: 720, built: false, raf: 0, last: 0 };

  /* Timeline: grey hatching for skipped stretches, a mark per moment worth finding. */
  var marks = "";
  var pct = function(t){ return duration ? Math.min(100, (t / duration) * 100) : 0; };
  gaps.forEach(function(g){ marks += '<div class="vr-gap" style="left:' + pct(g[0]) + "%;width:" + Math.max(0, pct(g[1]) - pct(g[0])) + '%"></div>'; });
  acts.forEach(function(a){
    if (a.k === "input") return;
    marks += '<div class="vr-mark ' + a.k + '" style="left:' + pct(a.t) + '%" title="' + vrEsc(vrClock(a.t) + " · " + a.label) + '"></div>';
  });
  q(".vr-marks").innerHTML = marks;

  function doc(){ return frame.contentDocument; }

  function fit(){
    var sw = stage.clientWidth || 800, sh = stage.clientHeight || 500;
    var s = Math.min(sw / st.vw, sh / st.vh, 1);
    var ox = Math.max(0, (sw - st.vw * s) / 2);
    frame.style.width = st.vw + "px"; frame.style.height = st.vh + "px";
    frame.style.transform = "translate(" + ox + "px,0) scale(" + s + ")";
    st.scale = s; st.ox = ox;
    q(".vr-vp").textContent = st.vw + " × " + st.vh + (s < 1 ? " · " + Math.round(s * 100) + "%" : "");
  }

  function pointer(x, y, click){
    cursor.style.display = "block";
    var px = st.ox + x * st.scale, py = y * st.scale;
    cursor.style.left = px + "px"; cursor.style.top = py + "px";
    if (click) { var r = document.createElement("div"); r.className = "vr-ripple"; r.style.left = px + "px"; r.style.top = py + "px"; stage.appendChild(r); setTimeout(function(){ r.remove(); }, 600); }
  }

  function flash(text){ notice.textContent = text; notice.style.display = "block"; clearTimeout(st.nt); st.nt = setTimeout(function(){ notice.style.display = "none"; }, 1800); }

  function apply(e, quiet){
    var d = doc(); if (!d || !st.ready) return;
    var type = e[1];
    if (type === 0) {
      vrBuild(d, e[2], nodes); st.built = true;
      if (e[3] && e[4]) { st.vw = e[3]; st.vh = e[4]; fit(); }
      q(".vr-url").textContent = e[5] || "/";
      return;
    }
    if (!st.built) return;
    if (type === 1) vrMutate(d, e[2], nodes);
    else if (type === 2) { if (!quiet) pointer(e[2], e[3], false); }
    else if (type === 3) { if (!quiet) pointer(e[3], e[4], true); }
    else if (type === 4) {
      if (e[2] === 0) { try { frame.contentWindow.scrollTo(e[3], e[4]); } catch (x) {} }
      else { var el = nodes.get(e[2]); if (el) { el.scrollLeft = e[3]; el.scrollTop = e[4]; } }
    }
    else if (type === 5) { st.vw = e[2] || st.vw; st.vh = e[3] || st.vh; fit(); }
    else if (type === 6) { var inp = nodes.get(e[2]); if (inp) { try { if (typeof e[3] === "boolean") inp.checked = e[3]; else inp.value = e[3]; } catch (x) {} } }
    else if (type === 7) { q(".vr-url").textContent = e[2]; }
    else if (type === 9 && !quiet) { flash("Recording gap: " + String(e[2]).replace(/_/g, " ")); }
  }

  /* Seeking rebuilds from the last full snapshot at or before the target,
     then replays silently up to it — the only way a DOM can be rewound. */
  function seek(target){
    target = Math.max(0, Math.min(duration, target));
    if (!st.ready) { st.t = target; paint(); return; }
    var from = -1;
    for (var i = 0; i < events.length && events[i][0] <= target; i++) if (events[i][1] === 0) from = i;
    if (from === -1) { for (i = 0; i < events.length; i++) if (events[i][1] === 0) { from = i; break; } }
    st.built = false;
    if (from === -1) { st.idx = events.length; st.t = target; paint(); return; }
    var lastMove = null;
    for (i = from; i < events.length && (i === from || events[i][0] <= target); i++) {
      if (events[i][1] === 2 || events[i][1] === 3) { lastMove = events[i]; if (events[i][1] === 2) continue; }
      apply(events[i], true);
    }
    st.idx = i;
    if (lastMove) pointer(lastMove[1] === 2 ? lastMove[2] : lastMove[3], lastMove[1] === 2 ? lastMove[3] : lastMove[4], false);
    st.t = target;
    paint();
  }

  function paint(){
    q(".vr-fill").style.width = pct(st.t) + "%";
    q(".vr-time").textContent = vrClock(st.t) + " / " + vrClock(duration);
    q(".vr-play").textContent = st.playing ? "Pause" : st.t >= duration && duration ? "Replay" : "Play";
    var items = host.querySelectorAll(".vr-acts li[data-t]"), on = null;
    for (var i = 0; i < items.length; i++) { items[i].classList.remove("on"); if (Number(items[i].getAttribute("data-t")) <= st.t) on = items[i]; }
    if (on) on.classList.add("on");
  }

  function frameLoop(now){
    if (!st.playing) return;
    var dt = st.last ? now - st.last : 0; st.last = now;
    st.t += dt * st.speed;
    if (st.skip) for (var g = 0; g < gaps.length; g++) {
      if (st.t >= gaps[g][0] && st.t < gaps[g][1]) { st.t = gaps[g][1]; flash("Skipped " + vrClock(gaps[g][1] - gaps[g][0]) + " of inactivity"); }
    }
    while (st.idx < events.length && events[st.idx][0] <= st.t) apply(events[st.idx++], false);
    if (st.t >= duration) { st.t = duration; st.playing = false; }
    paint();
    if (st.playing) st.raf = requestAnimationFrame(frameLoop);
  }

  function play(){ if (!events.length) return; if (st.t >= duration) seek(0); st.playing = true; st.last = 0; st.raf = requestAnimationFrame(frameLoop); paint(); }
  function pause(){ st.playing = false; cancelAnimationFrame(st.raf); paint(); }
  function toggle(){ if (st.playing) pause(); else play(); }

  q(".vr-play").onclick = toggle;
  q(".vr-speed").onchange = function(){ st.speed = Number(this.value) || 1; };
  q(".vr-skipbox").onchange = function(){ st.skip = !!this.checked; };
  q(".vr-track").onclick = function(ev){ var r = this.getBoundingClientRect(); seek(((ev.clientX - r.left) / r.width) * duration); };
  q(".vr-acts").onclick = function(ev){ var li = ev.target.closest("li[data-t]"); if (li) seek(Number(li.getAttribute("data-t"))); };
  q(".vr").onkeydown = function(ev){
    if (ev.key === " ") { ev.preventDefault(); toggle(); }
    else if (ev.key === "ArrowRight") seek(st.t + 5000);
    else if (ev.key === "ArrowLeft") seek(st.t - 5000);
  };
  var ro = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
  if (ro) ro.observe(stage);

  fit();
  paint();
  /* The srcdoc document replaces the initial about:blank one when it loads;
     building before that would build into a document about to be discarded. */
  frame.onload = function(){ if (!st.ready) { st.ready = true; seek(st.t); } };
  if (frame.contentDocument && frame.contentDocument.readyState === "complete" && frame.contentDocument.body && frame.contentDocument.URL === "about:srcdoc") { st.ready = true; seek(0); }
  return {
    play: play, pause: pause, toggle: toggle, seek: seek, duration: duration,
    setSpeed: function(s){ st.speed = s; q(".vr-speed").value = String(s); },
    destroy: function(){ pause(); if (ro) ro.disconnect(); host.innerHTML = ""; }
  };
}
`;
