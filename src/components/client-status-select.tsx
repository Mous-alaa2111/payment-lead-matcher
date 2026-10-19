"use client";

import { useEffect, useState, useTransition } from "react";
import { setClientStatusAction } from "@/app/dashboard/clients/[clientId]/actions";
import { CLIENT_STATUSES, CLIENT_STATUS_LABEL, type ClientStatus } from "@/lib/client-status";
import { Spinner, useBusyCursor } from "@/components/submit-button";

// Agency staff's client status picker (client page, dashboard, Client Health).
// Saves on change through setClientStatusAction. The action doesn't refresh the
// page, so a client that no longer fits the Health filter keeps its row until
// reload and a misclick can be undone in place. A failed save puts the picker
// back on the stored status.
export function ClientStatusSelect({
  clientId,
  clientName,
  status,
  label,
}: {
  clientId: string;
  clientName: string;
  status: ClientStatus;
  label?: string;
}) {
  const [saved, setSaved] = useState(status);
  const [value, setValue] = useState(status);
  const [result, setResult] = useState<"saved" | "error" | null>(null);
  const [pending, startTransition] = useTransition();
  const action = setClientStatusAction.bind(null, clientId);
  useBusyCursor(pending);

  useEffect(() => {
    if (result !== "saved") return;
    const t = setTimeout(() => setResult(null), 2500);
    return () => clearTimeout(t);
  }, [result]);

  const save = (next: ClientStatus) => {
    setValue(next);
    setResult(null);
    const form = new FormData();
    form.set("status", next);
    startTransition(async () => {
      try {
        await action(form);
        setSaved(next);
        setResult("saved");
      } catch {
        setValue(saved);
        setResult("error");
      }
    });
  };

  const id = `client-status-${clientId}`;
  return (
    <form action={action} data-client-status={clientId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {label && (
        <label htmlFor={id} className="text-zinc-500">
          {label}
        </label>
      )}
      <select
        id={id}
        name="status"
        value={value}
        disabled={pending}
        aria-label={label ? undefined : `Status for ${clientName}`}
        onChange={(e) => save(e.target.value as ClientStatus)}
        className="rounded-md border border-zinc-300 bg-transparent px-2 py-1 disabled:opacity-60 dark:border-zinc-700"
      >
        {CLIENT_STATUSES.map((s) => (
          <option key={s} value={s}>
            {CLIENT_STATUS_LABEL[s]}
          </option>
        ))}
      </select>
      <span aria-live="polite" className="inline-flex items-center gap-1 text-xs">
        {pending ? (
          <Spinner />
        ) : result === "saved" ? (
          <span className="text-teal-700 dark:text-teal-400">Saved</span>
        ) : result === "error" ? (
          <span className="text-red-700 dark:text-red-400">Couldn&apos;t save. Try again.</span>
        ) : null}
      </span>
    </form>
  );
}
