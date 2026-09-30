// Sync one client's connected payment accounts from the command line (same code
// as the dashboard's Sync now / Sync range). No time limit, so it suits big backfills.
//   npx tsx scripts/e2e-db.ts npm run sync -- --client 417-details
//   npx tsx scripts/e2e-db.ts npm run sync -- --client 417-details --from 2015-01-01 --to 2026-09-30
//   ... --provider stripe        only one provider (default: every connected one)
import { config } from "dotenv";
import { parseArgs } from "node:util";

config({ path: ".env.local", quiet: true });

const { values } = parseArgs({
  options: { client: { type: "string" }, from: { type: "string" }, to: { type: "string" }, provider: { type: "string" } },
});

async function main() {
  if (!values.client) throw new Error("--client <slug> is required");
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { clients } = await import("../src/db/schema");
  const { PROVIDER_NAME, syncClient, syncPayments } = await import("../src/lib/sync");
  const { formatDay, parseRange } = await import("../src/lib/sync/window");

  let range;
  if (values.from || values.to) {
    const parsed = parseRange(values.from ?? "", values.to ?? "");
    if ("error" in parsed) throw new Error(parsed.error);
    range = parsed;
  }
  const [client] = await db.select().from(clients).where(eq(clients.slug, values.client));
  if (!client) throw new Error(`No client with slug ${values.client}`);
  if (values.provider && values.provider !== "stripe" && values.provider !== "square") {
    throw new Error("--provider must be stripe or square");
  }
  const started = Date.now();
  const results = values.provider
    ? [{ provider: values.provider as "stripe" | "square", summary: await syncPayments(client.id, values.provider as "stripe" | "square", range) }]
    : await syncClient(client.id, range);
  if (!results.length) throw new Error(`${client.name} has no connected payment accounts`);
  for (const { provider, summary: s, error } of results as { provider: "stripe" | "square"; summary?: Awaited<ReturnType<typeof syncPayments>>; error?: string }[]) {
    if (!s) {
      console.log(`${client.name} / ${PROVIDER_NAME[provider]}: FAILED: ${error}`);
      process.exitCode = 1;
      continue;
    }
    console.log(
      `${client.name} / ${PROVIDER_NAME[provider]} [${s.window.kind} ${formatDay(s.window.start)}..${s.window.end.toISOString().slice(0, 16)}]: ` +
        `${s.payments} payments vs ${s.contacts} GHL contacts -> ${s.matched} matched, ${s.ambiguous} ambiguous, ` +
        `${s.noMatch} no match; ${s.rematched} older rows re-matched`,
    );
  }
  console.log(`(${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
