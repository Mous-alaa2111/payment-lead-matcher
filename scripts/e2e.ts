// End-to-end checks for invite-only sign-up, client permissions and the OAuth
// start/callback flow. Runs against the Neon e2e branch (.env.test.local), never
// production. Start the app against the same branch, then run the suite:
//   npm run e2e:server      (builds + starts :3000 with fake Stripe creds, no Square)
//   npm run test:e2e
// All test rows are deleted at the end.
import { config } from "dotenv";
import { selectE2EDatabase } from "./e2e-db";
try {
  console.log(`Using e2e database (${selectE2EDatabase()})`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
config({ path: ".env.local", quiet: true }); // other vars only; DATABASE_URL is already set

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

// Runs syncSquare in this process with fetch faked for Square and GHL only
// (Neon and the local app still get real requests). Square pages are 2 long so
// cursor paging is exercised.
async function syncWindowChecks(clientId: string, owner: Jar, viewer: Jar) {
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { clients, clientMembers, paymentConnections, paymentMatches } = await import("../src/db/schema");
  const { encrypt } = await import("../src/lib/crypto");
  const { syncSquare } = await import("../src/lib/sync");
  const { parseRange, formatDay } = await import("../src/lib/sync/window");

  const DAY = 86_400_000;
  const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();
  const payments = [
    { id: "p1", created_at: ago(1), customer_id: "cust-a", amount_money: { amount: 1000, currency: "USD" } },
    { id: "p2", created_at: ago(10), customer_id: "cust-b", amount_money: { amount: 2000, currency: "USD" } },
    { id: "p3", created_at: ago(200), amount_money: { amount: 3000, currency: "USD" }, buyer_email_address: "x@example.com" },
    { id: "p4", created_at: ago(400), amount_money: { amount: 4000, currency: "USD" } },
    { id: "p5", created_at: ago(401), amount_money: { amount: 5000, currency: "USD" } },
  ];
  const customers: Record<string, object> = {
    "cust-a": { given_name: "Ann", phone_number: "+15550000001" },
    "cust-b": { given_name: "Bob", email_address: "bob@example.com" },
  };
  const ghl: object[] = [{ id: "g-ann", firstName: "Ann", phone: "(555) 000-0001" }];
  const paymentCalls: URL[] = [];

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const json = (b: object) => new Response(JSON.stringify(b), { status: 200 });
    if (url.hostname === "connect.squareupsandbox.com") {
      if (url.pathname === "/v2/locations") return json({ locations: [{ id: "L1", status: "ACTIVE" }] });
      if (url.pathname === "/v2/customers/bulk-retrieve") {
        const ids: string[] = JSON.parse(String(init?.body)).customer_ids;
        return json({ responses: Object.fromEntries(ids.map((id) => [id, { customer: customers[id] }])) });
      }
      paymentCalls.push(url);
      const begin = url.searchParams.get("begin_time")!;
      const end = url.searchParams.get("end_time")!;
      const inWindow = payments
        .filter((p) => p.created_at >= begin && p.created_at < end)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      const from = Number(url.searchParams.get("cursor") ?? 0);
      return json({ payments: inWindow.slice(from, from + 2), ...(from + 2 < inWindow.length ? { cursor: String(from + 2) } : {}) });
    }
    if (url.hostname === "services.leadconnectorhq.com") return json({ contacts: ghl, meta: {} });
    return realFetch(input, init);
  }) as typeof fetch;

  try {
    const [c] = await db
      .insert(clients)
      .values({ name: `E2E sync ${tag}`, slug: `${tag}-sync`, ghlLocationId: `${tag}-loc`, ghlTokenEnc: encrypt("fake-pit") })
      .returning();
    await db.insert(paymentConnections).values({
      clientId: c.id, provider: "square", externalAccountId: `${tag}-m2`, accessTokenEnc: encrypt("fake"), livemode: false,
    });
    const conn = async () => (await db.select().from(paymentConnections).where(eq(paymentConnections.clientId, c.id)))[0];
    const rows = async () => db.select().from(paymentMatches).where(eq(paymentMatches.clientId, c.id));
    const byId = async () => Object.fromEntries((await rows()).map((r) => [r.externalPaymentId, r]));

    // Backfill an old period first: pages through, doesn't touch synced_through.
    const range = parseRange(formatDay(new Date(Date.now() - 450 * DAY)), formatDay(new Date(Date.now() - 150 * DAY)));
    if ("error" in range) throw new Error(range.error);
    let s = await syncSquare(c.id, range);
    check("range sync fetches only payments in the range, across pages", s.payments === 3 && (await rows()).length === 3, `${s.payments} fetched`);
    check(
      "range sync passed begin/end to Square and followed the cursor",
      paymentCalls.length === 2 && paymentCalls.every((u) => u.searchParams.get("begin_time") === range.start.toISOString()),
    );
    check("range sync on a never-synced connection leaves synced_through unset", (await conn()).syncedThrough === null);

    // First plain sync: last 90 days.
    s = await syncSquare(c.id);
    let r = await byId();
    check("first plain sync pulls the last 90 days", s.window.kind === "latest" && s.payments === 2 && Object.keys(r).length === 5);
    check("phone match on the new payment, no match for the unknown payer", r.p1.status === "matched" && r.p1.method === "phone" && r.p2.status === "no_match");
    const through = (await conn()).syncedThrough;
    check("plain sync sets synced_through", Boolean(through) && Math.abs(through!.getTime() - Date.now()) < 60_000);

    // Bob becomes a lead in GHL. The next plain sync only refetches the last
    // ~7 days (p1), but p2 (10 days old) must still be re-matched.
    ghl.push({ id: "g-bob", firstName: "Bob", email: "BOB@example.com" });
    paymentCalls.length = 0;
    s = await syncSquare(c.id);
    r = await byId();
    check(
      "next plain sync starts 7 days before synced_through",
      s.payments === 1 && paymentCalls[0]?.searchParams.get("begin_time") === new Date(through!.getTime() - 7 * DAY).toISOString(),
    );
    check(
      "older payment re-matched after its lead appeared in GHL",
      s.rematched === 1 && r.p2.status === "matched" && r.p2.method === "email" && r.p2.contacts[0]?.id === "g-bob",
    );
    check("no duplicate rows after repeated syncs", (await rows()).length === 5);

    // Page: everyone gets the date filter; only managers get Sync range, and a bad range is rejected before any sync.
    const members = await db.select().from(clientMembers).where(eq(clientMembers.clientId, clientId));
    const idOf = (role: string) => members.find((m) => m.role === role)!.userId;
    await db.insert(clientMembers).values([
      { clientId: c.id, userId: idOf("owner"), role: "owner" },
      { clientId: c.id, userId: idOf("viewer"), role: "viewer" },
    ]);
    const ownerPage = (await (await owner.fetch(`/dashboard/clients/${c.id}`)).text()).replace(/<!-- -->/g, "");
    check(
      "owner sees the date-range form with Sync range and synced-through date",
      ownerPage.includes("Filter or sync a date range") && ownerPage.includes('name="from"') && ownerPage.includes("Sync range") && ownerPage.includes(`payments synced through ${formatDay(through!)}`),
    );
    const viewerPage = (await (await viewer.fetch(`/dashboard/clients/${c.id}`)).text()).replace(/<!-- -->/g, "");
    check(
      "viewer sees the date filter but not Sync range",
      viewerPage.includes("Filter by date range") && viewerPage.includes('name="from"') && viewerPage.includes("Show range") && !viewerPage.includes("Sync range"),
    );
    // Replay the Sync range button: it carries the bound Server Action (and client id) as hidden inputs.
    const unescape = (v: string) => v.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const syncButton = ownerPage.match(/<button[^>]*name="(\$ACTION_REF_[^"]+)"[^>]*>([\s\S]*?)Sync range<\/button>/)!;
    const syncRangeForm = (from: string, to: string) => {
      const fd = new FormData();
      fd.append(syncButton[1], "");
      for (const m of syncButton[2].matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) fd.append(m[1], unescape(m[2]));
      fd.set("from", from);
      fd.set("to", to);
      return fd;
    };
    const before = (await conn()).lastSyncedAt?.getTime();
    const res = await owner.fetch(`/dashboard/clients/${c.id}`, { method: "POST", body: syncRangeForm("2026-02-01", "2026-01-01") });
    const loc = res.headers.get("location") ?? "";
    check("reversed date range is rejected with a message", loc.includes("error=bad_range"), `${res.status} ${loc}`);
    const after = await conn();
    check("rejected range didn't run a sync", after.lastSyncedAt?.getTime() === before && !after.lastSyncError);
    const vres = await viewer.fetch(`/dashboard/clients/${c.id}`, { method: "POST", body: syncRangeForm("2026-01-01", "2026-01-02") });
    const afterViewer = await conn();
    check(
      "viewer replaying Sync range is refused",
      !(vres.headers.get("location") ?? "").includes("synced=") && afterViewer.lastSyncedAt?.getTime() === before && !afterViewer.lastSyncError,
      `status ${vres.status}`,
    );
    const filtered = (await (await viewer.fetch(`/dashboard/clients/${c.id}?from=2000-01-01&to=2000-01-02`)).text()).replace(/<!-- -->/g, "");
    check("viewer can filter by date (GET ?from&to)", filtered.includes("Showing payments from") && filtered.includes("No payments in this date range."));
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function main() {
  const { eq, like, inArray } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { agencyStaff, clients, clientMembers, invitations, paymentConnections, paymentMatches, user } = await import("../src/db/schema");
  const { createInvitation, findPendingInvitation, revokeInvitation } = await import("../src/lib/invitations");
  const { encrypt, decrypt } = await import("../src/lib/crypto");

  const [client] = await db.insert(clients).values({ name: `E2E ${tag}`, slug: tag }).returning();
  const ownerEmail = `${tag}-owner@example.com`;
  const viewerEmail = `${tag}-viewer@example.com`;
  const tokenOf = (url: string) => url.split("/invite/")[1];

  try {
    // The server must read the same database we write fixtures to, or its writes land elsewhere.
    const probe = await createInvitation({ email: `${tag}-probe@example.com`, clientId: client.id, role: "viewer", invitedBy: null });
    const probePage = await fetch(`${BASE}/invite/${tokenOf(probe.url)}`).catch(() => null);
    if (!probePage || !(await probePage.text()).includes("Create your account")) {
      console.error("App on :3000 isn't running against the e2e database. Start it with `npm run e2e:server`.");
      process.exitCode = 1;
      return;
    }
    await db.delete(invitations).where(eq(invitations.id, probe.invite.id));

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
    r = await owner.fetch("/dashboard");
    check("owner of A doesn't see client B on the dashboard", r.status === 200 && !(await r.text()).includes(`E2E other ${tag}`));
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

    // --- Payments table + sync (fake rows; never calls Square or GHL) ---
    r = await owner.fetch(`/dashboard/clients/${client.id}`);
    check("no connection -> payments placeholder", (await r.text()).includes("Connect a payment account to see payments here."));

    const { syncSquare } = await import("../src/lib/sync");
    await db.insert(paymentConnections).values({
      clientId: client.id, provider: "square", externalAccountId: `${tag}-merchant`,
      accessTokenEnc: encrypt("fake-square-token"), livemode: false,
    });
    const syncError = await syncSquare(client.id).then(() => null, (e: Error) => e.message);
    check("sync without GHL creds fails before calling any API", Boolean(syncError?.includes("no GHL location")), syncError ?? "");
    let page = await (await owner.fetch(`/dashboard/clients/${client.id}`)).text();
    check("sync failure is shown on the page", page.includes("Last sync failed:") && page.includes("no GHL location"));

    const contact = { id: "c1", name: "Pat Lead", email: null, phone: "+15550001111" };
    await db.insert(paymentMatches).values([
      { clientId: client.id, provider: "square", externalPaymentId: "p1", paidAt: new Date("2026-01-03"), amountCents: 12345, currency: "USD", payerName: "Pat Payer", payerPhone: "+15550001111", status: "matched", method: "phone", contacts: [contact] },
      { clientId: client.id, provider: "square", externalPaymentId: "p2", paidAt: new Date("2026-01-02"), amountCents: 500, currency: "USD", status: "ambiguous", method: "email", contacts: [contact, { ...contact, id: "c2" }] },
      { clientId: client.id, provider: "square", externalPaymentId: "p3", paidAt: new Date("2026-01-01"), amountCents: 700, currency: "USD", paymentStatus: "FAILED", status: "no_match" },
    ]);
    page = await (await owner.fetch(`/dashboard/clients/${client.id}`)).text();
    check(
      "owner sees payments table with counts and Sync now",
      page.replace(/<!-- -->/g, "").includes("1 matched, 1 ambiguous,") && page.includes("$123.45") && page.includes("Pat Lead") && page.includes(">Sync now<"),
    );
    check("newest payment listed first", page.indexOf("2026-01-03") < page.indexOf("2026-01-01"));
    page = await (await viewer.fetch(`/dashboard/clients/${client.id}`)).text();
    check("viewer sees payments but no Sync now", page.includes("$123.45") && !page.includes("Sync now"));

    // --- Payments pagination: 45 rows -> pages of 20, 20, 5; totals cover all rows ---
    await db.insert(paymentMatches).values(
      Array.from({ length: 42 }, (_, i) => ({
        clientId: client.id, provider: "square" as const, externalPaymentId: `older-${i}`,
        paidAt: new Date(Date.UTC(2025, 0, 1) - i * 86_400_000), amountCents: 100_000 + i * 100, currency: "USD",
        status: "no_match" as const,
      })),
    );
    const payPage = async (q = "") => {
      const html = (await (await owner.fetch(`/dashboard/clients/${client.id}${q}`)).text()).replace(/<!-- -->/g, "");
      return {
        html,
        rows: html.match(/<tr class="align-top"/g)?.length ?? 0,
        // Only the visible table; the page's embedded RSC payload repeats the same text.
        amounts: [...html.slice(html.indexOf("<tbody"), html.indexOf("</tbody>")).matchAll(/\$[\d,]+\.\d\d/g)].map((m) => m[0]),
      };
    };
    const p1 = await payPage();
    check("page 1 shows 20 rows", p1.rows === 20, `rows ${p1.rows}`);
    check("summary counts cover all 45 rows", p1.html.includes("45 payments: 1 matched, 1 ambiguous, 43 with no matching lead"));
    check("page 1: Previous disabled, Next links to page 2",
      p1.html.includes("Page 1 of 3") && /<span aria-disabled[^>]*>← Previous/.test(p1.html) && /<a [^>]*href="[^"]*\?page=2"[^>]*>Next →/.test(p1.html));
    const p2 = await payPage("?page=2");
    const p3 = await payPage("?page=3");
    check("page 3 shows the last 5 rows, Next disabled",
      p3.rows === 5 && p3.html.includes("Page 3 of 3") && /<span aria-disabled[^>]*>Next →/.test(p3.html));
    check("summary counts are the same on every page", p3.html.includes("45 payments: 1 matched, 1 ambiguous, 43 with no matching lead"));
    const all = [...p1.amounts, ...p2.amounts, ...p3.amounts];
    check("pages don't overlap or skip rows", all.length === 45 && new Set(all).size === 45, `${all.length} amounts, ${new Set(all).size} unique`);
    check("out-of-range page clamps to the last page", (await payPage("?page=99")).html.includes("Page 3 of 3"));
    check("junk page param falls back to page 1", (await payPage("?page=abc")).html.includes("Page 1 of 3"));

    // --- Agency staff: every client without per-client membership; agency-only actions ---
    // Replays a no-JS form submission (Server Action ids travel as hidden inputs).
    const unescapeHtml = (v: string) =>
      v.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const formFields = (html: string, marker: string) => {
      const form = html.split("<form").find((f) => f.split("</form>")[0].includes(marker));
      if (!form) throw new Error(`no form with ${marker}`);
      const fd = new FormData();
      for (const m of form.split("</form>")[0].matchAll(/<input([^>]*)>/g)) {
        const name = m[1].match(/name="([^"]+)"/)?.[1];
        if (name) fd.append(name, unescapeHtml(m[1].match(/value="([^"]*)"/)?.[1] ?? ""));
      }
      return fd;
    };
    const staffEmail = `${tag}-staff@example.com`;
    const staffInvite = await createInvitation({ email: staffEmail, clientId: null, role: "viewer", agencyStaff: true, invitedBy: null });
    const staffInvitePage = await (await anon.fetch(`/invite/${tokenOf(staffInvite.url)}`)).text();
    check("staff invite page names the agency team", staffInvitePage.includes("agency team"));
    const staff = new Jar();
    r = await staff.signUp(staffEmail, tokenOf(staffInvite.url));
    const [staffRow] = await db.select().from(user).where(eq(user.email, staffEmail));
    const staffRows = await db.select().from(agencyStaff).where(eq(agencyStaff.userId, staffRow.id));
    const staffMemberships = await db.select().from(clientMembers).where(eq(clientMembers.userId, staffRow.id));
    check("staff invite makes agency staff with no client memberships", r.status === 200 && staffRows.length === 1 && staffMemberships.length === 0);

    let dash = (await (await staff.fetch("/dashboard")).text()).replace(/<!-- -->/g, "");
    check("staff dashboard lists every client", dash.includes(`E2E ${tag}`) && dash.includes("All clients"));
    check("staff dashboard has New client and Agency team", dash.includes("Create client") && dash.includes("Agency team") && dash.includes(staffEmail));
    r = await staff.fetch(`/dashboard/clients/${client.id}`);
    const staffClientPage = (await r.text()).replace(/<!-- -->/g, "");
    check("staff opens a client they aren't a member of, as agency staff",
      r.status === 200 && staffClientPage.includes("Your role: agency staff") && staffClientPage.includes("Create invite"));
    check("staff can manage payment connections", staffClientPage.includes('action="/api/connect/stripe/start"'));
    r = await staff.post("/api/connect/stripe/start", { clientId: client.id });
    check("staff can start OAuth for any client", r.status === 303 && (r.headers.get("location") ?? "").includes("stripe.com"), `${r.status}`);
    const ownerClientPage = await (await owner.fetch(`/dashboard/clients/${client.id}`)).text();
    check("staff don't appear in the client's Team list", !ownerClientPage.includes(staffEmail));

    const ownerDash = await (await owner.fetch("/dashboard")).text();
    check("client owner's dashboard has no agency controls", !ownerDash.includes("Agency team") && !ownerDash.includes("Create client") && ownerDash.includes("Your clients"));
    const newClient = formFields(dash, "Create client");
    newClient.set("name", `${tag} new`);
    await owner.fetch("/dashboard", { method: "POST", body: newClient });
    check("client owner can't create clients (replayed action refused)",
      (await db.select().from(clients).where(eq(clients.slug, `${tag}-new`))).length === 0);
    r = await staff.fetch("/dashboard", { method: "POST", body: newClient });
    const [created] = await db.select().from(clients).where(eq(clients.slug, `${tag}-new`));
    check("staff can create a client", Boolean(created), `status ${r.status}`);

    const staff2Email = `${tag}-staff2@example.com`;
    const staff2 = new Jar();
    await staff2.signUp(staff2Email, tokenOf((await createInvitation({ email: staff2Email, clientId: null, role: "viewer", agencyStaff: true, invitedBy: staffRow.id })).url));
    check("second staff member sees the client", (await staff2.fetch(`/dashboard/clients/${client.id}`)).status === 200);
    dash = (await (await staff.fetch("/dashboard")).text()).replace(/<!-- -->/g, "");
    check("staff can't remove themselves (no Remove on own row)", (dash.match(/>Remove</g) ?? []).length === 1);
    const [staff2Row] = await db.select().from(user).where(eq(user.email, staff2Email));
    const selfRemove = formFields(dash, "Remove");
    selfRemove.set("userId", staffRow.id);
    await staff.fetch("/dashboard", { method: "POST", body: selfRemove });
    check("replayed self-removal is ignored", (await db.select().from(agencyStaff).where(eq(agencyStaff.userId, staffRow.id))).length === 1);
    const removeOther = formFields(dash, "Remove");
    removeOther.set("userId", staff2Row.id);
    await owner.fetch("/dashboard", { method: "POST", body: removeOther });
    check("client owner can't remove agency staff", (await db.select().from(agencyStaff).where(eq(agencyStaff.userId, staff2Row.id))).length === 1);
    await staff.fetch("/dashboard", { method: "POST", body: removeOther });
    check("staff removes another staff member", (await db.select().from(agencyStaff).where(eq(agencyStaff.userId, staff2Row.id))).length === 0);
    check("removed staff lose access to clients", (await staff2.fetch(`/dashboard/clients/${client.id}`)).status === 404);

    // --- Sync windows, paging and re-matching (real sync code; Square + GHL faked in-process) ---
    await syncWindowChecks(client.id, owner, viewer);
  } finally {
    await db.delete(user).where(like(user.email, `${tag}-%`));
    await db.delete(invitations).where(like(invitations.email, `${tag}-%`));
    await db.delete(clients).where(inArray(clients.slug, [tag, `${tag}-other`, `${tag}-sync`, `${tag}-new`]));
  }

  // Encryption round trip
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
