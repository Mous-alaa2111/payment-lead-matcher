import { and, asc, eq, gt, isNull } from "drizzle-orm";
import Link from "next/link";
import { SubmitButton } from "@/components/submit-button";
import { db } from "@/db";
import { agencyStaff, clientMembers, clients, invitations, user } from "@/db/schema";
import { isAgencyStaff, requireSession } from "@/lib/access";
import { removeStaffAction, revokeStaffInviteAction } from "./actions";
import { NewClientForm, StaffInviteForm } from "./agency-forms";
import { SignOutButton } from "./sign-out-button";

const card = "space-y-3 rounded-xl border border-panel-border bg-panel p-5 shadow-sm";
const list = "divide-y divide-panel-border rounded-lg border border-panel-border";
const smallButton =
  "rounded-md border px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800";

export default async function DashboardPage() {
  const session = await requireSession();
  const agency = await isAgencyStaff(session.user.id);

  // Agency staff see every client; everyone else only the clients they belong to.
  const myClients = agency
    ? (await db.select({ id: clients.id, name: clients.name }).from(clients).orderBy(asc(clients.name))).map((c) => ({
        ...c,
        role: null,
      }))
    : await db
        .select({ id: clients.id, name: clients.name, role: clientMembers.role })
        .from(clientMembers)
        .innerJoin(clients, eq(clientMembers.clientId, clients.id))
        .where(eq(clientMembers.userId, session.user.id))
        .orderBy(asc(clients.name));

  const [staff, staffInvites] = agency
    ? await Promise.all([
        db
          .select({ id: user.id, name: user.name, email: user.email })
          .from(agencyStaff)
          .innerJoin(user, eq(agencyStaff.userId, user.id))
          .orderBy(asc(user.name)),
        db
          .select({ id: invitations.id, email: invitations.email })
          .from(invitations)
          .where(
            and(eq(invitations.agencyStaff, true), isNull(invitations.acceptedAt), gt(invitations.expiresAt, new Date())),
          ),
      ])
    : [[], []];

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-zinc-500">
            Signed in as {session.user.email}
            {agency && " · Agency staff"}
          </p>
        </div>
        <SignOutButton />
      </header>

      <section className={agency ? card : undefined}>
        <h2 className="mb-2 font-medium">{agency ? "All clients" : "Your clients"}</h2>
        {myClients.length === 0 ? (
          <p className="text-sm text-zinc-500">
            {agency ? "No clients yet. Create the first one below." : "You haven't been added to any clients yet."}
          </p>
        ) : (
          <ul className={agency ? list : `${list} bg-panel shadow-sm`}>
            {myClients.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/dashboard/clients/${c.id}`}
                  className="flex justify-between px-4 py-3 text-sm hover:bg-brand-soft"
                >
                  <span>{c.name}</span>
                  {c.role && <span className="text-zinc-500">{c.role}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {agency && (
          <div className="space-y-2 pt-2">
            <h3 className="text-sm font-medium">New client</h3>
            <NewClientForm />
          </div>
        )}
      </section>

      {agency && (
        <section className={card}>
          <div>
            <h2 className="font-medium">Agency team</h2>
            <p className="text-sm text-zinc-500">
              Agency staff can see and manage every client. They don&apos;t appear in a client&apos;s Team list.
            </p>
          </div>
          <ul className={list}>
            {staff.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                <span>
                  {s.name} <span className="text-zinc-500">· {s.email}</span>
                </span>
                {s.id === session.user.id ? (
                  <span className="text-zinc-500">you</span>
                ) : (
                  <form action={removeStaffAction}>
                    <input type="hidden" name="userId" value={s.id} />
                    <SubmitButton className={smallButton}>Remove</SubmitButton>
                  </form>
                )}
              </li>
            ))}
            {staffInvites.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm text-zinc-500">
                <span>{i.email} · invited</span>
                <form action={revokeStaffInviteAction}>
                  <input type="hidden" name="inviteId" value={i.id} />
                  <SubmitButton className={smallButton}>Revoke</SubmitButton>
                </form>
              </li>
            ))}
          </ul>
          <StaffInviteForm />
        </section>
      )}
    </main>
  );
}
