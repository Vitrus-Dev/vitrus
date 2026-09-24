// packages/core/src/geo.ts
// Country detection — WITHOUT a GeoIP database.
//
// DECISION: we do not bundle a MaxMind/DB-IP style database. A
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

/**
 * Where a visitor was, as precisely as the proxy in front of us was willing to
 * say — and no more precisely than we are willing to store.
 *
 * Country is the only field every proxy gives. City, subdivision and
 * coordinates come from a smaller set, and on Cloudflare only after the
 * operator turns on the "Add visitor location headers" managed transform
 * (Rules → Settings → Managed Transforms). Absent is the normal case, and an
 * absent field stays "" / null — never 0, which is a real place in the Gulf of
 * Guinea.
 *
 * Still no GeoIP database (see the top of this file). The proxy has already
 * done the lookup; we only read its answer.
 */
export interface Geo {
  /** ISO-3166 alpha-2, or "". */
  country: string;
  /**
   * ISO-3166-2 subdivision code WITH the country prefix ("US-TX", "TR-34"), or
   * "". Proxies send only the suffix; prefixing it here makes the value join
   * directly against Natural Earth's `iso_3166_2` (see scripts/build-admin1.ts).
   */
  region: string;
  /** Subdivision name as the proxy spelled it ("Texas", "Istanbul"), or "". */
  regionName: string;
  city: string;
  /**
   * Latitude/longitude ROUNDED TO 0.1° (~11 km), or null.
   *
   * Two reasons, and both are the point. Privacy: a proxy's coordinate is
   * already a city centroid, and storing it at full precision would make every
   * row a little more identifying for no analytical gain. Honesty: IP
   * geolocation is routinely tens of kilometres off; a coordinate with six
   * decimals claims a precision the measurement does not have. One decimal is
   * "which city", which is what the number actually knows.
   */
  lat: number | null;
  lon: number | null;
}

export const EMPTY_GEO: Readonly<Geo> = Object.freeze({
  country: "",
  region: "",
  regionName: "",
  city: "",
  lat: null,
  lon: null,
});

/**
 * One proxy's header names. The fields of a location must come from the SAME
 * provider: a Cloudflare city stitched onto a Vercel country is a place that
 * does not exist.
 */
export interface GeoProvider {
  country: string;
  region?: string;
  regionName?: string;
  city?: string;
  lat?: string;
  lon?: string;
  /** Vercel URL-encodes its city ("S%C3%A3o%20Paulo"). */
  urlEncoded?: boolean;
}

/** Checked against each provider's documentation, 2026-09-24. */
export const GEO_PROVIDERS: readonly GeoProvider[] = [
  {
    // Cloudflare. cf-ipcountry is on by default; the other five need the
    // managed transform "Add visitor location headers". cf-region-code is the
    // ISO 3166-2 suffix ("TX").
    country: "cf-ipcountry",
    region: "cf-region-code",
    regionName: "cf-region",
    city: "cf-ipcity",
    lat: "cf-iplatitude",
    lon: "cf-iplongitude",
  },
  {
    // Vercel. x-vercel-ip-country-region is the ISO 3166-2 suffix; no name.
    country: "x-vercel-ip-country",
    region: "x-vercel-ip-country-region",
    city: "x-vercel-ip-city",
    lat: "x-vercel-ip-latitude",
    lon: "x-vercel-ip-longitude",
    urlEncoded: true,
  },
  {
    // AWS CloudFront, when the origin request policy forwards these.
    country: "cloudfront-viewer-country",
    region: "cloudfront-viewer-country-region",
    regionName: "cloudfront-viewer-country-region-name",
    city: "cloudfront-viewer-city",
    lat: "cloudfront-viewer-latitude",
    lon: "cloudfront-viewer-longitude",
  },
  // Country only: these document no city-level header.
  { country: "fly-client-ip-country" },
  { country: "x-nf-client-connection-country" },
  { country: "x-country-code" },
  { country: "x-geo-country" },
];

/**
 * Header values are bytes. Cloudflare sends non-ASCII as UTF-8, but the Fetch
 * `Headers` object can hand them back decoded as Latin-1 — "Zürich" arrives as
 * "ZÃ¼rich". Re-decode when the string is plausibly UTF-8-read-as-Latin-1, and
 * keep the original when it is not.
 */
function fixUtf8(s: string): string {
  if (!/[\u0080-ÿ]/.test(s) || /[^\u0000-ÿ]/.test(s)) return s;
  try {
    const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return s;
  }
}

/** A free-text header value, cleaned and length-capped. "" when absent. */
function textHeader(headers: Headers, name: string | undefined, urlEncoded = false): string {
  if (!name) return "";
  const raw = headers.get(name);
  if (!raw) return "";
  let v = raw.trim();
  if (urlEncoded) {
    try {
      v = decodeURIComponent(v);
    } catch {
      /* keep as sent */
    }
  }
  return fixUtf8(v).replace(/[\u0000-\u001f\u007f<>]/g, "").slice(0, 80);
}

/** Round to 0.1° — see `Geo.lat` for why this is a decision, not a detail. */
export function roundCoord(n: number): number {
  return Math.round(n * 10) / 10;
}

function coordHeader(headers: Headers, name: string | undefined, limit: number): number | null {
  if (!name) return null;
  const raw = headers.get(name);
  if (!raw || !raw.trim()) return null;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || Math.abs(n) > limit) return null;
  return roundCoord(n);
}

/**
 * Everything a proxy told us about location, from ONE provider.
 *
 * The first provider with a valid country wins, and every other field is read
 * from that provider only. Coordinates are kept only as a pair, and exactly
 * (0, 0) is refused: that is what a failed lookup looks like, not a visitor
 * floating off the coast of Ghana.
 */
export function geoFromHeaders(headers: Headers): Geo {
  for (const p of GEO_PROVIDERS) {
    const raw = headers.get(p.country);
    if (!raw) continue;
    const country = raw.trim().toUpperCase().slice(0, 2);
    if (!/^[A-Z]{2}$/.test(country) || NOT_A_COUNTRY.has(country)) continue;

    const suffix = textHeader(headers, p.region).toUpperCase();
    const region = /^[A-Z0-9]{1,3}$/.test(suffix) ? `${country}-${suffix}` : "";
    let lat = coordHeader(headers, p.lat, 90);
    let lon = coordHeader(headers, p.lon, 180);
    if (lat === null || lon === null || (lat === 0 && lon === 0)) {
      lat = null;
      lon = null;
    }
    return {
      country,
      region,
      regionName: textHeader(headers, p.regionName),
      city: textHeader(headers, p.city, p.urlEncoded),
      lat,
      lon,
    };
  }
  return { ...EMPTY_GEO };
}
