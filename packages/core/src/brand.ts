// packages/core/src/brand.ts
// The Vitrus icon (a glass cube with an amber spark inside), shared by every
// page that shows a browser tab: the marketing site, the hosted dashboard and
// the self-hosted dashboard. Inline, so no page needs an extra request for it.

/** Square icon (favicon and header). Carries its own dark background so it also works on a light theme. */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="34" height="34" role="img" aria-label="Vitrus">
  <defs>
    <linearGradient id="vbg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0e1124"/><stop offset="1" stop-color="#07080f"/></linearGradient>
    <linearGradient id="vedge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a5b4fc"/><stop offset="1" stop-color="#c084fc"/></linearGradient>
    <radialGradient id="vamber" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffe9a8"/><stop offset="0.45" stop-color="#f5a623"/><stop offset="1" stop-color="#f5a623" stop-opacity="0"/></radialGradient>
    <radialGradient id="vhalo" cx="0.5" cy="0.45" r="0.55"><stop offset="0" stop-color="#818cf8" stop-opacity="0.38"/><stop offset="1" stop-color="#818cf8" stop-opacity="0"/></radialGradient>
  </defs>
  <rect x="1" y="1" width="62" height="62" rx="15" fill="url(#vbg)" stroke="rgba(255,255,255,0.10)"/>
  <circle cx="32" cy="30" r="23" fill="url(#vhalo)"/>
  <path d="M32 11 L51 21.5 L51 42.5 L32 53 L13 42.5 L13 21.5 Z" fill="none" stroke="url(#vedge)" stroke-width="3.2" stroke-linejoin="round"/>
  <path d="M32 32 L32 11 M32 32 L13 42.5 M32 32 L51 42.5" fill="none" stroke="#8ea2e8" stroke-width="1.7" stroke-linejoin="round" opacity="0.65"/>
  <circle cx="32" cy="32" r="9.5" fill="url(#vamber)"/>
  <path d="M32 25 L33.9 30.1 L39 32 L33.9 33.9 L32 39 L30.1 33.9 L25 32 L30.1 30.1 Z" fill="#ffd873" stroke="#fff1c9" stroke-width="0.5"/>
</svg>`;

/** The data URI embedded as the favicon. */
export const FAVICON_DATA_URI = `data:image/svg+xml,${encodeURIComponent(
  ICON_SVG.replace(/width="34" height="34"/, 'width="64" height="64"')
)}`;
