// End-to-end checks for invite-only sign-up, client permissions and the OAuth
// start/callback flow. Needs the app running on :3000 with fake Stripe creds:
//   $env:STRIPE_CONNECT_CLIENT_ID="ca_e2e_fake"; $env:STRIPE_SECRET_KEY="sk_test_e2e_fake"; npm run build; npm start
//   npm run test:e2e
// Leave Square unconfigured. All test rows are deleted at the end.
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

const BASE = "http://localhost:3000";
const tag = `e2e${Date.now()}`;
let failures = 0;
let rateLimited = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
};

class Jar {
  cookies = new Map<string, string>();
  async fetch(path: string, init: RequestInit = {}) {
    const res = await fetch(BASE + path, {
      ...init,
      redirect: "manual",
      headers: {
        Origin: BASE,
        ...(init.headers as Record<string, string>),
        Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, v] = pair.split("=");
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || v === "") this.cookies.delete(k);
      else this.cookies.set(k, pair.slice(k.length + 1));
    }
    return res;
  }
  async signUp(email: string, token?: string): Promise<Response> {
    const res = await this.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { "x-invite-token": token } : {}) },
      body: JSON.stringify({ email, password: "correct-horse-99", name: "E2E" }),
    });
    if (res.status !== 429) return res;
    rateLimited++;
    await new Promise((r) => setTimeout(r, 11_000)); // Better Auth sign-up rate limit window
    return this.signUp(email, token);
  }
  post(path: string, fields: Record<string, string>) {
    return this.fetch(path, { method: "POST", body: new URLSearchParams(fields) });
  }
}

async function main() {
  const { eq, like, inArray } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { clients, clientMembers, invitations, user } = await import("../src/db/schema");
  const { createInvitation, findPendingInvitation, revokeInvitation } = await import("../src/lib/invitations");

  const [client] = await db.insert(clients).values({ name: `E2E ${tag}`, slug: tag }).returning();
  const ownerEmail = `${tag}-owner@example.com`;
  const viewerEmail = `${tag}-viewer@example.com`;
  const tokenOf = (url: string) => url.split("/invite/")[1];

  try {
    // --- invite-only sign-up ---
    const anon = new Jar();
    let r = await anon.signUp(`${tag}-rando@example.com`);
    check("public sign-up without invite is rejected", r.status === 403, `status ${r.status}`);

    const ownerInvite = await createInvitation({ email: ownerEmail, clientId: client.id, role: "owner", invitedBy: null });
    r = await anon.signUp(`${tag}-other@example.com`, tokenOf(ownerInvite.url));
    check("invite token used with a different email is rejected", r.status === 403, `status ${r.status}`);

    r = await anon.signUp(ownerEmail, "not-a-real-token");
    check("bogus invite token is rejected", r.status === 403, `status ${r.status}`);

    const invitePage = await anon.fetch(`/invite/${tokenOf(ownerInvite.url)}`);
    check("invite page renders sign-up form", invitePage.status === 200 && (await invitePage.text()).includes("Create your account"));

    const owner = new Jar();
    r = await owner.signUp(ownerEmail, tokenOf(ownerInvite.url));
    check("sign-up with valid invite succeeds", r.status === 200, `status ${r.status}`);

    const [ownerRow] = await db.select().from(user).where(eq(user.email, ownerEmail));
    const [membership] = await db.select().from(clientMembers).where(eq(clientMembers.userId, ownerRow.id));
    check("invite created owner membership", membership?.role === "owner" && membership.clientId === client.id);
    const [inv] = await db.select().from(invitations).where(eq(invitations.id, ownerInvite.invite.id));
    check("invite marked accepted", Boolean(inv.acceptedAt) && inv.acceptedBy === ownerRow.id);

    r = await new Jar().signUp(`${tag}-reuse@example.com`, tokenOf(ownerInvite.url));
    check("used invite can't be reused", r.status === 403, `status ${r.status}`);
    const usedPage = await anon.fetch(`/invite/${tokenOf(ownerInvite.url)}`);
    check("used invite page says invalid", (await usedPage.text()).includes("Invite not valid"));

    // --- client page + permissions ---
    r = await owner.fetch(`/dashboard/clients/${client.id}`);
    const html = await r.text();
    check("owner sees client page with Connect buttons", r.status === 200 && html.includes('action="/api/connect/stripe/start"') && html.includes('action="/api/connect/square/start"'));

    const viewerInvite = await createInvitation({ email: viewerEmail, clientId: client.id, role: "viewer", invitedBy: ownerRow.id });
    const viewer = new Jar();
    await viewer.signUp(viewerEmail, tokenOf(viewerInvite.url));
    r = await viewer.fetch(`/dashboard/clients/${client.id}`);
    const vhtml = await r.text();
    check("viewer sees client page without Connect buttons", r.status === 200 && !vhtml.includes("/api/connect/") && vhtml.includes("Not connected"));
    r = await viewer.post("/api/connect/stripe/start", { clientId: client.id });
    check("viewer cannot start OAuth", r.status === 403, `status ${r.status}`);

    // --- revoking pending invites ---
    const adminEmail = `${tag}-admin@example.com`;
    const adminInvite = await createInvitation({ email: adminEmail, clientId: client.id, role: "admin", invitedBy: ownerRow.id });
    const admin = new Jar();
    await admin.signUp(adminEmail, tokenOf(adminInvite.url));
    const pendingOwner = await createInvitation({ email: `${tag}-pending-owner@example.com`, clientId: client.id, role: "owner", invitedBy: ownerRow.id });
    const pendingViewer = await createInvitation({ email: `${tag}-pending-viewer@example.com`, clientId: client.id, role: "viewer", invitedBy: ownerRow.id });
    const revokeButtons = async (jar: Jar) => {
      const page = await (await jar.fetch(`/dashboard/clients/${client.id}`)).text();
      return {
        count: page.match(/>Revoke</g)?.length ?? 0,
        listsPending: page.includes(`${tag}-pending-owner@example.com`) && page.includes(`${tag}-pending-viewer@example.com`),
      };
    };
    let b = await revokeButtons(owner);
    check("owner sees Revoke on both pending invites", b.listsPending && b.count === 2, `count ${b.count}`);
    b = await revokeButtons(admin);
    check("admin sees Revoke only on the non-owner invite", b.listsPending && b.count === 1, `count ${b.count}`);
    b = await revokeButtons(viewer);
    check("viewer sees no pending invites and no Revoke", !b.listsPending && b.count === 0, `count ${b.count}`);

    const revoke = (inviteId: string, actorRole: "owner" | "admin" | "viewer", clientId = client.id) =>
      revokeInvitation({ inviteId, clientId, actorRole });
    check("viewer cannot revoke", (await revoke(pendingViewer.invite.id, "viewer")) === "forbidden");
    check("admin cannot revoke an owner invite", (await revoke(pendingOwner.invite.id, "admin")) === "forbidden");
    check("owner invite still valid after refused revoke", Boolean(await findPendingInvitation(tokenOf(pendingOwner.url))));
    check("admin can revoke a viewer invite", (await revoke(pendingViewer.invite.id, "admin")) === "revoked");
    check("revoked invite link no longer works", (await findPendingInvitation(tokenOf(pendingViewer.url))) === null);
    r = await new Jar().signUp(`${tag}-pending-viewer@example.com`, tokenOf(pendingViewer.url));
    check("revoked invite can't be used to sign up", r.status === 403, `status ${r.status}`);
    check("revoke with the wrong client id is not_found", (await revoke(pendingOwner.invite.id, "owner", crypto.randomUUID())) === "not_found");
    check("accepted invites can't be revoked", (await revoke(adminInvite.invite.id, "owner")) === "not_found");
    check("owner can revoke an owner invite", (await revoke(pendingOwner.invite.id, "owner")) === "revoked");
    b = await revokeButtons(owner);
    check("revoked invites disappear from the Team list", b.count === 0 && !b.listsPending);

    r = await anon.post("/api/connect/stripe/start", { clientId: client.id });
    check("signed-out user cannot start OAuth", r.status === 303 && r.headers.get("location")!.endsWith("/sign-in"));

    const outsider = await db.insert(clients).values({ name: `E2E other ${tag}`, slug: `${tag}-other` }).returning();
    r = await owner.post("/api/connect/stripe/start", { clientId: outsider[0].id });
    check("owner of A cannot connect client B", r.status === 403, `status ${r.status}`);
    r = await owner.fetch(`/dashboard/clients/${outsider[0].id}`);
    check("owner of A gets 404 on client B page", r.status === 404, `status ${r.status}`);
    await db.delete(clients).where(eq(clients.id, outsider[0].id));

    // --- OAuth start/callback (Square unconfigured, Stripe with fake creds) ---
    r = await owner.post("/api/connect/square/start", { clientId: client.id });
    check("unconfigured Square redirects with not_configured", (r.headers.get("location") ?? "").includes("error=square_not_configured"));

    r = await owner.post("/api/connect/stripe/start", { clientId: client.id });
    const loc = new URL(r.headers.get("location") ?? "http://x");
    check(
      "Stripe start redirects to connect.stripe.com with state + redirect_uri",
      r.status === 303 &&
        loc.origin === "https://connect.stripe.com" &&
        Boolean(loc.searchParams.get("state")) &&
        loc.searchParams.get("redirect_uri") === `${BASE}/api/connect/stripe/callback`,
      loc.toString().slice(0, 90),
    );
    check("state cookie set", owner.cookies.has("oauth_stripe"));

    r = await owner.fetch(`/api/connect/stripe/callback?code=ac_fake&state=wrong`);
    check("callback with wrong state rejected", (r.headers.get("location") ?? "").includes("error=invalid_state"));

    await owner.post("/api/connect/stripe/start", { clientId: client.id });
    const fresh = owner.cookies.get("oauth_stripe")!;
    const freshState = JSON.parse(decodeURIComponent(fresh)).state;
    r = await viewer.fetch(`/api/connect/stripe/callback?code=ac_fake&state=${freshState}`);
    check("callback without the matching cookie (other user) rejected", (r.headers.get("location") ?? "").includes("error=invalid_state"));

    r = await owner.fetch(`/api/connect/stripe/callback?error=access_denied&state=${freshState}`);
    check("user cancelling on Stripe returns cancelled", (r.headers.get("location") ?? "").includes("cancelled=1"));

    await owner.post("/api/connect/stripe/start", { clientId: client.id });
    const s3 = JSON.parse(decodeURIComponent(owner.cookies.get("oauth_stripe")!)).state;
    r = await owner.fetch(`/api/connect/stripe/callback?code=ac_fake&state=${s3}`);
    check("fake code -> exchange fails cleanly (no crash)", (r.headers.get("location") ?? "").includes("error=stripe_exchange_failed"));
    r = await owner.fetch(`/api/connect/stripe/callback?code=ac_fake&state=${s3}`);
    check("state is single-use", (r.headers.get("location") ?? "").includes("error=invalid_state"));
  } finally {
    await db.delete(user).where(like(user.email, `${tag}-%`));
    await db.delete(invitations).where(like(invitations.email, `${tag}-%`));
    await db.delete(clients).where(inArray(clients.slug, [tag, `${tag}-other`]));
  }

  // Encryption round trip
  const { encrypt, decrypt } = await import("../src/lib/crypto");
  const ct = encrypt("EAAA-square-token");
  check("token encryption round-trips and isn't plaintext", decrypt(ct) === "EAAA-square-token" && !ct.includes("EAAA"));

  console.log(`(sign-up rate limit hit ${rateLimited}x and waited out)`);
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
