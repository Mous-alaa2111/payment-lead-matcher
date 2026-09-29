// Run a Square sync for one client from the command line (same code as the
// dashboard's Sync now / Sync range). No time limit, so it suits big backfills.
//   npx tsx scripts/e2e-db.ts npm run sync -- --client 417-details
//   npx tsx scripts/e2e-db.ts npm run sync -- --client 417-details --from 2015-01-01 --to 2026-09-30
import { config } from "dotenv";
import { parseArgs } from "node:util";

config({ path: ".env.local", quiet: true });

const { values } = parseArgs({ options: { client: { type: "string" }, from: { type: "string" }, to: { type: "string" } } });

async function main() {
  if (!values.client) throw new Error("--client <slug> is required");
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { clients } = await import("../src/db/schema");
  const { syncSquare } = await import("../src/lib/sync");
  const { formatDay, parseRange } = await import("../src/lib/sync/window");

  let range;
  if (values.from || values.to) {
    const parsed = parseRange(values.from ?? "", values.to ?? "");
    if ("error" in parsed) throw new Error(parsed.error);
    range = parsed;
  }
  const [client] = await db.select().from(clients).where(eq(clients.slug, values.client));
  if (!client) throw new Error(`No client with slug ${values.client}`);
  const started = Date.now();
  const s = await syncSquare(client.id, range);
  console.log(
    `${client.name} [${s.window.kind} ${formatDay(s.window.start)}..${s.window.end.toISOString().slice(0, 16)}]: ` +
      `${s.payments} payments vs ${s.contacts} GHL contacts -> ${s.matched} matched, ${s.ambiguous} ambiguous, ` +
      `${s.noMatch} no match; ${s.rematched} older rows re-matched (${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
