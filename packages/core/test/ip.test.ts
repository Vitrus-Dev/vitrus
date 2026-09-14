// packages/core/test/ip.test.ts
// IP normalisation — the stability of the visitor id depends on it.
// The core claim: when an IPv6 privacy extension rotates the address, the
// identity DOES NOT CHANGE.

import { describe, expect, test } from "bun:test";
import { ipv6Prefix64, normalizeIp } from "../src/ip.ts";
import { visitorId } from "../src/visitor.ts";

describe("normalizeIp", () => {
  test("IPv4 is left as-is", () => {
    expect(normalizeIp("176.234.224.62")).toBe("176.234.224.62");
  });

  test("IPv4-mapped IPv6 collapses to plain IPv4 — one client must not get two identities", () => {
    expect(normalizeIp("::ffff:176.234.224.62")).toBe("176.234.224.62");
    expect(normalizeIp("::FFFF:10.0.0.1")).toBe("10.0.0.1");
  });

  test("IPv6 is reduced to its /64 prefix", () => {
    expect(normalizeIp("2a02:e0:73f3:1300:6448:5021:112:af95")).toBe("2a02:e0:73f3:1300::/64");
  });

  test("a compressed IPv6 address expands correctly", () => {
    expect(ipv6Prefix64("2a02:e0::1")).toBe("2a02:e0:0:0::/64");
    expect(ipv6Prefix64("::1")).toBe("0:0:0:0::/64");
  });

  test("leading zeros are canonicalised — 00e0 and e0 are the same network", () => {
    expect(ipv6Prefix64("2a02:00e0:73f3:1300::1")).toBe(ipv6Prefix64("2a02:e0:73f3:1300::9999"));
  });

  test("the zone id and square brackets are dropped", () => {
    expect(ipv6Prefix64("[2a02:e0:73f3:1300::1]")).toBe("2a02:e0:73f3:1300::/64");
    expect(ipv6Prefix64("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  test("unparseable input is NOT invented — it comes back as-is", () => {
    expect(normalizeIp("bu:bir:ip:degil:::")).toBe("bu:bir:ip:degil:::");
    expect(normalizeIp("")).toBe("");
  });
});

describe("visitorId stability", () => {
  const base = { secret: "s", siteId: "demo", userAgent: "Chrome", now: Date.UTC(2026, 8, 13, 10) };

  test("when an IPv6 privacy extension rotates the address, the identity DOES NOT CHANGE", () => {
    // Same /64, different interface id — an RFC 4941 rotation.
    const sabah = visitorId({ ...base, ip: "2a02:e0:73f3:1300:6448:5021:112:af95" });
    const oglen = visitorId({ ...base, ip: "2a02:e0:73f3:1300:aaaa:bbbb:cccc:dddd" });
    expect(sabah).toBe(oglen);
  });

  test("a different /64 network is a different visitor", () => {
    const a = visitorId({ ...base, ip: "2a02:e0:73f3:1300::1" });
    const b = visitorId({ ...base, ip: "2a02:e0:73f3:1301::1" });
    expect(a).not.toBe(b);
  });

  test("IPv4 and its mapped form are the SAME visitor", () => {
    expect(visitorId({ ...base, ip: "1.2.3.4" })).toBe(visitorId({ ...base, ip: "::ffff:1.2.3.4" }));
  });
});
