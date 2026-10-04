// AUDIT_ORCHESTRATION over a sealed revision (package B08, mandate B08-CONTROL-AUDIT; docs/design/B08-audit-approval-jobs.md §3, §6,
// §7, §8.1, §11; decisions D8-AUD-1..4, D8-CANCEL-1/2, D8-DL-1; supporting B03's IC-02 and R2-035) on a real PostgreSQL 17 through
// this package's own control plane: B07's dispatcher delivering the audit's own events to AUDIT_ORCHESTRATION, which runs PROFILE,
// INTERPRET and VALIDATE, each claiming the audit's fence + 1 in one unit of work, calling its core outside any transaction and
// recording its result only under that fence; the system draft plan created by the control plane for the audit's requester, validated
// by the Migration-core port and its receipt written by the validator's own pool (kauro_validator_test); DRAFT_READY only under the
// DRAFT_READY guard. StartAudit and CancelAudit are the request handlers' writes through the audit store (the routes are
// B08-COMMANDS-AUDIT's); a lost source is B07's supersession delivered to EXECUTION_CONTROL. SIMULATED: the Migration core (profiler,
// validator) and the Intelligence core (candidates, interpretation, compiler) are the labelled contract fakes of B08-CORE-PORTS;
// interleavings are the Intelligence fake's own hold points and test decorators holding the profiler's, the validator's or the
// receipt writer's answer in flight; the absolute deadline is the labelled TEST CLOCK. The superuser is the oracle only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { CONTRACT_FAKE_INTELLIGENCE_CORE_RESERVATION, CONTRACT_FAKE_INTELLIGENCE_CORE_RESPONSE, CONTRACT_FAKE_MIGRATION_CORE_PACKAGE_HASH } from "@kauro/application/testing/cores";
import { heldProfile, heldReceipts, heldValidate, openAuditWorld, type AuditWorld, type CallHold } from "./support/audit-world.js";
import { startExecutionWorld, type AuditSubject, type ExecutionWorld } from "./support/execution-world.js";

let w: ExecutionWorld;
let a: AuditWorld;

before(async () => {
  w = await startExecutionWorld("audit");
  a = await openAuditWorld(w);
});

after(async () => {
  await w.stop();
});

const ABSOLUTE_SECONDS = 86_400;

test("the audit runs PROFILE, INTERPRET and VALIDATE under its fence to DRAFT_READY with a VALIDATED system draft; a stale step's result is refused, and a cancellation or the absolute deadline after every await of the three steps leaves no draft", async () => {
  const ag = w.A;
  const orchestration = w.x.consumers.auditOrchestration;
  let n = 0;
  const subject = (): Promise<AuditSubject> => w.subject(ag, `audit-${++n}`);

  // --- the three steps under the audit's fence, to DRAFT_READY -------------------------------------------------------------------
  const s1 = await subject();
  const before1 = { profile: w.core.calls("profile").length, validate: w.core.calls("validate").length, interpret: w.intelligence.calls("interpret").length, compile: w.intelligence.calls("compile").length };
  w.intelligence.scriptInterpretOutcomes("COMPILED");
  const started = await a.start(s1);
  const auditId = started.audit.auditId;
  const delivered = await w.drain(orchestration);
  assert.equal(delivered.deadLettered, 0);
  const ready = await a.audit(auditId);
  assert.deepEqual([ready.state, ready.version, ready.fence, ready.cancel_version, ready.terminal_reason], ["DRAFT_READY", "5", "3", "0", null]);
  assert.deepEqual(await a.steps(auditId), [
    ["PROFILE", 1, "COMPLETED", "SIMULATED"],
    ["INTERPRET", 2, "COMPILED", "SIMULATED"],
    ["VALIDATE", 3, "VALID", "SIMULATED"],
  ]);
  assert.ok(ready.profile_evidence_hash !== null && ready.candidate_manifest_hash !== null && ready.interpretation_deadline_at !== null);
  // the system draft: the audit's requester's plan of exactly the audit's source and target, VALIDATED under the validator's receipt
  const [draft, ...others] = await a.plansOf(s1);
  assert.ok(draft);
  assert.equal(others.length, 0, "one system draft");
  assert.deepEqual([draft.plan_id, draft.state, draft.version, draft.created_by_membership_id], [ready.draft_plan_id, "VALIDATED", "4", ready.requested_by_membership_id]);
  const receipts = await a.receipts(draft.plan_id);
  assert.equal(receipts.length, 1, "one receipt, written by the validator's pool");
  const receipt = receipts[0];
  assert.ok(receipt);
  assert.deepEqual(
    [receipt.result, receipt.receipt_hash, receipt.plan_hash, receipt.revision_hash, receipt.target_contract_hash, receipt.core_package_hash, receipt.blocking_issue_codes],
    ["VALID", draft.validation_receipt_hash, draft.body_hash, s1.revisionHash, s1.targetContractHash, CONTRACT_FAKE_MIGRATION_CORE_PACKAGE_HASH, []],
  );
  assert.deepEqual(await a.validations(draft.plan_id), [[1, "AUDIT", "VALID", receipt.receipt_hash]], "the draft's one validation intent, settled VALID");
  // every edge is the control plane's, one event per version; the draft's edges are B06's plan events
  assert.deepEqual(await a.events(auditId), [
    ["audit.queued.v1", "USER", ag.ownerUserId],
    ["audit.profiling.v1", "SERVICE", "audit-orchestration"],
    ["audit.interpreting.v1", "SERVICE", "audit-orchestration"],
    ["audit.validating.v1", "SERVICE", "audit-orchestration"],
    ["audit.draft_ready.v1", "SERVICE", "audit-orchestration"],
  ]);
  assert.deepEqual((await a.events(draft.plan_id)).map(([type]) => type), ["plan.created.v1", "plan.validation_required.v1", "plan.validating.v1", "plan.validated.v1"]);
  // the Intelligence core dispatched under the platform's fenced journal of the audit's run: one reservation, one response
  assert.deepEqual(await a.journal(auditId), [CONTRACT_FAKE_INTELLIGENCE_CORE_RESERVATION, CONTRACT_FAKE_INTELLIGENCE_CORE_RESPONSE]);
  assert.deepEqual(
    [w.core.calls("profile").length - before1.profile, w.intelligence.calls("interpret").length - before1.interpret, w.intelligence.calls("compile").length - before1.compile, w.core.calls("validate").length - before1.validate],
    [1, 1, 1, 1],
    "each core called once",
  );
  // a redelivery of any of the audit's events finds it moved on: nothing is claimed again
  for (const type of ["audit.queued.v1", "audit.profiling.v1", "audit.interpreting.v1", "audit.validating.v1"]) {
    assert.deepEqual(await w.redeliver(orchestration, await w.eventOf(auditId, type)), { kind: "DONE" }, type);
  }
  assert.equal((await a.steps(auditId)).length, 3);
  assert.equal((await a.audit(auditId)).version, "5");

  // --- a stale step's result is refused (KA080) ------------------------------------------------------------------------------------
  {
    const s = await subject();
    w.intelligence.scriptInterpretOutcomes("COMPILED");
    const audit = (await a.start(s)).audit.auditId;
    const held = heldProfile(w.core);
    const slow = w.planeWith({ profile: held.port }).execution;
    assert.ok(slow !== null);
    // delivery A claims fence 1 (QUEUED -> PROFILING) and its profiler answers, the answer still in flight
    const first = w.redeliver(slow.consumers.auditOrchestration, await w.eventOf(audit, "audit.queued.v1"));
    await held.hold.reached;
    // delivery B of audit.profiling.v1 (the step claimed, its result not yet recorded) claims fence 2 and completes PROFILE
    assert.deepEqual(await w.redeliver(orchestration, await w.eventOf(audit, "audit.profiling.v1")), { kind: "DONE" });
    const afterB = await a.audit(audit);
    assert.deepEqual([afterB.state, afterB.version, afterB.fence], ["INTERPRETING", "3", "2"]);
    held.hold.release();
    assert.deepEqual(await first, { kind: "DONE" }, "the stale step's result is refused, not retried");
    assert.deepEqual(await a.steps(audit), [
      ["PROFILE", 1, null, null],
      ["PROFILE", 2, "COMPLETED", "SIMULATED"],
    ]);
    assert.deepEqual([(await a.audit(audit)).version, (await a.audit(audit)).fence], ["3", "2"], "the stale step moved nothing");
    await w.drain(orchestration);
    assert.equal((await a.audit(audit)).state, "DRAFT_READY", "the current fence carries the audit on");
  }

  // --- a cancellation or the absolute deadline after every await of the three steps -------------------------------------------------
  type Interruption = "CANCELLATION" | "LOST_SOURCE" | "DEADLINE";
  interface Boundary {
    readonly name: string;
    /** Drives the audit to the await and returns the delivery in flight and its hold. */
    arm(audit: string): Promise<{ readonly delivery: Promise<unknown>; readonly hold: CallHold }>;
    readonly validating: boolean;
  }
  const profiled = async (audit: string): Promise<void> => {
    assert.deepEqual(await w.redeliver(orchestration, await w.eventOf(audit, "audit.queued.v1")), { kind: "DONE" });
    assert.equal((await a.audit(audit)).state, "INTERPRETING");
  };
  const interpreted = async (audit: string): Promise<void> => {
    await profiled(audit);
    assert.deepEqual(await w.redeliver(orchestration, await w.eventOf(audit, "audit.interpreting.v1")), { kind: "DONE" });
    assert.equal((await a.audit(audit)).state, "VALIDATING");
  };
  const boundaries: ReadonlyArray<Boundary> = [
    {
      name: "the profiler's answer",
      validating: false,
      async arm(audit) {
        const held = heldProfile(w.core);
        const slow = w.planeWith({ profile: held.port }).execution;
        assert.ok(slow !== null);
        return { delivery: w.redeliver(slow.consumers.auditOrchestration, await w.eventOf(audit, "audit.queued.v1")), hold: held.hold };
      },
    },
    {
      name: "the candidate plan",
      validating: false,
      async arm(audit) {
        const hold = w.intelligence.holdNext("plan");
        return { delivery: w.redeliver(orchestration, await w.eventOf(audit, "audit.queued.v1")), hold };
      },
    },
    {
      name: "a model task",
      validating: false,
      async arm(audit) {
        await profiled(audit);
        const hold = w.intelligence.holdNext("dispatch");
        return { delivery: w.redeliver(orchestration, await w.eventOf(audit, "audit.interpreting.v1")), hold };
      },
    },
    {
      name: "the plan compiler",
      validating: false,
      async arm(audit) {
        await profiled(audit);
        const hold = w.intelligence.holdNext("compile");
        return { delivery: w.redeliver(orchestration, await w.eventOf(audit, "audit.interpreting.v1")), hold };
      },
    },
    {
      name: "the validator's answer",
      validating: true,
      async arm(audit) {
        await interpreted(audit);
        const held = heldValidate(w.core);
        const slow = w.planeWith({ validate: held.port }).execution;
        assert.ok(slow !== null);
        return { delivery: w.redeliver(slow.consumers.auditOrchestration, await w.eventOf(audit, "audit.validating.v1")), hold: held.hold };
      },
    },
    {
      name: "the receipt recorded, the finalization pending",
      validating: true,
      async arm(audit) {
        await interpreted(audit);
        const held = heldReceipts(w.receipts);
        const slow = w.planeWith({ receipts: held.receipts }).execution;
        assert.ok(slow !== null);
        return { delivery: w.redeliver(slow.consumers.auditOrchestration, await w.eventOf(audit, "audit.validating.v1")), hold: held.hold };
      },
    },
  ];

  const outcomes: Array<readonly [string, Interruption, string, string | null]> = [];
  for (const boundary of boundaries) {
    for (const interruption of ["CANCELLATION", "DEADLINE"] as const) {
      const kind: Interruption = interruption === "CANCELLATION" && boundary.name === "the profiler's answer" ? "LOST_SOURCE" : interruption;
      const label = `${boundary.name} / ${kind}`;
      const s = await subject();
      w.intelligence.scriptInterpretOutcomes("COMPILED");
      const audit = (await a.start(s)).audit.auditId;
      const { delivery, hold } = await boundary.arm(audit);
      await hold.reached;
      const stepsAtHold = await a.steps(audit);
      if (kind === "CANCELLATION") {
        await a.cancel(s, audit);
      } else if (kind === "LOST_SOURCE") {
        // B07's supersession of the audit's source, delivered to EXECUTION_CONTROL, which cancels the audit as a SERVICE actor
        await a.supersedeSource(s);
        await w.drain(w.x.consumers.executionControl);
      } else {
        // never early: before the absolute deadline AUDIT_DEADLINES leaves the audit live
        const live = (await a.audit(audit)).state;
        await w.x.sweepers.auditDeadlines.sweep(w.units, 50);
        assert.equal((await a.audit(audit)).state, live, `${label}: nothing expires before its deadline`);
        // the server clock at the audit's absolute deadline (the labelled TEST CLOCK of the control plane's units)
        w.advance(ABSOLUTE_SECONDS);
        if (boundary.validating) {
          // even while the validator runs: AUDIT_DEADLINES expires the audit before the step answers
          await w.x.sweepers.auditDeadlines.sweep(w.units, 50);
          assert.equal((await a.audit(audit)).state, "EXPIRED", `${label}: expired while the step's await is outstanding`);
        }
      }
      hold.release();
      assert.deepEqual(await delivery, { kind: "DONE" }, `${label}: the step's late result is refused`);
      if (kind === "DEADLINE") {
        await w.x.sweepers.auditDeadlines.sweep(w.units, 50);
        w.advance(-ABSOLUTE_SECONDS);
      }
      // the cancellation's own event reaches AUDIT_ORCHESTRATION (the system draft's open intent, if any, settles CANCELLED)
      await w.drain(orchestration);

      const ended = await a.audit(audit);
      const expected: readonly [string, string | null, string | null, string] =
        kind === "DEADLINE" ? ["EXPIRED", null, "ABSOLUTE_DEADLINE_REACHED", "0"] : kind === "LOST_SOURCE" ? ["CANCELLED", "execution-control", "SOURCE_SUPERSEDED", "1"] : ["CANCELLED", s.agency.ownerUserId, "AGENCY_CANCELLED", "1"];
      assert.deepEqual([ended.state, ended.cancel_actor_id, ended.terminal_reason, ended.cancel_version], expected, label);
      assert.equal(ended.draft_plan_id, null, `${label}: no draft is published`);
      assert.deepEqual(await a.steps(audit), stepsAtHold, `${label}: the step in flight recorded nothing`);
      assert.ok(!(await a.events(audit)).some(([type]) => type === "audit.draft_ready.v1"), `${label}: never DRAFT_READY`);
      const plans = await a.plansOf(s);
      assert.ok(plans.every((p) => p.state !== "VALIDATED" && p.validation_receipt_hash === null), `${label}: no plan of the subject is VALIDATED`);
      if (boundary.validating) {
        // the system draft exists (created with the VALIDATING edge) but its intent settled CANCELLED and it needs validation again
        const [systemDraft] = plans;
        assert.ok(systemDraft && plans.length === 1, `${label}: the one system draft`);
        assert.equal(systemDraft.state, "VALIDATION_REQUIRED", label);
        assert.deepEqual((await a.validations(systemDraft.plan_id)).map(([fence, origin, result, receiptHash]) => [fence, origin, result, receiptHash]), [[1, "AUDIT", "CANCELLED", null]], label);
        if (boundary.name.startsWith("the receipt")) {
          // the validator's VALID receipt stays evidence of what it validated; it promotes nothing
          assert.deepEqual((await a.receipts(systemDraft.plan_id)).map((r) => r.result), ["VALID"], `${label}: the later receipt stays evidence`);
        }
      } else {
        assert.equal(plans.length, 0, `${label}: no system draft was created`);
      }
      if (boundary.name === "a model task" && kind === "CANCELLATION") {
        // the send in flight keeps its reservation; its response was refused by the journal's fence
        assert.deepEqual(await a.journal(audit), [CONTRACT_FAKE_INTELLIGENCE_CORE_RESERVATION], `${label}: the sent request keeps its reservation, no response is compiled`);
      }
      outcomes.push([boundary.name, kind, ended.state, ended.draft_plan_id]);
    }
  }
  assert.equal(outcomes.length, 12);
  assert.ok(outcomes.every(([, , state, draftPlan]) => ["CANCELLED", "EXPIRED"].includes(state) && draftPlan === null));
});
