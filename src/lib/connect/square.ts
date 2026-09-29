import { appUrl } from "@/lib/url";

// Square OAuth, code flow (confidential client). Access tokens last 30 days;
// code-flow refresh tokens don't expire. Both are stored encrypted.
// Docs: https://developer.squareup.com/docs/oauth-api/overview

const SQUARE_VERSION = "2025-01-23";

// Read-only: everything payment-to-lead matching needs, nothing more.
export const SQUARE_SCOPES = ["MERCHANT_PROFILE_READ", "PAYMENTS_READ", "CUSTOMERS_READ", "ORDERS_READ"];

const isSandbox = () => process.env.SQUARE_ENVIRONMENT !== "production";
const base = () => (isSandbox() ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com");

export function squareConfigured() {
  return Boolean(process.env.SQUARE_APPLICATION_ID && process.env.SQUARE_APPLICATION_SECRET);
}

export const squareRedirectUri = () => appUrl("/api/connect/square/callback");

export function squareAuthorizeUrl(state: string) {
  const url = new URL("/oauth2/authorize", base());
  url.searchParams.set("client_id", process.env.SQUARE_APPLICATION_ID!);
  url.searchParams.set("scope", SQUARE_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", squareRedirectUri());
  // Production: always show the sign-in screen so the right seller account is chosen.
  if (!isSandbox()) url.searchParams.set("session", "false");
  return url.toString();
}

async function post(path: string, body: object, auth?: string) {
  const res = await fetch(new URL(path, base()), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Square-Version": SQUARE_VERSION,
      ...(auth ? { Authorization: auth } : {}),
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const json = await res.json();
  if (!res.ok) {
    const detail = json.errors?.map((e: { code: string; detail?: string }) => e.detail ?? e.code).join("; ");
    throw new Error(`Square ${path} failed: ${res.status} ${detail ?? json.message ?? ""}`.trim());
  }
  return json;
}

export async function exchangeSquareCode(code: string) {
  const json = await post("/oauth2/token", {
    client_id: process.env.SQUARE_APPLICATION_ID,
    client_secret: process.env.SQUARE_APPLICATION_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: squareRedirectUri(),
  });
  const expiresAt = json.expires_at
    ? new Date(json.expires_at)
    : json.expires_in
      ? new Date(Date.now() + Number(json.expires_in) * 1000)
      : null;
  return {
    merchantId: json.merchant_id as string,
    accessToken: json.access_token as string,
    refreshToken: (json.refresh_token as string | undefined) ?? null,
    expiresAt,
    livemode: !isSandbox(),
  };
}

export async function revokeSquare(merchantId: string) {
  await post(
    "/oauth2/revoke",
    { client_id: process.env.SQUARE_APPLICATION_ID, merchant_id: merchantId },
    `Client ${process.env.SQUARE_APPLICATION_SECRET}`,
  );
}
