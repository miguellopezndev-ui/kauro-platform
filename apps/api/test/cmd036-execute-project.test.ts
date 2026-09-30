// CMD036 ExecuteProject through its route (package B08, mandate B08-COMMANDS-EXECUTION; docs/design/B08-audit-approval-jobs.md §4, §7, §12;
// docs/design/B08-case-map.md S055, R2-046, CMD036-OK, CMD036-DENY, CMD036-RACE): an OPERATOR of the agency binds a live commercial
// authorization to one QUEUED job in one unit of work on PostgreSQL 17 — the project row, then the authorization after its shared transition
// lock, then the prerequisites in the order of D8-LOCK-1, the agency's bound (D8-CAP-2), the job, its event and its outbox record. The purchases
// are B09's `paidPurchase` fixture over a plan approved through CMD025; the revocation is B09's own payment-service write; the control plane's
// steps between commands are written through the product's adapters (execution-support.ts). Nothing here reaches a provider.
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { toUtcInstant, type ProjectId } from "@kauro/domain";
import { endJob, waitForLockWait } from "@kauro/persistence/testing";
import { commerceEdition } from "../src/index.js";
import { accepted, paymentsWorld, subscribersOf, type PaymentsWorld } from "./commerce-support.js";
import {
  authorizationRow,
  cancel,
  endLiveJobs,
  execute,
  footprint,
  heldRevocation,
  jobEvents,
  jobIdOf,
  jobRow,
  jobsOfAuthorization,
  outboxRecord,
  queuedThroughRoute,
  remedyAgency,
  restrictAgency,
  revisionIdOf,
  revoke,
  supersedeTarget,
  suspendCapability,
  withdrawApproval,
  agencyLiveJobs,
} from "./execution-support.js";
import { LOCKS, revokeAdmission } from "./source-support.js";
import { SimulatedCrash, asProblem, freshKey, ids, outcome, rootCause, waitForApiLockWait } from "./support.js";
import { reachedHold } from "./writers.js";

let pw: PaymentsWorld;
before(async () => {
  pw = await paymentsWorld({ unbound: ["capacity"] });
});
after(async () => {
  await pw.stop();
});
// every live job is ended by the control plane after each case: the platform's slots and the agency's bound are free again
afterEach(async () => {
  await endLiveJobs(pw);
});

// the payment service's own pool of the harness (B09 fixtures: persistence testing harness `paymentPool`)
const PAYMENT_SERVICE_APPLICATION = "kauro-test-payment";
const REASON = "The client asked to hold the migration";

test("OK: ExecuteProject with a live commercial authorization whose source, plan, approval, target, capture, retention and capability bind consistently answers 202 with one QUEUED job, one processing_job.queued.v1 event and one outbox record to JOB_EXECUTION, the job bound exactly to the authorization's subject", async () => {
  const { w } = pw;
  const sale = await pw.paidProject("cmd036-ok");
  const key = freshKey("cmd036-ok");
  const reply = await execute(pw, sale, { key });
  const answer = accepted(reply);
  const jobId = answer.operationId;
  assert.deepEqual(answer, { kind: "ACCEPTED", operationId: jobId, state: "QUEUED", statusPath: `/api/v1/jobs/${jobId}`, pollAfterSeconds: 10 });

  // the job: QUEUED at version 1, holding the backlog, bound exactly to the authorization's subject — its purchase, plan, approval, source,
  // target, capability and the receipt of the plan's validation
  const job = await jobRow(pw, jobId);
  const authorization = await authorizationRow(pw, sale.authorizationId);
  assert.deepEqual([job.state, job.version, job.holds, job.attempt_count, job.fence], ["QUEUED", "1", "BACKLOG", 0, "0"]);
  assert.deepEqual([job.agency_id, job.project_id, job.authorization_id, job.capture_id], [w.A.agencyId, sale.projectId, sale.authorizationId, sale.captureId]);
  const subject = await w.h.oracle.query<Record<string, string>>(
    `SELECT a.plan_id, a.plan_hash, a.approval_id, a.approval_hash, a.revision_hash, a.target_contract_hash, a.capability_id, a.capability_version, a.mode,
            x.validation_receipt_hash, r.core_package_hash
       FROM kauro.commercial_authorizations a
       JOIN kauro.approvals x ON x.agency_id = a.agency_id AND x.approval_id = a.approval_id
       JOIN kauro.validation_receipts r ON r.agency_id = x.agency_id AND r.receipt_hash = x.validation_receipt_hash
      WHERE a.authorization_id = $1`,
    [sale.authorizationId],
  );
  const expected = subject.rows[0];
  assert.ok(expected !== undefined, "the authorization's subject is readable");
  assert.deepEqual(
    {
      plan_id: job.plan_id,
      plan_hash: job.plan_hash,
      approval_id: job.approval_id,
      approval_hash: job.approval_hash,
      revision_hash: job.revision_hash,
      target_contract_hash: job.target_contract_hash,
      capability_id: job.capability_id,
      capability_version: job.capability_version,
      mode: job.mode,
      validation_receipt_hash: job.validation_receipt_hash,
      core_package_hash: job.core_package_hash,
    },
    expected,
  );
  assert.equal(job.created_by_membership_id, w.memberships.operator);
  // ExecuteProject binds and does not consume: the authorization stays ACTIVE until the admission (D8-AUTH-1)
  assert.deepEqual([authorization.state, authorization.version, authorization.job_ref], ["ACTIVE", "1", null]);
  // the delivery deadline is the capture's completion plus 172,800 s, stamped by the database (D8-RET-1)
  const deadline = await w.h.oracle.query<{ seconds: string }>("SELECT extract(epoch FROM (j.delivery_deadline_at - c.provider_completed_at))::text AS seconds FROM kauro.processing_jobs j JOIN kauro.capture_facts c ON c.capture_id = j.capture_id WHERE j.job_id = $1", [jobId]);
  assert.equal(Number(deadline.rows[0]?.seconds), 172_800);

  // one event, one outbox record, to JOB_EXECUTION only; the journal names the job
  const events = await jobEvents(pw, jobId);
  assert.deepEqual(events.map((e) => [e.version, e.type, e.consumers]), [[1, "processing_job.queued.v1", ["JOB_EXECUTION"]]]);
  assert.deepEqual(events[0]?.payload, { jobId, agencyId: w.A.agencyId, projectId: sale.projectId, authorizationId: sale.authorizationId, inputBindingHash: job.input_binding_hash, state: "QUEUED" });
  const journal = await w.journal(key);
  assert.deepEqual([journal?.state, journal?.status, journal?.resourceKind, journal?.resourceId], ["COMMITTED", 202, "processing_job", jobId]);
  assert.equal(await agencyLiveJobs(pw), 1, "the agency's ledger counts the queued job");
  assert.deepEqual(await jobsOfAuthorization(pw, sale.authorizationId), [jobId]);
});

test("S055: the process dies after ExecuteProject commits and before any dispatch or answer — a retry with the same key replays the one job, a retry with another key answers the same job, and the undelivered outbox record is still due", async () => {
  const { w } = pw;
  const sale = await pw.paidProject("s055");
  const key = freshKey("s055");
  // the process dies after ExecuteProject committed and before the answer leaves: nothing was dispatched, nothing was answered
  w.holds.arm("after.commit", { fail: new SimulatedCrash("after COMMIT, before any dispatch or answer") });
  const lost = await execute(pw, sale, { key });
  assert.equal(outcome(w, lost), "500 INTERNAL_ERROR -");
  assert.equal(rootCause(w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true);

  // the job is durable and QUEUED with its event and its undelivered outbox record; the journal holds the 202 for the key
  const jobs = await jobsOfAuthorization(pw, sale.authorizationId);
  assert.equal(jobs.length, 1);
  const jobId = jobs[0] as string;
  const job = await jobRow(pw, jobId);
  assert.deepEqual([job.state, job.version, job.holds], ["QUEUED", "1", "BACKLOG"]);
  const journal = await w.journal(key);
  assert.deepEqual([journal?.state, journal?.status, journal?.resourceKind, journal?.resourceId], ["COMMITTED", 202, "processing_job", jobId]);
  const events = await w.events("processing_job", jobId);
  assert.deepEqual(events.map((e) => e.type), ["processing_job.queued.v1"]);
  const queuedEventId = events[0]?.eventId as string;
  const pending = await outboxRecord(pw, queuedEventId, "JOB_EXECUTION");
  assert.ok(pending !== null, "the outbox record exists");
  assert.deepEqual([pending.state, pending.attempts, pending.delivered_at], ["PENDING", 0, null]);
  assert.equal(pending.next_attempt_at.getTime() <= Date.now(), true, "the record is due: the dispatcher delivers it");

  // a retry with the same key replays the one job
  const replay = await execute(pw, sale, { key });
  assert.deepEqual(accepted(replay), { kind: "ACCEPTED", operationId: jobId, state: "QUEUED", statusPath: `/api/v1/jobs/${jobId}`, pollAfterSeconds: 10 });
  // a retry with another key answers the same job and creates no second
  const another = await execute(pw, sale, { key: freshKey("s055-another") });
  assert.equal(jobIdOf(another), jobId);
  assert.deepEqual(await jobsOfAuthorization(pw, sale.authorizationId), [jobId]);
  // the undelivered record is still due, untouched by the retries
  assert.deepEqual((await w.events("processing_job", jobId)).map((e) => e.type), ["processing_job.queued.v1"]);
  const still = await outboxRecord(pw, queuedEventId, "JOB_EXECUTION");
  assert.deepEqual([still?.state, still?.attempts, still?.delivered_at], ["PENDING", 0, null]);
});

test("R2-046: an agency's fourth ExecuteProject while three of its jobs are live is 503 CAPACITY_UNAVAILABLE EXECUTION_QUEUE_FULL with nothing written and its authorization ACTIVE, and DeliveryCapacityPort answers unavailable for that agency and available for another", async () => {
  const { w } = pw;
  // three live jobs of the agency, each queued through the route
  const live: string[] = [];
  for (const label of ["r2-046-one", "r2-046-two", "r2-046-three"]) live.push((await queuedThroughRoute(pw, label)).jobId);
  assert.equal(await agencyLiveJobs(pw), 3);

  // the fourth: 503 with a typed reason, nothing written, and its authorization is not spent
  const fourth = await pw.paidProject("r2-046-fourth");
  const before = await footprint(pw);
  const refused = await execute(pw, fourth);
  assert.equal(outcome(w, refused), "503 CAPACITY_UNAVAILABLE EXECUTION_QUEUE_FULL");
  assert.deepEqual(await footprint(pw), before, "no job, event, outbox record, journal entry or ledger movement");
  assert.deepEqual(await jobsOfAuthorization(pw, fourth.authorizationId), []);
  assert.deepEqual([(await authorizationRow(pw, fourth.authorizationId)).state, (await authorizationRow(pw, fourth.authorizationId)).job_ref], ["ACTIVE", null]);
  assert.equal(await agencyLiveJobs(pw), 3);

  // B09's DeliveryCapacityPort, bound by the edition over the same ledger: unavailable for this agency, available for another
  const capacity = commerceEdition().capacity;
  assert.ok(capacity !== null, "the edition binds the delivery capacity port (D8-XPKG-4)");
  assert.equal(capacity.binding, "PLATFORM");
  const answerFor = (agency: typeof w.A, projectId: string) =>
    w.h.commerce.run(w.h.tenant(agency.agencyId, agency.ownerUserId), (uow) => capacity.checkoutCapacity(uow, { agencyId: agency.agencyId, projectId: projectId as ProjectId, mode: "CLEAN", billableUnits: 40_000, at: toUtcInstant(Date.now()) }));
  assert.deepEqual(await answerFor(w.A, fourth.projectId), { available: false, reason: "ADMISSION_QUEUE_FULL" });
  const free = await answerFor(w.B, ids.next());
  assert.equal(free.available, true);
  assert.match(free.available ? free.evidenceHash : "", /^[0-9a-f]{64}$/);

  // a slot freed by the control plane makes the fourth executable again: the bound counts live jobs only
  await endJob(w.h, w.A, live[0] as string);
  assert.equal(await agencyLiveJobs(pw), 2);
  assert.equal((await answerFor(w.A, fourth.projectId)).available, true);
  const retried = await execute(pw, fourth);
  assert.equal(accepted(retried).state, "QUEUED");
  assert.equal(await agencyLiveJobs(pw), 3);
});

test("DENY: ExecuteProject for an authorization that already has a job answers that same job, even after the job was cancelled, and never creates a second one", async () => {
  const { w } = pw;
  const sale = await pw.paidProject("cmd036-duplicate");
  const first = await execute(pw, sale);
  const jobId = jobIdOf(first);
  // a second key while the job is queued: the same job, never a second
  const second = accepted(await execute(pw, sale, { key: freshKey("cmd036-duplicate-second") }));
  assert.deepEqual([second.operationId, second.state], [jobId, "QUEUED"]);

  // the job is cancelled through CMD037 and ended by the control plane: CANCELLED, terminal
  const cancelled = await cancel(pw, jobId, { expectedVersion: 1, reasonCode: REASON });
  assert.equal(cancelled.status, 200, cancelled.text);
  await endJob(w.h, w.A, jobId);
  assert.equal((await jobRow(pw, jobId)).state, "CANCELLED");

  // the authorization of a cancelled job still has its job: the same one is answered — it is not spent, not revived and not duplicated
  const before = await footprint(pw);
  const third = accepted(await execute(pw, sale, { key: freshKey("cmd036-duplicate-third") }));
  assert.deepEqual([third.operationId, third.state, third.statusPath], [jobId, "CANCELLED", `/api/v1/jobs/${jobId}`]);
  const after = await footprint(pw);
  assert.deepEqual({ ...after, command_journal: 0 }, { ...before, command_journal: 0 }, "no job, event or outbox record; only the journal entry of the answered key");
  assert.deepEqual(await jobsOfAuthorization(pw, sale.authorizationId), [jobId]);
  assert.equal((await jobRow(pw, jobId)).state, "CANCELLED");
});

test("RACE: an identical retry replays the 202, the same key with another authorization is 409 IDEMPOTENCY_CONFLICT, two keys for one authorization serialize on the project row with the wait observed and yield one job, and a crash before COMMIT leaves nothing", async () => {
  const { w } = pw;
  const sale = await pw.paidProject("cmd036-race-retry");
  const other = await pw.paidProject("cmd036-race-retry-other");
  const key = freshKey("cmd036-race");

  // an identical retry replays the journaled 202, byte for byte
  const first = await execute(pw, sale, { key });
  const jobId = jobIdOf(first);
  const replay = await execute(pw, sale, { key });
  assert.equal(replay.status, 202);
  assert.equal(replay.text, first.text);
  // the same key with another authorization is another request: a typed conflict with no effect
  const before = await footprint(pw);
  const conflicting = await execute(pw, sale, { key, authorizationId: other.authorizationId });
  assert.equal(outcome(w, conflicting), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.deepEqual(await footprint(pw), before);
  assert.deepEqual(await jobsOfAuthorization(pw, other.authorizationId), []);

  // two keys for one authorization: the first held before its journal commit with the project row locked; the second is observed waiting on
  // that row (FOR UPDATE), then answers the same job — one job row, one event
  const twin = await pw.paidProject("cmd036-race-twin");
  const hold = w.holds.arm("journal.commit");
  const firstKey = execute(pw, twin, { key: freshKey("cmd036-race-a") });
  let secondKey: ReturnType<typeof execute> | undefined;
  try {
    await reachedHold(hold, firstKey);
    secondKey = execute(pw, twin, { key: freshKey("cmd036-race-b") });
    await waitForApiLockWait(w, LOCKS.project);
  } finally {
    hold.release();
  }
  const [a, b] = await Promise.all([firstKey, secondKey as ReturnType<typeof execute>]);
  assert.equal(jobIdOf(a), jobIdOf(b));
  assert.deepEqual(await jobsOfAuthorization(pw, twin.authorizationId), [jobIdOf(a)]);
  assert.equal((await w.events("processing_job", jobIdOf(a))).length, 1);
  assert.equal(await agencyLiveJobs(pw), 2, "the winner's job and the first sale's; the loser wrote nothing");

  // a crash before COMMIT: the job, its event and the ledger movement were written and never committed; the same key then queues it once
  const crashing = await pw.paidProject("cmd036-race-crash");
  const crashKey = freshKey("cmd036-race-crash");
  const beforeCrash = await footprint(pw);
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await execute(pw, crashing, { key: crashKey });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.deepEqual(asProblem(w, crashed).nextActions, [{ action: "RETRY_SAME_KEY" }]);
  assert.deepEqual(await footprint(pw), beforeCrash, "nothing left behind");
  assert.deepEqual(await jobsOfAuthorization(pw, crashing.authorizationId), []);
  assert.equal(await w.journal(crashKey), null);
  const retried = accepted(await execute(pw, crashing, { key: crashKey }));
  assert.equal(retried.state, "QUEUED");
  assert.deepEqual(await jobsOfAuthorization(pw, crashing.authorizationId), [retried.operationId]);
  assert.equal(jobId.length > 0, true);
});

test("RACE: ExecuteProject racing the payment service's revocation of the authorization serializes on the authorization's transition lock in both interleavings — the command is refused AUTHORIZATION_REVOKED, or the job exists QUEUED and the revocation's event is routed to EXECUTION_CONTROL", async () => {
  const { w } = pw;
  // (a) the revocation first: the payment service holds the authorization's exclusive transition lock uncommitted; ExecuteProject is observed
  // waiting for it, reads the committed REVOKED authorization and is refused; no job exists
  const first = await pw.paidProject("cmd036-revocation-first");
  const revocation = heldRevocation(pw, first);
  const key = freshKey("cmd036-revocation-first");
  try {
    await revocation.written;
    const request = execute(pw, first, { key });
    try {
      await waitForApiLockWait(w, "kauro.await_transition");
    } finally {
      revocation.release();
    }
    await revocation.done;
    const refused = await request;
    assert.equal(outcome(w, refused), "409 PRECONDITION_FAILED AUTHORIZATION_REVOKED");
    assert.deepEqual(asProblem(w, refused).current, { version: 2, state: "REVOKED" });
  } finally {
    revocation.release();
  }
  assert.deepEqual(await jobsOfAuthorization(pw, first.authorizationId), []);
  assert.equal(await w.journal(key), null);
  assert.equal((await authorizationRow(pw, first.authorizationId)).state, "REVOKED");

  // (b) ExecuteProject first: held before its journal commit with the authorization's shared transition lock; the revocation is observed
  // waiting for it; the job commits QUEUED, the revocation commits after it, and its event is routed to EXECUTION_CONTROL, which reconciles the
  // job (cancels it or lets it end) under its own state machine
  const second = await pw.paidProject("cmd036-revocation-second");
  const hold = w.holds.arm("journal.commit");
  const request = execute(pw, second, { key: freshKey("cmd036-revocation-second") });
  let revoking: Promise<unknown> | undefined;
  try {
    await reachedHold(hold, request);
    revoking = revoke(pw, second);
    await waitForLockWait(w.h.oracle, PAYMENT_SERVICE_APPLICATION, "UPDATE kauro.commercial_authorizations AS t");
  } finally {
    hold.release();
  }
  const queued = accepted(await request);
  await revoking;
  assert.equal(queued.state, "QUEUED");
  const job = await jobRow(pw, queued.operationId);
  assert.deepEqual([job.state, job.authorization_id], ["QUEUED", second.authorizationId]);
  assert.equal((await authorizationRow(pw, second.authorizationId)).state, "REVOKED");
  const revoked = await w.h.oracle.query<{ event_id: string }>("SELECT event_id FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'commercial_authorization.revoked.v1'", [second.authorizationId]);
  assert.equal(revoked.rows.length, 1);
  assert.deepEqual([...(await w.outbox(revoked.rows[0]?.event_id as string))].sort(), subscribersOf("commercial_authorization.revoked.v1"));
  assert.equal(subscribersOf("commercial_authorization.revoked.v1").includes("EXECUTION_CONTROL"), true);
  // a later ExecuteProject for the revoked authorization answers its job (D8-JOB-1): the job exists and the control plane owns what follows
  const again = accepted(await execute(pw, second, { key: freshKey("cmd036-revocation-again") }));
  assert.equal(again.operationId, queued.operationId);
});

// the last case of the file: it suspends the platform's CLEAN capability, which no later case can undo
test("DENY: a VIEWER or an APPROVER is 403 ROLE_INSUFFICIENT and another agency's project 404; then one missing prerequisite at a time — a revoked authorization, a withdrawn approval, an expired source, a superseded target, a suspended capability, an agency not ACTIVE — is refused with its reason, nothing written and no outbox record", async () => {
  const { w } = pw;
  const sale = await pw.paidProject("cmd036-deny");
  // a refusal writes nothing: no job, event, outbox record, journal entry or ledger movement, and its authorization keeps its state
  const refused = async (what: string, subject: typeof sale, options: Parameters<typeof execute>[2], expected: string): Promise<Awaited<ReturnType<typeof execute>>> => {
    const state = (await authorizationRow(pw, subject.authorizationId)).state;
    const before = await footprint(pw);
    const reply = await execute(pw, subject, options);
    assert.equal(outcome(w, reply), expected, what);
    assert.deepEqual(await footprint(pw), before, `${what}: nothing written`);
    assert.deepEqual(await jobsOfAuthorization(pw, subject.authorizationId), [], `${what}: no job`);
    assert.equal((await authorizationRow(pw, subject.authorizationId)).state, state, `${what}: the authorization is untouched`);
    return reply;
  };

  // roles: an OPERATOR-level command (OWNER, ADMIN, OPERATOR); a VIEWER, an APPROVER and a BILLING member are refused before any read
  const denied = (await w.securityEvents("CMD036")).length;
  await refused("viewer", sale, { token: w.viewer.token }, "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  await refused("approver", sale, { token: w.approver.token }, "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  await refused("billing", sale, { token: w.billing.token }, "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.deepEqual((await w.securityEvents("CMD036")).slice(denied).map((f) => [f.outcome, f.reason, f.agencyId]), [
    ["DENY", "ROLE_INSUFFICIENT", w.A.agencyId],
    ["DENY", "ROLE_INSUFFICIENT", w.A.agencyId],
    ["DENY", "ROLE_INSUFFICIENT", w.A.agencyId],
  ]);
  // another agency's project is 404, the answer of a project that never existed
  const foreign = await refused("foreign project", sale, { token: w.stranger.token, agency: w.B.agencyId }, "404 NOT_FOUND -");
  const unknown = await execute(pw, { projectId: ids.next(), authorizationId: sale.authorizationId }, { token: w.stranger.token, agency: w.B.agencyId });
  assert.deepEqual({ ...asProblem(w, foreign), correlationId: "" }, { ...asProblem(w, unknown), correlationId: "" }, "a foreign and a nonexistent project answer alike");
  // an authorization of another project of the agency is not visible through this project's path
  const sibling = await pw.paidProject("cmd036-deny-sibling");
  await refused("an authorization of another project", sale, { authorizationId: sibling.authorizationId }, "404 NOT_FOUND -");

  // one missing prerequisite at a time, each on a purchase of its own: the reason, and nothing written
  const revoked = await pw.paidProject("cmd036-deny-revoked");
  await revoke(pw, revoked);
  const revokedReply = await refused("a revoked authorization", revoked, {}, "409 PRECONDITION_FAILED AUTHORIZATION_REVOKED");
  assert.deepEqual(asProblem(w, revokedReply).current, { version: 2, state: "REVOKED" });

  const withdrawn = await pw.paidProject("cmd036-deny-withdrawn");
  const withdrawal = await withdrawApproval(pw, withdrawn);
  assert.equal(withdrawal.status, 200, withdrawal.text);
  await refused("a withdrawn approval", withdrawn, {}, "409 PRECONDITION_FAILED PLAN_NOT_APPROVED");

  const expired = await pw.paidProject("cmd036-deny-expired");
  await w.h.expireRevision(w.A, expired.projectId as ProjectId, (await revisionIdOf(pw, expired)) as never, new Date(Date.now() + 400 * 86_400_000));
  await refused("an expired source", expired, {}, "422 SOURCE_EXPIRED -");

  const superseded = await pw.paidProject("cmd036-deny-superseded");
  await supersedeTarget(pw, superseded);
  await refused("a superseded target", superseded, {}, "422 TARGET_STALE -");

  // an agency that is not ACTIVE: refused while RESTRICTED, and the same purchase executes once the restriction is remedied
  const restricted = await pw.paidProject("cmd036-deny-restricted");
  await restrictAgency(pw);
  try {
    const reply = await refused("an agency not ACTIVE", restricted, {}, "409 PRECONDITION_FAILED AGENCY_NOT_ACTIVE");
    assert.equal(asProblem(w, reply).current?.state, "RESTRICTED");
  } finally {
    await remedyAgency(pw);
  }
  assert.equal(accepted(await execute(pw, restricted)).state, "QUEUED", "the refusal was the agency's state alone");

  // the capability the project runs on suspended by the control plane: the mode is no longer offered
  const suspended = await pw.paidProject("cmd036-deny-suspended");
  await suspendCapability(pw);
  await refused("a suspended capability", suspended, {}, "422 CAPABILITY_UNAVAILABLE MODE_NOT_OFFERED");
});

test("B08-R1 (CMD036-DENY): an INCLUDED sealed file of the authorization's revision whose admission OBJECT_INVENTORY revoked (GENERATION_CHANGED) — the revision itself still SEALED and the event not yet read by EXECUTION_CONTROL — refuses ExecuteProject 422 SOURCE_EXPIRED with nothing written, while a neighbour purchase whose files are admitted executes", async () => {
  const { w } = pw;
  const sale = await pw.paidProject("cmd036-b08r1");
  const revisionId = await revisionIdOf(pw, sale);
  const [file] = (await w.h.oracle.query<{ file_id: string }>("SELECT file_id FROM kauro.sealed_revision_files WHERE revision_id = $1 AND disposition = 'INCLUDED' ORDER BY ordinal LIMIT 1", [revisionId])).rows;
  assert.ok(file, "the revision seals an included file");
  await revokeAdmission(w, w.A.agencyId, file.file_id, "GENERATION_CHANGED");
  assert.equal((await w.h.oracle.query<{ state: string }>("SELECT state FROM kauro.dataset_revisions WHERE revision_id = $1", [revisionId])).rows[0]?.state, "SEALED");
  const before = await footprint(pw);
  const reply = await execute(pw, sale);
  assert.equal(outcome(w, reply), "422 SOURCE_EXPIRED -");
  assert.deepEqual(await footprint(pw), before, "nothing written");
  assert.deepEqual(await jobsOfAuthorization(pw, sale.authorizationId), [], "no job");
  assert.equal((await authorizationRow(pw, sale.authorizationId)).state, "ACTIVE", "the authorization is untouched");

  const neighbour = await pw.paidProject("cmd036-b08r1-neighbour");
  assert.equal(accepted(await execute(pw, neighbour)).state, "QUEUED", "the refusal was the revoked file alone");
});
