// ONE-TIME MANUAL SEED, not the real OAuth flow. Stores a Square personal
// access token (and the client's GHL location + PIT) as if the client had
// connected Square, so sync/matching/dashboard can be proven before the Square
// OAuth app exists. The row is marked scope="manual-seed" so it's easy to find
// and remove once the client connects for real.
//
// Reads credentials from the GHL CLI .env; nothing secret is printed.
//   npx tsx scripts/e2e-db.ts npx tsx scripts/seed-manual-square.ts --client "417 Details" --ghl-prefix 417_DETAILS
//
// Refuses to write to the database in .env.local (production) unless
// --production is passed. Tokens are encrypted with this machine's
// TOKEN_ENCRYPTION_KEY, so for production that key must match the app's.
import { config, parse } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

config({ path: ".env.local", quiet: true }); // TOKEN_ENCRYPTION_KEY; DATABASE_URL only if not already set

const GHL_ENV =
  "C:\\Users\\Quantum Technology\\Downloads\\GHL\\gohighlevel-cli-main\\leadgenjay-gohighlevel-cli-d8331d3f5b8553eb76e9e3d7b3db1264d74b4832\\.env";

const { values } = parseArgs({
  options: {
    client: { type: "string" },
    slug: { type: "string" },
    "ghl-prefix": { type: "string" },
    "env-file": { type: "string", default: GHL_ENV },
    production: { type: "boolean", default: false },
  },
});

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const endpoint = (url: string) => new URL(url).hostname.replace("-pooler", "");

async function main() {
  if (!values.client || !values["ghl-prefix"]) throw new Error("--client and --ghl-prefix are required");
  const prodUrl = parse(readFileSync(".env.local")).DATABASE_URL;
  const target = endpoint(process.env.DATABASE_URL!);
  if (endpoint(prodUrl) === target && !values.production) {
    throw new Error("Target is the production database (.env.local). Run via scripts/e2e-db.ts, or pass --production.");
  }

  if (!existsSync(values["env-file"]!)) throw new Error(`Credentials file not found: ${values["env-file"]}`);
  const creds = parse(readFileSync(values["env-file"]!));
  const need = (k: string) => {
    if (!creds[k]) throw new Error(`${k} is missing from ${values["env-file"]}`);
    return creds[k];
  };
  const squareToken = need("SQUARE_ACCESS_TOKEN");
  const livemode = (creds.SQUARE_ENVIRONMENT ?? "").trim().toLowerCase() === "production";
  const ghlLocationId = need(`${values["ghl-prefix"]}_LOC`);
  const ghlToken = need(`${values["ghl-prefix"]}_PIT`);

  const { eq, sql } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { clients, paymentConnections } = await import("../src/db/schema");
  const { encrypt } = await import("../src/lib/crypto");
  const { SquareApi } = await import("../src/lib/sync/square");

  const merchant = await new SquareApi(squareToken, livemode).merchant();
  console.log(`Target database: ${target}`);
  console.log(`Square token OK: merchant ${merchant.id} (${merchant.business_name ?? "no name"}), ${livemode ? "production" : "sandbox"}`);

  const slug = values.slug ?? slugify(values.client);
  const [client] = await db
    .insert(clients)
    .values({ name: values.client, slug, ghlLocationId, ghlTokenEnc: encrypt(ghlToken) })
    .onConflictDoUpdate({ target: clients.slug, set: { ghlLocationId, ghlTokenEnc: encrypt(ghlToken) } })
    .returning();
  console.log(`Client: ${client.name} (${client.id}), GHL location ${ghlLocationId}`);

  const conn = {
    clientId: client.id,
    provider: "square" as const,
    externalAccountId: merchant.id,
    accessTokenEnc: encrypt(squareToken),
    refreshTokenEnc: null,
    tokenExpiresAt: null, // personal access tokens don't expire
    scope: "manual-seed",
    livemode,
    connectedBy: null,
  };
  await db
    .insert(paymentConnections)
    .values(conn)
    .onConflictDoUpdate({
      target: [paymentConnections.clientId, paymentConnections.provider],
      set: { ...conn, lastSyncError: null, updatedAt: sql`now()` },
    });
  const [check] = await db.select().from(paymentConnections).where(eq(paymentConnections.clientId, client.id));
  console.log(`Square connection stored (scope=${check.scope}, livemode=${check.livemode})`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
