"use client";

import { useRef } from "react";
import { SubmitButton } from "@/components/submit-button";
import { removeClientAction } from "./actions";

const danger =
  "rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40";

// Agency-only "Remove client", behind a confirmation dialog that spells out
// exactly what gets deleted, so a misclick can't wipe a client.
export function RemoveClient({ clientId, clientName, deletes }: { clientId: string; clientName: string; deletes: string[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" onClick={() => dialog.current?.showModal()} className={danger}>
        Remove client
      </button>
      <dialog
        ref={dialog}
        aria-labelledby="remove-client-title"
        className="m-auto w-[min(28rem,calc(100%-2rem))] rounded-xl border border-panel-border bg-panel p-6 text-foreground shadow-xl backdrop:bg-black/60"
      >
        <h2 id="remove-client-title" className="text-lg font-semibold">
          Remove {clientName}?
        </h2>
        <p className="mt-2 text-sm">This can&apos;t be undone. It permanently deletes:</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          {deletes.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
          Nothing is deleted in GHL, Stripe or Square, and team members keep their logins.
        </p>
        <form action={removeClientAction.bind(null, clientId)} className="mt-5 flex justify-end gap-2">
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
            Remove client
          </SubmitButton>
        </form>
      </dialog>
    </>
  );
}
