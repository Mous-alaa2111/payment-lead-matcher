"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { clients, paymentConnections } from "@/db/schema";
import { canManage, getMembership, isUuid, requireAgencyStaff, requireSession, type ClientRole } from "@/lib/access";
import { revokeSquare } from "@/lib/connect/square";
import { deauthorizeStripe } from "@/lib/connect/stripe";
import { canManageInviteRole, createInvitation, revokeInvitation } from "@/lib/invitations";
import { syncClient } from "@/lib/sync";
import { formatDay, parseRange, type SyncWindow } from "@/lib/sync/window";

const ROLES: ClientRole[] = ["owner", "admin", "viewer"];

async function requireManager(clientId: string) {
  const session = await requireSession();
  if (!isUuid(clientId)) throw new Error("Bad client id");
  const membership = await getMembership(session.user.id, clientId);
  if (!membership || !canManage(membership.role)) throw new Error("Forbidden");
  return { session, membership };
}

export type InviteState = { url?: string; email?: string; error?: string };

export async function inviteAction(_prev: InviteState, form: FormData): Promise<InviteState> {
  const clientId = String(form.get("clientId"));
  const { session, membership } = await requireManager(clientId);

  const email = String(form.get("email") ?? "").trim();
  const role = String(form.get("role")) as ClientRole;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Enter a valid email address." };
  if (!ROLES.includes(role)) return { error: "Pick a role." };
  if (!canManageInviteRole(membership.role, role)) return { error: "Only owners can invite owners." };

  const { url } = await createInvitation({ email, clientId, role, invitedBy: session.user.id });
  revalidatePath(`/dashboard/clients/${clientId}`);
  return { url, email };
}

export async function revokeInviteAction(form: FormData) {
  const clientId = String(form.get("clientId"));
  const inviteId = String(form.get("inviteId"));
  const { membership } = await requireManager(clientId);
  if (!isUuid(inviteId)) throw new Error("Bad invite id");

  const result = await revokeInvitation({ inviteId, clientId, actorRole: membership.role });
  if (result === "forbidden") throw new Error("Only owners can revoke owner invites");
  revalidatePath(`/dashboard/clients/${clientId}`);
}

export async function disconnectAction(form: FormData) {
  const clientId = String(form.get("clientId"));
  const provider = String(form.get("provider"));
  if (provider !== "stripe" && provider !== "square") throw new Error("Bad provider");
  await requireManager(clientId);

  const where = and(eq(paymentConnections.clientId, clientId), eq(paymentConnections.provider, provider));
  const [conn] = await db.select().from(paymentConnections).where(where);
  if (!conn) return;

  // Best effort: revoke on the provider side, but always remove our record.
  try {
    if (provider === "stripe") await deauthorizeStripe(conn.externalAccountId);
    else await revokeSquare(conn.externalAccountId);
  } catch (err) {
    console.error(`[disconnect:${provider}] provider revoke failed`, err);
  }
  await db.delete(paymentConnections).where(where);
  revalidatePath(`/dashboard/clients/${clientId}`);
}

// "Sync range" on the date-range filter form. That form is a GET filter (so it
// carries no clientId); the id comes bound from the page instead.
export async function syncRangeAction(clientId: string, form: FormData) {
  form.set("clientId", clientId);
  return syncAction(form);
}

// Plain "Sync now" posts no dates and syncs everything since the last sync;
// the date-range form posts from/to (YYYY-MM-DD) for a backfill or one period.
export async function syncAction(form: FormData) {
  const clientId = String(form.get("clientId"));
  await requireManager(clientId);
  const page = `/dashboard/clients/${clientId}`;

  const from = String(form.get("from") ?? "");
  const to = String(form.get("to") ?? "");
  let range: SyncWindow | undefined;
  if (from || to) {
    const parsed = parseRange(from, to);
    if ("error" in parsed) redirect(`${page}?error=bad_range`);
    range = parsed;
  }

  // Every connected account is synced; each one's error is stored on its
  // connection and shown on the page.
  const results = await syncClient(clientId, range);
  const done = results.flatMap((r) => (r.summary ? [r.summary] : []));
  let result: string;
  if (!done.length) {
    result = "error=sync_failed";
  } else {
    const synced = String(done.reduce((n, s) => n + s.payments, 0));
    const since = formatDay(new Date(Math.min(...done.map((s) => s.window.start.getTime()))));
    // A range sync filters the table to that range (from/to); Sync now shows everything.
    result = new URLSearchParams({
      synced,
      ...(range ? { from: from.trim(), to: to.trim() } : { since }),
      ...(done.length < results.length ? { partial: "1" } : {}),
    }).toString();
  }
  revalidatePath(page);
  redirect(`${page}?${result}`);
}

// Agency staff only. Permanently deletes the client and, through the foreign
// keys' ON DELETE CASCADE, everything stored for it: payments and match
// results, Stripe/Square connection records, team memberships and pending
// invites. User accounts, other clients, and anything in GHL, Stripe or Square
// are left alone. OAuth connections are revoked first, as Disconnect does;
// manually seeded ones are skipped because their keys are shared with other tools.
export async function removeClientAction(clientId: string) {
  await requireAgencyStaff();
  if (!isUuid(clientId)) throw new Error("Bad client id");
  const [client] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, clientId));
  if (!client) redirect("/dashboard");

  const conns = await db.select().from(paymentConnections).where(eq(paymentConnections.clientId, clientId));
  for (const conn of conns) {
    if (conn.scope === "manual-seed") continue;
    try {
      if (conn.provider === "stripe") await deauthorizeStripe(conn.externalAccountId);
      else await revokeSquare(conn.externalAccountId);
    } catch (err) {
      console.error(`[remove-client:${conn.provider}] provider revoke failed`, err);
    }
  }
  await db.delete(clients).where(eq(clients.id, clientId));
  revalidatePath("/dashboard");
  redirect(`/dashboard?${new URLSearchParams({ removed: client.name })}`);
}
