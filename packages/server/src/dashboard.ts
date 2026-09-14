// packages/server/src/dashboard.ts
// A single-file dashboard — no build step, no dependencies.
// Its one distinguishing job: EVERY NUMBER HAS a "show the evidence" control.
// Evidence = the SQL that ran + its parameters + the raw rows. Not an
// explanation of the query — the query itself.

import type { Site } from "@vitrus/core";

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
</main>
<footer>Click the <code>e#</code> badge next to any number to see the query that ran and the raw rows. Nothing is invented.</footer>

<dialog id="ev">
  <div class="dl-head"><strong id="ev-title"></strong><button class="chip" onclick="document.getElementById('ev').close()">close</button></div>
  <div class="dl-body" id="ev-body"></div>
</dialog>

<script>
const CARDS = ["visitors.unique","sessions.total","pageviews.total","ai.sessions","ai.crawler.hits","bounce.rate"];
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
}

function renderCards(b) {
  const byMetric = Object.fromEntries(b.evidence.map(e => [e.metric, e]));
  document.getElementById("cards").innerHTML = CARDS.map(m => {
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

document.getElementById("site").addEventListener("change", load);
document.getElementById("days").addEventListener("change", load);
load();
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
