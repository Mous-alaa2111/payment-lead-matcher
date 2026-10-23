"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { writebackAudit, writebackRuns } from "@/db/schema";
import { isUuid, requireAgencyStaffOr404 } from "@/lib/access";
import { sendWritebackSummary } from "@/lib/writeback/email";
import { releaseAudit, runWriteBack, undoAudit, undoRun } from "@/lib/writeback/run";
import { checkPermissions, configFromForm, isWritebackMode, livePipelines, saveConfig, setMode } from "@/lib/writeback/setup";

// GHL write-back controls on the client page. Agency staff only: everyone else
// gets the same plain 404 as other staff-only actions, even when the request is
// built by hand. Each action ends on the client page with a message (?wb=).

async function staffOn(clientId: string) {
  const session = await requireAgencyStaffOr404();
  if (!isUuid(clientId)) throw new Error("Bad client id");
  return session;
}

function done(clientId: string, message: string): never {
  const page = `/dashboard/clients/${clientId}`;
  revalidatePath(page);
  redirect(`${page}?${new URLSearchParams({ wb: message.slice(0, 300) })}#writeback`);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function setWritebackModeAction(clientId: string, form: FormData) {
  await staffOn(clientId);
  const mode = form.get("mode");
  if (!isWritebackMode(mode)) throw new Error("Bad mode");
  const refused = await setMode(clientId, mode);
  done(clientId, refused ?? `Write-back mode set to ${mode[0].toUpperCase()}${mode.slice(1)}.`);
}

export async function saveWritebackSetupAction(clientId: string, form: FormData) {
  await staffOn(clientId);
  let result: string;
  try {
    const config = configFromForm(form, await livePipelines(clientId));
    if ("error" in config) result = config.error;
    else {
      await saveConfig(clientId, config);
      result = "Write-back setup saved.";
    }
  } catch (err) {
    result = `Setup not saved: ${errorText(err)}`;
  }
  done(clientId, result);
}

export async function checkPermissionsAction(clientId: string) {
  await staffOn(clientId);
  let result: string;
  try {
    const { ok } = await checkPermissions(clientId);
    result = ok ? "Check permissions passed." : "Check permissions failed; see the details below.";
  } catch (err) {
    result = `Check permissions failed: ${errorText(err)}`;
  }
  done(clientId, result);
}

// Run now (Preview: plan only; Auto: plan and write) and Apply (Preview: write the plan).
async function run(clientId: string, trigger: "run_now" | "apply") {
  const session = await staffOn(clientId);
  let result: string;
  try {
    const outcome = await runWriteBack(clientId, { trigger, userId: session.user.id });
    if (!outcome) result = "Write-back is Off for this client.";
    else {
      await sendWritebackSummary([outcome], trigger === "apply" ? "Apply" : "Run now");
      result =
        outcome.status === "locked"
          ? outcome.error!
          : `Run ${outcome.status}: ${outcome.planned} planned, ${outcome.updated} updated${outcome.error ? `. ${outcome.error}` : "."}`;
    }
  } catch (err) {
    result = `Run failed: ${errorText(err)}`;
  }
  done(clientId, result);
}

export async function runWritebackNowAction(clientId: string) {
  return run(clientId, "run_now");
}

export async function applyWritebackAction(clientId: string) {
  return run(clientId, "apply");
}

async function auditOf(clientId: string, form: FormData) {
  const auditId = String(form.get("auditId") ?? "");
  if (!isUuid(auditId)) throw new Error("Bad audit id");
  const [row] = await db
    .select({ id: writebackAudit.id })
    .from(writebackAudit)
    .where(and(eq(writebackAudit.id, auditId), eq(writebackAudit.clientId, clientId)));
  if (!row) throw new Error("Not this client's update");
  return row.id;
}

export async function undoWritebackAction(clientId: string, form: FormData) {
  const session = await staffOn(clientId);
  const auditId = await auditOf(clientId, form);
  let result: string;
  try {
    await undoAudit(auditId, session.user.id);
    result = "Update undone. Its payments are blocked until you press Release.";
  } catch (err) {
    result = `Undo failed: ${errorText(err)}`;
  }
  done(clientId, result);
}

export async function undoWritebackRunAction(clientId: string, form: FormData) {
  const session = await staffOn(clientId);
  const runId = String(form.get("runId") ?? "");
  if (!isUuid(runId)) throw new Error("Bad run id");
  const [row] = await db
    .select({ id: writebackRuns.id })
    .from(writebackRuns)
    .where(and(eq(writebackRuns.id, runId), eq(writebackRuns.clientId, clientId)));
  if (!row) throw new Error("Not this client's run");
  let result: string;
  try {
    const n = await undoRun(runId, session.user.id);
    result = `Run undone: ${n} update${n === 1 ? "" : "s"} restored. Their payments are blocked until released.`;
  } catch (err) {
    result = `Undo run stopped: ${errorText(err)}`;
  }
  done(clientId, result);
}

export async function releaseWritebackAction(clientId: string, form: FormData) {
  await staffOn(clientId);
  const auditId = await auditOf(clientId, form);
  let result: string;
  try {
    await releaseAudit(auditId);
    result = "Payments released; the next run may push them again.";
  } catch (err) {
    result = `Release failed: ${errorText(err)}`;
  }
  done(clientId, result);
}
