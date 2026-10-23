// When the daily auto sync (lib/sync/auto, Vercel Cron) picks a client up.
// Pure, so it can be shown on the client page and unit-tested.
//
// A client is due once its oldest connected account's last successful sync
// (Sync now, Sync range or auto) is AUTO_SYNC_EVERY_DAYS or more UTC days old.
// Whole days, not hours: the cron fires at a slightly different minute each
// day, and an hour-exact rule would let a 06:20 sync miss the 06:05 run 14 days
// later and slip to day 15.

const DAY = 86_400_000;

// How often each client is auto synced. Change this one number to change it.
export const AUTO_SYNC_EVERY_DAYS = 14;
// Clients whose GHL write-back is on Auto are synced (and written back) daily.
export const WRITEBACK_AUTO_SYNC_EVERY_DAYS = 1;

export const syncEveryDays = (writebackMode: string) =>
  writebackMode === "auto" ? WRITEBACK_AUTO_SYNC_EVERY_DAYS : AUTO_SYNC_EVERY_DAYS;

// Must match the schedule in vercel.json ("0 6 * * *"; a unit test checks it).
// On the Hobby plan Vercel fires a daily cron somewhere within that hour.
export const AUTO_SYNC_CRON_HOUR_UTC = 6;

const startOfUtcDay = (d: Date) => new Date(Math.floor(d.getTime() / DAY) * DAY);

type Conn = { lastSyncedAt: Date | null };
type Client = { ghlLocationId: string | null; ghlTokenEnc: string | null };

// Why a client is left out of auto sync, or null if it takes part.
export function autoSyncBlocker(client: Client, conns: Conn[]): string | null {
  if (!conns.length) return "connect Stripe or Square to turn it on";
  if (!client.ghlLocationId || !client.ghlTokenEnc) return "add a GHL token to turn it on";
  return null;
}

// The UTC day from which the client is due; null = due now (an account has never synced).
export function autoSyncDueFrom(conns: Conn[], everyDays = AUTO_SYNC_EVERY_DAYS): Date | null {
  if (conns.some((c) => !c.lastSyncedAt)) return null;
  const oldest = Math.min(...conns.map((c) => c.lastSyncedAt!.getTime()));
  return new Date(startOfUtcDay(new Date(oldest)).getTime() + everyDays * DAY);
}

export function isAutoSyncDue(conns: Conn[], now = new Date(), everyDays = AUTO_SYNC_EVERY_DAYS): boolean {
  const from = autoSyncDueFrom(conns, everyDays);
  return !from || from <= now;
}

// The first cron run at or after `t` (the top of AUTO_SYNC_CRON_HOUR_UTC).
export function nextCronRun(t: Date): Date {
  const run = new Date(startOfUtcDay(t).getTime() + AUTO_SYNC_CRON_HOUR_UTC * 3_600_000);
  return run >= t ? run : new Date(run.getTime() + DAY);
}

// The cron run expected to sync this client next. If it's already due, that's
// the next run (today's run may have run out of time before reaching it).
export function nextAutoSync(conns: Conn[], now = new Date(), everyDays = AUTO_SYNC_EVERY_DAYS): Date {
  const from = autoSyncDueFrom(conns, everyDays);
  return nextCronRun(from && from > now ? from : now);
}
