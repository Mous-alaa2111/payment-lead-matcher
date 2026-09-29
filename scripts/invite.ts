// Create an invite link from the command line (bootstrap / agency use).
//
//   npm run invite -- --email you@agency.com --client "Essential Auto Werks" --role owner
//   npm run invite -- --email you@agency.com --client "Essential Auto Werks" --ghl-location sZ3v1n2QPco50eNiBkN4
//   npm run invite -- --email someone@x.com            (account only, no client)
//
// --client creates the client if no client with that slug exists yet.
import { config } from "dotenv";
import { parseArgs } from "node:util";

config({ path: ".env.local", quiet: true });

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    client: { type: "string" },
    slug: { type: "string" },
    "ghl-location": { type: "string" },
    role: { type: "string", default: "owner" },
  },
});

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function main() {
  if (!values.email) throw new Error("--email is required");
  const role = values.role as "owner" | "admin" | "viewer";
  if (!["owner", "admin", "viewer"].includes(role)) throw new Error("--role must be owner, admin or viewer");

  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { clients } = await import("../src/db/schema");
  const { createInvitation } = await import("../src/lib/invitations");

  let clientId: string | null = null;
  if (values.client) {
    const slug = values.slug ?? slugify(values.client);
    const [existing] = await db.select().from(clients).where(eq(clients.slug, slug));
    const client =
      existing ??
      (
        await db
          .insert(clients)
          .values({ name: values.client, slug, ghlLocationId: values["ghl-location"] ?? null })
          .returning()
      )[0];
    console.log(`${existing ? "Using existing" : "Created"} client: ${client.name} (${client.id})`);
    clientId = client.id;
  }

  const { invite, url } = await createInvitation({ email: values.email, clientId, role, invitedBy: null });
  console.log(`Invite for ${invite.email}${clientId ? ` as ${role}` : ""}, expires ${invite.expiresAt.toISOString()}`);
  console.log(url);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
