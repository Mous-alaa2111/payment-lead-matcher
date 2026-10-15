import { and, count, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { clients, invitations } from "@/db/schema";

// Invite emails, sent through Resend's HTTP API. Needs RESEND_API_KEY and
// EMAIL_FROM_ADDRESS (a full from address, e.g. `Elko Creative <invites@…>`);
// without either, nothing is sent and the page shows the invite link only.
// The invite is always created first: sending never throws or blocks it.
//
// Logs say only whether sending worked and the provider's error code: never
// the link, the email body, the recipient or the key.

export const AGENCY_NAME = "Elko Creative";
// Per inviting user, rolling hour, counted from the invitations they created.
export const INVITE_EMAILS_PER_HOUR = 20;
const SEND_TIMEOUT_MS = 10_000;

export type InviteEmailStatus = "sent" | "failed" | "rate_limited" | "not_configured";

function settings() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM_ADDRESS?.trim();
  if (!apiKey || !from) return null;
  // RESEND_API_URL exists only so the e2e suite can point at its mock.
  return { apiKey, from, apiUrl: process.env.RESEND_API_URL?.trim() || "https://api.resend.com" };
}

const formatExpiry = (d: Date) =>
  `${d.toLocaleString("en-US", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" })} UTC`;

export function inviteEmailContent(opts: { inviter: string; target: string; role: string; url: string; expiresAt: Date }) {
  return {
    subject: `You're invited to ${opts.target}`,
    text: [
      `${opts.inviter} invited you to ${opts.target} on Payment Lead Matcher.`,
      `Role: ${opts.role}`,
      "",
      "Accept the invite here:",
      opts.url,
      "",
      `This link expires on ${formatExpiry(opts.expiresAt)}.`,
      "If you weren't expecting this, you can ignore this email.",
    ].join("\n"),
  };
}

async function overHourlyLimit(userId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(invitations)
    .where(and(eq(invitations.invitedBy, userId), gt(invitations.createdAt, new Date(Date.now() - 3_600_000))));
  // The invite being emailed is already stored, so it's included in the count.
  return row.n > INVITE_EMAILS_PER_HOUR;
}

// Emails the link for a just-created invite. Never throws.
export async function sendInviteEmail(opts: {
  invite: typeof invitations.$inferSelect;
  url: string;
  inviter: { id: string; name: string; email: string };
}): Promise<InviteEmailStatus> {
  try {
    const config = settings();
    if (!config) return "not_configured";
    if (await overHourlyLimit(opts.inviter.id)) {
      console.warn("[invite-email] not sent: rate_limited");
      return "rate_limited";
    }

    const { invite } = opts;
    let target = AGENCY_NAME;
    if (!invite.agencyStaff && invite.clientId) {
      const [client] = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, invite.clientId));
      if (client) target = client.name;
    }
    const { subject, text } = inviteEmailContent({
      inviter: opts.inviter.name || opts.inviter.email,
      target,
      role: invite.agencyStaff ? "agency staff (access to every client)" : invite.role,
      url: opts.url,
      expiresAt: invite.expiresAt,
    });

    const res = await fetch(`${config.apiUrl}/emails`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: config.from, to: [invite.email], subject, text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Resend errors look like { statusCode, name: "validation_error", message }; only `name` is logged.
      const body = (await res.json().catch(() => null)) as { name?: unknown } | null;
      const code = typeof body?.name === "string" && /^[a-z0-9_]{1,64}$/i.test(body.name) ? body.name : `http_${res.status}`;
      console.error(`[invite-email] send failed: ${code}`);
      return "failed";
    }
    console.log("[invite-email] sent");
    return "sent";
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    console.error(`[invite-email] send failed: ${/^[A-Za-z]{1,40}$/.test(name) ? name : "error"}`);
    return "failed";
  }
}
