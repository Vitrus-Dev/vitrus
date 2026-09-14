# Security policy

## Reporting a vulnerability

Email **security@vitrus.dev**. Please do not open a public issue for a security problem.

Include enough detail to reproduce it — a proof of concept, the affected version or commit, and what
an attacker could do with it.

We will confirm receipt within **three working days** and keep you updated while we work on a fix. We
will not pursue legal action against anyone acting in good faith, and we are happy to credit you in
the release notes if you would like.

## Supported versions

Vitrus is pre-1.0. Security fixes land on `main` and in the next release; there are no long-term
support branches yet.

## Scope

In scope: this repository, the tracker script, the ingest endpoint, the query API and the MCP server.

Out of scope: findings that require a compromised host or physical access, reports generated purely by
an automated scanner with no demonstrated impact, and missing hardening headers with no exploit path.

## Design decisions worth knowing before you report

Some things look like findings and are deliberate:

- **The tracker accepts any `data-site` value.** Ingest validates the site exists and rejects unknown
  ids with a 404. An unknown site and a site you cannot access return the *same* error on purpose — a
  distinguishable response would confirm which sites exist.
- **The visitor id is not a secret.** It is a one-way hash with a daily salt, designed to be
  unlinkable across days rather than unguessable.
- **Bot traffic is stored, not discarded.** It is labelled with `bot_kind` and excluded from every
  human metric at the query layer.
- **The optional LLM layer cannot produce numbers.** If you find a way to make an unprovable number
  survive `guardProse`, that *is* a valid report — please send it.
