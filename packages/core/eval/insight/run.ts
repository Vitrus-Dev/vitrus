// packages/core/eval/insight/run.ts
// The numeric guard's golden set — the measure of the product's ONE difference.
//
// Two separate measures, and the difference between them is deliberate:
//   • LEAK: a sentence with an invented number survives. TOLERANCE 0. One leak
//     and the product loses its "provable" claim → the gate goes RED.
//   • FALSE DROP: a correct sentence is dropped unnecessarily. This does not make
//     the product untrustworthy, only poorer; still reported, and the target is 0.

import { guardProse } from "../../src/insight/guard.ts";
import cases from "./cases.json" with { type: "json" };

interface Case {
  id: string;
  allowed: number[];
  prose: string;
  fabricated: boolean;
  causal?: boolean;
  expectDropped: number;
}

let leaks = 0;
let falseDrops = 0;
let exact = 0;
const problems: string[] = [];

for (const c of cases as Case[]) {
  const r = guardProse(c.prose, { allowedNumbers: c.allowed }, { strictCausality: true });
  const droppedCount = r.dropped.length;

  if (droppedCount === c.expectDropped) exact++;
  else if (droppedCount < c.expectDropped) {
    leaks += c.expectDropped - droppedCount;
    problems.push(`${c.id}: LEAK — expected ${c.expectDropped} drop(s), got ${droppedCount}`);
  } else {
    falseDrops += droppedCount - c.expectDropped;
    problems.push(
      `${c.id}: FALSE DROP — expected ${c.expectDropped}, got ${droppedCount} → ${r.dropped
        .map((d) => `"${d.sentence}" (${d.numbers.join(", ") || "nedensellik"})`)
        .join(" | ")}`
    );
  }
}

const total = (cases as Case[]).length;
console.log(`insight (numeric guard) eval — ${total} cases`);
console.log(`  exact matches   : ${exact}/${total}`);
console.log(`  leaks           : ${leaks}   (tolerance: 0)`);
console.log(`  false drops     : ${falseDrops}`);

if (problems.length) {
  console.log("\nPROBLEMS:");
  for (const p of problems) console.log(`  ✗ ${p}`);
}

const pass = leaks === 0 && falseDrops === 0;
console.log(pass ? "\n✓ PASS" : "\n✗ FAIL");
process.exit(pass ? 0 : 1);
