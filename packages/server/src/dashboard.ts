// packages/server/src/dashboard.ts
// A single-file dashboard — no build step, no dependencies.
// Its one distinguishing job: EVERY NUMBER HAS a "show the evidence" control.
// Evidence = the SQL that ran + its parameters + the raw rows. Not an
// explanation of the query — the query itself.
//
// This page renders EVERY metric in the bundle, not a chosen subset. That is a
// deliberate constraint rather than a feature: the open-core claim is that no
// metric is held back from this repository, and a self-hosted dashboard showing
// six cards while the documentation lists Web Vitals and error grouping makes
// that claim look false to the one person who checked. The engine had all of
// it; only the screen was missing.
//
// The section list below is therefore derived from the bundle at runtime — a
// metric added to `metrics/queries.ts` appears here without anyone remembering
// to come back.

import { REPLAY_PLAYER_JS, type Site } from "@vitrus/core";

export function dashboardHtml(sites: Site[]): string {
  const options = sites.length
    ? sites.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} (${esc(s.domain)})</option>`).join("")
    : `<option value="">— no sites —</option>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vitrus — provable analytics</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #0b0d10; --panel: #14181d; --line: #232a32; --fg: #e8edf2; --dim: #8b97a5;
    --accent: #5bc8af; --warn: #e0a458;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f7f8fa; --panel:#fff; --line:#e2e6ea; --fg:#1b2026; --dim:#5d6b7a; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); }
  header { padding: 20px 24px; border-bottom: 1px solid var(--line); display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  h1 { font-size: 16px; margin: 0; letter-spacing: .02em; }
  h1 span { color: var(--accent); }
  select { background: var(--panel); color: var(--fg); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; font: inherit; }
  main { padding: 24px; max-width: 1080px; margin: 0 auto; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
  .card .label { color: var(--dim); font-size: 12px; margin-bottom: 6px; }
  .card .value { font-size: 26px; font-variant-numeric: tabular-nums; }
  .card .delta { font-size: 12px; margin-top: 4px; }
  .up { color: var(--accent); } .down { color: var(--warn); }
  .digest { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 18px; }
  .digest h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--dim); margin: 0 0 12px; }
  .line { display: flex; gap: 10px; padding: 9px 0; border-bottom: 1px dashed var(--line); line-height: 1.55; }
  .line:last-child { border-bottom: 0; }
  .kind { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); min-width: 62px; padding-top: 4px; }
  .chips { display: inline-flex; gap: 4px; margin-left: 6px; }
  .chip { font-size: 11px; border: 1px solid var(--line); border-radius: 999px; padding: 1px 7px; color: var(--dim); cursor: pointer; background: none; font-family: ui-monospace, monospace; }
  .chip:hover { border-color: var(--accent); color: var(--accent); }
  dialog { background: var(--panel); color: var(--fg); border: 1px solid var(--line); border-radius: 12px; max-width: 760px; width: 92vw; padding: 0; }
  dialog::backdrop { background: rgba(0,0,0,.55); }
  .dl-head { padding: 14px 18px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; }
  .dl-body { padding: 18px; }
  pre { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow: auto; font-size: 12px; line-height: 1.5; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); }
  th { color: var(--dim); font-weight: 500; }
  .empty { color: var(--dim); padding: 40px 0; text-align: center; }
  h2.sec { font-size: 12px; text-transform: uppercase; letter-spacing: .09em; color: var(--dim); margin: 34px 0 12px; font-weight: 600; }
  .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
  .tbl { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; min-width: 0; overflow-x: auto; }
  .tbl h3 { font-size: 12.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); margin: 0 0 10px; font-weight: 500; }
  .tbl td, .tbl th { white-space: nowrap; }
  footer { color: var(--dim); font-size: 12px; padding: 24px; text-align: center; }
  code { font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<header>
  <h1>vitrus<span>.</span> <small style="color:var(--dim);font-weight:400">provable analytics</small></h1>
  <select id="site">${options}</select>
  <select id="days">
    <option value="7">last 7 days</option>
    <option value="30">last 30 days</option>
    <option value="1">last 24 hours</option>
  </select>
</header>
<main>
  <div class="cards" id="cards"></div>
  <div class="digest">
    <h2>What happened → why → what to do</h2>
    <div id="lines"><div class="empty">loading…</div></div>
  </div>
  <div id="tables"></div>
  <h2 class="sec">Session replay</h2>
  <div class="tbl" id="replay"><div class="empty">loading…</div></div>
  <div id="replay-player" style="margin-top:14px"></div>
</main>
<footer>Click the <code>e#</code> badge next to any number to see the query that ran and the raw rows. Nothing is invented.</footer>

<dialog id="ev">
  <div class="dl-head"><strong id="ev-title"></strong><button class="chip" onclick="document.getElementById('ev').close()">close</button></div>
  <div class="dl-body" id="ev-body"></div>
</dialog>

<script>
const CARDS = ["visitors.unique","sessions.total","pageviews.total","visit.duration",
               "ai.sessions","ai.crawler.hits","agent.sessions","bots.suspected",
               "bounce.rate","errors.total"];

/* Row metrics, grouped the way somebody reads them rather than the order the
   query file happens to declare them. Anything in the bundle that is not listed
   here still renders, under "More" — so a new metric is never invisible. */
const SECTIONS = [
  ["Traffic",     ["pages.top","entry.pages","exit.pages","channels.sessions","referrers.top","utm.campaigns"]],
  ["AI",          ["ai.sources","ai.landing_pages","ai.crawler.pages"]],
  ["Agents",      ["agent.operators","agent.pages","agent.events",
                   "agents.by_signer","agents.unverified_bots"]],
  ["Traffic quality", ["bots.signal_rules"]],
  ["Behaviour",   ["events.top","form.abandon_fields"]],
  ["Performance", ["vitals.p75","vitals.slow_pages"]],
  ["Errors",      ["errors.top","errors.browsers"]],
  ["Audience",    ["countries.sessions","devices.sessions","browsers.sessions","os.sessions",
                   "languages.sessions","screens.sessions"]]
];

let bundle = null;

function fmt(n, unit) {
  if (n === null || n === undefined) return "—";
  const d = unit === "percent" ? 1 : 0;
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n) + (unit === "percent" ? "%" : "");
}

async function load() {
  const site = document.getElementById("site").value;
  const days = document.getElementById("days").value;
  if (!site) { document.getElementById("lines").innerHTML = '<div class="empty">Add a site first: <code>vitrus site add</code></div>'; return; }
  const [b, d] = await Promise.all([
    fetch("/api/stats?site=" + encodeURIComponent(site) + "&days=" + days).then(r => r.json()),
    fetch("/api/digest?site=" + encodeURIComponent(site) + "&days=" + days).then(r => r.json())
  ]);
  bundle = b;
  renderCards(b);
  renderLines(d.digest);
  renderTables(b);
}

function renderTables(b) {
  const byMetric = {};
  b.evidence.forEach(e => { byMetric[e.metric] = e; });

  const listed = {};
  SECTIONS.forEach(s => s[1].forEach(m => { listed[m] = true; }));
  // Anything the bundle produced that no section claims. Without this a metric
  // added to the engine would simply not exist on the screen, which is the
  // failure this page was just fixed for.
  const extra = b.evidence
    .filter(e => e.rows && e.rows.length && !listed[e.metric])
    .map(e => e.metric);

  const groups = SECTIONS.concat(extra.length ? [["More", extra]] : []);
  const out = groups.map(([title, metrics]) => {
    const tables = metrics.map(m => table(byMetric[m])).filter(Boolean).join("");
    return tables ? '<h2 class="sec">' + title + "</h2><div class=\\"grid\\">" + tables + "</div>" : "";
  }).join("");

  document.getElementById("tables").innerHTML = out ||
    '<div class="empty">No breakdowns yet — they appear as soon as there is traffic.</div>';
}

function table(e) {
  if (!e || !e.rows || !e.rows.length) return "";
  const cols = Object.keys(e.rows[0]);
  return '<div class="tbl"><h3>' + escapeHtml(e.label) +
    ' <button class="chip" onclick="showEvidence(\\'' + e.id + '\\')">' + e.id + "</button></h3>" +
    "<table><tr>" + cols.map(c => "<th>" + escapeHtml(c) + "</th>").join("") + "</tr>" +
    e.rows.slice(0, 10).map(r =>
      "<tr>" + cols.map(c => "<td>" + escapeHtml(String(r[c] === null ? "—" : r[c])) + "</td>").join("") + "</tr>"
    ).join("") + "</table></div>";
}

function renderCards(b) {
  const byMetric = Object.fromEntries(b.evidence.map(e => [e.metric, e]));
  /* The same safety net the tables have, which the cards did not: a scalar the
     engine computes but CARDS does not name was invisible here, while a rows
     metric in the same position fell through to "More". Two catch-alls, or the
     open-core claim only holds for half the bundle. */
  const extra = b.evidence
    .filter(e => (!e.rows || !e.rows.length) && CARDS.indexOf(e.metric) === -1 &&
                 e.metric !== "timeseries" && e.value !== null && e.value !== undefined)
    .map(e => e.metric);
  document.getElementById("cards").innerHTML = CARDS.concat(extra).map(m => {
    const e = byMetric[m]; if (!e) return "";
    const delta = (e.deltaPct === null || e.deltaPct === undefined) ? "" :
      '<div class="delta ' + (e.deltaPct >= 0 ? "up" : "down") + '">' + (e.deltaPct >= 0 ? "▲" : "▼") + " " + fmt(Math.abs(e.deltaPct), "percent") + "</div>";
    return '<div class="card"><div class="label">' + e.label + '</div><div class="value">' + fmt(e.value, e.unit) + "</div>" + delta +
      '<button class="chip" style="margin-top:8px" onclick="showEvidence(\\'' + e.id + '\\')">' + e.id + " · evidence</button></div>";
  }).join("");
}

function renderLines(digest) {
  const el = document.getElementById("lines");
  if (!digest || !digest.lines.length) { el.innerHTML = '<div class="empty">No data yet.</div>'; return; }
  el.innerHTML = digest.lines.map(l =>
    '<div class="line"><span class="kind">' + l.kind + '</span><span>' + escapeHtml(l.text) +
    '<span class="chips">' + l.evidence.map(id => '<button class="chip" onclick="showEvidence(\\'' + id + '\\')">' + id + "</button>").join("") + "</span></span></div>"
  ).join("");
}

function showEvidence(id) {
  if (!bundle) return;
  const e = bundle.evidence.find(x => x.id === id);
  if (!e) return;
  document.getElementById("ev-title").textContent = e.id + " — " + e.label;
  let rows = "";
  if (e.rows && e.rows.length) {
    const cols = Object.keys(e.rows[0]);
    rows = "<h4>Raw rows</h4><table><tr>" + cols.map(c => "<th>" + c + "</th>").join("") + "</tr>" +
      e.rows.map(r => "<tr>" + cols.map(c => "<td>" + escapeHtml(String(r[c])) + "</td>").join("") + "</tr>").join("") + "</table>";
  } else {
    rows = "<h4>Result</h4><pre>" + fmt(e.value, e.unit) + (e.previous !== undefined && e.previous !== null ? "   (previous period: " + fmt(e.previous, e.unit) + ")" : "") + "</pre>";
  }
  document.getElementById("ev-body").innerHTML =
    "<h4>Query that ran</h4><pre>" + escapeHtml(e.sql) + "</pre>" +
    "<h4>Parameters</h4><pre>" + escapeHtml(JSON.stringify(e.params)) + "</pre>" + rows;
  document.getElementById("ev").showModal();
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

/* ——— Session replay (opt-in; off until switched on here) ———
   The player engine is core's (replay-player.ts), shared with the hosted
   dashboard. Recordings render in a sandboxed frame where no script runs. */
${REPLAY_PLAYER_JS}
let replayPlayer = null;

async function loadReplays() {
  const box = document.getElementById("replay");
  const site = document.getElementById("site").value;
  if (!site) { box.innerHTML = ""; return; }
  const days = document.getElementById("days").value;
  const r = await fetch("/api/replays?site=" + encodeURIComponent(site) + "&days=" + days).then(x => x.json());
  const s = r.settings;
  const form =
    '<p style="margin:0 0 10px;color:var(--dim);font-size:13px">Off by default. When on, text and inputs are masked, password and card fields are never captured, ' +
    'and the page needs <code>data-replay</code> on the tracker tag. Visitors with Do Not Track are never recorded.</p>' +
    '<label><input type="checkbox" id="rp-on"' + (s.enabled ? " checked" : "") + "> Record sessions</label> · " +
    'sample <input id="rp-rate" type="number" min="0.01" max="1" step="0.01" value="' + s.sampleRate + '" style="width:70px"> · ' +
    'max <input id="rp-max" type="number" min="1" max="120" value="' + s.maxMinutes + '" style="width:60px"> min · ' +
    'keep <input id="rp-ret" type="number" min="1" max="90" value="' + s.retentionDays + '" style="width:60px"> days · ' +
    '<label><input type="checkbox" id="rp-media"' + (s.blockMedia ? " checked" : "") + "> Hide images</label> " +
    '<button class="chip" onclick="saveReplaySettings()">save</button> <span id="rp-msg" style="color:var(--dim);font-size:12px"></span>';
  const rows = r.replays.map(x =>
    "<tr><td>" + escapeHtml(x.name) + "</td><td>" + new Date(x.started_at).toLocaleString() + "</td><td>" +
    Math.round(x.duration_ms / 1000) + "s</td><td>" + x.pages + "</td><td>" + x.clicks + "</td><td>" + x.errors + "</td><td>" +
    escapeHtml(x.device + " · " + x.browser) + "</td><td>" + escapeHtml(x.country || "—") + "</td>" +
    '<td><button class="chip" onclick="watchReplay(&quot;' + x.id + '&quot;)">watch</button> ' +
    '<button class="chip" onclick="deleteReplay(&quot;' + x.id + '&quot;)">delete</button></td></tr>').join("");
  box.innerHTML = form + '<h3 style="margin-top:16px">' + r.total + " recordings · kept " + r.retentionDays + " days</h3>" +
    (rows ? "<table><tr><th>Visitor</th><th>Started</th><th>Length</th><th>Pages</th><th>Clicks</th><th>Errors</th><th>Device</th><th>Country</th><th></th></tr>" + rows + "</table>"
          : '<div class="empty">No recordings in this window.</div>') +
    "<details><summary style=\\"color:var(--dim);font-size:12px;cursor:pointer\\">Query that counted them</summary><pre>" + escapeHtml(r.sql) + "</pre><pre>" + escapeHtml(JSON.stringify(r.params)) + "</pre></details>";
}

async function saveReplaySettings() {
  const site = document.getElementById("site").value;
  const body = {
    enabled: document.getElementById("rp-on").checked,
    sampleRate: Number(document.getElementById("rp-rate").value),
    maxMinutes: Number(document.getElementById("rp-max").value),
    retentionDays: Number(document.getElementById("rp-ret").value),
    blockMedia: document.getElementById("rp-media").checked
  };
  const r = await fetch("/api/replay/settings?site=" + encodeURIComponent(site), { method: "PUT", body: JSON.stringify(body) }).then(x => x.json());
  document.getElementById("rp-msg").textContent = r.ok ? "saved" : "not saved: " + r.reason;
}

async function watchReplay(id) {
  const site = document.getElementById("site").value;
  const r = await fetch("/api/replays/" + id + "?site=" + encodeURIComponent(site)).then(x => x.json());
  if (replayPlayer) replayPlayer.destroy();
  replayPlayer = vrPlayer(document.getElementById("replay-player"), r);
  document.getElementById("replay-player").scrollIntoView({ behavior: "smooth" });
}

async function deleteReplay(id) {
  const site = document.getElementById("site").value;
  await fetch("/api/replays/" + id + "?site=" + encodeURIComponent(site), { method: "DELETE" });
  if (replayPlayer) { replayPlayer.destroy(); replayPlayer = null; }
  loadReplays();
}

document.getElementById("site").addEventListener("change", load);
document.getElementById("days").addEventListener("change", load);
document.getElementById("site").addEventListener("change", loadReplays);
document.getElementById("days").addEventListener("change", loadReplays);
load();
loadReplays();
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
