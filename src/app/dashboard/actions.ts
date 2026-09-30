"use server";

import { eq, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { agencyStaff, clients, user } from "@/db/schema";
import { requireAgencyStaff } from "@/lib/access";
import { encrypt } from "@/lib/crypto";
import { createInvitation, normalizeEmail, revokeStaffInvitation } from "@/lib/invitations";

// Everything here is agency-only: each action checks requireAgencyStaff itself,
// since Server Actions can be called directly, not just from the dashboard form.

export type FormState = { error?: string; url?: string; email?: string };

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function createClientAction(_prev: FormState, form: FormData): Promise<FormState> {
  await requireAgencyStaff();
  const name = String(form.get("name") ?? "").trim();
  const ghlLocationId = String(form.get("ghlLocationId") ?? "").trim() || null;
  const ghlToken = String(form.get("ghlToken") ?? "").trim();
  const slug = slugify(name);
  if (!name || !slug) return { error: "Enter the client's business name." };

  const clash = await db
    .select({ slug: clients.slug, loc: clients.ghlLocationId })
    .from(clients)
    .where(ghlLocationId ? or(eq(clients.slug, slug), eq(clients.ghlLocationId, ghlLocationId)) : eq(clients.slug, slug));
  if (clash.some((c) => c.slug === slug)) return { error: "A client with that name already exists." };
  if (clash.length) return { error: "Another client already uses that GHL location ID." };

  const [client] = await db
    .insert(clients)
    .values({ name, slug, ghlLocationId, ghlTokenEnc: ghlToken ? encrypt(ghlToken) : null })
    .returning({ id: clients.id });
  revalidatePath("/dashboard");
  redirect(`/dashboard/clients/${client.id}`);
}

export async function inviteStaffAction(_prev: FormState, form: FormData): Promise<FormState> {
  const session = await requireAgencyStaff();
  const email = String(form.get("email") ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "Enter a valid email address." };

  const [already] = await db
    .select({ id: agencyStaff.userId })
    .from(agencyStaff)
    .innerJoin(user, eq(agencyStaff.userId, user.id))
    .where(eq(user.email, normalizeEmail(email)));
  if (already) return { error: "That person is already agency staff." };

  const { url } = await createInvitation({
    email,
    clientId: null,
    role: "viewer", // unused for staff invites; staff act as owner everywhere
    agencyStaff: true,
    invitedBy: session.user.id,
  });
  revalidatePath("/dashboard");
  return { url, email: normalizeEmail(email) };
}

export async function removeStaffAction(form: FormData) {
  const session = await requireAgencyStaff();
  const userId = String(form.get("userId") ?? "");
  // Nobody removes themselves, so the agency always keeps at least one staff member.
  if (userId && userId !== session.user.id) {
    await db.delete(agencyStaff).where(eq(agencyStaff.userId, userId));
  }
  revalidatePath("/dashboard");
}

export async function revokeStaffInviteAction(form: FormData) {
  await requireAgencyStaff();
  await revokeStaffInvitation(String(form.get("inviteId") ?? ""));
  revalidatePath("/dashboard");
}
