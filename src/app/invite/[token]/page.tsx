import { eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/app/(auth)/auth-form";
import { SubmitButton } from "@/components/submit-button";
import { db } from "@/db";
import { clients, user } from "@/db/schema";
import { getSession } from "@/lib/access";
import { acceptInvitation, findPendingInvitation } from "@/lib/invitations";

export default async function InvitePage(props: PageProps<"/invite/[token]">) {
  const { token } = await props.params;
  const invite = await findPendingInvitation(token);

  if (!invite) {
    return (
      <Shell title="Invite not valid">
        <p>This invite link is invalid, expired, or has already been used. Ask whoever invited you for a new one.</p>
        <Link href="/sign-in" className="underline">Go to sign in</Link>
      </Shell>
    );
  }

  const [client] = invite.clientId
    ? await db.select({ name: clients.name }).from(clients).where(eq(clients.id, invite.clientId))
    : [];
  const what = client ? `${client.name} (${invite.role})` : "Payment Lead Matcher";

  const session = await getSession();
  if (session) {
    if (session.user.email.toLowerCase() !== invite.email) {
      return (
        <Shell title="Wrong account">
          <p>
            You&apos;re signed in as <strong>{session.user.email}</strong>, but this invite is for{" "}
            <strong>{invite.email}</strong>. Sign out, then open the link again.
          </p>
        </Shell>
      );
    }
    async function accept() {
      "use server";
      const s = await getSession();
      if (!s) redirect(`/sign-in?redirect=/invite/${token}`);
      const result = await acceptInvitation(token, s.user);
      redirect(result.ok && result.clientId ? `/dashboard/clients/${result.clientId}` : "/dashboard");
    }
    return (
      <Shell title="Accept invite">
        <p>You&apos;ve been invited to <strong>{what}</strong>.</p>
        <form action={accept}>
          <SubmitButton pendingText="Accepting…" className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-zinc-900">
            Accept
          </SubmitButton>
        </form>
      </Shell>
    );
  }

  const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, invite.email));
  if (existing) {
    return (
      <Shell title="Sign in to accept">
        <p>You&apos;ve been invited to <strong>{what}</strong>. You already have an account, so sign in to accept.</p>
        <Link href={`/sign-in?redirect=/invite/${token}`} className="underline">Sign in</Link>
      </Shell>
    );
  }

  return (
    <AuthForm
      mode="sign-up"
      inviteToken={token}
      email={invite.email}
      subtitle={`You've been invited to ${what}.`}
    />
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-zinc-200 bg-white p-6 text-sm shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-xl font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  );
}
