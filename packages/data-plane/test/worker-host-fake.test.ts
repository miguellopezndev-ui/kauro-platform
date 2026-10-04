// ContractFakeWorkerHost (mandate B08-WORKER-HOST; design §10, D8-HOST-1, D8-ATT-2, D8-JAN-1, D8-FAKE-1; S056, S075). CONTRACT
// FAKE — SIMULATED: the labelled worker host of @kauro/data-plane/testing/worker-host, its single owner, runs each attempt as a
// local executor inside the attempt envelope — the real AttemptScratchStore, FencedArtifactWriter and GenerationSourceReader —
// over B07's object-storage fake and B08-CORE-PORTS' migration-core fake, both consumed from their owners and copied by neither.
// Every answer, record and token is SIMULATED / contract-fake-worker-host*; the real host is B14's (Cloud Batch). Interleavings
// are the fake's hold points and its settled runs, and its clock is the test's: nothing here sleeps.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { attemptIdentityOf, readStagedManifest, type WorkerLaunchSpec } from "@kauro/application";
import { ContractFakeObjectStorage } from "@kauro/application/testing";
import { ContractFakeMigrationCore } from "@kauro/application/testing/cores";
import { attemptScratchDirectoryOf } from "../src/index.js";
import {
  CONTRACT_FAKE_WORKER_HOST_MACHINE_TYPE,
  CONTRACT_FAKE_WORKER_HOST_TOKEN,
  ContractFakeWorkerHost,
} from "../src/testing/worker-host.js";
import { attemptFixture, collect, holderOf, limitsOf, manualClock, v7, type AttemptFixture } from "./support/attempt.js";
import { freshDir, removeDir } from "./support/harness.js";

const T0 = Date.parse("2026-09-21T08:00:00.000Z");

function rig(root: string) {
  const clock = manualClock(T0);
  const storage = new ContractFakeObjectStorage();
  const core = new ContractFakeMigrationCore();
  const host = new ContractFakeWorkerHost({ core, storage, uploads: holderOf(storage), scratchRoot: root, clock, creationHorizonSeconds: 300 });
  return { clock, storage, core, host, staging: storage.location("STAGING") };
}

/** The staged manifest the host reported for `fixture`, read by the test itself and checked against `expected` (default: its own). */
async function manifestOf(r: ReturnType<typeof rig>, fixture: AttemptFixture, fence: number, expected: AttemptFixture = fixture) {
  const observed = await r.host.observe(fixture.identity);
  assert.ok(observed.manifest !== null, `${fixture.identity} reported a manifest`);
  const bytes = await collect(r.storage.read(r.staging, observed.manifest.objectName, observed.manifest.generation));
  return readStagedManifest(bytes, {
    jobId: expected.jobId,
    attemptId: expected.attemptId,
    fence,
    inputBindingHash: expected.subject.inputBindingHash,
    stagingPrefix: expected.prefix,
    manifestObjectName: expected.capability.manifestObjectName,
  });
}

async function objectsUnder(r: ReturnType<typeof rig>, prefix: string): Promise<string[]> {
  return (await r.storage.list(r.staging, prefix)).objects.map((o) => `${o.objectName}#${o.generation}`).sort();
}

test("the labelled worker-host fake keys every provider job by the attempt's deterministic identity — a second create answers ALREADY_EXISTS, a scripted timeout after creation leaves a job that observe finds, termination acts on that identity only — and every record carries evidence class SIMULATED", async () => {
  const root = freshDir("worker-host-identity");
  const r = rig(root);
  const [a1, a2, a3, a4] = [1, 2, 3, 4].map((n) => attemptFixture(n));
  assert.ok(a1 !== undefined && a2 !== undefined && a3 !== undefined && a4 !== undefined);
  const records: Array<{ readonly evidenceClass: string }> = [];
  const keep = <T extends { readonly evidenceClass: string }>(value: T): T => {
    records.push(value);
    return value;
  };
  try {
    assert.equal(r.host.evidenceClass, "SIMULATED");
    // create by identity: the second launch of one identity adopts the job the first created
    const start1 = r.host.holdNext("start", a1.identity);
    assert.deepEqual(keep(await r.host.launch(a1.spec(1))), { evidenceClass: "SIMULATED", identity: a1.identity, outcome: "LAUNCHED", reason: null });
    await start1.reached;
    assert.equal(keep(await r.host.launch(a1.spec(1))).outcome, "ALREADY_EXISTS");
    const queued = keep(await r.host.observe(a1.identity));
    assert.equal(queued.state, "QUEUED");
    assert.equal(queued.lastHeartbeatAt, null);

    // a spec whose identity is not its attempt's deterministic identity creates nothing
    const forged: WorkerLaunchSpec = { ...a2.spec(1), identity: a1.identity };
    assert.equal(keep(await r.host.launch(forged)).outcome, "REFUSED");
    assert.equal(keep(await r.host.launch({ ...a2.spec(1), identity: "kauro-attempt-not-a-uuid" })).outcome, "REFUSED");

    // a scripted timeout after creation: AMBIGUOUS, the job exists, observe finds it and nothing is created twice
    r.host.scriptLaunch(a2.identity, "TIMEOUT_AFTER_CREATE");
    const start2 = r.host.holdNext("start", a2.identity);
    assert.equal(keep(await r.host.launch(a2.spec(1))).outcome, "AMBIGUOUS");
    await start2.reached;
    assert.equal(keep(await r.host.observe(a2.identity)).state, "QUEUED");
    assert.equal(keep(await r.host.launch(a2.spec(1))).outcome, "ALREADY_EXISTS");

    // a timeout before creation: NOT_FOUND proves nothing inside the creation horizon (the create may still land), and past it
    // the late create can never land, so a create by identity is safe
    r.host.scriptLaunch(a3.identity, "TIMEOUT_BEFORE_CREATE");
    r.host.scriptLaunch(a4.identity, "TIMEOUT_BEFORE_CREATE");
    assert.equal(keep(await r.host.launch(a3.spec(1))).outcome, "AMBIGUOUS");
    assert.equal(keep(await r.host.launch(a4.spec(1))).outcome, "AMBIGUOUS");
    assert.equal(keep(await r.host.observe(a3.identity)).state, "NOT_FOUND");
    assert.equal(keep(await r.host.observe(a4.identity)).state, "NOT_FOUND");
    r.clock.advance(299_000);
    const start3 = r.host.holdNext("start", a3.identity);
    assert.equal(r.host.landPendingCreation(a3.identity), true, "inside the horizon the create lands late");
    await start3.reached;
    assert.equal(keep(await r.host.observe(a3.identity)).state, "QUEUED");
    r.clock.advance(2_000);
    assert.equal(r.host.landPendingCreation(a4.identity), false, "past the horizon it never lands");
    assert.equal(keep(await r.host.observe(a4.identity)).state, "NOT_FOUND");
    assert.equal(keep(await r.host.launch(a4.spec(1))).outcome, "LAUNCHED");

    // termination acts on exactly the identity it is given
    assert.deepEqual(keep(await r.host.terminate(a1.identity)), { evidenceClass: "SIMULATED", identity: a1.identity, outcome: "TERMINATED" });
    assert.equal(keep(await r.host.observe(a1.identity)).state, "TERMINATED");
    assert.equal(keep(await r.host.observe(a2.identity)).state, "QUEUED", "another attempt's job is untouched");
    assert.equal(keep(await r.host.terminate(a1.identity)).outcome, "ALREADY_TERMINAL");
    assert.equal(keep(await r.host.terminate(attemptIdentityOf(v7(3999)))).outcome, "NOT_FOUND");
    assert.equal(keep(await r.host.terminate("kauro-attempt-../x")).outcome, "NOT_FOUND");
    start1.release();
    await r.host.settled(a1.identity);
    assert.deepEqual(await objectsUnder(r, a1.prefix), [], "the terminated worker wrote nothing");

    // the others run to completion inside their envelopes, each under its own prefix, heartbeating on the host's clock
    start2.release();
    start3.release();
    for (const a of [a2, a3, a4]) {
      await r.host.settled(a.identity);
      const done = keep(await r.host.observe(a.identity));
      assert.equal(done.state, "SUCCEEDED");
      assert.equal(done.lastHeartbeatAt, r.clock.now());
      const reading = await manifestOf(r, a, 1);
      assert.ok(reading.ok, JSON.stringify(reading));
      assert.ok((await objectsUnder(r, "staging/")).filter((o) => o.startsWith(a.prefix)).length === 2, "one artifact and the manifest");
    }
    assert.equal((await objectsUnder(r, "staging/")).length, 6);

    // one job per identity for good; every record and call log entry is SIMULATED and names the host's token
    assert.deepEqual(
      r.host.jobs().map((j) => [j.identity, j.createRequests]),
      [[a1.identity, 2], [a2.identity, 2], [a3.identity, 1], [a4.identity, 2]],
    );
    for (const record of [...records, ...r.host.jobs()]) assert.equal(record.evidenceClass, "SIMULATED");
    for (const call of r.host.calls()) {
      assert.equal(call.evidenceClass, "SIMULATED");
      assert.equal(call.host, CONTRACT_FAKE_WORKER_HOST_TOKEN);
    }
    assert.match(CONTRACT_FAKE_WORKER_HOST_TOKEN, /^contract-fake-worker-host/);
    assert.deepEqual(
      r.host.calls("launch").map((c) => [c.identity, c.outcome]),
      [
        [a1.identity, "LAUNCHED"],
        [a1.identity, "ALREADY_EXISTS"],
        [a1.identity, "REFUSED IDENTITY_NOT_THE_ATTEMPTS"],
        ["kauro-attempt-not-a-uuid", "REFUSED IDENTITY_NOT_THE_ATTEMPTS"],
        [a2.identity, "AMBIGUOUS (created)"],
        [a2.identity, "ALREADY_EXISTS"],
        [a3.identity, "AMBIGUOUS (not created)"],
        [a4.identity, "AMBIGUOUS (not created)"],
        [a4.identity, "LAUNCHED"],
      ],
    );
  } finally {
    removeDir(root);
  }
});

test("the labelled worker-host fake reports the VM, disk and cost of each provider job it created, terminates only the identity it is given and answers NOT_FOUND for any other", async () => {
  const root = freshDir("worker-host-resources");
  const r = rig(root);
  const [a1, a2, a3] = [1, 2, 3].map((n) => attemptFixture(n));
  assert.ok(a1 !== undefined && a2 !== undefined && a3 !== undefined);
  try {
    // a1 runs for 90 s of the host's clock and succeeds
    const finish1 = r.host.holdNext("finish", a1.identity);
    await r.host.launch(a1.spec(1));
    await finish1.reached;
    r.clock.advance(90_000);
    finish1.release();
    await r.host.settled(a1.identity);
    // a2's agent dies before its manifest while its VM stays up: no heartbeat after that, its artifact and scratch left behind
    r.host.crashAt("manifest", a2.identity, "RUNNING");
    await r.host.launch(a2.spec(1));
    await r.host.settled(a2.identity);
    const crashedAt = r.clock.now();
    r.clock.advance(600_000);
    const dead = await r.host.observe(a2.identity);
    assert.equal(dead.state, "RUNNING");
    assert.equal(dead.lastHeartbeatAt, crashedAt, "the heartbeat stopped when the agent died");
    assert.equal((await objectsUnder(r, a2.prefix)).length, 1, "its artifact, and no manifest");
    assert.ok(existsSync(attemptScratchDirectoryOf(root, a2.attemptId)), "its scratch is left for the janitor");
    assert.equal(existsSync(attemptScratchDirectoryOf(root, a1.attemptId)), false, "a finished worker disposed its own");

    const limits = limitsOf();
    const machine = r.host.machine;
    const costOf = (runtimeMs: number): number => Math.ceil((runtimeMs * (machine.vmMicrosPerHour + machine.diskMicrosPerGibHour * (limits.hardScratchBytes / 2 ** 30))) / 3_600_000);
    const done = await r.host.resources(a1.identity);
    assert.ok(done.outcome === "REPORTED");
    assert.equal(done.evidenceClass, "SIMULATED");
    assert.equal(done.state, "SUCCEEDED");
    assert.equal(done.resources.machineType, CONTRACT_FAKE_WORKER_HOST_MACHINE_TYPE);
    assert.match(done.resources.machineType, /^contract-fake-worker-host-/);
    assert.equal(done.resources.vcpus, machine.vcpus);
    assert.equal(done.resources.memoryBytes, machine.memoryBytes);
    assert.equal(done.resources.diskBytes, limits.hardScratchBytes);
    assert.ok(done.resources.peakScratchBytes > 0, "the scratch the attempt really used");
    assert.equal(done.resources.runtimeMs, 90_000);
    assert.equal(done.resources.costMicros, costOf(90_000));
    assert.equal(done.resources.currency, "USD");

    const running = await r.host.resources(a2.identity);
    assert.ok(running.outcome === "REPORTED" && running.state === "RUNNING");
    assert.equal(running.resources.runtimeMs, 600_000, "a VM left running keeps costing");
    assert.equal(running.resources.costMicros, costOf(600_000));

    // termination of exactly the identity given; the finished job is not touched
    assert.equal((await r.host.terminate(a2.identity)).outcome, "TERMINATED");
    assert.equal((await r.host.observe(a1.identity)).state, "SUCCEEDED");
    assert.equal((await r.host.terminate(a1.identity)).outcome, "ALREADY_TERMINAL");
    r.clock.advance(3_600_000);
    const stopped = await r.host.resources(a2.identity);
    assert.ok(stopped.outcome === "REPORTED" && stopped.state === "TERMINATED");
    assert.equal(stopped.resources.runtimeMs, 600_000, "a terminated VM stops costing");

    // NOT_FOUND for every identity the host never created, whatever is asked
    for (const identity of [a3.identity, attemptIdentityOf(v7(3999)), "not-an-identity"]) {
      assert.deepEqual(await r.host.resources(identity), { evidenceClass: "SIMULATED", identity, outcome: "NOT_FOUND" });
      assert.equal((await r.host.observe(identity)).state, "NOT_FOUND");
      assert.equal((await r.host.terminate(identity)).outcome, "NOT_FOUND");
    }
    assert.deepEqual(
      r.host.calls("terminate").map((c) => [c.identity, c.outcome]),
      [
        [a2.identity, "TERMINATED"],
        [a1.identity, "ALREADY_TERMINAL"],
        [a3.identity, "NOT_FOUND"],
        [attemptIdentityOf(v7(3999)), "NOT_FOUND"],
        ["not-an-identity", "NOT_FOUND"],
      ],
    );
    assert.equal((await r.host.observe(a1.identity)).state, "SUCCEEDED");
  } finally {
    removeDir(root);
  }
});

test("the labelled worker-host fake runs each attempt inside its envelope: the real scratch store and writer decide S035's causes, a cancellation or a fence stops the worker before its manifest, a scripted termination answer is UNCERTAIN, and an old worker that survives a takeover writes only under its own prefix", async () => {
  const root = freshDir("worker-host-envelope");
  const r = rig(root);
  try {
    // scripted core faults end the job FAILED with that exact cause, no manifest, the worker's scratch disposed
    for (const [n, fault, cause] of [[1, "ENOSPC", "SCRATCH_EXHAUSTED"], [2, "SHORT_WRITE", "SHORT_WRITE"], [3, "CORRUPT_INTERMEDIATE", "CORRUPT_INTERMEDIATE"]] as const) {
      const a = attemptFixture(n);
      r.core.failNextExecute(fault);
      await r.host.launch(a.spec(1));
      await r.host.settled(a.identity);
      const failed = await r.host.observe(a.identity);
      assert.deepEqual([failed.state, failed.cause, failed.manifest], ["FAILED", cause, null]);
      assert.equal(await r.storage.stat(r.staging, a.capability.manifestObjectName), null);
      assert.equal(existsSync(attemptScratchDirectoryOf(root, a.attemptId)), false);
    }
    // the real quota decides: a scratch budget below one segment is SCRATCH_EXHAUSTED from AttemptScratchStore itself
    const tight = attemptFixture(4);
    await r.host.launch(tight.spec(1, limitsOf(16)));
    await r.host.settled(tight.identity);
    assert.deepEqual([(await r.host.observe(tight.identity)).state, (await r.host.observe(tight.identity)).cause], ["FAILED", "SCRATCH_EXHAUSTED"]);
    assert.deepEqual(await objectsUnder(r, tight.prefix), []);

    // the control plane's signal: CANCELLED before any artifact; FENCED after the artifact and before the manifest
    const cancelled = attemptFixture(5);
    r.host.signal(cancelled.identity, "CANCELLED");
    await r.host.launch(cancelled.spec(1));
    await r.host.settled(cancelled.identity);
    assert.equal((await r.host.observe(cancelled.identity)).cause, "CANCELLED");
    assert.deepEqual(await objectsUnder(r, cancelled.prefix), []);
    const fenced = attemptFixture(6);
    const beforeManifest = r.host.holdNext("manifest", fenced.identity);
    await r.host.launch(fenced.spec(1));
    await beforeManifest.reached;
    r.host.signal(fenced.identity, "FENCED");
    beforeManifest.release();
    await r.host.settled(fenced.identity);
    assert.deepEqual([(await r.host.observe(fenced.identity)).state, (await r.host.observe(fenced.identity)).cause], ["FAILED", "FENCED"]);
    assert.equal((await objectsUnder(r, fenced.prefix)).length, 1, "the artifact, never the manifest");

    // a termination whose answer is lost: UNCERTAIN, and the job was in fact terminated
    const uncertain = attemptFixture(9);
    const held = r.host.holdNext("start", uncertain.identity);
    await r.host.launch(uncertain.spec(1));
    await held.reached;
    r.host.scriptTermination(uncertain.identity, { applied: true });
    assert.equal((await r.host.terminate(uncertain.identity)).outcome, "UNCERTAIN");
    assert.equal((await r.host.observe(uncertain.identity)).state, "TERMINATED");
    await r.host.settled(uncertain.identity);

    // takeover: attempt 7 is held before its manifest and survives its termination; attempt 8 of the same job at fence 2
    // completes; then the old worker finishes, and all it can touch is its own prefix
    const old = attemptFixture(7);
    const current = attemptFixture(8, { job: 7 });
    r.host.survivesTermination(old.identity, { reportsAfterFinish: "SUCCEEDED" });
    const oldBeforeManifest = r.host.holdNext("manifest", old.identity);
    await r.host.launch(old.spec(1));
    await oldBeforeManifest.reached;
    assert.equal((await r.host.terminate(old.identity)).outcome, "TERMINATED");
    assert.equal((await r.host.observe(old.identity)).state, "TERMINATED");
    await r.host.launch(current.spec(2));
    await r.host.settled(current.identity);
    const currentReading = await manifestOf(r, current, 2);
    assert.ok(currentReading.ok);
    const currentObjects = await objectsUnder(r, current.prefix);
    oldBeforeManifest.release();
    await r.host.settled(old.identity);
    assert.equal((await r.host.observe(old.identity)).state, "SUCCEEDED", "the surviving worker's host even reports success");
    assert.deepEqual(await objectsUnder(r, current.prefix), currentObjects, "the current attempt's objects are untouched");
    const oldObjects = await objectsUnder(r, old.prefix);
    assert.equal(oldObjects.length, 2);
    const own = await manifestOf(r, old, 1);
    assert.ok(own.ok, "a valid package, under its own prefix, at its own fence");
    const asCurrent = await manifestOf(r, old, 2, current);
    assert.deepEqual(asCurrent, { ok: false, problem: "FOREIGN_ATTEMPT" }, "never the current attempt's manifest");
    const launched = [1, 2, 3, 4, 5, 6, 7, 9].map((n) => attemptFixture(n).prefix).concat(current.prefix);
    for (const object of await objectsUnder(r, "staging/")) assert.ok(launched.some((prefix) => object.startsWith(prefix)), object);
  } finally {
    removeDir(root);
  }
});
