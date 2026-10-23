import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { clients, paymentConnections } from "@/db/schema";
import { sendWritebackSummary, type SummaryEmailStatus } from "@/lib/writeback/email";
import { CRON_CAP, writeBackAfterSync, type RunOutcome } from "@/lib/writeback/run";
import { syncClient, type ClientSyncResult } from "./index";
import { AUTO_SYNC_EVERY_DAYS, WRITEBACK_AUTO_SYNC_EVERY_DAYS, isAutoSyncDue } from "./schedule";

// The cron route may run 300 s. No new client is started after this, leaving
// room for the one in progress; whoever is left is picked up on the next run.
export const AUTO_SYNC_STOP_STARTING_AFTER_MS = 200_000;

export type AutoSyncReport = {
  eligible: number; // clients with a GHL token and at least one connected account
  due: number;
  synced: { client: string; ok: boolean; errors: string[] }[];
  remaining: number; // due but not started because time ran out
  writeBack: { client: string; status: RunOutcome["status"]; planned: number; updated: number }[];
  writeBackEmail: SummaryEmailStatus;
};

// Daily auto sync (Vercel Cron -> /api/cron/auto-sync). Runs the same
// incremental sync as Sync now on every due client, one at a time. Provider
// errors are stored on the connection by syncPayments (shown on the page like
// Sync now's); anything else is stored on the client. One client failing never
// stops the rest. Clients with GHL write-back on Auto are due daily and go
// first; after each sync, write-back runs for Preview/Auto clients (at most
// CRON_CAP changes across the whole run) and staff get one summary email.
export async function runAutoSync({
  now = new Date(),
  everyDays = AUTO_SYNC_EVERY_DAYS,
  stopStartingAfterMs = AUTO_SYNC_STOP_STARTING_AFTER_MS,
  onlyClientIds,
}: {
  now?: Date;
  everyDays?: number;
  stopStartingAfterMs?: number;
  onlyClientIds?: string[]; // tests: limit the run to these clients
} = {}): Promise<AutoSyncReport> {
  const started = Date.now();
  const [withGhl, conns] = await Promise.all([
    db
      .select({ id: clients.id, name: clients.name, lastAutoSyncAt: clients.lastAutoSyncAt, writebackMode: clients.writebackMode })
      .from(clients)
      .where(and(isNotNull(clients.ghlLocationId), isNotNull(clients.ghlTokenEnc))),
    db
      .select({ clientId: paymentConnections.clientId, lastSyncedAt: paymentConnections.lastSyncedAt })
      .from(paymentConnections),
  ]);
  const eligible = withGhl
    .filter((c) => !onlyClientIds || onlyClientIds.includes(c.id))
    .map((c) => ({ ...c, conns: conns.filter((x) => x.clientId === c.id) }))
    .filter((c) => c.conns.length > 0);

  // Least recently auto-synced first, so a client that keeps failing or timing
  // out can't hold the others back.
  const isAuto = (c: { writebackMode: string }) => c.writebackMode === "auto";
  const due = eligible
    .filter((c) => isAutoSyncDue(c.conns, now, isAuto(c) ? WRITEBACK_AUTO_SYNC_EVERY_DAYS : everyDays))
    .sort((a, b) => Number(isAuto(b)) - Number(isAuto(a)) || (a.lastAutoSyncAt?.getTime() ?? 0) - (b.lastAutoSyncAt?.getTime() ?? 0));

  const report: AutoSyncReport = {
    eligible: eligible.length, due: due.length, synced: [], remaining: 0, writeBack: [], writeBackEmail: "skipped",
  };
  const outcomes: RunOutcome[] = [];
  const budget = { remaining: CRON_CAP };
  for (const [i, client] of due.entries()) {
    if (Date.now() - started > stopStartingAfterMs) {
      report.remaining = due.length - i;
      break;
    }
    const where = eq(clients.id, client.id);
    await db.update(clients).set({ lastAutoSyncAt: new Date() }).where(where);
    try {
      const results: ClientSyncResult[] = await syncClient(client.id);
      await db.update(clients).set({ lastAutoSyncError: null }).where(where);
      const errors = results.flatMap((r) => (r.error ? [`${r.provider}: ${r.error}`] : []));
      report.synced.push({ client: client.name, ok: errors.length === 0, errors });
      const wb = await writeBackAfterSync(client.id, results, { trigger: "cron", budget });
      if (wb) {
        outcomes.push(wb);
        report.writeBack.push({ client: client.name, status: wb.status, planned: wb.planned, updated: wb.updated });
      }
    } catch (err) {
      const message = (err as Error).message;
      console.error(`[auto-sync] ${client.name}`, err);
      await db
        .update(clients)
        .set({ lastAutoSyncError: message.slice(0, 500) })
        .where(where)
        .catch((e) => console.error(`[auto-sync] couldn't record the error for ${client.name}`, e));
      report.synced.push({ client: client.name, ok: false, errors: [message] });
    }
  }
  report.writeBackEmail = await sendWritebackSummary(outcomes, "daily cron");
  return report;
}
