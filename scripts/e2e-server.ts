// Builds and starts the app on :3000 against the e2e database, with fake Stripe
// creds and Square left unconfigured, as `npm run test:e2e` expects.
import { spawnSync } from "node:child_process";
import { selectE2EDatabase } from "./e2e-db";

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
};
for (const cmd of ["npx next build", "npx next start"]) {
  const r = spawnSync(cmd, { stdio: "inherit", shell: true, env });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
