// B14-A: the local executor under attack and failure (docs/design/B14-A-worker-executor.md §8). Real worker processes started by
// LocalProcessWorkerHost — the migration worker (Migration Core 3.0.0 and the sandboxed Chromium) or, for the confinement and memory
// cases, the hostile worker of support/hostile-worker.ts started exactly as the real one is. EXECUTED_LOCAL for the host, the processes
// and the core; B07's object storage stays its labelled CONTRACT FAKE (SIMULATED). Processes are observed through the operating
// system (Linux /proc, Windows CIM), never through the host's own word.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { toUtcInstant } from "@kauro/domain";
import { BROWSER_SOCKET_ROOT_MAX_BYTES, LocalProcessWorkerHost, attemptScratchDirectoryOf, linuxAttemptProcesses, processRunning, removeAttemptScratch, sweepAttemptProcesses, type LocalProcessWorkerHostOptions } from "../src/index.js";
import { collect, holderOf, sha } from "./support/attempt.js";
import { BROWSER, BROWSER_REQUIRED, CORE_PACKAGE_HASH, HOSTILE_ENTRY, RENDER, REPO_ROOT, WALL, WORKER_ENTRY, eventually, hostLimits, localRig, plantedAttempt, processesReferencing, readsFor, type LocalRig } from "./support/local-host.js";

const skip = BROWSER === null && !BROWSER_REQUIRED ? "no Chromium-family browser (set KAURO_PDF_BROWSER)" : false;

function gate(): { promise: Promise<void>; open(): void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

const never = (): Promise<void> => new Promise<void>(() => undefined);

function ticketsOf(rig: LocalRig): LocalProcessWorkerHostOptions["tickets"] {
  return { read: (spec) => Promise.resolve(rig.reads.get(spec.capability.attemptId) as never) };
}

/** A second host over the rig's roots that starts the hostile worker, its behaviour named in the ticket's render. */
function hostileHost(rig: LocalRig, render: LocalProcessWorkerHostOptions["render"], workerHeapMegabytes = 256, more: Partial<LocalProcessWorkerHostOptions> = {}): LocalProcessWorkerHost {
  return new LocalProcessWorkerHost({
    workerEntry: HOSTILE_ENTRY,
    codeRoots: [REPO_ROOT],
    hostRoot: rig.hostRoot,
    scratchRoot: rig.scratchRoot,
    chromiumExecutable: BROWSER ?? process.execPath,
    storage: rig.storage,
    uploads: holderOf(rig.storage),
    tickets: ticketsOf(rig),
    render,
    corePackageHash: CORE_PACKAGE_HASH,
    clock: WALL,
    sessionOrigin: "https://app.kauro.test",
    workerHeapMegabytes,
    coreHeapMegabytes: 256,
    ...more,
  });
}

// --- identity, duplicates, lost answers, refusals ------------------------------------------------------------------------------------

test("B14-A RACE (duplicate launch, redelivery, a second host): three concurrent launches of one identity create one job — one LAUNCHED, the others ALREADY_EXISTS (adopt) — a second host over the same root adopts it too, exactly one worker process runs, and it ends SUCCEEDED once", { skip }, async () => {
  const hold = gate();
  const rig = localRig({ hooks: { atStage: (_id, stage) => (stage === "STARTED" ? hold.promise : undefined) } });
  try {
    const planted = plantedAttempt(rig.storage, 2);
    await readsFor(rig, planted);
    const spec = planted.fixture.spec(1);
    const answers = await Promise.all([rig.host.launch(spec), rig.host.launch(spec), rig.host.launch(spec)]);
    assert.deepEqual(answers.map((a) => a.outcome).sort(), ["ALREADY_EXISTS", "ALREADY_EXISTS", "LAUNCHED"]);
    const second = rig.restart();
    assert.equal((await second.launch(spec)).outcome, "ALREADY_EXISTS", "a redelivery to another host instance adopts the same job");
    const attemptDir = attemptScratchDirectoryOf(realpathSync.native(rig.scratchRoot), planted.fixture.attemptId);
    const workers = (): number => processesReferencing(attemptDir).filter((pid) => processesReferencing("--ticket-digest").includes(pid)).length;
    assert.ok(await eventually(() => workers() === 1), "one worker process for the identity");
    hold.open();
    assert.equal((await rig.host.settled(spec.identity))?.state, "SUCCEEDED");
    assert.equal((await second.observe(spec.identity)).state, "SUCCEEDED", "another instance reads the finished record as it is");
    assert.deepEqual(readdirSync(join(rig.hostRoot, "jobs")), [spec.identity]);
  } finally {
    hold.open();
    await rig.dispose();
  }
});

test("B14-A RACE (two live control planes over one root): another live instance answers a running job as RUNNING — never as crashed — and its termination kills the worker by pid; the end it records first stands, and the running instance's own later reading of the exit adopts it instead of overwriting it", { skip }, async () => {
  const hold = gate();
  const rig = localRig({ hooks: { atStage: (_id, stage) => (stage === "CORE_STARTED" ? (hold.open(), never()) : undefined) } });
  try {
    const planted = plantedAttempt(rig.storage, 21);
    await readsFor(rig, planted);
    const spec = planted.fixture.spec(1);
    assert.equal((await rig.host.launch(spec)).outcome, "LAUNCHED");
    await hold.promise;
    const other = rig.restart();
    assert.equal((await other.observe(spec.identity)).state, "RUNNING", "a live instance's job is not judged lost");
    assert.equal((await other.terminate(spec.identity)).outcome, "TERMINATED");
    const ended = await rig.host.settled(spec.identity);
    assert.deepEqual([ended?.state, ended?.note], ["TERMINATED", "TERMINATED_BY_HOST"], "the first end recorded stands");
    assert.equal((await other.observe(spec.identity)).state, "TERMINATED");
    const attemptDir = attemptScratchDirectoryOf(realpathSync.native(rig.scratchRoot), planted.fixture.attemptId);
    assert.ok(await eventually(() => processesReferencing(attemptDir).length === 0));
  } finally {
    hold.open();
    await rig.dispose();
  }
});

test("B14-A RACE (lost answers, S056 at the host): a launch whose answer is lost has created exactly one job — observe finds it and a relaunch adopts it; a launch whose control-plane read failed created nothing — observe answers NOT_FOUND, no directory exists, and the later launch is the only run", { skip }, async () => {
  const rig = localRig();
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
    assert.equal(existsSync(join(rig.hostRoot, "jobs", otherSpec.identity)), false);
    await readsFor(rig, other);
    assert.equal((await rig.host.launch(otherSpec)).outcome, "LAUNCHED");
    assert.equal((await rig.host.settled(otherSpec.identity))?.state, "SUCCEEDED");
  } finally {
    await rig.dispose();
  }
});

test("B14-A DENY (incomplete or unsafe configuration): a spec that is not one attempt's own, a plan without its binding, inputs that are not the capability's sealed generations and limits past their bounds are REFUSED with nothing created; a host whose roots overlap the code a worker reads, or without its browser, is refused before it exists", { skip }, async () => {
  const rig = localRig();
  try {
    const planted = plantedAttempt(rig.storage, 5);
    await readsFor(rig, planted);
    const spec = planted.fixture.spec(1);
    const other = plantedAttempt(rig.storage, 6);
    const refusedWith = async (s: typeof spec, reason: string, label: string): Promise<void> => {
      const answer = await rig.host.launch(s);
      assert.deepEqual([answer.outcome, answer.reason], ["REFUSED", reason], label);
      assert.equal(existsSync(join(rig.hostRoot, "jobs", s.identity)), false, `${label}: nothing created`);
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

    const base: LocalProcessWorkerHostOptions = { workerEntry: WORKER_ENTRY, codeRoots: [REPO_ROOT], hostRoot: join(rig.root, "h2"), scratchRoot: join(rig.root, "s2"), chromiumExecutable: BROWSER!, storage: rig.storage, uploads: holderOf(rig.storage), tickets: { read: () => Promise.reject(new Error("unused")) }, render: RENDER, corePackageHash: CORE_PACKAGE_HASH, clock: WALL, sessionOrigin: "https://app.kauro.test" };
    assert.throws(() => new LocalProcessWorkerHost({ ...base, scratchRoot: join(REPO_ROOT, "scratch-inside-code") }), /scratchRoot overlaps a code root/);
    assert.throws(() => new LocalProcessWorkerHost({ ...base, hostRoot: join(rig.root, "s2", "host") }), /overlap/);
    assert.throws(() => new LocalProcessWorkerHost({ ...base, chromiumExecutable: join(rig.root, "no-browser.exe") }), /browser executable does not exist/);
    assert.throws(() => new LocalProcessWorkerHost({ ...base, codeRoots: [] }), /codeRoots/);
    assert.throws(() => new LocalProcessWorkerHost({ ...base, sessionOrigin: "http://plain" }), /sessionOrigin/);
    assert.throws(() => new LocalProcessWorkerHost({ ...base, corePackageHash: "unknown" as never }), /corePackageHash/);
    // POSIX: the browser binds a socket under the scratch root, and a socket's path is at most 107 bytes
    if (process.platform !== "win32") assert.throws(() => new LocalProcessWorkerHost({ ...base, scratchRoot: join(rig.root, "s".repeat(BROWSER_SOCKET_ROOT_MAX_BYTES)) }), /too long for the browser's socket path/);
    rmSync(join(REPO_ROOT, "scratch-inside-code"), { recursive: true, force: true });
  } finally {
    await rig.dispose();
  }
});

// --- confinement and limits ------------------------------------------------------------------------------------------------------------

test("B14-A DENY (confinement, hostile worker): a worker started exactly as the real one gets an empty environment without the host's secrets, cannot read another attempt's scratch, another job's ticket or any other file, cannot write outside its own attempt directory, cannot open a socket, fetch or resolve a name, and its broker refuses another attempt's source and prefix and the delivery zone; it may start no program but the core's confined Node child and the named browser", async () => {
  const rig = localRig();
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  process.env["KAURO_TEST_SECRET_DATABASE_URL"] = "postgres://secret@127.0.0.1/never";
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const planted = plantedAttempt(rig.storage, 7);
    const neighbour = plantedAttempt(rig.storage, 8);
    rig.reads.set(planted.fixture.attemptId, { planBinding: { configDocument: planted.configDocument, coreConfigHash: planted.coreConfigHash }, inputs: planted.inputs, reportInputs: null });
    const scratch = realpathSync.native(rig.scratchRoot);
    const otherScratch = attemptScratchDirectoryOf(scratch, neighbour.fixture.attemptId);
    mkdirSync(otherScratch, { recursive: true });
    writeFileSync(join(otherScratch, "customer.csv"), "another agency's rows");
    const otherTicket = join(realpathSync.native(rig.hostRoot), "jobs", neighbour.fixture.identity, "ticket.json");
    mkdirSync(dirname(otherTicket), { recursive: true });
    writeFileSync(otherTicket, "another job's ticket");
    const secretFile = join(realpathSync.native(rig.root), "secret.txt");
    writeFileSync(secretFile, "a secret of the host");
    const probe = { port, neighbourObject: neighbour.inputs[0]!.objectName, neighbourGeneration: neighbour.inputs[0]!.generation, neighbourPrefix: neighbour.fixture.prefix, otherScratchFile: join(otherScratch, "customer.csv"), secretFile, otherTicket };
    const hostile = hostileHost(rig, { pageSize: "LETTER", locale: "hostile-probe", rendererVersion: JSON.stringify(probe) });
    const spec = planted.fixture.spec(1);
    assert.equal((await hostile.launch(spec)).outcome, "LAUNCHED");
    const record = await hostile.settled(spec.identity);
    const seen = JSON.parse(record?.refusal ?? "{}") as Record<string, unknown>;
    const envKeys = seen["envKeys"] as string[];
    // the host passes SystemRoot alone; on Windows libuv adds the variables CreateProcess needs (its required_vars), none a credential
    const allowed = process.platform === "win32" ? new Set(["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR"]) : new Set<string>();
    assert.ok(envKeys.every((k) => allowed.has(k.toUpperCase())), `the worker's environment holds nothing of the host's: ${JSON.stringify(envKeys)}`);
    assert.ok(!envKeys.includes("KAURO_TEST_SECRET_DATABASE_URL"));
    for (const key of ["readOtherAttemptScratch", "readOtherJobTicket", "readSecretFile", "writeOutsideOwnScratch", "writeHostRoot"]) assert.equal(seen[key], "ERR_ACCESS_DENIED", key);
    if (process.platform === "linux") assert.equal(seen["procEnvironOfHost"], "ERR_ACCESS_DENIED");
    for (const key of ["netConnect", "fetch", "dnsLookup"]) assert.equal(seen[key], "KAURO_NETWORK_REFUSED", key);
    assert.equal(connections, 0, "no byte reached the listening socket");
    for (const key of ["brokerForeignSource", "brokerForeignPrefix", "brokerDelivery"]) assert.equal(seen[key], "OUTSIDE_CAPABILITY", key);
    // the process allowlist (worker-preload.ts): no native program, no shell, no Node child without a permission at most the worker's
    // own, no NODE_OPTIONS — each refused before a process exists; the one Node child it admits still cannot read the secret
    const refusedChildren = ["nodeChildPlain", "nodeChildWiderPermission", "nodeChildOwnPermission", "nodeChildNodeOptions", "nativeChild", "shellExec", "asyncSpawn"];
    // review round 2 (R2-1..R2-3): only the core child's closed command line is a Node child; no negation, script, shell or detached child
    refusedChildren.push("nodeChildNoPermission", "nodeChildNetwork", "shellOptionSpawnSync", "shellOptionExecFileSync", "detachedNodeChild", "execve", "asyncShellSpawn");
    // review round 3 (R3-1): the rules are not reachable, and a replaced permission check does not widen a child
    refusedChildren.push("permissionTamperedCoreChild");
    assert.equal(seen["commandSpecExported"], "undefined");
    for (const key of refusedChildren) assert.equal(seen[key], "KAURO_PROCESS_REFUSED", key);
    assert.deepEqual(hostile.refusals(spec.identity).map((r) => r.code), ["OUTSIDE_CAPABILITY", "OUTSIDE_CAPABILITY", "OUTSIDE_CAPABILITY"]);
    await hostile.stop();
  } finally {
    delete process.env["KAURO_TEST_SECRET_DATABASE_URL"];
    server.close();
    await rig.dispose();
  }
});

test("B14-A limits (memory): a worker past its heap dies and the host records WORKER_CRASHED with MEMORY_EXHAUSTED (a takeover's cause, never a result the worker gave); the flag that bounds it is on its command line", async () => {
  const rig = localRig();
  try {
    const planted = plantedAttempt(rig.storage, 9);
    rig.reads.set(planted.fixture.attemptId, { planBinding: { configDocument: planted.configDocument, coreConfigHash: planted.coreConfigHash }, inputs: planted.inputs, reportInputs: null });
    const host = hostileHost(rig, { pageSize: "LETTER", locale: "hostile-allocate", rendererVersion: "x" }, 64);
    const spec = planted.fixture.spec(1);
    assert.equal((await host.launch(spec)).outcome, "LAUNCHED");
    const record = await host.settled(spec.identity);
    assert.deepEqual([record?.state, record?.cause, record?.note], ["FAILED", "WORKER_CRASHED", "MEMORY_EXHAUSTED"]);
    assert.ok(record?.flags.includes("--max-old-space-size=64"));
    await host.stop();
  } finally {
    await rig.dispose();
  }
});

test("B14-A limits (disk): an attempt whose scratch budget cannot hold its package ends SCRATCH_EXHAUSTED — S035's terminal cause — with no manifest", { skip }, async () => {
  const rig = localRig();
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
  const rig = localRig({ maxWallClockMs: 1500, terminationGraceMs: 250, hooks: { atStage: (_id, s) => (s === "CORE_STARTED" ? never() : undefined) } });
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
  const rig = localRig({
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

test("B14-A terminate during processing (S075): terminating the identity while the core runs kills the worker and the core's child, revokes the broker, leaves no manifest and the attempt's scratch for the janitor", { skip }, () => terminatedAt("CORE_STARTED", 11));
test("B14-A terminate during the PDF: terminating while Chromium prints kills the browser with the worker; no report is staged", { skip }, () => terminatedAt("PDF_STARTED", 12));
test("B14-A terminate during publication: terminating before the manifest is written leaves the staged package and report unpublishable (no manifest)", { skip }, () => terminatedAt("MANIFEST", 13));

test("B14-A cancellation (D8-CANCEL-1): the host's mirror of the lease reaches the worker's channel; a worker told CANCELLED or FENCED stops the core at its next check and ends with that cause, no manifest", { skip }, async () => {
  for (const [n, state] of [[16, "CANCELLED"], [17, "FENCED"]] as const) {
    const at = gate();
    const go = gate();
    const rig = localRig({
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

test("B14-A recovery (the control plane dies): the host process is killed while its worker runs; the worker ends itself and everything it started, and a new host over the same roots answers the identity from its durable record — FAILED WORKER_CRASHED (HOST_RESTARTED), never NOT_FOUND — adopts a relaunch (ALREADY_EXISTS) without running it again, and terminates nothing twice", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "kauro-b14a-restart-"));
  const script = join(dirname(fileURLToPath(import.meta.url)), "support", "host-process.js");
  const child = spawn(process.execPath, [script, root], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env } });
  try {
    const line = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const at = buffer.indexOf("\n");
        if (at >= 0) resolve(buffer.slice(0, at));
      });
      child.on("exit", (code) => reject(new Error(`the host process exited early (${code})`)));
    });
    const started = JSON.parse(line) as { outcome: string; identity: string; pid: number; attemptDir: string; spec: Parameters<LocalProcessWorkerHost["launch"]>[0] };
    assert.equal(started.outcome, "LAUNCHED");
    assert.ok(processesReferencing(started.attemptDir).length > 0, "the worker runs");
    // the control plane dies: its process alone, never its tree
    child.kill("SIGKILL");
    assert.ok(await eventually(() => processesReferencing(started.attemptDir).length === 0, 30_000), "the orphaned worker ended itself and its children");
    const rig = localRig({ root });
    try {
      // the dead host's instance goes quiet first (INSTANCE_LOST_MS); until then its job is answered as its record stands, never ended
      assert.ok(await eventually(async () => (await rig.host.observe(started.identity)).state !== "RUNNING", 45_000, 500));
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

// --- B13 and source integrity ---------------------------------------------------------------------------------------------------------

test("B14-A B13: the absent legal identity still blocks the report — a worker whose platform inputs carry no issuer document ends REFUSED (REPORT_ISSUER_UNAVAILABLE) with no manifest, the package's files kept as evidence and no PDF staged", { skip }, async () => {
  const rig = localRig();
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
  const rig = localRig();
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

// --- review round 1 (R2, R3, R6, R7): the supervisor and the bounded launch ---------------------------------------------------------

test("B14-A limits (review R2, scratch past every quota): a worker writing straight to its own directory, outside the attempt store's accounting, is ended by its supervisor once the directory passes the attempt's hard scratch — SCRATCH_EXHAUSTED, the tree gone", async () => {
  const rig = localRig();
  try {
    const planted = plantedAttempt(rig.storage, 30);
    rig.reads.set(planted.fixture.attemptId, { planBinding: { configDocument: planted.configDocument, coreConfigHash: planted.coreConfigHash }, inputs: planted.inputs, reportInputs: null });
    const host = hostileHost(rig, { pageSize: "LETTER", locale: "hostile-disk", rendererVersion: "x" }, 256, { supervisorPollMs: 100 });
    const limits = { ...hostLimits(1 << 20), hardScratchBytes: 16 << 20 };
    const spec = planted.fixture.spec(1, limits);
    assert.equal((await host.launch(spec)).outcome, "LAUNCHED");
    const record = await host.settled(spec.identity);
    assert.deepEqual([record?.state, record?.cause, record?.note], ["FAILED", "SCRATCH_EXHAUSTED", "SCRATCH_EXHAUSTED"]);
    const attemptDir = attemptScratchDirectoryOf(realpathSync.native(rig.scratchRoot), planted.fixture.attemptId);
    assert.ok(await eventually(() => processesReferencing(attemptDir).length === 0));
    await host.stop();
  } finally {
    await rig.dispose();
  }
});

test("B14-A limits (review R2, native memory): a worker whose resident memory outside its heap passes the attempt's hard memory is ended by its supervisor — MEMORY_EXHAUSTED (Linux, where the tree's resident memory is read from /proc; in a cloud task the container's limit)", { skip: process.platform === "linux" ? false : "the tree's resident memory is read from /proc (Linux); a cloud task's memory limit is the container's" }, async () => {
  const rig = localRig();
  try {
    const planted = plantedAttempt(rig.storage, 31);
    rig.reads.set(planted.fixture.attemptId, { planBinding: { configDocument: planted.configDocument, coreConfigHash: planted.coreConfigHash }, inputs: planted.inputs, reportInputs: null });
    const host = hostileHost(rig, { pageSize: "LETTER", locale: "hostile-buffers", rendererVersion: "x" }, 64, { coreHeapMegabytes: 64, browserReserveBytes: 0, supervisorPollMs: 100 });
    const limits = { ...hostLimits(1 << 20), hardMemoryBytes: 512 << 20, memoryBudgetBytes: 256 << 20 };
    const spec = planted.fixture.spec(1, limits);
    assert.equal((await host.launch(spec)).outcome, "LAUNCHED");
    const record = await host.settled(spec.identity);
    assert.deepEqual([record?.state, record?.cause, record?.note], ["FAILED", "WORKER_CRASHED", "MEMORY_EXHAUSTED"]);
    await host.stop();
  } finally {
    await rig.dispose();
  }
});

test("B14-A RACE (review R3): a launch whose records are still being read creates nothing when its identity is terminated meanwhile, or when the read outlasts its bound — the identity is proved absent and stays absent", async () => {
  const rig = localRig();
  try {
    const releases: Array<() => void> = [];
    const release = (): void => releases.splice(0).forEach((r) => r());
    const planted = plantedAttempt(rig.storage, 32);
    const late = plantedAttempt(rig.storage, 33);
    const reads = { planBinding: { configDocument: planted.configDocument, coreConfigHash: planted.coreConfigHash }, inputs: planted.inputs, reportInputs: null };
    const host = new LocalProcessWorkerHost({
      workerEntry: WORKER_ENTRY, codeRoots: [REPO_ROOT], hostRoot: rig.hostRoot, scratchRoot: rig.scratchRoot, chromiumExecutable: BROWSER ?? process.execPath, storage: rig.storage, uploads: holderOf(rig.storage),
      tickets: { read: (spec) => new Promise((resolve) => void releases.push(() => resolve((spec.capability.attemptId === planted.fixture.attemptId ? reads : { ...reads, inputs: late.inputs }) as never))) },
      render: RENDER, corePackageHash: CORE_PACKAGE_HASH, clock: WALL, sessionOrigin: "https://app.kauro.test", creationHorizonSeconds: 2, workerHeapMegabytes: 256, coreHeapMegabytes: 256,
    });
    const spec = planted.fixture.spec(1);
    // two launches of the identity pending at once (review round 2, R2-4): the termination abandons both
    const launching = [host.launch(spec), host.launch(spec)];
    assert.equal((await host.observe(spec.identity)).state, "NOT_FOUND");
    assert.equal((await host.terminate(spec.identity)).outcome, "NOT_FOUND", "nothing exists, and the pending launches are abandoned");
    release();
    await Promise.all(launching.map((l) => assert.rejects(l, /abandoned before its create/)));
    assert.equal((await host.observe(spec.identity)).state, "NOT_FOUND");
    assert.equal((await host.resources(spec.identity)).outcome, "NOT_FOUND");
    // the identity's name is taken for good: a later launch, of this instance or any other, creates nothing
    assert.equal((await host.launch(spec)).outcome, "REFUSED");
    assert.equal((await rig.restart().launch(spec)).outcome, "REFUSED");
    assert.equal((await host.terminate(spec.identity)).outcome, "NOT_FOUND");
    assert.equal(existsSync(join(rig.hostRoot, "jobs", spec.identity, "ticket.json")), false, "no ticket: nothing was created");
    // a read past its bound (half the 2 s horizon): the launch fails and nothing is ever created by it
    const lateSpec = late.fixture.spec(1);
    await assert.rejects(host.launch(lateSpec), /not read within 1000 ms/);
    release();
    assert.equal(existsSync(join(rig.hostRoot, "jobs", lateSpec.identity)), false);
    await host.stop();
  } finally {
    await rig.dispose();
  }
});

test("B14-A terminate (review R6): a worker whose storage call never answers is still ended at once by its termination — the broker closes, the tree is killed and the end recorded without waiting for the provider", { skip }, async () => {
  const blocked = gate();
  const rig = localRig({ hooks: { beforeCall: (_id, call) => (call.op === "storage.readNext" ? (blocked.open(), never()) : undefined) } });
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

test("B14-A recovery (review R7): the host dies while its worker is stuck in synchronous work — no handler of the worker can run — and the worker's supervisor ends the tree; a new host answers FAILED WORKER_CRASHED only once the supervisor's verdict (HOST_LOST) proves the tree ended", async () => {
  const root = mkdtempSync(join(tmpdir(), "kauro-b14a-spin-"));
  const script = join(dirname(fileURLToPath(import.meta.url)), "support", "host-process.js");
  const child = spawn(process.execPath, [script, root, "hostile-spin"], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env } });
  try {
    const line = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const at = buffer.indexOf("\n");
        if (at >= 0) resolve(buffer.slice(0, at));
      });
      child.on("exit", (code) => reject(new Error(`the host process exited early (${code})`)));
    });
    const started = JSON.parse(line) as { identity: string; attemptDir: string; pid: number };
    assert.ok(await eventually(() => processesReferencing(started.attemptDir).length > 0));
    child.kill("SIGKILL");
    assert.ok(await eventually(() => processesReferencing(started.attemptDir).length === 0, 30_000), "the supervisor ended the stuck worker");
    const rig = localRig({ root });
    try {
      // the dead host's instance must go quiet before its job is judged (INSTANCE_LOST_MS)
      assert.ok(await eventually(async () => (await rig.host.observe(started.identity)).state === "FAILED", 45_000, 500));
      assert.deepEqual([rig.host.record(started.identity)?.cause, rig.host.record(started.identity)?.note], ["WORKER_CRASHED", "HOST_RESTARTED"]);
      assert.equal(readFileSync(join(rig.hostRoot, "jobs", started.identity, "supervisor.json"), "utf8").includes("HOST_LOST"), true);
    } finally {
      await rig.dispose();
    }
  } finally {
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("B14-A RACE (review round 2, R2-4): a launch pending on one instance is cancelled by a termination through another instance over the same roots — the identity is proved absent there and stays absent everywhere", async () => {
  const rig = localRig();
  try {
    let release: (() => void) | null = null;
    const planted = plantedAttempt(rig.storage, 34);
    const reads = { planBinding: { configDocument: planted.configDocument, coreConfigHash: planted.coreConfigHash }, inputs: planted.inputs, reportInputs: null };
    const host = new LocalProcessWorkerHost({
      workerEntry: WORKER_ENTRY, codeRoots: [REPO_ROOT], hostRoot: rig.hostRoot, scratchRoot: rig.scratchRoot, chromiumExecutable: BROWSER ?? process.execPath, storage: rig.storage, uploads: holderOf(rig.storage),
      tickets: { read: () => new Promise((resolve) => (release = () => resolve(reads as never))) },
      render: RENDER, corePackageHash: CORE_PACKAGE_HASH, clock: WALL, sessionOrigin: "https://app.kauro.test", creationHorizonSeconds: 60, workerHeapMegabytes: 256, coreHeapMegabytes: 256,
    });
    const spec = planted.fixture.spec(1);
    const launching = host.launch(spec);
    const other = rig.restart();
    assert.equal((await other.terminate(spec.identity)).outcome, "NOT_FOUND", "the other instance sees no job, and takes the name");
    release!();
    const result = await launching;
    assert.deepEqual([result.outcome, result.reason], ["REFUSED", "IDENTITY_TERMINATED"], "the pending launch's create finds the name taken");
    assert.equal((await host.observe(spec.identity)).state, "NOT_FOUND");
    assert.equal((await other.observe(spec.identity)).state, "NOT_FOUND");
    assert.equal(existsSync(attemptScratchDirectoryOf(realpathSync.native(rig.scratchRoot), planted.fixture.attemptId)), false, "no worker ever started");
    await host.stop();
  } finally {
    await rig.dispose();
  }
});

test("B14-A RACE (review round 2, R2-5): an owner whose liveness is stale is not proof that its worker is dead — another instance answers the job RUNNING while the worker lives, and its termination kills the worker by a pid proved the job's (its command line names the ticket digest) before it records the end", { skip }, async () => {
  const hold = gate();
  const rig = localRig({ hooks: { atStage: (_id, stage) => (stage === "CORE_STARTED" ? (hold.open(), never()) : undefined) } });
  try {
    const planted = plantedAttempt(rig.storage, 35);
    await readsFor(rig, planted);
    const spec = planted.fixture.spec(1);
    assert.equal((await rig.host.launch(spec)).outcome, "LAUNCHED");
    await hold.promise;
    // a second instance whose clock runs a minute ahead: the owner's last sign of life is older than the 30 s that mean "lost"
    const ahead = rig.restart({ now: () => toUtcInstant(Date.now() + 60_000), nowMs: () => Date.now() + 60_000 });
    assert.equal((await ahead.observe(spec.identity)).state, "RUNNING", "the worker lives: its job is not declared ended");
    assert.equal((await ahead.terminate(spec.identity)).outcome, "TERMINATED");
    const ended = await rig.host.settled(spec.identity);
    assert.deepEqual([ended?.state, ended?.note], ["TERMINATED", "TERMINATED_BY_HOST"]);
    const attemptDir = attemptScratchDirectoryOf(realpathSync.native(rig.scratchRoot), planted.fixture.attemptId);
    assert.ok(await eventually(() => processesReferencing(attemptDir).length === 0), "the worker and its core child are gone");
  } finally {
    hold.open();
    await rig.dispose();
  }
});

test("B14-A cleanup (review round 2, R2-6; Linux): what an attempt left after its worker died — a process re-parented, in a session of its own, working in the attempt's directory or naming its browser directory — is found and ended by the sweep", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "kauro-sweep-"));
  try {
    const attemptDir = join(root, "attempt");
    const browserTemp = join(root, "kb");
    mkdirSync(attemptDir);
    mkdirSync(browserTemp);
    // two orphans in sessions of their own: one working in the attempt's directory, one whose environment names the browser's
    const inDir = spawn("/bin/sleep", ["60"], { cwd: attemptDir, detached: true, stdio: "ignore" });
    const named = spawn("/bin/sleep", ["60"], { cwd: root, env: { TMPDIR: browserTemp }, detached: true, stdio: "ignore" });
    const unrelated = spawn("/bin/sleep", ["60"], { cwd: root, detached: true, stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(linuxAttemptProcesses([attemptDir, browserTemp]).sort(), [inDir.pid!, named.pid!].sort());
    assert.deepEqual(sweepAttemptProcesses(999_999, [attemptDir, browserTemp]), []);
    assert.ok(await eventually(() => !processRunning(inDir.pid!) && !processRunning(named.pid!), 5_000));
    assert.equal(processRunning(unrelated.pid!), true, "a process the attempt does not mark is left alone");
    unrelated.kill("SIGKILL");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B14-A limits (review round 3, R3-3; Linux): a file whose name the worker removed, written on through its descriptor past the hard scratch, still counts — the supervisor ends the tree SCRATCH_EXHAUSTED", { skip: process.platform !== "linux" }, async () => {
  const rig = localRig();
  try {
    const planted = plantedAttempt(rig.storage, 36);
    rig.reads.set(planted.fixture.attemptId, { planBinding: { configDocument: planted.configDocument, coreConfigHash: planted.coreConfigHash }, inputs: planted.inputs, reportInputs: null });
    const host = hostileHost(rig, { pageSize: "LETTER", locale: "hostile-unlinked", rendererVersion: "x" }, 256, { supervisorPollMs: 100 });
    const spec = planted.fixture.spec(1, { ...hostLimits(1 << 20), hardScratchBytes: 16 << 20 });
    assert.equal((await host.launch(spec)).outcome, "LAUNCHED");
    const record = await host.settled(spec.identity);
    assert.deepEqual([record?.state, record?.cause, record?.note], ["FAILED", "SCRATCH_EXHAUSTED", "SCRATCH_EXHAUSTED"]);
    await host.stop();
  } finally {
    await rig.dispose();
  }
});

test("B14-A RACE (review round 3, R3-2): a worker that rewrites its own command line is still known by the identity recorded at its spawn — another instance answers it RUNNING, terminates it by its pid and records the end only once it is gone", async () => {
  const rig = localRig();
  try {
    const planted = plantedAttempt(rig.storage, 37);
    rig.reads.set(planted.fixture.attemptId, { planBinding: { configDocument: planted.configDocument, coreConfigHash: planted.coreConfigHash }, inputs: planted.inputs, reportInputs: null });
    const host = hostileHost(rig, { pageSize: "LETTER", locale: "hostile-title", rendererVersion: "x" }, 256);
    const spec = planted.fixture.spec(1);
    assert.equal((await host.launch(spec)).outcome, "LAUNCHED");
    const pid = host.record(spec.identity)?.pid ?? null;
    assert.notEqual(pid, null);
    if (process.platform === "linux") assert.ok(host.record(spec.identity)?.pidStart, "the start of the worker is recorded at its spawn");
    // the worker has had time to rewrite its title
    await new Promise((r) => setTimeout(r, 2_000));
    const ahead = rig.restart({ now: () => toUtcInstant(Date.now() + 60_000), nowMs: () => Date.now() + 60_000 });
    assert.equal((await ahead.observe(spec.identity)).state, "RUNNING");
    assert.equal((await ahead.terminate(spec.identity)).outcome, "TERMINATED");
    assert.equal(processRunning(pid!), false, "the worker is gone before its end is recorded");
    const ended = await host.settled(spec.identity);
    assert.deepEqual([ended?.state, ended?.note], ["TERMINATED", "TERMINATED_BY_HOST"]);
    await host.stop();
  } finally {
    await rig.dispose();
  }
});

test("B14-A limits (review round 4, R4-1): no worker runs its attempt unsupervised — the ticket is given only once the supervisor watches, and a supervisor that ends while the worker runs ends the attempt (FAILED WORKER_CRASHED, SUPERVISOR_LOST), the tree gone", async () => {
  const rig = localRig();
  try {
    const planted = plantedAttempt(rig.storage, 38);
    rig.reads.set(planted.fixture.attemptId, { planBinding: { configDocument: planted.configDocument, coreConfigHash: planted.coreConfigHash }, inputs: planted.inputs, reportInputs: null });
    const host = hostileHost(rig, { pageSize: "LETTER", locale: "hostile-title", rendererVersion: "x" }, 256);
    const spec = planted.fixture.spec(1);
    assert.equal((await host.launch(spec)).outcome, "LAUNCHED");
    const supervisor = host.supervisorPid(spec.identity);
    assert.notEqual(supervisor, null);
    await new Promise((r) => setTimeout(r, 1_500));
    const pid = host.record(spec.identity)!.pid!;
    process.kill(supervisor!, "SIGKILL");
    const ended = await host.settled(spec.identity);
    assert.deepEqual([ended?.state, ended?.cause, ended?.note], ["FAILED", "WORKER_CRASHED", "SUPERVISOR_LOST"]);
    assert.ok(await eventually(() => !processRunning(pid), 10_000), "the worker was ended with its supervisor's loss");
    await host.stop();
  } finally {
    await rig.dispose();
  }
});

test("B14-A RACE (review round 5, R5-1): a creator paused between its create and its start, then judged lost, never starts the job another instance has ended — the start is claimed once, and the end recorded stands", async () => {
  const pause = gate();
  const resumed = gate();
  const rig = localRig({ hooks: { afterCreate: async () => (pause.open(), await resumed.promise) } });
  try {
    const planted = plantedAttempt(rig.storage, 39);
    await readsFor(rig, planted);
    const spec = planted.fixture.spec(1);
    const launching = rig.host.launch(spec);
    await pause.promise;
    // a second instance whose clock runs a minute ahead judges the creator lost: the queued job, no pid, is ended for good
    const ahead = rig.restart({ now: () => toUtcInstant(Date.now() + 60_000), nowMs: () => Date.now() + 60_000 });
    const seen = await ahead.observe(spec.identity);
    assert.equal(seen.state, "FAILED");
    resumed.open();
    assert.equal((await launching).outcome, "LAUNCHED", "the job was created");
    assert.deepEqual([rig.host.record(spec.identity)?.state, rig.host.record(spec.identity)?.note], ["FAILED", "HOST_RESTARTED"], "the end recorded stands");
    assert.equal(rig.host.running().length, 0, "the creator started nothing");
    assert.equal(existsSync(attemptScratchDirectoryOf(realpathSync.native(rig.scratchRoot), planted.fixture.attemptId)), false, "no worker ever ran");
  } finally {
    resumed.open();
    await rig.dispose();
  }
});
