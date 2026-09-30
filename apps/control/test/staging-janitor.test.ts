// STAGING_JANITOR after ATTEMPT_MONITOR (package B08, mandate B08-CONTROL-EXECUTION; docs/design/B08-audit-approval-jobs.md §4.3, §7,
// D8-ATT-1, D8-ATT-2, D8-JAN-1, D8-STG-2; case S075) on a real PostgreSQL 17 through this package's own control plane
// (kauro_control_test, SYSTEM units bound to each attempt's agency). SIMULATED: the worker host (its VM, disk and cost reports, its
// scripted crash), the Migration core and the object storage are the labelled contract fakes of their single owners; the attempt's
// scratch is @kauro/data-plane's real AttemptScratchStore on the file system. The lease lapses because the labelled TEST CLOCK of the
// control plane's units and the host's clock move past it — never a back-dated row, never a sleep. The superuser is the oracle only.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, test } from "node:test";
import { attemptScratchDirectoryOf } from "@kauro/data-plane";
import { admitted, ids, launched, startExecutionWorld, type ExecutionWorld } from "./support/execution-world.js";

let w: ExecutionWorld;

before(async () => {
  w = await startExecutionWorld("janitor");
});

after(async () => {
  await w.stop();
});

test("S075: the worker dies and its lease lapses; STAGING_JANITOR terminates exactly that provider job, deletes by generation exactly the objects under that attempt's staging prefix and its scratch — a sibling attempt's and another agency's objects untouched — and records the VM, disk, cost and result the host reported", async () => {
  const A = await w.agency("s075");
  const p = await w.paid(A, "s075");
  const { jobId, identity: dead } = await admitted(w, p);
  // the agent dies before its manifest: its VM stays up without heartbeats, its artifact and scratch are left behind
  w.host.crashAt("manifest", dead, "RUNNING");
  await launched(w, jobId);
  await w.host.settled(dead);
  await w.x.sweepers.attemptMonitor.sweep(w.units, 20);
  const lost = await w.attempt(jobId, 1);
  assert.deepEqual([lost.state, (await w.job(jobId)).state], ["RUNNING", "RUNNING"]);
  const leftBehind = await w.objectsUnder("STAGING", lost.staging_prefix);
  assert.equal(leftBehind.length, 1, "its artifact, no manifest");
  assert.ok(existsSync(attemptScratchDirectoryOf(w.scratchRoot, lost.attempt_id)), "its scratch is left behind");

  // another agency's staging object, which nothing of this attempt may touch
  const other = await w.agency("s075-other");
  const staging = w.storage.location("STAGING");
  const foreignName = `staging/${other.agencyId}/${ids.next()}/${ids.next()}/${ids.next()}/${ids.next()}`;
  const foreign = w.storage.plantObject(staging, foreignName, Buffer.from("another agency's staged bytes"));

  // the lease lapses on the server clock (the TEST CLOCK of the control plane's units; the host's clock moves with it): the monitor
  // terminates the silent identity, abandons the attempt and takes the lease over at fence + 1 ...
  w.advance(150);
  await w.x.sweepers.attemptMonitor.sweep(w.units, 20);
  assert.deepEqual([(await w.attempt(jobId, 1)).state, (await w.attempt(jobId, 1)).terminal_cause], ["ABANDONED", "LEASE_LAPSED"]);
  const sibling = await w.attempt(jobId, 2);
  assert.deepEqual([sibling.state, sibling.fence], ["CLAIMED", "2"]);
  // ... and launches the sibling attempt, which writes its own artifact and is held live before its manifest
  const siblingHeld = w.host.holdNext("manifest", sibling.identity);
  await w.x.sweepers.attemptMonitor.sweep(w.units, 20);
  await siblingHeld.reached;
  const siblingObjects = await w.objectsUnder("STAGING", sibling.staging_prefix);
  assert.equal(siblingObjects.length, 1, "the sibling attempt's artifact");
  const terminationsBefore = w.host.calls("terminate").map((c) => `${c.identity} ${c.outcome}`);
  assert.deepEqual(terminationsBefore, [`${dead} TERMINATED`], "the monitor terminated exactly the lost identity");

  // STAGING_JANITOR: exactly the ended attempt
  await w.x.sweepers.stagingJanitor.sweep(w.units, 20);
  assert.deepEqual(
    w.host.calls("terminate").map((c) => `${c.identity} ${c.outcome}`),
    [`${dead} TERMINATED`, `${dead} ALREADY_TERMINAL`],
    "the janitor terminated exactly that provider job and no other",
  );
  assert.deepEqual(await w.objectsUnder("STAGING", lost.staging_prefix), [], "every object under the attempt's prefix is gone");
  assert.equal(existsSync(attemptScratchDirectoryOf(w.scratchRoot, lost.attempt_id)), false, "and its scratch");
  assert.deepEqual(await w.objectsUnder("STAGING", sibling.staging_prefix), siblingObjects, "the sibling attempt's objects are untouched");
  assert.ok(existsSync(attemptScratchDirectoryOf(w.scratchRoot, sibling.attempt_id)), "the live sibling's scratch is untouched");
  assert.deepEqual(await w.objectsUnder("STAGING", foreignName), [`${foreignName}#${foreign.generation}`], "another agency's object is untouched");
  // the registry records each deletion by generation
  const [objectName, generation] = leftBehind[0]!.split("#");
  const registry = await w.h.oracle.query<{ object_id: string; zone: string; state: string; generation: string; deletion_result: string; data_class: string }>(
    "SELECT object_id, zone, state, generation, deletion_result, data_class FROM kauro.stored_objects WHERE object_name = $1",
    [objectName],
  );
  assert.deepEqual(registry.rows.map((r) => [r.zone, r.state, r.generation, r.deletion_result, r.data_class]), [["STAGING", "DELETED", generation, "DELETED", "RESIDUAL"]]);

  // the cleanup record: exactly one attempt, its identity and prefix, its deleted generations and what the host reported
  const report = await w.host.resources(dead);
  assert.ok(report.outcome === "REPORTED");
  const cleanup = (
    await w.h.oracle.query<{
      provider_identity: string;
      staging_prefix: string;
      deleted_objects: Array<{ objectId: string; objectName: string; generation: string }>;
      termination_result: string;
      scratch_deleted: boolean;
      machine_type: string;
      vcpus: number;
      memory_bytes: string;
      disk_bytes: string;
      peak_scratch_bytes: string;
      runtime_ms: string;
      cost_micros: string;
      currency: string;
      result: string;
      evidence_class: string;
    }>("SELECT * FROM kauro.attempt_cleanups WHERE attempt_id = $1", [lost.attempt_id])
  ).rows;
  assert.equal(cleanup.length, 1);
  const c = cleanup[0]!;
  assert.deepEqual([c.provider_identity, c.staging_prefix, c.termination_result, c.scratch_deleted, c.result, c.evidence_class], [dead, lost.staging_prefix, "ALREADY_TERMINAL", true, "CLEANED", "SIMULATED"]);
  assert.deepEqual(c.deleted_objects, [{ objectId: registry.rows[0]!.object_id, objectName, generation }]);
  assert.deepEqual(
    [c.machine_type, c.vcpus, Number(c.memory_bytes), Number(c.disk_bytes), Number(c.peak_scratch_bytes), Number(c.runtime_ms), Number(c.cost_micros), c.currency],
    [report.resources.machineType, report.resources.vcpus, report.resources.memoryBytes, report.resources.diskBytes, report.resources.peakScratchBytes, report.resources.runtimeMs, report.resources.costMicros, report.resources.currency],
    "the VM, disk, cost and result the host reported",
  );
  assert.ok(report.resources.runtimeMs >= 150_000, "a VM left running after its agent died kept costing until its termination");
  assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.attempt_cleanups WHERE attempt_id = $1", [sibling.attempt_id])).rowCount, 0, "a live attempt is never cleaned");

  // a second pass cleans nothing twice
  await w.x.sweepers.stagingJanitor.sweep(w.units, 20);
  assert.equal(w.host.calls("terminate").length, 2);
  assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.attempt_cleanups WHERE attempt_id = $1", [lost.attempt_id])).rowCount, 1);

  // the sibling finishes and publishes: the job never lost its entitlement to the dead agent
  siblingHeld.release();
  await w.host.settled(sibling.identity);
  await w.x.sweepers.attemptMonitor.sweep(w.units, 20);
  await w.drain(w.x.consumers.jobExecution);
  assert.deepEqual([(await w.job(jobId)).state, (await w.job(jobId)).fence], ["READY", "2"]);
  await w.quiesce();
});
