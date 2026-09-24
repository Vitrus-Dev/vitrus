// packages/tracker/build.ts — minify the script and REPORT its size.
// Size is a promise: if the tracker grows, the customer's page gets slower. So
// the number is both printed and fed into a CI gate (scripts/gate-tracker-size.ts).
//
// Two artefacts: the tracker (every page) and the session-replay recorder (only
// pages that opt in with `data-replay`, fetched lazily by the tracker). They are
// measured and gated SEPARATELY — the recorder must never hide inside the
// tracker's budget, and the tracker must not grow because replay exists.

import { gzipSync } from "bun";

const TARGETS = [
  { entry: "./src/tracker.ts", out: "./dist/v.js", size: "./dist/size.json", label: "tracker" },
  { entry: "./src/replay.ts", out: "./dist/r.js", size: "./dist/replay-size.json", label: "replay recorder" },
];

for (const t of TARGETS) {
  const out = await Bun.build({
    entrypoints: [t.entry],
    target: "browser",
    format: "iife",
    minify: true,
  });

  if (!out.success) {
    for (const log of out.logs) console.error(log);
    process.exit(1);
  }

  const artifact = out.outputs[0];
  if (!artifact) {
    console.error("no build output");
    process.exit(1);
  }

  const code = await artifact.text();
  await Bun.write(t.out, code);

  const raw = Buffer.byteLength(code, "utf8");
  const gz = gzipSync(Buffer.from(code)).length;
  await Bun.write(t.size, JSON.stringify({ raw, gzip: gz }, null, 2) + "\n");

  console.log(`${t.label}: ${raw} B raw · ${gz} B gzip → ${t.out.replace("./", "")}`);
}
