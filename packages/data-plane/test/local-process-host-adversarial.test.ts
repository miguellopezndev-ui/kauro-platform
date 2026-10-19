// B14-A: the local executor under attack and failure (docs/design/B14-A-worker-executor.md §8, B14-A-recovery.md). Real worker
// processes started by LocalProcessWorkerHost — the migration worker (Migration Core 3.0.0 and the sandboxed Chromium) or, for the
// confinement, memory and channel cases, the hostile worker of support/hostile-worker.ts started exactly as the real one is.
// EXECUTED_LOCAL for the host, the processes and the core; B07's object storage stays its labelled CONTRACT FAKE (SIMULATED).
// Processes are observed through the operating system (Linux /proc, Windows CIM), never through the host's own word.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { writeSync as writeSyncOf } from "node:fs";
import { BROWSER_SOCKET_ROOT_MAX_BYTES, CALLS_HELD, HostRecordUnreadable, HostRootInUse, JobJournal, LOCAL_HOST_ISOLATION, LocalProcessWorkerHost, attemptScratchDirectoryOf, removeAttemptScratch, type LocalJobRecord, type LocalProcessWorkerHostOptions } from "../src/index.js";
import { collect, sha } from "./support/attempt.js";
import { BROWSER, BROWSER_REQUIRED, HOSTILE_ENTRY, REPO_ROOT, eventually, hostLimits, localRig, plantedAttempt, processesReferencing, readsFor, type LocalRig, type LocalRigOptions, type Planted } from "./support/local-host.js";

const skip = BROWSER === null && !BROWSER_REQUIRED ? "no Chromium-family browser (set KAURO_PDF_BROWSER)" : false;

function gate(): { promise: Promise<void>; open(): void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

const never = (): Promise<void> => new Promise<void>(() => undefined);

/** A rig whose host starts the hostile worker, its behaviour named in the ticket's render. */
function hostileRig(locale: string, rendererVersion = "x", more: LocalRigOptions = {}): Promise<LocalRig> {
  return localRig({ workerEntry: HOSTILE_ENTRY, render: { pageSize: "LETTER", locale, rendererVersion }, workerHeapMegabytes: 256, coreHeapMegabytes: 256, ...more });
}

/** What the control plane would read for a planted attempt the hostile worker runs (no report inputs: it never prints). */
function plainReads(rig: LocalRig, planted: Planted): void {
  rig.reads.set(planted.fixture.attemptId, { planBinding: { configDocument: planted.configDocument, coreConfigHash: planted.coreConfigHash }, inputs: planted.inputs, reportInputs: null });
}

const recordFile = (rig: LocalRig, identity: string): string => join(rig.hostRoot, "jobs", `${identity}.json`);

// --- identity, duplicates, lost answers, one host per root -------------------------------------------------------------------------

test("B14-A RACE (duplicate launch, redelivery, a second control plane): three concurrent launches of one identity create one job — one LAUNCHED, the others ALREADY_EXISTS (adopt) — exactly one worker process runs; a second host over the same root is refused while this one lives (HOST_ROOT_IN_USE); after a restart the record answers SUCCEEDED and a redelivery adopts", { skip }, async () => {
  const hold = gate();
  const rig = await localRig({ hooks: { atStage: (_id, stage) => (stage === "STARTED" ? hold.promise : undefined) } });
  try {
    const planted = plantedAttempt(rig.storage, 2);
    await readsFor(rig, planted);
    const spec = planted.fixture.spec(1);
    const answers = await Promise.all([rig.host.launch(spec), rig.host.launch(spec), rig.host.launch(spec)]);
    assert.deepEqual(answers.map((a) => a.outcome).sort(), ["ALREADY_EXISTS", "ALREADY_EXISTS", "LAUNCHED"]);
    await assert.rejects(LocalProcessWorkerHost.open(rig.options()), (e: unknown) => e instanceof HostRootInUse, "one live host per root");
    const attemptDir = attemptScratchDirectoryOf(realpathSync.native(rig.scratchRoot), planted.fixture.attemptId);
    const workers = (): number => processesReferencing(attemptDir).filter((pid) => processesReferencing("--ticket-digest").includes(pid)).length;
    assert.ok(await eventually(() => workers() === 1), "one worker process for the identity");
    hold.open();
    assert.equal((await rig.host.settled(spec.identity))?.state, "SUCCEEDED");
    assert.equal((await rig.host.launch(spec)).outcome, "ALREADY_EXISTS");
    const reopened = await rig.reopen();
    assert.equal((await reopened.observe(spec.identity)).state, "SUCCEEDED", "the next host reads the finished record as it is");
    assert.equal((await reopened.launch(spec)).outcome, "ALREADY_EXISTS", "a redelivery after the restart adopts");
    assert.deepEqual(readdirSync(join(rig.hostRoot, "jobs")), [`${spec.identity}.json`]);
  } finally {
    hold.open();
    await rig.dispose();
  }
});

test("B14-A RACE (lost answers, S056 at the host): a launch whose answer is lost has created exactly one job — observe finds it and a relaunch adopts it; a launch whose control-plane read failed created nothing — observe answers NOT_FOUND, no record exists, and the later launch is the only run", { skip }, async () => {
  const rig = await localRig();
  try {
    const planted = plantedAttempt(rig.storage, 3);
    await readsFor(rig, planted);
    const spec = planted.fixture.spec(1);
    // the answer of a launch that landed is lost: the caller knows nothing, the host knows the identity
    void rig.host.launch(spec).catch(() => undefined);
    assert.ok(await eventually(async () => (await rig.host.observe(spec.identity)).state !== "NOT_FOUND"));
    assert.equal((await rig.host.launch(spec)).outcome, "ALREADY_EXISTS");
    assert.equal((await rig.host.settled(spec.identity))?.state, "SUCCEEDED");

    // a launch that failed before it created anything (the control plane's read failed)
    const other = plantedAttempt(rig.storage, 4);
    const otherSpec = other.fixture.spec(1);
    await assert.rejects(rig.host.launch(otherSpec), /no reads/);
    assert.equal((await rig.host.observe(otherSpec.identity)).state, "NOT_FOUND");
    assert.equal(existsSync(recordFile(rig, otherSpec.identity)), false);
    await readsFor(rig, other);
    assert.equal((await rig.host.launch(otherSpec)).outcome, "LAUNCHED");
    assert.equal((await rig.host.settled(otherSpec.identity))?.state, "SUCCEEDED");
  } finally {
    await rig.dispose();
  }
});

test("B14-A DENY (incomplete or unsafe configuration): a spec that is not one attempt's own, a plan without its binding, inputs that are not the capability's sealed generations and limits past their bounds are REFUSED with nothing created; a host without its stated trust model, whose roots overlap the code a worker reads, or without its browser, is refused before it opens", { skip }, async () => {
  const rig = await localRig();
  try {
    const planted = plantedAttempt(rig.storage, 5);
    await readsFor(rig, planted);
    const spec = planted.fixture.spec(1);
    const other = plantedAttempt(rig.storage, 6);
    const refusedWith = async (s: typeof spec, reason: string, label: string): Promise<void> => {
      const answer = await rig.host.launch(s);
      assert.deepEqual([answer.outcome, answer.reason], ["REFUSED", reason], label);
      assert.equal(existsSync(recordFile(rig, s.identity)), false, `${label}: nothing created`);
    };
    await refusedWith({ ...spec, identity: other.fixture.identity }, "IDENTITY_NOT_THE_ATTEMPTS", "another attempt's identity");
    await refusedWith({ ...spec, capability: { ...spec.capability, stagingPrefix: other.fixture.prefix } }, "CAPABILITY_PREFIX_NOT_THE_ATTEMPTS", "another attempt's prefix");
    await refusedWith({ ...spec, limits: { ...spec.limits, hardMemoryBytes: 1024 * 1024 * 1024, memoryBudgetBytes: 512 * 1024 * 1024 } }, "MEMORY_PLAN_PAST_HARD_LIMIT", "two heaps and the browser past 1 GiB");
    await refusedWith({ ...spec, limits: { ...spec.limits, scratchBudgetBytes: spec.limits.hardScratchBytes + 1 } }, "SCRATCH_BUDGET_PAST_HARD_LIMIT", "scratch past its bound");
    await refusedWith({ ...spec, fence: 0 }, "FENCE_MALFORMED", "no fence");
    const reads = rig.reads.get(planted.fixture.attemptId)!;
    rig.reads.set(planted.fixture.attemptId, { ...reads, planBinding: null });
    await refusedWith(spec, "PLAN_BINDING_MISSING", "no plan binding");
    rig.reads.set(planted.fixture.attemptId, { ...reads, inputs: other.inputs });
    await refusedWith(spec, "INPUTS_NOT_THE_CAPABILITYS", "another revision's inputs");
    rig.reads.set(planted.fixture.attemptId, reads);

    const base = rig.options({ hostRoot: join(rig.root, "h2"), scratchRoot: join(rig.root, "s2") });
    const refused = (options: LocalProcessWorkerHostOptions, pattern: RegExp): Promise<void> => assert.rejects(LocalProcessWorkerHost.open(options), pattern);
    await refused({ ...base, isolation: "MULTI_TENANT" as typeof LOCAL_HOST_ISOLATION }, /isolation is not SINGLE_TENANT_QUALIFICATION/);
    await refused({ ...base, scratchRoot: join(REPO_ROOT, "scratch-inside-code") }, /scratchRoot overlaps a code root/);
    await refused({ ...base, hostRoot: join(rig.root, "s2", "host") }, /overlap/);
    await refused({ ...base, chromiumExecutable: join(rig.root, "no-browser.exe") }, /browser executable does not exist/);
    // the browser's directory is read by the worker too (review R8): it may not hold a private root
    const nested = join(rig.root, "browser-holds-roots");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "chrome.exe"), "");
    await refused({ ...base, chromiumExecutable: join(nested, "chrome.exe"), hostRoot: join(nested, "h3"), scratchRoot: join(rig.root, "s3") }, /hostRoot overlaps the browser's directory/);
    await refused({ ...base, codeRoots: [] }, /codeRoots/);
    await refused({ ...base, sessionOrigin: "http://plain" }, /sessionOrigin/);
    await refused({ ...base, corePackageHash: "unknown" as never }, /corePackageHash/);
    // POSIX: the browser binds a socket under the scratch root, and a socket's path is at most 107 bytes
    if (process.platform !== "win32") await refused({ ...base, scratchRoot: join(rig.root, "s".repeat(BROWSER_SOCKET_ROOT_MAX_BYTES)) }, /too long for the browser's socket path/);
    rmSync(join(REPO_ROOT, "scratch-inside-code"), { recursive: true, force: true });
  } finally {
    await rig.dispose();
  }
});

// --- confinement and limits ------------------------------------------------------------------------------------------------------------

test("B14-A DENY (confinement of the platform's code, hostile worker): a worker started exactly as the real one gets an empty environment without the host's secrets, cannot read another attempt's scratch, the host's records or any other file, cannot write outside its own attempt directory, cannot open a socket, fetch or resolve a name from its code, and its broker refuses another attempt's source and prefix and the delivery zone. RESIDUAL_LOCAL (B14-A-recovery.md §6): a native program it starts is outside the permission model — the local host is no boundary against a compromised worker; the cloud task is", async () => {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const rig = await hostileRig("hostile-probe");
  process.env["KAURO_TEST_SECRET_DATABASE_URL"] = "postgres://secret@127.0.0.1/never";
  try {
    const planted = plantedAttempt(rig.storage, 7);
    const neighbour = plantedAttempt(rig.storage, 8);
    plainReads(rig, planted);
    const otherScratch = attemptScratchDirectoryOf(realpathSync.native(rig.scratchRoot), neighbour.fixture.attemptId);
    mkdirSync(otherScratch, { recursive: true });
    writeFileSync(join(otherScratch, "customer.csv"), "another agency's rows");
    const secretFile = join(realpathSync.native(rig.root), "secret.txt");
    writeFileSync(secretFile, "a secret of the host");
    const hostRecords = join(realpathSync.native(rig.hostRoot), "jobs", `${neighbour.fixture.identity}.json`);
    writeFileSync(hostRecords, "another job's record");
    // the probe's targets travel in the ticket's render (the hostile worker reads them there): a host opened with them
    const probe = { port, neighbourObject: neighbour.inputs[0]!.objectName, neighbourGeneration: neighbour.inputs[0]!.generation, neighbourPrefix: neighbour.fixture.prefix, otherScratchFile: join(otherScratch, "customer.csv"), secretFile, hostRecords };
    const host = await rig.reopen({ render: { pageSize: "LETTER", locale: "hostile-probe", rendererVersion: JSON.stringify(probe) } });
    const spec = planted.fixture.spec(1);
    assert.equal((await host.launch(spec)).outcome, "LAUNCHED");
    const record = await host.settled(spec.identity);
    const seen = JSON.parse(record?.refusal ?? "{}") as Record<string, unknown>;
    const envKeys = seen["envKeys"] as string[];
    // the host passes SystemRoot alone; on Windows libuv adds the variables CreateProcess needs (its required_vars), none a credential
    const allowed = process.platform === "win32" ? new Set(["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR"]) : new Set<string>();
    assert.ok(envKeys.every((k) => allowed.has(k.toUpperCase())), `the worker's environment holds nothing of the host's: ${JSON.stringify(envKeys)}`);
    assert.ok(!envKeys.includes("KAURO_TEST_SECRET_DATABASE_URL"));
    for (const key of ["readOtherAttemptScratch", "readHostRecords", "readSecretFile", "writeOutsideOwnScratch", "writeHostRoot"]) assert.equal(seen[key], "ERR_ACCESS_DENIED", key);
    if (process.platform === "linux") assert.equal(seen["procEnvironOfHost"], "ERR_ACCESS_DENIED");
    for (const key of ["netConnect", "fetch", "dnsLookup"]) assert.equal(seen[key], "KAURO_NETWORK_REFUSED", key);
    assert.equal(connections, 0, "no byte reached the listening socket");
    for (const key of ["brokerForeignSource", "brokerForeignPrefix"]) assert.equal(seen[key], "OUTSIDE_CAPABILITY", key);
    // a zone outside the protocol's two is refused before the broker sees the call (review round 18, R18-1)
    assert.equal(seen["brokerDelivery"], "MALFORMED_CALL");
    assert.deepEqual(host.refusals(spec.identity).map((r) => r.code), ["OUTSIDE_CAPABILITY", "OUTSIDE_CAPABILITY", "MALFORMED_CALL"]);
    // the local limit, demonstrated: if this ever reads otherwise, an OS sandbox exists locally and B14-A-recovery.md §6 is out of date
    assert.equal(seen["nativeChildRead"], "READ", "RESIDUAL_LOCAL: a native child of the worker runs outside Node's permission model");
  } finally {
    delete process.env["KAURO_TEST_SECRET_DATABASE_URL"];
    server.close();
    await rig.dispose();
  }
});

test("B14-A limits (memory): a worker past its heap dies and the host records WORKER_CRASHED with MEMORY_EXHAUSTED (a takeover's cause, never a result the worker gave); the flag that bounds it is on its command line", async () => {
  const rig = await hostileRig("hostile-allocate", "x", { workerHeapMegabytes: 64 });
  try {
    const planted = plantedAttempt(rig.storage, 9);
    plainReads(rig, planted);
    const spec = planted.fixture.spec(1);
    assert.equal((await rig.host.launch(spec)).outcome, "LAUNCHED");
    const record = await rig.host.settled(spec.identity);
    assert.deepEqual([record?.state, record?.cause, record?.note], ["FAILED", "WORKER_CRASHED", "MEMORY_EXHAUSTED"]);
    assert.ok(record?.flags.includes("--max-old-space-size=64"));
  } finally {
    await rig.dispose();
  }
});

test("B14-A limits (disk): an attempt whose scratch budget cannot hold its package ends SCRATCH_EXHAUSTED — S035's terminal cause — with no manifest", { skip }, async () => {
  const rig = await localRig();
  try {
    const planted = plantedAttempt(rig.storage, 10);
    await readsFor(rig, planted);
    const spec = planted.fixture.spec(1, hostLimits(4096));
    assert.equal((await rig.host.launch(spec)).outcome, "LAUNCHED");
    const record = await rig.host.settled(spec.identity);
    assert.deepEqual([record?.state, record?.cause, record?.manifest], ["FAILED", "SCRATCH_EXHAUSTED", null], rig.host.diagnostics(spec.identity) ?? "");
    assert.equal(await rig.storage.stat(rig.storage.location("STAGING"), planted.fixture.capability.manifestObjectName), null);
  } finally {
    await rig.dispose();
  }
});

test("B14-A limits (time): past the attempt's wall clock the host kills the worker's tree itself and records DEADLINE_EXCEEDED — a terminal cause — whatever the worker was doing; a deadline already past ends the run before it asks the broker for anything", { skip }, async () => {
  const rig = await localRig({ maxWallClockMs: 1500, terminationGraceMs: 250, hooks: { atStage: (_id, s) => (s === "CORE_STARTED" ? never() : undefined) } });
  try {
    const planted = plantedAttempt(rig.storage, 14);
    await readsFor(rig, planted);
    const spec = planted.fixture.spec(1);
    const attemptDir = attemptScratchDirectoryOf(realpathSync.native(rig.scratchRoot), planted.fixture.attemptId);
    assert.equal((await rig.host.launch(spec)).outcome, "LAUNCHED");
    const record = await rig.host.settled(spec.identity);
    assert.deepEqual([record?.state, record?.cause, record?.note], ["FAILED", "DEADLINE_EXCEEDED", "DEADLINE"]);
    assert.ok(await eventually(() => processesReferencing(attemptDir).length === 0));

    const late = plantedAttempt(rig.storage, 15, { deadlineAt: new Date(Date.now() - 1000).toISOString() });
    await readsFor(rig, late);
    const lateSpec = late.fixture.spec(1);
    assert.equal((await rig.host.launch(lateSpec)).outcome, "LAUNCHED");
    const lateRecord = await rig.host.settled(lateSpec.identity);
    assert.deepEqual([lateRecord?.state, lateRecord?.cause], ["FAILED", "DEADLINE_EXCEEDED"]);
    assert.deepEqual(rig.host.refusals(lateSpec.identity), []);
  } finally {
    await rig.dispose();
  }
});

// --- termination, cancellation, recovery -------------------------------------------------------------------------------------------

async function terminatedAt(stage: "CORE_STARTED" | "PDF_STARTED" | "MANIFEST", n: number): Promise<void> {
  const reached = gate();
  const rig = await localRig({
    hooks: {
      atStage: (_id, s) => {
        if (s !== stage) return undefined;
        reached.open();
        // the PDF: let the browser start, so the termination meets it printing; the others are held where they stand
        return stage === "PDF_STARTED" ? undefined : never();
      },
    },
  });
  try {
    const planted = plantedAttempt(rig.storage, n);
    await readsFor(rig, planted);
    const spec = planted.fixture.spec(1);
    const attemptDir = attemptScratchDirectoryOf(realpathSync.native(rig.scratchRoot), planted.fixture.attemptId);
    assert.equal((await rig.host.launch(spec)).outcome, "LAUNCHED");
    await reached.promise;
    if (stage === "PDF_STARTED") assert.ok(await eventually(() => processesReferencing(join(attemptDir, "browser-tmp")).length > 0, 20_000, 20), "the browser is printing");
    assert.ok(processesReferencing(attemptDir).length > 0, `${stage}: the attempt's processes run`);
    const answer = await rig.host.terminate(spec.identity);
    assert.deepEqual([answer.outcome, answer.evidenceClass], ["TERMINATED", "EXECUTED_LOCAL"]);
    assert.ok(await eventually(() => processesReferencing(attemptDir).length === 0), `${stage}: no process of the attempt survives its termination (worker, core child, browser)`);
    const observed = await rig.host.observe(spec.identity);
    assert.deepEqual([observed.state, observed.manifest], ["TERMINATED", null]);
    assert.equal(await rig.storage.stat(rig.storage.location("STAGING"), planted.fixture.capability.manifestObjectName), null, `${stage}: no manifest, so nothing can be submitted`);
    assert.equal((await rig.host.terminate(spec.identity)).outcome, "ALREADY_TERMINAL");
    // what a dead process leaves (its scratch) is the janitor's: exactly that directory, removed
    assert.equal(existsSync(attemptDir), true);
    assert.equal(removeAttemptScratch(rig.scratchRoot, planted.fixture.attemptId), "REMOVED");
    assert.equal((await rig.host.resources(spec.identity)).outcome, "REPORTED");
  } finally {
    reached.open();
    await rig.dispose();
  }
}

test("B14-A terminate during processing (S075): terminating the identity as the core's stage begins ends the worker, revokes the broker, leaves no manifest and the attempt's scratch for the janitor (a tree with a hung child and a browser of its own: the boundary cases below)", { skip }, () => terminatedAt("CORE_STARTED", 11));
test("B14-A terminate during the PDF: terminating while Chromium prints kills the browser with the worker; no report is staged", { skip }, () => terminatedAt("PDF_STARTED", 12));
test("B14-A terminate during publication: terminating before the manifest is written leaves the staged package and report unpublishable (no manifest)", { skip }, () => terminatedAt("MANIFEST", 13));

test("B14-A cancellation (D8-CANCEL-1): the host's mirror of the lease reaches the worker's channel; a worker told CANCELLED or FENCED stops the core at its next check and ends with that cause, no manifest", { skip }, async () => {
  for (const [n, state] of [[16, "CANCELLED"], [17, "FENCED"]] as const) {
    const at = gate();
    const go = gate();
    const rig = await localRig({
      hooks: {
        atStage: (_id, s) => {
          if (s !== "CORE_STARTED") return undefined;
          at.open();
          return go.promise;
        },
      },
    });
    try {
      const planted = plantedAttempt(rig.storage, n);
      await readsFor(rig, planted);
      const spec = planted.fixture.spec(1);
      assert.equal((await rig.host.launch(spec)).outcome, "LAUNCHED");
      await at.promise;
      assert.equal(rig.host.signal(spec.identity, state), true);
      go.open();
      const record = await rig.host.settled(spec.identity);
      assert.deepEqual([record?.state, record?.cause, record?.manifest], ["FAILED", state, null], state);
    } finally {
      go.open();
      await rig.dispose();
    }
  }
});

test("B14-A terminate (review R1, R3, R7): the attempt's whole tree ends with its boundary — a worker holding a Node child stuck in synchronous work and a browser started in a session of its own (as Playwright starts one) is terminated, and every process of the attempt, each observed running first, is gone (OS-checked); no process is signalled by its number", { skip }, async () => {
  const reached = gate();
  const rig = await hostileRig("hostile-tree", "x", { hooks: { atStage: (_id, s) => (s === "CORE_STARTED" ? (reached.open(), never()) : undefined) } });
  try {
    const planted = plantedAttempt(rig.storage, 56);
    plainReads(rig, planted);
    const spec = planted.fixture.spec(1);
    const attemptDir = attemptScratchDirectoryOf(realpathSync.native(rig.scratchRoot), planted.fixture.attemptId);
    assert.equal((await rig.host.launch(spec)).outcome, "LAUNCHED");
    await reached.promise;
    // the worker, its stuck child, and the browser with at least one process of its own
    assert.ok(await eventually(() => processesReferencing(attemptDir).length >= 4, 20_000), `the tree runs: ${processesReferencing(attemptDir).length} processes`);
    const before = processesReferencing(attemptDir);
    assert.equal((await rig.host.terminate(spec.identity)).outcome, "TERMINATED");
    assert.ok(await eventually(() => processesReferencing(attemptDir).length === 0, 20_000), `every process of the attempt ended: ${processesReferencing(attemptDir).length} of ${before.length} left`);
  } finally {
    reached.open();
    await rig.dispose();
  }
});

/** Runs support/host-process.js over `root` (a control plane in a process of its own) and answers what it launched once it holds. */
async function dyingHost(root: string, hostile?: string): Promise<{ readonly child: ReturnType<typeof spawn>; readonly dead: Promise<unknown>; readonly started: { outcome: string; identity: string; pid: number; attemptDir: string; spec: Parameters<LocalProcessWorkerHost["launch"]>[0] } }> {
  const script = join(dirname(fileURLToPath(import.meta.url)), "support", "host-process.js");
  const child = spawn(process.execPath, [script, root, ...(hostile === undefined ? [] : [hostile])], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env } });
  // the host's process gone (reaped): only then has the kernel released its root's lock
  const dead = new Promise((resolve) => child.once("exit", resolve));
  const line = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const at = buffer.indexOf("\n");
      if (at >= 0) resolve(buffer.slice(0, at));
    });
    child.on("exit", (code) => reject(new Error(`the host process exited early (${code})`)));
  });
  return { child, dead, started: JSON.parse(line) as never };
}

test("B14-A recovery (the control plane dies): the host process is killed while its worker runs; the operating system ends the worker with it, and the next host over the same roots — free to open the moment the dead one is gone — answers the identity from its durable record: FAILED WORKER_CRASHED (HOST_RESTARTED), never NOT_FOUND, adopts a relaunch (ALREADY_EXISTS) without running it again, and terminates nothing twice", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "kauro-b14a-restart-"));
  const { child, dead, started } = await dyingHost(root);
  try {
    assert.equal(started.outcome, "LAUNCHED");
    assert.ok(processesReferencing(started.attemptDir).length > 0, "the worker runs");
    // the control plane dies: its process alone, never its tree
    child.kill("SIGKILL");
    await dead;
    assert.ok(await eventually(() => processesReferencing(started.attemptDir).length === 0, 30_000), "the worker and what it started ended with their host");
    const rig = await localRig({ root });
    try {
      const observed = await rig.host.observe(started.identity);
      assert.deepEqual([observed.state, observed.cause], ["FAILED", "WORKER_CRASHED"]);
      assert.equal(rig.host.record(started.identity)?.note, "HOST_RESTARTED");
      assert.equal((await rig.host.launch(started.spec)).outcome, "ALREADY_EXISTS", "a relaunch of the identity adopts; nothing runs twice");
      assert.equal((await rig.host.terminate(started.identity)).outcome, "ALREADY_TERMINAL");
      assert.equal(processesReferencing(started.attemptDir).length, 0);
    } finally {
      await rig.dispose();
    }
  } finally {
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("B14-A recovery (review R2, R3, R7): the host dies while its attempt's tree holds a Node child stuck in synchronous work and a browser in a session of its own; the kernel ends the whole tree with the host, and the next host answers FAILED WORKER_CRASHED (HOST_RESTARTED)", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "kauro-b14a-tree-"));
  const { child, dead, started } = await dyingHost(root, "hostile-tree");
  try {
    assert.ok(await eventually(() => processesReferencing(started.attemptDir).length >= 4, 20_000), "the tree runs");
    child.kill("SIGKILL");
    await dead;
    assert.ok(await eventually(() => processesReferencing(started.attemptDir).length === 0, 30_000), "the whole tree ended with its host");
    const rig = await localRig({ root });
    try {
      assert.deepEqual([rig.host.record(started.identity)?.state, rig.host.record(started.identity)?.note], ["FAILED", "HOST_RESTARTED"]);
    } finally {
      await rig.dispose();
    }
  } finally {
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("B14-A recovery (review R7): the host dies while its worker is stuck in synchronous work — no handler of the worker can run — and the kernel ends the worker all the same (Windows: the host's kill-on-close job object; Linux: the worker's parent-death signal); the next host answers FAILED WORKER_CRASHED (HOST_RESTARTED)", async () => {
  const root = mkdtempSync(join(tmpdir(), "kauro-b14a-spin-"));
  const { child, dead, started } = await dyingHost(root, "hostile-spin");
  try {
    assert.ok(await eventually(() => processesReferencing(started.attemptDir).length > 0));
    child.kill("SIGKILL");
    await dead;
    assert.ok(await eventually(() => processesReferencing(started.attemptDir).length === 0, 30_000), "the stuck worker ended with its host");
    const rig = await localRig({ root });
    try {
      assert.deepEqual([rig.host.record(started.identity)?.state, rig.host.record(started.identity)?.cause, rig.host.record(started.identity)?.note], ["FAILED", "WORKER_CRASHED", "HOST_RESTARTED"]);
    } finally {
      await rig.dispose();
    }
  } finally {
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

// --- B13 and source integrity ---------------------------------------------------------------------------------------------------------

test("B14-A B13: the absent legal identity still blocks the report — a worker whose platform inputs carry no issuer document ends REFUSED (REPORT_ISSUER_UNAVAILABLE) with no manifest, the package's files kept as evidence and no PDF staged", { skip }, async () => {
  const rig = await localRig();
  try {
    const planted = plantedAttempt(rig.storage, 18);
    await readsFor(rig, planted, (inputs) => {
      const terms = inputs.terms as Extract<NonNullable<typeof inputs.terms>, { binding: "QUOTE_TERMS_V1" }>;
      return { ...inputs, terms: { ...terms, issuer: terms.issuer === null ? null : { ...terms.issuer, identity: null } } };
    });
    const spec = planted.fixture.spec(1);
    assert.equal((await rig.host.launch(spec)).outcome, "LAUNCHED");
    const record = await rig.host.settled(spec.identity);
    assert.deepEqual([record?.state, record?.cause, record?.refusal, record?.manifest], ["FAILED", "REFUSED", "REPORT_ISSUER_UNAVAILABLE", null]);
    const staging = rig.storage.location("STAGING");
    const staged = await rig.storage.list(staging, planted.fixture.prefix);
    assert.ok(staged.objects.length > 3, "the package's files stay as evidence for the janitor");
    for (const o of staged.objects) assert.notEqual((await collect(rig.storage.read(staging, o.objectName, o.generation))).subarray(0, 5).toString("latin1"), "%PDF-");
  } finally {
    await rig.dispose();
  }
});

test("B14-A DENY (sealed source): a sealed generation replaced after the seal, or bytes that are not the seal's digest, end the attempt SOURCE_INTEGRITY_FAILED — S035's terminal cause — and nothing is staged", { skip }, async () => {
  const rig = await localRig();
  try {
    const replaced = plantedAttempt(rig.storage, 19);
    await readsFor(rig, replaced);
    rig.storage.plantObject(rig.storage.location("ACCEPTED"), replaced.inputs[0]!.objectName, Buffer.from("Id,Email,Name\n9,z@example.com,Zed\n"), { overwrite: true });
    const spec = replaced.fixture.spec(1);
    assert.equal((await rig.host.launch(spec)).outcome, "LAUNCHED");
    const first = await rig.host.settled(spec.identity);
    assert.deepEqual([first?.state, first?.cause], ["FAILED", "SOURCE_INTEGRITY_FAILED"]);

    // a seal that names another digest than the bytes the generation holds
    const forged = plantedAttempt(rig.storage, 20);
    const lie = { ...forged.inputs[0]!, sha256: sha("not the bytes") };
    const capability = { ...forged.fixture.capability, acceptedGenerations: [{ objectName: lie.objectName, generation: lie.generation, sha256: lie.sha256, byteLength: lie.byteLength }] };
    rig.reads.set(forged.fixture.attemptId, { planBinding: { configDocument: forged.configDocument, coreConfigHash: forged.coreConfigHash }, inputs: [lie], reportInputs: null });
    const forgedSpec = { ...forged.fixture.spec(1), capability };
    assert.equal((await rig.host.launch(forgedSpec)).outcome, "LAUNCHED");
    const second = await rig.host.settled(forgedSpec.identity);
    assert.deepEqual([second?.state, second?.cause], ["FAILED", "SOURCE_INTEGRITY_FAILED"]);
    for (const p of [replaced.fixture.prefix, forged.fixture.prefix]) assert.deepEqual((await rig.storage.list(rig.storage.location("STAGING"), p)).objects, []);
  } finally {
    await rig.dispose();
  }
});

// --- the bounded launch, termination without waiting, the record's durability ------------------------------------------------------

test("B14-A RACE (review R3, R2-4): launches whose records are still being read create nothing when their identity is terminated meanwhile, or when the read outlasts its bound (half the creation horizon) — the identity is proved absent, and the tombstone keeps it absent across a restart", async () => {
  const releases: Array<() => void> = [];
  const release = (): void => releases.splice(0).forEach((r) => r());
  const rig = await localRig({ creationHorizonSeconds: 2 });
  try {
    const planted = plantedAttempt(rig.storage, 32);
    const late = plantedAttempt(rig.storage, 33);
    const reads = { planBinding: { configDocument: planted.configDocument, coreConfigHash: planted.coreConfigHash }, inputs: planted.inputs, reportInputs: null };
    await rig.host.stop();
    const host = await LocalProcessWorkerHost.open(rig.options({ creationHorizonSeconds: 2, tickets: { read: (spec) => new Promise((resolve) => void releases.push(() => resolve((spec.capability.attemptId === planted.fixture.attemptId ? reads : { ...reads, inputs: late.inputs }) as never))) } }));
    try {
      const spec = planted.fixture.spec(1);
      // two launches of the identity pending at once: the second is the first's redelivery, and the termination abandons both
      const launching = [host.launch(spec), host.launch(spec)];
      assert.equal((await host.observe(spec.identity)).state, "NOT_FOUND");
      assert.equal((await host.terminate(spec.identity)).outcome, "NOT_FOUND", "nothing exists, and the pending launch is abandoned");
      release();
      await Promise.all(launching.map((l) => assert.rejects(l, /abandoned before its create/)));
      assert.equal((await host.observe(spec.identity)).state, "NOT_FOUND");
      assert.equal((await host.resources(spec.identity)).outcome, "NOT_FOUND");
      assert.equal((await host.launch(spec)).outcome, "REFUSED", "the identity is taken for good");
      assert.equal((await host.terminate(spec.identity)).outcome, "NOT_FOUND");
      // a read past its bound (half the 2 s horizon): the launch fails and nothing is ever created by it
      const lateSpec = late.fixture.spec(1);
      await assert.rejects(host.launch(lateSpec), /not read within 1000 ms/);
      release();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(existsSync(recordFile(rig, lateSpec.identity)), false);
    } finally {
      await host.stop();
    }
    const next = await rig.reopen();
    assert.deepEqual(await next.launch(planted.fixture.spec(1)).then((a) => [a.outcome, a.reason]), ["REFUSED", "IDENTITY_TERMINATED"], "the tombstone outlives its host");
    assert.equal((await next.observe(planted.fixture.identity)).state, "NOT_FOUND");
  } finally {
    release();
    await rig.dispose();
  }
});

test("B14-A terminate (review R6): a worker whose storage call never answers is still ended at once by its termination — the broker closes, the tree is killed and the end recorded without waiting for the provider", { skip }, async () => {
  const blocked = gate();
  const rig = await localRig({ hooks: { beforeCall: (_id, call) => (call.op === "storage.readNext" ? (blocked.open(), never()) : undefined) } });
  try {
    const planted = plantedAttempt(rig.storage, 34);
    await readsFor(rig, planted);
    const spec = planted.fixture.spec(1);
    const attemptDir = attemptScratchDirectoryOf(realpathSync.native(rig.scratchRoot), planted.fixture.attemptId);
    assert.equal((await rig.host.launch(spec)).outcome, "LAUNCHED");
    await blocked.promise;
    assert.equal((await rig.host.terminate(spec.identity)).outcome, "TERMINATED");
    assert.equal((await rig.host.observe(spec.identity)).state, "TERMINATED");
    assert.ok(await eventually(() => processesReferencing(attemptDir).length === 0, 20_000));
    const record = await rig.host.settled(spec.identity);
    assert.deepEqual([record?.state, record?.note], ["TERMINATED", "TERMINATED_BY_HOST"], "the exit never overwrites the termination");
  } finally {
    blocked.open();
    await rig.dispose();
  }
});

test("B14-A records (review R9-1, R10-2, R11-3, the later audit): the next host reads the root once — a record it cannot read answers the host's transient failure for that identity alone (observe, resources, terminate and launch), never NOT_FOUND and never an end; a temporary file of a host that died mid-write is discarded; an unfinished record ends HOST_RESTARTED; a name that is no identity is never written; a stopped host answers nothing more", async () => {
  const rig = await localRig();
  try {
    const unreadable = plantedAttempt(rig.storage, 41);
    const unfinished = plantedAttempt(rig.storage, 42);
    const fine = plantedAttempt(rig.storage, 43);
    await rig.host.stop();
    const jobs = join(rig.hostRoot, "jobs");
    writeFileSync(join(jobs, `${unreadable.fixture.identity}.json`), "");
    const record = { host: "kauro-local-process-host", identity: unfinished.fixture.identity, ticketDigest: "0".repeat(64), state: "RUNNING", pid: 999_999, createdAtMs: 1, startedAtMs: 2, endedAtMs: null, lastHeartbeatMs: 2, cause: null, note: null, manifest: null, refusal: null, peakScratchBytes: 0, peakMemoryBytes: 0, flags: [], hardMemoryBytes: 1, hardScratchBytes: 1 };
    writeFileSync(join(jobs, `${unfinished.fixture.identity}.json`), JSON.stringify(record));
    writeFileSync(join(jobs, `${fine.fixture.identity}.json.tmp`), "{\"half");
    const host = await rig.reopen();
    const id = unreadable.fixture.identity;
    const transient = (e: unknown): boolean => e instanceof HostRecordUnreadable && e.transient === true;
    await assert.rejects(host.observe(id), transient);
    await assert.rejects(host.resources(id), transient);
    await assert.rejects(host.terminate(id), transient);
    await assert.rejects(host.launch(unreadable.fixture.spec(1)), transient);
    const ended = await host.observe(unfinished.fixture.identity);
    assert.deepEqual([ended.state, ended.cause, host.record(unfinished.fixture.identity)?.note], ["FAILED", "WORKER_CRASHED", "HOST_RESTARTED"]);
    assert.equal(existsSync(join(jobs, `${fine.fixture.identity}.json.tmp`)), false);
    assert.equal((await host.observe(fine.fixture.identity)).state, "NOT_FOUND");
    // a name that is no attempt's identity is never one the root holds, and is never written as one
    assert.equal((await host.terminate("../../escape")).outcome, "NOT_FOUND");
    assert.deepEqual(readdirSync(dirname(rig.hostRoot)).filter((n) => n.startsWith("escape")), []);
    // a stopped host answers nothing more: the next one holds the root
    const next = await rig.reopen();
    await assert.rejects(host.observe(fine.fixture.identity), /the host is stopped/);
    assert.equal((await next.observe(unfinished.fixture.identity)).state, "FAILED");
  } finally {
    await rig.dispose();
  }
});

test("B14-A records (review R5): a record is written whole or not at all — a write that makes partial progress is continued to the last byte; one that makes none fails, leaving the previous version as it was", () => {
  const dir = mkdtempSync(join(tmpdir(), "kauro-b14a-journal-"));
  try {
    const identity = "kauro-attempt-0192b000-0000-7000-8000-000000000001";
    const record: LocalJobRecord = { host: "kauro-local-process-host", identity, ticketDigest: "0".repeat(64) as never, state: "QUEUED", pid: null, createdAtMs: 1, startedAtMs: null, endedAtMs: null, lastHeartbeatMs: null, cause: null, note: null, manifest: null, refusal: null, peakScratchBytes: 0, peakMemoryBytes: 0, flags: ["--permission"], hardMemoryBytes: 1, hardScratchBytes: 1 };
    // three bytes at a time: every write a short one
    const short = new JobJournal(dir, (fd, bytes, offset, length) => writeSyncOf(fd, bytes, offset, Math.min(3, length)));
    short.write(record);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, `${identity}.json`), "utf8")), record);
    // no progress: the write fails, and the version on disk is the previous one, whole
    const stuck = new JobJournal(dir, () => 0);
    assert.throws(() => stuck.write({ ...record, state: "RUNNING" }), /made no progress/);
    assert.equal(JSON.parse(readFileSync(join(dir, `${identity}.json`), "utf8")).state, "QUEUED");
    assert.deepEqual(readdirSync(dir), [`${identity}.json`], "no temporary file left");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the channel (review rounds 16–21): a worker outside the protocol ends its attempt, never the host -------------------------------

test("B14-A DENY (the channel, review R20-1, R21-1, R21-2): bytes that are no frame, a frame declaring a 4 GiB body (refused from its prefix, before any of it is held), a header that is not UTF-8 JSON, and a well-framed message that is not the protocol's (Node's own IPC command, a call without an id) each end the attempt FAILED WORKER_ERROR, CHANNEL_PROTOCOL_VIOLATION — the host lives on and answers", async () => {
  for (const [n, locale] of [[51, "hostile-garbage"], [52, "hostile-huge"], [53, "hostile-header"], [54, "hostile-message"]] as const) {
    const rig = await hostileRig(locale);
    try {
      const planted = plantedAttempt(rig.storage, n);
      plainReads(rig, planted);
      const spec = planted.fixture.spec(1);
      assert.equal((await rig.host.launch(spec)).outcome, "LAUNCHED");
      const record = await rig.host.settled(spec.identity);
      assert.deepEqual([record?.state, record?.cause, record?.note], ["FAILED", "WORKER_ERROR", "CHANNEL_PROTOCOL_VIOLATION"], locale);
      // this process is the host: it is still here to say so
      assert.equal((await rig.host.observe(spec.identity)).state, "FAILED");
    } finally {
      await rig.dispose();
    }
  }
});

test("B14-A limits (the channel, review R16-1, R19-1): a worker that stops reading its channel and keeps asking makes the host hold no more than CALLS_HELD calls — it stops reading the worker in turn, so nothing queues — and the attempt is still ended at once by its termination", async () => {
  const rig = await hostileRig("hostile-nodrain");
  try {
    const planted = plantedAttempt(rig.storage, 55);
    plainReads(rig, planted);
    const spec = planted.fixture.spec(1);
    assert.equal((await rig.host.launch(spec)).outcome, "LAUNCHED");
    assert.ok(await eventually(() => rig.host.heldCalls(spec.identity) === CALLS_HELD, 20_000), "the host holds its bound of calls");
    const heap = process.memoryUsage().heapUsed;
    await new Promise((r) => setTimeout(r, 2_000));
    assert.equal(rig.host.heldCalls(spec.identity), CALLS_HELD, "and no more, however long the worker asks");
    assert.ok(process.memoryUsage().heapUsed - heap < 64 * 1024 * 1024, "the host's own memory does not grow with the worker's asking");
    assert.equal((await rig.host.observe(spec.identity)).state, "RUNNING");
    assert.equal((await rig.host.terminate(spec.identity)).outcome, "TERMINATED");
    assert.equal((await rig.host.settled(spec.identity))?.state, "TERMINATED");
  } finally {
    await rig.dispose();
  }
});
