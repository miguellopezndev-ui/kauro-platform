// CMD020 StartAudit through its route (package B08, mandate B08-COMMANDS-AUDIT; docs/design/B08-audit-approval-jobs.md §3 the AUDIT grant, §6 the
// audit's phases, §12 the served route; docs/design/B08-case-map.md R2-044, CMD020-OK, CMD020-DENY, CMD020-RACE): an OPERATOR of the agency asks for
// the audit of a sealed, available revision against a confirmed current target contract — one live audit per agency, one audit per subject for
// good, the AUDIT grant carved from the platform's funded monthly pool under the pool row's lock or 429 BUDGET_EXHAUSTED NO_FUNDED_GRANT with
// nothing written, and a 202 whose operation is the audit. The core fakes are bound to the api and record no call: StartAudit only queues.
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import type { ProjectId } from "@kauro/domain";
import { accepted } from "./commerce-support.js";
import {
  AUDIT_POLICY,
  POOL_ROW_LOCK,
  auditEvents,
  auditIdOf,
  auditRow,
  auditWorld,
  auditsOfAgency,
  endLiveAudits,
  footprint,
  fundPool,
  grantEvents,
  grantRow,
  secondsBetween,
  startAudit,
  subjectOf,
  type AuditWorld,
} from "./audit-support.js";
import { activate, sealedThroughRoutes } from "./source-support.js";
import { SimulatedCrash, asProblem, freshKey, outcome, waitForApiLockWait } from "./support.js";
import { reachedHold } from "./writers.js";

let aw: AuditWorld;
before(async () => {
  aw = await auditWorld();
});
after(async () => {
  await aw.stop();
});
// the agency's one live audit is ended after each case, so the next case may queue its own
afterEach(async () => {
  await endLiveAudits(aw.w);
});

/** The server's own instant, as the database reads it (the audit's deadlines are stamped by the database, never by the process). */
async function serverNow(): Promise<Date> {
  const r = await aw.w.h.oracle.query<{ t: Date }>("SELECT kauro.server_now() AS t");
  const t = r.rows[0]?.t;
  assert.ok(t instanceof Date, "the server's instant");
  return t;
}

test("R2-044: a revision sealed through SealRevision with no funded grant — StartAudit is 429 BUDGET_EXHAUSTED NO_FUNDED_GRANT, no audit, grant reservation, model task or dispatch intent exists and the core fakes recorded no call; the funded neighbour is QUEUED with its reservation", async () => {
  const { w, core } = aw;
  // a revision sealed through the source lifecycle's own routes (SealRevision, 200) and a confirmed current target contract of its project
  const sealed = await sealedThroughRoutes(w);
  const target = await w.targetContract(w.A, sealed.projectId as ProjectId);
  const body = { targetContractId: target.contractId };
  assert.equal(aw.poolId, null, "the platform's pool is not funded yet");
  assert.equal(await w.count("cost_grants"), 0, "no grant of any kind exists");

  // no funded pool: the refusal writes nothing — no audit, no AUDIT grant (so no reservation), no model task, no dispatch intent, no event
  const written = await footprint(w);
  const key = freshKey("r2-044");
  const refused = await startAudit(w, sealed.revisionId, body, { key });
  assert.equal(outcome(w, refused), "429 BUDGET_EXHAUSTED NO_FUNDED_GRANT");
  assert.equal(asProblem(w, refused).retryable, false);
  assert.deepEqual(await footprint(w), written, "nothing written");
  assert.deepEqual([await w.count("audits"), await w.count("cost_grants"), await w.count("model_tasks"), await w.count("model_task_journal")], [0, 0, 0, 0]);
  assert.equal(await w.journal(key), null, "the refused command left no journal row");
  assert.deepEqual(core.calls(), [], "the core fakes recorded no call");

  // the owner funds the platform's monthly pool (Q8-1): the funded neighbour — the same revision and target — is QUEUED with its reservation
  const poolId = await fundPool(aw);
  assert.equal((await grantRow(w, poolId)).reserved_cents, "0");
  const started = await startAudit(w, sealed.revisionId, body);
  const auditId = auditIdOf(started);
  const audit = await auditRow(w, auditId);
  assert.deepEqual([audit.state, audit.version, audit.revision_id, audit.revision_hash, audit.target_contract_id], ["QUEUED", "1", sealed.revisionId, sealed.manifestHash, target.contractId]);
  const grant = await grantRow(w, audit.grant_id);
  assert.deepEqual([grant.grant_kind, grant.pool_grant_id, grant.ceiling_cents, grant.state, grant.reserved_cents], ["AUDIT", poolId, String(AUDIT_POLICY.freeAuditCeilingCents), "AUTHORIZED", "0"]);
  assert.equal((await grantRow(w, poolId)).reserved_cents, String(AUDIT_POLICY.freeAuditCeilingCents), "the pool holds the audit grant's ceiling");
  assert.deepEqual([await w.count("audits"), await w.count("model_tasks"), await w.count("model_task_journal")], [1, 0, 0]);
  assert.deepEqual(core.calls(), [], "queuing an audit calls no core");
});

test("OK: StartAudit on a sealed, available revision with a confirmed current target reserves a free audit grant from the funded pool and answers 202 with one QUEUED audit, its deadlines at the server's instant and one audit.queued.v1 event to AUDIT_ORCHESTRATION", async () => {
  const { w, core } = aw;
  const poolId = aw.poolId as string;
  const subject = await subjectOf(w);
  const poolBefore = BigInt((await grantRow(w, poolId)).reserved_cents);
  const key = freshKey("cmd020-ok");

  const from = await serverNow();
  const reply = await startAudit(w, subject.revisionId, { targetContractId: subject.contractId }, { key });
  const to = await serverNow();
  const auditId = auditIdOf(reply);
  assert.equal(reply.status, 202);
  assert.deepEqual(accepted(reply), { kind: "ACCEPTED", operationId: auditId, state: "QUEUED", statusPath: `/api/v1/audits/${auditId}`, pollAfterSeconds: 10 });

  // one QUEUED audit of the subject, requested by the caller's membership, on the policy the body named
  const audit = await auditRow(w, auditId);
  assert.deepEqual(
    [audit.agency_id, audit.project_id, audit.revision_id, audit.revision_hash, audit.target_contract_id, audit.target_contract_hash, audit.audit_policy_version, audit.requested_by_membership_id],
    [w.A.agencyId, subject.projectId, subject.revisionId, subject.revisionHash, subject.contractId, subject.targetContractHash, "R2-INITIAL", w.memberships.operator],
  );
  assert.deepEqual([audit.state, audit.version, audit.fence, audit.cancel_version, audit.draft_plan_id, audit.terminal_reason], ["QUEUED", "1", "0", "0", null, null]);
  assert.equal(await w.count("audits", "revision_id = $1", [subject.revisionId]), 1, "one audit of the subject");

  // its deadlines are the database's instant: started now (between two readings of the server's clock), absolute deadline a day later, the
  // interpretation deadline stamped only when the audit reaches INTERPRETING
  assert.ok(audit.started_at >= from && audit.started_at <= to, "startedAt is the server's instant");
  assert.equal(secondsBetween(audit.started_at.toISOString(), audit.absolute_deadline_at.toISOString()), AUDIT_POLICY.auditAbsoluteSeconds);
  assert.equal(audit.interpretation_deadline_at, null);

  // the free audit grant carved from the funded pool: AUTHORIZED by the pool, ceiling 150 cents, the pool holding it
  const grant = await grantRow(w, audit.grant_id);
  assert.deepEqual([grant.agency_id, grant.grant_kind, grant.pool_grant_id, grant.authorization_ref, grant.ceiling_cents, grant.reserved_cents, grant.reconciled_spend_cents, grant.state], [w.A.agencyId, "AUDIT", poolId, poolId, "150", "0", "0", "AUTHORIZED"]);
  assert.equal(BigInt((await grantRow(w, poolId)).reserved_cents), poolBefore + 150n);

  // one audit.queued.v1 at version 1, routed to AUDIT_ORCHESTRATION only; the grant's two events (prepared, authorized) have no consumer
  assert.deepEqual(
    (await auditEvents(w, auditId)).map((e) => [e.version, e.type, e.consumers]),
    [[1, "audit.queued.v1", ["AUDIT_ORCHESTRATION"]]],
  );
  assert.deepEqual((await auditEvents(w, auditId))[0]?.payload, {
    auditId,
    agencyId: w.A.agencyId,
    projectId: subject.projectId,
    revisionId: subject.revisionId,
    revisionHash: subject.revisionHash,
    targetContractId: subject.contractId,
    targetContractHash: subject.targetContractHash,
    grantId: audit.grant_id,
    state: "QUEUED",
  });
  assert.deepEqual(
    (await grantEvents(w, audit.grant_id)).map((e) => [e.version, e.type, e.consumers]),
    [
      [1, "cost_grant.prepared.v1", []],
      [2, "cost_grant.authorized.v1", []],
    ],
  );
  const journal = await w.journal(key);
  assert.deepEqual([journal?.state, journal?.status, journal?.resourceKind, journal?.resourceId], ["COMMITTED", 202, "audit", auditId]);
  assert.deepEqual(core.calls(), [], "queuing an audit calls no core");
});

test("DENY and RACE: a VIEWER is 403, another agency's revision 404, an unsealed revision 409 REVISION_NOT_SEALED, a stale target 422 TARGET_STALE, a second live audit of the agency 429 AUDIT_CONCURRENCY_LIMITED, a second audit of the same subject 409 AUDIT_EXISTS; an identical retry replays and the same key with another target is 409 IDEMPOTENCY_CONFLICT", async () => {
  const { w } = aw;
  const poolId = aw.poolId as string;
  const subject = await subjectOf(w);
  const body = { targetContractId: subject.contractId };
  const earlier = await auditsOfAgency(w); // the earlier cases' audits (ended)
  // a refusal writes nothing: no audit, grant, reservation, event, outbox record or journal entry
  const refused = async (what: string, revisionId: string, requested: { readonly targetContractId: string }, options: Parameters<typeof startAudit>[3], expected: string): Promise<Awaited<ReturnType<typeof startAudit>>> => {
    const written = await footprint(w);
    const reply = await startAudit(w, revisionId, requested, options);
    assert.equal(outcome(w, reply), expected, what);
    assert.deepEqual(await footprint(w), written, `${what}: nothing written`);
    return reply;
  };

  // roles: a VIEWER (and an APPROVER, and a BILLING member) is not an operator; the denial is a durable fact of the agency's stream
  const denied = (await w.securityEvents("CMD020")).length;
  await refused("viewer", subject.revisionId, body, { token: w.viewer.token }, "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  await refused("approver", subject.revisionId, body, { token: w.approver.token }, "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.deepEqual((await w.securityEvents("CMD020")).slice(denied).map((f) => [f.outcome, f.reason, f.agencyId, f.actorId]), [
    ["DENY", "ROLE_INSUFFICIENT", w.A.agencyId, w.viewer.userId],
    ["DENY", "ROLE_INSUFFICIENT", w.A.agencyId, w.approver.userId],
  ]);
  // another agency's revision is 404, the answer of a revision that never existed
  const foreign = await refused("foreign revision", subject.revisionId, body, { token: w.stranger.token, agency: w.B.agencyId }, "404 NOT_FOUND -");
  const unknown = await startAudit(w, "00000000-0000-4000-8000-000000000000", body, { token: w.stranger.token, agency: w.B.agencyId });
  assert.deepEqual({ ...asProblem(w, foreign), correlationId: "" }, { ...asProblem(w, unknown), correlationId: "" }, "a foreign and a nonexistent revision answer alike");

  // an unsealed revision: a DRAFT one answers where it is, and an EXPIRED or long-sealed one is no longer available
  const draft = await w.project(w.A, w.clientA);
  const draftTarget = await w.targetContract(w.A, draft.projectId);
  const unsealed = await refused("draft revision", draft.revisionId, { targetContractId: draftTarget.contractId }, {}, "409 PRECONDITION_FAILED REVISION_NOT_SEALED");
  assert.equal(asProblem(w, unsealed).current?.state, "DRAFT");
  const expiredProject = await w.project(w.A, w.clientA);
  const expiredRevision = await w.revision(w.A, expiredProject.projectId, "EXPIRED");
  const expiredTarget = await w.targetContract(w.A, expiredProject.projectId);
  await refused("expired revision", expiredRevision.revisionId, { targetContractId: expiredTarget.contractId }, {}, "422 SOURCE_EXPIRED -");
  const oldProject = await w.project(w.A, w.clientA);
  // sealed fifteen days ago, its UNPAID retention behind: since main's B06-R2 fixture change a SEALED revision is current by
  // default, so the lapsed one is asked for explicitly
  const oldRevision = await w.revision(w.A, oldProject.projectId, "SEALED", { recent: false });
  const oldTarget = await w.targetContract(w.A, oldProject.projectId);
  await refused("a revision sealed past its retention", oldRevision.revisionId, { targetContractId: oldTarget.contractId }, {}, "422 SOURCE_EXPIRED -");

  // a target contract that is not the project's current confirmed one: superseded, of another project, or unknown
  const staleProject = await w.project(w.A, w.clientA);
  const staleRevision = await w.revision(w.A, staleProject.projectId, "SEALED", { recent: true });
  const superseded = await w.targetContract(w.A, staleProject.projectId, { superseded: true });
  await refused("superseded target", staleRevision.revisionId, { targetContractId: superseded.contractId }, {}, "422 TARGET_STALE -");
  await refused("another project's target", staleRevision.revisionId, body, {}, "422 TARGET_STALE -");
  await refused("unknown target", staleRevision.revisionId, { targetContractId: "00000000-0000-4000-8000-000000000000" }, {}, "422 TARGET_STALE -");

  // the subject's audit is queued: an identical retry replays the 202 (nothing queued again), the same key with another target is a typed conflict
  const key = freshKey("cmd020-deny");
  const first = await startAudit(w, subject.revisionId, body, { key });
  const auditId = auditIdOf(first);
  const settled = await footprint(w);
  const replay = await startAudit(w, subject.revisionId, body, { key });
  assert.equal(replay.status, 202);
  assert.deepEqual(accepted(replay), accepted(first));
  assert.deepEqual(await footprint(w), settled, "a replay writes nothing");
  const conflicting = await startAudit(w, subject.revisionId, { targetContractId: superseded.contractId }, { key });
  assert.equal(outcome(w, conflicting), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.deepEqual(await footprint(w), settled);
  assert.deepEqual(await auditsOfAgency(w), [...earlier, auditId], "one audit more");

  // a second live audit of the agency (another subject, another key): the agency runs one at a time
  const other = await subjectOf(w);
  const limited = await refused("second live audit", other.revisionId, { targetContractId: other.contractId }, {}, "429 ADMISSION_LIMITED AUDIT_CONCURRENCY_LIMITED");
  assert.deepEqual(asProblem(w, limited).nextActions, [{ action: "RETRY_LATER" }]);

  // the first audit ended, the agency may audit again — but never the same subject twice: one audit per (revision, target contract) for good
  await endLiveAudits(w);
  assert.equal((await auditRow(w, auditId)).state, "CANCELLED");
  await refused("the same subject again", subject.revisionId, body, {}, "409 PRECONDITION_FAILED AUDIT_EXISTS");
  assert.equal(BigInt((await grantRow(w, poolId)).reserved_cents) % 150n, 0n, "every reservation is a whole audit grant");
  const next = await startAudit(w, other.revisionId, { targetContractId: other.contractId });
  assert.equal(next.status, 202, "another subject is served once the agency's live audit ended");

  // a crash before COMMIT leaves nothing: the audit, the AUDIT grant, the pool's reservation and the events were written and never committed;
  // the same key then queues the audit once
  await endLiveAudits(w);
  const crashing = await subjectOf(w);
  const crashKey = freshKey("cmd020-crash");
  const beforeCrash = await footprint(w);
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await startAudit(w, crashing.revisionId, { targetContractId: crashing.contractId }, { key: crashKey });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.deepEqual(await footprint(w), beforeCrash, "nothing left behind");
  assert.equal(await w.journal(crashKey), null);
  const retried = await startAudit(w, crashing.revisionId, { targetContractId: crashing.contractId }, { key: crashKey });
  assert.equal(accepted(retried).state, "QUEUED");
  assert.equal((await auditsOfAgency(w)).length, earlier.length + 3, "the retry queued the audit once");
  await endLiveAudits(w);

  // two StartAudit calls for the last free audit grant of the pool: the first is held before its journal commit with the pool row locked; the
  // second (another agency's) is observed waiting on that row, then reads what the first left — one QUEUED audit, one 429 NO_FUNDED_GRANT
  const race = await auditWorld();
  try {
    await activate(race.w, race.w.B);
    await fundPool(race, 150n);
    const one = await subjectOf(race.w);
    const two = await subjectOf(race.w, race.w.B);
    const hold = race.w.holds.arm("journal.commit");
    const winner = startAudit(race.w, one.revisionId, { targetContractId: one.contractId });
    let loser: ReturnType<typeof startAudit> | undefined;
    try {
      await reachedHold(hold, winner);
      loser = startAudit(race.w, two.revisionId, { targetContractId: two.contractId }, { token: race.w.stranger.token, agency: race.w.B.agencyId });
      await waitForApiLockWait(race.w, POOL_ROW_LOCK);
    } finally {
      hold.release();
    }
    const [won, lost] = await Promise.all([winner, loser as ReturnType<typeof startAudit>]);
    assert.equal(accepted(won).state, "QUEUED");
    assert.equal(outcome(race.w, lost), "429 BUDGET_EXHAUSTED NO_FUNDED_GRANT");
    assert.equal(await race.w.count("audits"), 1, "one audit");
    assert.equal(await race.w.count("audits", "agency_id = $1", [race.w.B.agencyId]), 0, "the loser's agency has none");
    assert.equal((await grantRow(race.w, race.poolId as string)).reserved_cents, "150", "one reservation");
    assert.equal(await race.w.count("cost_grants", "grant_kind = 'AUDIT'"), 1, "one AUDIT grant");
    await endLiveAudits(race.w);
  } finally {
    await race.stop();
  }
});
