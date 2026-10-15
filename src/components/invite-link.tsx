import type { InviteEmailStatus } from "@/lib/invite-email";

// Shown after creating an invite: whether the email went out, then the link
// itself (always, so it can be copied even when email isn't set up).
export function InviteLink({
  label,
  email,
  url,
  emailStatus,
}: {
  label: string;
  email: string;
  url: string;
  emailStatus?: InviteEmailStatus;
}) {
  return (
    <div className="space-y-2 rounded-md bg-zinc-100 p-3 text-sm dark:bg-zinc-800">
      {emailStatus === "sent" && (
        <p className="font-medium">
          Email sent to <strong>{email}</strong>.
        </p>
      )}
      {(emailStatus === "failed" || emailStatus === "rate_limited") && (
        <p className="font-medium text-red-700 dark:text-red-400">Email couldn&apos;t be sent, copy the link below.</p>
      )}
      <div>
        <p className="mb-1">
          {label} for <strong>{email}</strong> (expires in 7 days, shown once):
        </p>
        <code className="block break-all">{url}</code>
      </div>
    </div>
  );
}
