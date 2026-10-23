import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WritebackConfig } from "@/db/schema";
import type { GhlOpportunity, GhlPipeline } from "./ghl";
import { configProblems, guessClosedStage, paymentExclusion, planLead, unchangedSincePlan, type CandidatePayment } from "./rules";

const pipelines: GhlPipeline[] = [
  { id: "pd", name: "Detailing Pipeline", stages: [{ id: "d-new", name: "New Lead" }, { id: "d-closed", name: "Closed" }] },
  { id: "pc", name: "Ceramic Coating", stages: [{ id: "c-new", name: "New Lead" }, { id: "c-closed", name: "Closed" }] },
  { id: "px", name: "Other", stages: [{ id: "x-new", name: "New" }] },
];
const config: WritebackConfig = {
  pipelines: [
    { id: "pd", name: "Detailing Pipeline", closedStageId: "d-closed", closedStageName: "Closed", contradictTags: ["ceramic-coating"] },
    { id: "pc", name: "Ceramic Coating", closedStageId: "c-closed", closedStageName: "Closed", contradictTags: ["detailing lead"] },
  ],
};
const pay = (id: string, day: string, cents: number, over: Partial<CandidatePayment> = {}): CandidatePayment => ({
  id, paidAt: new Date(`${day}T12:00:00Z`), amountCents: cents, paymentStatus: "COMPLETED", refundedCents: 0, writebackState: null, ...over,
});
const opp = (over: Partial<GhlOpportunity> = {}): GhlOpportunity => ({
  id: "o1", pipelineId: "pd", pipelineStageId: "d-new", status: "open", monetaryValue: 0, createdAt: "2026-10-01T00:00:00Z", ...over,
});
const plan = (payments: CandidatePayment[], opportunities: GhlOpportunity[], tags: string[] = []) =>
  planLead({ contactId: "c1", payments, opportunities, tags, config, pipelines });

describe("paymentExclusion", () => {
  it("counts a completed, unrefunded, unpushed payment", () => assert.equal(paymentExclusion(pay("p", "2026-10-02", 100)), null));
  it("excludes full and partial refunds", () => {
    assert.equal(paymentExclusion(pay("p", "2026-10-02", 100, { refundedCents: 100 })), "refunded");
    assert.equal(paymentExclusion(pay("p", "2026-10-02", 100, { refundedCents: 1 })), "refunded");
    assert.equal(paymentExclusion(pay("p", "2026-10-02", 100, { paymentStatus: "PARTIALLY_REFUNDED" })), "refunded");
  });
  it("excludes failed and pending", () => {
    assert.equal(paymentExclusion(pay("p", "2026-10-02", 100, { paymentStatus: "FAILED" })), "status failed");
    assert.equal(paymentExclusion(pay("p", "2026-10-02", 100, { paymentStatus: "PENDING" })), "status pending");
  });
  it("excludes an unchecked refund status, pushed and blocked payments", () => {
    assert.equal(paymentExclusion(pay("p", "2026-10-02", 100, { refundedCents: null })), "refund status not checked");
    assert.equal(paymentExclusion(pay("p", "2026-10-02", 100, { writebackState: "pushed" })), "already pushed");
    assert.match(paymentExclusion(pay("p", "2026-10-02", 100, { writebackState: "blocked" }))!, /blocked after undo/);
  });
});

describe("planLead", () => {
  it("closes an open opportunity with no value in its own pipeline and sets the sum paid", () => {
    const i = plan([pay("a", "2026-10-02", 10000), pay("b", "2026-10-03", 5000)], [opp()]);
    assert.equal(i.skip, null);
    assert.equal(i.setValue, true);
    assert.equal(i.target?.pipelineId, "pd");
    assert.equal(i.target?.pipelineStageId, "d-closed");
    assert.equal(i.target?.status, "won");
    assert.equal(i.target?.monetaryValue, 150);
    assert.deepEqual(i.paymentIds, ["a", "b"]);
  });
  it("uses the Closed stage of the opportunity's own pipeline", () => {
    const i = plan([pay("a", "2026-10-02", 60000)], [opp({ pipelineId: "pc", pipelineStageId: "c-new" })]);
    assert.equal(i.target?.pipelineStageId, "c-closed");
    assert.equal(i.target?.pipelineId, "pc");
  });
  it("keeps a value that already equals the amount paid", () => {
    const i = plan([pay("a", "2026-10-02", 25500)], [opp({ monetaryValue: 255 })]);
    assert.equal(i.skip, null);
    assert.equal(i.setValue, false);
  });
  it("skips when the existing value differs", () =>
    assert.equal(plan([pay("a", "2026-10-02", 20000)], [opp({ monetaryValue: 100 })]).skip, "existing value differs from amount paid"));
  it("skips a lead already Closed in either pipeline, whatever its status", () => {
    assert.equal(plan([pay("a", "2026-10-02", 100)], [opp({ pipelineStageId: "d-closed", status: "open" })]).skip, "already Closed");
    assert.equal(
      plan([pay("a", "2026-10-02", 100)], [opp(), opp({ id: "o2", pipelineId: "pc", pipelineStageId: "c-closed", status: "won" })]).skip,
      "already Closed",
    );
  });
  it("skips opportunities in more than one pipeline, or in none", () => {
    assert.equal(plan([pay("a", "2026-10-02", 100)], [opp(), opp({ id: "o2", pipelineId: "pc", pipelineStageId: "c-new" })]).skip, "opportunities in more than one pipeline");
    assert.equal(plan([pay("a", "2026-10-02", 100)], []).skip, "no opportunity");
    assert.equal(plan([pay("a", "2026-10-02", 100)], [opp({ pipelineId: "px", pipelineStageId: "x-new" })]).skip, "opportunity only in other pipelines");
  });
  it("skips only a contradicting tag; a missing tag is fine", () => {
    assert.equal(plan([pay("a", "2026-10-02", 100)], [opp()], ["Ceramic-Coating"]).skip, 'tag "ceramic-coating" contradicts Detailing Pipeline');
    assert.equal(plan([pay("a", "2026-10-02", 100)], [opp()], []).skip, null);
    assert.equal(plan([pay("a", "2026-10-02", 100)], [opp()], ["detailing lead"]).skip, null);
    assert.match(plan([pay("a", "2026-10-02", 100)], [opp({ pipelineId: "pc", pipelineStageId: "c-new" })], ["detailing lead"]).skip!, /contradicts Ceramic/);
  });
  it("skips several opportunities in the same pipeline", () =>
    assert.equal(plan([pay("a", "2026-10-02", 100)], [opp(), opp({ id: "o2" })]).skip, "2 opportunities in Detailing Pipeline"));
  for (const status of ["won", "lost", "abandoned"]) {
    it(`skips a ${status} opportunity`, () => assert.equal(plan([pay("a", "2026-10-02", 100)], [opp({ status })]).skip, `status ${status}`));
  }
  it("leaves out payments made before the opportunity was created", () => {
    const i = plan([pay("old", "2026-09-20", 9900), pay("new", "2026-10-02", 15000)], [opp()]);
    assert.equal(i.skip, null);
    assert.equal(i.target?.monetaryValue, 150);
    assert.deepEqual(i.excluded, [{ paymentId: "old", reason: "paid before the opportunity was created" }]);
    assert.equal(plan([pay("old", "2026-09-20", 9900)], [opp()]).skip, "all payments before the opportunity was created");
  });
  it("leaves out refunded payments and skips a lead with nothing left", () => {
    const i = plan([pay("r", "2026-10-02", 5000, { refundedCents: 10 }), pay("ok", "2026-10-03", 15000)], [opp()]);
    assert.equal(i.target?.monetaryValue, 150);
    assert.deepEqual(i.excluded, [{ paymentId: "r", reason: "refunded" }]);
    assert.equal(plan([pay("r", "2026-10-02", 5000, { refundedCents: 5000 })], [opp()]).skip, "no qualifying payments");
  });
});

describe("setup helpers", () => {
  it("guesses the only stage named like Closed", () => {
    assert.equal(guessClosedStage(pipelines[0])?.id, "d-closed");
    assert.equal(guessClosedStage(pipelines[2]), null);
    assert.equal(guessClosedStage({ id: "p", name: "p", stages: [{ id: "1", name: "Closed Won" }, { id: "2", name: "Closed Lost" }] }), null);
  });
  it("flags a missing setup, a deleted pipeline and a deleted stage", () => {
    assert.equal(configProblems(config, pipelines).length, 0);
    assert.equal(configProblems(null, pipelines).length, 1);
    assert.match(configProblems(config, pipelines.slice(1)).join(), /no longer exists/);
    const noClosed = [{ ...pipelines[0], stages: [pipelines[0].stages[0]] }, pipelines[1]];
    assert.match(configProblems(config, noClosed).join(), /no longer in/);
  });
  it("notices an opportunity changed since the plan", () => {
    const planned = { pipelineId: "pd", pipelineName: "", pipelineStageId: "d-new", stageName: "", status: "open", monetaryValue: 0 };
    assert.equal(unchangedSincePlan(planned, opp({ monetaryValue: null })), true);
    assert.equal(unchangedSincePlan(planned, opp({ monetaryValue: 10 })), false);
    assert.equal(unchangedSincePlan(planned, opp({ pipelineStageId: "d-closed" })), false);
    assert.equal(unchangedSincePlan(planned, opp({ status: "won" })), false);
  });
});
