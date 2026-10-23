# @vitrus-dev/cli

Self-hosted, cookie-free analytics in one process. Needs [Bun](https://bun.sh) 1.3+.

```bash
bun install -g @vitrus-dev/cli
vitrus init                                   # creates ./vitrus.db and a secret salt
vitrus site add "My site" example.com         # prints your script tag
VITRUS_PASSWORD="a long secret" vitrus start  # ingest + dashboard on http://localhost:3000
```

The self-hosted dashboard shows fewer pages than the cloud one today; [the docs](https://vitrus.dev/docs/self-hosting) list exactly what.

Part of [Vitrus](https://github.com/Vitrus-Dev/vitrus) · Apache-2.0
