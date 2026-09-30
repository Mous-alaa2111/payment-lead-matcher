"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { useFormStatus } from "react-dom";

// Buttons currently in flight; while any are, <html data-busy> shows a progress cursor page-wide.
let busyCount = 0;

export function useBusyCursor(busy: boolean) {
  useEffect(() => {
    if (!busy) return;
    if (busyCount++ === 0) document.documentElement.dataset.busy = "";
    return () => {
      if (--busyCount === 0) delete document.documentElement.dataset.busy;
    };
  }, [busy]);
}

export function Spinner() {
  return (
    <svg className="size-3.5 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Submit button that shows a spinner and disables itself while its form is in flight.
 * Covers Server Action forms (via useFormStatus) and plain HTML form posts that
 * navigate away, like the OAuth "Connect" forms.
 */
export function SubmitButton({
  pendingText,
  busy: busyProp = false,
  disabled,
  className = "",
  children,
  ...props
}: ComponentProps<"button"> & { pendingText?: string; busy?: boolean }) {
  const { pending } = useFormStatus();
  const [navigating, setNavigating] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const onSubmit = (e: SubmitEvent) => {
      if (e.submitter !== ref.current) return;
      // React cancels the native submit for Server Action forms; only a real post navigates.
      setTimeout(() => !e.defaultPrevented && setNavigating(true));
    };
    // Coming back via the back/forward cache restores the busy state; clear it.
    const onPageShow = () => setNavigating(false);
    form.addEventListener("submit", onSubmit);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      form.removeEventListener("submit", onSubmit);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  const busy = busyProp || pending || navigating;
  useBusyCursor(busy);

  return (
    <button
      ref={ref}
      type="submit"
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex items-center justify-center gap-2 transition-opacity disabled:opacity-50 ${className}`}
      {...props}
    >
      {busy && <Spinner />}
      {busy && pendingText ? pendingText : children}
    </button>
  );
}
