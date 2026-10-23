import Link from "next/link";
import type { clients, OpportunityState, WritebackPlanItem } from "@/db/schema";
import { SubmitButton } from "@/components/submit-button";
import type { GhlPipeline } from "@/lib/writeback/ghl";
import { guessClosedStage } from "@/lib/writeback/rules";
import { writebackHistory, writebackSwitch } from "@/lib/writeback/run";
import { livePipelines } from "@/lib/writeback/setup";
import {
  applyWritebackAction,
  checkPermissionsAction,
  releaseWritebackAction,
  runWritebackNowAction,
  saveWritebackSetupAction,
  setWritebackModeAction,
  undoWritebackAction,
  undoWritebackRunAction,
} from "./writeback-actions";

// GHL write-back on the client page. The page renders this for agency staff
// only; owners, admins and viewers never get it (and the actions refuse them).

const card = "space-y-4 rounded-xl border border-panel-border bg-panel p-5 shadow-sm";
const button = "rounded-md border px-3 py-1.5 text-sm";
const primary = "rounded-md border border-transparent bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-hover";
const small = "rounded-md border px-2 py-1 text-xs";
const errorBox = "rounded-md border border-red-300 px-4 py-2 text-sm text-red-700 dark:border-red-900 dark:text-red-400";
const utc = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const usd = (dollars: number | null) =>
  dollars === null ? "no value" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(dollars);
const state = (s: OpportunityState | null) => (s ? `${s.pipelineName} / ${s.stageName} / ${s.status} / ${usd(s.monetaryValue)}` : "—");

export async function WritebackSection(props: {
  client: typeof clients.$inferSelect;
  message: string | null;
  editSetup: boolean;
}) {
  const { client, message, editSetup } = props;
  const [history, killSwitch] = await Promise.all([writebackHistory(client.id), writebackSwitch()]);
  let pipelines: GhlPipeline[] | null = null;
  let pipelinesError: string | null = null;
  if (editSetup) {
    try {
      pipelines = await livePipelines(client.id);
    } catch (err) {
      pipelinesError = (err as Error).message;
    }
  }
  const latest = history.runs[0];
  const latestPlan: WritebackPlanItem[] = latest?.plan ?? [];
  const canApply = client.writebackMode === "preview" && latest && !latest.applied && latest.status === "ok" && latestPlan.some((i) => !i.skip);
  const okByRun = new Map<string, number>();
  for (const a of history.audit) if (a.result === "ok" && a.runId) okByRun.set(a.runId, (okByRun.get(a.runId) ?? 0) + 1);
  const config = client.writebackConfig;
  const page = `/dashboard/clients/${client.id}`;

  return (
    <section id="writeback" className={card} data-writeback>
      <div>
        <h2 className="font-medium">GHL write-back</h2>
        <p className="text-sm text-zinc-500">
          Closes the GHL opportunity of each lead whose payment matched and sets its value. Agency staff only.
        </p>
      </div>
      {message && <p className="rounded-md border border-panel-border px-4 py-2 text-sm">{message}</p>}
      {!killSwitch.enabled && (
        <p className={errorBox}>
          Write-back is switched off for every client{killSwitch.envDisabled ? " (WRITEBACK_DISABLED on the server)" : " (kill switch on the dashboard)"}.
          Runs plan but write nothing.
        </p>
      )}

      <div className="flex flex-wrap items-end gap-6 text-sm">
        <form action={setWritebackModeAction.bind(null, client.id)} className="flex items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-zinc-500">Mode</span>
            <select name="mode" defaultValue={client.writebackMode} className="rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 dark:border-zinc-700">
              <option value="off">Off</option>
              <option value="preview">Preview</option>
              <option value="auto" disabled={!client.writebackPermsOk}>
                Auto{client.writebackPermsOk ? "" : " (needs Check permissions)"}
              </option>
            </select>
          </label>
          <SubmitButton className={button}>Save mode</SubmitButton>
        </form>
        <form action={checkPermissionsAction.bind(null, client.id)}>
          <SubmitButton pendingText="Checking…" className={button}>
            Check permissions
          </SubmitButton>
        </form>
        {client.writebackMode !== "off" && (
          <form action={runWritebackNowAction.bind(null, client.id)}>
            <SubmitButton pendingText="Running…" className={button}>
              Run now
            </SubmitButton>
          </form>
        )}
        {canApply && (
          <form action={applyWritebackAction.bind(null, client.id)}>
            <SubmitButton pendingText="Applying…" className={primary}>
              Apply
            </SubmitButton>
          </form>
        )}
      </div>

      <div className="text-sm">
        <p className="text-zinc-500">
          Permissions:{" "}
          {client.writebackPermsCheckedAt
            ? `${client.writebackPermsOk ? "passed" : "failed"} (${utc(client.writebackPermsCheckedAt)})`
            : "not checked yet"}
        </p>
        {client.writebackPermsDetail && (
          <pre className="mt-1 whitespace-pre-wrap rounded-md border border-panel-border px-3 py-2 text-xs">{client.writebackPermsDetail}</pre>
        )}
      </div>

      <div className="space-y-2 text-sm">
        <div className="flex items-center justify-between gap-4">
          <h3 className="font-medium">Pipelines</h3>
          {!editSetup && (
            <Link href={`${page}?wbsetup=1#writeback`} className="text-brand-fg hover:underline">
              Edit setup
            </Link>
          )}
        </div>
        {!editSetup &&
          (config?.pipelines.length ? (
            <ul className="list-disc pl-5">
              {config.pipelines.map((p) => (
                <li key={p.id}>
                  {p.name} → {p.closedStageName}
                  {p.contradictTags.length ? `; skip leads tagged ${p.contradictTags.map((t) => `"${t}"`).join(", ")}` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-zinc-500">Not set up. Preview and Auto need at least one pipeline and its Closed stage.</p>
          ))}
        {editSetup && pipelinesError && <p className={errorBox}>Couldn&apos;t read the pipelines from GHL: {pipelinesError}</p>}
        {editSetup && pipelines && (
          <form action={saveWritebackSetupAction.bind(null, client.id)} className="space-y-2">
            {pipelines.map((p) => {
              const saved = config?.pipelines.find((c) => c.id === p.id);
              const closed = saved?.closedStageId ?? guessClosedStage(p)?.id ?? "";
              return (
                <fieldset key={p.id} className="flex flex-col gap-2 rounded-md border border-panel-border px-3 py-2 sm:flex-row sm:items-center">
                  <label className="flex items-center gap-2 sm:w-56">
                    <input type="checkbox" name={`include_${p.id}`} defaultChecked={Boolean(saved)} />
                    {p.name}
                  </label>
                  <label className="flex items-center gap-2">
                    <span className="text-zinc-500">Closed stage</span>
                    <select name={`closed_${p.id}`} defaultValue={closed} className="rounded-md border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700">
                      <option value="">—</option>
                      {p.stages.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-1 items-center gap-2">
                    <span className="whitespace-nowrap text-zinc-500">Contradicting tags</span>
                    <input
                      name={`tags_${p.id}`}
                      defaultValue={saved?.contradictTags.join(", ") ?? ""}
                      placeholder="comma-separated"
                      className="w-full rounded-md border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
                    />
                  </label>
                </fieldset>
              );
            })}
            <div className="flex gap-2">
              <SubmitButton className={primary}>Save setup</SubmitButton>
              <Link href={`${page}#writeback`} className={button}>
                Cancel
              </Link>
            </div>
          </form>
        )}
      </div>

      {latest && (
        <div className="space-y-2 text-sm">
          <h3 className="font-medium">
            Latest run: {latest.applied ? "write" : "preview"} · {latest.status} · {utc(latest.startedAt)} · {latest.trigger.replace("_", " ")}
          </h3>
          {latest.error && <p className={latest.status === "error" ? errorBox : "text-zinc-500"}>{latest.error}</p>}
          {latestPlan.length === 0 ? (
            <p className="text-zinc-500">Nothing to do: no matched payments waiting.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-left text-xs" data-writeback-plan>
                <thead className="border-b text-zinc-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">GHL contact</th>
                    <th className="px-3 py-2 font-medium">Opportunity now</th>
                    <th className="px-3 py-2 font-medium">Payments</th>
                    <th className="px-3 py-2 font-medium">Planned change</th>
                    <th className="px-3 py-2 font-medium">Outcome</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {latestPlan.map((i) => (
                    <tr key={i.contactId} className="align-top">
                      <td className="px-3 py-2 font-mono">{i.contactId}</td>
                      <td className="px-3 py-2">{state(i.current)}</td>
                      <td className="px-3 py-2">
                        {i.paymentIds.length} counted ({usd(i.totalCents / 100)})
                        {i.excluded.map((e) => (
                          <span key={e.paymentId} className="block text-zinc-500">
                            1 left out: {e.reason}
                          </span>
                        ))}
                      </td>
                      <td className="px-3 py-2">
                        {i.skip
                          ? `Skip: ${i.skip}`
                          : `→ ${i.target!.stageName} / won${i.setValue ? `, value ${usd(i.target!.monetaryValue)}` : ", value unchanged"}`}
                      </td>
                      <td className="px-3 py-2">
                        {i.outcome ?? (i.skip ? "" : latest.applied ? "" : "not written (preview)")}
                        {i.note && <span className="block text-zinc-500">{i.note}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {history.runs.some((r) => okByRun.get(r.id)) && (
        <div className="space-y-2 text-sm">
          <h3 className="font-medium">Runs with updates</h3>
          <ul className="divide-y divide-panel-border rounded-lg border border-panel-border">
            {history.runs
              .filter((r) => okByRun.get(r.id))
              .map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-4 px-3 py-2">
                  <span>
                    {utc(r.startedAt)} · {r.trigger.replace("_", " ")} · {okByRun.get(r.id)} live update{okByRun.get(r.id) === 1 ? "" : "s"}
                  </span>
                  <form action={undoWritebackRunAction.bind(null, client.id)}>
                    <input type="hidden" name="runId" value={r.id} />
                    <SubmitButton pendingText="Undoing…" className={small}>
                      Undo run
                    </SubmitButton>
                  </form>
                </li>
              ))}
          </ul>
        </div>
      )}

      <div className="space-y-2 text-sm">
        <h3 className="font-medium">
          Audit{history.needsReview ? ` · ${history.needsReview} need review` : ""}
        </h3>
        {history.audit.length === 0 ? (
          <p className="text-zinc-500">No GHL updates yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-xs" data-writeback-audit>
              <thead className="border-b text-zinc-500">
                <tr>
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Contact / opportunity</th>
                  <th className="px-3 py-2 font-medium">Before</th>
                  <th className="px-3 py-2 font-medium">After</th>
                  <th className="px-3 py-2 font-medium">Result</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {history.audit.map((a) => (
                  <tr key={a.id} className="align-top" data-audit={a.id}>
                    <td className="whitespace-nowrap px-3 py-2">{utc(a.createdAt)}</td>
                    <td className="px-3 py-2 font-mono">
                      {a.contactId}
                      <span className="block text-zinc-500">{a.opportunityId}</span>
                    </td>
                    <td className="px-3 py-2">
                      {a.previousPipelineName} / {a.previousStageName} / {a.previousStatus} / {usd(a.previousValue)}
                    </td>
                    <td className="px-3 py-2">
                      {a.newStageName} / {a.newStatus} / {usd(a.newValue)}
                    </td>
                    <td className="px-3 py-2">
                      {a.result}
                      {a.tagStatus && <span className="block text-zinc-500">tag: {a.tagStatus}</span>}
                      {a.needsReview && <span className="block font-medium text-red-700 dark:text-red-400">needs review: {a.reviewReason}</span>}
                      {a.error && <span className="block text-red-700 dark:text-red-400">{a.error}</span>}
                      {a.undoneAt && <span className="block text-zinc-500">undone {utc(a.undoneAt)}{a.releasedAt ? ", released" : ", payments blocked"}</span>}
                    </td>
                    <td className="px-3 py-2">
                      {a.result === "ok" && (
                        <form action={undoWritebackAction.bind(null, client.id)}>
                          <input type="hidden" name="auditId" value={a.id} />
                          <SubmitButton pendingText="Undoing…" className={small}>
                            Undo
                          </SubmitButton>
                        </form>
                      )}
                      {a.result === "undone" && !a.releasedAt && (
                        <form action={releaseWritebackAction.bind(null, client.id)}>
                          <input type="hidden" name="auditId" value={a.id} />
                          <SubmitButton className={small}>Release</SubmitButton>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
