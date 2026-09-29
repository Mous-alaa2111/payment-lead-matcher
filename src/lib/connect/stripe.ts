import { appUrl } from "@/lib/url";

// Stripe Connect OAuth (Standard accounts). After connecting we only keep
// stripe_user_id; API calls use STRIPE_SECRET_KEY + the Stripe-Account header.
// Docs: https://docs.stripe.com/connect/oauth-reference

const CONNECT_BASE = "https://connect.stripe.com";

export function stripeConfigured() {
  return Boolean(process.env.STRIPE_CONNECT_CLIENT_ID && process.env.STRIPE_SECRET_KEY);
}

export const stripeRedirectUri = () => appUrl("/api/connect/stripe/callback");

export function stripeAuthorizeUrl(state: string, prefillEmail?: string) {
  const url = new URL("/oauth/authorize", CONNECT_BASE);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", process.env.STRIPE_CONNECT_CLIENT_ID!);
  // read_only is only allowed for Stripe extensions; standard platforms must use read_write.
  url.searchParams.set("scope", "read_write");
  url.searchParams.set("redirect_uri", stripeRedirectUri());
  url.searchParams.set("state", state);
  if (prefillEmail) url.searchParams.set("stripe_user[email]", prefillEmail);
  return url.toString();
}

async function post(path: string, body: Record<string, string>) {
  const res = await fetch(new URL(path, CONNECT_BASE), {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.STRIPE_SECRET_KEY}:`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
    cache: "no-store",
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    throw new Error(`Stripe ${path} failed: ${json.error ?? res.status} ${json.error_description ?? ""}`.trim());
  }
  return json;
}

export async function exchangeStripeCode(code: string) {
  // Codes are single-use: consuming one twice revokes the connection, so never retry this.
  const json = await post("/oauth/token", { grant_type: "authorization_code", code });
  return {
    accountId: json.stripe_user_id as string,
    livemode: Boolean(json.livemode),
    scope: json.scope as string,
  };
}

export async function deauthorizeStripe(accountId: string) {
  await post("/oauth/deauthorize", {
    client_id: process.env.STRIPE_CONNECT_CLIENT_ID!,
    stripe_user_id: accountId,
  });
}
