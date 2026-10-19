// What an invite email says: subject, plain text and HTML. No database or
// network here, so scripts/preview-invite-email.ts can render it on its own.
//
// The HTML is table-based with inline CSS only (no stylesheet, scripts, tracking
// pixels or rewritten links) so it holds up in Gmail, Outlook and Apple Mail.
// Every dynamic value goes through esc(). Colors are solid (navy header band,
// white card) so it stays readable when a client applies dark mode, and the
// logo's alt text keeps the header readable with images blocked.

export const AGENCY_NAME = "Elko Creative";
// Agency staff invites pass this as the role.
export const AGENCY_STAFF_ROLE = "agency staff (access to every client)";

// Production copy of public/elko-logo.png (white lettering, transparent; it sits on the navy band).
const LOGO_URL = "https://payment-lead-matcher.vercel.app/elko-logo.png";
const NAVY = "#1f3a68";
const FONT = "Arial, Helvetica, sans-serif";

// The role in plain words, for the HTML sentence ("... as an admin").
const ROLE_WORDS: Record<string, string> = {
  owner: "an owner",
  admin: "an admin",
  viewer: "a viewer, with read-only access",
  [AGENCY_STAFF_ROLE]: "agency staff, with access to every client",
};

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const formatExpiry = (d: Date) =>
  `${d.toLocaleString("en-US", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" })} UTC`;

export type InviteEmailInput = { inviter: string; target: string; role: string; url: string; expiresAt: Date };

export function inviteEmailContent(opts: InviteEmailInput) {
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
    html: inviteEmailHtml(opts),
  };
}

function inviteEmailHtml(opts: InviteEmailInput) {
  const inviter = esc(opts.inviter);
  const target = esc(opts.target);
  const role = esc(ROLE_WORDS[opts.role] ?? opts.role);
  const url = esc(opts.url);
  const expiry = esc(formatExpiry(opts.expiresAt));
  const text = `font-family:${FONT};color:#3f3f46;`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>You're invited to ${target}</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f2f4;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:#f1f2f4;">Accept your invite to ${target}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f1f2f4" style="background-color:#f1f2f4;">
<tr>
<td align="center" style="padding:32px 12px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e4e4e7;border-radius:12px;border-collapse:separate;overflow:hidden;">
<tr>
<td align="center" bgcolor="${NAVY}" style="background-color:${NAVY};padding:8px 24px;border-radius:12px 12px 0 0;">
<img src="${LOGO_URL}" width="120" height="120" alt="${esc(AGENCY_NAME)}" style="display:block;width:120px;height:120px;border:0;outline:none;text-decoration:none;font-family:${FONT};font-size:16px;font-weight:bold;line-height:120px;color:#ffffff;text-align:center;">
</td>
</tr>
<tr>
<td style="padding:36px 32px 8px 32px;">
<h1 style="margin:0 0 16px 0;font-family:${FONT};font-size:24px;line-height:32px;font-weight:bold;color:#18181b;">You've been invited</h1>
<p style="margin:0 0 28px 0;${text}font-size:16px;line-height:24px;"><strong style="color:#18181b;">${inviter}</strong> invited you to join <strong style="color:#18181b;">${target}</strong> on Payment Lead Matcher as ${role}.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px 0;">
<tr>
<td align="center" bgcolor="${NAVY}" style="background-color:${NAVY};border-radius:8px;">
<a href="${url}" target="_blank" style="display:inline-block;padding:15px 32px;font-family:${FONT};font-size:17px;line-height:22px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px;border:1px solid ${NAVY};">Accept invitation</a>
</td>
</tr>
</table>
<p style="margin:0 0 24px 0;${text}font-size:14px;line-height:21px;">This invitation expires on <strong style="color:#18181b;">${expiry}</strong>.</p>
<p style="margin:0 0 8px 0;${text}font-size:13px;line-height:19px;color:#71717a;">If the button doesn't work, copy and paste this link into your browser:</p>
<p style="margin:0 0 28px 0;font-family:${FONT};font-size:13px;line-height:19px;word-break:break-all;color:${NAVY};">${url}</p>
</td>
</tr>
<tr>
<td style="padding:20px 32px 28px 32px;border-top:1px solid #e4e4e7;">
<p style="margin:0 0 4px 0;font-family:${FONT};font-size:13px;line-height:19px;font-weight:bold;color:#3f3f46;">${esc(AGENCY_NAME)}</p>
<p style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:#71717a;">If you weren't expecting this, you can ignore this email.</p>
</td>
</tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td>
</tr>
</table>
</body>
</html>`;
}
