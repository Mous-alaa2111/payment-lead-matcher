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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Neon over HTTP drops a connection now and then (a timed-out fetch, not a SQL error).
function isConnectionError(e: unknown) {
  for (let c = e as { message?: string; code?: string; name?: string; cause?: unknown; sourceError?: unknown } | undefined, d = 0; c && d < 6; d++) {
    if (/fetch failed|error connecting to database|ConnectTimeout|ECONNRESET|ETIMEDOUT/i.test(`${c.message ?? ""} ${c.code ?? ""} ${c.name ?? ""}`)) return true;
    c = (c.cause ?? c.sourceError) as typeof c;
  }
  return false;
}

// Retries `fn` on connection errors only; any other error is thrown at once.
async function retryOnConnectionError<T>(fn: () => Promise<T>, attempts = 4, waitMs = 3000): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= attempts || !isConnectionError(e)) throw e;
      await sleep(waitMs);
    }
  }
}

// Before the suite writes anything: the e2e branch must answer `select 1`
// (3 tries, ~5 s apart), so a cold or unreachable branch stops the run here
// instead of failing checks halfway through.
async function warmUpE2EDatabase() {
  const { sql } = await import("../src/db");
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sql`select 1`;
      return;
    } catch (e) {
      console.log(`e2e database warm-up ${attempt}/3 failed: ${(e as Error).message}`);
      if (attempt < 3) await sleep(5000);
    }
  }
  console.error("e2e database unreachable: `select 1` failed 3 times. Not running the suite.");
  process.exit(1);
}

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
    const callsBefore = paymentCalls.length;

    // Viewer filtering by a range: the table and counts change, nothing is synced, no sync buttons.
    const tableOf = (html: string) => {
      const body = html.slice(html.indexOf("<tbody"), html.indexOf("</tbody>"));
      return { rows: body.match(/<tr class="align-top"/g)?.length ?? 0, amounts: [...body.matchAll(/\$[\d,]+\.\d\d/g)].map((m) => m[0]) };
    };
    const unfiltered = tableOf(viewerPage);
    const rangeHtml = (
      await (await viewer.fetch(`/dashboard/clients/${c.id}?from=${formatDay(range.start)}&to=${formatDay(new Date(range.end.getTime() - DAY))}`)).text()
    ).replace(/<!-- -->/g, "");
    const inRange = tableOf(rangeHtml);
    check("viewer sees all 5 payments before filtering", unfiltered.rows === 5 && viewerPage.includes("5 payments:"), `rows ${unfiltered.rows}`);
    check(
      "viewer filtering by a range changes the table and counts",
      inRange.rows === 3 && rangeHtml.includes("3 payments:") && rangeHtml.includes("Showing payments from") &&
        ["$30.00", "$40.00", "$50.00"].every((a) => inRange.amounts.includes(a)) && !inRange.amounts.includes("$10.00"),
      `rows ${inRange.rows}: ${inRange.amounts.join(" ")}`,
    );
    check("viewer's filtered page has no sync buttons", !/>Sync (now|range)</.test(rangeHtml));
    check("viewer filtering doesn't run a sync", (await conn()).lastSyncedAt?.getTime() === before && paymentCalls.length === callsBefore);

    const res = await owner.fetch(`/dashboard/clients/${c.id}`, { method: "POST", body: syncRangeForm("2026-02-01", "2026-01-01") });
    const loc = res.headers.get("location") ?? "";
    check("reversed date range is rejected with a message", loc.includes("error=bad_range"), `${res.status} ${loc}`);
    const after = await conn();
    check("rejected range didn't run a sync", after.lastSyncedAt?.getTime() === before && !after.lastSyncError);
    const vres = await viewer.fetch(`/dashboard/clients/${c.id}`, { method: "POST", body: syncRangeForm("2026-01-01", "2026-01-02") });
    const afterViewer = await conn();
    check(
      "viewer replaying Sync range is refused",
      !(vres.headers.get("location") ?? "").includes("synced=") && afterViewer.lastSyncedAt?.getTime() === before &&
        !afterViewer.lastSyncError && paymentCalls.length === callsBefore,
      `status ${vres.status}`,
    );
    const filtered = (await (await viewer.fetch(`/dashboard/clients/${c.id}?from=2000-01-01&to=2000-01-02`)).text()).replace(/<!-- -->/g, "");
    check("viewer can filter by date (GET ?from&to)", filtered.includes("Showing payments from") && filtered.includes("No payments in this date range."));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// Runs Stripe sync in-process with fetch faked for Stripe and GHL only. Two
// charge pages exercise starting_after paging. Ann's email and phone point at
// different leads, proving Stripe matches email-first (Square would pick phone).
async function stripeSyncChecks(tag: string, owner: Jar, ownerId: string) {
  const { and, eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { clients, clientMembers, paymentConnections, paymentMatches } = await import("../src/db/schema");
  const { encrypt } = await import("../src/lib/crypto");
  const { syncClient } = await import("../src/lib/sync");

  const ago = (d: number) => Math.floor((Date.now() - d * 86_400_000) / 1000);
  const charges = [
    { id: "ch_a", created: ago(1), amount: 1500, currency: "usd", status: "succeeded",
      customer: { id: "cus_a", name: "Ann Payer", email: "ann@example.com", phone: "+15550000009" }, billing_details: {} },
    { id: "ch_b", created: ago(2), amount: 2500, currency: "usd", status: "succeeded", refunded: true, amount_refunded: 2500,
      customer: { id: "cus_b", deleted: true }, billing_details: { name: "Bob Billing", email: "bob@example.com" } },
    { id: "ch_c", created: ago(3), amount: 3500, currency: "usd", status: "failed", customer: null,
      billing_details: { email: "nobody@example.com" } },
  ];
  const ghl = [
    { id: "g-ann-email", firstName: "Ann", lastName: "ByEmail", email: "ann@example.com" },
    { id: "g-ann-phone", firstName: "Other", lastName: "ByPhone", phone: "+15550000009" },
    { id: "g-bob", firstName: "Bob", lastName: "Lead", email: "bob@example.com" },
  ];
  const chargeCalls: { url: URL; account?: string }[] = [];

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const json = (b: object) => new Response(JSON.stringify(b), { status: 200 });
    if (url.hostname === "api.stripe.com" && url.pathname === "/v1/charges") {
      chargeCalls.push({ url, account: (init?.headers as Record<string, string>)["Stripe-Account"] });
      return url.searchParams.get("starting_after") === "ch_b"
        ? json({ data: charges.slice(2), has_more: false })
        : json({ data: charges.slice(0, 2), has_more: true });
    }
    if (url.hostname === "services.leadconnectorhq.com") return json({ contacts: ghl, meta: {} });
    return realFetch(input, init);
  }) as typeof fetch;

  try {
    const [c] = await db
      .insert(clients)
      .values({ name: `E2E stripe ${tag}`, slug: `${tag}-stripe`, ghlLocationId: `${tag}-sloc`, ghlTokenEnc: encrypt("fake-pit") })
      .returning();
    await db.insert(clientMembers).values({ clientId: c.id, userId: ownerId, role: "owner" });
    await db.insert(paymentConnections).values([
      { clientId: c.id, provider: "stripe", externalAccountId: "acct_e2e", accessTokenEnc: encrypt("sk_test_fake"), livemode: false, scope: "manual-seed" },
      // A Square connection with no token: its sync fails, Stripe's must still run.
      { clientId: c.id, provider: "square", externalAccountId: `${tag}-sq`, livemode: false },
    ]);

    const results = await syncClient(c.id);
    const stripe = results.find((r) => r.provider === "stripe");
    const square = results.find((r) => r.provider === "square");
    check("Stripe sync pages through every charge", stripe?.summary?.payments === 3 && chargeCalls.length === 2, stripe?.error);
    check("seeded Stripe key is used without a Stripe-Account header", chargeCalls.every((call) => call.account === undefined));
    check("one provider failing doesn't stop the other", Boolean(square?.error) && Boolean(stripe?.summary));

    const rows = Object.fromEntries(
      (await db.select().from(paymentMatches).where(and(eq(paymentMatches.clientId, c.id), eq(paymentMatches.provider, "stripe"))))
        .map((r) => [r.externalPaymentId, r]),
    );
    check("Stripe is email-first: email lead wins over a different phone lead",
      rows.ch_a?.status === "matched" && rows.ch_a.method === "email" && rows.ch_a.contacts[0]?.id === "g-ann-email");
    check("deleted customer falls back to billing email and name; refund shown",
      rows.ch_b?.status === "matched" && rows.ch_b.contacts[0]?.id === "g-bob" && rows.ch_b.payerName === "Bob Billing" && rows.ch_b.paymentStatus === "REFUNDED");
    check("unknown payer is no_match; failed charge keeps its status",
      rows.ch_c?.status === "no_match" && rows.ch_c.paymentStatus === "FAILED" && rows.ch_c.currency === "USD");

    const conns = Object.fromEntries(
      (await db.select().from(paymentConnections).where(eq(paymentConnections.clientId, c.id))).map((r) => [r.provider, r]),
    );
    check("each connection records its own sync result", !conns.stripe.lastSyncError && Boolean(conns.stripe.lastSyncedAt) && Boolean(conns.square.lastSyncError));
    const page = (await (await owner.fetch(`/dashboard/clients/${c.id}`)).text()).replace(/<!-- -->/g, "");
    check("page shows per-provider sync status, error and row source",
      page.includes("Stripe: Last synced") && page.includes("Last Square sync failed:") && page.includes(">Stripe</span>"));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// Must match CRON_SECRET in scripts/e2e-server.ts.
const E2E_CRON_SECRET = "e2e-cron-secret";

// Daily auto sync. The route's auth is checked over HTTP; the runner itself runs
// in-process (limited to this run's clients) with Stripe, Square and GHL faked,
// so no other client on the e2e branch is synced.
async function autoSyncChecks(tag: string, owner: Jar, ownerId: string) {
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { clients, clientMembers, paymentConnections, paymentMatches } = await import("../src/db/schema");
  const { encrypt } = await import("../src/lib/crypto");
  const { runAutoSync } = await import("../src/lib/sync/auto");
  const { AUTO_SYNC_EVERY_DAYS } = await import("../src/lib/sync/schedule");
  const { formatDay } = await import("../src/lib/sync/window");

  const cron = (headers: Record<string, string> = {}) => fetch(`${BASE}/api/cron/auto-sync`, { headers });
  let res = await cron();
  check("cron route rejects a request with no secret", res.status === 401, `status ${res.status}`);
  res = await cron({ Authorization: "Bearer wrong-secret" });
  check("cron route rejects a wrong secret", res.status === 401, `status ${res.status}`);
  res = await cron({ Authorization: E2E_CRON_SECRET });
  check("cron route rejects the secret without 'Bearer '", res.status === 401, `status ${res.status}`);
  res = await cron({ Authorization: "Bearer " });
  check("cron route rejects an empty bearer token", res.status === 401, `status ${res.status}`);
  res = await fetch(`${BASE}/api/cron/auto-sync`, { method: "POST", headers: { Authorization: `Bearer ${E2E_CRON_SECRET}` } });
  check("cron route doesn't accept POST", res.status === 405, `status ${res.status}`);

  const DAY = 86_400_000;
  const ago = (d: number) => new Date(Date.now() - d * DAY);
  const stripeCalls: URL[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const json = (b: object) => new Response(JSON.stringify(b), { status: 200 });
    if (url.hostname === "api.stripe.com" && url.pathname === "/v1/charges") {
      stripeCalls.push(url);
      return json({
        data: [{ id: "ch_auto", created: Math.floor(ago(1).getTime() / 1000), amount: 900, currency: "usd", status: "succeeded",
          customer: null, billing_details: { email: "auto@example.com" } }],
        has_more: false,
      });
    }
    if (url.hostname === "services.leadconnectorhq.com") return json({ contacts: [{ id: "g-auto", firstName: "Auto", email: "auto@example.com" }], meta: {} });
    return realFetch(input, init);
  }) as typeof fetch;

  try {
    const make = async (key: string, ghl: boolean, lastAutoSyncAt: Date | null) => {
      const [c] = await db
        .insert(clients)
        .values({
          name: `E2E auto ${key} ${tag}`, slug: `${tag}-auto-${key}`, lastAutoSyncAt,
          ...(ghl ? { ghlLocationId: `${tag}-auto-${key}`, ghlTokenEnc: encrypt("fake-pit") } : {}),
        })
        .returning();
      await db.insert(clientMembers).values({ clientId: c.id, userId: ownerId, role: "owner" });
      return c;
    };
    const stripeConn = (clientId: string, lastSyncedAt: Date | null) => ({
      clientId, provider: "stripe" as const, externalAccountId: `acct_${clientId.slice(0, 8)}`, accessTokenEnc: encrypt("sk_test_fake"),
      livemode: false, scope: "manual-seed", lastSyncedAt, syncedThrough: lastSyncedAt,
    });
    const monthAgo = ago(30);
    const due = await make("due", true, monthAgo); // last synced 20 days ago, auto-synced a month ago
    const failing = await make("failing", true, null); // never auto-synced, so it goes first; Square has no token
    const fresh = await make("fresh", true, null); // synced 2 days ago: not due
    const noGhl = await make("noghl", false, null); // old sync but no GHL token: not eligible
    const noConn = await make("noconn", true, null); // GHL but nothing connected: not eligible
    await db.insert(paymentConnections).values([
      stripeConn(due.id, ago(20)),
      { clientId: failing.id, provider: "square", externalAccountId: `${tag}-auto-sq`, livemode: false, lastSyncedAt: ago(40) },
      stripeConn(fresh.id, ago(2)),
      stripeConn(noGhl.id, ago(40)),
    ]);
    const ours = [due, failing, fresh, noGhl, noConn].map((c) => c.id);
    const get = async (id: string) => (await db.select().from(clients).where(eq(clients.id, id)))[0];
    const connOf = async (id: string) => (await db.select().from(paymentConnections).where(eq(paymentConnections.clientId, id)))[0];

    // Out of time before the first client: nothing starts, everything due is left for the next run.
    let report = await runAutoSync({ onlyClientIds: ours, stopStartingAfterMs: -1 });
    check("auto sync picks only clients with a GHL token, a connected account and a 14+ day old sync",
      report.eligible === 3 && report.due === 2, `eligible ${report.eligible}, due ${report.due}`);
    check("out of time: no client is started, the rest are reported as remaining",
      report.synced.length === 0 && report.remaining === 2 && stripeCalls.length === 0 &&
        (await get(due.id)).lastAutoSyncAt?.getTime() === monthAgo.getTime() && !(await get(failing.id)).lastAutoSyncAt);

    const dueBefore = await connOf(due.id);
    report = await runAutoSync({ onlyClientIds: ours });
    check("next run picks up the remaining clients, least recently auto-synced first",
      report.remaining === 0 && report.synced.map((s) => s.client).join("|") === [failing.name, due.name].join("|"), JSON.stringify(report.synced));
    const failed = report.synced.find((s) => s.client === failing.name);
    const ok = report.synced.find((s) => s.client === due.name);
    check("a failing client is reported and doesn't stop the next one",
      failed?.ok === false && failed.errors.length === 1 && ok?.ok === true, JSON.stringify(report.synced));
    check("auto sync is Sync now's incremental window (synced_through minus 7 days)",
      stripeCalls.length === 1 &&
        stripeCalls[0].searchParams.get("created[gte]") === String(Math.floor((dueBefore.syncedThrough!.getTime() - 7 * DAY) / 1000)),
      stripeCalls.map((u) => u.search).join(" "));
    const dueAfter = await connOf(due.id);
    check("auto sync stores payments and moves last synced / synced through",
      (await db.select().from(paymentMatches).where(eq(paymentMatches.clientId, due.id))).length === 1 &&
        dueAfter.lastSyncedAt!.getTime() > Date.now() - 60_000 && dueAfter.syncedThrough!.getTime() > Date.now() - 60_000 && !dueAfter.lastSyncError);
    const failingConn = await connOf(failing.id);
    check("the failure is recorded on that client's connection, as Sync now does",
      Boolean(failingConn.lastSyncError) && failingConn.lastSyncedAt!.getTime() < Date.now() - 39 * DAY);
    const [dueRow, failingRow, freshRow] = await Promise.all([get(due.id), get(failing.id), get(fresh.id)]);
    check("last auto sync is set on the clients it ran, not on the others",
      dueRow.lastAutoSyncAt!.getTime() > Date.now() - 60_000 && Boolean(failingRow.lastAutoSyncAt) && !freshRow.lastAutoSyncAt);

    report = await runAutoSync({ onlyClientIds: ours });
    check("a client synced today isn't due again; a still-failing one is retried",
      report.synced.map((s) => s.client).join("|") === failing.name, JSON.stringify(report.synced));

    const page = async (id: string) => (await (await owner.fetch(`/dashboard/clients/${id}`)).text()).replace(/<!-- -->/g, "");
    const nextDay = formatDay(new Date(Math.floor(Date.now() / DAY) * DAY + AUTO_SYNC_EVERY_DAYS * DAY));
    let html = await page(due.id);
    check("client page shows Last auto sync and Next auto sync (14 days on, around 06:00 UTC)",
      html.includes(`Last auto sync: ${formatDay(dueRow.lastAutoSyncAt!)}`) && html.includes(`Next auto sync: ${nextDay}, around 06:00 UTC`),
      html.match(/Last auto sync[^<]*/)?.[0]);
    html = await page(failing.id);
    check("a failed auto sync shows its error like Sync now", html.includes("Last Square sync failed:") && html.includes("Next auto sync: "));
    check("never auto-synced client shows 'never'", (await page(fresh.id)).includes("Last auto sync: never"));
    check("no GHL token: auto sync shown as off", (await page(noGhl.id)).includes("Next auto sync: off (add a GHL token"));
    check("nothing connected: auto sync shown as off", (await page(noConn.id)).includes("Next auto sync: off (connect Stripe or Square"));
    await db.update(clients).set({ lastAutoSyncError: "boom outside the providers" }).where(eq(clients.id, fresh.id));
    check("a client-level auto sync error is shown", (await page(fresh.id)).includes("Last auto sync failed: boom outside the providers"));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// Client Health. The page and status control are checked over HTTP; the refresh
// runner runs in-process (limited to this run's clients) with GHL faked.
// clientUsers (owner, admin, viewer) are made members of the health test client,
// so "refused" is checked for users who can otherwise see that client.
type ClientUser = { role: "owner" | "admin" | "viewer"; jar: Jar; userId: string };
async function healthChecks(tag: string, clientUsers: ClientUser[], staff: Jar, formFields: (html: string, marker: string) => FormData) {
  const { and, eq, inArray } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { clients, clientHealthStatus, clientHealthWeeks, clientMembers } = await import("../src/db/schema");
  const { encrypt } = await import("../src/lib/crypto");
  const { refreshClientHealth } = await import("../src/lib/health/refresh");
  const { isoDay, weekStart } = await import("../src/lib/health/rules");

  const DAY = 86_400_000;
  const thisMonday = weekStart(new Date()).getTime();
  const mondayOf = (n: number) => isoDay(new Date(thisMonday - n * 7 * DAY)); // n weeks back
  // createdAt n weeks before this week's Monday, plus `h` hours (never in the future).
  const inWeek = (n: number, h = 1) =>
    new Date(Math.min(thisMonday - n * 7 * DAY + h * 3_600_000, Date.now() - 60_000)).toISOString();
  const opps = [
    { createdAt: inWeek(0, 3), pipelineStageId: "s-booked", status: "won", monetaryValue: 100 },
    { createdAt: inWeek(0, 2), pipelineStageId: "s-booked", status: "open" },
    { createdAt: inWeek(0, 1), pipelineStageId: "s-new", status: "open" },
    { createdAt: inWeek(1, 5), pipelineStageId: "s-not", status: "lost" },
    { createdAt: inWeek(1, 4), pipelineStageId: "s-new", status: "open" },
    { createdAt: inWeek(3, 1), pipelineStageId: "s-booked", status: "open" },
    { createdAt: inWeek(12, 1), pipelineStageId: "s-booked", status: "open" }, // before the 8-week backfill
  ];
  const searches: URL[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "services.leadconnectorhq.com") return realFetch(input, init);
    const loc = url.searchParams.get("locationId") ?? url.searchParams.get("location_id");
    if (loc === `${tag}-h-denied`) return new Response('{"message":"The token is not authorized for this scope."}', { status: 403 });
    if (url.pathname === "/opportunities/pipelines") {
      return Response.json({
        pipelines: [{ stages: [
          { id: "s-booked", name: "Appointment Booked" }, { id: "s-new", name: "New Lead" }, { id: "s-not", name: "Not Scheduled" },
        ] }],
      });
    }
    if (url.pathname === "/opportunities/search") {
      searches.push(url);
      return Response.json({ opportunities: opps, meta: { total: opps.length } });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  try {
    const make = async (key: string, ghl: boolean) =>
      (
        await db
          .insert(clients)
          .values({
            name: `E2E health ${key} ${tag}`, slug: `${tag}-health-${key}`,
            ...(ghl ? { ghlLocationId: `${tag}-h-${key}`, ghlTokenEnc: encrypt("fake-pit") } : {}),
          })
          .returning()
      )[0];
    const good = await make("good", true);
    const denied = await make("denied", true);
    const noToken = await make("notoken", false);
    const ours = [good.id, denied.id, noToken.id];
    await db.insert(clientMembers).values(clientUsers.map((u) => ({ clientId: good.id, userId: u.userId, role: u.role })));

    let r: Response;
    for (const { role, jar } of clientUsers) {
      r = await jar.fetch("/dashboard/health");
      check(`Client Health page is a plain 404 for a client ${role}`, r.status === 404 && !(await r.text()).includes("Refresh now"), `status ${r.status}`);
      const dash = await (await jar.fetch("/dashboard")).text();
      check(`a client ${role}'s dashboard has no Client Health link`, dash.includes("Your clients") && !dash.includes("/dashboard/health"));
    }
    const staffDash = await (await staff.fetch("/dashboard")).text();
    check("staff get the Client Health link", staffDash.includes("/dashboard/health"));

    let report = await refreshClientHealth({ onlyClientIds: ours });
    const byName = (n: string) => report.find((x) => x.client === n);
    check("first refresh backfills 8 weeks; a client with no GHL token is left out",
      byName(good.name)?.ok === true && byName(good.name)?.weeks === 8 && !byName(noToken.name) && report.length === 2, JSON.stringify(report));
    check("a 403 on opportunities is recorded on that client and doesn't stop the rest",
      byName(denied.name)?.ok === false && /refused the token \(403\)/.test(byName(denied.name)?.error ?? ""), byName(denied.name)?.error);
    check("opportunities are read with location_id and paged like the Python",
      searches.length === 1 && searches[0].searchParams.get("location_id") === `${tag}-h-good` && searches[0].searchParams.get("page") === "1");

    const weeks = await db.select().from(clientHealthWeeks).where(eq(clientHealthWeeks.clientId, good.id));
    const week = (n: number) => weeks.find((w) => w.weekStart === mondayOf(n));
    check("one row per week, zeros included", weeks.length === 8 && week(2)?.total === 0 && week(7)?.total === 0, `${weeks.length} rows`);
    check("this week: total, booked, won and revenue by current stage",
      week(0)?.total === 3 && week(0)?.booked === 2 && week(0)?.won === 1 && week(0)?.revenueCents === 10000 && week(0)?.lost === 0,
      JSON.stringify(week(0)));
    check("last week: 'Not Scheduled' isn't booked; lost counted", week(1)?.total === 2 && week(1)?.booked === 0 && week(1)?.lost === 1);
    check("older weeks come from the backfill", week(3)?.total === 1 && week(3)?.booked === 1);
    const [deniedStatus] = await db.select().from(clientHealthStatus).where(eq(clientHealthStatus.clientId, denied.id));
    const deniedWeeks = await db.select().from(clientHealthWeeks).where(eq(clientHealthWeeks.clientId, denied.id));
    check("the failed client has its error stored and no weeks", Boolean(deniedStatus?.lastError) && deniedWeeks.length === 0);

    report = await refreshClientHealth({ onlyClientIds: [good.id] });
    check("next refresh fetches only this week (finished weeks are frozen)", report[0]?.weeks === 1, JSON.stringify(report));
    const after = await db.select().from(clientHealthWeeks).where(eq(clientHealthWeeks.clientId, good.id));
    check("frozen weeks keep their first fetch",
      after
        .filter((w) => w.weekStart !== mondayOf(0))
        .every((w) => w.fetchedAt.getTime() === weeks.find((x) => x.weekStart === w.weekStart)!.fetchedAt.getTime()));

    const page = async (q = "") => (await (await staff.fetch(`/dashboard/health${q}`)).text()).replace(/<!-- -->/g, "");
    const row = (html: string, id: string) => html.split(`data-client="${id}"`)[1]?.split("</tr>")[0] ?? "";
    const cells = (html: string) => [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, "|"));
    let html = await page();
    // This week 3 vs last week 2: Up; 2 of 3 booked = 67%; active this week.
    const g = cells(row(html, good.id));
    check("staff see the client's health: Green, 3 vs 2, Up, 67%, 0 weeks",
      g[1]?.includes("Green") && g[2] === "3" && g[3] === "2" && g[4] === "Up" && g[5] === "67%" && g[6] === "0", JSON.stringify(g));
    const d = row(html, denied.id);
    check("a 403 client shows its error, grey, never red", d.includes("Refresh failed") && d.includes("refused the token (403)") && !d.includes(">Red<"));
    const n = cells(row(html, noToken.id));
    check("a client with no GHL token shows grey 'No GHL token', no zeros",
      n[1]?.includes("No GHL token") && n.slice(2).every((c) => !/\b0\b/.test(c)) && !n[1]?.includes("Red"), JSON.stringify(n));

    // Two weeks in a row with no activity: red.
    await db
      .update(clientHealthWeeks)
      .set({ total: 0, booked: 0 })
      .where(and(eq(clientHealthWeeks.clientId, good.id), inArray(clientHealthWeeks.weekStart, [mondayOf(0), mondayOf(1)])));
    check("two weeks with no activity: Red", cells(row(await page(), good.id))[1]?.includes("Red"));

    // Client status: staff set it on the client page; the health page filters by it.
    const clientPage = (await (await staff.fetch(`/dashboard/clients/${good.id}`)).text()).replace(/<!-- -->/g, "");
    check("staff see the client status control", clientPage.includes('name="status"') && clientPage.includes("Client status"));
    const statusForm = formFields(clientPage, "Client status");
    const statusOf = async () => (await db.select({ s: clients.status }).from(clients).where(eq(clients.id, good.id)))[0].s;
    check("new clients start Active", (await statusOf()) === "active");
    for (const { role, jar } of clientUsers) {
      r = await jar.fetch(`/dashboard/clients/${good.id}`);
      const own = (await r.text()).replace(/<!-- -->/g, "");
      check(`a client ${role} opens their own client page but sees no status picker or status label`,
        r.status === 200 && own.includes(good.name) && !own.includes("Client status") && !own.includes('name="status"') &&
          !/>(Active|Onboarding|Paused|Canceled)</.test(own), `status ${r.status}`);
      // Hand-built: staff's status form (action id, bound client id) replayed with this user's cookies.
      statusForm.set("status", "canceled");
      r = await jar.fetch(`/dashboard/clients/${good.id}`, { method: "POST", body: statusForm });
      check(`a client ${role} changing status gets a 404 (replayed action refused)`,
        r.status === 404 && (await statusOf()) === "active" && !(r.headers.get("location") ?? "").includes("status=saved"), `status ${r.status}`);
    }
    statusForm.set("status", "bogus");
    await staff.fetch(`/dashboard/clients/${good.id}`, { method: "POST", body: statusForm });
    check("an unknown status is refused", (await statusOf()) === "active");
    statusForm.set("status", "paused");
    r = await staff.fetch(`/dashboard/clients/${good.id}`, { method: "POST", body: statusForm });
    check("staff set a client to Paused", (await statusOf()) === "paused", `status ${r.status}`);
    html = await page();
    check("health page shows Active and Onboarding by default",
      !html.includes(`data-client="${good.id}"`) && html.includes(`data-client="${denied.id}"`));
    check("the Paused filter shows paused clients only",
      (await page("?show=paused")).includes(`data-client="${good.id}"`) && !(await page("?show=paused")).includes(`data-client="${denied.id}"`));
    check("the All filter shows everyone", (await page("?show=all")).includes(`data-client="${good.id}"`));
    await db.update(clients).set({ status: "onboarding" }).where(eq(clients.id, good.id));
    check("onboarding clients are in the default view", (await page()).includes(`data-client="${good.id}"`));

    // Hand-built: staff's Refresh now form replayed with each client user's cookies. Had it
    // run, it would refresh every client with a token, good included (GHL isn't faked in the
    // server), moving good's last refresh time.
    const refreshForm = formFields(html, "Refresh now");
    const lastRefresh = async () =>
      (await db.select().from(clientHealthStatus).where(eq(clientHealthStatus.clientId, good.id)))[0]?.lastRefreshedAt.getTime();
    const before = await lastRefresh();
    for (const { role, jar } of clientUsers) {
      r = await jar.fetch("/dashboard/health", { method: "POST", body: refreshForm });
      check(`a client ${role} running Refresh now gets a 404 (replayed action refused)`,
        r.status === 404 && !(r.headers.get("location") ?? "").includes("refreshed=") && (await lastRefresh()) === before,
        `status ${r.status}`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

// Remove team member: who sees Remove on whose row, the server refusing the same
// removals when hand-built, and what a removal deletes. Actors are real signed-in
// users; extra targets are inserted directly (they never sign in).
type Actor = { jar: Jar; userId: string };
async function memberRemovalChecks(
  tag: string,
  actors: { staff: Actor; owner: Actor; admin: Actor; viewer: Actor },
  formFields: (html: string, marker: string) => FormData,
) {
  const { and, eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { clients, clientMembers, user } = await import("../src/db/schema");
  const { staff, owner, admin, viewer } = actors;

  const [c] = await db.insert(clients).values({ name: `E2E members ${tag}`, slug: `${tag}-members` }).returning();
  const [other] = await db.insert(clients).values({ name: `E2E members other ${tag}`, slug: `${tag}-members-other` }).returning();
  const target = async (key: string, role: "owner" | "admin" | "viewer") => {
    const id = `${tag}-${key}`;
    await db.insert(user).values({ id, name: `Target ${key}`, email: `${tag}-${key}@example.com` });
    await db.insert(clientMembers).values({ clientId: c.id, userId: id, role });
    return id;
  };
  await db.insert(clientMembers).values([
    { clientId: c.id, userId: owner.userId, role: "owner" },
    { clientId: c.id, userId: admin.userId, role: "admin" },
    { clientId: c.id, userId: viewer.userId, role: "viewer" },
  ]);
  const owner2 = await target("t-owner2", "owner");
  const owner3 = await target("t-owner3", "owner");
  const admin2 = await target("t-admin2", "admin");
  const viewer2 = await target("t-viewer2", "viewer");
  const viewer3 = await target("t-viewer3", "viewer");
  // Only a member of the other client: a removal posted to this client must not touch it.
  const outsider = `${tag}-t-outsider`;
  await db.insert(user).values({ id: outsider, name: "Target outsider", email: `${tag}-t-outsider@example.com` });
  await db.insert(clientMembers).values({ clientId: other.id, userId: outsider, role: "viewer" });

  const page = `/dashboard/clients/${c.id}`;
  const isMember = async (userId: string, clientId = c.id) =>
    (await db.select().from(clientMembers).where(and(eq(clientMembers.clientId, clientId), eq(clientMembers.userId, userId)))).length === 1;
  // Each Team row is an <li>; a Remove button sits in the row with its member's email.
  const removable = async (jar: Jar) => {
    const html = (await (await jar.fetch(page)).text()).replace(/<!-- -->/g, "");
    const team = html.slice(html.indexOf(">Team<"));
    const rows = team.split(/<li[ >]/).slice(1).map((li) => li.split("</li>")[0]);
    return {
      html,
      ids: rows.filter((li) => li.includes(">Remove<")).map((li) => li.match(/name="userId" value="([^"]+)"/)?.[1]).filter(Boolean),
    };
  };
  const everyone = [owner.userId, admin.userId, viewer.userId, owner2, owner3, admin2, viewer2, viewer3];
  const same = (a: unknown[], b: string[]) => a.length === b.length && b.every((x) => a.includes(x));

  let v = await removable(staff.jar);
  check("staff see Remove on every team member", same(v.ids, everyone), `${v.ids.length} of ${everyone.length}`);
  check(
    "Remove opens a dialog naming the member and client",
    v.html.includes("<dialog") && v.html.includes(`Remove Target t-viewer2 from E2E members ${tag}?`) &&
      v.html.includes("They will lose access to this client. Their login stays."),
  );
  const staffPage = v.html;
  v = await removable(owner.jar);
  check("client owner sees Remove on everyone but themselves", same(v.ids, everyone.filter((id) => id !== owner.userId)), `${v.ids.length}`);
  v = await removable(admin.jar);
  check("admin sees Remove on admins and viewers only, not owners or themselves",
    same(v.ids, [viewer.userId, admin2, viewer2, viewer3]), `${v.ids.length}`);
  v = await removable(viewer.jar);
  check("viewer sees no Remove buttons", v.ids.length === 0 && v.html.includes("Target t-viewer2"), `${v.ids.length}`);

  // Hand-built: staff's Remove form for `userId` (action id, bound client id), sent with another user's cookies.
  const removal = (userId: string) => {
    const fd = formFields(staffPage, `name="userId" value="${owner.userId}"`);
    fd.set("userId", userId);
    return fd;
  };
  const post = (who: Actor, userId: string) => who.jar.fetch(page, { method: "POST", body: removal(userId) });
  const refused = async (label: string, who: Actor, userId: string, clientId = c.id) => {
    const r = await post(who, userId);
    check(`${label} (hand-built request refused)`,
      (await isMember(userId, clientId)) && !(r.headers.get("location") ?? "").includes("memberRemoved="), `status ${r.status}`);
  };
  const removed = async (label: string, who: Actor, userId: string) => {
    const r = await post(who, userId);
    const loc = decodeURIComponent((r.headers.get("location") ?? "").replace(/\+/g, " "));
    check(label, !(await isMember(userId)) && loc.includes("memberRemoved="), `status ${r.status} ${loc}`);
    return loc;
  };

  await refused("viewer can't remove another viewer", viewer, viewer2);
  await refused("viewer can't remove an owner", viewer, owner2);
  await refused("viewer can't remove themselves", viewer, viewer.userId);
  await refused("admin can't remove an owner", admin, owner2);
  await refused("admin can't remove themselves", admin, admin.userId);
  await refused("owner can't remove themselves", owner, owner.userId);
  await db.insert(clientMembers).values({ clientId: c.id, userId: staff.userId, role: "viewer" });
  await refused("staff can't remove their own membership", staff, staff.userId);
  await db.delete(clientMembers).where(and(eq(clientMembers.clientId, c.id), eq(clientMembers.userId, staff.userId)));
  await refused("removal can't reach a member of a different client", owner, outsider, other.id);

  await removed("admin removes a viewer", admin, viewer3);
  await removed("admin removes another admin", admin, admin2);
  const loc = await removed("owner removes another owner", owner, owner2);
  check("removal shows who was removed from which client", (await (await owner.jar.fetch(loc.replace(/^https?:\/\/[^/]+/, ""))).text())
    .replace(/<!-- -->/g, "").includes(`Removed Target t-owner2 from E2E members ${tag}.`), loc);
  await removed("owner removes a viewer", owner, viewer2);
  await removed("staff remove an owner", staff, owner3);
  await removed("staff remove a viewer", staff, viewer.userId);

  const r = await viewer.jar.fetch(page);
  check("removed user gets a 404 on that client's page", r.status === 404, `status ${r.status}`);
  check("removal keeps the user's login and their other clients",
    (await db.select().from(user).where(eq(user.id, viewer.userId))).length === 1 &&
      (await db.select().from(clientMembers).where(eq(clientMembers.userId, viewer.userId))).length > 0 &&
      (await db.select().from(user).where(eq(user.id, owner2))).length === 1);
  check("removed user stays signed in and keeps their dashboard", (await viewer.jar.fetch("/dashboard")).status === 200);
  check("remaining members untouched", (await isMember(owner.userId)) && (await isMember(admin.userId)));
}

async function main() {
  await warmUpE2EDatabase();
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
    check("sync failure is shown on the page", page.includes("sync failed:") && page.includes("no GHL location"));

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
    // Look only at each staff row, so leftover staff from other runs can't skew it.
    const rowFor = (email: string) =>
      dash.split(/<li[ >]/).slice(1).find((li) => li.includes(email))?.split("</li>")[0] ?? "";
    check("staff can't remove themselves (no Remove on own row)",
      !rowFor(staffEmail).includes(">Remove<") && rowFor(staffEmail).includes("you") && rowFor(staff2Email).includes(">Remove<"));
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

    // --- Stripe sync (real sync code; Stripe + GHL faked in-process) ---
    await stripeSyncChecks(tag, owner, ownerRow.id);

    // --- Daily auto sync: cron route auth, runner (faked providers), client page ---
    await autoSyncChecks(tag, owner, ownerRow.id);

    // --- Client Health: staff-only page, refresh runner (GHL faked), client status ---
    const [adminRow] = await db.select().from(user).where(eq(user.email, adminEmail));
    const [viewerRow] = await db.select().from(user).where(eq(user.email, viewerEmail));
    await healthChecks(tag, [
      { role: "owner", jar: owner, userId: ownerRow.id },
      { role: "admin", jar: admin, userId: adminRow.id },
      { role: "viewer", jar: viewer, userId: viewerRow.id },
    ], staff, formFields);

    // --- Remove team member: per-role buttons, hand-built requests refused, removed user gets a 404 ---
    await memberRemovalChecks(tag, {
      staff: { jar: staff, userId: staffRow.id },
      owner: { jar: owner, userId: ownerRow.id },
      admin: { jar: admin, userId: adminRow.id },
      viewer: { jar: viewer, userId: viewerRow.id },
    }, formFields);

    // --- Remove client: agency staff only, behind a dialog; cascades to everything stored for it ---
    const [doomed] = await db.insert(clients).values({ name: `E2E remove ${tag}`, slug: `${tag}-remove` }).returning();
    await db.insert(clientMembers).values({ clientId: doomed.id, userId: ownerRow.id, role: "owner" });
    await db.insert(paymentConnections).values({
      clientId: doomed.id, provider: "square", externalAccountId: `${tag}-rm`, accessTokenEnc: encrypt("x"), livemode: false, scope: "manual-seed",
    });
    await db.insert(paymentMatches).values({
      clientId: doomed.id, provider: "square", externalPaymentId: "rm1", paidAt: new Date(), amountCents: 100, currency: "USD", status: "no_match",
    });
    await createInvitation({ email: `${tag}-rm-invitee@example.com`, clientId: doomed.id, role: "viewer", invitedBy: null });
    const ownerView = await (await owner.fetch(`/dashboard/clients/${doomed.id}`)).text();
    check("client owner doesn't see Remove client", !ownerView.includes("Remove client"));
    const staffView = (await (await staff.fetch(`/dashboard/clients/${doomed.id}`)).text()).replace(/<!-- -->/g, "");
    check(
      "staff see Remove client, with a dialog listing what it deletes",
      staffView.includes("Remove client") && staffView.includes("<dialog") && staffView.includes("undone") &&
        staffView.includes("1 stored payment and their match results") && staffView.includes("The Square connection") &&
        staffView.includes("1 team member") && staffView.includes("1 pending invite"),
    );
    const removeForm = formFields(staffView, ">Remove client<"); // its submit button; Remove member dialogs say just "Remove"
    await owner.fetch(`/dashboard/clients/${doomed.id}`, { method: "POST", body: removeForm });
    check("client owner can't remove a client (replayed action refused)",
      (await db.select().from(clients).where(eq(clients.id, doomed.id))).length === 1);
    r = await staff.fetch(`/dashboard/clients/${doomed.id}`, { method: "POST", body: removeForm });
    const left = await Promise.all([
      db.select().from(clients).where(eq(clients.id, doomed.id)),
      db.select().from(clientMembers).where(eq(clientMembers.clientId, doomed.id)),
      db.select().from(paymentConnections).where(eq(paymentConnections.clientId, doomed.id)),
      db.select().from(paymentMatches).where(eq(paymentMatches.clientId, doomed.id)),
      db.select().from(invitations).where(eq(invitations.clientId, doomed.id)),
    ]);
    check("staff remove deletes the client, its payments, connections, memberships and invites",
      left.every((rows) => rows.length === 0), left.map((rows) => rows.length).join(","));
    check("removing a client keeps its team's user accounts", (await db.select().from(user).where(eq(user.id, ownerRow.id))).length === 1);
    check("removal redirects to the dashboard with a message", (r.headers.get("location") ?? "").includes("/dashboard?removed="), `${r.status}`);
  } finally {
    // Each delete is retried on connection errors, and one failing doesn't skip the rest.
    const cleanup = async (what: string, del: () => Promise<unknown>) => {
      try {
        await retryOnConnectionError(del);
      } catch (e) {
        check(`cleanup: delete ${what} (rows tagged ${tag} may be left on the e2e branch)`, false, (e as Error).message);
      }
    };
    await cleanup("users", () => db.delete(user).where(like(user.email, `${tag}-%`)));
    await cleanup("invitations", () => db.delete(invitations).where(like(invitations.email, `${tag}-%`)));
    await cleanup("clients", () =>
      db.delete(clients).where(
        inArray(clients.slug, [tag, `${tag}-other`, `${tag}-sync`, `${tag}-new`, `${tag}-stripe`, `${tag}-remove`, `${tag}-members`, `${tag}-members-other`]),
      ),
    );
    await cleanup("auto sync clients", () => db.delete(clients).where(like(clients.slug, `${tag}-auto-%`)));
    await cleanup("health clients", () => db.delete(clients).where(like(clients.slug, `${tag}-health-%`)));
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
