import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import {
  appSettings,
  clients,
  paymentConnections,
  paymentMatches,
  writebackAudit,
  writebackRuns,
  type WritebackPlanItem,
} from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { squareApiFor, stripeApiFor, type ClientSyncResult } from "@/lib/sync";
import { stripeChargeStatus } from "@/lib/sync/stripe";
import { GhlWriteApi } from "./ghl";
import { MATCHED_TAG, configProblems, paymentExclusion, planLead, toCents, unchangedSincePlan, type CandidatePayment } from "./rules";

// GHL write-back: after a sync (or from staff's Run now / Apply), close the GHL
// opportunity of each lead whose payment matched and set its value, following
// lib/writeback/rules. Preview plans only; Auto and Apply write. Every write is
// recorded in writeback_audit first, so staff can Undo it.

export const RUN_CAP = 20; // opportunity updates per client per run
export const CRON_CAP = 100; // across one cron run (every client together)
export const RUN_STALE_MS = 10 * 60_000; // a "running" run older than this was interrupted
const RECHECK_EVERY_MS = 12 * 3_600_000; // a payment's refund re-check is reused this long
const RECHECK_PUSHED_DAYS = 180; // pushed payments watched for later refunds this long
const RECHECK_CONCURRENCY = 4;

export type WritebackTrigger = "sync" | "cron" | "run_now" | "apply";

export type RunOutcome = {
  clientId: string;
  runId: string | null;
  applied: boolean;
  status: "ok" | "capped" | "error" | "killed" | "locked";
  planned: number; // updates in the plan
  updated: number;
  skipped: Record<string, number>;
  newNeedsReview: number;
  error?: string;
};

// --- kill switch ---

export async function writebackSwitch(): Promise<{ enabled: boolean; envDisabled: boolean; dbEnabled: boolean }> {
  const envDisabled = process.env.WRITEBACK_DISABLED?.trim() === "1";
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, "writeback_enabled"));
  const dbEnabled = row?.value !== "false";
  return { enabled: dbEnabled && !envDisabled, envDisabled, dbEnabled };
}

export async function setWritebackEnabled(enabled: boolean, userId: string | null) {
  await db
    .insert(appSettings)
    .values({ key: "writeback_enabled", value: String(enabled), updatedBy: userId })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: String(enabled), updatedBy: userId, updatedAt: new Date() } });
}

// --- helpers ---

type Client = typeof clients.$inferSelect;
type PaymentRow = typeof paymentMatches.$inferSelect;

function ghlFor(client: Client) {
  if (!client.ghlLocationId || !client.ghlTokenEnc) throw new Error("This client has no GHL location/token set");
  return new GhlWriteApi(client.ghlLocationId, decrypt(client.ghlTokenEnc));
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Re-reads each payment's status and refunds from Stripe/Square (sync only sees
// payments created in its window, so a later refund of an older payment would
// be missed) and stores them. Throws on the first provider error.
async function recheckRefunds(clientId: string, rows: PaymentRow[], now: Date) {
  const due = rows.filter((r) => !r.refundCheckedAt || now.getTime() - r.refundCheckedAt.getTime() > RECHECK_EVERY_MS);
  if (!due.length) return rows;
  const conns = await db.select().from(paymentConnections).where(eq(paymentConnections.clientId, clientId));
  const fresh = new Map<string, { status: string | null; refundedCents: number }>();
  await mapLimit(due, RECHECK_CONCURRENCY, async (r) => {
    const conn = conns.find((c) => c.provider === r.provider);
    if (!conn) throw new Error(`Can't re-check refunds: ${r.provider} is no longer connected`);
    if (r.provider === "square") {
      const p = await squareApiFor(conn).payment(r.externalPaymentId);
      fresh.set(r.id, { status: p.status ?? null, refundedCents: p.refunded_money?.amount ?? 0 });
    } else {
      const c = await stripeApiFor(conn).charge(r.externalPaymentId);
      fresh.set(r.id, { status: stripeChargeStatus(c), refundedCents: c.amount_refunded ?? 0 });
    }
  });
  const updates = due.map((r) => {
    const f = fresh.get(r.id)!;
    return db
      .update(paymentMatches)
      .set({ paymentStatus: f.status, refundedCents: f.refundedCents, refundCheckedAt: now })
      .where(eq(paymentMatches.id, r.id));
  });
  for (let i = 0; i < updates.length; i += 100) {
    const chunk = updates.slice(i, i + 100);
    await db.batch(chunk as [(typeof chunk)[number], ...typeof chunk]);
  }
  return rows.map((r) => {
    const f = fresh.get(r.id);
    return f ? { ...r, paymentStatus: f.status, refundedCents: f.refundedCents, refundCheckedAt: now } : r;
  });
}

const candidate = (r: PaymentRow): CandidatePayment => ({
  id: r.id,
  paidAt: r.paidAt,
  amountCents: r.amountCents,
  paymentStatus: r.paymentStatus,
  refundedCents: r.refundedCents,
  writebackState: r.writebackState,
});

function summarize(plan: WritebackPlanItem[]) {
  const skipped: Record<string, number> = {};
  for (const i of plan) {
    const reason = i.skip ?? (i.outcome === "skipped" ? i.note ?? "skipped" : null);
    if (reason) skipped[reason] = (skipped[reason] ?? 0) + 1;
  }
  return { planned: plan.filter((i) => !i.skip).length, skipped };
}

// --- the run ---

export async function runWriteBack(
  clientId: string,
  opts: { trigger: WritebackTrigger; userId?: string | null; cap?: number; budget?: { remaining: number }; now?: Date },
): Promise<RunOutcome | null> {
  const now = opts.now ?? new Date();
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client || client.writebackMode === "off") return null;
  if (opts.trigger === "apply" && client.writebackMode !== "preview") throw new Error("Apply is only for clients in Preview");
  const apply = opts.trigger === "apply" || client.writebackMode === "auto";

  // One run per client at a time; clear a run that never recorded its end.
  await db
    .update(writebackRuns)
    .set({ status: "error", error: "Interrupted: the run never finished", finishedAt: now })
    .where(and(eq(writebackRuns.clientId, clientId), eq(writebackRuns.status, "running"), lt(writebackRuns.startedAt, new Date(now.getTime() - RUN_STALE_MS))));
  const [run] = await db
    .insert(writebackRuns)
    .values({ clientId, trigger: opts.trigger, applied: apply, startedBy: opts.userId ?? null, startedAt: now })
    .onConflictDoNothing()
    .returning();
  if (!run) {
    return { clientId, runId: null, applied: apply, status: "locked", planned: 0, updated: 0, skipped: {}, newNeedsReview: 0, error: "Another write-back run is in progress for this client" };
  }

  const plan: WritebackPlanItem[] = [];
  let updated = 0;
  let newNeedsReview = 0;
  let status: RunOutcome["status"] = "ok";
  let error: string | undefined;
  try {
    if (apply && client.writebackMode === "auto" && !client.writebackPermsOk) {
      throw new Error("Check permissions hasn't passed for this client");
    }
    const ghl = ghlFor(client);
    const pipelines = await ghl.pipelines();
    const problems = configProblems(client.writebackConfig, pipelines);
    if (problems.length) throw new Error(problems.join(" "));
    const config = client.writebackConfig!;

    // Matched payments not yet pushed, plus recently pushed ones (watched for refunds).
    const pushedSince = new Date(now.getTime() - RECHECK_PUSHED_DAYS * 86_400_000);
    let rows = await db
      .select()
      .from(paymentMatches)
      .where(and(eq(paymentMatches.clientId, clientId), eq(paymentMatches.status, "matched")));
    const watched = rows.filter((r) => r.writebackState !== "pushed" || r.paidAt >= pushedSince);
    rows = await recheckRefunds(clientId, watched, now);

    // Requirement: a pushed payment refunded later changes nothing in GHL; its audit row is flagged.
    const refundedAfterPush = rows.filter(
      (r) => r.writebackState === "pushed" && r.writebackAuditId && paymentExclusion({ ...candidate(r), writebackState: null }) === "refunded",
    );
    for (const r of refundedAfterPush) {
      const flagged = await db
        .update(writebackAudit)
        .set({ needsReview: true, reviewReason: "A payment in this update was refunded after the push. Nothing was changed in GHL." })
        .where(and(eq(writebackAudit.id, r.writebackAuditId!), eq(writebackAudit.needsReview, false)))
        .returning({ id: writebackAudit.id });
      newNeedsReview += flagged.length;
    }

    // One plan item per lead with anything left to do.
    const byContact = new Map<string, PaymentRow[]>();
    for (const r of rows) {
      const contactId = r.contacts[0]?.id;
      if (!contactId) continue;
      byContact.set(contactId, [...(byContact.get(contactId) ?? []), r]);
    }
    for (const [contactId, payments] of byContact) {
      if (payments.every((p) => p.writebackState === "pushed")) continue; // done
      const cands = payments.map(candidate);
      if (cands.every((p) => paymentExclusion(p))) {
        plan.push(planLead({ contactId, payments: cands, opportunities: [], tags: [], config, pipelines }));
        continue;
      }
      const [opportunities, tags] = await Promise.all([ghl.opportunitiesForContact(contactId), ghl.contactTags(contactId)]);
      plan.push(planLead({ contactId, payments: cands, opportunities, tags, config, pipelines }));
    }
    plan.sort((a, b) => Number(Boolean(a.skip)) - Number(Boolean(b.skip)) || a.contactId.localeCompare(b.contactId));
    await db.update(writebackRuns).set({ plan }).where(eq(writebackRuns.id, run.id));

    if (apply) {
      const cap = opts.cap ?? RUN_CAP;
      for (const item of plan.filter((i) => !i.skip)) {
        if (status !== "ok") {
          item.outcome = "not_reached";
          continue;
        }
        if (updated >= cap || (opts.budget && opts.budget.remaining <= 0)) {
          status = "capped";
          error = updated >= cap ? `Stopped at the cap of ${cap} changes; the rest wait for the next run` : `Stopped at the cron run's cap of ${CRON_CAP} changes`;
          item.outcome = "not_reached";
          continue;
        }
        if (!(await writebackSwitch()).enabled) {
          status = "killed";
          error = "Write-back is switched off (kill switch); nothing more was written";
          item.outcome = "not_reached";
          continue;
        }
        try {
          const result = await pushOne(client, ghl, run.id, item);
          if (result === "updated") {
            updated++;
            if (opts.budget) opts.budget.remaining--;
          }
        } catch (err) {
          item.outcome = "error";
          item.note = message(err);
          status = "error";
          error = message(err);
        }
      }
    }
  } catch (err) {
    status = "error";
    error = message(err);
  }

  await db
    .update(writebackRuns)
    .set({ status, plan, updated, newNeedsReview, error: error ?? null, finishedAt: new Date() })
    .where(eq(writebackRuns.id, run.id));
  return { clientId, runId: run.id, applied: apply, status, ...summarize(plan), updated, newNeedsReview, error };
}

// Writes one planned update. Order matters for undo and idempotency: re-read,
// audit row (holds the opportunity), claim the payments, write, read back, tag.
// Returns "updated" or "skipped" (outcome noted on the item); throws on errors.
async function pushOne(client: Client, ghl: GhlWriteApi, runId: string, item: WritebackPlanItem) {
  const current = item.current!;
  const target = item.target!;
  const live = await ghl.opportunity(item.opportunityId!);
  if (!unchangedSincePlan(current, live)) {
    item.outcome = "skipped";
    item.note = "changed in GHL since the plan";
    return "skipped" as const;
  }

  const [audit] = await db
    .insert(writebackAudit)
    .values({
      clientId: client.id,
      runId,
      paymentIds: item.paymentIds,
      contactId: item.contactId,
      opportunityId: item.opportunityId!,
      previousPipelineId: current.pipelineId,
      previousPipelineName: current.pipelineName,
      previousStageId: current.pipelineStageId,
      previousStageName: current.stageName,
      previousStatus: current.status,
      previousValue: current.monetaryValue,
      newPipelineId: target.pipelineId,
      newStageId: target.pipelineStageId,
      newStageName: target.stageName,
      newStatus: target.status,
      newValue: item.setValue ? target.monetaryValue : current.monetaryValue,
    })
    .onConflictDoNothing()
    .returning();
  if (!audit) {
    item.outcome = "skipped";
    item.note = "opportunity already pushed";
    return "skipped" as const;
  }
  const fail = async (err: unknown, releasePayments: boolean) => {
    await db.update(writebackAudit).set({ result: "error", error: message(err) }).where(eq(writebackAudit.id, audit.id));
    if (releasePayments) {
      await db
        .update(paymentMatches)
        .set({ writebackState: null, writebackAuditId: null })
        .where(eq(paymentMatches.writebackAuditId, audit.id));
    }
    throw err;
  };

  const claimed = await db
    .update(paymentMatches)
    .set({ writebackState: "pushed", writebackAuditId: audit.id })
    .where(and(inArray(paymentMatches.id, item.paymentIds), isNull(paymentMatches.writebackState)))
    .returning({ id: paymentMatches.id });
  if (claimed.length !== item.paymentIds.length) await fail(new Error("A payment in this update was already pushed"), true);

  try {
    await ghl.updateOpportunity(item.opportunityId!, {
      pipelineId: live.pipelineId,
      pipelineStageId: target.pipelineStageId,
      status: "won",
      ...(item.setValue ? { monetaryValue: target.monetaryValue! } : {}),
    });
  } catch (err) {
    await fail(err, true);
  }

  let after;
  try {
    after = await ghl.opportunity(item.opportunityId!);
  } catch (err) {
    await fail(err, false);
  }
  const expectedValue = item.setValue ? target.monetaryValue : current.monetaryValue;
  if (
    after!.pipelineId !== live.pipelineId ||
    after!.pipelineStageId !== target.pipelineStageId ||
    after!.status !== "won" ||
    toCents(after!.monetaryValue) !== toCents(expectedValue)
  ) {
    await fail(new Error("GHL's read-back doesn't match the update; check this opportunity in GHL"), false);
  }
  await db
    .update(writebackAudit)
    .set({ result: "ok", newValue: after!.monetaryValue ?? null })
    .where(eq(writebackAudit.id, audit.id));
  item.outcome = "updated";

  // The tag a GHL workflow listens for. Undo only removes it if we added it.
  try {
    const tags = (await ghl.contactTags(item.contactId)).map((t) => t.toLowerCase());
    if (tags.includes(MATCHED_TAG)) {
      await db.update(writebackAudit).set({ tagStatus: "already" }).where(eq(writebackAudit.id, audit.id));
    } else {
      await ghl.addTag(item.contactId, MATCHED_TAG);
      await db.update(writebackAudit).set({ tagStatus: "added" }).where(eq(writebackAudit.id, audit.id));
    }
  } catch (err) {
    await db
      .update(writebackAudit)
      .set({ tagStatus: "failed", error: `Opportunity updated, but adding the tag failed: ${message(err)}` })
      .where(eq(writebackAudit.id, audit.id));
    throw new Error(`Opportunity updated, but adding the "${MATCHED_TAG}" tag failed: ${message(err)}`);
  }
  return "updated" as const;
}

// --- after a sync ---

// Every sync path (Sync now / range, the daily cron, the CLI) calls this. Runs
// only for clients in Preview or Auto, and only if every account synced.
export async function writeBackAfterSync(
  clientId: string,
  results: ClientSyncResult[],
  opts: { trigger: "sync" | "cron"; userId?: string | null; budget?: { remaining: number } },
) {
  if (!results.length || results.some((r) => r.error)) return null;
  try {
    return await runWriteBack(clientId, opts);
  } catch (err) {
    console.error("[writeback] after sync", message(err));
    return null;
  }
}

// --- undo / release (staff) ---

// Restores one audit row's opportunity to its previous pipeline, stage, status
// and value, removes the tag if we added it, and blocks its payments until
// Release. Refuses if the opportunity changed since the push.
export async function undoAudit(auditId: string, userId: string | null) {
  const [row] = await db.select().from(writebackAudit).where(eq(writebackAudit.id, auditId));
  if (!row || row.result !== "ok") throw new Error("Only a successful update can be undone");
  const [client] = await db.select().from(clients).where(eq(clients.id, row.clientId));
  const ghl = ghlFor(client);

  const live = await ghl.opportunity(row.opportunityId);
  if (
    live.pipelineId !== row.newPipelineId ||
    live.pipelineStageId !== row.newStageId ||
    live.status !== row.newStatus ||
    toCents(live.monetaryValue) !== toCents(row.newValue)
  ) {
    throw new Error("This opportunity changed in GHL after the update, so it wasn't undone. Restore it by hand if needed.");
  }
  await ghl.updateOpportunity(row.opportunityId, {
    pipelineId: row.previousPipelineId,
    pipelineStageId: row.previousStageId,
    status: row.previousStatus,
    monetaryValue: row.previousValue ?? 0,
  });
  const after = await ghl.opportunity(row.opportunityId);
  if (after.pipelineStageId !== row.previousStageId || after.status !== row.previousStatus) {
    throw new Error("GHL's read-back doesn't match the restore; check this opportunity in GHL");
  }
  if (row.tagStatus === "added") await ghl.removeTag(row.contactId, MATCHED_TAG);

  await db
    .update(writebackAudit)
    .set({ result: "undone", undoneAt: new Date(), undoneBy: userId })
    .where(eq(writebackAudit.id, auditId));
  await db
    .update(paymentMatches)
    .set({ writebackState: "blocked" })
    .where(and(eq(paymentMatches.writebackAuditId, auditId), eq(paymentMatches.writebackState, "pushed")));
}

// Undo every successful update of a run, newest first; stops at the first error.
export async function undoRun(runId: string, userId: string | null) {
  const rows = await db
    .select({ id: writebackAudit.id })
    .from(writebackAudit)
    .where(and(eq(writebackAudit.runId, runId), eq(writebackAudit.result, "ok")))
    .orderBy(desc(writebackAudit.createdAt));
  let undone = 0;
  for (const r of rows) {
    await undoAudit(r.id, userId);
    undone++;
  }
  return undone;
}

// Lets an undone update's payments be pushed again.
export async function releaseAudit(auditId: string) {
  const [row] = await db.select().from(writebackAudit).where(eq(writebackAudit.id, auditId));
  if (!row || row.result !== "undone" || row.releasedAt) throw new Error("Only an undone update can be released, once");
  await db
    .update(paymentMatches)
    .set({ writebackState: null, writebackAuditId: null })
    .where(and(eq(paymentMatches.writebackAuditId, auditId), eq(paymentMatches.writebackState, "blocked")));
  await db.update(writebackAudit).set({ releasedAt: new Date() }).where(eq(writebackAudit.id, auditId));
}

// Recent runs and audit rows for the client page (staff only).
export async function writebackHistory(clientId: string) {
  const [runs, audit] = await Promise.all([
    db.select().from(writebackRuns).where(eq(writebackRuns.clientId, clientId)).orderBy(desc(writebackRuns.startedAt)).limit(10),
    db
      .select()
      .from(writebackAudit)
      .where(eq(writebackAudit.clientId, clientId))
      .orderBy(desc(writebackAudit.createdAt))
      .limit(50),
  ]);
  return { runs, audit, needsReview: audit.filter((a) => a.needsReview && a.result === "ok").length };
}

