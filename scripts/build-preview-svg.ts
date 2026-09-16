// scripts/build-preview-svg.ts
// Generates the dashboard preview image used in the README.
//
// Why generated rather than a screenshot:
//
//  - A screenshot goes stale the first time a label changes and nobody notices
//    for months. This is built from the same nav list the dashboard declares,
//    so a page added to the product without being added here is visible in the
//    diff.
//  - A screenshot of a dashboard full of numbers is a claim about traffic we do
//    not have. The image carries "illustration" inside the artwork, not in a
//    caption underneath that a re-screenshot would crop away.
//
// Run: bun run scripts/build-preview-svg.ts

const NAV = [
  ["Analytics", ["Overview", "AI traffic", "Behaviour", "Performance", "Errors", "Funnel", "Retention"]],
  ["Workspace", ["Digest", "Install", "Team", "Billing", "Support"]],
] as const;

const CARDS = [
  ["Unique visitors", "2,481", "+12.4%", true],
  ["Sessions", "3,104", "+9.1%", true],
  ["Pageviews", "7,922", "-2.0%", false],
  ["Bounce rate", "41.2%", "+1.1%", true],
] as const;

const CHANNELS = [
  ["AI assistants", "412"],
  ["Search", "1,208"],
  ["Direct", "846"],
  ["Social", "638"],
] as const;

const SQL = [
  "SELECT channel,",
  "       COUNT(DISTINCT session_id) AS sessions",
  "  FROM events",
  " WHERE site_id = ?",
  "   AND ts >= ? AND ts &lt; ?",
  "   AND bot_kind = ''",
  " GROUP BY channel",
];

const W = 920;
const H = 560;

function build(): string {
  const parts: string[] = [];
  const p = (s: string) => parts.push(s);

  p(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
     aria-label="Illustration of the Vitrus dashboard: an overview with metric cards, a trend chart, a channel breakdown and the SQL evidence panel open beside it.">
  <style>
    .f  { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .m  { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .dim { fill:#6f7c8a; } .fg { fill:#e9eef3; } .acc { fill:#5bc8af; } .warn { fill:#e0a458; }
  </style>
  <rect width="${W}" height="${H}" rx="12" fill="#0f1318"/>`);

  // — window chrome —
  p(`<rect x="0" y="0" width="${W}" height="34" rx="12" fill="#171c22"/>
     <rect x="0" y="22" width="${W}" height="12" fill="#171c22"/>
     <line x1="0" y1="34" x2="${W}" y2="34" stroke="#232a32"/>`);
  [16, 32, 48].forEach((x) => p(`<circle cx="${x}" cy="17" r="4.5" fill="#2c343d"/>`));
  p(`<text x="70" y="21" class="m dim" font-size="11">app.vitrus.dev/app</text>`);
  // The label is INSIDE the artwork: a caption underneath is cropped out the
  // moment somebody screenshots the screenshot.
  p(`<rect x="${W - 218}" y="8" width="204" height="19" rx="9.5" fill="#241c0c" stroke="#6b4f1c"/>
     <text x="${W - 116}" y="21" class="f" font-size="10" fill="#c99a3f" text-anchor="middle"
       letter-spacing="0.6">ILLUSTRATION · NOT A LIVE ACCOUNT</text>`);

  // — sidebar —
  const SB = 168;
  p(`<rect x="0" y="34" width="${SB}" height="${H - 34}" fill="#12161b"/>
     <line x1="${SB}" y1="34" x2="${SB}" y2="${H}" stroke="#232a32"/>
     <text x="18" y="64" class="f fg" font-size="15" font-weight="650">vitrus<tspan class="acc">.</tspan></text>`);

  let y = 92;
  for (const [group, items] of NAV) {
    p(`<text x="18" y="${y}" class="f dim" font-size="9" font-weight="700" letter-spacing="1.1">${group.toUpperCase()}</text>`);
    y += 15;
    for (const item of items) {
      const active = item === "Overview";
      if (active) p(`<rect x="10" y="${y - 12}" width="${SB - 20}" height="22" rx="6" fill="#1c222a"/>`);
      p(`<text x="18" y="${y + 3}" class="f ${active ? "fg" : "dim"}" font-size="12">${item}</text>`);
      y += 24;
    }
    y += 6;
  }

  // — top bar pills —
  const X = SB + 20;
  let bx = X;
  for (const label of ["Acme Retail", "acme.example", "Last 7 days"]) {
    const w = label.length * 6.2 + 18;
    p(`<rect x="${bx}" y="50" width="${w}" height="21" rx="6" fill="#12161b" stroke="#232a32"/>
       <text x="${bx + 9}" y="64" class="f dim" font-size="11">${label}</text>`);
    bx += w + 7;
  }
  p(`<circle cx="${W - 116}" cy="60" r="3.5" class="acc"/>
     <text x="${W - 106}" y="64" class="f acc" font-size="11">12 online now</text>`);

  // — metric cards —
  const cw = (W - X - 20 - 27) / 4;
  CARDS.forEach(([label, value, delta, up], i) => {
    const cx = X + i * (cw + 9);
    p(`<rect x="${cx}" y="84" width="${cw}" height="70" rx="9" fill="#12161b" stroke="#232a32"/>
       <text x="${cx + 13}" y="104" class="f dim" font-size="10">${label}</text>
       <text x="${cx + 13}" y="128" class="f fg" font-size="21" font-weight="600">${value}</text>
       <text x="${cx + 13}" y="144" class="f ${up ? "acc" : "warn"}" font-size="10.5">${up ? "▲" : "▼"} ${delta.replace(/^[+-]/, "")}</text>`);
  });

  // — trend chart —
  const CH_Y = 168;
  const CH_H = 150;
  const cwid = W - X - 20;
  p(`<rect x="${X}" y="${CH_Y}" width="${cwid}" height="${CH_H}" rx="9" fill="#12161b" stroke="#232a32"/>
     <text x="${X + 14}" y="${CH_Y + 21}" class="f dim" font-size="10" letter-spacing="0.9">TREND</text>
     <rect x="${X + cwid - 96}" y="${CH_Y + 10}" width="82" height="16" rx="8" fill="none" stroke="#2a323b"/>
     <text x="${X + cwid - 55}" y="${CH_Y + 21}" class="m dim" font-size="9" text-anchor="middle">e3 · evidence</text>`);
  for (let g = 1; g <= 3; g++) {
    const gy = CH_Y + 34 + (g * (CH_H - 48)) / 4;
    p(`<line x1="${X + 14}" y1="${gy}" x2="${X + cwid - 14}" y2="${gy}" stroke="#1e242c"/>`);
  }
  const pts = [0.44, 0.58, 0.51, 0.74, 0.66, 0.86, 0.79, 0.93, 0.9];
  const path = (scale: number, colour: string, dy: number) =>
    pts
      .map((v, i) => {
        const px = X + 16 + (i / (pts.length - 1)) * (cwid - 32);
        const py = CH_Y + CH_H - 18 - v * scale + dy;
        return `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`;
      })
      .join(" ");
  p(`<path d="${path(96, "", 0)}" fill="none" stroke="#7c8cf8" stroke-width="2" stroke-linejoin="round"/>`);
  p(`<path d="${path(70, "", 12)}" fill="none" stroke="#5bc8af" stroke-width="2" stroke-linejoin="round"/>`);

  // — channels + the evidence panel, side by side —
  const BY = CH_Y + CH_H + 12;
  const BH = H - BY - 16;
  const lw = (cwid - 10) * 0.4;
  p(`<rect x="${X}" y="${BY}" width="${lw}" height="${BH}" rx="9" fill="#12161b" stroke="#232a32"/>
     <text x="${X + 14}" y="${BY + 20}" class="f dim" font-size="10" letter-spacing="0.9">CHANNELS</text>`);
  CHANNELS.forEach(([name, n], i) => {
    const ry = BY + 42 + i * 22;
    p(`<text x="${X + 14}" y="${ry}" class="f dim" font-size="11.5">${name}</text>
       <text x="${X + lw - 14}" y="${ry}" class="f fg" font-size="11.5" text-anchor="end">${n}</text>
       ${i < CHANNELS.length - 1 ? `<line x1="${X + 14}" y1="${ry + 7}" x2="${X + lw - 14}" y2="${ry + 7}" stroke="#1a2028"/>` : ""}`);
  });

  const ex = X + lw + 10;
  const ew = cwid - lw - 10;
  p(`<rect x="${ex}" y="${BY}" width="${ew}" height="${BH}" rx="9" fill="#12161b" stroke="#2f6b5d"/>
     <text x="${ex + 14}" y="${BY + 20}" class="f" font-size="10" fill="#5bc8af" letter-spacing="0.9">e8 — THE QUERY THAT RAN</text>
     <rect x="${ex + 12}" y="${BY + 30}" width="${ew - 24}" height="${BH - 62}" rx="6" fill="#0b0e12" stroke="#1e242c"/>`);
  SQL.forEach((line, i) => {
    p(`<text x="${ex + 22}" y="${BY + 48 + i * 14}" class="m" font-size="10" fill="#b6c2ce">${line}</text>`);
  });
  p(`<text x="${ex + 14}" y="${BY + BH - 12}" class="f dim" font-size="10">Click any number and this is what opens.</text>`);

  p(`</svg>`);
  return parts.join("\n");
}

const out = new URL("../.github/assets/dashboard-preview.svg", import.meta.url).pathname;
await Bun.write(out, build());
console.log(`preview → ${out}`);
