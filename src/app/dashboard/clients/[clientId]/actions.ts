"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { paymentConnections } from "@/db/schema";
import { canManage, getMembership, isUuid, requireSession, type ClientRole } from "@/lib/access";
import { revokeSquare } from "@/lib/connect/square";
import { deauthorizeStripe } from "@/lib/connect/stripe";
import { canManageInviteRole, createInvitation, revokeInvitation } from "@/lib/invitations";
import { syncSquare } from "@/lib/sync";
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

  // The error itself is stored on the connection and shown on the page.
  let result: string;
  try {
    const s = await syncSquare(clientId, range);
    // A range sync filters the table to that range (from/to); Sync now shows everything.
    result = new URLSearchParams(
      range
        ? { synced: String(s.payments), from: from.trim(), to: to.trim() }
        : { synced: String(s.payments), since: formatDay(s.window.start) },
    ).toString();
  } catch (err) {
    console.error("[sync:square]", err);
    result = "error=sync_failed";
  }
  revalidatePath(page);
  redirect(`${page}?${result}`);
}
