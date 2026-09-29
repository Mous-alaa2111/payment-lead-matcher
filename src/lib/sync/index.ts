import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { clients, paymentConnections, paymentMatches, type MatchedContact } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { buildContactIndexes, matchPayment, partyFromSquarePayment, type Contact } from "@/lib/matching";
import { listGhlContacts } from "./ghl";
import { SquareApi, type SquareCustomer } from "./square";

// How many of the seller's most recent payments each sync (re)matches.
export const RECENT_PAYMENTS = 100;

export type SyncSummary = {
  payments: number;
  contacts: number;
  matched: number;
  ambiguous: number;
  noMatch: number;
};

const toMatched = (c: Contact): MatchedContact => ({
  id: c.id,
  name: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "(no name)",
  email: c.email ?? null,
  phone: c.phone ?? null,
});

// Pull the client's recent Square payments and GHL contacts, match each payment
// phone-first, and upsert the results. Read-only towards Square and GHL.
// Failures are recorded on the connection (last_sync_error) and rethrown.
export async function syncSquare(clientId: string): Promise<SyncSummary> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) throw new Error("Client not found");
  const where = and(eq(paymentConnections.clientId, clientId), eq(paymentConnections.provider, "square"));
  const [conn] = await db.select().from(paymentConnections).where(where);
  if (!conn?.accessTokenEnc) throw new Error("Square isn't connected for this client");

  try {
    if (!client.ghlLocationId || !client.ghlTokenEnc) {
      throw new Error("This client has no GHL location/token set, so there are no leads to match against");
    }
    if (conn.tokenExpiresAt && conn.tokenExpiresAt < new Date()) {
      throw new Error("Square access token has expired. Reconnect Square");
    }

    const square = new SquareApi(decrypt(conn.accessTokenEnc), conn.livemode);
    const [contacts, payments] = await Promise.all([
      listGhlContacts(client.ghlLocationId, decrypt(client.ghlTokenEnc)),
      square.recentPayments(RECENT_PAYMENTS),
    ]);

    const customerIds = [...new Set(payments.map((p) => p.customer_id).filter((id): id is string => Boolean(id)))];
    const customers = new Map<string, SquareCustomer | null>();
    for (let i = 0; i < customerIds.length; i += 5) {
      const batch = customerIds.slice(i, i + 5);
      const fetched = await Promise.all(batch.map((id) => square.customer(id)));
      batch.forEach((id, j) => customers.set(id, fetched[j]));
    }

    const indexes = buildContactIndexes(contacts);
    const summary: SyncSummary = { payments: payments.length, contacts: contacts.length, matched: 0, ambiguous: 0, noMatch: 0 };
    const rows = payments.map((p) => {
      const party = partyFromSquarePayment(p, p.customer_id ? customers.get(p.customer_id) : null);
      const result = matchPayment("square", party, indexes);
      if (result.status === "matched") summary.matched++;
      else if (result.status === "ambiguous") summary.ambiguous++;
      else summary.noMatch++;
      return {
        clientId,
        provider: "square" as const,
        externalPaymentId: p.id,
        paidAt: new Date(p.created_at),
        amountCents: p.amount_money?.amount ?? 0,
        currency: p.amount_money?.currency ?? "",
        paymentStatus: p.status ?? null,
        payerName: party.name,
        payerEmail: party.email,
        payerPhone: party.phone,
        status: result.status,
        method: result.method,
        contacts:
          result.status === "matched"
            ? [toMatched(result.contact)]
            : result.status === "ambiguous"
              ? result.contacts.map(toMatched)
              : [],
        syncedAt: new Date(),
      };
    });

    if (rows.length) {
      await db
        .insert(paymentMatches)
        .values(rows)
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
    await db.update(paymentConnections).set({ lastSyncedAt: new Date(), lastSyncError: null }).where(where);
    return summary;
  } catch (err) {
    await db
      .update(paymentConnections)
      .set({ lastSyncError: (err as Error).message.slice(0, 500) })
      .where(where);
    throw err;
  }
}
