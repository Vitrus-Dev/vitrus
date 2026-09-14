// packages/core/src/geo.ts
// Country detection — WITHOUT a GeoIP database.
//
// DECISION (PIVOT2.md): we do not bundle a MaxMind/DB-IP style database. A
// 60+ MB file, a monthly update burden and (with MaxMind) a mandatory account
// and licence key each break the "one-command install, zero dependencies"
// promise on their own.
//
// Instead we read the header the proxy in front of us has ALREADY computed.
// Cloudflare, Vercel, Fly, AWS CloudFront and Netlify all provide it for free.
// With no proxy the country stays empty and the dashboard says so PLAINLY —
// "unknown" is better than guessing from the IP and showing the wrong country.

/** Tried in order; the first present, valid value wins. */
export const COUNTRY_HEADERS = [
  "cf-ipcountry", // Cloudflare
  "x-vercel-ip-country", // Vercel
  "fly-client-ip-country", // Fly.io
  "cloudfront-viewer-country", // AWS CloudFront
  "x-nf-client-connection-country", // Netlify
  "x-country-code", // generic/custom nginx
  "x-geo-country",
] as const;

/** Values proxies use to mean "unknown". These must not be mistaken for a country. */
const NOT_A_COUNTRY = new Set(["XX", "T1", "ZZ", "A1", "A2", "O1", "EU", "AP"]);

/**
 * ISO-3166 alpha-2 country code from the headers. "" when none is found.
 * `EU` is a continent code, not a country; `T1` means a Tor exit and `XX` means unknown.
 */
export function countryFromHeaders(headers: Headers): string {
  for (const name of COUNTRY_HEADERS) {
    const raw = headers.get(name);
    if (!raw) continue;
    const code = raw.trim().toUpperCase().slice(0, 2);
    if (!/^[A-Z]{2}$/.test(code)) continue;
    if (NOT_A_COUNTRY.has(code)) continue;
    return code;
  }
  return "";
}
