// GRANT_RECONCILIATION (package B08, mandate B08-CONTROL-AUDIT; docs/design/B08-audit-approval-jobs.md §3, §8.1, §11; decisions
// D8-GRANT-1, D8-GRANT-2, D8-DL-1, D8-PAU-3, D8-PAU-4; supporting B03's IC-12) on a real PostgreSQL 17 through this package's own
// control plane: the sweeper settles the dispatch intents reserved on each cost grant — a known usage joins the grant's spend, an
// intent the database can no longer send is released, an unknown or uncertain usage stays reserved — and takes the grant's edges on
// the server clock: EXHAUSTED when known spend plus reserved reaches its ceiling, AUTHORIZED again when a proven unused amount frees
// room, EXPIRED at its expiry and never before, CLOSED only when nothing it funds is live and no usage is uncertain; an AUDIT grant's
// close releases its pool's hold. The audits are StartAudit's and CancelAudit's writes through the audit store (the routes are
// B08-COMMANDS-AUDIT's); the pool is the owner's funding act (Q8-1). The model tasks and dispatch intents stand for the Intelligence
// core adapter's (b05/cores) dispatches under the platform's own adapters as the control plane — nothing here is a fake — and the
// PROFILE step before them is AUDIT_ORCHESTRATION's over the labelled Migration and Intelligence fakes (SIMULATED). Time is the labelled
// TEST CLOCK of the control plane's units. The superuser is the oracle only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Id } from "@kauro/contracts";
import type { AuditId, AuditStepId, LeaseOwnerId, ModelTaskId, RequestId, RequestJournalRecord } from "@kauro/domain";
import { openAuditWorld, type AuditWorld } from "./support/audit-world.js";
import { ids, sha, startExecutionWorld, type ExecutionWorld } from "./support/execution-world.js";

let w: ExecutionWorld;
let a: AuditWorld;

before(async () => {
  w = await startExecutionWorld("grants");
  a = await openAuditWorld(w);
});

after(async () => {
  await w.stop();
});

test("GRANT_RECONCILIATION keeps an unknown usage reserved, releases only a proven unused amount, exhausts and expires grants on the server clock never early, and closes a grant only when no uncertain usage remains", async () => {
  const sweep = async (): Promise<void> => {
    const result = await w.x.sweepers.grantReconciliation.sweep(w.units, 50);
    assert.deepEqual(result.failed ?? [], [], "no grant failed to reconcile");
  };
  /** The TEST CLOCK of the control plane's units at `instant` + `seconds` (never a back-dated row). */
  const standAt = (instant: string, seconds: number): void => {
    w.advance(Math.floor((Date.parse(instant) - Date.now()) / 1000) + seconds - w.units.offsetSeconds);
  };
  const usage = async (r: RequestJournalRecord) => {
    const row = await a.request(r.requestId);
    return [row.state, row.usage_state, row.actual] as const;
  };
  const poolOf = async () => {
    const p = await a.grant(a.pool);
    return [p.state, p.version, p.reserved, p.spent] as const;
  };
  assert.deepEqual(await poolOf(), ["AUTHORIZED", "2", 0, 0]);

  // --- audit X interprets on its AUDIT grant: three dispatch intents of 50 cents fill its 150-cent ceiling ---------------------------
  const sx = await w.subject(w.A, "grants-x");
  const X = await a.start(sx);
  const auditX = X.audit.auditId;
  const grantX = X.grant.grantId;
  assert.deepEqual(await w.redeliver(w.x.consumers.auditOrchestration, await w.eventOf(auditX, "audit.queued.v1")), { kind: "DONE" });
  const interpreting = await a.audit(auditX);
  assert.equal(interpreting.state, "INTERPRETING");
  assert.ok(interpreting.candidate_manifest_hash !== null && interpreting.interpretation_deadline_at !== null);
  const manifest = interpreting.candidate_manifest_hash;
  // the Intelligence core adapter's dispatches (b05/cores): the INTERPRET step, one model task each, each intent reserving on the grant
  const [r1, r2, r3] = await a.control(w.A.agencyId, async (uow) => {
    const step = await uow.audits.claimStep(auditX as AuditId, "INTERPRET", ids.next() as AuditStepId);
    const owner = step.step.stepId as string as LeaseOwnerId;
    const dispatch = async (key: string): Promise<RequestJournalRecord> => {
      const task = await uow.audits.createModelTask({
        modelTaskId: ids.next() as ModelTaskId,
        auditId: auditX as AuditId,
        stepFence: step.step.fence,
        taskKey: sha(`task-${key}`),
        candidateManifestHash: manifest,
        policyHash: sha("model-policy"),
        minimizedRequestHash: sha(`minimized-${key}`),
        providerProfileId: ids.next() as Id,
        maximumCostCents: 50n,
      });
      const out = await uow.audits.beginDispatch(task.modelTaskId, { requestId: ids.next() as RequestId, ownerId: owner, requestHash: sha(`request-${key}`), reservedCents: 50n, stepFence: step.step.fence });
      assert.equal(out.kind, "RESERVED");
      if (out.kind !== "RESERVED") throw new Error("not reserved");
      return out.request;
    };
    return [await dispatch("1"), await dispatch("2"), await dispatch("3")] as const;
  });
  // r1 is never sent; r2 is sent and its answer lost (UNCERTAIN); r3 is answered with a known usage and consumed
  await a.control(w.A.agencyId, async (uow) => {
    const j = uow.requestJournal;
    await j.markDispatching(r2.requestId as RequestId, r2.fence, "provider-request-2", w.now());
    await j.markUncertain(r2.requestId as RequestId, r2.fence, w.now());
    await j.markDispatching(r3.requestId as RequestId, r3.fence, "provider-request-3", w.now());
    await j.storeResponse(r3.requestId as RequestId, r3.fence, sha("response-3"), { usageState: "KNOWN", actualCents: "50" as never }, w.now());
    await j.markConsumed(r3.requestId as RequestId, r3.fence, w.now());
  });
  const gx0 = await a.grant(grantX);
  assert.deepEqual([gx0.state, gx0.ceiling, gx0.reserved, gx0.spent], ["AUTHORIZED", 150, 150, 0]);

  // --- the valid neighbour: audit Y of another agency ends with nothing dispatched ---------------------------------------------------
  const sy = await w.subject(w.B, "grants-y");
  const Y = await a.start(sy);
  await a.cancel(sy, Y.audit.auditId);
  assert.deepEqual(await poolOf(), ["AUTHORIZED", "2", 300, 0], "the pool holds both AUDIT grants' ceilings");

  // --- the first pass: a known usage joins the spend; the ceiling is reached; nothing unknown or still sendable is released ---------
  await sweep();
  assert.deepEqual(await usage(r3), ["CONSUMED", "RECONCILED", 50], "the known usage is reconciled into the grant's spend");
  assert.deepEqual(await usage(r1), ["RESERVED", "UNKNOWN", null], "a still sendable intent keeps its reservation (its audit interprets, before the interpretation deadline)");
  assert.deepEqual(await usage(r2), ["UNCERTAIN", "UNKNOWN", null], "an uncertain send keeps its reservation");
  const gx1 = await a.grant(grantX);
  assert.deepEqual([gx1.state, gx1.reserved, gx1.spent], ["EXHAUSTED", 100, 50], "known spend plus reserved reaches the ceiling");
  // the neighbour closes at once: its audit ended and no usage of it is uncertain; its pool hold is released
  const gy = await a.grant(Y.grant.grantId);
  assert.deepEqual([gy.state, gy.reserved, gy.spent], ["CLOSED", 0, 0]);
  assert.deepEqual(await poolOf(), ["AUTHORIZED", "2", 150, 0]);
  // a second pass changes nothing
  await sweep();
  assert.deepEqual([(await a.grant(grantX)).state, (await a.grant(grantX)).version, (await a.grant(Y.grant.grantId)).version], ["EXHAUSTED", gx1.version, gy.version]);

  // --- the interpretation deadline on the server clock, never early: only then is the unsent intent proven unused -------------------
  standAt(interpreting.interpretation_deadline_at, -30);
  await sweep();
  assert.deepEqual(await usage(r1), ["RESERVED", "UNKNOWN", null], "not before the interpretation deadline");
  assert.equal((await a.grant(grantX)).state, "EXHAUSTED");
  standAt(interpreting.interpretation_deadline_at, 30);
  await sweep();
  assert.deepEqual(await usage(r1), ["CANCELLED", "RECONCILED", 0], "the database can no longer send it: released, nothing spent");
  assert.deepEqual(await usage(r2), ["UNCERTAIN", "UNKNOWN", null], "the uncertain send stays reserved past the deadline");
  const gx2 = await a.grant(grantX);
  assert.deepEqual([gx2.state, gx2.reserved, gx2.spent], ["AUTHORIZED", 50, 50], "the released amount makes the grant AUTHORIZED again");

  // --- the audit ends: its scope closes, but the uncertain usage keeps the grant open ---------------------------------------------
  await a.cancel(sx, auditX);
  await sweep();
  assert.deepEqual([(await a.grant(grantX)).state, (await a.grant(grantX)).reserved], ["AUTHORIZED", 50], "no close while a usage is uncertain");

  // --- the grant's expiry on the server clock, never early ------------------------------------------------------------------------
  standAt(gx2.expires_at, -30);
  await sweep();
  assert.equal((await a.grant(grantX)).state, "AUTHORIZED", "not before its expiry");
  standAt(gx2.expires_at, 30);
  await sweep();
  const gx3 = await a.grant(grantX);
  assert.deepEqual([gx3.state, gx3.reserved, gx3.spent], ["EXPIRED", 50, 50], "expired, still holding the uncertain usage");

  // --- the provider's usage of the uncertain send becomes known (the adapter's reconciliation): the grant closes -----------------------
  await a.control(w.A.agencyId, async (uow) => {
    await uow.requestJournal.storeResponse(r2.requestId as RequestId, r2.fence, sha("response-2-reconciled"), { usageState: "KNOWN", actualCents: "30" as never }, w.now());
    await uow.requestJournal.markConsumed(r2.requestId as RequestId, r2.fence, w.now());
  });
  await sweep();
  assert.deepEqual(await usage(r2), ["CONSUMED", "RECONCILED", 30]);
  const gx4 = await a.grant(grantX);
  assert.deepEqual([gx4.state, gx4.reserved, gx4.spent], ["CLOSED", 0, 80], "closed once no usage is uncertain");
  assert.deepEqual(await poolOf(), ["AUTHORIZED", "2", 0, 80], "the pool's hold becomes the closed grant's spend");
  assert.deepEqual(await a.events(grantX), [
    ["cost_grant.prepared.v1", "USER", w.A.ownerUserId],
    ["cost_grant.authorized.v1", "USER", w.A.ownerUserId],
    ["cost_grant.exhausted.v1", "SERVICE", "grant-reconciliation"],
    ["cost_grant.authorized.v1", "SERVICE", "grant-reconciliation"],
    ["cost_grant.expired.v1", "SERVICE", "grant-reconciliation"],
    ["cost_grant.closed.v1", "SERVICE", "grant-reconciliation"],
  ]);
  assert.deepEqual((await a.events(Y.grant.grantId)).map(([type]) => type), ["cost_grant.prepared.v1", "cost_grant.authorized.v1", "cost_grant.closed.v1"]);
  w.advance(-w.units.offsetSeconds);
});
