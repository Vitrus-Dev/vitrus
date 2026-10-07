---
name: traffic-drop
description: Investigate a drop (or spike) in traffic on a Vitrus site by narrowing it down by day, channel, source, page, country, device and browser, and checking errors and Web Vitals for the same window — every finding backed by its query. Use when someone says traffic fell, signups dropped, "what happened on Tuesday", or a number looks wrong.
---

# Traffic-drop check

Use the Vitrus MCP server (`vitrus`). Work from the data outwards; do not start with a theory.

## Steps

1. **Find the break.** `query_stats` with `metric: "visitors"`, `by: "day"`, `days: 28`. Identify the first
   day that departs from the pattern (weekends are normally lower — compare like with like).
2. **Pick two windows** of equal length: the days after the break and the same days before it. Use
   exact `from`/`to` dates for both.
3. **Segment, both windows, same metric:** `query_stats` with `by` set to `channel`, then `source`,
   `path`, `country`, `device`, `browser`. Put the segments side by side; the drop usually lives in one
   or two rows. Narrow further with `filters` (for example `{"field": "channel", "value": "search"}`
   and `by: "path"`).
4. **Look for a technical reason:** `get_errors` and `get_web_vitals` for the after-window. A new error
   on the affected page, or an LCP jump, is worth reporting.
5. **Check tracking itself:** if every segment fell by the same proportion at the same hour, suspect the
   tracking script (removed, blocked, consent change) and say so — `get_tracking_snippet` shows the
   expected tag.

## Report

- The break: date and size, cited.
- Where it lives: the one or two segments that account for most of it, with both windows' numbers.
- What coincides with it: errors, vitals, a campaign ending — framed as "coincides with", not "caused by".
- What you could not tell from analytics alone, and what would settle it (a deploy log, a search
  console check).

Never fill a gap with a guess. If the data cannot say, write that it cannot.
