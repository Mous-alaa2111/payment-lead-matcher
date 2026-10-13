// ONE-TIME: set each client's starting status (Active / Onboarding / Paused /
// Canceled). Everyone not listed stays Active (the column default). After this,
// staff change statuses on the client page.
//
//   npx tsx scripts/set-client-statuses.ts                          dry run against .env.local (production)
//   npx tsx scripts/set-client-statuses.ts --apply --production     write to production
//   npx tsx scripts/e2e-db.ts npx tsx scripts/set-client-statuses.ts --apply   write to the e2e branch
//
// Names are matched ignoring case, spaces and punctuation. A listed name with no
// client in the app is skipped and reported. Refuses to apply if any client
// already has a non-Active status (it has run, or staff have set one) unless
// --force is passed.
import { config, parse } from "dotenv";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

config({ path: ".env.local", quiet: true }); // DATABASE_URL only if not already set

const STARTING: Record<"canceled" | "paused" | "onboarding", string[]> = {
  canceled: ["417 Hail", "Foursquare Flooring", "Hail Center", "Detail Supreme", "Wittmann Detail", "Seattle Details"],
  paused: ["Artworx", "Bellweather", "Detail Armor", "K&J Cleaner Cars", "Ozarks Handy Gal", "TerraClear", "Waterfowl Ecom"],
  onboarding: ["Deep Cleanum", "LNM Epoxy", "Network Video Surveillance", "North Tx", "North's Millwork", "Prestine Cleaning"],
};

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    production: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  },
});

const endpoint = (url: string) => new URL(url).hostname.replace("-pooler", "");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function main() {
  const prodUrl = parse(readFileSync(".env.local")).DATABASE_URL;
  const target = endpoint(process.env.DATABASE_URL!);
  const isProd = endpoint(prodUrl) === target;
  if (values.apply && isProd && !values.production) {
    throw new Error("Target is the production database. Add --production to write to it (or run a dry run first).");
  }

  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { clients } = await import("../src/db/schema");
  const all = await db.select({ id: clients.id, name: clients.name, status: clients.status }).from(clients);

  console.log(`Target database: ${target}${isProd ? " (PRODUCTION)" : ""}; ${values.apply ? "APPLYING" : "dry run"}\n`);
  const already = all.filter((c) => c.status !== "active");
  if (values.apply && already.length && !values.force) {
    throw new Error(
      `${already.length} client(s) already have a non-Active status (${already.map((c) => c.name).join(", ")}). ` +
        "This has run before or staff set them. Re-run with --force to overwrite.",
    );
  }

  const changes: { client: string; from: string; to: string }[] = [];
  const skipped: string[] = [];
  for (const [status, names] of Object.entries(STARTING) as [keyof typeof STARTING, string[]][]) {
    for (const name of names) {
      const hit = all.filter((c) => norm(c.name) === norm(name));
      if (hit.length !== 1) {
        skipped.push(`${name} (${hit.length ? `${hit.length} clients match` : "not in the app"})`);
        continue;
      }
      changes.push({ client: hit[0].name, from: hit[0].status, to: status });
      if (values.apply) await db.update(clients).set({ status }).where(eq(clients.id, hit[0].id));
    }
  }

  console.table(changes);
  const listed = new Set(changes.map((c) => c.client));
  // Not listed: left as they are (Active unless staff already changed them).
  const rest = all
    .filter((c) => !listed.has(c.name))
    .map((c) => (c.status === "active" ? c.name : `${c.name} (${c.status})`))
    .sort();
  console.log(`Not listed, left as is (${rest.length}): ${rest.join(", ")}`);
  console.log(`Skipped, not in the app (${skipped.length}): ${skipped.join(", ") || "none"}`);
  console.log(values.apply ? `\nDone: ${changes.length} client status(es) set.` : "\nDry run. Re-run with --apply to write.");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);
