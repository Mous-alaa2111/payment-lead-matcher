// Points DATABASE_URL at the Neon e2e branch (from .env.test.local) so tests
// never touch production data. Refuses to run if that file is missing or if it
// points at the same Neon endpoint as .env.local.
//
// As a runner: tsx scripts/e2e-db.ts <command...>   (e.g. drizzle-kit migrate)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "dotenv";

const TEST_ENV = ".env.test.local";

const endpoint = (url: string) => new URL(url).hostname.replace("-pooler", "");

export function selectE2EDatabase() {
  if (!existsSync(TEST_ENV)) {
    throw new Error(`${TEST_ENV} not found. Put the Neon e2e branch's DATABASE_URL in it (see README).`);
  }
  const testUrl = parse(readFileSync(TEST_ENV)).DATABASE_URL;
  if (!testUrl) throw new Error(`DATABASE_URL is not set in ${TEST_ENV}`);
  const mainUrl = existsSync(".env.local") ? parse(readFileSync(".env.local")).DATABASE_URL : undefined;
  if (mainUrl && endpoint(mainUrl) === endpoint(testUrl)) {
    throw new Error(`${TEST_ENV} points at the same Neon endpoint as .env.local. Refusing to run against production data.`);
  }
  process.env.DATABASE_URL = testUrl;
  return endpoint(testUrl);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/e2e-db.ts")) {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) {
    console.error("usage: tsx scripts/e2e-db.ts <command...>");
    process.exit(2);
  }
  try {
    console.log(`Using e2e database (${selectE2EDatabase()})`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  // shell: true joins args with spaces, so re-quote any that contain spaces.
  const quoted = args.map((a) => (/\s/.test(a) ? `"${a}"` : a));
  const r = spawnSync(cmd, quoted, { stdio: "inherit", shell: true, env: process.env });
  process.exit(r.status ?? 1);
}
