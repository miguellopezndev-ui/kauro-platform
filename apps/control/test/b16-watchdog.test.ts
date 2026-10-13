// S063 (A job never reaches READY but keeps heartbeating -> an absolute deadline and a watchdog prevent indefinite work or retention):
// the job's 48 h delivery deadline (capture completion + 172,800 s, D8-RET-1) is absolute. A worker that heartbeats right up to it
// is not a reason to wait: the JOB_DEADLINES watchdog compares with the SERVER clock, never early, terminates the exact provider job,
// EXPIRES the job (a delivery deadline reached, never a delivery) and the PAID_ORDINARY retention record that governs its source is
// untouched by it (its hard deadline neither moves nor restarts): the retention clock runs on to deletion. Real PostgreSQL 17 through
// this package's own control plane; SIMULATED: the worker host, the Migration core and the object storage are the labelled contract
// fakes (B08-WORKER-HOST, B08-CORE-PORTS, B07-PROVIDER-FAKES); the control plane's TEST CLOCK is moved with the host's.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { admitted, launched, observedDone, startExecutionWorld, type ExecutionWorld } from "./support/execution-world.js";

let w: ExecutionWorld;
before(async () => {
  w = await startExecutionWorld("b16-watchdog");
});
after(async () => {
  await w.stop();
});

const DELIVERY_SECONDS = 172_800;
const LEASE_STEP = 120;

interface Governing {
  readonly retention_id: string;
  readonly version: string;
  readonly state: string;
  readonly soft_deadline: Date | null;
  readonly hard_deadline: Date;
  readonly effective_deadline: Date;
  readonly expired_at: Date | null;
}

async function governingRecord(revisionId: string): Promise<Governing> {
  const r = await w.h.oracle.query<Governing>(
    "SELECT retention_id, version::text, state, soft_deadline, hard_deadline, effective_deadline, expired_at FROM kauro.retention_records WHERE revision_id = $1 AND class = 'PAID_ORDINARY'",
    [revisionId],
  );
  assert.equal(r.rows.length, 1, "one PAID_ORDINARY record governs the purchased source");
  return r.rows[0]!;
}

test("S063: a job that heartbeats but never reaches READY is EXPIRED at its 48 h delivery deadline on the server clock and its terminal retention clock starts", async () => {
  const A = await w.agency("b16-s063");
  const p = await w.paid(A, "b16-s063");
  // the purchase's capture completed 47 h 35 m ago (fixture: the superuser moves the fact the delivery deadline is computed from, with
  // triggers off), so the job's 48 h delivery deadline is 25 minutes away, shorter than the 8 h execution wall its launch would give it
  const oracle = w.h.oracle;
  try {
    await oracle.query("SET session_replication_role = replica");
    const moved = await oracle.query("UPDATE kauro.capture_facts SET provider_completed_at = kauro.server_now() - make_interval(secs => $2) WHERE capture_id = $1", [p.captureId, DELIVERY_SECONDS - 1500]);
    assert.equal(moved.rowCount, 1);
  } finally {
    await oracle.query("RESET session_replication_role");
  }
  const { jobId, identity } = await admitted(w, p);
  const admittedJob = (await w.h.oracle.query<{ delivery_deadline_at: Date; server_now: Date }>("SELECT delivery_deadline_at, kauro.server_now() AS server_now FROM kauro.processing_jobs WHERE job_id = $1", [jobId])).rows[0]!;
  const record = await governingRecord(p.revisionId);
  // the retention clock is already running from the admission: a hard deadline, no soft deadline (nothing was published), and it is
  // 14 days from the capture while the delivery deadline is 2 days from it
  assert.equal(record.soft_deadline, null, "nothing was published: no soft deadline");
  assert.equal((record.hard_deadline.getTime() - admittedJob.delivery_deadline_at.getTime()) / 1000, 1_209_600 - DELIVERY_SECONDS, "hard = capture + 14 d, delivery = capture + 2 d");

  // the worker is launched at once, heartbeats (the host's observation start) and submits its manifest: the job is VERIFYING, live,
  // and no verification ever finishes it (JOB_EXECUTION's verify never runs here): it never reaches READY
  await launched(w, jobId);
  await observedDone(w, identity);
  assert.equal((await w.job(jobId)).state, "VERIFYING");
  assert.ok((await w.h.oracle.query("SELECT 1 FROM kauro.leases WHERE resource_kind = 'JOB_ATTEMPT' AND resource_id = $1", [jobId])).rowCount === 1, "its attempt holds the job's lease");
  const running = await w.h.oracle.query<{ execution_deadline_at: Date }>("SELECT execution_deadline_at FROM kauro.processing_jobs WHERE job_id = $1", [jobId]);
  assert.equal(running.rows[0]!.execution_deadline_at.getTime(), admittedJob.delivery_deadline_at.getTime(), "the 8 h execution wall is capped by the delivery deadline, 25 minutes away");

  // the clock walks to the deadline: no step expires it early and none lets it reach READY
  for (let i = 0; i < 10; i++) {
    w.advance(LEASE_STEP);
    const early = await w.x.sweepers.jobDeadlines.sweep(w.units, 20);
    assert.deepEqual([early.examined, early.acted], [0, 0], `step ${i}: never early`);
    assert.equal((await w.job(jobId)).state, "VERIFYING", `step ${i}: live, not READY`);
  }
  const nearly = await w.h.oracle.query<{ left: string }>("SELECT extract(epoch FROM (delivery_deadline_at - kauro.server_now()))::text AS left FROM kauro.processing_jobs WHERE job_id = $1", [jobId]);
  const left = Number(nearly.rows[0]!.left);
  assert.ok(left > 0, `the deadline is still ahead on the server clock (${left} s)`);

  // the deadline: the watchdog expires it on the server clock although its worker is alive
  w.advance(Math.ceil(left) + 5);
  const due = await w.x.sweepers.jobDeadlines.sweep(w.units, 20);
  assert.deepEqual([due.examined, due.acted, due.failed], [1, 1, []]);
  assert.deepEqual(w.host.calls("terminate").filter((c) => c.identity === identity).map((c) => c.outcome), ["ALREADY_TERMINAL"], "the exact provider job is the one asked to stop (its worker had already submitted and exited: nothing left to kill)");
  const job = await w.job(jobId);
  assert.deepEqual([job.state, job.terminal_reason, job.holds, job.published_package_id], ["EXPIRED", "DELIVERY_DEADLINE_REACHED", "NONE", null]);
  assert.deepEqual([(await w.attempt(jobId)).state, (await w.attempt(jobId)).terminal_cause], ["ABANDONED", "DELIVERY_DEADLINE_REACHED"]);
  const staged = await w.packages(jobId);
  assert.deepEqual(staged.map((s) => [s.state, s.revocation_reason, s.verification_id, s.delivery_manifest_hash]), [["REVOKED", "DELIVERY_DEADLINE_REACHED", null, null]], "what the worker staged is revoked, never verified, never delivered");
  assert.deepEqual(await w.capacity(A.agencyId), { active: 0, waiting: 0, live: 0 }, "its slots are released");
  assert.equal((await w.authorization(p.authorizationId)).state, "CONSUMED", "an expiry is never a delivery");
  assert.equal((await w.events(jobId)).at(-1)?.event_type, "processing_job.expired.v1");
  // a second sweep finds nothing: the job is terminal, the deadline is not restarted
  assert.deepEqual([(await w.x.sweepers.jobDeadlines.sweep(w.units, 20)).acted], [0]);

  // its terminal retention clock: the governing record is the very same record, ACTIVE, with the same hard deadline and no soft
  // deadline; the expiry neither extended nor restarted it, so the retention of the source ends on its original schedule
  const after = await governingRecord(p.revisionId);
  assert.deepEqual(
    [after.retention_id, after.state, after.soft_deadline, after.hard_deadline.getTime(), after.effective_deadline.getTime(), after.version],
    [record.retention_id, "ACTIVE", null, record.hard_deadline.getTime(), record.hard_deadline.getTime(), record.version],
  );
  await w.host.settled(identity);
  await w.quiesce();
});
