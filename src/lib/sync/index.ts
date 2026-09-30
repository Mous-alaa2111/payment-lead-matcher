import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { clients, paymentConnections, paymentMatches, type MatchedContact } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import {
  buildContactIndexes,
  matchPayment,
  partyFromSquarePayment,
  partyFromStripeCharge,
  type Contact,
  type ContactIndexes,
  type Party,
  type Provider,
} from "@/lib/matching";
import { listGhlContacts } from "./ghl";
import { SquareApi } from "./square";
import { StripeApi, stripeChargeStatus } from "./stripe";
import { latestWindow, nextSyncedThrough, type SyncWindow } from "./window";

export const PROVIDER_NAME: Record<Provider, string> = { stripe: "Stripe", square: "Square" };

export type SyncSummary = {
  window: SyncWindow;
  payments: number; // fetched from the provider in this window
  contacts: number;
  matched: number;
  ambiguous: number;
  noMatch: number;
  rematched: number; // older stored payments whose match changed (e.g. a lead was added in GHL)
};

const UPSERT_CHUNK = 500;

const toMatched = (c: Contact): MatchedContact => ({
  id: c.id,
  name: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "(no name)",
  email: c.email ?? null,
  phone: c.phone ?? null,
});

// Field-by-field, so jsonb's own key ordering can't make every row look changed.
const contactsKey = (cs: MatchedContact[]) => cs.map((c) => [c.id, c.name, c.email, c.phone].join("|")).join(";");

// Each provider keeps its own key order (lib/matching PRIORITY): Stripe
// email-first, Square phone-first, as in stripe-crm-sync.
function matchFields(provider: Provider, party: Party, indexes: ContactIndexes) {
  const result = matchPayment(provider, party, indexes);
  return {
    status: result.status,
    method: result.method,
    contacts:
      result.status === "matched"
        ? [toMatched(result.contact)]
        : result.status === "ambiguous"
          ? result.contacts.map(toMatched)
          : [],
  };
}

type Conn = typeof paymentConnections.$inferSelect;
type FetchedPayment = {
  externalPaymentId: string;
  paidAt: Date;
  amountCents: number;
  currency: string;
  paymentStatus: string | null;
  party: Party; // what matching uses
  displayName: string | null; // payer name shown in the table
};

async function fetchSquare(conn: Conn, window: SyncWindow): Promise<FetchedPayment[]> {
  if (!conn.accessTokenEnc) throw new Error("Square isn't connected for this client");
  if (conn.tokenExpiresAt && conn.tokenExpiresAt < new Date()) {
    throw new Error("Square access token has expired. Reconnect Square");
  }
  const square = new SquareApi(decrypt(conn.accessTokenEnc), conn.livemode);
  const payments = await square.payments(window.start, window.end);
  const customers = await square.customers([
    ...new Set(payments.map((p) => p.customer_id).filter((id): id is string => Boolean(id))),
  ]);
  return payments.map((p) => {
    const party = partyFromSquarePayment(p, p.customer_id ? customers.get(p.customer_id) : null);
    return {
      externalPaymentId: p.id,
      paidAt: new Date(p.created_at),
      amountCents: p.amount_money?.amount ?? 0,
      currency: p.amount_money?.currency ?? "",
      paymentStatus: p.status ?? null,
      party,
      displayName: party.name,
    };
  });
}

async function fetchStripe(conn: Conn, window: SyncWindow): Promise<FetchedPayment[]> {
  // A manually seeded connection stores the account's own key; a Connect
  // account is read with the platform key plus the Stripe-Account header.
  let stripe: StripeApi;
  if (conn.accessTokenEnc) stripe = new StripeApi(decrypt(conn.accessTokenEnc), null);
  else if (process.env.STRIPE_SECRET_KEY) stripe = new StripeApi(process.env.STRIPE_SECRET_KEY, conn.externalAccountId);
  else throw new Error("Stripe isn't configured on the server (STRIPE_SECRET_KEY)");

  const charges = await stripe.charges(window.start, window.end);
  return charges.map((c) => {
    // A deleted customer comes back as { id, deleted: true }: treat it as no customer.
    const customer = typeof c.customer === "object" && c.customer?.deleted ? null : c.customer;
    const party = partyFromStripeCharge({ customer, billing_details: c.billing_details });
    return {
      externalPaymentId: c.id,
      paidAt: new Date(c.created * 1000),
      amountCents: c.amount,
      currency: c.currency.toUpperCase(),
      paymentStatus: stripeChargeStatus(c),
      party,
      displayName: party.name ?? c.billing_details?.name ?? null,
    };
  });
}

const FETCH: Record<Provider, (conn: Conn, window: SyncWindow) => Promise<FetchedPayment[]>> = {
  square: fetchSquare,
  stripe: fetchStripe,
};

// Pull one provider's payments for the window (default: everything since the
// last sync) and the client's GHL contacts, match each payment in that
// provider's key order, upsert the results, then re-match every older stored
// payment from that provider against the fresh contacts. Read-only towards the
// provider and GHL. Failures are recorded on the connection (last_sync_error)
// and rethrown.
export async function syncPayments(clientId: string, provider: Provider, range?: SyncWindow): Promise<SyncSummary> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) throw new Error("Client not found");
  const where = and(eq(paymentConnections.clientId, clientId), eq(paymentConnections.provider, provider));
  const [conn] = await db.select().from(paymentConnections).where(where);
  if (!conn) throw new Error(`${PROVIDER_NAME[provider]} isn't connected for this client`);

  const startedAt = new Date();
  const window = range ?? latestWindow(conn.syncedThrough, startedAt);
  try {
    if (!client.ghlLocationId || !client.ghlTokenEnc) {
      throw new Error("This client has no GHL location/token set, so there are no leads to match against");
    }
    const [contacts, payments] = await Promise.all([
      listGhlContacts(client.ghlLocationId, decrypt(client.ghlTokenEnc)),
      FETCH[provider](conn, window),
    ]);

    const indexes = buildContactIndexes(contacts);
    const summary: SyncSummary = {
      window, payments: payments.length, contacts: contacts.length, matched: 0, ambiguous: 0, noMatch: 0, rematched: 0,
    };
    const rows = payments.map((p) => {
      const match = matchFields(provider, p.party, indexes);
      if (match.status === "matched") summary.matched++;
      else if (match.status === "ambiguous") summary.ambiguous++;
      else summary.noMatch++;
      return {
        clientId,
        provider,
        externalPaymentId: p.externalPaymentId,
        paidAt: p.paidAt,
        amountCents: p.amountCents,
        currency: p.currency,
        paymentStatus: p.paymentStatus,
        payerName: p.displayName,
        payerEmail: p.party.email,
        payerPhone: p.party.phone,
        ...match,
        syncedAt: startedAt,
      };
    });

    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      await db
        .insert(paymentMatches)
        .values(rows.slice(i, i + UPSERT_CHUNK))
        .onConflictDoUpdate({
          target: [paymentMatches.clientId, paymentMatches.provider, paymentMatches.externalPaymentId],
          set: {
            paidAt: sql`excluded.paid_at`,
            amountCents: sql`excluded.amount_cents`,
            currency: sql`excluded.currency`,
            paymentStatus: sql`excluded.payment_status`,
            payerName: sql`excluded.payer_name`,
            payerEmail: sql`excluded.payer_email`,
            payerPhone: sql`excluded.payer_phone`,
            status: sql`excluded.status`,
            method: sql`excluded.method`,
            contacts: sql`excluded.contacts`,
            syncedAt: sql`excluded.synced_at`,
          },
        });
    }

    // Payments outside this window keep their stored payer details; re-match
    // them so the whole table reflects today's GHL contacts.
    const older = await db
      .select()
      .from(paymentMatches)
      .where(
        and(
          eq(paymentMatches.clientId, clientId),
          eq(paymentMatches.provider, provider),
          lt(paymentMatches.syncedAt, startedAt),
        ),
      );
    const changed = older.flatMap((r) => {
      const match = matchFields(provider, { name: r.payerName, email: r.payerEmail, phone: r.payerPhone }, indexes);
      const same =
        match.status === r.status && match.method === r.method && contactsKey(match.contacts) === contactsKey(r.contacts);
      return same ? [] : [{ id: r.id, ...match }];
    });
    summary.rematched = changed.length;
    for (let i = 0; i < changed.length; i += 100) {
      const updates = changed
        .slice(i, i + 100)
        .map(({ id, ...match }) => db.update(paymentMatches).set(match).where(eq(paymentMatches.id, id)));
      await db.batch(updates as [(typeof updates)[number], ...typeof updates]);
    }

    await db
      .update(paymentConnections)
      .set({ lastSyncedAt: new Date(), lastSyncError: null, syncedThrough: nextSyncedThrough(conn.syncedThrough, window) })
      .where(where);
    return summary;
  } catch (err) {
    await db
      .update(paymentConnections)
      .set({ lastSyncError: (err as Error).message.slice(0, 500) })
      .where(where);
    throw err;
  }
}

export const syncSquare = (clientId: string, range?: SyncWindow) => syncPayments(clientId, "square", range);
export const syncStripe = (clientId: string, range?: SyncWindow) => syncPayments(clientId, "stripe", range);

export type ClientSyncResult = { provider: Provider; summary?: SyncSummary; error?: string };

// Sync every payment account the client has connected, one after the other.
// One provider failing doesn't stop the other; each error is also stored on
// its connection and shown on the page.
export async function syncClient(clientId: string, range?: SyncWindow): Promise<ClientSyncResult[]> {
  const conns = await db
    .select({ provider: paymentConnections.provider })
    .from(paymentConnections)
    .where(eq(paymentConnections.clientId, clientId));
  const results: ClientSyncResult[] = [];
  for (const { provider } of conns.sort((a, b) => a.provider.localeCompare(b.provider))) {
    try {
      results.push({ provider, summary: await syncPayments(clientId, provider, range) });
    } catch (err) {
      console.error(`[sync:${provider}]`, err);
      results.push({ provider, error: (err as Error).message });
    }
  }
  return results;
}
