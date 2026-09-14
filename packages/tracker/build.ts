// packages/tracker/build.ts — minify the script and REPORT its size.
// Size is a promise: if the tracker grows, the customer's page gets slower. So
// the number is both printed and fed into a CI gate (scripts/gate-tracker-size.ts).

import { gzipSync } from "bun";

const out = await Bun.build({
  entrypoints: ["./src/tracker.ts"],
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
await Bun.write("./dist/v.js", code);

const raw = Buffer.byteLength(code, "utf8");
const gz = gzipSync(Buffer.from(code)).length;
await Bun.write("./dist/size.json", JSON.stringify({ raw, gzip: gz }, null, 2) + "\n");

console.log(`tracker: ${raw} B raw · ${gz} B gzip → dist/v.js`);
