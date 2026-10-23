import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agencyStaff, user } from "@/db/schema";
import { resendSettings } from "@/lib/invite-email";
import { appUrl } from "@/lib/url";
import { happened, summaryContent } from "./email-content";
import type { RunOutcome } from "./run";

// Staff summary after a write-back run (one per cron run, one per Sync now /
// Run now / Apply). Counts only: no client, lead or payer names, no amounts.
// Clients are listed by number with a link to their page. Sent to agency staff
// only, through the same Resend settings as invite emails. Skipped when nothing
// happened (no update, no error, no cap, no new "needs review"). Never throws.

export type SummaryEmailStatus = "sent" | "skipped" | "failed" | "not_configured";

export async function sendWritebackSummary(outcomes: (RunOutcome | null)[], trigger: string): Promise<SummaryEmailStatus> {
  try {
    const real = outcomes.filter((o): o is RunOutcome => Boolean(o));
    if (!real.some(happened)) return "skipped";
    const config = resendSettings();
    if (!config) return "not_configured";
    const staff = await db.select({ email: user.email }).from(agencyStaff).innerJoin(user, eq(agencyStaff.userId, user.id));
    if (!staff.length) return "skipped";
    const { subject, text, html } = summaryContent(real, trigger, (id) => appUrl(`/dashboard/clients/${id}`));
    const res = await fetch(`${config.apiUrl}/emails`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: config.from, to: staff.map((s) => s.email), ...(config.replyTo && { reply_to: config.replyTo }), subject, html, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[writeback-email] send failed: http_${res.status}`);
      return "failed";
    }
    console.log("[writeback-email] sent");
    return "sent";
  } catch (err) {
    console.error(`[writeback-email] send failed: ${err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "error"}`);
    return "failed";
  }
}
