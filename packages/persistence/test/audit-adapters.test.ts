// Audit authority through the adapters (package B08, mandate B08-PERSISTENCE-AUDIT; @kauro/persistence PgAuditStore in the audit unit
// of work, the ModelTaskJournalPort and the ArtifactResolver; docs/design/B08-audit-approval-jobs.md §3, §6, §7, D8-GRANT-1,
// D8-GRANT-2, D8-AUD-2, D8-AUD-3, D8-AUD-4, D8-PLAN-1, D8-PLAN-2; case map docs/design/B08-case-map.md): every method of the store
// on real PostgreSQL 17, each through the runtime role that owns it — StartAudit, CancelAudit, the decision-artifact intake and
// ValidatePlan's intent as the request handlers (kauro_app_test, the owner's TENANT context), the steps, model tasks, dispatch
// intents, the system draft, the validation settlement and the grant reconciliation as the control plane (kauro_control_test, a SYSTEM
// context bound to the agency), the receipt as the validator (kauro_validator_test). The one interleaving is fixed by a hold point
// inside StartAudit's unit of work and the other's lock wait observed in pg_stat_activity, never by a sleep.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  AUDIT_POLICY,
  isDomainFailure,
  type ArtifactRef,
  type AuditId,
  type AuditStepId,
  type Id,
  type LeaseOwnerId,
  type MembershipId,
  type ModelTaskId,
  type PlanBody,
  type PlanId,
  type PlanValidationId,
  type RequestId,
  type AgencyId,
  type AuditStepOutcome,
  type UserId,
} from "@kauro/domain";
import { decisionArtifactResolver, modelTaskJournalOf } from "../src/index.js";
import { barrier, waitForLockWait } from "../src/testing/harness.js";
import { fundPlatformPool } from "../src/testing/audit-fixtures.js";
import { controlOf } from "../src/testing/execution-fixtures.js";
import { auditSubject, closeAuditEnv, failureOf, newAudit, openAuditEnv, type AuditEnv } from "./audit-support.js";
import { clock, ids, plan, planBody, sha, validationReceipt } from "./support.js";

let env: AuditEnv;

before(async () => {
  env = await openAuditEnv("audit-adapters");
});
after(async () => {
  await closeAuditEnv(env);
});

/**
 * How StartAudit's lock of the platform's pool shows in pg_stat_activity (PgAuditStore.startAudit: the funded pools read FOR UPDATE);
 * the application name and the lock wait do the rest.
 */
const POOL_ROW_LOCK = "FROM kauro.cost_grants WHERE grant_kind = 'PLATFORM_MONTHLY'";

async function oracleOne<R extends Record<string, unknown>>(sql: string, params: ReadonlyArray<unknown>): Promise<R> {
  const r = await env.h.oracle.query<R>(sql, params as unknown[]);
  assert.ok(r.rows[0], sql);
  return r.rows[0];
}

const heldOn = async (grantId: string): Promise<{ reserved: number; spent: number; state: string }> =>
  oracleOne("SELECT reserved_cents::int AS reserved, reconciled_spend_cents::int AS spent, state FROM kauro.cost_grants WHERE grant_id = $1", [grantId]);

test("the audit store through every repository method as the owning roles: two StartAudit reservations for the last cents of the pool serialize on its row with the loser BUDGET_EXHAUSTED, steps record only under the current fence, and the model-task journal returns a stored response before any new dispatch intent", async () => {
  const { h, A, B } = env;
  const asTenant = (agencyId: string, userId: string) => h.tenant(agencyId as AgencyId, userId as UserId);
  const ownerOf = { [A.agencyId]: A.ownerUserId, [B.agencyId]: B.ownerUserId } as Record<string, string>;
  const tenantOf = (agencyId: string) => asTenant(agencyId, ownerOf[agencyId]!);

  // --- startAudit: two agencies race for the last cents of the platform's pool (D8-GRANT-1) -------------------------------------------
  const last = await fundPlatformPool(env.control, { ceilingCents: BigInt(AUDIT_POLICY.freeAuditCeilingCents) });
  const sA = await auditSubject(env, A, "adapters-a");
  const sB = await auditSubject(env, B, "adapters-b");
  const inputA = newAudit(A, sA);
  const carved = barrier();
  const commitA = barrier();
  const startA = h.audit.run(tenantOf(A.agencyId), async (uow) => {
    const out = await uow.audits.startAudit(inputA);
    carved.open();
    await commitA.wait;
    return out;
  });
  await carved.wait;
  const inputB = newAudit(B, sB);
  const startB = h.audit.run(tenantOf(B.agencyId), (uow) => uow.audits.startAudit(inputB));
  // B's StartAudit waits on the pool's row A holds (its SELECT ... FOR UPDATE), observed in pg_stat_activity
  await waitForLockWait(h.oracle, "kauro-test-api", POOL_ROW_LOCK);
  commitA.open();
  const startedA = await startA;
  await assert.rejects(startB, (e: unknown) => failureOf(e)[0] === "BUDGET_EXHAUSTED" && failureOf(e)[1] === "NO_FUNDED_GRANT", "the loser finds the pool's last cents reserved");
  // the winner: its audit QUEUED at the server's instant with its absolute deadline, its AUDIT grant AUTHORIZED and held on the pool
  assert.deepEqual([startedA.audit.auditId, startedA.audit.state, startedA.audit.version, startedA.audit.fence, startedA.audit.cancelVersion], [inputA.auditId, "QUEUED", 1, 0, 0]);
  assert.equal(Date.parse(startedA.audit.absoluteDeadlineAt) - Date.parse(startedA.audit.startedAt), AUDIT_POLICY.auditAbsoluteSeconds * 1000);
  assert.equal(startedA.audit.interpretationDeadlineAt, undefined, "set once, with the first INTERPRETING");
  assert.deepEqual([startedA.grant.grantId, startedA.grant.kind, startedA.grant.state, startedA.grant.version, startedA.grant.ceilingCents, startedA.grant.authorizationRef], [inputA.grantId, "AUDIT", "AUTHORIZED", 2, 150n, last]);
  assert.deepEqual([startedA.pool.grantId, startedA.pool.reservedCents, startedA.pool.ceilingCents], [last, 150n, 150n]);
  // the loser wrote nothing: no audit, no grant of B, the pool holds exactly the winner's ceiling
  assert.deepEqual(await oracleOne("SELECT (SELECT count(*)::int FROM kauro.audits WHERE agency_id = $1) AS audits, (SELECT count(*)::int FROM kauro.cost_grants WHERE agency_id = $1) AS grants", [B.agencyId]), { audits: 0, grants: 0 });
  assert.deepEqual(await heldOn(last), { reserved: 150, spent: 0, state: "AUTHORIZED" });
  // the audit's first version reaches AUDIT_ORCHESTRATION through the outbox, the grant's two versions carry their events
  assert.deepEqual(
    (await h.oracle.query("SELECT e.event_type, array_agg(o.consumer ORDER BY o.consumer) FILTER (WHERE o.consumer IS NOT NULL) AS consumers FROM kauro.domain_events e LEFT JOIN kauro.outbox_records o ON o.event_id = e.event_id WHERE e.aggregate_id = ANY($1::uuid[]) GROUP BY e.event_type, e.sequence ORDER BY e.sequence", [[inputA.auditId, inputA.grantId]])).rows,
    [
      { event_type: "cost_grant.prepared.v1", consumers: null },
      { event_type: "cost_grant.authorized.v1", consumers: null },
      { event_type: "audit.queued.v1", consumers: ["AUDIT_ORCHESTRATION"] },
    ],
  );

  // a funded pool for the rest; B now starts, and CancelAudit ends it at its version (cancellation_wins)
  const pool = await fundPlatformPool(env.control, { ceilingCents: 5_000n });
  const inputB2 = newAudit(B, sB);
  const startedB = await h.audit.run(tenantOf(B.agencyId), (uow) => uow.audits.startAudit(inputB2));
  assert.equal(startedB.pool.grantId, pool, "a pool with room funds it");
  const cancellation = { actor: { kind: "USER", userId: B.ownerUserId }, reasonCode: "AGENCY_CANCELLED" } as const;
  const stale = await h.audit.run(tenantOf(B.agencyId), (uow) => uow.audits.cancelAudit(inputB2.auditId, 7, cancellation));
  assert.deepEqual(stale, { kind: "STALE", currentVersion: 1, currentState: "QUEUED" });
  const cancelled = await h.audit.run(tenantOf(B.agencyId), (uow) => uow.audits.cancelAudit(inputB2.auditId, 1, cancellation));
  assert.equal(cancelled.kind, "APPLIED");
  assert.deepEqual(cancelled.kind === "APPLIED" ? [cancelled.record.state, cancelled.record.version, cancelled.record.cancelVersion, cancelled.record.terminalReason] : [], ["CANCELLED", 2, 1, "AGENCY_CANCELLED"]);
  // a cancelled audit takes no step (KA081)
  await assert.rejects(h.audit.run(controlOf(B.agencyId), (uow) => uow.audits.claimStep(inputB2.auditId, "PROFILE", ids.next() as AuditStepId)), (e: unknown) => failureOf(e)[1] === "EXECUTION_AUTHORITY_LOST");

  // --- the reads of the control plane -----------------------------------------------------------------------------------------------
  const auditA = inputA.auditId;
  await h.audit.run(controlOf(A.agencyId), async (uow) => {
    assert.equal((await uow.audits.getAudit(auditA))?.state, "QUEUED");
    assert.equal((await uow.audits.lockAudit(auditA))?.version, 1);
    assert.equal((await uow.audits.getGrant(inputA.grantId))?.state, "AUTHORIZED");
    assert.equal(await uow.audits.getAudit(inputB2.auditId), null, "another agency's audit is not the bound unit's");
  });

  // --- steps record only under the current fence (D8-AUD-2) ------------------------------------------------------------------------
  const claim = (kind: "PROFILE" | "INTERPRET" | "VALIDATE") => h.audit.run(controlOf(A.agencyId), (uow) => uow.audits.claimStep(auditA, kind, ids.next() as AuditStepId));
  const record = (stepId: AuditStepId, outcome: AuditStepOutcome, seed: string) => h.audit.run(controlOf(A.agencyId), (uow) => uow.audits.recordStep(stepId, { outcome, evidenceHash: sha(seed), evidenceClass: "SIMULATED" }));
  const profile1 = await claim("PROFILE");
  assert.deepEqual([profile1.step.fence, profile1.audit.state, profile1.audit.version, profile1.audit.fence], [1, "PROFILING", 2, 1], "profile_worker_claims takes fence 1");
  // the first worker's result is lost; the redelivery claims fence 2 and the first worker's late result is refused (KA080)
  const profile2 = await claim("PROFILE");
  assert.deepEqual([profile2.step.fence, profile2.audit.state, profile2.audit.version, profile2.audit.fence], [2, "PROFILING", 2, 2]);
  await assert.rejects(record(profile1.step.stepId, "COMPLETED", "stale-profile"), (e: unknown) => failureOf(e)[1] === "EXECUTION_FENCED", "a stale step records nothing");
  const profiled = await record(profile2.step.stepId, "COMPLETED", "profile-evidence");
  assert.deepEqual([profiled.outcome, profiled.evidenceHash, profiled.evidenceClass], ["COMPLETED", sha("profile-evidence"), "SIMULATED"]);
  const candidateManifestHash = sha("candidate-manifest");
  const interpreting = await h.audit.run(controlOf(A.agencyId), (uow) => uow.audits.advanceAudit(auditA, 2, { to: "INTERPRETING", profileEvidenceHash: sha("profile-evidence"), candidateManifestHash }));
  assert.equal(interpreting.kind, "APPLIED");
  const interpretingAudit = interpreting.kind === "APPLIED" ? interpreting.record : null;
  assert.ok(interpretingAudit?.interpretationDeadlineAt !== undefined && interpretingAudit.interpretingAt !== undefined);
  assert.equal(Date.parse(interpretingAudit.interpretationDeadlineAt) - Date.parse(interpretingAudit.interpretingAt), AUDIT_POLICY.interpretationSeconds * 1000, "the interpretation deadline, once");
  const interpret = await claim("INTERPRET");
  assert.equal(interpret.step.fence, 3);

  // --- model tasks, their dispatch intents and the journal (D8-AUD-3, D8-GRANT-2) ------------------------------------------------------
  const taskInput = {
    modelTaskId: ids.next() as ModelTaskId,
    auditId: auditA,
    stepFence: 3,
    taskKey: sha("task-1"),
    candidateManifestHash,
    policyHash: sha("model-policy"),
    minimizedRequestHash: sha("minimized-request-1"),
    providerProfileId: ids.next() as Id,
    maximumCostCents: 40n,
  };
  const task = await h.audit.run(controlOf(A.agencyId), (uow) => uow.audits.createModelTask(taskInput));
  assert.deepEqual([task.modelTaskId, task.grantId, task.interpretationDeadlineAt, task.auditDeadlineAt], [taskInput.modelTaskId, inputA.grantId, interpretingAudit.interpretationDeadlineAt, interpretingAudit.absoluteDeadlineAt]);
  // the candidate set and policy are the task's idempotency identity: planning it again answers the same task
  const replanned = await h.audit.run(controlOf(A.agencyId), (uow) => uow.audits.createModelTask({ ...taskInput, modelTaskId: ids.next() as ModelTaskId }));
  assert.equal(replanned.modelTaskId, taskInput.modelTaskId);
  const owner = interpret.step.stepId as string as LeaseOwnerId;
  const r1 = ids.next() as RequestId;
  const first = await h.audit.run(controlOf(A.agencyId), (uow) => uow.audits.beginDispatch(task.modelTaskId, { requestId: r1, ownerId: owner, requestHash: sha("request-1"), reservedCents: 25n }));
  assert.equal(first.kind, "RESERVED");
  assert.deepEqual(first.kind === "RESERVED" ? [first.request.requestId, first.request.state, first.request.fence, first.lease.fence, first.lease.costAuthorityId] : [], [r1, "RESERVED", 1, 1, inputA.grantId]);
  assert.deepEqual(await heldOn(inputA.grantId), { reserved: 25, spent: 0, state: "AUTHORIZED" }, "the intent reserves on the audit's grant");
  // the send (the kernel's check before SEND_STARTED passes) and its complete response, stored before anything consumes it
  await h.audit.run(controlOf(A.agencyId), async (uow) => {
    assert.equal((await uow.requestJournal.markDispatching(r1, 1, "provider-request-1", clock.now()))?.state, "DISPATCHING");
    assert.equal((await uow.requestJournal.storeResponse(r1, 1, sha("response-1"), { usageState: "KNOWN", actualCents: "20" }, clock.now()))?.state, "RESPONSE_STORED");
  });
  // a redelivered INTERPRET asks again: the stored response comes back before any new dispatch intent — no row, no reservation
  const again = await h.audit.run(controlOf(A.agencyId), (uow) => uow.audits.beginDispatch(task.modelTaskId, { requestId: ids.next() as RequestId, ownerId: owner, requestHash: sha("request-1"), reservedCents: 25n }));
  assert.deepEqual(again.kind === "STORED_RESPONSE" ? [again.kind, again.request.requestId, again.request.responseArtifactHash] : [again.kind], ["STORED_RESPONSE", r1, sha("response-1")]);
  assert.deepEqual(await oracleOne("SELECT count(*)::int AS n FROM kauro.request_journal WHERE task_id = $1", [task.modelTaskId]), { n: 1 });
  assert.deepEqual(await heldOn(inputA.grantId), { reserved: 25, spent: 0, state: "AUTHORIZED" });
  // the core's journal (ModelTaskJournalPort, D8-PORT-3): a fenced log of the INTERPRET step, outside any transaction of the caller
  const journal = modelTaskJournalOf(h.audit, controlOf(A.agencyId), { auditId: auditA, stepFence: 3 });
  assert.deepEqual(await journal.append(auditA, { kind: "reservation", costCents: 25 }, 0), { ok: true, length: 1 });
  assert.deepEqual(await journal.append(auditA, { kind: "late" }, 0), { ok: false, conflict: "LENGTH_MISMATCH", actualLength: 1 });
  assert.deepEqual(await journal.read(auditA), [{ kind: "reservation", costCents: 25 }]);
  await h.audit.run(controlOf(A.agencyId), async (uow) => {
    const entries = await uow.audits.journalOf(auditA);
    assert.deepEqual(entries.map((e) => [e.position, e.auditId, e.stepFence]), [[0, auditA, 3]]);
    // a stale step appends nothing (KA080)
    await assert.rejects(uow.audits.appendJournal({ runId: auditA, auditId: auditA, stepFence: 2, event: { kind: "stale" }, expectedLength: 1 }), (e: unknown) => isDomainFailure(e) && e.reason === "EXECUTION_FENCED");
  });
  await record(interpret.step.stepId, "COMPILED", "compiled-decisions");
  const validating = await h.audit.run(controlOf(A.agencyId), (uow) => uow.audits.advanceAudit(auditA, 3, { to: "VALIDATING" }));
  assert.deepEqual(validating.kind === "APPLIED" ? [validating.record.state, validating.record.version] : [], ["VALIDATING", 4]);
  const validate = await claim("VALIDATE");
  assert.equal(validate.step.fence, 4);

  // --- the system draft, its validation intent and the receipt (D8-AUD-4, D8-PLAN-2) ------------------------------------------------------
  const draftId = ids.next() as PlanId;
  const draftBody = planBody(sA.revisionHash, sA.targetContractHash, sha("policy")) as unknown as PlanBody;
  const draftHash = sha(`draft-body-${draftId}`);
  // DRAFT_READY before the draft is validated is refused at COMMIT
  const draft = await h.audit.run(controlOf(A.agencyId), (uow) => uow.audits.recordSystemDraft(auditA, { planId: draftId, validationId: ids.next() as PlanValidationId, body: draftBody, bodyHash: draftHash }));
  assert.deepEqual([draft.planId, draft.planState, draft.planVersion, draft.validation.fence, draft.validation.origin, draft.validation.auditId], [draftId, "VALIDATING", 3, 1, "AUDIT", auditA]);
  await record(validate.step.stepId, "VALID", "validation-evidence");
  await assert.rejects(
    h.audit.run(controlOf(A.agencyId), (uow) => uow.audits.advanceAudit(auditA, 4, { to: "DRAFT_READY", draftPlanId: draftId })),
    (e: unknown) => failureOf(e)[1] === "EXECUTION_AUTHORITY_LOST",
    "DRAFT_READY only with the draft VALIDATED under a VALID receipt of the audit's subject",
  );
  const receiptHash = sha(`receipt-${draftId}`);
  await validationReceipt(env.validator, A, { planId: draftId, bodyHash: draftHash, revisionHash: sA.revisionHash, targetContractHash: sA.targetContractHash }, receiptHash, "VALID");
  const settled = await h.audit.run(controlOf(A.agencyId), (uow) => uow.audits.settleValidation(draft.validation.validationId, { result: "VALID", receiptHash }));
  assert.deepEqual([settled.current, settled.planState, settled.planVersion, settled.validation.result, settled.validation.receiptHash], [true, "VALIDATED", 4, "VALID", receiptHash]);
  const ready = await h.audit.run(controlOf(A.agencyId), (uow) => uow.audits.advanceAudit(auditA, 4, { to: "DRAFT_READY", draftPlanId: draftId }));
  assert.deepEqual(ready.kind === "APPLIED" ? [ready.record.state, ready.record.version, ready.record.draftPlanId] : [], ["DRAFT_READY", 5, draftId]);
  await h.audit.run(controlOf(A.agencyId), async (uow) => {
    assert.deepEqual((await uow.audits.stepsOf(auditA)).map((s) => [s.kind, s.fence, s.outcome ?? null]), [["PROFILE", 1, null], ["PROFILE", 2, "COMPLETED"], ["INTERPRET", 3, "COMPILED"], ["VALIDATE", 4, "VALID"]]);
    assert.deepEqual((await uow.audits.modelTasksOf(auditA)).map((t) => t.modelTaskId), [taskInput.modelTaskId]);
    assert.deepEqual((await uow.audits.validationsOf(draftId)).map((v) => [v.fence, v.result]), [[1, "VALID"]]);
  });

  // --- ValidatePlan's intent (CMD024) as the request handlers: only the current intent moves the plan ---------------------------------
  const p = await plan({ app: env.app, control: env.control }, A, sA.projectId, "VALIDATION_REQUIRED", "cmd024", undefined, { revisionHash: sA.revisionHash, targetContractHash: sA.targetContractHash });
  const intent = { validationId: ids.next() as PlanValidationId, planId: p.planId as PlanId, expectedVersion: 2, requestedByMembershipId: A.ownerMembershipId as MembershipId };
  const requested = await h.audit.run(tenantOf(A.agencyId), (uow) => uow.audits.requestValidation(intent));
  assert.deepEqual(requested.kind === "APPLIED" ? [requested.record.fence, requested.record.origin, requested.record.result ?? null] : [], [1, "COMMAND", null]);
  const again2 = await h.audit.run(tenantOf(A.agencyId), (uow) => uow.audits.requestValidation({ ...intent, validationId: ids.next() as PlanValidationId }));
  assert.deepEqual(again2, { kind: "STALE", currentVersion: 3, currentState: "VALIDATING" }, "two requests on one version yield one intent");
  const invalidHash = sha(`receipt-invalid-${p.planId}`);
  await validationReceipt(env.validator, A, p, invalidHash, "INVALID");
  const invalid = await h.audit.run(controlOf(A.agencyId), (uow) => uow.audits.settleValidation(intent.validationId, { result: "INVALID", receiptHash: invalidHash }));
  assert.deepEqual([invalid.current, invalid.planState, invalid.planVersion], [true, "VALIDATION_REQUIRED", 4], "findings kept; the plan needs validation again");

  // --- the content-idempotent decision-artifact intake and the ArtifactResolver (D8-PLAN-1) --------------------------------------------
  const document = { candidateDecisions: [{ candidateRef: "candidate-1", effect: "MAP" }], token: "decision-patch" };
  const artifactInput = { artifactRef: ids.next() as ArtifactRef, agencyId: A.agencyId as AgencyId, auditId: auditA, kind: "DECISION_PATCH" as const, document, createdByMembershipId: A.ownerMembershipId as MembershipId };
  const stored = await h.audit.run(tenantOf(A.agencyId), (uow) => uow.audits.storeDecisionArtifact(artifactInput));
  assert.deepEqual([stored.created, stored.artifact.artifactRef, stored.artifact.kind], [true, artifactInput.artifactRef, "DECISION_PATCH"]);
  const restored = await h.audit.run(tenantOf(A.agencyId), (uow) => uow.audits.storeDecisionArtifact({ ...artifactInput, artifactRef: ids.next() as ArtifactRef }));
  assert.deepEqual([restored.created, restored.artifact.artifactRef, restored.artifact.contentHash], [false, artifactInput.artifactRef, stored.artifact.contentHash], "the same document is the same artifact");
  await h.audit.run(tenantOf(A.agencyId), async (uow) => {
    assert.deepEqual((await uow.audits.getDecisionArtifact(artifactInput.artifactRef))?.document, document);
  });
  const resolved = await h.app.run(tenantOf(A.agencyId), (uow) => decisionArtifactResolver.resolveDecisionPatch(uow, A.agencyId as AgencyId, artifactInput.artifactRef));
  assert.deepEqual(resolved, { artifactRef: artifactInput.artifactRef, patchHash: stored.artifact.contentHash, document });
  assert.equal(await h.app.run(tenantOf(B.agencyId), (uow) => decisionArtifactResolver.resolveDecisionPatch(uow, B.agencyId as AgencyId, artifactInput.artifactRef)), null, "another agency's artifact is unknown");

  // --- GRANT_RECONCILIATION: known usage moves from reserved to spent; expiry never early; the grant closes and frees its pool hold -----
  await h.audit.run(controlOf(A.agencyId), async (uow) => {
    assert.equal((await uow.requestJournal.markConsumed(r1, 1, clock.now()))?.state, "CONSUMED");
    const reconciled = await uow.audits.reconcileRequest(r1, 20n);
    assert.deepEqual([reconciled.reservedCents, reconciled.reconciledSpendCents], [0n, 20n]);
  });
  const early = await h.audit.run(controlOf(A.agencyId), (uow) => uow.audits.getGrant(inputA.grantId));
  assert.ok(early);
  await assert.rejects(h.audit.run(controlOf(A.agencyId), (uow) => uow.audits.transitionGrant(inputA.grantId, early.version, "EXPIRED")), (e: unknown) => failureOf(e)[1] === "EXECUTION_AUTHORITY_LOST", "never before its expiry");
  const closed = await h.audit.run(controlOf(A.agencyId), (uow) => uow.audits.transitionGrant(inputA.grantId, early.version, "CLOSED"));
  assert.deepEqual(closed.kind === "APPLIED" ? [closed.record.state, closed.record.version] : [], ["CLOSED", 3]);
  assert.deepEqual(await heldOn(last), { reserved: 0, spent: 20, state: "AUTHORIZED" }, "the pool holds nothing more for the closed grant and records its spend");
  assert.deepEqual(
    (await h.oracle.query("SELECT event_type FROM kauro.domain_events WHERE aggregate_id = $1 ORDER BY aggregate_version", [inputA.grantId])).rows.map((r) => r.event_type),
    ["cost_grant.prepared.v1", "cost_grant.authorized.v1", "cost_grant.closed.v1"],
  );
});
