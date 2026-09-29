// Run a Square sync for one client from the command line (same code as the
// dashboard's "Sync now" button).
//   npx tsx scripts/e2e-db.ts npm run sync -- --client 417-details
import { config } from "dotenv";
import { parseArgs } from "node:util";

config({ path: ".env.local", quiet: true });

const { values } = parseArgs({ options: { client: { type: "string" } } });

async function main() {
  if (!values.client) throw new Error("--client <slug> is required");
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { clients } = await import("../src/db/schema");
  const { syncSquare } = await import("../src/lib/sync");

  const [client] = await db.select().from(clients).where(eq(clients.slug, values.client));
  if (!client) throw new Error(`No client with slug ${values.client}`);
  const started = Date.now();
  const s = await syncSquare(client.id);
  console.log(
    `${client.name}: ${s.payments} payments vs ${s.contacts} GHL contacts -> ` +
      `${s.matched} matched, ${s.ambiguous} ambiguous, ${s.noMatch} no match (${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
