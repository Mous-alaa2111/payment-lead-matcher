// Pre-fills a client's GHL write-back setup (pipelines, Closed stages,
// contradicting tags) by name, resolved to ids from the client's live pipelines
// (one read-only GHL call). Leaves the mode as it is (Off for a new setup).
// Staff can change it later on the client page.
//   npm run writeback:setup -- --client 417-details \
//     --pipeline "Detailing Pipeline=Closed=ceramic-coating" \
//     --pipeline "Ceramic Coating=Closed=detailing lead" --production
// Each --pipeline is "<pipeline name>=<Closed stage name>=<tag>[,<tag>...]".
// Refuses the production database (.env.local) unless --production is passed.
import { config, parse } from "dotenv";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

config({ path: ".env.local", quiet: true });

const { values } = parseArgs({
  options: {
    client: { type: "string" },
    pipeline: { type: "string", multiple: true },
    production: { type: "boolean", default: false },
  },
});
const endpoint = (url: string) => new URL(url).hostname.replace("-pooler", "");

async function main() {
  if (!values.client || !values.pipeline?.length) throw new Error("--client <slug> and at least one --pipeline are required");
  if (endpoint(parse(readFileSync(".env.local")).DATABASE_URL!) === endpoint(process.env.DATABASE_URL!) && !values.production) {
    throw new Error("Target is the production database (.env.local). Run via scripts/e2e-db.ts, or pass --production.");
  }
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { clients } = await import("../src/db/schema");
  const { livePipelines, saveConfig } = await import("../src/lib/writeback/setup");

  const [client] = await db.select().from(clients).where(eq(clients.slug, values.client));
  if (!client) throw new Error(`No client with slug ${values.client}`);
  const live = await livePipelines(client.id);
  const chosen = values.pipeline.map((arg) => {
    const [pipeName, stageName, tags = ""] = arg.split("=");
    const p = live.find((x) => x.name === pipeName?.trim());
    if (!p) throw new Error(`No pipeline named "${pipeName}". Live: ${live.map((x) => `"${x.name}"`).join(", ")}`);
    const stage = p.stages.filter((s) => s.name === stageName?.trim());
    if (stage.length !== 1) throw new Error(`"${p.name}" has ${stage.length} stages named "${stageName}"`);
    return {
      id: p.id,
      name: p.name,
      closedStageId: stage[0].id,
      closedStageName: stage[0].name,
      contradictTags: [...new Set(tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))],
    };
  });
  await saveConfig(client.id, { pipelines: chosen });
  console.log(`${client.name}: write-back setup saved (mode stays ${client.writebackMode})`);
  for (const c of chosen) console.log(`  ${c.name} -> ${c.closedStageName}; contradicting tags: ${c.contradictTags.join(", ") || "none"}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
