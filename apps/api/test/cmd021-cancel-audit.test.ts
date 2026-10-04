// CMD021 CancelAudit through its route (package B08, mandate B08-COMMANDS-AUDIT; docs/design/B08-audit-approval-jobs.md §6 the audit's phases and
// the cancellation that wins over every live one, §12 the served route; docs/design/B08-case-map.md CMD021-OK, CMD021-DENY, CMD021-RACE): an
// OPERATOR of the agency ends a live audit at the version it read — one CANCELLED audit, its cancellation version advanced, one
// audit.cancelled.v1 event to AUDIT_ORCHESTRATION under the audit row's lock. A terminal audit is 409 AUDIT_TERMINAL whatever version the
// caller names (the answer that the cancellation already happened is final), a live audit at another version 409 STALE_VERSION. The control
// plane's steps (profiling, interpretation, a failure, the decisions it needs) are written through the product's adapters (audit-support.ts).
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { accepted } from "./commerce-support.js";
import {
  AUDIT_ROW_LOCK,
  auditEvents,
  auditRow,
  auditWorld,
  cancelAudit,
  driveTo,
  endLiveAudits,
  footprint,
  fundPool,
  grantRow,
  startAudit,
  startedAudit,
  subjectOf,
  type AuditView,
  type AuditWorld,
} from "./audit-support.js";
import { SimulatedCrash, asProblem, completed, freshKey, outcome, replayTextOf, waitForApiLockWait } from "./support.js";
import { reachedHold } from "./writers.js";

let aw: AuditWorld;
before(async () => {
  aw = await auditWorld();
  await fundPool(aw);
});
after(async () => {
  await aw.stop();
});
// the agency's one live audit is ended after each case, so the next case may queue its own
afterEach(async () => {
  await endLiveAudits(aw.w);
});

/** The audit's row as the oracle reads it, reduced to what a refused or crashed cancellation must leave alone. */
async function untouched(auditId: string): Promise<readonly [string, string, string, string | null]> {
  const row = await auditRow(aw.w, auditId);
  return [row.state, row.version, row.cancel_version, row.terminal_reason];
}

test("OK, DENY and RACE: CancelAudit advances the cancellation version and ends the audit CANCELLED; a VIEWER is 403, a terminal audit 409 AUDIT_TERMINAL, a stale version 409 STALE_VERSION, and two cancellations on one version yield one", async () => {
  const { w } = aw;
  const poolId = aw.poolId as string;

  // --- OK: a QUEUED audit is cancelled at the version the caller read ---
  const started = await startedAudit(aw);
  const queued = await auditRow(w, started.auditId);
  assert.deepEqual([queued.state, queued.version, queued.cancel_version], ["QUEUED", "1", "0"]);
  const reserved = (await grantRow(w, poolId)).reserved_cents;
  const key = freshKey("cmd021-ok");
  const first = await cancelAudit(w, started.auditId, { expectedVersion: 1 }, { key });
  const done = completed<AuditView>(first, 200);
  const view = done.data;
  assert.equal(done.version, 2);
  assert.equal(done.replayed, false);
  // the audit as the cancellation left it: CANCELLED, the cancellation version advanced, the grant still the pool's carve, no action left
  assert.deepEqual([view.auditId, view.revisionId, view.targetContractId, view.grantId], [started.auditId, started.subject.revisionId, started.subject.contractId, started.grantId]);
  assert.deepEqual([view.state, view.version, view.cancelVersion, view.terminalReason, view.grantClass, view.grantState], ["CANCELLED", 2, 1, "AGENCY_CANCELLED", "FREE_AUDIT", "AUTHORIZED"]);
  assert.deepEqual(view.permittedActions, [], "an ended audit offers no action");
  const cancelled = await auditRow(w, started.auditId);
  assert.deepEqual([cancelled.state, cancelled.version, cancelled.cancel_version, cancelled.cancel_actor_kind, cancelled.cancel_actor_id, cancelled.terminal_reason], ["CANCELLED", "2", "1", "USER", w.operator.userId, "AGENCY_CANCELLED"]);
  assert.ok(cancelled.terminal_at instanceof Date, "the end is stamped");
  // one event at the audit's new version, routed to AUDIT_ORCHESTRATION only
  const events = (await auditEvents(w, started.auditId)).filter((e) => e.type === "audit.cancelled.v1");
  assert.deepEqual(events.map((e) => [e.version, e.consumers]), [[2, ["AUDIT_ORCHESTRATION"]]]);
  assert.deepEqual(events[0]?.payload, {
    auditId: started.auditId,
    agencyId: w.A.agencyId,
    projectId: started.subject.projectId,
    revisionId: started.subject.revisionId,
    targetContractId: started.subject.contractId,
    grantId: started.grantId,
    fence: 0,
    previousState: "QUEUED",
    state: "CANCELLED",
    cancelVersion: 1,
    actorKind: "USER",
    reasonCode: "AGENCY_CANCELLED",
  });
  const journal = await w.journal(key);
  assert.deepEqual([journal?.state, journal?.status, journal?.resourceKind, journal?.resourceId], ["COMMITTED", 200, "audit", started.auditId]);
  // the pool's reservation is the control plane's to reconcile (the grant's spend closes it): a cancellation releases nothing itself
  assert.equal((await grantRow(w, poolId)).reserved_cents, reserved);
  // the agency's slot is free at once: another subject's audit is queued
  const next = await subjectOf(w);
  assert.equal(accepted(await startAudit(w, next.revisionId, { targetContractId: next.contractId })).state, "QUEUED");
  await endLiveAudits(w);

  // an audit past QUEUED is cancelled all the same (cancellation wins over every live phase): INTERPRETING at v3 ends CANCELLED at v4
  const interpreting = await startedAudit(aw);
  await driveTo(w, interpreting, "INTERPRETING");
  const live = await auditRow(w, interpreting.auditId);
  assert.deepEqual([live.state, live.version], ["INTERPRETING", "3"]);
  const phase = completed<AuditView>(await cancelAudit(w, interpreting.auditId, { expectedVersion: 3 }), 200);
  assert.deepEqual([phase.data.state, phase.data.version, phase.data.cancelVersion], ["CANCELLED", 4, 1]);
  assert.equal(phase.data.interpretationDeadlineAt !== undefined, true, "the deadline stamped at INTERPRETING stays on the record");

  // --- DENY ---
  const target = await startedAudit(aw);
  await driveTo(w, target, "PROFILING");
  const profiling = await auditRow(w, target.auditId);
  assert.deepEqual([profiling.state, profiling.version], ["PROFILING", "2"]);
  // a refusal writes nothing: no event, outbox record or journal entry, and the audit is as it was
  const refused = async (what: string, auditId: string, body: { readonly expectedVersion: number }, options: Parameters<typeof cancelAudit>[3], expected: string): Promise<Awaited<ReturnType<typeof cancelAudit>>> => {
    const state = await untouched(auditId);
    const written = await footprint(w);
    const reply = await cancelAudit(w, auditId, body, options);
    assert.equal(outcome(w, reply), expected, what);
    assert.deepEqual(await footprint(w), written, `${what}: nothing written`);
    assert.deepEqual(await untouched(auditId), state, `${what}: the audit is untouched`);
    return reply;
  };
  // roles: a VIEWER (and an APPROVER, and a BILLING member) is not an operator; the denial is a durable fact of the agency's stream
  const denied = (await w.securityEvents("CMD021")).length;
  await refused("viewer", target.auditId, { expectedVersion: 2 }, { token: w.viewer.token }, "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  await refused("approver", target.auditId, { expectedVersion: 2 }, { token: w.approver.token }, "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.deepEqual((await w.securityEvents("CMD021")).slice(denied).map((f) => [f.outcome, f.reason, f.agencyId, f.actorId]), [
    ["DENY", "ROLE_INSUFFICIENT", w.A.agencyId, w.viewer.userId],
    ["DENY", "ROLE_INSUFFICIENT", w.A.agencyId, w.approver.userId],
  ]);
  // another agency's audit is 404, the answer of an audit that never existed
  const foreign = await refused("foreign audit", target.auditId, { expectedVersion: 2 }, { token: w.stranger.token, agency: w.B.agencyId }, "404 NOT_FOUND -");
  const unknown = await cancelAudit(w, "00000000-0000-4000-8000-000000000000", { expectedVersion: 1 }, { token: w.stranger.token, agency: w.B.agencyId });
  assert.deepEqual({ ...asProblem(w, foreign), correlationId: "" }, { ...asProblem(w, unknown), correlationId: "" }, "a foreign and a nonexistent audit answer alike");
  // a stale version: the audit moved since the caller read it (it was QUEUED at v1); the answer names where it is
  const stale = await refused("stale version", target.auditId, { expectedVersion: 1 }, {}, "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, stale).current, { version: 2, state: "PROFILING" });
  assert.deepEqual(asProblem(w, stale).nextActions, [{ action: "RELOAD" }, { action: "COMPARE_VERSIONS" }]);

  // a terminal audit — cancelled (through the route), failed (by the control plane), or waiting for decisions — is 409 AUDIT_TERMINAL: nothing to
  // cancel, whatever version the caller names; the answer names where the audit ended and offers no action
  const cancelledRow = await auditRow(w, started.auditId);
  const endedReply = await refused("a CANCELLED audit", started.auditId, { expectedVersion: Number(cancelledRow.version) }, {}, "409 PRECONDITION_FAILED AUDIT_TERMINAL");
  assert.deepEqual(asProblem(w, endedReply).current, { version: 2, state: "CANCELLED" });
  assert.deepEqual(asProblem(w, endedReply).nextActions, []);
  await refused("a CANCELLED audit at a stale version", started.auditId, { expectedVersion: 1 }, {}, "409 PRECONDITION_FAILED AUDIT_TERMINAL");
  await endLiveAudits(w);
  const failed = await startedAudit(aw);
  await driveTo(w, failed, "FAILED");
  const failedRow = await auditRow(w, failed.auditId);
  assert.deepEqual([failedRow.state, failedRow.version], ["FAILED", "3"]);
  const failedReply = await refused("a FAILED audit", failed.auditId, { expectedVersion: 3 }, {}, "409 PRECONDITION_FAILED AUDIT_TERMINAL");
  assert.deepEqual(asProblem(w, failedReply).current, { version: 3, state: "FAILED" });
  const deciding = await startedAudit(aw);
  await driveTo(w, deciding, "NEEDS_DECISION");
  const decidingRow = await auditRow(w, deciding.auditId);
  assert.deepEqual([decidingRow.state, decidingRow.version], ["NEEDS_DECISION", "4"]);
  await refused("an audit that needs decisions", deciding.auditId, { expectedVersion: 4 }, {}, "409 PRECONDITION_FAILED AUDIT_TERMINAL");

  // --- RACE ---
  const racing = await startedAudit(aw);
  const initial = await auditRow(w, racing.auditId);
  const raceKey = freshKey("cmd021-race");
  const body = { expectedVersion: Number(initial.version) };

  // an identical retry replays the journaled 200, byte for byte, and cancels nothing again; the same key with another version is a typed conflict
  const won = await cancelAudit(w, racing.auditId, body, { key: raceKey });
  completed<AuditView>(won, 200);
  const replay = await cancelAudit(w, racing.auditId, body, { key: raceKey });
  assert.equal(replay.status, 200);
  assert.equal(replay.text, replayTextOf(won));
  const settled = await footprint(w);
  const conflicting = await cancelAudit(w, racing.auditId, { expectedVersion: body.expectedVersion + 1 }, { key: raceKey });
  assert.equal(outcome(w, conflicting), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.deepEqual(await footprint(w), settled);
  assert.equal((await auditEvents(w, racing.auditId)).filter((e) => e.type === "audit.cancelled.v1").length, 1);

  // two CancelAudit calls on one version: the first held before its journal commit with the audit row locked; the second is observed waiting on
  // that row (FOR UPDATE), then finds the audit ended and answers AUDIT_TERMINAL at the version the first committed — one cancellation, one 409
  await endLiveAudits(w);
  const pair = await startedAudit(aw);
  const pairRow = await auditRow(w, pair.auditId);
  const pairBody = { expectedVersion: Number(pairRow.version) };
  const hold = w.holds.arm("journal.commit");
  const winner = cancelAudit(w, pair.auditId, pairBody);
  let loser: ReturnType<typeof cancelAudit> | undefined;
  try {
    await reachedHold(hold, winner);
    loser = cancelAudit(w, pair.auditId, pairBody);
    await waitForApiLockWait(w, AUDIT_ROW_LOCK);
  } finally {
    hold.release();
  }
  const [victor, beaten] = await Promise.all([winner, loser as ReturnType<typeof cancelAudit>]);
  assert.equal(completed<AuditView>(victor, 200).data.state, "CANCELLED");
  assert.equal(outcome(w, beaten), "409 PRECONDITION_FAILED AUDIT_TERMINAL");
  assert.deepEqual(asProblem(w, beaten).current, { version: Number(pairRow.version) + 1, state: "CANCELLED" });
  assert.equal((await auditEvents(w, pair.auditId)).filter((e) => e.type === "audit.cancelled.v1").length, 1, "one cancellation");
  assert.equal((await auditRow(w, pair.auditId)).cancel_version, "1");

  // a crash before COMMIT leaves the audit live: the cancellation and its event were written and never committed; the same key then cancels once
  const crashing = await startedAudit(aw);
  const crashingRow = await auditRow(w, crashing.auditId);
  const crashKey = freshKey("cmd021-crash");
  const beforeCrash = await footprint(w);
  const stateBefore = await untouched(crashing.auditId);
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await cancelAudit(w, crashing.auditId, { expectedVersion: Number(crashingRow.version) }, { key: crashKey });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.deepEqual(await footprint(w), beforeCrash, "nothing left behind");
  assert.deepEqual(await untouched(crashing.auditId), stateBefore);
  assert.equal((await auditRow(w, crashing.auditId)).state, "QUEUED", "the audit is still live");
  assert.equal(await w.journal(crashKey), null);
  const retried = completed<AuditView>(await cancelAudit(w, crashing.auditId, { expectedVersion: Number(crashingRow.version) }, { key: crashKey }), 200);
  assert.equal(retried.data.state, "CANCELLED");
  assert.equal((await auditEvents(w, crashing.auditId)).filter((e) => e.type === "audit.cancelled.v1").length, 1);
});
