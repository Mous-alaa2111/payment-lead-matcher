import { and, count, desc, eq, gt, isNull } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { clientMembers, invitations, paymentConnections, paymentMatches, user } from "@/db/schema";
import { canManage, getMembership, isUuid, requireSession } from "@/lib/access";
import { squareConfigured } from "@/lib/connect/square";
import { stripeConfigured } from "@/lib/connect/stripe";
import { canManageInviteRole } from "@/lib/invitations";
import { disconnectAction, revokeInviteAction, syncAction } from "./actions";
import { InviteForm } from "./invite-form";

const MESSAGES: Record<string, string> = {
  "connected=stripe": "Stripe account connected.",
  "connected=square": "Square account connected.",
  "cancelled=1": "Connection cancelled.",
  "error=stripe_not_configured": "Stripe Connect isn't configured on the server yet.",
  "error=square_not_configured": "Square OAuth isn't configured on the server yet.",
  "error=stripe_exchange_failed": "Stripe didn't accept the connection. Please try again.",
  "error=square_exchange_failed": "Square didn't accept the connection. Please try again.",
  "synced=1": "Sync finished.",
  "error=sync_failed": "Sync failed. The error is shown under Payments.",
};

const STATUS_LABEL = {
  matched: { text: "Matched", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
  ambiguous: { text: "Ambiguous", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  no_match: { text: "No match", cls: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" },
} as const;

const PAGE_SIZE = 20;

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(cents / 100);

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

  const [connections, members, pendingInvites, statusCounts] = await Promise.all([
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
    db
      .select({ status: paymentMatches.status, n: count() })
      .from(paymentMatches)
      .where(eq(paymentMatches.clientId, clientId))
      .groupBy(paymentMatches.status),
  ]);
  const square = connections.find((c) => c.provider === "square");

  // Summary counts cover every stored payment; the table shows one page of them.
  const counts = { matched: 0, ambiguous: 0, no_match: 0 };
  for (const c of statusCounts) counts[c.status] = c.n;
  const total = counts.matched + counts.ambiguous + counts.no_match;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(Number(search.page)) || 1), pageCount);
  const matches = total
    ? await db
        .select()
        .from(paymentMatches)
        .where(eq(paymentMatches.clientId, clientId))
        .orderBy(desc(paymentMatches.paidAt), desc(paymentMatches.id))
        .limit(PAGE_SIZE)
        .offset((page - 1) * PAGE_SIZE)
    : [];
  const pageHref = (n: number) => `/dashboard/clients/${clientId}?page=${n}`;

  const flash = Object.entries(search)
    .map(([k, v]) => MESSAGES[`${k}=${v}`] ?? (k === "error" ? `Something went wrong (${v}).` : null))
    .find(Boolean);

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-4 py-10">
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
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-medium">Payments</h2>
            {square && (
              <p className="text-sm text-zinc-500">
                {square.lastSyncedAt ? `Last synced ${square.lastSyncedAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : "Never synced"}
              </p>
            )}
          </div>
          {manage && square && (
            <form action={syncAction}>
              <input type="hidden" name="clientId" value={clientId} />
              <button className="rounded-md border px-3 py-1.5 text-sm">Sync now</button>
            </form>
          )}
        </div>
        {square?.lastSyncError && (
          <p className="rounded-md border border-red-300 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:text-red-400">
            Last sync failed: {square.lastSyncError}
          </p>
        )}
        {matches.length === 0 ? (
          <p className="rounded-lg border px-4 py-3 text-sm text-zinc-500">
            {square ? "No payments synced yet." : "Connect a payment account to see payments here."}
          </p>
        ) : (
          <>
            <p className="text-sm text-zinc-500">
              {total} payments: {counts.matched} matched, {counts.ambiguous} ambiguous,{" "}
              {counts.no_match} with no matching lead.
            </p>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-left text-sm">
                <thead className="border-b text-zinc-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Date</th>
                    <th className="px-4 py-2 text-right font-medium">Amount</th>
                    <th className="px-4 py-2 font-medium">Payer</th>
                    <th className="px-4 py-2 font-medium">Result</th>
                    <th className="px-4 py-2 font-medium">GHL lead</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {matches.map((m) => (
                    <tr key={m.id} className="align-top">
                      <td className="whitespace-nowrap px-4 py-2">{m.paidAt.toISOString().slice(0, 10)}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">
                        {money(m.amountCents, m.currency)}
                        {m.paymentStatus && m.paymentStatus !== "COMPLETED" && (
                          <span className="block text-xs text-zinc-500">{m.paymentStatus.toLowerCase()}</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <span className="block">{m.payerName ?? "—"}</span>
                        <span className="block text-xs text-zinc-500">
                          {[m.payerPhone, m.payerEmail].filter(Boolean).join(" · ") || "no contact details"}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">
                        <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_LABEL[m.status].cls}`}>
                          {STATUS_LABEL[m.status].text}
                        </span>
                        {m.method && <span className="block pt-1 text-xs text-zinc-500">by {m.method}</span>}
                      </td>
                      <td className="px-4 py-2">
                        {m.contacts.map((c) => (
                          <span key={c.id} className="block">
                            {c.name} <span className="text-xs text-zinc-500">{c.id}</span>
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pageCount > 1 && (
              <nav aria-label="Payments pages" className="flex items-center justify-between gap-4 text-sm">
                {page > 1 ? (
                  <Link href={pageHref(page - 1)} scroll={false} className="rounded-md border px-3 py-1.5">
                    ← Previous
                  </Link>
                ) : (
                  <span aria-disabled className="rounded-md border px-3 py-1.5 opacity-40">
                    ← Previous
                  </span>
                )}
                <span className="text-zinc-500">
                  Page {page} of {pageCount} · {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
                </span>
                {page < pageCount ? (
                  <Link href={pageHref(page + 1)} scroll={false} className="rounded-md border px-3 py-1.5">
                    Next →
                  </Link>
                ) : (
                  <span aria-disabled className="rounded-md border px-3 py-1.5 opacity-40">
                    Next →
                  </span>
                )}
              </nav>
            )}
          </>
        )}
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
