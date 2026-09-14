## What this changes

<!-- One or two sentences. If it fixes an issue, link it. -->

## Why

<!-- The reasoning, especially if the change has a cost. A comment explaining WHY is worth more
     here than a description of WHAT the code does. -->

## Checklist

- [ ] `bun run gates` is green (typecheck, tests, evals, build gates)
- [ ] New behaviour has a test; a bug fix has a test that fails without it
- [ ] If a classification table changed, its eval case was added and the table version bumped
- [ ] If a limitation was introduced or discovered, it is written down in a comment or the docs
- [ ] No new runtime dependency (or the allow list was updated in the same commit, with a reason)
