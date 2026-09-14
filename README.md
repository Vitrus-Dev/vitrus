<div align="center">
  <img src=".github/assets/logo.svg" alt="Vitrus" width="76" height="76">
  <h1>Vitrus</h1>
  <p><b>Analytics for the AI agent era.</b><br>
  Open source, cookie-free, and every number carries the query that produced it.</p>
  <p>
    <a href="https://vitrus.dev">Website</a> ·
    <a href="https://vitrus.dev/docs">Documentation</a> ·
    <a href="https://vitrus.dev/features">Features</a> ·
    <a href="https://app.vitrus.dev">Cloud</a>
  </p>
  <p>
    <img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue">
    <img alt="Runtime dependencies" src="https://img.shields.io/badge/runtime%20deps-0-brightgreen">
    <img alt="Tracker size" src="https://img.shields.io/badge/tracker-2.4%20KB%20gzip-brightgreen">
  </p>
</div>

---

Two things broke in web analytics at the same time.

**Measurement broke.** ChatGPT, Perplexity and Claude send you real visitors, and roughly **70% of
them land in GA4's "direct" bucket** because most assistants attach no campaign tag. Meanwhile GPTBot
and ClaudeBot read your pages every day, and most tools either ignore them or count them as people.

**Trust broke.** Analytics products now generate written summaries. A model that says "conversion
fell 12% because of the theme release" has produced two claims you cannot check: a number it may have
computed itself, and a cause it cannot possibly know.

Vitrus fixes both. It classifies AI traffic properly and separates the crawlers from the humans they
send you — and **it can prove every number it reports.** Click any figure in the dashboard and you get
the SQL that ran, the parameters it ran with, and the raw rows. If an AI-written sentence contains a
number that is not in the evidence, that sentence is dropped before it ever reaches you.

```
Visitors are down 18% against the previous period. [e1]
The drop coincides with the last deploy. [e1, e7]
✗ dropped: "The new theme caused a 41.7% fall in conversion."
   → 41.7 is in no evidence record, and "caused" is a claim we cannot make.
```

## Why Vitrus

|                                       | Vitrus                          | Typical tool        |
| ------------------------------------- | ------------------------------- | ------------------- |
| The query behind every number         | **Clickable, always**           | Not available       |
| AI referrals vs AI crawlers           | **Separate, never summed**      | Mixed or discarded  |
| AI summaries                          | **Unprovable sentences dropped** | Shipped as written |
| Cookies / consent banner              | **None needed**                 | Usually required    |
| Tracker size                          | **2.4 KB gzipped**              | 18–28 KB            |
| Services to install                   | **Zero** (embedded database)    | Postgres, ClickHouse, Redis… |
| Runtime dependencies                  | **Zero**, enforced by CI        | Dozens              |

## Quick start

```bash
bun install -g @vitrus/cli

vitrus init                                # creates ./vitrus.db and a secret salt
vitrus site add "My site" example.com      # prints your script tag
vitrus start                               # dashboard on :3000
```

Then add one line to your site:

```html
<script defer data-site="SITE_ID" src="http://localhost:3000/v.js"></script>
```

That is the entire install. No Docker Compose file, no second service, no migration step.

Want data on the screen straight away? `vitrus demo <site-id>` generates a realistic week.

## What it measures

**Traffic** — pageviews, sessions, unique visitors, live visitors, top pages, entry and exit pages,
referrers, channels, UTM campaigns, devices, browsers, operating systems, screen sizes, languages,
country (from your proxy's header).

**Behaviour** — custom events from code or from an HTML attribute, outbound clicks, form submissions,
field-level form abandonment, rage clicks, scroll depth, ordered funnels, retention cohorts.

**Health** — Core Web Vitals at p75 from real visits, slowest pages, JavaScript errors grouped by
message, page and browser.

**AI** — AI assistants as their own traffic channel, which pages AI crawlers are reading, and the gap
between the two.

**Control** — exclude your own visits, skip or mask private URLs in the browser, standard and strict
privacy modes, Slack/email/webhook digests, a REST API and a read-only MCP server.

Deliberately absent: session replay and ad-platform attribution. [Here is why](https://vitrus.dev/docs/faq).

## Privacy

No cookies. No identifier stored in the browser. No fingerprinting.

The visitor id is a one-way hash:

```
sha256(secret_salt + "|" + day + "|" + site + "|" + ip_prefix + "|" + user_agent)
```

The salt rotates daily, so the same person becomes a different value tomorrow — cross-day tracking of
an anonymous visitor is not merely disallowed by policy, it is mathematically impossible. The IP is
never stored; it is only an input, and IPv6 is reduced to its /64 network prefix first. Do Not Track
is respected by default, not as an option you have to find.

This is also why the retention page tells you when it *cannot* compute a cohort instead of showing you
zeros. Call `vitrus.identify(user.id)` for logged-in users and retention becomes real.

## Architecture

```
packages/
  core      ingest · classifiers · MetricBundle · numeric guard · digest   (zero deps)
  tracker   the browser script, 2.4 KB gzipped                             (zero deps)
  server    one process: ingest + query API + tracker + dashboard          (zero deps)
  cli       init · site · start · digest · demo                            (zero deps)
  mcp       read-only MCP server for AI agents                             (zero deps)
```

Every metric is `{ id, sql, params, window, value }`. The SQL string *is* the evidence — it is not a
description of the query, it is the query. Hiding it behind an ORM would destroy the one thing this
product is for.

Numbers are computed by deterministic SQL first. The optional LLM layer (local Ollama, or your own
API key — neither is on by default) is handed the results and is forbidden from producing a number of
its own. A numeric guard checks every figure in the generated prose against the evidence set and drops
any sentence it cannot support.

## Running the tests

```bash
bun install
bun run build:tracker
bun run gates
```

`gates` runs the type checker, 189 tests, two golden-set evals and three build gates:

| Gate               | What it prevents                                                              |
| ------------------ | ----------------------------------------------------------------------------- |
| `eval:referrer`    | The AI classification table going stale unnoticed (100% required)             |
| `eval:insight`     | An unprovable number surviving into prose (zero leaks tolerated)              |
| `gate:tracker-size`| The tracker quietly growing and slowing your pages down                        |
| `gate:core-purity` | The metric layer ever importing the LLM layer                                  |
| `gate:no-deps`     | A runtime dependency appearing without a deliberate decision                    |

## Cloud

[app.vitrus.dev](https://app.vitrus.dev) is the hosted version: teams, roles, quotas, EU hosting and
digest delivery without running your own mail provider. The analysis engine is identical — **no
metric, funnel, cohort or evidence panel is held back from this repository**, and a build gate proves
the open core imports nothing commercial.

Self-hosting is free forever. [Self-host vs cloud](https://vitrus.dev/docs/self-host-vs-cloud).

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The most useful
contribution is usually a new entry for the AI referrer table with a test case that pins it.

## License

[Apache-2.0](LICENSE).
