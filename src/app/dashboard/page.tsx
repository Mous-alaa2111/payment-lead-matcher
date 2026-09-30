import { eq } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { clientMembers, clients } from "@/db/schema";
import { requireSession } from "@/lib/access";
import { SignOutButton } from "./sign-out-button";

export default async function DashboardPage() {
  const session = await requireSession();

  const myClients = await db
    .select({ id: clients.id, name: clients.name, role: clientMembers.role })
    .from(clientMembers)
    .innerJoin(clients, eq(clientMembers.clientId, clients.id))
    .where(eq(clientMembers.userId, session.user.id));

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-zinc-500">Signed in as {session.user.email}</p>
        </div>
        <SignOutButton />
      </header>

      <section>
        <h2 className="mb-2 font-medium">Your clients</h2>
        {myClients.length === 0 ? (
          <p className="text-sm text-zinc-500">You haven&apos;t been added to any clients yet.</p>
        ) : (
          <ul className="divide-y divide-panel-border rounded-xl border border-panel-border bg-panel shadow-sm">
            {myClients.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/dashboard/clients/${c.id}`}
                  className="flex justify-between px-4 py-3 text-sm hover:bg-brand-soft"
                >
                  <span>{c.name}</span>
                  <span className="text-zinc-500">{c.role}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
