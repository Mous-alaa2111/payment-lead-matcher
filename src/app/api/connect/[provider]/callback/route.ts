import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { paymentConnections } from "@/db/schema";
import { canManage, getMembership, getSession } from "@/lib/access";
import { encrypt } from "@/lib/crypto";
import { consumeState } from "@/lib/connect/oauth-state";
import { exchangeSquareCode } from "@/lib/connect/square";
import { exchangeStripeCode } from "@/lib/connect/stripe";
import { appUrl } from "@/lib/url";

export async function GET(req: NextRequest, ctx: RouteContext<"/api/connect/[provider]/callback">) {
  const { provider } = await ctx.params;
  if (provider !== "stripe" && provider !== "square") {
    return new NextResponse("Unknown provider", { status: 404 });
  }

  const res = NextResponse.redirect(appUrl("/dashboard"));
  const back = (clientId: string | null, query: string) => {
    res.headers.set("Location", appUrl(clientId ? `/dashboard/clients/${clientId}?${query}` : `/dashboard?${query}`));
    return res;
  };

  const state = consumeState(req, res, provider);
  if (!state) return back(null, "error=invalid_state");

  // Re-authorize: same signed-in user who started the flow, still allowed to manage this client.
  const session = await getSession();
  if (!session || session.user.id !== state.userId) return back(null, "error=session_mismatch");
  const membership = await getMembership(session.user.id, state.clientId);
  if (!membership || !canManage(membership.role)) return back(null, "error=forbidden");

  const params = req.nextUrl.searchParams;
  const providerError = params.get("error");
  if (providerError) {
    return back(state.clientId, providerError === "access_denied" ? "cancelled=1" : `error=${provider}_${providerError}`);
  }
  const code = params.get("code");
  if (!code) return back(state.clientId, "error=missing_code");

  try {
    const values =
      provider === "stripe"
        ? await exchangeStripeCode(code).then((r) => ({
            externalAccountId: r.accountId,
            livemode: r.livemode,
            scope: r.scope,
            accessTokenEnc: null,
            refreshTokenEnc: null,
            tokenExpiresAt: null,
          }))
        : await exchangeSquareCode(code).then((r) => ({
            externalAccountId: r.merchantId,
            livemode: r.livemode,
            scope: null,
            accessTokenEnc: encrypt(r.accessToken),
            refreshTokenEnc: r.refreshToken ? encrypt(r.refreshToken) : null,
            tokenExpiresAt: r.expiresAt,
          }));

    await db
      .insert(paymentConnections)
      .values({ clientId: state.clientId, provider, connectedBy: session.user.id, ...values })
      .onConflictDoUpdate({
        target: [paymentConnections.clientId, paymentConnections.provider],
        set: { connectedBy: session.user.id, updatedAt: new Date(), ...values },
      });
  } catch (err) {
    console.error(`[connect:${provider}] token exchange failed`, err);
    return back(state.clientId, `error=${provider}_exchange_failed`);
  }

  return back(state.clientId, `connected=${provider}`);
}
