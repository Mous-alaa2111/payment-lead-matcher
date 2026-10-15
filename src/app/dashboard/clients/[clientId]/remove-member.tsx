"use client";

import { useRef } from "react";
import { SubmitButton } from "@/components/submit-button";
import { removeMemberAction } from "./actions";

// "Remove" on an accepted Team member, behind a confirmation dialog like Remove client.
export function RemoveMember({
  clientId,
  clientName,
  userId,
  name,
}: {
  clientId: string;
  clientName: string;
  userId: string;
  name: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = `remove-member-${userId}`;
  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        className="rounded-md border px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        Remove
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        className="m-auto w-[min(28rem,calc(100%-2rem))] rounded-xl border border-panel-border bg-panel p-6 text-foreground shadow-xl backdrop:bg-black/60"
      >
        <h2 id={titleId} className="text-lg font-semibold">
          Remove {name} from {clientName}?
        </h2>
        <p className="mt-2 text-sm">They will lose access to this client. Their login stays.</p>
        <form action={removeMemberAction.bind(null, clientId)} className="mt-5 flex justify-end gap-2">
          <input type="hidden" name="userId" value={userId} />
          <button
            type="button"
            autoFocus
            onClick={() => dialog.current?.close()}
            className="rounded-md border px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <SubmitButton
            pendingText="Removing…"
            className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800"
          >
            Remove
          </SubmitButton>
        </form>
      </dialog>
    </>
  );
}
