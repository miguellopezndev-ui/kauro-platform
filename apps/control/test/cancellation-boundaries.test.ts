// Cancellation at every await of the job pipeline (package B08, mandate B08-CONTROL-EXECUTION; docs/design/B08-audit-approval-jobs.md
// §6, D8-CANCEL-1, D8-HOST-1, D8-PUB-2; case CMD037-DENY) on a real PostgreSQL 17 through this package's own control plane. Each
// boundary is one run: a fresh paid job driven to exactly that await, held there by its hold point — the labelled fakes' own (the
// Migration core's execute steps, the worker host's start and manifest, the object storage's read and copy), a test decorator of the
// worker host's or the verifier's answer, or a hold inside the publication's unit of work — while CMD037 commits the cancellation
// (the request handlers' write); then the pipeline continues, EXECUTION_CONTROL reconciles, and no package is ever AVAILABLE.
// SIMULATED: worker host, Migration core, object storage (their single owners' labelled fakes). The superuser is the oracle only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ProcessingJobId } from "@kauro/domain";
import { admitted, heldHost, heldUnits, heldVerifier, launched, observedDone, startExecutionWorld, verifiedPrivate, type ExecutionWorld, type Purchase } from "./support/execution-world.js";

let w: ExecutionWorld;

before(async () => {
  w = await startExecutionWorld("boundaries");
});

after(async () => {
  await w.stop();
});

test("cancellation after every await of the job pipeline — admission, launch, each observe, the worker's own awaits, manifest read, each read-back, the verifier, the delivery copies and the publication commit — leaves no AVAILABLE package, each boundary held by its hold point", async () => {
  const A = await w.agency("boundaries");
  const staging = w.storage.location("STAGING");
  const outcomes: Array<readonly [string, string, string | null]> = [];
  let n = 0;
  const purchase = (): Promise<Purchase> => w.paid(A, `boundary-${++n}`);

  /** EXECUTION_CONTROL reconciles the committed cancellation; the job ends CANCELLED and nothing of it was ever AVAILABLE. */
  async function settle(boundary: string, jobId: string): Promise<void> {
    for (let round = 0; round < 4 && (await w.job(jobId)).state !== "CANCELLED"; round++) await w.x.cancellations.reconcile(jobId as ProcessingJobId);
    const job = await w.job(jobId);
    assert.deepEqual([job.state, job.cancel_version, job.published_package_id], ["CANCELLED", "1", null], boundary);
    const packages = await w.packages(jobId);
    for (const pkg of packages) {
      assert.equal(pkg.state, "REVOKED", `${boundary}: a package of a cancelled job is revoked, its evidence kept`);
      assert.ok(!(await w.events(pkg.package_version_id)).some((e) => e.event_type === "package_version.available.v1"), `${boundary}: never AVAILABLE`);
    }
    outcomes.push([boundary, job.state, packages[0]?.state ?? null]);
  }

  // admission: a cancellation committed before the admission unit — the round never admits the job
  {
    const p = await purchase();
    const job = await w.queue(p);
    await w.cancel(p, job.jobId);
    const round = await w.x.sweepers.jobAdmission.admitRound();
    assert.ok(!round.admitted.includes(job.jobId));
    await settle("before admission", job.jobId);
    assert.equal((await w.attempts(job.jobId)).length, 0);
  }

  // admission unit committed, launch not yet recorded: the launch intent re-reads the job — no launch, the attempt ABANDONED
  {
    const p = await purchase();
    const { jobId, identity } = await admitted(w, p);
    await w.cancel(p, jobId);
    await w.x.pipeline.launchNext();
    assert.equal(w.host.calls("launch").filter((c) => c.identity === identity).length, 0, "nothing is launched");
    await settle("admission committed", jobId);
    assert.equal((await w.attempt(jobId)).state, "ABANDONED");
  }

  // the launch returned (the provider job exists) and its answer is in flight: the launch record finds the job cancelled and
  // terminates the identity at once
  {
    const p = await purchase();
    const { jobId, identity } = await admitted(w, p);
    const start = w.host.holdNext("start", identity);
    const held = heldHost(w.host, "launch", identity);
    const other = w.planeWith({ host: held.host }).execution;
    assert.ok(other !== null);
    const launching = other.pipeline.launchNext();
    await held.hold.reached;
    await w.cancel(p, jobId);
    held.hold.release();
    await launching;
    await start.reached.catch(() => undefined);
    assert.equal(w.host.calls("terminate").filter((c) => c.identity === identity)[0]?.outcome, "TERMINATED", "terminated at once");
    await settle("launch", jobId);
    await w.host.settled(identity);
  }

  // each observe — the start: the monitor's unit re-reads the job and takes no edge; EXECUTION_CONTROL terminates and reconciles
  {
    const p = await purchase();
    const { jobId, identity } = await admitted(w, p);
    const beforeManifest = w.host.holdNext("manifest", identity);
    await launched(w, jobId);
    await beforeManifest.reached;
    const held = heldHost(w.host, "observe", identity);
    const other = w.planeWith({ host: held.host }).execution;
    assert.ok(other !== null);
    const observing = other.sweepers.attemptMonitor.sweep(other.units, 20);
    await held.hold.reached;
    await w.cancel(p, jobId);
    held.hold.release();
    await observing;
    assert.equal((await w.attempt(jobId)).state, "STARTING", "no provider_start_observed after the cancellation");
    await settle("observe (start)", jobId);
    await w.host.settled(identity);
  }

  // each observe — the success: no manifest is read or submitted
  {
    const p = await purchase();
    const { jobId, identity } = await admitted(w, p);
    await launched(w, jobId);
    await w.host.settled(identity);
    const held = heldHost(w.host, "observe", identity, (state) => state === "SUCCEEDED");
    const other = w.planeWith({ host: held.host }).execution;
    assert.ok(other !== null);
    const observing = other.sweepers.attemptMonitor.sweep(other.units, 20);
    await held.hold.reached;
    await w.cancel(p, jobId);
    held.hold.release();
    await observing;
    assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.staged_manifests WHERE job_id = $1", [jobId])).rowCount, 0);
    await settle("observe (success)", jobId);
  }

  // the worker's own awaits: its cancellation check, a scratch segment, the artifact write and close (the Migration core's hold points)
  // and the manifest write (the worker host's): the worker stops, no manifest exists
  for (const step of ["cancellation", "scratch", "write", "close", "manifest"] as const) {
    const p = await purchase();
    const { jobId, identity } = await admitted(w, p);
    const held = step === "manifest" ? w.host.holdNext("manifest", identity) : w.core.holdNext(step);
    await launched(w, jobId);
    await held.reached;
    await w.cancel(p, jobId);
    // the lease's cancellation, as the worker's channel reads it (the host's mirror), and EXECUTION_CONTROL's termination
    w.host.signal(identity, "CANCELLED");
    await settle(`worker await (${step})`, jobId);
    held.release();
    await w.host.settled(identity);
    const attempt = await w.attempt(jobId);
    assert.equal(await w.storage.stat(staging, attempt.manifest_object_name as string), null, `${step}: the worker wrote no manifest`);
  }

  // the manifest object read: the submission unit refuses — nothing STAGED, the objects left private for the janitor
  {
    const p = await purchase();
    const { jobId, identity } = await admitted(w, p);
    await launched(w, jobId);
    await w.host.settled(identity);
    const read = w.storage.holdNext("read");
    const observing = w.x.sweepers.attemptMonitor.sweep(w.units, 20);
    await read.reached;
    await w.cancel(p, jobId);
    read.release();
    await observing;
    assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.staged_manifests WHERE job_id = $1", [jobId])).rowCount, 0, "nothing STAGED");
    await settle("manifest read", jobId);
    assert.equal((await w.objectsUnder("STAGING", (await w.attempt(jobId)).staging_prefix)).length, 2, "the objects stay private for the janitor");
  }

  // each read-back: the verification unit refuses; the STAGED package is revoked with its evidence kept
  {
    const p = await purchase();
    const { jobId, identity } = await admitted(w, p);
    await launched(w, jobId);
    await observedDone(w, identity);
    const read = w.storage.holdNext("read");
    const verifying = w.x.pipeline.verify(jobId as ProcessingJobId);
    await read.reached;
    await w.cancel(p, jobId);
    read.release();
    assert.deepEqual(await verifying, { kind: "REFUSED", reason: "JOB_CANCELLED" });
    await settle("read-back", jobId);
    assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.staged_manifests WHERE job_id = $1", [jobId])).rowCount, 1, "the staged evidence is kept");
  }

  // the verifier call: the verification unit refuses
  {
    const p = await purchase();
    const { jobId, identity } = await admitted(w, p);
    await launched(w, jobId);
    await observedDone(w, identity);
    const held = heldVerifier(w.core);
    const other = w.planeWith({ verifier: held.verifier }).execution;
    assert.ok(other !== null);
    const verifying = other.pipeline.verify(jobId as ProcessingJobId);
    await held.hold.reached;
    await w.cancel(p, jobId);
    held.hold.release();
    assert.deepEqual(await verifying, { kind: "REFUSED", reason: "JOB_CANCELLED" });
    assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.package_verifications WHERE job_id = $1", [jobId])).rowCount, 0, "no verification recorded after the cancellation");
    await settle("verifier", jobId);
  }

  // the delivery copies: the publication is refused, the package revoked
  {
    const p = await purchase();
    const { jobId } = await verifiedPrivate(w, p);
    const copy = w.storage.holdNext("copy");
    const publishing = w.x.pipeline.publish(jobId as ProcessingJobId);
    await copy.reached;
    await w.cancel(p, jobId);
    copy.release();
    assert.deepEqual(await publishing, { kind: "REFUSED", reason: "JOB_CANCELLED" });
    await settle("delivery copy", jobId);
  }

  // the publication commit: the cancellation commits before the publication takes the job row — the publication finds it and refuses
  {
    const p = await purchase();
    const { jobId } = await verifiedPrivate(w, p);
    const held = heldUnits(w.units, "publish", "BEFORE");
    const other = w.planeWith({ units: held.units }).execution;
    assert.ok(other !== null);
    const publishing = other.pipeline.publish(jobId as ProcessingJobId);
    await held.hold.reached;
    await w.cancel(p, jobId);
    held.hold.release();
    assert.deepEqual(await publishing, { kind: "REFUSED", reason: "JOB_CANCELLED" });
    await settle("publication commit", jobId);
    assert.equal((await w.authorization(p.authorizationId)).state, "CONSUMED", "never DELIVERED");
  }

  assert.deepEqual(
    outcomes.map(([boundary]) => boundary),
    [
      "before admission",
      "admission committed",
      "launch",
      "observe (start)",
      "observe (success)",
      "worker await (cancellation)",
      "worker await (scratch)",
      "worker await (write)",
      "worker await (close)",
      "worker await (manifest)",
      "manifest read",
      "read-back",
      "verifier",
      "delivery copy",
      "publication commit",
    ],
  );
  for (const [boundary, state] of outcomes) assert.equal(state, "CANCELLED", boundary);
  assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.package_versions WHERE agency_id = $1 AND state = 'AVAILABLE'", [A.agencyId])).rowCount, 0, "no package of any run is AVAILABLE");
  await w.quiesce();
});
