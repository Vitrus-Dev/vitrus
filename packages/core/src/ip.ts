// packages/core/src/ip.ts
// IP normalisation — so that the visitor id is STABLE.
//
// ═══ WHY THIS IS NEEDED ═══
// The visitor id is `hash(salt + day + site + ip + ua)`. Hash the raw IP and the
// same person gets counted several times within one day:
//
//  1. **IPv6 privacy extensions (RFC 4941/8981).** The device ROTATES the last
//     64 bits of its IPv6 address (the interface identifier) on a schedule —
//     several times a day on most operating systems. Hash the full address and
//     the same visitor gets a fresh id on every rotation, INFLATING the unique
//     visitor count. Fix: use only the /64 prefix (the network part), which is
//     stable for a subscriber line.
//
//  2. **Side benefit: less identifying.** A /64 prefix points at a network, not
//     at a single device. That pulls in the same direction as our privacy claim.
//
// ═══ WHAT THIS DOES NOT SOLVE ═══
// A dual-stack browser can reach the same site over IPv4 on one request and
// IPv6 on the next (happy eyeballs). Those two addresses have nothing in
// common; without cookies or persistent storage they cannot be joined. It is
// rare in practice (the OS caches its choice for the life of the connection)
// but it is not ZERO. We cannot invent our way around it — we know, and we say so.

/** The normalised IP that feeds the identity hash. */
export function normalizeIp(raw: string): string {
  const ip = (raw || "").trim();
  if (!ip) return "";

  // IPv4-mapped IPv6 (`::ffff:1.2.3.4`) → plain IPv4. The same client appearing
  // in two different notations depending on the proxy would mean two visitors.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];

  if (!ip.includes(":")) return ip; // IPv4: as-is

  return ipv6Prefix64(ip);
}

/**
 * Return the first 64 bits of an IPv6 address in canonical form
 * ("2a02:e0:73f3:1300::/64"). Zone ids (`%eth0`) and port brackets (`[...]`) are dropped.
 */
export function ipv6Prefix64(raw: string): string {
  let ip = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);

  const groups = expandIpv6(ip);
  if (!groups) return raw; // unparseable: use as-is rather than inventing something
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/** "2a02:e0::1" → 8 four-digit groups. null when invalid. */
function expandIpv6(ip: string): string[] | null {
  const halves = ip.split("::");
  if (halves.length > 2) return null;

  const parse = (part: string): string[] =>
    part === "" ? [] : part.split(":").filter((g) => g !== "");

  let head = parse(halves[0] ?? "");
  let tail = halves.length === 2 ? parse(halves[1] ?? "") : [];

  // The last group may be in IPv4 notation (`::ffff:192.0.2.1`) → expand to two groups.
  const expandTrailingV4 = (list: string[]): string[] | null => {
    const last = list[list.length - 1];
    if (!last || !last.includes(".")) return list;
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(last);
    if (!m) return null;
    const n = m.slice(1).map(Number);
    if (n.some((x) => x > 255)) return null;
    const hex = (a: number, b: number) => ((a << 8) | b).toString(16);
    return [...list.slice(0, -1), hex(n[0] as number, n[1] as number), hex(n[2] as number, n[3] as number)];
  };

  const h = expandTrailingV4(head);
  const t = expandTrailingV4(tail);
  if (!h || !t) return null;
  head = h;
  tail = t;

  const missing = 8 - (head.length + tail.length);
  if (halves.length === 2) {
    if (missing < 0) return null;
  } else if (missing !== 0) {
    return null;
  }

  const groups = [...head, ...Array(Math.max(0, missing)).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;

  // Strip leading zeros (canonical short form) — "00e0" and "e0" are the same network.
  return groups.map((g) => g.replace(/^0+(?=.)/, "").toLowerCase());
}
