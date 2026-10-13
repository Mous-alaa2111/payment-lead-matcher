// Client Health rules, ported 1:1 from the GHL CLI's weekly_report.py
// (stage keywords, categorize) and health_tracker.py (compute_health).
//
// Rules (unchanged from the Python):
//   - A week is Monday 00:00 to the next Monday, UTC. Total = opportunities
//     created that week.
//   - Booked: the opportunity's current stage name contains "booked"/"booking",
//     or "scheduled" but not "not scheduled"/"unscheduled".
//   - From the latest two weeks: Trend Up/Down/Flat ("N/A (new)" with one week),
//     Booked Rate = booked / total (N/A when total is 0), Weeks Since Last
//     Activity = most recent weeks in a row with total 0.
//   - Red: 2+ weeks with no activity. Yellow: this week 0, trend Down, or booked
//     rate under 20%. Otherwise green. No weeks at all: grey "No data".
//
// App-only additions (not in the Python): a client with no GHL token, or whose
// last refresh failed, is grey with that reason, never red.
//
// Pure functions: no I/O, no env, safe to use anywhere.

const DAY = 86_400_000;
const WEEK = 7 * DAY;

export const BOOKED_RATE_THRESHOLD = 20; // % — below this is a "low" booked rate
export const BACKFILL_WEEKS = 8; // weeks fetched on a client's first refresh (this week included)

// Stage name substrings (lowercase) that map to contacted
export const CONTACTED_KEYWORDS = ["contacted", "lead contacted", "contact made"];
const BOOKED_POSITIVE = ["booked", "booking"];
const BOOKED_SCHEDULED = "scheduled";
const BOOKED_EXCLUDED = ["not scheduled", "unscheduled"];

export function isBooked(stageName: string): boolean {
  const lower = stageName.toLowerCase();
  if (BOOKED_POSITIVE.some((k) => lower.includes(k))) return true;
  return lower.includes(BOOKED_SCHEDULED) && !BOOKED_EXCLUDED.some((ex) => lower.includes(ex));
}

export type Opportunity = {
  createdAt?: string | number | null;
  pipelineStageId?: string | null;
  status?: string | null;
  monetaryValue?: number | string | null;
};

export type WeekCounts = { total: number; contacted: number; booked: number; won: number; lost: number; revenueCents: number };

// weekly_report.py categorize(), with won and lost kept apart (the Python sums them as "closed").
export function categorize(opps: Opportunity[], stageMap: Map<string, string>): WeekCounts {
  const m: WeekCounts = { total: opps.length, contacted: 0, booked: 0, won: 0, lost: 0, revenueCents: 0 };
  for (const opp of opps) {
    const stageName = (stageMap.get(opp.pipelineStageId ?? "") ?? "").toLowerCase();
    const status = (opp.status ?? "").toLowerCase();
    if (CONTACTED_KEYWORDS.some((k) => stageName.includes(k))) m.contacted++;
    if (isBooked(stageName)) m.booked++;
    if (status === "won") {
      m.won++;
      const value = Number(opp.monetaryValue ?? 0);
      if (Number.isFinite(value)) m.revenueCents += Math.round(value * 100);
    }
    if (status === "lost") m.lost++;
  }
  return m;
}

// Epoch ms for an opportunity's createdAt (ISO string or ms), or null if unreadable.
export function createdAtMs(raw: Opportunity["createdAt"]): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const ms = typeof raw === "number" ? raw : /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

// Monday 00:00 UTC of the week containing `d`.
export function weekStart(d: Date): Date {
  const day = new Date(Math.floor(d.getTime() / DAY) * DAY);
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - sinceMonday * DAY);
}

export const weekEnd = (start: Date) => new Date(start.getTime() + WEEK);
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export type StoredWeek = { weekStart: string; fetchedAt: Date }; // weekStart is YYYY-MM-DD

// Which weeks (Monday dates, oldest first) a refresh should fetch: every week
// in the last BACKFILL_WEEKS that isn't final yet. A week fetched after it
// ended is final (frozen) and never fetched again. So a client's first refresh
// backfills all BACKFILL_WEEKS weeks once; after that it's this week, plus
// last week until it has been fetched once after it ended (and any week left
// half-done or missing by refreshes that didn't happen).
export function weeksToFetch(stored: StoredWeek[], now = new Date()): Date[] {
  const current = weekStart(now);
  const byStart = new Map(stored.map((w) => [w.weekStart, w]));
  const weeks: Date[] = [];
  for (let i = BACKFILL_WEEKS - 1; i >= 0; i--) {
    const start = new Date(current.getTime() - i * WEEK);
    const row = byStart.get(isoDay(start));
    if (!row || row.fetchedAt < weekEnd(start)) weeks.push(start);
  }
  return weeks;
}

export type HealthKey = "green" | "yellow" | "red" | "grey";

export type ClientHealth = {
  thisWeek: number | null;
  lastWeek: number | null;
  trend: "Up" | "Down" | "Flat" | "N/A (new)" | null;
  bookedRate: number | null; // %, unrounded; null when this week's total is 0
  bookedRateDisplay: string; // "25%" or "N/A"
  weeksSince: number | null;
  status: HealthKey;
  label: string;
};

// Python's f"{x:.0f}" rounds half to even (12.5 -> "12"); Math.round wouldn't.
function roundHalfEven(x: number) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// health_tracker.py weeks_since_last_activity(): 0 = active this week.
export function weeksSinceLastActivity(weeks: { total: number }[]): number {
  let count = 0;
  for (let i = weeks.length - 1; i >= 0; i--) {
    if (weeks[i].total > 0) return count;
    count++;
  }
  return count;
}

const greyOnly = (label: string): ClientHealth => ({
  thisWeek: null, lastWeek: null, trend: null, bookedRate: null, bookedRateDisplay: "N/A", weeksSince: null,
  status: "grey", label,
});

// health_tracker.py compute_health(). `weeks` is chronological (oldest first).
export function clientHealth(
  weeks: { total: number; booked: number }[],
  opts: { hasToken?: boolean; error?: string | null } = {},
): ClientHealth {
  if (opts.hasToken === false) return greyOnly("No GHL token");
  if (opts.error) return greyOnly("Refresh failed");
  if (!weeks.length) return greyOnly("No data");

  const thisWk = weeks[weeks.length - 1];
  const lastWk = weeks.length >= 2 ? weeks[weeks.length - 2] : null;
  const totalThis = thisWk.total;

  const trend = !lastWk ? "N/A (new)" : totalThis > lastWk.total ? "Up" : totalThis < lastWk.total ? "Down" : "Flat";
  const bookedRate = totalThis > 0 ? (thisWk.booked / totalThis) * 100 : null;
  const weeksSince = weeksSinceLastActivity(weeks);

  let status: HealthKey;
  if (weeksSince >= 2) status = "red";
  else if (totalThis === 0 || trend === "Down" || (bookedRate !== null && bookedRate < BOOKED_RATE_THRESHOLD)) status = "yellow";
  else status = "green";

  return {
    thisWeek: totalThis,
    lastWeek: lastWk ? lastWk.total : null,
    trend,
    bookedRate,
    bookedRateDisplay: bookedRate === null ? "N/A" : `${roundHalfEven(bookedRate)}%`,
    weeksSince,
    status,
    label: { green: "Green", yellow: "Yellow", red: "Red", grey: "No data" }[status],
  };
}
