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

/**
 * Parse, and say WHERE it broke.
 *
 * `new Function(src)` answers the yes/no question but reports "Unexpected EOF"
 * with no position, and an unterminated string makes every later line look
 * wrong — the first version of this gate guessed the line by re-parsing
 * prefixes and pointed three times at the line AFTER the real mistake. Bun's
 * transpiler parses the same grammar and hands back the line, the column and
 * the source text, so the gate now names the character instead of the
 * neighbourhood.
 */
const transpiler = new Bun.Transpiler({ loader: "js" });

interface ParseFailure {
  message: string;
  line?: number;
  column?: number;
  lineText?: string;
}

function parseFailure(src: string): ParseFailure | null {
  try {
    transpiler.transformSync(src);
    return null;
  } catch (e) {
    const err = e as { message?: string; position?: { line?: number; column?: number; lineText?: string } };
    return {
      message: err.message ?? String(e),
      line: err.position?.line,
      column: err.position?.column,
      lineText: err.position?.lineText,
    };
  }
}

for (const page of PAGES) {
  const scripts = inlineScripts(page.html);
  if (scripts.length === 0) {
    console.log(`  ${page.name}: no inline script`);
    continue;
  }
  for (const [i, src] of scripts.entries()) {
    checked++;
    const fail = parseFailure(src);
    if (!fail) continue;
    failures++;
    console.log(`  ✗ ${page.name} script#${i + 1}: ${fail.message}`);
    if (fail.line !== undefined) {
      console.log(`     ↳ line ${fail.line}, column ${fail.column}: ${fail.lineText?.trim().slice(0, 140)}`);
      if (fail.column !== undefined && fail.lineText) {
        console.log(`       ${" ".repeat(Math.max(0, fail.column - fail.lineText.length + fail.lineText.trimStart().length))}^`);
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
