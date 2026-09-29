import { redirect } from "next/navigation";

// Sign-up is invite-only; new accounts are created from /invite/[token].
export default function SignUpPage() {
  redirect("/sign-in");
}
