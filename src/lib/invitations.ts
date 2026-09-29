import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { clientMembers, invitations } from "@/db/schema";
import type { ClientRole } from "@/lib/access";
import { randomToken, sha256 } from "@/lib/crypto";
import { appUrl } from "@/lib/url";

const INVITE_TTL_DAYS = 7;

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function createInvitation(opts: {
  email: string;
  clientId: string | null;
  role: ClientRole;
  invitedBy: string | null;
}) {
  const token = randomToken();
  const [invite] = await db
    .insert(invitations)
    .values({
      email: normalizeEmail(opts.email),
      clientId: opts.clientId,
      role: opts.role,
      invitedBy: opts.invitedBy,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
    })
    .returning();
  return { invite, url: appUrl(`/invite/${token}`) };
}

function pending() {
  return and(isNull(invitations.acceptedAt), gt(invitations.expiresAt, new Date()));
}

export async function findPendingInvitation(token: string) {
  const [invite] = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.tokenHash, sha256(token)), pending()));
  return invite ?? null;
}

export async function hasPendingInvitation(email: string) {
  const [row] = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(and(eq(invitations.email, normalizeEmail(email)), pending()))
    .limit(1);
  return Boolean(row);
}

async function accept(invite: typeof invitations.$inferSelect, userId: string) {
  if (invite.clientId) {
    await db
      .insert(clientMembers)
      .values({ clientId: invite.clientId, userId, role: invite.role })
      .onConflictDoUpdate({
        target: [clientMembers.clientId, clientMembers.userId],
        set: { role: invite.role },
      });
  }
  await db
    .update(invitations)
    .set({ acceptedAt: new Date(), acceptedBy: userId })
    .where(eq(invitations.id, invite.id));
}

// Called right after a new user is created: every pending invite addressed to
// their email is accepted (they may have been invited to several clients).
export async function acceptPendingInvitationsForEmail(email: string, userId: string) {
  const rows = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.email, normalizeEmail(email)), pending()));
  for (const invite of rows) await accept(invite, userId);
}

// Same rule as creating invites: owners and admins can manage invites, but
// only owners can create or revoke an owner invite.
export function canManageInviteRole(actorRole: ClientRole, inviteRole: ClientRole) {
  if (actorRole === "owner") return true;
  if (actorRole === "admin") return inviteRole !== "owner";
  return false;
}

// Deletes a pending invite for this client, so its link stops working.
// Accepted invites are left alone (remove the member instead).
export async function revokeInvitation(opts: { inviteId: string; clientId: string; actorRole: ClientRole }) {
  const [invite] = await db
    .select({ role: invitations.role })
    .from(invitations)
    .where(
      and(eq(invitations.id, opts.inviteId), eq(invitations.clientId, opts.clientId), isNull(invitations.acceptedAt)),
    );
  if (!invite) return "not_found" as const;
  if (!canManageInviteRole(opts.actorRole, invite.role)) return "forbidden" as const;
  await db
    .delete(invitations)
    .where(
      and(eq(invitations.id, opts.inviteId), eq(invitations.clientId, opts.clientId), isNull(invitations.acceptedAt)),
    );
  return "revoked" as const;
}

// Existing, signed-in user accepting one specific invite link.
export async function acceptInvitation(token: string, user: { id: string; email: string }) {
  const invite = await findPendingInvitation(token);
  if (!invite) return { ok: false as const, reason: "invalid" as const };
  if (invite.email !== normalizeEmail(user.email)) return { ok: false as const, reason: "wrong-email" as const };
  await accept(invite, user.id);
  return { ok: true as const, clientId: invite.clientId };
}
