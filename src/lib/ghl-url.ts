// The one place every GHL call gets its base URL from.
//
// GHL_API_URL may point at a local mock (the e2e suite's, scripts/e2e.ts) and is
// accepted only for localhost, so a stray setting can't send tokens elsewhere.
// When E2E_NO_REAL_GHL=1 (set by scripts/e2e-db.ts for anything running against
// the e2e branch) a missing or non-local override throws instead of falling back
// to real GHL: tests can never reach it.

export const REAL_GHL_URL = "https://services.leadconnectorhq.com";

const isLocal = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  } catch {
    return false;
  }
};

export function ghlBaseUrl() {
  const override = process.env.GHL_API_URL?.trim();
  if (override && !isLocal(override)) throw new Error("GHL_API_URL must be a http://localhost URL (test mock only)");
  if (process.env.E2E_NO_REAL_GHL === "1" && !override) {
    throw new Error("e2e run without GHL_API_URL: refusing to call real GHL");
  }
  return override || REAL_GHL_URL;
}
