"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Spinner, useBusyCursor } from "@/components/submit-button";
import { signOut } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  useBusyCursor(pending);
  return (
    <button
      disabled={pending}
      aria-busy={pending || undefined}
      onClick={async () => {
        setPending(true);
        await signOut();
        router.push("/sign-in");
        router.refresh();
      }}
      className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
    >
      {pending && <Spinner />}
      Sign out
    </button>
  );
}
