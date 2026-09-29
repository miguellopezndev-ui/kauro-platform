// JOB_ADMISSION (package B08, mandate B08-CONTROL-EXECUTION; docs/design/B08-audit-approval-jobs.md §4.2, D8-SCHED-1, D8-LOCK-1,
// D8-AUTH-1, D8-RET-1, D8-ATT-1, D8-STALE-1, D8-CANCEL-2; cases R2-046, CMD036-OK, CMD036-DENY) on a real PostgreSQL 17 through this
// package's own control plane (kauro_control_test, SYSTEM units of work bound to each job's agency). Paid purchases are B09's own
// entitlements; CMD036 is the request handlers' write through the execution store (the route is B08-COMMANDS-EXECUTION's). The worker
// host, the cores and the object storage are the labelled contract fakes of their owners (SIMULATED), used here only to launch the
// first admitted job. Interleavings are a hold inside a unit of work and the lock waits pg_stat_activity shows; the superuser is the
// oracle only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { barrier } from "@kauro/persistence/testing";
import { heldUnits, startExecutionWorld, type ExecutionWorld } from "./support/execution-world.js";

let w: ExecutionWorld;

before(async () => {
  w = await startExecutionWorld("admission");
});

after(async () => {
  await w.stop();
});

const LEDGER_LOCK = "FROM kauro.execution_capacity WHERE ledger_id = 1 FOR UPDATE";

async function admittedAt(jobId: string): Promise<number> {
  const r = await w.h.oracle.query<{ at: string }>("SELECT to_char(admitted_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS') AS at FROM kauro.processing_jobs WHERE job_id = $1", [jobId]);
  return Number(r.rows[0]?.at ?? Number.NaN);
}

test("R2-046: one agency's three paid-ready jobs and another agency's waiting job are admitted in the documented fair order — the waiting agency second, never last — within one ACTIVE and three WAITING slots, and admissions from two schedulers serialize on the global ledger", async () => {
  const A = await w.agency("fair-busy");
  const B = await w.agency("fair-waiting");
  const [a1, a2, a3] = [await w.paid(A, "fair-a1"), await w.paid(A, "fair-a2"), await w.paid(A, "fair-a3")];
  const b1 = await w.paid(B, "fair-b1");
  // CMD036 queues agency A's three jobs first; agency B's one job waits behind them in queue order
  const jobA1 = await w.queue(a1);
  const jobA2 = await w.queue(a2);
  const jobA3 = await w.queue(a3);
  const jobB1 = await w.queue(b1);
  assert.deepEqual(await w.capacity(), { active: 0, waiting: 0, live: 0 });

  // two schedulers: another control-plane process whose admission unit holds right after it locked the global ledger ...
  const held = heldUnits(w.units, "lockGlobalLedger");
  const other = w.planeWith({ units: held.units }).execution;
  assert.ok(other !== null);
  const first = other.sweepers.jobAdmission.admitRound();
  await held.hold.reached;
  // ... and this one, whose admission blocks on the ledger's row lock: the wait is observed in pg_stat_activity, never slept on
  const second = w.x.sweepers.jobAdmission.admitRound();
  try {
    await w.lockWait(LEDGER_LOCK);
  } finally {
    held.hold.release();
  }
  const rounds = await Promise.all([first, second]);
  const admittedJobs = rounds.flatMap((r) => r.admitted);
  assert.equal(new Set(admittedJobs).size, admittedJobs.length, "no job was admitted twice");

  // three WAITING slots: A1, then B1 — the agency that holds nothing goes before A's second job — then A2; A3 stays QUEUED
  assert.deepEqual(await w.capacity(), { active: 0, waiting: 3, live: 0 });
  assert.deepEqual([(await w.job(jobA1.jobId)).state, (await w.job(jobB1.jobId)).state, (await w.job(jobA2.jobId)).state, (await w.job(jobA3.jobId)).state], ["ADMITTED", "ADMITTED", "ADMITTED", "QUEUED"]);
  assert.deepEqual(
    [...admittedJobs].sort((x, y) => x.localeCompare(y)),
    [jobA1.jobId, jobA2.jobId, jobB1.jobId].sort((x, y) => x.localeCompare(y)),
  );
  const order1 = [await admittedAt(jobA1.jobId), await admittedAt(jobB1.jobId), await admittedAt(jobA2.jobId)];
  assert.ok(order1[0] < order1[1] && order1[1] < order1[2], `admitted A1 < B1 < A2: ${order1.join(" ")}`);
  assert.equal((await w.capacity(A.agencyId)).live, 3, "agency A holds its three live jobs");
  assert.equal((await w.capacity(B.agencyId)).live, 1);

  // the ACTIVE slot goes to the first admitted job (launch order: admitted_at, job id), which frees one WAITING slot ...
  const launched = await w.x.pipeline.launchNext();
  assert.equal(launched.kind, "APPLIED", JSON.stringify(launched));
  assert.equal((await w.job(jobA1.jobId)).holds, "ACTIVE");
  assert.deepEqual(await w.capacity(), { active: 1, waiting: 2, live: 0 });
  // ... and the next round admits the fourth job, last in the fair order; nothing is ever beyond one ACTIVE and three WAITING
  const third = await w.x.sweepers.jobAdmission.admitRound();
  assert.deepEqual(third.admitted, [jobA3.jobId]);
  assert.deepEqual(await w.capacity(), { active: 1, waiting: 3, live: 0 });
  const order = [await admittedAt(jobA1.jobId), await admittedAt(jobB1.jobId), await admittedAt(jobA2.jobId), await admittedAt(jobA3.jobId)];
  assert.ok(order[0] < order[1] && order[1] < order[2] && order[2] < order[3], `the fair order A1, B1, A2, A3: ${order.join(" ")}`);
  const nothing = await w.x.sweepers.jobAdmission.admitRound();
  assert.deepEqual(nothing.admitted, [], "no slot is left: nothing more is admitted");

  await w.quiesce();
});

test("admission consumes the entitlement: QUEUED -> ADMITTED with the authorization ACTIVE -> CONSUMED naming the job, attempt 1 CLAIMED at lease fence 1 and the PAID_ORDINARY record anchored on the capture, in one unit of work", async () => {
  const p = await w.paid(w.A, "consume");
  const job = await w.queue(p);
  assert.equal((await w.authorization(p.authorizationId)).state, "ACTIVE", "CMD036 binds the entitlement but does not consume it (D8-AUTH-1)");

  const round = await w.x.sweepers.jobAdmission.admitRound();
  assert.deepEqual(round.admitted, [job.jobId]);

  const row = await w.job(job.jobId);
  assert.deepEqual([row.state, row.holds, row.version, row.attempt_count, row.fence], ["ADMITTED", "WAITING", "2", 1, "1"]);
  const attempts = await w.attempts(job.jobId);
  assert.equal(attempts.length, 1);
  const attempt = attempts[0]!;
  assert.deepEqual([attempt.ordinal, attempt.state, attempt.fence, attempt.launch_state], [1, "CLAIMED", "1", "NOT_LAUNCHED"]);
  assert.equal(attempt.identity, `kauro-attempt-${attempt.attempt_id}`);
  assert.equal(row.current_attempt_id, attempt.attempt_id);

  // the JOB_ATTEMPT lease: owner the attempt, fence 1, subject the input binding, cost authority the entitlement (D8-ATT-1)
  const lease = (
    await w.h.oracle.query<{ owner_id: string; fence: string; subject_hash: string; cost_authority_id: string; deadline_at: Date }>(
      "SELECT owner_id, fence::text AS fence, subject_hash, cost_authority_id, deadline_at FROM kauro.leases WHERE resource_kind = 'JOB_ATTEMPT' AND resource_id = $1",
      [job.jobId],
    )
  ).rows[0];
  assert.ok(lease);
  assert.deepEqual([lease.owner_id, lease.fence, lease.subject_hash, lease.cost_authority_id], [attempt.attempt_id, "1", job.inputBindingHash, p.authorizationId]);

  // the entitlement consumed by exactly this job, at the admission's instant
  const authorization = await w.authorization(p.authorizationId);
  assert.deepEqual([authorization.state, authorization.job_ref], ["CONSUMED", job.jobId]);
  assert.equal(authorization.consumed_at?.getTime(), row.admitted_at?.getTime());

  // the PAID_ORDINARY record anchored on the admission: hard deadline the capture's completion + 14 days (D8-RET-1, D8-XPKG-5)
  const retention = (
    await w.h.oracle.query<{ retention_id: string; class: string; state: string; created_at: Date; hard_deadline: Date; anchor_kind: string; occurred_at: Date; completed: Date }>(
      `SELECT r.retention_id, r.class, r.state, r.created_at, r.hard_deadline, a.anchor_kind, a.occurred_at, c.provider_completed_at AS completed
         FROM kauro.retention_records r JOIN kauro.retention_anchors a ON a.anchor_id = r.anchor_id
         JOIN kauro.capture_facts c ON c.capture_id = $2
        WHERE r.revision_id = $1 AND r.class = 'PAID_ORDINARY'`,
      [p.revisionId, p.captureId],
    )
  ).rows[0];
  assert.ok(retention, "the PAID_ORDINARY record of the revision");
  assert.deepEqual([retention.state, retention.anchor_kind], ["ACTIVE", "EXECUTION_ADMITTED"]);
  assert.equal(retention.hard_deadline.getTime(), retention.completed.getTime() + 1_209_600_000);

  // one unit of work: every row carries that transaction's instant, and the three events share its correlation
  const at = row.admitted_at?.getTime();
  assert.ok(at !== undefined);
  assert.deepEqual([attempt.claimed_at?.getTime(), retention.occurred_at.getTime(), retention.created_at.getTime()], [at, at, at]);
  const jobEvents = await w.events(job.jobId);
  const admittedEvent = jobEvents.find((e) => e.event_type === "processing_job.admitted.v1");
  const consumedEvent = (await w.events(p.authorizationId)).find((e) => e.event_type === "commercial_authorization.consumed.v1");
  const createdEvent = (await w.events(retention.retention_id)).find((e) => e.event_type === "retention_record.created.v1");
  assert.ok(admittedEvent && consumedEvent && createdEvent);
  assert.equal(new Set([admittedEvent.correlation_id, consumedEvent.correlation_id, createdEvent.correlation_id]).size, 1, "one unit of work");
  for (const e of [admittedEvent, consumedEvent, createdEvent]) assert.deepEqual([e.actor_kind, e.actor_id], ["SERVICE", "job-admission"]);
  assert.deepEqual([admittedEvent.payload["attemptId"], admittedEvent.payload["fence"]], [attempt.attempt_id, 1]);

  // a second round admits nothing and consumes nothing twice
  const again = await w.x.sweepers.jobAdmission.admitRound();
  assert.deepEqual(again.admitted, []);
  assert.equal((await w.attempts(job.jobId)).length, 1);
  assert.equal((await w.events(p.authorizationId)).filter((e) => e.event_type === "commercial_authorization.consumed.v1").length, 1);

  await w.quiesce();
});

test("admission re-reads the authority after the transition locks: a job whose authorization was revoked, whose approval was withdrawn or whose source expired while QUEUED is cancelled with its reason and consumes nothing", async () => {
  const A = await w.agency("reread");
  const C = await w.agency("reread-in-flight");
  const revoked = await w.paid(A, "reread-revoked");
  const withdrawn = await w.paid(A, "reread-withdrawn");
  const expired = await w.paid(A, "reread-expired");
  const inFlight = await w.paid(C, "reread-in-flight");
  const neighbour = await w.paid(C, "reread-neighbour");
  const jobs = {
    revoked: (await w.queue(revoked)).jobId,
    withdrawn: (await w.queue(withdrawn)).jobId,
    expired: (await w.queue(expired)).jobId,
    inFlight: (await w.queue(inFlight)).jobId,
    neighbour: (await w.queue(neighbour)).jobId,
  };

  // the facts are lost while the jobs are QUEUED: B09's revocation by the payment service, CMD026's withdrawal of the approval, the
  // retention sweeper's expiry of the source
  await w.revoke(revoked);
  await w.withdrawApproval(withdrawn);
  await w.expireSource(expired);

  // a revocation in flight holds its entitlement's transition lock: the round defers that job and never waits under the ledger
  const gate = barrier();
  let locked: () => void = () => undefined;
  const lockedNow = new Promise<void>((resolve) => (locked = resolve));
  const revocation = w.revoke(inFlight, gate.wait, locked);
  await lockedNow;
  const round = await w.withoutWaiting(w.x.sweepers.jobAdmission.admitRound(), "the admission round").finally(() => gate.open());
  await revocation;

  assert.deepEqual(round.deferred, [jobs.inFlight], "the job whose entitlement was in transition waits for the next round");
  assert.deepEqual(round.admitted, [jobs.neighbour], "the valid neighbour is admitted");
  for (const [key, reason] of [["revoked", "AUTHORIZATION_REVOKED"], ["withdrawn", "APPROVAL_WITHDRAWN"], ["expired", "SOURCE_EXPIRED"]] as const) {
    const row = await w.job(jobs[key]);
    assert.deepEqual([row.state, row.holds, row.cancel_reason_code, row.cancel_actor_kind, row.cancel_actor_id, row.attempt_count], ["CANCELLED", "NONE", reason, "SERVICE", "job-admission", 0], key);
    assert.deepEqual((await w.events(jobs[key])).map((e) => e.event_type), ["processing_job.queued.v1", "processing_job.cancel_requested.v1", "processing_job.cancelled.v1"], key);
    assert.deepEqual(round.cancelled.find((c) => c.jobId === jobs[key])?.reason, reason);
  }
  assert.equal((await w.job(jobs.inFlight)).state, "QUEUED");
  // nothing was consumed: the revoked entitlement stays REVOKED, the others stay ACTIVE, and no attempt, anchor or record exists
  assert.equal((await w.authorization(revoked.authorizationId)).state, "REVOKED");
  assert.equal((await w.authorization(withdrawn.authorizationId)).state, "ACTIVE");
  assert.equal((await w.authorization(expired.authorizationId)).state, "ACTIVE");
  for (const p of [revoked, withdrawn, expired]) {
    const kept = await w.h.oracle.query("SELECT 1 FROM kauro.retention_records WHERE revision_id = $1 AND class = 'PAID_ORDINARY'", [p.revisionId]);
    assert.equal(kept.rowCount, 0, "no PAID_ORDINARY record for a job that was never admitted");
  }
  assert.equal((await w.capacity(A.agencyId)).live, 0, "the cancelled jobs released their agency's slots");

  // once the revocation committed, the next round reads it after the lock and cancels that job too
  const next = await w.x.sweepers.jobAdmission.admitRound();
  assert.deepEqual(next.cancelled, [{ jobId: jobs.inFlight, reason: "AUTHORIZATION_REVOKED" }]);
  const row = await w.job(jobs.inFlight);
  assert.deepEqual([row.state, row.cancel_reason_code], ["CANCELLED", "AUTHORIZATION_REVOKED"]);
  assert.deepEqual([(await w.authorization(inFlight.authorizationId)).state, (await w.authorization(neighbour.authorizationId)).state], ["REVOKED", "CONSUMED"]);

  await w.quiesce();
});
