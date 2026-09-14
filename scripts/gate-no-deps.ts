// scripts/gate-no-deps.ts
// The gatekeeper of the "genuinely one-command install" promise.
//
// Competitors' install pain (Plausible: Elixir+Postgres+ClickHouse; PostHog:
// Kafka+ClickHouse+Redis) starts with a single decision: "let's add one more
// thing". This gate makes that decision visible — adding a runtime dependency
// requires a deliberate update to the list below.

const ALLOWED_RUNTIME_DEPS = new Set<string>([
  // Only workspace-internal packages are allowed.
]);

const root = new URL("../", import.meta.url).pathname;
const packages = ["packages/core", "packages/tracker", "packages/server", "packages/cli", "packages/mcp"];

const problems: string[] = [];

for (const pkg of packages) {
  const file = Bun.file(`${root}${pkg}/package.json`);
  if (!(await file.exists())) continue;
  const json = (await file.json()) as { name: string; dependencies?: Record<string, string> };
  for (const [dep, version] of Object.entries(json.dependencies ?? {})) {
    if (version.startsWith("workspace:")) continue;
    if (ALLOWED_RUNTIME_DEPS.has(dep)) continue;
    problems.push(`${json.name}: ${dep}@${version}`);
  }
}

console.log(`no-deps gate — ${packages.length} packages`);
if (problems.length) {
  console.log("  Unapproved runtime dependency:");
  for (const p of problems) console.log(`  ✗ ${p}`);
  console.log("\nIf this is a deliberate decision, add it to the list in scripts/gate-no-deps.ts.");
  console.log("✗ FAILED");
  process.exit(1);
}
console.log("✓ PASSED — no runtime dependencies (bun + sqlite is enough)");
