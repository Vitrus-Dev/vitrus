// scripts/gate-tracker-size.ts
// The tracker's size is a PROMISE. If it grows, the customer's page gets slower,
// and it will come back at us in Shopify's performance gate (p95 ≤ 500 ms).
// So the size is a CI gate, not a "let's be careful" note.

const LIMIT_GZIP = 3 * 1024; // 3 KB
const LIMIT_RAW = 12 * 1024;

const root = new URL("../", import.meta.url).pathname;
const sizePath = `${root}packages/tracker/dist/size.json`;

const file = Bun.file(sizePath);
if (!(await file.exists())) {
  console.error("✗ tracker not built — run this first: bun run build:tracker");
  process.exit(1);
}

const { raw, gzip } = (await file.json()) as { raw: number; gzip: number };
const ok = gzip <= LIMIT_GZIP && raw <= LIMIT_RAW;

console.log(`tracker size: ${raw} B raw · ${gzip} B gzip  (limit: ${LIMIT_RAW} / ${LIMIT_GZIP})`);
console.log(ok ? "✓ PASSED" : "✗ FAILED — the tracker exceeded its limit");
process.exit(ok ? 0 : 1);
