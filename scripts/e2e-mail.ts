// Shared by scripts/e2e-server.ts and scripts/e2e.ts: the app on :3000 sends
// invite emails to a mock of Resend's API that the suite runs, never to Resend.
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAIL_MOCK_PORT = 4010;
export const MAIL_ENV = {
  RESEND_API_KEY: "re_e2e_fake_key_7f3a9c", // fake; the suite checks it never shows up in the server log
  EMAIL_FROM_ADDRESS: "E2E Invites <invites@e2e.example.test>",
  RESEND_API_URL: `http://localhost:${MAIL_MOCK_PORT}`,
};
// `next start` output, so the suite can check nothing secret was logged.
export const SERVER_LOG = join(tmpdir(), "payment-lead-matcher-e2e-server.log");
