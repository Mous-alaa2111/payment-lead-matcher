import { and, desc, eq, gt, isNull } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { clientMembers, invitations, paymentConnections, user } from "@/db/schema";
import { canManage, getMembership, isUuid, requireSession } from "@/lib/access";
import { squareConfigured } from "@/lib/connect/square";
import { stripeConfigured } from "@/lib/connect/stripe";
import { canManageInviteRole } from "@/lib/invitations";
import { disconnectAction, revokeInviteAction } from "./actions";
import { InviteForm } from "./invite-form";

const MESSAGES: Record<string, string> = {
  "connected=stripe": "Stripe account connected.",
  "connected=square": "Square account connected.",
  "cancelled=1": "Connection cancelled.",
  "error=stripe_not_configured": "Stripe Connect isn't configured on the server yet.",
  "error=square_not_configured": "Square OAuth isn't configured on the server yet.",
  "error=stripe_exchange_failed": "Stripe didn't accept the connection. Please try again.",
  "error=square_exchange_failed": "Square didn't accept the connection. Please try again.",
};

const PROVIDERS = [
  { id: "stripe", name: "Stripe", configured: stripeConfigured },
  { id: "square", name: "Square", configured: squareConfigured },
] as const;

export default async function ClientPage(props: PageProps<"/dashboard/clients/[clientId]">) {
  const { clientId } = await props.params;
  const search = await props.searchParams;
  const session = await requireSession();
  if (!isUuid(clientId)) notFound();
  const membership = await getMembership(session.user.id, clientId);
  if (!membership) notFound(); // don't reveal whether the client exists
  const { client, role } = membership;
  const manage = canManage(role);

  const [connections, members, pendingInvites] = await Promise.all([
    db.select().from(paymentConnections).where(eq(paymentConnections.clientId, clientId)),
    db
      .select({ name: user.name, email: user.email, role: clientMembers.role })
      .from(clientMembers)
      .innerJoin(user, eq(clientMembers.userId, user.id))
      .where(eq(clientMembers.clientId, clientId)),
    manage
      ? db
          .select({ id: invitations.id, email: invitations.email, role: invitations.role })
          .from(invitations)
          .where(
            and(
              eq(invitations.clientId, clientId),
              isNull(invitations.acceptedAt),
              gt(invitations.expiresAt, new Date()),
            ),
          )
          .orderBy(desc(invitations.createdAt))
      : Promise.resolve([]),
  ]);

  const flash = Object.entries(search)
    .map(([k, v]) => MESSAGES[`${k}=${v}`] ?? (k === "error" ? `Something went wrong (${v}).` : null))
    .find(Boolean);

  return (
    <main className="mx-auto max-w-3xl space-y-8 px-4 py-10">
      <header>
        <Link href="/dashboard" className="text-sm text-zinc-500 hover:underline">
          ← All clients
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{client.name}</h1>
        <p className="text-sm text-zinc-500">Your role: {role}</p>
      </header>

      {flash && <p className="rounded-md border px-4 py-2 text-sm">{flash}</p>}

      <section className="space-y-3">
        <h2 className="font-medium">Payment accounts</h2>
        <ul className="divide-y rounded-lg border">
          {PROVIDERS.map((p) => {
            const conn = connections.find((c) => c.provider === p.id);
            return (
              <li key={p.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                <div>
                  <p className="font-medium">{p.name}</p>
                  <p className="text-zinc-500">
                    {conn
                      ? `Connected · ${conn.externalAccountId}${conn.livemode ? "" : " (test mode)"}`
                      : "Not connected"}
                  </p>
                </div>
                {manage &&
                  (conn ? (
                    <form action={disconnectAction}>
                      <input type="hidden" name="clientId" value={clientId} />
                      <input type="hidden" name="provider" value={p.id} />
                      <button className="rounded-md border px-3 py-1.5">Disconnect</button>
                    </form>
                  ) : (
                    <form action={`/api/connect/${p.id}/start`} method="post">
                      <input type="hidden" name="clientId" value={clientId} />
                      <button
                        disabled={!p.configured()}
                        title={p.configured() ? undefined : `${p.name} OAuth isn't configured on the server`}
                        className="rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-white disabled:opacity-40 dark:bg-white dark:text-zinc-900"
                      >
                        Connect {p.name}
                      </button>
                    </form>
                  ))}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">Team</h2>
        <ul className="divide-y rounded-lg border">
          {members.map((m) => (
            <li key={m.email} className="flex justify-between px-4 py-3 text-sm">
              <span>
                {m.name} <span className="text-zinc-500">· {m.email}</span>
              </span>
              <span className="text-zinc-500">{m.role}</span>
            </li>
          ))}
          {pendingInvites.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm text-zinc-500">
              <span>{i.email} · invited</span>
              <span className="flex items-center gap-3">
                {i.role}
                {canManageInviteRole(role, i.role) && (
                  <form action={revokeInviteAction}>
                    <input type="hidden" name="clientId" value={clientId} />
                    <input type="hidden" name="inviteId" value={i.id} />
                    <button className="rounded-md border px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800">
                      Revoke
                    </button>
                  </form>
                )}
              </span>
            </li>
          ))}
        </ul>
        {manage && <InviteForm clientId={clientId} canInviteOwner={role === "owner"} />}
      </section>
    </main>
  );
}
