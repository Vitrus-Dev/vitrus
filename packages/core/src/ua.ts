// packages/core/src/ua.ts
// Minimal UA parsing. Deliberately library-free and coarse: device/OS/browser
// are only ever used as BUCKETS ("did it drop on mobile?"), never as a
// fingerprint. Anything unrecognised becomes "unknown" — better than writing
// down an invented name.

export interface UaVerdict {
  device: "desktop" | "mobile" | "tablet" | "unknown";
  os: string;
  browser: string;
}

export function parseUa(userAgent: string): UaVerdict {
  const ua = (userAgent || "").toLowerCase();
  if (!ua) return { device: "unknown", os: "unknown", browser: "unknown" };

  const os = ua.includes("windows")
    ? "Windows"
    : ua.includes("android")
      ? "Android"
      : ua.includes("iphone") || ua.includes("ipad") || ua.includes("ipod")
        ? "iOS"
        : ua.includes("mac os x") || ua.includes("macintosh")
          ? "macOS"
          : ua.includes("cros")
            ? "ChromeOS"
            : ua.includes("linux")
              ? "Linux"
              : "unknown";

  // Order matters: Edge/Opera/Brave all announce themselves as Chrome.
  const browser = ua.includes("edg/")
    ? "Edge"
    : ua.includes("opr/") || ua.includes("opera")
      ? "Opera"
      : ua.includes("samsungbrowser")
        ? "Samsung Internet"
        : ua.includes("firefox") || ua.includes("fxios")
          ? "Firefox"
          : ua.includes("crios")
            ? "Chrome"
            : ua.includes("chrome")
              ? "Chrome"
              : ua.includes("safari")
                ? "Safari"
                : "unknown";

  const tablet = ua.includes("ipad") || (ua.includes("android") && !ua.includes("mobile"));
  const mobile = ua.includes("iphone") || ua.includes("ipod") || ua.includes("mobile") || ua.includes("android");
  const device: UaVerdict["device"] = tablet ? "tablet" : mobile ? "mobile" : os === "unknown" ? "unknown" : "desktop";

  return { device, os, browser };
}
