import { sql } from "@/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [row] = await sql`select now() as now`;
    return Response.json({ ok: true, db: "up", now: row.now });
  } catch (err) {
    return Response.json(
      { ok: false, db: "down", error: (err as Error).message },
      { status: 503 },
    );
  }
}
