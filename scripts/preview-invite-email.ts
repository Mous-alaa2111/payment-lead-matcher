// Writes a sample invite email (the HTML version, plus the plain text next to it)
// to local files to open in a browser. Sends nothing and needs no database or env.
//   npm run preview:invite-email            (writes to the system temp folder)
//   npm run preview:invite-email -- out.html
//   npm run preview:invite-email -- --agency   (an agency staff invite)
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENCY_NAME, AGENCY_STAFF_ROLE, inviteEmailContent } from "../src/lib/invite-email-content";

const args = process.argv.slice(2);
const agency = args.includes("--agency");
const out = resolve(args.find((a) => !a.startsWith("--")) ?? join(tmpdir(), "invite-email-preview.html"));
const { subject, text, html } = inviteEmailContent({
  inviter: "Dana Example",
  target: agency ? AGENCY_NAME : "Acme Plumbing & Heating",
  role: agency ? AGENCY_STAFF_ROLE : "admin",
  url: "https://payment-lead-matcher.vercel.app/invite/sample-token-not-real",
  expiresAt: new Date(Date.now() + 7 * 86_400_000),
});
writeFileSync(out, html);
writeFileSync(out.replace(/\.html?$/i, "") + ".txt", `Subject: ${subject}\n\n${text}\n`);
console.log(`Wrote ${out} (and the plain text as .txt beside it)`);
