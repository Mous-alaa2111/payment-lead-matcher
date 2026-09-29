import { timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { randomToken } from "@/lib/crypto";

// CSRF protection for the OAuth round trip: a random `state` goes to the
// provider and into an httpOnly cookie; the callback must present both.
// clientId/userId ride along in the cookie but are re-authorized on callback.

type Provider = "stripe" | "square";
type StatePayload = { state: string; clientId: string; userId: string };

const cookieName = (provider: Provider) => `oauth_${provider}`;

export function issueState(res: NextResponse, provider: Provider, clientId: string, userId: string) {
  const state = randomToken();
  res.cookies.set(cookieName(provider), JSON.stringify({ state, clientId, userId }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax", // must survive the top-level redirect back from the provider
    path: `/api/connect/${provider}`,
    maxAge: 10 * 60,
  });
  return state;
}

export function consumeState(req: NextRequest, res: NextResponse, provider: Provider): StatePayload | null {
  const raw = req.cookies.get(cookieName(provider))?.value;
  res.cookies.delete({ name: cookieName(provider), path: `/api/connect/${provider}` });
  const returned = req.nextUrl.searchParams.get("state");
  if (!raw || !returned) return null;
  try {
    const payload = JSON.parse(raw) as StatePayload;
    const a = Buffer.from(payload.state);
    const b = Buffer.from(returned);
    return a.length === b.length && timingSafeEqual(a, b) ? payload : null;
  } catch {
    return null;
  }
}
