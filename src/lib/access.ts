import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { agencyStaff, clientMembers, clients } from "@/db/schema";
import { auth } from "@/lib/auth";

export type ClientRole = (typeof clientMembers.$inferSelect)["role"];

export const MANAGE_ROLES: ClientRole[] = ["owner", "admin"];

export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

export async function requireSession() {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  return session;
}

export async function isAgencyStaff(userId: string) {
  const [row] = await db.select({ userId: agencyStaff.userId }).from(agencyStaff).where(eq(agencyStaff.userId, userId));
  return Boolean(row);
}

export async function requireAgencyStaff() {
  const session = await requireSession();
  if (!(await isAgencyStaff(session.user.id))) throw new Error("Forbidden");
  return session;
}

// Same check, but a signed-in non-staff user gets a plain 404, as the client
// pages give non-members, so staff-only pages and actions don't reveal they exist.
export async function requireAgencyStaffOr404() {
  const session = await requireSession();
  if (!(await isAgencyStaff(session.user.id))) notFound();
  return session;
}

// The client and the user's effective role on it, or null if they have no access.
// Agency staff act as owner on every client (agency: true); everyone else needs
// a client_members row.
export async function getMembership(userId: string, clientId: string) {
  const [[row], agency] = await Promise.all([
    db
      .select({ client: clients, role: clientMembers.role })
      .from(clients)
      .leftJoin(clientMembers, and(eq(clientMembers.clientId, clients.id), eq(clientMembers.userId, userId)))
      .where(eq(clients.id, clientId)),
    isAgencyStaff(userId),
  ]);
  if (!row) return null;
  if (agency) return { client: row.client, role: "owner" as ClientRole, agency: true };
  return row.role ? { client: row.client, role: row.role, agency: false } : null;
}

export function canManage(role: ClientRole) {
  return MANAGE_ROLES.includes(role);
}

// Who can take whom off a client's team. Owners (and agency staff, who act as
// owner) can remove anyone; admins can remove viewers and other admins but not
// owners; viewers can't remove anyone. Nobody can remove themselves.
export function canRemoveMember(actor: { userId: string; role: ClientRole }, target: { userId: string; role: ClientRole }) {
  if (actor.userId === target.userId) return false;
  if (actor.role === "owner") return true;
  if (actor.role === "admin") return target.role !== "owner";
  return false;
}

export function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
