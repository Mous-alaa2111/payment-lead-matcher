import { asc } from "drizzle-orm";
import Link from "next/link";
import { SubmitButton } from "@/components/submit-button";
import { db } from "@/db";
import { clientHealthStatus, clientHealthWeeks, clients } from "@/db/schema";
import { requireAgencyStaffOr404 } from "@/lib/access";
import { CLIENT_STATUS_LABEL, type ClientStatus } from "@/lib/client-status";
import { BOOKED_RATE_THRESHOLD, clientHealth, isoDay, weekStart, type HealthKey } from "@/lib/health/rules";
import { refreshHealthAction } from "./actions";

// Refresh now reads every client's opportunities from GHL; it may run long.
export const maxDuration = 300;

// ?show= filter. Active and onboarding clients by default.
const FILTERS = {
  current: { label: "Active & onboarding", statuses: ["active", "onboarding"] },
  paused: { label: "Paused", statuses: ["paused"] },
  canceled: { label: "Canceled", statuses: ["canceled"] },
  all: { label: "All", statuses: ["active", "onboarding", "paused", "canceled"] },
} satisfies Record<string, { label: string; statuses: ClientStatus[] }>;
type Filter = keyof typeof FILTERS;

const BADGE: Record<HealthKey, string> = {
  green: "bg-teal-100 text-teal-900 ring-teal-700/20 dark:bg-teal-950 dark:text-teal-200 dark:ring-teal-400/30",
  yellow: "bg-amber-100 text-amber-900 ring-amber-700/20 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-400/30",
  red: "bg-red-100 text-red-900 ring-red-700/20 dark:bg-red-950 dark:text-red-200 dark:ring-red-400/30",
  grey: "bg-zinc-100 text-zinc-700 ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-400/20",
};
const ORDER: Record<HealthKey, number> = { red: 0, yellow: 1, green: 2, grey: 3 };

const utc = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const shortDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export default async function HealthPage(props: PageProps<"/dashboard/health">) {
  await requireAgencyStaffOr404();
  const search = await props.searchParams;
  const filter: Filter = typeof search.show === "string" && search.show in FILTERS ? (search.show as Filter) : "current";

  const [allClients, weeks, statuses] = await Promise.all([
    db
      .select({ id: clients.id, name: clients.name, status: clients.status, loc: clients.ghlLocationId, token: clients.ghlTokenEnc })
      .from(clients)
      .orderBy(asc(clients.name)),
    db.select().from(clientHealthWeeks).orderBy(asc(clientHealthWeeks.weekStart)),
    db.select().from(clientHealthStatus),
  ]);

  const currentWeek = isoDay(weekStart(new Date()));
  const counts = Object.fromEntries(
    Object.entries(FILTERS).map(([k, f]) => [k, allClients.filter((c) => (f.statuses as ClientStatus[]).includes(c.status)).length]),
  ) as Record<Filter, number>;

  const rows = allClients
    .filter((c) => (FILTERS[filter].statuses as ClientStatus[]).includes(c.status))
    .map((c) => {
      const own = weeks.filter((w) => w.clientId === c.id);
      const refresh = statuses.find((s) => s.clientId === c.id);
      const hasToken = Boolean(c.loc && c.token);
      const health = clientHealth(own, { hasToken, error: refresh?.lastError });
      return { ...c, hasToken, health, refresh, latestWeek: own.at(-1)?.weekStart ?? null };
    })
    .sort((a, b) => ORDER[a.health.status] - ORDER[b.health.status] || a.name.localeCompare(b.name));

  const refreshed = typeof search.refreshed === "string" ? search.refreshed : null;
  const failed = typeof search.failed === "string" ? search.failed : null;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/dashboard" className="text-sm text-brand-fg hover:underline">
            ← Dashboard
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">Client Health</h1>
          <p className="text-sm text-zinc-500">
            GHL opportunities per week (Monday to Sunday, UTC). This week is the week of {shortDay(currentWeek)}.
          </p>
        </div>
        <form action={refreshHealthAction}>
          <input type="hidden" name="show" value={filter === "current" ? "" : filter} />
          <SubmitButton
            pendingText="Refreshing…"
            className="rounded-md border border-transparent bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-hover"
          >
            Refresh now
          </SubmitButton>
        </form>
      </header>

      {refreshed !== null && (
        <p className="rounded-md border border-panel-border bg-panel px-4 py-2 text-sm">
          Refreshed {refreshed} client{refreshed === "1" ? "" : "s"} from GHL.
          {failed && ` ${failed} failed; the error is shown on each one.`}
        </p>
      )}

      <section className="space-y-3 rounded-xl border border-panel-border bg-panel p-5 shadow-sm">
        <nav aria-label="Filter by client status" className="flex flex-wrap gap-2 text-sm">
          {(Object.keys(FILTERS) as Filter[]).map((k) => (
            <Link
              key={k}
              href={k === "current" ? "/dashboard/health" : `/dashboard/health?show=${k}`}
              aria-current={k === filter ? "page" : undefined}
              className={`rounded-full border px-3 py-1 ${
                k === filter ? "border-brand-fg/40 bg-brand-soft font-medium text-brand-fg" : "border-panel-border text-zinc-500 hover:bg-brand-soft"
              }`}
            >
              {FILTERS[k].label} ({counts[k]})
            </Link>
          ))}
        </nav>

        {rows.length === 0 ? (
          <p className="rounded-lg border border-panel-border px-4 py-3 text-sm text-zinc-500">No clients with this status.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-sm">
              <thead className="border-b text-zinc-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Client</th>
                  <th className="px-4 py-2 font-medium">Health</th>
                  <th className="px-4 py-2 text-right font-medium">This week</th>
                  <th className="px-4 py-2 text-right font-medium">Last week</th>
                  <th className="px-4 py-2 font-medium">Trend</th>
                  <th className="px-4 py-2 text-right font-medium">Booked rate</th>
                  <th className="px-4 py-2 text-right font-medium">Weeks since last activity</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => {
                  const h = r.health;
                  const dash = <span className="text-zinc-400">—</span>;
                  return (
                    <tr key={r.id} className="align-top" data-client={r.id}>
                      <td className="px-4 py-2">
                        <Link href={`/dashboard/clients/${r.id}`} className="font-medium hover:underline">
                          {r.name}
                        </Link>
                        <span className="block text-xs text-zinc-500">
                          {CLIENT_STATUS_LABEL[r.status]}
                          {r.refresh && ` · refreshed ${utc(r.refresh.lastRefreshedAt)}`}
                        </span>
                        {r.refresh?.lastError && (
                          <span className="mt-1 block max-w-md text-xs break-words text-red-700 dark:text-red-400">
                            Last refresh failed: {r.refresh.lastError}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${BADGE[h.status]}`}>
                          {h.label}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">
                        {h.thisWeek ?? dash}
                        {h.thisWeek !== null && r.latestWeek !== currentWeek && (
                          <span className="block text-xs text-zinc-500">wk of {shortDay(r.latestWeek!)}</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">
                        {h.lastWeek ?? (h.trend === "N/A (new)" ? "N/A" : dash)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">{h.trend ?? dash}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">
                        {h.status === "grey" ? dash : h.bookedRateDisplay}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">{h.weeksSince ?? dash}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-zinc-500">
          Red: 2 or more weeks in a row with no new opportunities. Yellow: none this week, fewer than last week, or under{" "}
          {BOOKED_RATE_THRESHOLD}% booked (opportunities now in a booked or scheduled stage). Grey: no GHL token, no data
          yet, or the last refresh failed. Weeks already over are kept as fetched; a client&apos;s first refresh loads the
          last 8 weeks.
        </p>
      </section>
    </main>
  );
}
