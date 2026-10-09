import { createHash, timingSafeEqual } from "node:crypto";
import { runAutoSync } from "@/lib/sync/auto";

// Called once a day by Vercel Cron (vercel.json), which sends
// "Authorization: Bearer $CRON_SECRET". Anything else gets 401.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const digest = (s: string) => createHash("sha256").update(s).digest();

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // not configured: refuse rather than run open
  const given = request.headers.get("authorization") ?? "";
  return timingSafeEqual(digest(given), digest(`Bearer ${secret}`));
}

export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const report = await runAutoSync();
  console.log("[auto-sync]", JSON.stringify(report));
  return Response.json(report);
}
