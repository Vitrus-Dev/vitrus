// scripts/gate-core-purity.ts
// The dependency-direction gate.
//
// Two invariants:
//  I1  The metric/ingest layer MUST NOT depend on the LLM. Code that produces
//      numbers must not know about code that produces language; if it does, the
//      claim "the numbers are deterministic" collapses.
//  I2  Vertical packages (verticals/) may import the core; the core NEVER imports
//      a vertical. Otherwise adding Shopify forks the landing code.

import { readdir } from "node:fs/promises";

const root = new URL("../packages/core/src/", import.meta.url).pathname;

interface Rule {
  id: string;
  /** Files in these directories… */
  from: string[];
  /** …MUST NOT import from these. */
  forbidden: string[];
  why: string;
}

const RULES: Rule[] = [
  {
    id: "I1",
    from: ["metrics", "store", "ingest.ts", "bots.ts", "referrers.ts", "ua.ts", "visitor.ts", "validate.ts"],
    forbidden: ["insight/llm"],
    why: "the layer that produces numbers must not know the LLM — the basis of the determinism claim",
  },
  {
    id: "I2",
    from: ["metrics", "store", "insight", "ingest.ts"],
    forbidden: ["verticals/"],
    why: "the core cannot depend on a vertical; a vertical depends on the core",
  },
  {
    id: "I3",
    from: ["insight/guard.ts", "insight/compose.ts"],
    forbidden: ["insight/llm"],
    why: "the guard and the deterministic composer must work on their own, without an LLM",
  },
];

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = `${dir}${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walk(`${full}/`)));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const files = await walk(root);
const violations: string[] = [];

for (const file of files) {
  const rel = file.slice(root.length);
  const source = await Bun.file(file).text();
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");

  for (const rule of RULES) {
    const inScope = rule.from.some((f) => (f.endsWith(".ts") ? rel === f : rel.startsWith(`${f}/`)));
    if (!inScope) continue;
    for (const imp of imports) {
      const normalized = imp.replace(/^\.\.?\//, "").replace(/^(\.\.\/)+/, "");
      if (rule.forbidden.some((f) => normalized.includes(f.replace(/\/$/, "")))) {
        violations.push(`${rule.id}  ${rel} → ${imp}   (${rule.why})`);
      }
    }
  }
}

// Extra check: the core must have no runtime dependencies.
const corePkg = (await Bun.file(new URL("../packages/core/package.json", import.meta.url)).json()) as {
  dependencies?: Record<string, string>;
};
if (corePkg.dependencies && Object.keys(corePkg.dependencies).length > 0) {
  violations.push(`I4  @vitrus/core acquired a runtime dependency: ${Object.keys(corePkg.dependencies).join(", ")}`);
}

console.log(`core-purity gate — ${files.length} files, ${RULES.length} rules`);
if (violations.length) {
  for (const v of violations) console.log(`  ✗ ${v}`);
  console.log("\n✗ FAILED");
  process.exit(1);
}
console.log("✓ PASSED");
