import { redirect } from "next/navigation";
import { getSession } from "@/lib/access";

// No public landing page: send people straight into the app.
export default async function Home() {
  const session = await getSession();
  redirect(session ? "/dashboard" : "/sign-in");
}
