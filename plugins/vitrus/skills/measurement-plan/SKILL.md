---
name: measurement-plan
description: Propose what a site should measure with Vitrus — the custom events, goals, funnels, revenue and identify() calls that answer the owner's questions — by reading the codebase or the site, then give the exact code to add. Use when setting up Vitrus, when there are no goals yet, or when asked "what should we track".
---

# Measurement plan

Vitrus' MCP server is read-only on purpose: you cannot create goals or funnels through it. Your job is
to produce a plan and the exact code; the person adds goals and funnels in the dashboard.

## Steps

1. Ask (or infer from the repo) the 2–3 questions the site must answer: "which channels bring buyers",
   "where do people drop out of signup", "does the docs page lead to activation".
2. Read the code: find signup, checkout, pricing, key CTAs and forms. Note the routes.
3. `list_sites`, then `get_tracking_snippet` — confirm the tag and the site id.
4. `query_stats` with `by: "event"`, `days: 30` — see which custom events already arrive. `list_goals`
   — see what exists.
5. Write the plan:
   - **Events** — name, where it fires, properties. Code, e.g.
     `vitrus("signup", { plan: "pro" })` or, with no JavaScript, an attribute
     `data-vitrus-event="cta_click" data-vitrus-event-label="Start free"`.
   - **Revenue** — `vitrus("purchase", { revenue: 29, currency: "USD" })` on the success page. Amounts are
     never converted between currencies.
   - **identify()** — `vitrus.identify(user.id)` after sign-in, which makes retention possible. The raw
     id is hashed on the server and never stored.
   - **Goals** to add under Goals: name, type (`page` with a pattern like `/docs/**`, or `event`), value.
   - **Funnel** to add under Funnels: ordered steps.
6. Keep it small: five events that answer real questions beat thirty that nobody reads.

Do not put personal data (emails, names, ids) in event properties or URLs. Say so in the plan.
