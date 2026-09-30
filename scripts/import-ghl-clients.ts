// ONE-TIME IMPORT: create a client record for every GHL location in the GHL CLI
// .env (each <PREFIX>_LOC + <PREFIX>_PIT pair), with its token stored encrypted.
// Names come from GHL itself (GET /locations/:id), falling back to the prefix.
// Each token is checked against the contacts endpoint that sync uses.
//
//   npx tsx scripts/import-ghl-clients.ts                          dry run against .env.local (production)
//   npx tsx scripts/import-ghl-clients.ts --apply --production     write to production
//   npx tsx scripts/e2e-db.ts npx tsx scripts/import-ghl-clients.ts --apply   write to the e2e branch
//   ... --only 417_DETAILS --only ARTWORX                         limit to some prefixes
//
// Safe to re-run: a location that already has a client is left alone (its token is
// updated if it changed); a new location whose name clashes with an existing
// client is skipped and reported. Nothing secret is printed.
import { config, parse } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

config({ path: ".env.local", quiet: true }); // TOKEN_ENCRYPTION_KEY; DATABASE_URL only if not already set

const GHL_ENV =
  "C:\\Users\\Quantum Technology\\Downloads\\GHL\\gohighlevel-cli-main\\leadgenjay-gohighlevel-cli-d8331d3f5b8553eb76e9e3d7b3db1264d74b4832\\.env";
const GHL_API = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    production: { type: "boolean", default: false },
    only: { type: "string", multiple: true, default: [] },
    "env-file": { type: "string", default: GHL_ENV },
  },
});

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const endpoint = (url: string) => new URL(url).hostname.replace("-pooler", "");
const titleCase = (prefix: string) =>
  prefix
    .toLowerCase()
    .split("_")
    .map((w) => (w === "and" ? "&" : w === "llc" ? "LLC" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");

async function ghl(path: string, token: string) {
  const res = await fetch(GHL_API + path, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", Version: GHL_VERSION },
  });
  return { ok: res.ok, status: res.status, body: res.ok ? await res.json() : null };
}

async function main() {
  const prodUrl = parse(readFileSync(".env.local")).DATABASE_URL;
  const target = endpoint(process.env.DATABASE_URL!);
  const isProd = endpoint(prodUrl) === target;
  if (values.apply && isProd && !values.production) {
    throw new Error("Target is the production database. Add --production to write to it (or run a dry run first).");
  }
  if (!existsSync(values["env-file"]!)) throw new Error(`Credentials file not found: ${values["env-file"]}`);
  const creds = parse(readFileSync(values["env-file"]!));

  const prefixes = Object.keys(creds)
    .filter((k) => k.endsWith("_LOC") && creds[k] && creds[k.replace(/_LOC$/, "_PIT")])
    .map((k) => k.replace(/_LOC$/, ""))
    .filter((p) => !values.only!.length || values.only!.includes(p));

  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { clients } = await import("../src/db/schema");
  const { decrypt, encrypt } = await import("../src/lib/crypto");
  const existing = await db.select().from(clients);

  console.log(`Target database: ${target}${isProd ? " (PRODUCTION)" : ""}; ${values.apply ? "APPLYING" : "dry run"}`);
  console.log(`${prefixes.length} GHL location(s) in ${values["env-file"]!.split("\\").at(-2)}/.env\n`);

  const rows: Record<string, string>[] = [];
  const counts = { create: 0, update: 0, unchanged: 0, skip: 0 };
  for (const prefix of prefixes) {
    const locationId = creds[`${prefix}_LOC`].trim();
    const token = creds[`${prefix}_PIT`].trim();

    const loc = await ghl(`/locations/${locationId}`, token);
    const ghlName: string | undefined = loc.body?.location?.name?.trim();
    const name = ghlName || titleCase(prefix);
    const contacts = await ghl(`/contacts/?locationId=${locationId}&limit=1`, token);
    const tokenCheck = contacts.ok ? "ok" : `FAILED (${contacts.status})`;

    const byLocation = existing.find((c) => c.ghlLocationId === locationId);
    const bySlug = existing.find((c) => c.slug === slugify(name));
    let action: string;
    if (byLocation) {
      const same = byLocation.ghlTokenEnc && decrypt(byLocation.ghlTokenEnc) === token;
      action = same ? `exists as "${byLocation.name}"` : `exists as "${byLocation.name}", token updated`;
      if (!same && values.apply) {
        await db.update(clients).set({ ghlTokenEnc: encrypt(token) }).where(eq(clients.id, byLocation.id));
      }
      counts[same ? "unchanged" : "update"]++;
    } else if (bySlug) {
      action = `SKIPPED: name clashes with existing "${bySlug.name}" (different GHL location)`;
      counts.skip++;
    } else {
      action = "create";
      if (values.apply) {
        const [c] = await db
          .insert(clients)
          .values({ name, slug: slugify(name), ghlLocationId: locationId, ghlTokenEnc: encrypt(token) })
          .returning();
        existing.push(c);
      }
      counts.create++;
    }
    rows.push({ prefix, name, "name from": ghlName ? "GHL" : `prefix (GHL ${loc.status})`, token: tokenCheck, action });
  }

  console.table(rows);
  console.log(
    `${values.apply ? "Done" : "Would do"}: ${counts.create} create, ${counts.update} token update, ` +
      `${counts.unchanged} unchanged, ${counts.skip} skipped.${values.apply ? "" : " Re-run with --apply to write."}`,
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err.message);
    process.exit(1);
  },
);
