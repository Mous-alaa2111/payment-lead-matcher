"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { signIn, signUp } from "@/lib/auth-client";
import { INVITE_TOKEN_HEADER } from "@/lib/constants";

type Props =
  | { mode: "sign-in"; redirectTo: string }
  | { mode: "sign-up"; inviteToken: string; email: string; subtitle?: string };

export function AuthForm(props: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isSignUp = props.mode === "sign-up";

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(e.currentTarget);
    const password = String(form.get("password"));

    const { error } =
      props.mode === "sign-up"
        ? await signUp.email(
            { email: props.email, password, name: String(form.get("name")) },
            { headers: { [INVITE_TOKEN_HEADER]: props.inviteToken } },
          )
        : await signIn.email({ email: String(form.get("email")), password });

    setPending(false);
    if (error) {
      setError(error.message ?? "Something went wrong");
      return;
    }
    router.push(props.mode === "sign-in" ? props.redirectTo : "/dashboard");
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
      >
        <div>
          <h1 className="text-xl font-semibold">{isSignUp ? "Create your account" : "Sign in"}</h1>
          {props.mode === "sign-up" && props.subtitle && (
            <p className="mt-1 text-sm text-zinc-500">{props.subtitle}</p>
          )}
        </div>

        {props.mode === "sign-up" ? (
          <>
            <Field label="Name" name="name" type="text" autoComplete="name" />
            <Field label="Email" name="email" type="email" value={props.email} readOnly disabled />
          </>
        ) : (
          <Field label="Email" name="email" type="email" autoComplete="email" />
        )}
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete={isSignUp ? "new-password" : "current-password"}
          minLength={isSignUp ? 10 : undefined}
        />

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
        >
          {pending ? "Please wait…" : isSignUp ? "Create account" : "Sign in"}
        </button>

        {!isSignUp && (
          <p className="text-center text-sm text-zinc-500">
            Access is by invitation. Ask your account manager for an invite link.
          </p>
        )}
      </form>
    </main>
  );
}

function Field(props: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const { label, ...input } = props;
  return (
    <label className="block space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      <input
        required
        {...input}
        className="w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 disabled:opacity-60 dark:border-zinc-700"
      />
    </label>
  );
}
