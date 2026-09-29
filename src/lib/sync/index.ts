import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { clients, paymentConnections, paymentMatches, type MatchedContact } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import {
  buildContactIndexes,
  matchPayment,
  partyFromSquarePayment,
  type Contact,
  type ContactIndexes,
  type Party,
} from "@/lib/matching";
import { listGhlContacts } from "./ghl";
import { SquareApi } from "./square";
import { latestWindow, nextSyncedThrough, type SyncWindow } from "./window";

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

function matchFields(party: Party, indexes: ContactIndexes) {
  const result = matchPayment("square", party, indexes);
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

// Pull the client's Square payments for the window (default: everything since
// the last sync) and its GHL contacts, match each payment phone-first, upsert
// the results, then re-match every older stored payment against the fresh
// contacts. Read-only towards Square and GHL. Failures are recorded on the
// connection (last_sync_error) and rethrown.
export async function syncSquare(clientId: string, range?: SyncWindow): Promise<SyncSummary> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) throw new Error("Client not found");
  const where = and(eq(paymentConnections.clientId, clientId), eq(paymentConnections.provider, "square"));
  const [conn] = await db.select().from(paymentConnections).where(where);
  if (!conn?.accessTokenEnc) throw new Error("Square isn't connected for this client");

  const startedAt = new Date();
  const window = range ?? latestWindow(conn.syncedThrough, startedAt);
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
      square.payments(window.start, window.end),
    ]);
    const customers = await square.customers([
      ...new Set(payments.map((p) => p.customer_id).filter((id): id is string => Boolean(id))),
    ]);

    const indexes = buildContactIndexes(contacts);
    const summary: SyncSummary = {
      window, payments: payments.length, contacts: contacts.length, matched: 0, ambiguous: 0, noMatch: 0, rematched: 0,
    };
    const rows = payments.map((p) => {
      const party = partyFromSquarePayment(p, p.customer_id ? customers.get(p.customer_id) : null);
      const match = matchFields(party, indexes);
      if (match.status === "matched") summary.matched++;
      else if (match.status === "ambiguous") summary.ambiguous++;
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
          eq(paymentMatches.provider, "square"),
          lt(paymentMatches.syncedAt, startedAt),
        ),
      );
    const changed = older.flatMap((r) => {
      const match = matchFields({ name: r.payerName, email: r.payerEmail, phone: r.payerPhone }, indexes);
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
