---
name: ai-search-audit
description: Audit how AI assistants and AI crawlers interact with a Vitrus site — which assistants send people, where those people land and whether they convert, and which pages GPTBot/ClaudeBot/PerplexityBot read — and turn it into GEO/AEO recommendations backed by the numbers. Use for "AI traffic", "ChatGPT traffic", "GEO", "AEO" or "are we showing up in AI answers".
---

# AI-search audit

Use the Vitrus MCP server (`vitrus`). Three different things are measured, and they are never mixed:

- **AI referrals** — people who clicked through from ChatGPT, Perplexity, Claude, Gemini…
- **AI crawlers** — bots (GPTBot, ClaudeBot, PerplexityBot, OAI-SearchBot) reading pages. Not visitors.
- **Verified agents** — browsers that cryptographically signed their requests (Web Bot Auth).

## Steps

1. `get_ai_traffic` with `days: 30` — referral sessions by source, landing pages, crawler hits, pages
   crawled.
2. `query_stats` with `filters: [{"field": "channel", "value": "ai"}]`, `by: "path"`, `days: 30` — where
   AI-referred people land. If the channel name differs, use the source values `get_ai_traffic` returned.
3. `goal_report` with the same filter (or `query_stats` with `metric: "events"`, `by: "event"`) — do
   AI-referred visitors convert, compared with search?
4. Compare the crawled pages with the landed pages:
   - **Crawled, rarely landed** — read by models but not cited; check the content answers a question
     directly.
   - **Landed, rarely crawled** — strong pages the bots under-read; check `robots.txt` and internal links.
5. Note the limit honestly: crawlers do not run JavaScript, so a browser script sees them only if the
   site forwards page requests to `/api/collect/server`. If crawler numbers are zero, say this is the
   likely reason rather than "no bots visit".

## Report

AI share of sessions (cited) · top assistants · top AI landing pages and their conversion · crawled vs
landed table · three recommendations, each tied to a row above.
