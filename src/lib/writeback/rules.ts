import type { OpportunityState, WritebackConfig, WritebackPlanItem } from "@/db/schema";
import type { GhlOpportunity, GhlPipeline } from "./ghl";

// Write-back rules, ported from 417-close-opps/close-opps.mjs (the manual run
// of 2026-10-23) with one change: tags only skip a lead when they contradict the
// opportunity's pipeline; a missing tag is fine. Pure, so every rule is unit-tested.

export const MATCHED_TAG = "payment-matched";

export type CandidatePayment = {
  id: string; // payment_matches id
  paidAt: Date;
  amountCents: number;
  paymentStatus: string | null; // provider status, fresh from the refund re-check
  refundedCents: number | null; // null = couldn't be checked
  writebackState: "pushed" | "blocked" | null;
};

// Why a payment can't count towards a lead's value, or null if it can.
export function paymentExclusion(p: CandidatePayment): string | null {
  if (p.writebackState === "pushed") return "already pushed";
  if (p.writebackState === "blocked") return "blocked after undo (staff can release it)";
  if (p.refundedCents === null) return "refund status not checked";
  if (p.refundedCents > 0 || /REFUNDED/.test(p.paymentStatus ?? "")) return "refunded";
  if (p.paymentStatus !== "COMPLETED") return `status ${(p.paymentStatus ?? "unknown").toLowerCase()}`;
  return null;
}

// GHL stores the value in dollars; compared in cents so 150 and 150.0 agree.
export const toCents = (dollars: number | null | undefined) => Math.round((dollars ?? 0) * 100);

export function stateOf(o: GhlOpportunity, pipelines: GhlPipeline[]): OpportunityState {
  const pipe = pipelines.find((p) => p.id === o.pipelineId);
  return {
    pipelineId: o.pipelineId,
    pipelineName: pipe?.name ?? o.pipelineId,
    pipelineStageId: o.pipelineStageId,
    stageName: pipe?.stages.find((s) => s.id === o.pipelineStageId)?.name ?? o.pipelineStageId,
    status: o.status,
    monetaryValue: o.monetaryValue ?? null,
  };
}

// Problems with a client's setup against its live pipelines; empty = usable.
export function configProblems(config: WritebackConfig | null, pipelines: GhlPipeline[]): string[] {
  if (!config?.pipelines.length) return ["Write-back isn't set up: pick at least one pipeline and its Closed stage."];
  const problems: string[] = [];
  for (const c of config.pipelines) {
    const live = pipelines.find((p) => p.id === c.id);
    if (!live) problems.push(`Pipeline "${c.name}" no longer exists in GHL.`);
    else if (!live.stages.some((s) => s.id === c.closedStageId)) problems.push(`The Closed stage "${c.closedStageName}" is no longer in "${live.name}".`);
  }
  return problems;
}

// A stage pre-selected as Closed in setup: the pipeline's only stage named like "closed".
export function guessClosedStage(p: GhlPipeline) {
  const closed = p.stages.filter((s) => /closed/i.test(s.name));
  return closed.length === 1 ? closed[0] : null;
}

// One lead (a GHL contact with matched payments): the update it gets, or why it's skipped.
export function planLead(input: {
  contactId: string;
  payments: CandidatePayment[];
  opportunities: GhlOpportunity[];
  tags: string[];
  config: WritebackConfig;
  pipelines: GhlPipeline[];
}): WritebackPlanItem {
  const { contactId, payments, opportunities, config, pipelines } = input;
  const excluded: WritebackPlanItem["excluded"] = [];
  let qualifying: CandidatePayment[] = [];
  for (const p of payments) {
    const why = paymentExclusion(p);
    if (why) excluded.push({ paymentId: p.id, reason: why });
    else qualifying.push(p);
  }
  const item = (rest: Partial<WritebackPlanItem>): WritebackPlanItem => ({
    contactId,
    paymentIds: qualifying.map((p) => p.id),
    totalCents: qualifying.reduce((n, p) => n + p.amountCents, 0),
    excluded,
    opportunityId: null,
    current: null,
    target: null,
    setValue: false,
    skip: null,
    ...rest,
  });
  if (!qualifying.length) return item({ skip: "no qualifying payments" });

  const closedIds = new Set(config.pipelines.map((p) => p.closedStageId));
  const inScope = opportunities.filter((o) => config.pipelines.some((p) => p.id === o.pipelineId));
  // Already Closed in any set-up pipeline, whatever its status or value: change nothing.
  const closed = inScope.find((o) => closedIds.has(o.pipelineStageId));
  if (closed) return item({ skip: "already Closed", opportunityId: closed.id, current: stateOf(closed, pipelines) });

  const pipelineIds = new Set(inScope.map((o) => o.pipelineId));
  if (pipelineIds.size === 0) return item({ skip: opportunities.length ? "opportunity only in other pipelines" : "no opportunity" });
  if (pipelineIds.size > 1) return item({ skip: "opportunities in more than one pipeline" });

  const pipe = config.pipelines.find((p) => p.id === [...pipelineIds][0])!;
  const tags = input.tags.map((t) => t.trim().toLowerCase());
  const contradicting = pipe.contradictTags.find((t) => tags.includes(t));
  if (contradicting) return item({ skip: `tag "${contradicting}" contradicts ${pipe.name}` });

  if (inScope.length > 1) return item({ skip: `${inScope.length} opportunities in ${pipe.name}` });
  const opp = inScope[0];
  const current = stateOf(opp, pipelines);
  const base = { opportunityId: opp.id, current };
  if (opp.status !== "open") return item({ ...base, skip: `status ${opp.status}` });

  // Payments made before the opportunity existed don't count.
  const created = new Date(opp.createdAt).getTime();
  const before = qualifying.filter((p) => p.paidAt.getTime() < created);
  for (const p of before) excluded.push({ paymentId: p.id, reason: "paid before the opportunity was created" });
  qualifying = qualifying.filter((p) => !before.includes(p));
  if (!qualifying.length) return item({ ...base, skip: "all payments before the opportunity was created" });

  const total = qualifying.reduce((n, p) => n + p.amountCents, 0);
  const currentCents = toCents(opp.monetaryValue);
  if (currentCents !== 0 && currentCents !== total) return item({ ...base, skip: "existing value differs from amount paid" });

  return item({
    ...base,
    setValue: currentCents === 0,
    target: {
      pipelineId: opp.pipelineId,
      pipelineName: current.pipelineName,
      pipelineStageId: pipe.closedStageId,
      stageName: pipe.closedStageName,
      status: "won",
      monetaryValue: total / 100,
    },
  });
}

// The plan's state still matches GHL's opportunity (checked right before writing).
export function unchangedSincePlan(planned: OpportunityState, live: GhlOpportunity) {
  return (
    planned.pipelineId === live.pipelineId &&
    planned.pipelineStageId === live.pipelineStageId &&
    planned.status === live.status &&
    toCents(planned.monetaryValue) === toCents(live.monetaryValue)
  );
}
