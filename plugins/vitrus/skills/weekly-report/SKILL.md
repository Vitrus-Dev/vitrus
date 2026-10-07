---
name: weekly-report
description: Write a weekly traffic report for a Vitrus site — what changed against the previous week, where visitors came from (including AI assistants), how goals converted — with every number cited to the query that produced it. Use when asked for a weekly/Monday report, a traffic summary, or "how did the site do last week".
---

# Weekly report from Vitrus

You have the Vitrus MCP server (`vitrus`). Every tool returns numbers together with the SQL, parameters
and rows behind them. The point of this report is that a reader can check every figure — keep it that way.

## Steps

1. `list_sites` — pick the site the user means. If there are several and it is unclear, ask.
2. `get_digest` with `days: 7` — the deterministic summary. Each line lists evidence ids; reuse them.
3. `query_stats` with `metric: "visitors"`, `by: "day"`, `days: 14` — the daily shape across both weeks.
4. `query_stats` with `by: "channel"`, `days: 7` and again with `from`/`to` for the previous week — the
   channel shift.
5. `get_ai_traffic` with `days: 7` — AI referrals (people) and AI crawlers (bots), separately.
6. `goal_report` with `days: 7` — conversions per saved goal. If there are no goals, say so and suggest the
   `measurement-plan` skill.
7. If revenue events exist, `get_revenue` with `days: 7`.

## Writing rules

- **Every number you write must come from a tool result.** After each figure, cite where it came from
  (the evidence id, or "query_stats: visitors by day"). Never compute a percentage the tools did not
  return unless you show the two numbers it comes from.
- **AI referrals and AI crawlers are never added together.** Crawlers are not visitors.
- Describe changes as coinciding, not as causes: "signups rose in the same week the pricing page
  changed", never "the pricing change caused".
- If a tool says a metric is unavailable (retention without `identify()`, no revenue events), say that.
  Do not estimate.

## Shape

**Headline** (one sentence with the visitor change and its evidence) · **What changed** (3–5 bullets) ·
**Where visitors came from** (channels, AI assistants) · **Goals** · **Worth a look** (at most 3 items,
each tied to a number above).
