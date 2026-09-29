import { config } from "dotenv";

config({ path: ".env.local" });

async function main() {
  const { sql } = await import("../src/db");
  const [row] = await sql`
    select current_database() as db, current_user as "user", version() as version, now() as now
  `;
  console.log("Connected to Neon Postgres");
  console.log(`  database: ${row.db}`);
  console.log(`  user:     ${row.user}`);
  console.log(`  server:   ${String(row.version).split(" on ")[0]}`);
  console.log(`  now():    ${row.now}`);
}

main().catch((err) => {
  console.error("Database connection failed:", err.message);
  process.exit(1);
});
