# @vitrus/core

The engine behind [Vitrus](https://vitrus.dev): ingest and validation, bot and AI-referrer classifiers, every metric as `{ sql, params, window, value }` so the query is the evidence, user lifecycle and portfolio, heatmaps from masked recordings, and the numeric guard that drops an AI sentence whose number cannot be proven.

Zero runtime dependencies; runs on [Bun](https://bun.sh) with its built-in SQLite.

```ts
import { SqliteStore, computePortfolio } from "@vitrus/core";
```

Part of [Vitrus](https://github.com/Vitrus-Dev/vitrus) · Apache-2.0
