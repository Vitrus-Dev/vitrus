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

/**
 * The native SDKs' own user-agent: `Vitrus-iOS/1.0 (iPhone; iOS 18.0)`,
 * `Vitrus-Android/1.0 (Pixel 8; Android 14)`, `Vitrus-Dart/1.0 (iPad; iOS 17.4)`.
 * The model before the semicolon decides the device class, the OS after it.
 * The "browser" bucket becomes "<OS> app", so app traffic reads apart from web.
 */
const SDK_UA = /^vitrus-[a-z]+\/[\d.]+ \(([^;)]*);\s*([a-z]+)/;

export function parseUa(userAgent: string): UaVerdict {
  const ua = (userAgent || "").toLowerCase();
  if (!ua) return { device: "unknown", os: "unknown", browser: "unknown" };
  const sdk = SDK_UA.exec(ua);
  if (sdk) {
    const model = sdk[1] ?? "";
    const osWord = sdk[2] ?? "";
    const os = osWord === "ios" || osWord === "ipados" ? "iOS" : osWord === "android" ? "Android" : osWord === "macos" ? "macOS"
      : osWord === "windows" ? "Windows" : osWord === "linux" ? "Linux" : "unknown";
    const device: UaVerdict["device"] = /ipad|tablet|tab\b/.test(model) ? "tablet" : os === "iOS" || os === "Android" ? "mobile" : os === "unknown" ? "unknown" : "desktop";
    return { device, os, browser: os === "unknown" ? "App" : `${os} app` };
  }

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
