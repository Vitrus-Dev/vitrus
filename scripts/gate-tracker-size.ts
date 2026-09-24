// scripts/gate-tracker-size.ts
// The tracker's size is a PROMISE. If it grows, the customer's page gets slower,
// and it will come back at us in Shopify's performance gate (p95 ≤ 500 ms).
// So the size is a CI gate, not a "let's be careful" note.
//
// The session-replay recorder is gated separately with its own budget. It is
// only downloaded by pages that opt in with `data-replay`, but "only some pages"
// is not a licence to grow without limit — rrweb is ~40 KB gzipped, and the
// reason we wrote our own is gone the day ours drifts toward that.

const root = new URL("../", import.meta.url).pathname;

const BUDGETS = [
  { label: "tracker", file: "packages/tracker/dist/size.json", gzip: 3 * 1024, raw: 12 * 1024 },
  { label: "replay recorder", file: "packages/tracker/dist/replay-size.json", gzip: 5 * 1024, raw: 16 * 1024 },
];

let ok = true;
for (const b of BUDGETS) {
  const file = Bun.file(`${root}${b.file}`);
  if (!(await file.exists())) {
    console.error(`✗ ${b.label} not built — run this first: bun run build:tracker`);
    process.exit(1);
  }
  const { raw, gzip } = (await file.json()) as { raw: number; gzip: number };
  const pass = gzip <= b.gzip && raw <= b.raw;
  ok &&= pass;
  console.log(`${b.label} size: ${raw} B raw · ${gzip} B gzip  (limit: ${b.raw} / ${b.gzip})`);
  if (!pass) console.log(`✗ FAILED — the ${b.label} exceeded its limit`);
}
console.log(ok ? "✓ PASSED" : "✗ FAILED");
process.exit(ok ? 0 : 1);
