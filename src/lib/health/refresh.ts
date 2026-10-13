import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { clientHealthStatus, clientHealthWeeks, clients } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { getOpportunities, getStageMap } from "./ghl";
import { categorize, createdAtMs, isoDay, weekEnd, weeksToFetch, type Opportunity } from "./rules";

// Clients refreshed at once. GHL rate-limits per location, so this only bounds
// how long Refresh now takes and how hard we hit GHL overall.
export const REFRESH_CONCURRENCY = 3;

export type HealthRefreshReport = { client: string; ok: boolean; weeks: number; error?: string }[];

// Refresh now on the Client Health page. For every client with a GHL location
// and token, fetch the weeks that aren't final yet (lib/health/rules
// weeksToFetch) and store one row per week. Each client's result or error goes
// in client_health_status; one client failing never stops the rest.
export async function refreshClientHealth({
  now = new Date(),
  onlyClientIds, // tests: limit the run to these clients
}: { now?: Date; onlyClientIds?: string[] } = {}): Promise<HealthRefreshReport> {
  const withGhl = await db
    .select({ id: clients.id, name: clients.name, locationId: clients.ghlLocationId, tokenEnc: clients.ghlTokenEnc })
    .from(clients)
    .where(
      and(
        isNotNull(clients.ghlLocationId),
        isNotNull(clients.ghlTokenEnc),
        onlyClientIds ? inArray(clients.id, onlyClientIds) : undefined,
      ),
    );
  const todo = withGhl.filter((c) => c.locationId && c.tokenEnc);

  const report: HealthRefreshReport = [];
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const c = todo[next++];
      try {
        const weeks = await refreshOne(c.id, c.locationId!, decrypt(c.tokenEnc!), now);
        await saveStatus(c.id, now, null);
        report.push({ client: c.name, ok: true, weeks });
      } catch (err) {
        const message = (err as Error).message.slice(0, 500);
        console.error(`[client-health] ${c.name}`, err);
        await saveStatus(c.id, now, message).catch((e) =>
          console.error(`[client-health] couldn't record the error for ${c.name}`, e),
        );
        report.push({ client: c.name, ok: false, weeks: 0, error: message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, todo.length) }, worker));
  return report;
}

async function saveStatus(clientId: string, at: Date, lastError: string | null) {
  await db
    .insert(clientHealthStatus)
    .values({ clientId, lastRefreshedAt: at, lastError })
    .onConflictDoUpdate({ target: clientHealthStatus.clientId, set: { lastRefreshedAt: at, lastError } });
}

// Fetches and stores one client's unfinished weeks; returns how many weeks it wrote.
async function refreshOne(clientId: string, locationId: string, token: string, now: Date) {
  const stored = await db
    .select({ weekStart: clientHealthWeeks.weekStart, fetchedAt: clientHealthWeeks.fetchedAt })
    .from(clientHealthWeeks)
    .where(eq(clientHealthWeeks.clientId, clientId));
  const weeks = weeksToFetch(stored, now);
  if (!weeks.length) return 0;

  // One newest-first pass over the whole span, bucketed by week.
  const stageMap = await getStageMap(locationId, token);
  const opps = await getOpportunities(locationId, token, weeks[0].getTime(), weekEnd(weeks[weeks.length - 1]).getTime());
  const rows = weeks.map((start) => {
    const [from, to] = [start.getTime(), weekEnd(start).getTime()];
    const inWeek = opps.filter((o: Opportunity) => {
      const ts = createdAtMs(o.createdAt)!; // getOpportunities only returns readable ones
      return ts >= from && ts < to;
    });
    return { clientId, weekStart: isoDay(start), ...categorize(inWeek, stageMap), fetchedAt: now };
  });

  await db
    .insert(clientHealthWeeks)
    .values(rows)
    .onConflictDoUpdate({
      target: [clientHealthWeeks.clientId, clientHealthWeeks.weekStart],
      set: {
        total: sql`excluded.total`,
        contacted: sql`excluded.contacted`,
        booked: sql`excluded.booked`,
        won: sql`excluded.won`,
        lost: sql`excluded.lost`,
        revenueCents: sql`excluded.revenue_cents`,
        fetchedAt: sql`excluded.fetched_at`,
      },
    });
  return rows.length;
}
