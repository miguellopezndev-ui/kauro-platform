// JOB_EXECUTION and ATTEMPT_MONITOR end to end (package B08, mandate B08-CONTROL-EXECUTION; docs/design/B08-audit-approval-jobs.md
// §4.3, §5, §7, D8-HOST-1, D8-ATT-1/2, D8-STG-1..3, D8-VER-1, D8-PUB-1/2, D8-STALE-1, D8-JAN-1; cases S035, S056, S061, S062, R2-045)
// on a real PostgreSQL 17 through this package's own control plane (kauro_control_test, SYSTEM units bound to each job's agency).
// SIMULATED: the worker host, the Migration core (execution envelope and verifier) and the object storage are the labelled contract
// fakes of their single owners (B08-WORKER-HOST, B08-CORE-PORTS, B07-PROVIDER-FAKES), consumed here and never copied; the attempt
// envelope inside the host fake is @kauro/data-plane's real scratch store and fenced writer. Entitlements are B09's own; a lease's
// lapse is the labelled TEST CLOCK moved forward (with the host's clock); interleavings are the fakes' hold points. The superuser is
// the oracle only.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, test } from "node:test";
import { readStagedManifest } from "@kauro/application";
import { attemptScratchDirectoryOf } from "@kauro/data-plane";
import type { ProcessingAttemptId, ProcessingJobId } from "@kauro/domain";
import { admitted, launched, observedDone, startExecutionWorld, verifiedPrivate, type ExecutionWorld, type Purchase } from "./support/execution-world.js";

let w: ExecutionWorld;

before(async () => {
  w = await startExecutionWorld("execution");
});

after(async () => {
  await w.stop();
});

async function bytesOf(objectName: string, generation: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of w.storage.read(w.storage.location("STAGING"), objectName, generation)) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

/** The staged artifact the worker wrote under its prefix (every object there but the attempt's manifest). */
async function artifactOf(jobId: string): Promise<{ readonly objectName: string; readonly generation: string }> {
  const attempt = await w.attempt(jobId);
  const objects = (await w.objectsUnder("STAGING", attempt.staging_prefix)).filter((o) => !o.startsWith(`${attempt.manifest_object_name}#`));
  assert.equal(objects.length, 1, "one artifact besides the manifest");
  const [objectName, generation] = objects[0]!.split("#");
  return { objectName: objectName!, generation: generation! };
}

async function cleanupOf(attemptId: string) {
  return (
    await w.h.oracle.query<{ provider_identity: string; staging_prefix: string; deleted_objects: Array<{ objectId: string; objectName: string; generation: string }>; termination_result: string; scratch_deleted: boolean; machine_type: string | null; result: string; evidence_class: string }>(
      "SELECT provider_identity, staging_prefix, deleted_objects, termination_result, scratch_deleted, machine_type, result, evidence_class FROM kauro.attempt_cleanups WHERE attempt_id = $1",
      [attemptId],
    )
  ).rows[0];
}

test("S035 end to end: an attempt whose scratch fills, whose artifact write is short or whose intermediate bytes are corrupted ends its job FAILED with that exact cause, no package version leaves STAGED, and STAGING_JANITOR deletes exactly that attempt's staging objects and scratch", async () => {
  const A = await w.agency("s035");
  for (const [fault, cause] of [["ENOSPC", "SCRATCH_EXHAUSTED"], ["SHORT_WRITE", "SHORT_WRITE"], ["CORRUPT_INTERMEDIATE", "CORRUPT_INTERMEDIATE"]] as const) {
    const p = await w.paid(A, `s035-${cause.toLowerCase()}`);
    const { jobId, identity } = await admitted(w, p);
    w.core.failNextExecute(fault);
    await launched(w, jobId);
    // the worker ends FAILED with the envelope's exact cause; ATTEMPT_MONITOR observes it (start, then the classified failure)
    await observedDone(w, identity);
    const job = await w.job(jobId);
    assert.deepEqual([job.state, job.terminal_reason, job.holds], ["FAILED", cause, "NONE"], cause);
    const attempt = await w.attempt(jobId);
    assert.deepEqual([attempt.state, attempt.terminal_cause], ["FAILED", cause]);
    assert.deepEqual((await w.events(jobId)).map((e) => e.event_type).slice(-1), ["processing_job.failed.v1"]);
    assert.deepEqual(await w.packages(jobId), [], "no manifest was submitted: no package version exists, none leaves STAGED");
    const left = await w.objectsUnder("STAGING", attempt.staging_prefix);
    // a short or corrupted artifact the writer closed stays under the prefix until the janitor; a full scratch wrote nothing
    assert.equal(left.length, cause === "SCRATCH_EXHAUSTED" ? 0 : 1, `${cause}: what the worker left`);

    // STAGING_JANITOR: exactly that attempt — its prefix listed, each object deleted by generation, its scratch, one record
    const neighbours = await w.objectsUnder("STAGING", "staging/");
    await w.x.sweepers.stagingJanitor.sweep(w.units, 20);
    assert.deepEqual(await w.objectsUnder("STAGING", attempt.staging_prefix), [], "nothing is left under the prefix");
    assert.deepEqual(await w.objectsUnder("STAGING", "staging/"), neighbours.filter((o) => !o.startsWith(attempt.staging_prefix)), "nothing outside the prefix was touched");
    assert.equal(existsSync(attemptScratchDirectoryOf(w.scratchRoot, attempt.attempt_id)), false, "no scratch of the attempt remains");
    const cleanup = await cleanupOf(attempt.attempt_id);
    assert.ok(cleanup, "one cleanup record of the attempt");
    assert.deepEqual([cleanup.provider_identity, cleanup.staging_prefix, cleanup.scratch_deleted, cleanup.result, cleanup.evidence_class], [identity, attempt.staging_prefix, true, "CLEANED", "SIMULATED"]);
    assert.equal(cleanup.termination_result, "ALREADY_TERMINAL", "the janitor terminated exactly that identity, already terminal");
    assert.deepEqual(cleanup.deleted_objects.map((o) => `${o.objectName}#${o.generation}`).sort(), left);
    const registry = await w.h.oracle.query<{ state: string; deletion_result: string; zone: string }>("SELECT state, deletion_result, zone FROM kauro.stored_objects WHERE starts_with(object_name, $1)", [attempt.staging_prefix]);
    assert.equal(registry.rowCount, left.length);
    for (const r of registry.rows) assert.deepEqual([r.zone, r.state, r.deletion_result], ["STAGING", "DELETED", "DELETED"], "the registry records each deletion by generation");
  }
  assert.deepEqual(await w.capacity(), { active: 0, waiting: 0, live: 0 });
  await w.quiesce();
});

test("S056: a duplicated admission delivery launches nothing twice; an ambiguous launch is reconciled by observing the attempt's identity before any other create; the old attempt that survives a takeover finishes a valid package that is never submitted, verified or published", async () => {
  const A = await w.agency("s056");
  const launches = (identity: string) => w.host.calls("launch").filter((c) => c.identity === identity);

  // (1) the host's answer to the create is lost after it created the job (AMBIGUOUS): the launch is recorded UNCERTAIN
  const p1 = await w.paid(A, "s056-ambiguous");
  const first = await admitted(w, p1);
  w.host.scriptLaunch(first.identity, "TIMEOUT_AFTER_CREATE");
  const firstStart = w.host.holdNext("start", first.identity);
  await w.drain(w.x.consumers.jobExecution);
  let attempt = await w.attempt(first.jobId);
  assert.deepEqual([attempt.state, attempt.launch_state, attempt.provider_job_id], ["STARTING", "UNCERTAIN", null]);
  assert.deepEqual(launches(first.identity).map((c) => c.outcome), ["AMBIGUOUS (created)"]);
  // the admission's record delivered again (dispatch is at least once): nothing is launched twice
  const admittedEvent = await w.eventOf(first.jobId, "processing_job.admitted.v1");
  assert.deepEqual(await w.redeliver(w.x.consumers.jobExecution, admittedEvent), { kind: "DONE" });
  assert.equal(launches(first.identity).length, 1, "one create per identity");
  // ATTEMPT_MONITOR observes the identity before any other create: found, the job is adopted as launched
  await firstStart.reached;
  await w.x.sweepers.attemptMonitor.sweep(w.units, 20);
  attempt = await w.attempt(first.jobId);
  assert.deepEqual([attempt.launch_state, attempt.provider_job_id], ["LAUNCHED", first.identity]);
  const firstCalls = w.host.calls().filter((c) => c.identity === first.identity).map((c) => c.operation);
  assert.deepEqual(firstCalls.slice(0, 2), ["launch", "observe"], "observe before any other create");
  assert.equal(launches(first.identity).length, 1);
  firstStart.release();
  await observedDone(w, first.identity);
  await w.drain(w.x.consumers.jobExecution);
  assert.equal((await w.job(first.jobId)).state, "READY", "the adopted attempt publishes");

  // (2) the create timed out before it took effect: NOT_FOUND inside the creation horizon proves nothing, so nothing is created
  // again; when the late create lands, the monitor finds it and adopts it
  const p2 = await w.paid(A, "s056-late-create");
  const second = await admitted(w, p2);
  w.host.scriptLaunch(second.identity, "TIMEOUT_BEFORE_CREATE");
  await launched(w, second.jobId);
  await w.x.sweepers.attemptMonitor.sweep(w.units, 20);
  assert.equal((await w.attempt(second.jobId)).launch_state, "UNCERTAIN", "an absence inside the horizon is not proof");
  assert.equal(launches(second.identity).length, 1, "nothing is created while the launch is uncertain");
  assert.equal(w.host.landPendingCreation(second.identity), true, "the create lands late, inside the horizon");
  await w.host.settled(second.identity);
  await w.x.sweepers.attemptMonitor.sweep(w.units, 20);
  assert.deepEqual([(await w.attempt(second.jobId)).launch_state, launches(second.identity).length], ["LAUNCHED", 1]);
  await w.drain(w.x.consumers.jobExecution);
  assert.equal((await w.job(second.jobId)).state, "READY");

  // (3) the old attempt survives its takeover: its agent falls silent before its manifest, the lease lapses on the server clock
  const p3 = await w.paid(A, "s056-survivor");
  const third = await admitted(w, p3);
  const old = third.identity;
  w.host.survivesTermination(old, { reportsAfterFinish: "SUCCEEDED" });
  const oldBeforeManifest = w.host.holdNext("manifest", old);
  await launched(w, third.jobId);
  await oldBeforeManifest.reached;
  await w.x.sweepers.attemptMonitor.sweep(w.units, 20);
  const oldAttempt = await w.attempt(third.jobId, 1);
  assert.deepEqual([oldAttempt.state, (await w.job(third.jobId)).state], ["RUNNING", "RUNNING"]);
  w.advance(150);
  // the monitor finds the lease lapsed: it terminates the identity (the host reports it terminated), abandons the attempt, and takes
  // the lease over for attempt 2 at fence + 1 — a second pass launches it by its own identity
  await w.x.sweepers.attemptMonitor.sweep(w.units, 20);
  assert.deepEqual([(await w.attempt(third.jobId, 1)).state, (await w.attempt(third.jobId, 1)).terminal_cause], ["ABANDONED", "LEASE_LAPSED"]);
  const takeover = await w.attempt(third.jobId, 2);
  assert.deepEqual([takeover.state, takeover.fence], ["CLAIMED", "2"]);
  await w.x.sweepers.attemptMonitor.sweep(w.units, 20);
  assert.equal((await w.attempt(third.jobId, 2)).state, "STARTING");
  await observedDone(w, takeover.identity);
  await w.drain(w.x.consumers.jobExecution);
  const job = await w.job(third.jobId);
  assert.deepEqual([job.state, job.fence], ["READY", "2"]);
  const packages = await w.packages(third.jobId);
  assert.deepEqual(packages.map((x) => [x.attempt_id, x.state]), [[takeover.attempt_id, "AVAILABLE"]]);

  // the old worker now finishes a valid package in its own prefix, at its own fence ...
  oldBeforeManifest.release();
  await w.host.settled(old);
  const observed = await w.host.observe(old);
  assert.equal(observed.state, "SUCCEEDED", "its host even reports success");
  assert.ok(observed.manifest !== null);
  const reading = readStagedManifest(await bytesOf(observed.manifest.objectName, observed.manifest.generation), {
    jobId: third.jobId as never,
    attemptId: oldAttempt.attempt_id as never,
    fence: 1,
    inputBindingHash: (await w.h.oracle.query<{ h: string }>("SELECT input_binding_hash AS h FROM kauro.processing_jobs WHERE job_id = $1", [third.jobId])).rows[0]!.h as never,
    stagingPrefix: oldAttempt.staging_prefix,
    manifestObjectName: oldAttempt.manifest_object_name as string,
  });
  assert.ok(reading.ok, "a valid package");
  // ... which is never submitted, verified or published: its late submission is refused under its lost fence
  const late = await w.x.pipeline.submit(oldAttempt.attempt_id as ProcessingAttemptId, observed.manifest);
  assert.equal(late.kind, "REFUSED", JSON.stringify(late));
  await w.x.sweepers.attemptMonitor.sweep(w.units, 20);
  const staged = await w.h.oracle.query("SELECT 1 FROM kauro.staged_manifests WHERE attempt_id = $1", [oldAttempt.attempt_id]);
  assert.equal(staged.rowCount, 0, "the old attempt submitted nothing");
  assert.deepEqual((await w.packages(third.jobId)).map((x) => [x.attempt_id, x.state]), [[takeover.attempt_id, "AVAILABLE"]]);
  assert.equal((await w.objectsUnder("STAGING", oldAttempt.staging_prefix)).length, 2, "its artifact and manifest stay private for the janitor");
  for (const identity of [first.identity, second.identity, old, takeover.identity]) assert.equal(launches(identity).length, 1, `one create for ${identity}`);
  await w.quiesce();
});

test("S061: a staged manifest naming a partial blob, another attempt's object or an overwritten generation fails read-back, the job ends FAILED by verification_failure with the exact problem and its package is REVOKED with the evidence kept; the complete neighbour publishes", async () => {
  const A = await w.agency("s061");
  // the complete neighbour publishes; its artifact is the other attempt's object of one case below
  const neighbour = await w.paid(A, "s061-neighbour");
  const n = await admitted(w, neighbour);
  await launched(w, n.jobId);
  await observedDone(w, n.identity);
  await w.drain(w.x.consumers.jobExecution);
  assert.equal((await w.job(n.jobId)).state, "READY");
  assert.equal((await w.packages(n.jobId))[0]?.state, "AVAILABLE");
  const neighbourArtifact = await artifactOf(n.jobId);
  const neighbourBytes = await bytesOf(neighbourArtifact.objectName, neighbourArtifact.generation);

  const staging = w.storage.location("STAGING");
  const cases: ReadonlyArray<readonly [string, (name: string, bytes: Buffer) => void, string]> = [
    ["partial blob", (name, bytes) => void w.storage.plantObject(staging, name, bytes.subarray(0, bytes.length - 9), { overwrite: true }), "READBACK_PARTIAL_BLOB"],
    ["another attempt's object", (name) => void w.storage.plantObject(staging, name, neighbourBytes, { overwrite: true }), "READBACK_FOREIGN_CONTENT"],
    ["an overwritten generation", (name, bytes) => void w.storage.plantObject(staging, name, bytes, { overwrite: true }), "READBACK_GENERATION_CHANGED"],
  ];
  for (const [label, tamper, problem] of cases) {
    const p: Purchase = await w.paid(A, `s061-${problem.toLowerCase()}`);
    const { jobId, identity } = await admitted(w, p);
    const finish = w.host.holdNext("finish", identity);
    await launched(w, jobId);
    await finish.reached;
    // the worker closed its artifact and wrote its manifest; before it reports, the named generation is replaced under its name
    const artifact = await artifactOf(jobId);
    tamper(artifact.objectName, await bytesOf(artifact.objectName, artifact.generation));
    finish.release();
    await observedDone(w, identity);
    assert.equal((await w.job(jobId)).state, "VERIFYING", `${label}: the manifest itself is intact and submitted`);
    await w.drain(w.x.consumers.jobExecution);

    const job = await w.job(jobId);
    assert.deepEqual([job.state, job.terminal_reason, job.holds], ["FAILED", problem, "NONE"], label);
    const attempt = await w.attempt(jobId);
    assert.deepEqual([attempt.state, attempt.terminal_cause], ["FAILED", problem]);
    const readbacks = await w.h.oracle.query<{ object_name: string; expected_generation: string; observed_generation: string | null; result: string }>(
      "SELECT object_name, expected_generation, observed_generation, result FROM kauro.artifact_readbacks WHERE attempt_id = $1 AND kind = 'STAGING'",
      [attempt.attempt_id],
    );
    assert.deepEqual(readbacks.rows.map((r) => [r.object_name, r.expected_generation, r.result]), [[artifact.objectName, artifact.generation, "MISMATCH"]], label);
    assert.notEqual(readbacks.rows[0]?.observed_generation, artifact.generation, "what the storage holds under the name is another generation");
    const verification = (await w.h.oracle.query<{ result: string; problems: string[] }>("SELECT result, problems FROM kauro.package_verifications WHERE attempt_id = $1", [attempt.attempt_id])).rows;
    assert.deepEqual(verification, [{ result: "INVALID", problems: [problem] }], label);
    const [pkg] = await w.packages(jobId);
    assert.deepEqual([pkg?.state, pkg?.revocation_reason], ["REVOKED", "VERIFICATION_FAILED"]);
    assert.deepEqual((await w.events(pkg!.package_version_id)).map((e) => e.event_type), ["package_version.staged.v1", "package_version.revoked.v1"], "never VERIFIED_PRIVATE, never AVAILABLE");
    // the evidence is kept: the staged manifest, its artifact rows and the read-back
    assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.staged_manifests WHERE attempt_id = $1", [attempt.attempt_id])).rowCount, 1);
    assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.staged_artifacts WHERE attempt_id = $1", [attempt.attempt_id])).rowCount, 1);
    assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.delivery_artifacts WHERE attempt_id = $1", [attempt.attempt_id])).rowCount, 0);
    assert.equal((await w.authorization(p.authorizationId)).state, "CONSUMED", "never DELIVERED");
  }
  assert.equal((await w.job(n.jobId)).state, "READY", "the neighbour stays published");
  await w.quiesce();
});

test("stale authority at publication: a source revision superseded or expired, an approval withdrawn, a target contract superseded or a capability suspended after verification refuses the publication with its reason and the package is REVOKED, never AVAILABLE", async () => {
  const A = await w.agency("stale");
  const suspended = await w.offeredCapability("R2-STALE-CAPABILITY");
  const cases: ReadonlyArray<readonly [string, (p: Purchase) => Promise<void>, { readonly capabilityId?: string }]> = [
    ["SOURCE_SUPERSEDED", (p) => w.supersedeSource(p), {}],
    ["SOURCE_EXPIRED", (p) => w.expireSource(p), {}],
    ["APPROVAL_WITHDRAWN", (p) => w.withdrawApproval(p), {}],
    ["TARGET_STALE", (p) => w.supersedeTarget(p), {}],
    ["CAPABILITY_UNAVAILABLE", (p) => w.suspendCapability(p.capabilityId), { capabilityId: suspended }],
  ];
  for (const [reason, makeStale, options] of cases) {
    const p = await w.paid(A, `stale-${reason.toLowerCase()}`, options);
    const { jobId } = await verifiedPrivate(w, p);
    // the fact the job relies on is lost after verification ...
    await makeStale(p);
    // ... and JOB_EXECUTION's publication reads it after its locks: refused with the reason, the job's cancellation requested
    const step = await w.x.pipeline.publish(jobId as ProcessingJobId);
    assert.deepEqual(step, { kind: "REFUSED", reason }, reason);
    const cancelling = await w.job(jobId);
    assert.deepEqual([cancelling.state, cancelling.cancel_reason_code, cancelling.cancel_actor_kind, cancelling.cancel_actor_id], ["CANCEL_REQUESTED", reason, "SERVICE", "job-execution"]);
    const [pkg] = await w.packages(jobId);
    assert.deepEqual([pkg?.state, pkg?.revocation_reason], ["REVOKED", reason]);
    // EXECUTION_CONTROL reconciles the cancellation: the job ends CANCELLED, the entitlement consumed and never DELIVERED
    await w.x.cancellations.reconcile(jobId as ProcessingJobId);
    assert.equal((await w.job(jobId)).state, "CANCELLED");
    assert.deepEqual((await w.events(pkg!.package_version_id)).map((e) => e.event_type), ["package_version.staged.v1", "package_version.verified_private.v1", "package_version.revoked.v1"], "never AVAILABLE");
    assert.equal((await w.authorization(p.authorizationId)).state, "CONSUMED");
    assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.package_verifications WHERE package_version_id = $1 AND result = 'VALID'", [pkg!.package_version_id])).rowCount, 1, "the evidence stays");
  }
  await w.quiesce();
});

test("R2-045: a reversal revokes the consumed authorization while the worker is still producing a valid package — EXECUTION_CONTROL requests the job's cancellation, the package is verified but never AVAILABLE, it ends REVOKED with its evidence retained privately, and the authorization is never DELIVERED", async () => {
  const p = await w.paid(await w.agency("r2045"), "r2045");
  const { jobId, identity } = await admitted(w, p);
  const writing = w.core.holdNext("write");
  await launched(w, jobId);
  await w.x.sweepers.attemptMonitor.sweep(w.units, 20);
  await writing.reached;
  // B09's payment service revokes the consumed entitlement (a reversal during execution) through its own adapter
  await w.revoke(p);
  assert.equal((await w.authorization(p.authorizationId)).state, "REVOKED");
  const revocation = (await w.events(p.authorizationId)).find((e) => e.event_type === "commercial_authorization.revoked.v1");
  assert.ok(revocation, "the revocation's event, routed to EXECUTION_CONTROL");
  // the worker still produces a valid package, and the platform verifies it
  writing.release();
  await observedDone(w, identity);
  assert.equal((await w.x.pipeline.verify(jobId as ProcessingJobId)).kind, "APPLIED");
  const [verified] = await w.packages(jobId);
  assert.equal(verified?.state, "VERIFIED_PRIVATE", "the package is verified");

  // EXECUTION_CONTROL: the revocation requests the job's cancellation and reconciles it
  await w.drain(w.x.consumers.executionControl);
  const job = await w.job(jobId);
  assert.deepEqual([job.state, job.cancel_reason_code, job.cancel_actor_kind, job.cancel_actor_id], ["CANCELLED", "AUTHORIZATION_REVOKED", "SERVICE", "execution-control"]);
  const [pkg] = await w.packages(jobId);
  assert.deepEqual([pkg?.state, pkg?.revocation_reason], ["REVOKED", "AUTHORIZATION_REVOKED"]);
  // the verified package's publication is refused: JOB_EXECUTION's step finds the job cancelled
  assert.equal((await w.x.pipeline.publish(jobId as ProcessingJobId)).kind, "REFUSED");
  assert.deepEqual((await w.events(pkg!.package_version_id)).map((e) => e.event_type), ["package_version.staged.v1", "package_version.verified_private.v1", "package_version.revoked.v1"], "never AVAILABLE");

  // the evidence is retained privately: the VALID verification, the read-backs, the staged artifacts and their objects
  const attempt = await w.attempt(jobId);
  assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.package_verifications WHERE attempt_id = $1 AND result = 'VALID'", [attempt.attempt_id])).rowCount, 1);
  assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.artifact_readbacks WHERE attempt_id = $1 AND kind = 'STAGING' AND result = 'EQUAL'", [attempt.attempt_id])).rowCount, 1);
  assert.equal((await w.objectsUnder("STAGING", attempt.staging_prefix)).length, 2, "the artifact and its manifest stay, private");
  await w.x.sweepers.stagingJanitor.sweep(w.units, 20);
  assert.equal((await w.objectsUnder("STAGING", attempt.staging_prefix)).length, 2, "the janitor keeps a revoked package's evidence");
  // the entitlement was never DELIVERED: no delivery copy, no delivered event
  assert.equal((await w.authorization(p.authorizationId)).state, "REVOKED");
  assert.equal((await w.events(p.authorizationId)).filter((e) => e.event_type === "commercial_authorization.delivered.v1").length, 0);
  assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.delivery_artifacts WHERE job_id = $1", [jobId])).rowCount, 0);
  assert.deepEqual(await w.objectsUnder("DELIVERY", `delivery/${p.agency.agencyId}/`), []);
  await w.quiesce();
});
