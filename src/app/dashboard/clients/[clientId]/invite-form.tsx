"use client";

import { useActionState } from "react";
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
        <button
          disabled={pending}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
        >
          {pending ? "Creating…" : "Create invite"}
        </button>
      </div>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      {state.url && (
        <div className="rounded-md bg-zinc-100 p-3 text-sm dark:bg-zinc-800">
          <p className="mb-1">
            Invite link for <strong>{state.email}</strong> (expires in 7 days, shown once):
          </p>
          <code className="block break-all">{state.url}</code>
        </div>
      )}
    </form>
  );
}
