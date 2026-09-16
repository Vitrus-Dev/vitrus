// scripts/gate-inline-js.ts
// THE INLINE-JS SYNTAX GATE.
//
// Why it exists: the dashboard generates its JavaScript INSIDE a TypeScript
// template literal. Get one quote wrong in the template — for example
// `style=\"...\"`, which becomes a bare `"` and splits the JS string — and the
// generated page's ENTIRE script dies with a syntax error. The page still
// renders (the HTML is static) but nothing works: no data loads, no control
// responds.
//
// This happened to us and was caught IN PRODUCTION. The tests missed it because
// every one of them asked "does this text appear in the HTML" — it did, and it
// did not work.
//
// This gate PARSES every inline <script> block in the generated page.
// It parses; it does not execute: no side effects, no DOM needed.

import { dashboardHtml } from "../packages/server/src/dashboard.ts";
import type { Site } from "../packages/core/src/types.ts";

const SITE: Site = {
  id: "demo",
  name: "Demo",
  domain: "demo.example",
  vertical: "landing",
  createdAt: 0,
};

const PAGES = [
  { name: "server/dashboard (with sites)", html: dashboardHtml([SITE]) },
  // The empty case renders a different branch of the site picker, and a broken
  // escape there would only ever show up on a brand-new install.
  { name: "server/dashboard (no sites)", html: dashboardHtml([]) },
];

/** `<script>` blocks (ones with src are skipped — those are not inline). */
function inlineScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const body = (m[1] ?? "").trim();
    if (body) out.push(body);
  }
  return out;
}

let failures = 0;
let checked = 0;

for (const page of PAGES) {
  const scripts = inlineScripts(page.html);
  if (scripts.length === 0) {
    console.log(`  ${page.name}: no inline script`);
    continue;
  }
  for (const [i, src] of scripts.entries()) {
    checked++;
    try {
      // `new Function` only PARSES; it does not run the code.
      new Function(src);
    } catch (e) {
      failures++;
      const msg = (e as Error).message;
      console.log(`  ✗ ${page.name} script#${i + 1}: ${msg}`);
      // Locate the offending line: parse incrementally and report where it first breaks.
      const lines = src.split("\n");
      for (let n = 1; n <= lines.length; n++) {
        try {
          new Function(lines.slice(0, n).join("\n"));
        } catch (inner) {
          if ((inner as Error).message === msg) {
            console.log(`     ↳ line ${n}: ${lines[n - 1]?.trim().slice(0, 120)}`);
            break;
          }
        }
      }
    }
  }
}

console.log(`inline-js gate — ${PAGES.length} pages, ${checked} scripts`);
if (failures > 0) {
  console.log(`✗ FAILED — ${failures} script(s) will not parse (the page renders but the JS is DEAD)`);
  process.exit(1);
}
console.log("✓ PASSED");
