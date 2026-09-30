"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { createClientAction, inviteStaffAction, type FormState } from "./actions";

const input = "rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700";
const primary = "whitespace-nowrap rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-zinc-900";

export function NewClientForm() {
  const [state, formAction, pending] = useActionState<FormState, FormData>(createClientAction, {});
  return (
    <form action={formAction} className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input name="name" required placeholder="Business name" className={`flex-1 ${input}`} />
        <input name="ghlLocationId" placeholder="GHL location ID (optional)" className={`flex-1 ${input}`} />
        <input
          name="ghlToken"
          type="password"
          autoComplete="off"
          placeholder="GHL private integration token (optional)"
          className={`flex-1 ${input}`}
        />
        <SubmitButton busy={pending} pendingText="Creating…" className={primary}>
          Create client
        </SubmitButton>
      </div>
      <p className="text-xs text-zinc-500">
        The GHL location and token are needed for matching; you can add the client first and fill them in later.
      </p>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
    </form>
  );
}

export function StaffInviteForm() {
  const [state, formAction, pending] = useActionState<FormState, FormData>(inviteStaffAction, {});
  return (
    <form action={formAction} className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input name="email" type="email" required placeholder="name@elkocreative.com" className={`flex-1 ${input}`} />
        <SubmitButton busy={pending} pendingText="Creating…" className={primary}>
          Invite agency staff
        </SubmitButton>
      </div>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      {state.url && (
        <div className="rounded-md bg-zinc-100 p-3 text-sm dark:bg-zinc-800">
          <p className="mb-1">
            Agency invite link for <strong>{state.email}</strong> (expires in 7 days, shown once):
          </p>
          <code className="block break-all">{state.url}</code>
        </div>
      )}
    </form>
  );
}
