// MANUAL SEED, not the real Connect flow. Stores a Stripe secret key from the
// GHL CLI .env as an existing client's Stripe connection (scope="manual-seed"),
// so Stripe sync and matching can be proven before the Connect app exists.
// Sync reads a seeded connection with its own key instead of the platform key.
//
//   npx tsx scripts/e2e-db.ts npx tsx scripts/seed-manual-stripe.ts --client essential-auto-werks
//   ... --key-var STRIPE_TEST_SECRET_KEY (default)
//
// Refuses to write to the database in .env.local (production) unless
// --production is passed. Nothing secret is printed.
import { config, parse } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

config({ path: ".env.local", quiet: true }); // TOKEN_ENCRYPTION_KEY; DATABASE_URL only if not already set

const GHL_ENV =
  "C:\\Users\\Quantum Technology\\Downloads\\GHL\\gohighlevel-cli-main\\leadgenjay-gohighlevel-cli-d8331d3f5b8553eb76e9e3d7b3db1264d74b4832\\.env";

const { values } = parseArgs({
  options: {
    client: { type: "string" },
    "key-var": { type: "string", default: "STRIPE_TEST_SECRET_KEY" },
    "env-file": { type: "string", default: GHL_ENV },
    production: { type: "boolean", default: false },
  },
});

const endpoint = (url: string) => new URL(url).hostname.replace("-pooler", "");

async function main() {
  if (!values.client) throw new Error("--client <slug> is required");
  const prodUrl = parse(readFileSync(".env.local")).DATABASE_URL;
  const target = endpoint(process.env.DATABASE_URL!);
  if (endpoint(prodUrl) === target && !values.production) {
    throw new Error("Target is the production database (.env.local). Run via scripts/e2e-db.ts, or pass --production.");
  }
  if (!existsSync(values["env-file"]!)) throw new Error(`Credentials file not found: ${values["env-file"]}`);
  const key = parse(readFileSync(values["env-file"]!))[values["key-var"]!]?.trim();
  if (!key) throw new Error(`${values["key-var"]} is missing from ${values["env-file"]}`);

  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { clients, paymentConnections } = await import("../src/db/schema");
  const { encrypt } = await import("../src/lib/crypto");
  const { StripeApi } = await import("../src/lib/sync/stripe");

  const account = await new StripeApi(key, null).accountInfo();
  const livemode = /^(sk|rk)_live_/.test(key);
  console.log(`Target database: ${target}`);
  console.log(`Stripe key OK: account ${account.id} (${account.business_profile?.name ?? "no name"}), ${livemode ? "LIVE" : "test"} mode`);

  const [client] = await db.select().from(clients).where(eq(clients.slug, values.client));
  if (!client) throw new Error(`No client with slug ${values.client}`);
  const conn = {
    clientId: client.id,
    provider: "stripe" as const,
    externalAccountId: account.id,
    accessTokenEnc: encrypt(key),
    refreshTokenEnc: null,
    tokenExpiresAt: null,
    scope: "manual-seed",
    livemode,
    lastSyncError: null,
  };
  await db
    .insert(paymentConnections)
    .values(conn)
    .onConflictDoUpdate({ target: [paymentConnections.clientId, paymentConnections.provider], set: conn });
  console.log(`Stripe connection stored for ${client.name} (${client.id}), scope=manual-seed`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err.message);
    process.exit(1);
  },
);
