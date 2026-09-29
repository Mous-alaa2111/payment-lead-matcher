import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";

config({ path: ".env.local", quiet: true });
const sql = neon(process.env.DATABASE_URL!);

sql`select (select count(*) from "user") users, (select count(*) from clients) clients,
           (select count(*) from invitations) invites, (select count(*) from payment_connections) conns,
           (select count(*) from session) sessions`.then((r) => console.log(r[0]));
