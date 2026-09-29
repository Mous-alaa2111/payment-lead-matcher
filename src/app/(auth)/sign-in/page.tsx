import { AuthForm } from "../auth-form";

export default async function SignInPage(props: PageProps<"/sign-in">) {
  const { redirect } = await props.searchParams;
  // Only allow same-site relative paths to avoid an open redirect.
  const redirectTo =
    typeof redirect === "string" && /^\/(?![/\\])/.test(redirect)
      ? redirect
      : "/dashboard";
  return <AuthForm mode="sign-in" redirectTo={redirectTo} />;
}
