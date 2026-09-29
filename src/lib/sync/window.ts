// Which slice of time a sync pulls payments for. Provider-neutral: Square uses
// it today, and a Stripe sync should take the same window.
//
// - "latest" (plain Sync now): from where the last latest-sync got to, minus
//   an overlap so late-landing payments aren't missed, up to now. A
//   connection that has never synced gets the last FIRST_SYNC_DAYS days.
// - "range": whole UTC days, both ends inclusive, for backfills or one period.

const DAY = 86_400_000;
export const FIRST_SYNC_DAYS = 90;
export const OVERLAP_DAYS = 7;

export type SyncWindow = { kind: "latest" | "range"; start: Date; end: Date };

export function latestWindow(syncedThrough: Date | null, now = new Date()): SyncWindow {
  const start = syncedThrough
    ? new Date(syncedThrough.getTime() - OVERLAP_DAYS * DAY)
    : new Date(now.getTime() - FIRST_SYNC_DAYS * DAY);
  return { kind: "latest", start, end: now };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const parseDay = (s: string) => {
  if (!ISO_DAY.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d; // rejects 2026-02-31
};

// `from` / `to` are YYYY-MM-DD (what <input type="date"> submits). An end date
// of today or later is capped at now.
export function parseRange(from: string, to: string, now = new Date()): SyncWindow | { error: string } {
  const start = parseDay(from.trim());
  const endDay = parseDay(to.trim());
  if (!start || !endDay) return { error: "Pick both a start and an end date." };
  if (start > endDay) return { error: "The start date must be on or before the end date." };
  if (start > now) return { error: "The start date is in the future." };
  const end = new Date(Math.min(endDay.getTime() + DAY, now.getTime()));
  return { kind: "range", start, end };
}

// How far "latest" syncs have covered, after a successful sync of window `w`.
// A range only moves it forward when it starts inside what's already covered
// (otherwise it would leave a gap that the next Sync now wouldn't fill).
export function nextSyncedThrough(current: Date | null, w: SyncWindow): Date | null {
  if (w.kind === "latest") return w.end;
  if (current && w.start <= current && w.end > current) return w.end;
  return current;
}

export const formatDay = (d: Date) => d.toISOString().slice(0, 10);
