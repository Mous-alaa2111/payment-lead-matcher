import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { clientMembers, clients } from "@/db/schema";
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

// Returns the client and the user's role on it, or null if they aren't a member.
export async function getMembership(userId: string, clientId: string) {
  const [row] = await db
    .select({ client: clients, role: clientMembers.role })
    .from(clientMembers)
    .innerJoin(clients, eq(clientMembers.clientId, clients.id))
    .where(and(eq(clientMembers.userId, userId), eq(clientMembers.clientId, clientId)));
  return row ?? null;
}

export function canManage(role: ClientRole) {
  return MANAGE_ROLES.includes(role);
}

export function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
