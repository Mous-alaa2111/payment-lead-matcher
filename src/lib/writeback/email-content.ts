import { esc } from "@/lib/invite-email-content";
import type { RunOutcome } from "./run";

// What the write-back summary email says (lib/writeback/email sends it).
// Counts only: clients by number with a link, no names, amounts or error text.

export const happened = (o: RunOutcome) =>
  o.updated > 0 || o.newNeedsReview > 0 || o.status === "error" || o.status === "capped" || o.status === "killed";

export function summaryContent(outcomes: RunOutcome[], trigger: string, link: (clientId: string) => string) {
  const shown = outcomes.filter(happened);
  const total = (k: "updated" | "newNeedsReview") => shown.reduce((n, o) => n + o[k], 0);
  const errors = shown.filter((o) => o.status === "error").length;
  const lines = shown.map((o, i) => {
    const skipped = Object.values(o.skipped).reduce((a, b) => a + b, 0);
    const parts = [
      `${o.updated} updated`,
      `${skipped} skipped`,
      ...(o.newNeedsReview ? [`${o.newNeedsReview} need review`] : []),
      ...(o.status === "capped" ? ["stopped at the cap"] : []),
      ...(o.status === "killed" ? ["stopped by the kill switch"] : []),
      ...(o.status === "error" ? ["stopped on an error"] : []),
    ];
    return { label: `Client ${i + 1}`, text: parts.join(", "), url: link(o.clientId) };
  });
  const subject = `GHL write-back: ${total("updated")} updated${errors ? `, ${errors} with errors` : ""}${total("newNeedsReview") ? `, ${total("newNeedsReview")} need review` : ""}`;
  const intro = `Write-back run (${trigger}) on ${shown.length} client${shown.length === 1 ? "" : "s"}. Details and Undo are on each client page.`;
  return {
    subject,
    text: [intro, "", ...lines.map((l) => `${l.label}: ${l.text}\n${l.url}`)].join("\n"),
    html:
      `<p style="font-family:Arial,Helvetica,sans-serif">${esc(intro)}</p><ul style="font-family:Arial,Helvetica,sans-serif">` +
      lines.map((l) => `<li><a href="${esc(l.url)}">${esc(l.label)}</a>: ${esc(l.text)}</li>`).join("") +
      "</ul>",
  };
}
