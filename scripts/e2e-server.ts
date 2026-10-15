// Builds and starts the app on :3000 against the e2e database, with fake Stripe
// creds, Square left unconfigured and invite emails pointed at the suite's Resend
// mock (scripts/e2e-mail.ts), as `npm run test:e2e` expects. Server output is
// also written to SERVER_LOG so the suite can check what got logged.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { selectE2EDatabase } from "./e2e-db";
import { MAIL_ENV, SERVER_LOG } from "./e2e-mail";

try {
  console.log(`Using e2e database (${selectE2EDatabase()})`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const env = {
  ...process.env,
  STRIPE_CONNECT_CLIENT_ID: "ca_e2e_fake",
  STRIPE_SECRET_KEY: "sk_test_e2e_fake",
  SQUARE_APPLICATION_ID: "",
  SQUARE_APPLICATION_SECRET: "",
  CRON_SECRET: "e2e-cron-secret", // E2E_CRON_SECRET in scripts/e2e.ts
  ...MAIL_ENV, // invite emails go to the suite's mock of Resend
};
const build = spawnSync("npx next build", { stdio: "inherit", shell: true, env });
if (build.status !== 0) process.exit(build.status ?? 1);

// The server's output goes to the console and to SERVER_LOG (truncated on each start).
const log = createWriteStream(SERVER_LOG);
const server = spawn("npx next start", { shell: true, env, stdio: ["inherit", "pipe", "pipe"] });
for (const [from, to] of [[server.stdout, process.stdout], [server.stderr, process.stderr]] as const) {
  from.on("data", (chunk) => {
    to.write(chunk);
    log.write(chunk);
  });
}
server.on("exit", (code) => process.exit(code ?? 1));
