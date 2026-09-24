<div align="center">
  <img src=".github/assets/logo.svg" alt="Vitrus" width="84" height="84">
  <h1>Vitrus</h1>
  <p><b>Analytics that shows its work.</b></p>
  <p>Open-source, cookie-free web analytics. Every number carries the SQL that produced it —<br>
  and an AI summary can't ship a number it can't prove.</p>
  <p>
    <a href="https://vitrus.dev">Website</a> ·
    <a href="https://vitrus.dev/docs">Docs</a> ·
    <a href="https://vitrus.dev/features">Features</a> ·
    <a href="https://vitrus.dev/compare">Compare</a> ·
    <a href="https://vitrus.dev/changelog">Changelog</a> ·
    <a href="https://app.vitrus.dev">Cloud</a> ·
    <a href="https://github.com/Vitrus-Dev/vitrus/discussions">Discussions</a>
  </p>
  <p>
    <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
    <img alt="Runtime dependencies: 0" src="https://img.shields.io/badge/runtime%20deps-0-brightgreen">
    <img alt="Tracker: 2.6 KB gzipped" src="https://img.shields.io/badge/tracker-2.6%20KB%20gzip-brightgreen">
    <img alt="Services to install: 0" src="https://img.shields.io/badge/services%20to%20install-0-brightgreen">
    <a href="https://github.com/Vitrus-Dev/vitrus/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Vitrus-Dev/vitrus/actions/workflows/ci.yml/badge.svg"></a>
    <a href="https://github.com/Vitrus-Dev/vitrus/releases"><img alt="Release" src="https://img.shields.io/github/v/release/Vitrus-Dev/vitrus"></a>
  </p>
</div>

<p align="center">
  <img src=".github/assets/dashboard-preview.svg" alt="Illustration of the hosted Vitrus dashboard: a KPI strip, a trend chart, and the SQL evidence panel open beside a channel breakdown" width="880">
</p>

---

**What it is, in one paragraph.** Vitrus tells you how many people visit your website, where they come
from, what they do and where they leave. It sets no cookies, so you do not need a consent banner. You
can use the hosted version at [vitrus.dev](https://vitrus.dev) or run it yourself as a single program
— there is no database server to install.

Every analytics tool shows you numbers. Vitrus shows you **where each one came from**. Click any
figure and you get the query that ran, the parameters it ran with, and the raw rows — not a
description of the number, the number's origin.

That matters more now that models write the reports. When an AI-written sentence contains a number
that is not in the evidence, Vitrus **drops the sentence** before it reaches you:

```
Visitors are down 18% against the previous period. [e1]
The drop coincides with the last deploy. [e1, e7]
✗ dropped: "The new theme caused a 41.7% fall in conversion."
   → 41.7 is in no evidence record, and "caused" is a claim nobody can make from this data.
```

## Get started

| | |
|---|---|
| **[Self-host](#self-host-in-a-minute)** | One process, an embedded database, nothing else to run. Free forever. |
| **[Cloud](https://app.vitrus.dev)** | The same engine, hosted — teams, quotas and digest delivery handled for you. |

Documentation: **[vitrus.dev/docs](https://vitrus.dev/docs)**.

## Features

- **The query behind every number.** Every metric travels as `{ id, sql, params, window, value }`,
  and the dashboard opens that exact SQL when you click the badge beside a figure.
- **AI summaries that cannot invent.** Numbers come from deterministic SQL first. The optional model
  (local Ollama, or your own key — neither is on by default) may rephrase them and may not produce
  one; a numeric guard drops any sentence it cannot support, and a golden-set eval holds leaks at **0**.
- **AI referrals ≠ AI crawlers.** `chatgpt.com` sending a person and `GPTBot` reading a page are two
  different events, classified separately and never summed — by a versioned rule table held at
  **100%** precision and recall by its own eval.
- **Which pages the crawlers read**, per page — the feedback loop GEO/AEO work actually needs.
- **Verified agent identity.** A request signed with Web Bot Auth (RFC 9421 HTTP Message Signatures)
  is checked against the Ed25519 key its operator publishes, so the signer can be *named*. A
  user-agent is a sentence; a signature is proof.
- **Agent sessions as their own class** — kept out of your visitor numbers, reported separately,
  never silently dropped or counted as people.
- **Two-layer bot detection, in the open-source core.** A user-agent table plus header rules that
  check whether a request agrees with the browser it claims to be. Recorded and shown, never
  self-applying: *a suspicion is not a verdict*.
- **Everything else you expect** — pageviews, sessions, unique and live visitors, bounce rate, visit
  duration, top / entry / exit pages, referrers, channels, UTM campaigns, devices, browsers, OS,
  screens, languages, country, custom events with properties, outbound clicks, form submissions,
  field-level form abandonment, rage and dead clicks, scroll depth, **ordered funnels**,
  **retention cohorts**, **Core Web Vitals at p75** and **JavaScript errors**.
- **Session replay, opt-in and masked.** Off until you switch it on for a site, loaded as a
  separate script only on pages that carry `data-replay`, and every text node and input value
  masked by default. Password, card and one-time-code fields are always blocked. Recordings play in
  a sandboxed player in the self-hosted dashboard.
- **City, region and coordinates without a GeoIP database** — read from the headers your proxy
  already sets (Cloudflare, Vercel, CloudFront), coordinates rounded to 0.1°.
- **Digests: what happened → why → what to do.** `vitrus digest` writes one in your terminal, every
  line tagged with the evidence ids behind it. The Slack / email / webhook channels and the
  never-sent-twice scheduler ship in the core.
- **A read-only MCP module** for AI agents that returns the evidence with every metric, so an agent
  can cite instead of assert.
- **Private by construction.** No cookies, no stored identifier, no fingerprinting, no consent
  banner. Do Not Track honoured by default. A **2.6 KB** tracker. **Zero** runtime dependencies,
  enforced by CI.

Deliberately absent: ad-platform attribution (ROAS/CPA) and multi-touch attribution models, because
a model's opinion is not something we can prove.

## Self-host in a minute

You need [Bun](https://bun.sh) 1.3 or newer. That is the whole list.

```bash
git clone https://github.com/Vitrus-Dev/vitrus && cd vitrus
bun install && bun run build:tracker

alias vitrus="bun $PWD/packages/cli/src/cli.ts"
vitrus init                              # creates ./vitrus.db and a secret salt
vitrus site add "My site" example.com    # prints your script tag
vitrus start                             # ingest + dashboard on http://localhost:3000
```

Add the tag it printed to your site's `<head>`:

```html
<script defer data-site="SITE_ID" src="https://YOUR-HOST/v.js"></script>
```

No Docker Compose file, no second service, no migration step. Want data on screen straight away?
`vitrus demo <site-id>` generates a realistic week of sample traffic.

```bash
vitrus site ls                                        # list your sites
vitrus digest <site-id> --days 7                      # deterministic summary, in your terminal
vitrus digest <site-id> --llm ollama:gemma3:4b        # phrased by a local model; data never leaves the box
vitrus start --port 8080
```

The database path is `VITRUS_DB` (default `./vitrus.db`). Put Cloudflare, Vercel, Fly, CloudFront or
Netlify in front and country (and, from Cloudflare, Vercel or CloudFront, region and city) is read from
the headers they already set — there is no GeoIP database
to download, and without a proxy the dashboard says the data is missing rather than guessing.

## How it compares

The open-source alternatives are good, and several do things we do not. This table lists only
differences we can state without qualification. *Checked 24 September 2026 against each product's own
documentation — if a cell is out of date, please [open an issue](https://github.com/Vitrus-Dev/vitrus/issues/new).*

| | GA4 | Plausible | Umami | Rybbit | **Vitrus** |
|---|:---:|:---:|:---:|:---:|:---:|
| Open source | ✗ | ✓ AGPL-3.0 | ✓ MIT | ✓ AGPL-3.0 | **✓ Apache-2.0** |
| Cookie-free, no consent banner | ✗ | ✓ | ✓ | ✓ | **✓** |
| Services to install | — | Postgres + ClickHouse | Postgres or MySQL | Postgres + ClickHouse | **none** |
| Tracker size (gzipped) | ~28 KB | ~1 KB | ~2 KB | ~18 KB | **2.6 KB** |
| AI assistants as a channel | ✗ | ✓ | ✓ | ✓ | **✓** |
| Crawler reads separated from the humans they send | ✗ | ✗ | ✗ | ✓ | **✓** |
| **The query behind every number, in the UI** | ✗ | ✗ | ✗ | ✗ | **✓** |
| **AI sentences dropped when the number is unprovable** | ✗ | ✗ | ✗ | ✗ | **✓** |
| Verified agent identity (Web Bot Auth) | ✗ | ✗ | ✗ | ✗ | **✓** |
| Bot detection beyond the user-agent, in the open-source build | ✗ | ✗ | ✗ | ✗ | **✓** |
| Funnels, journeys and goals | ✓ | ✓ (funnels on paid plans) | ✓ | ✓ | **✓** |
| Session replay | ✗ | ✗ | ✓ | ✓ | opt-in, masked by default |
| Public API with keys | ✓ | ✓ | ✓ | ✓ | not yet (read-only MCP today) |
| City-level geography | ✓ | ✓ | ✓ | ✓ | from proxy headers |
| Hundreds of millions of events a month | ✓ | ✓ | ✓ | ✓ | ~1M/month per box |

### Where Vitrus is ahead

- **You can check every number.** Click it and you get the query, its parameters and the rows. No other
  tool in this table does that.
- **AI summaries cannot make numbers up.** A sentence whose number is not in the evidence is removed.
- **AI traffic, told apart properly.** Visitors that ChatGPT or Perplexity sent you are one thing; the AI
  crawlers reading your pages are another; agents that sign their requests are verified and named.
- **Nothing to operate.** One process and an embedded database. The others need a database server —
  Postgres or MySQL, and for two of them ClickHouse as well.
- **The privacy default is the strict one.** The visitor id is re-salted every day, always.

### Where others are ahead

- **Revenue tracking** — Plausible, Umami and GA4. **Heatmaps** — Umami. We have neither.
- **Importing your history** from another tool — Plausible and Rybbit do it; we do not yet.
- **Google Search Console** — Plausible and Rybbit connect it; we do not yet.
- **A public API with keys** — everyone else has one; we offer a read-only MCP server for now.
- **Maturity and scale.** Replay, autocapture of every button click and hundreds of millions of events
  a month are all further along in Rybbit and Umami, which run on ClickHouse or Postgres. Our embedded
  database is what makes the zero-service install possible, and it is also its ceiling (about a million
  events a month per box).
- **Ad attribution.** If your reporting is tied to Google or Meta ad spend, GA4 closes that loop and we
  never will.
- **Cities without a proxy.** Everyone else bundles a GeoIP database; we read city and region from
  Cloudflare, Vercel or CloudFront headers, and show only the country otherwise.

One-page write-ups per tool: **[vitrus.dev/compare](https://vitrus.dev/compare)**.

## Privacy

The visitor id is a one-way hash that cannot follow anyone across days:

```
sha256(secret_salt | day | site | ip_prefix | user_agent)
```

The salt rotates daily, the IP is never stored (IPv6 is reduced to its `/64` first), and nothing is
written to the browser. That is also why the retention page tells you when it *cannot* compute a
cohort instead of showing zeros — call `vitrus.identify(user.id)` for signed-in users and retention
becomes real, with the raw id never touching disk.

## Architecture

```
packages/
  core      ingest · classifiers · MetricBundle · numeric guard · digest · agent verifier ·
            explore queries (sessions, users, journeys, goals, geo) · replay ingest + player
  tracker   the browser script, 2.6 KB gzipped (+ an opt-in replay recorder, under 5 KB)
  server    one process: ingest + query API + tracker + evidence dashboard
  cli       init · site · start · digest · demo
  mcp       read-only MCP module (JSON-RPC over HTTP) for AI agents
```

Every package has **zero** runtime dependencies. The SQL string *is* the evidence — `Store.select`
takes raw SQL on purpose, because hiding it behind an ORM would remove the one thing this project is
for.

A few pieces ship in the core as libraries before the self-hosted server exposes them. Today the
server does **not** yet mount the MCP module, run the scheduled digest delivery, accept server-side
forwarded requests (which is how signed agents and non-rendering crawlers are seen — a browser script
never sees them), take row filters, or render the sessions, users, journeys, goals and globe views; the building blocks are here and wiring them into `vitrus start` is on the
[roadmap](https://github.com/Vitrus-Dev/vitrus/issues).

## Running the gates

```bash
bun install && bun run build:tracker
bun run gates
```

Type checks, the test suites, two golden-set evals and the build gates:

| Gate | What it prevents |
|---|---|
| `eval:referrer` | the AI-source table going stale unnoticed — 100% required |
| `eval:insight` | an unprovable number surviving into prose — zero leaks tolerated |
| `gate:core-purity` | the metric layer ever importing the LLM layer |
| `gate:no-deps` | a runtime dependency appearing without a deliberate decision |
| `gate:tracker-size` | the tracker quietly growing past 3 KB |
| `gate:inline-js` | a bad escape killing the dashboard's script while the page still renders |

## Cloud

**[app.vitrus.dev](https://app.vitrus.dev)** is the hosted version: teams and roles, quotas, EU
hosting and digest delivery without running your own mail provider, plus the sessions, users,
journeys, goals, real-time and globe views. The analysis engine is the same: every query those views
run lives in `packages/core` in this repository.

## Community

- **Questions and ideas** — [GitHub Discussions](https://github.com/Vitrus-Dev/vitrus/discussions)
- **Bugs** — [open an issue](https://github.com/Vitrus-Dev/vitrus/issues/new). A failing case beats a
  description; the AI referrer table in particular is tested by example.
- **Security** — see [SECURITY.md](SECURITY.md). Please do not open a public issue for a vulnerability.
- **Contributing** — see [CONTRIBUTING.md](CONTRIBUTING.md). The most useful first contribution is a
  new AI-referrer rule with the test case that pins it.

## Star history

<a href="https://star-history.com/#Vitrus-Dev/vitrus&Date">
  <img src="https://api.star-history.com/svg?repos=Vitrus-Dev/vitrus&type=Date" alt="Star history chart" width="600">
</a>

## Contributors

<a href="https://github.com/Vitrus-Dev/vitrus/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Vitrus-Dev/vitrus" alt="Contributors">
</a>

## License

[Apache-2.0](LICENSE).
