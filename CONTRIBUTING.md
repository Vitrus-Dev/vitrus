# Contributing to Vitrus

Thanks for taking the time. This document is short on purpose — if something here is unclear, open an
issue and say so.

## Getting set up

You need [Bun](https://bun.sh) 1.3 or newer. Nothing else: no database to install, no services to run.

```bash
git clone https://github.com/Vitrus-Dev/vitrus.git
cd vitrus
bun install
bun run build:tracker
bun run gates          # typecheck + 189 tests + 2 evals + 3 gates
```

To try it end to end:

```bash
cd packages/cli
bun run src/cli.ts init
bun run src/cli.ts site add "Local" localhost
bun run src/cli.ts demo <site-id>     # generates a realistic week of data
bun run src/cli.ts start
```

## Before you open a pull request

`bun run gates` must be green. That is the whole checklist — CI runs exactly the same command.

## Things worth knowing about this codebase

**The SQL string is the evidence.** Every metric is `{ id, sql, params, window, value }` and the
dashboard shows the user that exact query. If you find yourself wanting to build queries through an
ORM or a query builder, stop: the product's only real differentiator disappears the moment the query
stops being readable.

**Numbers never come from a model.** `packages/core/src/metrics/` computes; `packages/core/src/insight/llm.ts`
only rephrases. A CI gate (`gate:core-purity`) fails the build if the metric layer ever imports the
LLM layer. This is not a style preference — it is the reason anyone can trust the output.

**Zero runtime dependencies.** `gate:no-deps` fails the build when a package acquires one. If you
genuinely need a dependency, say why in the pull request and add it to the allow list in the same
commit so the decision is visible. Most of the time the answer is thirty lines of code instead.

**Fail closed, and say why.** When we cannot compute something, we return a reason and a remedy — see
`retention.ts` for the pattern. Never return a plausible number in place of a missing one, and never
render an unmeasured value as zero.

**Honest comments.** Comments here explain *why* a decision was made and what it cost, not what the
line below does. If a limitation is real, write it down — `ip.ts` and `visitor.ts` are the house style.

## What is most useful to contribute

**New AI assistants or crawlers.** The tables in `packages/core/src/bots.ts` and
`packages/core/src/referrers.ts` go stale as new products launch. Add the host or user agent, bump the
table version, and add a case to `packages/core/eval/ai-referrer/cases.json`. The eval must stay at
100%.

**Guard cases.** If you can get an unprovable number past `guardProse`, that is a bug worth a test.
Add the case to `packages/core/eval/insight/cases.json` with `expectDropped` set to what *should*
happen, and it will fail until fixed.

**Bug reports with a reproduction.** A failing test is the fastest possible bug report.

## What is out of scope

Two things are permanently out of scope, and pull requests adding them will be declined:

- **Session replay.** Recording a visitor's screen means recording the ID number they typed into a
  form. One missed mask and we have created our user's compliance problem.
- **Ad-platform attribution.** ROAS and CPA need the ad platform's own spend data. Deriving them from
  click counts would produce exactly the kind of unprovable number this project exists to refuse.

## Commit messages

Plain, imperative, and explain the *why* when it is not obvious:

```
Fix mail.google.com being classified as search

Suffix matching on "google.com" beat the exact match in the email table.
Two-phase now: exact first, then the longest suffix.
```

## License

By contributing you agree that your contributions are licensed under
[Apache-2.0](LICENSE), the same as the rest of this repository.
