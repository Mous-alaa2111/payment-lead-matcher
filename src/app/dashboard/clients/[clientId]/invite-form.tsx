"use client";

import { useActionState } from "react";
import { InviteLink } from "@/components/invite-link";
import { SubmitButton } from "@/components/submit-button";
import { inviteAction, type InviteState } from "./actions";

export function InviteForm({ clientId, canInviteOwner }: { clientId: string; canInviteOwner: boolean }) {
  const [state, formAction, pending] = useActionState<InviteState, FormData>(inviteAction, {});

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="clientId" value={clientId} />
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          name="email"
          type="email"
          required
          placeholder="name@business.com"
          className="flex-1 rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
        />
        <select
          name="role"
          defaultValue="viewer"
          className="rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
        >
          <option value="viewer">Viewer</option>
          <option value="admin">Admin</option>
          {canInviteOwner && <option value="owner">Owner</option>}
        </select>
        <SubmitButton
          busy={pending}
          pendingText="Creating…"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-zinc-900"
        >
          Create invite
        </SubmitButton>
      </div>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      {state.url && state.email && (
        <InviteLink label="Invite link" email={state.email} url={state.url} emailStatus={state.emailStatus} />
      )}
    </form>
  );
}
