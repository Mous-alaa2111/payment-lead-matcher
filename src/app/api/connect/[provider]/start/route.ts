import { NextRequest, NextResponse } from "next/server";
import { canManage, getMembership, getSession, isUuid } from "@/lib/access";
import { issueState } from "@/lib/connect/oauth-state";
import { squareAuthorizeUrl, squareConfigured } from "@/lib/connect/square";
import { stripeAuthorizeUrl, stripeConfigured } from "@/lib/connect/stripe";
import { appUrl } from "@/lib/url";

// POST (from the Connect button's <form>) so it can't be triggered by a
// cross-site link; the session cookie is SameSite=Lax.
export async function POST(req: NextRequest, ctx: RouteContext<"/api/connect/[provider]/start">) {
  const { provider } = await ctx.params;
  if (provider !== "stripe" && provider !== "square") {
    return new NextResponse("Unknown provider", { status: 404 });
  }

  const session = await getSession();
  if (!session) return NextResponse.redirect(appUrl("/sign-in"), 303);

  const clientId = String((await req.formData()).get("clientId") ?? "");
  if (!isUuid(clientId)) return new NextResponse("Bad request", { status: 400 });

  const membership = await getMembership(session.user.id, clientId);
  if (!membership || !canManage(membership.role)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const configured = provider === "stripe" ? stripeConfigured() : squareConfigured();
  if (!configured) {
    return NextResponse.redirect(appUrl(`/dashboard/clients/${clientId}?error=${provider}_not_configured`), 303);
  }

  const res = NextResponse.redirect(appUrl("/"), 303); // location replaced below
  const state = issueState(res, provider, clientId, session.user.id);
  const target =
    provider === "stripe" ? stripeAuthorizeUrl(state, session.user.email) : squareAuthorizeUrl(state);
  res.headers.set("Location", target);
  return res;
}
