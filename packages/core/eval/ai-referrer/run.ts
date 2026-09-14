// packages/core/eval/ai-referrer/run.ts
// The golden set for the AI-referral classifier.
//
// Why an eval and not just a test: this table GOES STALE over time (new
// assistants appear, hosts change). The eval reduces the table's health to a
// single number and wires it to a CI gate; when a rule is added, it proves the
// old ones still hold.
//
// Pass condition: overall accuracy 100% AND precision/recall for the ai class
// both 100%. In a deterministic, rule-based classifier 99% is not "nearly right",
// it means "one case is broken".

import { detectBot } from "../../src/bots.ts";
import { classifyReferrer, parseUtm } from "../../src/referrers.ts";
import cases from "./cases.json" with { type: "json" };

interface Case {
  id: string;
  referrer: string;
  url: string;
  ua: string;
  channel: string;
  source: string;
  bot?: string;
}

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

const failures: string[] = [];
let tp = 0;
let fp = 0;
let fn = 0;
let correct = 0;

for (const c of cases as Case[]) {
  const ua = c.ua === "chrome" ? CHROME : c.ua;
  const query = c.url.includes("?") ? c.url.slice(c.url.indexOf("?")) : "";
  const verdict = classifyReferrer({
    referrer: c.referrer,
    utm: parseUtm(query),
    selfHost: "example.com",
  });
  const bot = detectBot(ua);
  const expectedBot = c.bot ?? "";

  const okChannel = verdict.channel === c.channel;
  const okSource = verdict.source === c.source;
  const okBot = bot.kind === expectedBot;

  if (okChannel && okSource && okBot) correct++;
  else {
    failures.push(
      `${c.id}: kanal ${verdict.channel}≠${c.channel} · kaynak "${verdict.source}"≠"${c.source}" · bot "${bot.kind}"≠"${expectedBot}"`
    );
  }

  const predAi = verdict.channel === "ai";
  const goldAi = c.channel === "ai";
  if (predAi && goldAi) tp++;
  else if (predAi && !goldAi) fp++;
  else if (!predAi && goldAi) fn++;
}

const total = (cases as Case[]).length;
const accuracy = (correct / total) * 100;
const precision = tp + fp === 0 ? 100 : (tp / (tp + fp)) * 100;
const recall = tp + fn === 0 ? 100 : (tp / (tp + fn)) * 100;

console.log(`ai-referrer eval — ${total} cases`);
console.log(`  accuracy        : ${accuracy.toFixed(1)}%  (${correct}/${total})`);
console.log(`  ai precision    : ${precision.toFixed(1)}%  (tp=${tp} fp=${fp})`);
console.log(`  ai recall       : ${recall.toFixed(1)}%  (fn=${fn})`);

if (failures.length) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
}

const pass = accuracy === 100 && precision === 100 && recall === 100;
console.log(pass ? "\n✓ PASS" : "\n✗ FAIL");
process.exit(pass ? 0 : 1);
