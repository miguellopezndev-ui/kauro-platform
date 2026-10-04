// The execution control plane's outbox work (package B08, mandate B08-CONTROL-EXECUTION; docs/design/B08-audit-approval-jobs.md §6,
// §7, §11, D8-CANCEL-1, D8-CANCEL-2, D8-DUP-1, D8-HOST-1; cases S055, CMD037-OK, CMD037-DENY, CMD037-RACE) on a real PostgreSQL 17:
// B07's dispatcher delivering JOB_EXECUTION and EXECUTION_CONTROL records, at least once, to this package's consumers (SYSTEM units
// bound to each event's agency). CMD037 is the request handlers' write through the execution store (the route is
// B08-COMMANDS-EXECUTION's). SIMULATED: the worker host, the Migration core and the object storage are the labelled contract fakes of
// their single owners; the uncertain termination and the live old worker are the host fake's own scripts. Interleavings are the
// fakes' hold points; a redelivery is the dispatcher's own claim expiring or the same event handed to the consumer again. The
// superuser is the oracle only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readStagedManifest } from "@kauro/application";
import { toUtcInstant, type CorrelationId, type ProcessingAttemptId, type ProcessingJobId } from "@kauro/domain";
import { admitted, ids, launched, startExecutionWorld, verifiedPrivate, type ExecutionWorld } from "./support/execution-world.js";

let w: ExecutionWorld;

before(async () => {
  w = await startExecutionWorld("control");
});

after(async () => {
  await w.stop();
});

function later(seconds: number) {
  return toUtcInstant(Date.parse(w.now()) + seconds * 1000);
}

async function outboxOf(eventId: string, consumer: string): Promise<{ state: string; attempts: number }> {
  const r = await w.h.oracle.query<{ state: string; attempts: number }>("SELECT state, attempts FROM kauro.outbox_records WHERE event_id = $1 AND consumer = $2", [eventId, consumer]);
  const row = r.rows[0];
  assert.ok(row, `the ${consumer} record of event ${eventId}`);
  return row;
}

async function leaseCancelVersion(jobId: string): Promise<string> {
  const r = await w.h.oracle.query<{ v: string }>("SELECT cancel_version::text AS v FROM kauro.leases WHERE resource_kind = 'JOB_ATTEMPT' AND resource_id = $1", [jobId]);
  return r.rows[0]?.v ?? "none";
}

function terminations(identity: string): string[] {
  return w.host.calls("terminate").filter((c) => c.identity === identity).map((c) => c.outcome);
}

test("S055: after a restart the dispatcher delivers the queued job's outbox record once and JOB_ADMISSION admits it once; a second delivery of the same record admits nothing and creates no second attempt", async () => {
  const p = await w.paid(await w.agency("s055"), "s055");
  const job = await w.queue(p);
  const queued = await w.eventOf(job.jobId, "processing_job.queued.v1");
  assert.deepEqual(await outboxOf(queued.eventId, "JOB_EXECUTION"), { state: "PENDING", attempts: 0 }, "CMD036 committed the job with its outbox record");

  // a dispatcher claims the record and the process dies before it handles it: the claim stands, nothing was admitted
  const dying = await w.units.runSource({ kind: "SYSTEM", serviceId: "outbox-dispatcher", correlationId: ids.next() as CorrelationId }, (uow) => uow.outboxDispatch.claim("JOB_EXECUTION", 100, w.now(), 60));
  assert.ok(dying.some((d) => d.event.eventId === queued.eventId), "the dying dispatcher held the record");
  assert.deepEqual(await outboxOf(queued.eventId, "JOB_EXECUTION"), { state: "CLAIMED", attempts: 1 });
  assert.equal((await w.job(job.jobId)).state, "QUEUED");

  // after the restart: another control-plane process takes the expired claim and delivers the record, once; JOB_ADMISSION admits
  const restarted = w.planeWith({}).execution;
  assert.ok(restarted !== null);
  await w.plane.drain(restarted.consumers.jobExecution, later(61));
  assert.deepEqual(await outboxOf(queued.eventId, "JOB_EXECUTION"), { state: "DELIVERED", attempts: 2 });
  const admittedJob = await w.job(job.jobId);
  assert.ok(["ADMITTED", "RUNNING"].includes(admittedJob.state), admittedJob.state);
  assert.equal((await w.attempts(job.jobId)).length, 1);
  assert.deepEqual([(await w.authorization(p.authorizationId)).state, (await w.authorization(p.authorizationId)).job_ref], ["CONSUMED", job.jobId]);
  const consumptions = async () => (await w.events(p.authorizationId)).filter((e) => e.event_type === "commercial_authorization.consumed.v1").length;
  const admissions = async () => (await w.events(job.jobId)).filter((e) => e.event_type === "processing_job.admitted.v1").length;
  assert.deepEqual([await consumptions(), await admissions()], [1, 1]);

  // a second delivery of the same record (at least once): the job is no longer QUEUED, so nothing is admitted or created
  const version = (await w.job(job.jobId)).version;
  assert.deepEqual(await w.redeliver(restarted.consumers.jobExecution, queued), { kind: "DONE" });
  assert.equal((await w.attempts(job.jobId)).length, 1, "no second attempt");
  assert.deepEqual([await consumptions(), await admissions()], [1, 1], "one consumption of the entitlement");
  assert.equal((await w.job(job.jobId)).version, version);
  await w.quiesce();
});

test("CMD037-OK continuation: EXECUTION_CONTROL advances the lease's cancellation version, terminates exactly the attempt's provider job, observes it terminal, revokes the private package and moves the job CANCEL_REQUESTED -> CANCELLED, releasing its capacity once", async () => {
  const A = await w.agency("cmd037-ok");

  // a RUNNING job whose worker is live, held before its manifest
  const p1 = await w.paid(A, "cmd037-ok-running");
  const running = await admitted(w, p1);
  const beforeManifest = w.host.holdNext("manifest", running.identity);
  await launched(w, running.jobId);
  await beforeManifest.reached;
  await w.x.sweepers.attemptMonitor.sweep(w.units, 20);
  assert.equal((await w.job(running.jobId)).state, "RUNNING");
  assert.deepEqual(await w.capacity(A.agencyId), { active: 1, waiting: 0, live: 1 });
  const cancelled = await w.cancel(p1, running.jobId);
  assert.deepEqual([cancelled.state, cancelled.cancelVersion, cancelled.holds], ["CANCEL_REQUESTED", 1, "ACTIVE"], "CMD037 advances the job's cancellation; the slot is kept until reconciled");
  assert.equal(await leaseCancelVersion(running.jobId), "0");

  await w.drain(w.x.consumers.executionControl);
  assert.equal(await leaseCancelVersion(running.jobId), "1", "the cancellation version mirrored into the lease");
  assert.deepEqual(terminations(running.identity), ["TERMINATED"], "exactly the attempt's provider job, once");
  const afterTerminate = w.host.calls().filter((c) => c.identity === running.identity);
  const terminateAt = afterTerminate.findIndex((c) => c.operation === "terminate");
  assert.ok(afterTerminate.slice(terminateAt + 1).some((c) => c.operation === "observe" && c.outcome === "TERMINATED"), "observed terminal after the termination");
  const attempt = await w.attempt(running.jobId);
  assert.deepEqual([attempt.state, attempt.terminal_cause], ["ABANDONED", "CANCELLED"]);
  const job1 = await w.job(running.jobId);
  assert.deepEqual([job1.state, job1.holds], ["CANCELLED", "NONE"]);
  assert.deepEqual(await w.capacity(A.agencyId), { active: 0, waiting: 0, live: 0 }, "its slots released");
  await w.host.settled(running.identity);

  // a VERIFYING job with its private package: the provider job already ended, the package is revoked, its evidence kept
  const p2 = await w.paid(A, "cmd037-ok-package");
  const verifying = await verifiedPrivate(w, p2);
  await w.cancel(p2, verifying.jobId);
  await w.drain(w.x.consumers.executionControl);
  assert.deepEqual(terminations(verifying.identity), ["ALREADY_TERMINAL"]);
  const [pkg] = await w.packages(verifying.jobId);
  assert.deepEqual([pkg?.state, pkg?.revocation_reason], ["REVOKED", "JOB_CANCELLED"]);
  assert.deepEqual([(await w.attempt(verifying.jobId)).state, (await w.job(verifying.jobId)).state], ["ABANDONED", "CANCELLED"]);
  assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.package_verifications WHERE package_version_id = $1 AND result = 'VALID'", [pkg!.package_version_id])).rowCount, 1);
  const released = await w.capacity(A.agencyId);
  assert.deepEqual(released, { active: 0, waiting: 0, live: 0 });

  // a second delivery of the cancellation releases nothing twice and terminates nothing again
  const version = (await w.job(verifying.jobId)).version;
  const event = await w.eventOf(verifying.jobId, "processing_job.cancel_requested.v1");
  assert.deepEqual(await w.redeliver(w.x.consumers.executionControl, event), { kind: "DONE" });
  assert.deepEqual(await w.capacity(A.agencyId), released);
  assert.equal((await w.job(verifying.jobId)).version, version);
  assert.deepEqual(terminations(verifying.identity), ["ALREADY_TERMINAL"]);
  assert.equal(await leaseCancelVersion(verifying.jobId), "1");
  for (const jobId of [running.jobId, verifying.jobId]) {
    const types = (await w.events(jobId)).map((e) => e.event_type);
    assert.equal(types.filter((t) => t === "processing_job.cancelled.v1").length, 1);
    assert.equal(types[types.length - 1], "processing_job.cancelled.v1");
  }
  await w.quiesce();
});

test("CMD037-DENY: the cancelled job's old worker is still live and finishes a valid package — its manifest submission, verification and publication are refused under the advanced cancellation and the package is never AVAILABLE", async () => {
  const p = await w.paid(await w.agency("cmd037-deny"), "cmd037-deny");
  const { jobId, identity } = await admitted(w, p);
  // the worker will survive its termination: its host kills nothing (the old worker is still live)
  w.host.survivesTermination(identity, { reportsAfterFinish: "SUCCEEDED" });
  const beforeManifest = w.host.holdNext("manifest", identity);
  await launched(w, jobId);
  await beforeManifest.reached;
  await w.x.sweepers.attemptMonitor.sweep(w.units, 20);
  await w.cancel(p, jobId);
  await w.drain(w.x.consumers.executionControl);
  assert.deepEqual(terminations(identity), ["TERMINATED"]);
  const attempt = await w.attempt(jobId);
  assert.deepEqual([attempt.state, (await w.job(jobId)).state], ["ABANDONED", "CANCELLED"]);

  // the old worker finishes a valid package under its own prefix, at its own fence
  beforeManifest.release();
  await w.host.settled(identity);
  const observed = await w.host.observe(identity);
  assert.equal(observed.state, "SUCCEEDED");
  assert.ok(observed.manifest !== null);
  const parts: Buffer[] = [];
  for await (const chunk of w.storage.read(w.storage.location("STAGING"), observed.manifest.objectName, observed.manifest.generation)) parts.push(Buffer.from(chunk));
  const job = await w.h.oracle.query<{ h: string }>("SELECT input_binding_hash AS h FROM kauro.processing_jobs WHERE job_id = $1", [jobId]);
  const reading = readStagedManifest(Buffer.concat(parts), { jobId: jobId as never, attemptId: attempt.attempt_id as never, fence: 1, inputBindingHash: job.rows[0]!.h as never, stagingPrefix: attempt.staging_prefix, manifestObjectName: attempt.manifest_object_name as string });
  assert.ok(reading.ok, "a valid package");

  // its manifest submission, verification and publication are refused under the advanced cancellation; the monitor takes nothing
  assert.deepEqual(await w.x.pipeline.submit(attempt.attempt_id as ProcessingAttemptId, observed.manifest), { kind: "REFUSED", reason: "JOB_CANCELLED" });
  assert.deepEqual(await w.x.pipeline.verify(jobId as ProcessingJobId), { kind: "REFUSED", reason: "JOB_CANCELLED" });
  assert.deepEqual(await w.x.pipeline.publish(jobId as ProcessingJobId), { kind: "REFUSED", reason: "JOB_CANCELLED" });
  await w.x.sweepers.attemptMonitor.sweep(w.units, 20);
  assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.staged_manifests WHERE attempt_id = $1", [attempt.attempt_id])).rowCount, 0);
  assert.deepEqual(await w.packages(jobId), [], "no package: never AVAILABLE");
  assert.deepEqual([(await w.job(jobId)).state, await leaseCancelVersion(jobId)], ["CANCELLED", "1"]);
  assert.equal((await w.objectsUnder("STAGING", attempt.staging_prefix)).length, 2, "its objects stay private, for the janitor");
  assert.equal((await w.authorization(p.authorizationId)).state, "CONSUMED", "cancellation is not a CRM rollback nor a delivery");
  await w.quiesce();
});

test("CMD037-RACE: a provider termination that times out stays UNCERTAIN and is reconciled by observing the attempt's identity until terminal; the job becomes CANCELLED only then, and a second delivery of the cancellation terminates nothing twice", async () => {
  const p = await w.paid(await w.agency("cmd037-race"), "cmd037-race");
  const { jobId, identity } = await admitted(w, p);
  const beforeManifest = w.host.holdNext("manifest", identity);
  await launched(w, jobId);
  await beforeManifest.reached;
  await w.x.sweepers.attemptMonitor.sweep(w.units, 20);
  // the provider applies the termination but its answer times out
  w.host.scriptTermination(identity, { applied: true });
  await w.cancel(p, jobId);
  const cancelRequested = await w.eventOf(jobId, "processing_job.cancel_requested.v1");

  const first = await w.drain(w.x.consumers.executionControl);
  assert.equal(first.retried, 1, "the uncertain termination is retried, never assumed");
  assert.deepEqual(terminations(identity), ["UNCERTAIN"]);
  assert.deepEqual(await outboxOf(cancelRequested.eventId, "EXECUTION_CONTROL"), { state: "RETRYABLE", attempts: 1 });
  assert.equal((await w.job(jobId)).state, "CANCEL_REQUESTED", "not CANCELLED while the provider job's end is uncertain");
  assert.equal((await w.attempt(jobId)).state, "RUNNING");

  // the retry observes the identity: terminated — only then is the attempt abandoned and the job CANCELLED
  const second = await w.plane.drain(w.x.consumers.executionControl, later(31));
  assert.equal(second.delivered, 1);
  assert.deepEqual([(await w.attempt(jobId)).state, (await w.job(jobId)).state], ["ABANDONED", "CANCELLED"]);
  const calls = w.host.calls().filter((c) => c.identity === identity);
  const uncertainAt = calls.findIndex((c) => c.operation === "terminate");
  assert.deepEqual(calls.slice(uncertainAt).map((c) => `${c.operation} ${c.outcome}`), ["terminate UNCERTAIN", "observe TERMINATED"], "reconciled by observation, not by a second termination");
  const history = (await w.events(jobId)).map((e) => e.event_type);
  assert.deepEqual(history.slice(-2), ["processing_job.cancel_requested.v1", "processing_job.cancelled.v1"]);

  // a second delivery of the cancellation terminates nothing twice
  assert.deepEqual(await w.redeliver(w.x.consumers.executionControl, cancelRequested), { kind: "DONE" });
  assert.deepEqual(terminations(identity), ["UNCERTAIN"]);
  beforeManifest.release();
  await w.host.settled(identity);
  await w.quiesce();
});
