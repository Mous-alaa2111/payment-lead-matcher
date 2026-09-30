// Grant or remove agency staff (see and manage every client) for existing accounts.
// For someone without an account yet, use `npm run invite -- --email x --agency`.
//
//   npm run staff -- --list
//   npm run staff -- --add mustafa@example.com
//   npm run staff -- --remove someone@example.com
//   npm run staff -- --add a@x.com --drop-memberships   (also removes their per-client rows)
//
// Uses DATABASE_URL from .env.local (production). Run through scripts/e2e-db.ts for the e2e branch.
import { config } from "dotenv";
import { parseArgs } from "node:util";

config({ path: ".env.local", quiet: true });

const { values } = parseArgs({
  options: {
    list: { type: "boolean", default: false },
    add: { type: "string", multiple: true, default: [] },
    remove: { type: "string", multiple: true, default: [] },
    "drop-memberships": { type: "boolean", default: false },
  },
});

async function main() {
  const { eq, inArray } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { agencyStaff, clientMembers, user } = await import("../src/db/schema");
  const { normalizeEmail } = await import("../src/lib/invitations");

  const findUser = async (email: string) => {
    const [u] = await db.select().from(user).where(eq(user.email, normalizeEmail(email)));
    if (!u) throw new Error(`No account for ${email}. Invite them with: npm run invite -- --email ${email} --agency`);
    return u;
  };

  for (const email of values.add!) {
    const u = await findUser(email);
    await db.insert(agencyStaff).values({ userId: u.id }).onConflictDoNothing();
    console.log(`Agency staff: added ${u.email}`);
    if (values["drop-memberships"]) {
      const dropped = await db.delete(clientMembers).where(eq(clientMembers.userId, u.id)).returning();
      console.log(`  removed ${dropped.length} per-client membership(s); staff access covers every client`);
    }
  }
  for (const email of values.remove!) {
    const u = await findUser(email);
    const gone = await db.delete(agencyStaff).where(eq(agencyStaff.userId, u.id)).returning();
    console.log(gone.length ? `Agency staff: removed ${u.email}` : `${u.email} wasn't agency staff`);
  }

  const rows = await db.select({ userId: agencyStaff.userId }).from(agencyStaff);
  const staff = rows.length
    ? await db.select({ name: user.name, email: user.email }).from(user).where(inArray(user.id, rows.map((r) => r.userId)))
    : [];
  console.log(`\nAgency staff (${staff.length}):`);
  for (const s of staff) console.log(`  ${s.name} <${s.email}>`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err.message);
    process.exit(1);
  },
);
