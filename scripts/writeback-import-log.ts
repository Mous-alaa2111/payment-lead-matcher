// Imports a manual close-opps run (417-close-opps/update-log.jsonl, 2026-10-23)
// into the write-back audit table, so its Undo lives in the app. For each
// "updated" entry: one audit row (result ok, previous/new state from the log,
// names from the live pipelines: one read-only GHL call), and the contact's
// matched payments marked pushed so they're never pushed again. No tag was
// added by that run, so Undo won't remove one. Opportunities already in the
// audit table are skipped, so running it twice changes nothing.
//   npm run writeback:import-log -- --client 417-details --log "<path>/update-log.jsonl" --production
// Refuses the production database (.env.local) unless --production is passed.
import { config, parse } from "dotenv";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

config({ path: ".env.local", quiet: true });

const { values } = parseArgs({
  options: { client: { type: "string" }, log: { type: "string" }, production: { type: "boolean", default: false } },
});
const endpoint = (url: string) => new URL(url).hostname.replace("-pooler", "");

type State = { pipelineId: string; pipelineStageId: string; status: string; monetaryValue: number | null };
type Entry = { at: string; action: string; contactId: string; opportunityId: string; previous: State; after: State };

async function main() {
  if (!values.client || !values.log) throw new Error("--client <slug> and --log <file> are required");
  if (endpoint(parse(readFileSync(".env.local")).DATABASE_URL!) === endpoint(process.env.DATABASE_URL!) && !values.production) {
    throw new Error("Target is the production database (.env.local). Run via scripts/e2e-db.ts, or pass --production.");
  }
  const { and, eq, inArray, isNull } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { clients, paymentMatches, writebackAudit, writebackRuns } = await import("../src/db/schema");
  const { livePipelines } = await import("../src/lib/writeback/setup");

  const entries = readFileSync(values.log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Entry)
    .filter((e) => e.action === "updated");
  if (!entries.length) throw new Error("No 'updated' entries in the log");
  // An entry undone later in the same log isn't imported.
  const undone = new Set(
    readFileSync(values.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action === "undone").map((e) => e.at0),
  );

  const [client] = await db.select().from(clients).where(eq(clients.slug, values.client));
  if (!client) throw new Error(`No client with slug ${values.client}`);
  const pipelines = await livePipelines(client.id);
  const names = (s: State) => {
    const p = pipelines.find((x) => x.id === s.pipelineId);
    return { pipeline: p?.name ?? s.pipelineId, stage: p?.stages.find((x) => x.id === s.pipelineStageId)?.name ?? s.pipelineStageId };
  };

  const [run] = await db
    .insert(writebackRuns)
    .values({ clientId: client.id, trigger: "import", applied: true, status: "ok", startedAt: new Date(entries[0].at), finishedAt: new Date() })
    .returning();
  let imported = 0;
  for (const e of entries) {
    if (undone.has(e.at)) continue;
    const matched = (
      await db.select().from(paymentMatches).where(and(eq(paymentMatches.clientId, client.id), eq(paymentMatches.status, "matched")))
    ).filter((p) => p.contacts[0]?.id === e.contactId && !p.writebackState);
    const prev = names(e.previous);
    const next = names(e.after);
    const [audit] = await db
      .insert(writebackAudit)
      .values({
        clientId: client.id,
        runId: run.id,
        paymentIds: matched.map((p) => p.id),
        contactId: e.contactId,
        opportunityId: e.opportunityId,
        previousPipelineId: e.previous.pipelineId,
        previousPipelineName: prev.pipeline,
        previousStageId: e.previous.pipelineStageId,
        previousStageName: prev.stage,
        previousStatus: e.previous.status,
        previousValue: e.previous.monetaryValue,
        newPipelineId: e.after.pipelineId,
        newStageId: e.after.pipelineStageId,
        newStageName: next.stage,
        newStatus: e.after.status,
        newValue: e.after.monetaryValue,
        result: "ok",
        createdAt: new Date(e.at),
      })
      .onConflictDoNothing()
      .returning();
    if (!audit) {
      console.log(`${e.contactId}: already in the audit table, skipped`);
      continue;
    }
    if (matched.length) {
      await db
        .update(paymentMatches)
        .set({ writebackState: "pushed", writebackAuditId: audit.id })
        .where(and(inArray(paymentMatches.id, matched.map((p) => p.id)), isNull(paymentMatches.writebackState)));
    }
    imported++;
    console.log(`${e.contactId}: imported (${prev.stage}/${e.previous.status} -> ${next.stage}/${e.after.status}), ${matched.length} payment(s) marked pushed`);
  }
  await db.update(writebackRuns).set({ updated: imported }).where(eq(writebackRuns.id, run.id));
  if (!imported) await db.delete(writebackRuns).where(eq(writebackRuns.id, run.id));
  console.log(`${imported} imported`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
