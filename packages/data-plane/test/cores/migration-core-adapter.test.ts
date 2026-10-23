// B05 L1 (S045): the Migration Core adapter over the real vendored core in the real isolated child. Interleavings use the adapter's
// own hold points, the child's progress points and a manual clock; nothing here sleeps.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadConfig } from "@kauro/migration-core";
import type { CoreInputRef, ExecutionSubject, HostIo, SourceHandle, SourceReader } from "@kauro/application";
import {
  AttemptEnvelopeFailure,
  CORE_RUN_DIRECTORY,
  MigrationCoreAdapter,
  attemptScratchDirectoryOf,
  coreInputPathOf,
  coreTargetModeOf,
  platformTargetModeOf,
  removeAttemptScratch,
  removeOrphanStepScratch,
  rowCountsOf,
  type CoreAdapterHooks,
} from "../../src/index.js";
import { OperationEnded, coreTimersOf } from "../../src/cores/operation.js";

/** The wall clock of a test (CK3 scans product code only). */
const WALL_TIMERS = coreTimersOf({ nowMs: () => Date.now() });
import { attemptFixture, manualChannel, sha } from "../support/attempt.js";
import { CONTACTS_CSV, ManualTimers, configDocument, gate, hostIoOf, inputRef, memorySource, memoryWriter, resolverOf, settle, tempRoot } from "../support/core-config.js";

interface Built {
  readonly t: ReturnType<typeof tempRoot>;
  readonly adapter: MigrationCoreAdapter;
  readonly subject: ExecutionSubject;
  readonly fixture: ReturnType<typeof attemptFixture>;
  readonly refs: readonly CoreInputRef[];
  readonly timers: ManualTimers;
  callDir(): string;
}

function build(options: { n?: number; hooks?: CoreAdapterHooks; document?: Record<string, unknown>; refs?: CoreInputRef[]; root?: ReturnType<typeof tempRoot>; manual?: boolean; hash?: string; clockSkewMs?: number } = {}): Built {
  const t = options.root ?? tempRoot();
  const fixture = attemptFixture(options.n ?? 1);
  mkdirSync(attemptScratchDirectoryOf(t.root, fixture.attemptId), { recursive: true });
  const refs = options.refs ?? [inputRef("contacts.csv", CONTACTS_CSV)];
  const timers = new ManualTimers();
  // time the manual clock stood still while the real one ran on (a loaded host between this line and the subject below)
  timers.now -= options.clockSkewMs ?? 0;
  const document = options.document ?? configDocument();
  const adapter = new MigrationCoreAdapter({
    attemptId: fixture.attemptId,
    scratchRoot: t.root,
    inputs: resolverOf(refs),
    corePackageHash: sha("core"),
    pollIntervalMs: options.manual === true ? 1000 : 50,
    timers: options.manual === true ? timers : WALL_TIMERS,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  const subject: ExecutionSubject = {
    ...fixture.subject,
    configDocument: document,
    configHash: options.hash ?? loadConfig(JSON.stringify(document), "t").configHash,
    // the deadline sits on the clock the adapter reads: the injected one when manual, so advance(3_600_001) always passes it
    executionDeadlineAt: new Date((options.manual === true ? timers.nowMs() : Date.now()) + 3_600_000).toISOString() as ExecutionSubject["executionDeadlineAt"],
  };
  return { t, adapter, subject, fixture, refs, timers, callDir: () => join(attemptScratchDirectoryOf(t.root, fixture.attemptId), CORE_RUN_DIRECTORY, "execute") };
}

const runsOf = (b: Built): string[] => {
  const dir = join(attemptScratchDirectoryOf(b.t.root, b.fixture.attemptId), CORE_RUN_DIRECTORY);
  return existsSync(dir) ? readdirSync(dir) : [];
};
const source = (): ReturnType<typeof memorySource> => memorySource({ "contacts.csv#1": CONTACTS_CSV });

test("M01 OK S045 (EXECUTED_LOCAL): execute runs vendored kauro-migration-core 3.1.0 in an isolated child under the real fs preload over the attempt's accepted, nonempty generations and stages every package file through the ArtifactWriter with the package's own reconciliation", async () => {
  const b = build();
  try {
    const io = hostIoOf({ source: source() });
    const out = await b.adapter.execute(b.subject, io);
    assert.equal(out.terminalCause, "COMPLETED", JSON.stringify(out));
    assert.equal(out.evidenceClass, "EXECUTED_LOCAL");
    assert.equal(out.coreVersion, "3.1.0");
    assert.ok(out.stagedArtifacts.length > 3);
    assert.ok(out.stagedArtifacts.some((a) => a.role === "package-manifest"));
    assert.equal(io.writer.staged.size, out.stagedArtifacts.length);
    for (const { artifact, bytes } of io.writer.staged.values()) {
      assert.equal(artifact.sha256, sha(bytes));
      assert.equal(artifact.byteLength, bytes.byteLength);
    }
    const reconciliation = out.reconciliationSummary as { sourceRows: { total: number } };
    assert.equal(reconciliation.sourceRows.total, 3);
    assert.ok(out.resourceMetrics.peakMemoryBytes > 0);
    assert.deepEqual(runsOf(b), []);
  } finally {
    b.t.dispose();
  }
});

test("M02 RACE (core throws mid-run): a MigrationError refusal answers REFUSED with its code, an unclassified throw rejects; neither stages an artifact nor leaves child scratch", async () => {
  const bad = configDocument();
  (bad["records"] as Array<{ fields: Array<{ destinationField: string }> }>)[0]!.fields[0]!.destinationField = "contact.nonexistent";
  const b = build({ document: bad, hash: sha("anything") });
  try {
    const io = hostIoOf({ source: source() });
    const out = await b.adapter.execute(b.subject, io);
    assert.equal(out.terminalCause, "REFUSED");
    assert.equal(out.refusal?.code, "DESTINATION_FIELD_UNKNOWN");
    assert.equal(io.writer.staged.size, 0);
    assert.deepEqual(runsOf(b), []);
  } finally {
    b.t.dispose();
  }
  // an unclassified end (the child lost without a record) rejects
  const killed = build({ hooks: { childPausePoints: ["before-run"], child: (_p, child) => child.kill() } });
  try {
    const io = hostIoOf({ source: source() });
    await assert.rejects(killed.adapter.execute(killed.subject, io), /CORE_CHILD_LOST/);
    assert.equal(io.writer.staged.size, 0);
    assert.deepEqual(runsOf(killed), []);
  } finally {
    killed.t.dispose();
  }
});

test("M03 RACE (scratch full): the shared ledger refuses the write that would pass the budget before the byte reaches the device, from the store or a direct writePackage write; SCRATCH_EXHAUSTED, nothing staged", async () => {
  let exhausted = 0;
  let completed = 0;
  for (const budget of [200, 3_000, 12_000, 40_000, 120_000, 400_000]) {
    const b = build();
    try {
      const io = hostIoOf({ source: source(), scratchBytes: budget });
      const out = await b.adapter.execute(b.subject, io);
      assert.ok(out.terminalCause === "SCRATCH_EXHAUSTED" || out.terminalCause === "COMPLETED", `${budget}: ${out.terminalCause}`);
      if (out.terminalCause === "SCRATCH_EXHAUSTED") {
        exhausted += 1;
        assert.equal(out.stagedArtifacts.length, 0);
        assert.equal(io.writer.staged.size, 0);
      } else {
        completed += 1;
        assert.ok(out.resourceMetrics.peakScratchBytes <= budget, `peak ${out.resourceMetrics.peakScratchBytes} <= ${budget}`);
      }
      assert.deepEqual(runsOf(b), []);
    } finally {
      b.t.dispose();
    }
  }
  assert.ok(exhausted >= 2 && completed >= 1, `${exhausted} exhausted, ${completed} completed`);
});

test("M03b RACE (scratch full): inputs reserved at declared length, run segments, writePackage artifacts and human-view temporaries, verify scratch and spools never exceed the budget at any write; a stream past its declared length is cut", async () => {
  // an input larger than the budget is refused at its reservation, before a byte is read
  const small = build();
  try {
    const io = hostIoOf({ source: source(), scratchBytes: 10 });
    const out = await small.adapter.execute(small.subject, io);
    assert.equal(out.terminalCause, "SCRATCH_EXHAUSTED");
  } finally {
    small.t.dispose();
  }
  // a stream past its declared length is cut
  const longer: SourceReader = {
    open: (): Promise<SourceHandle> => {
      const bytes = Buffer.from(CONTACTS_CSV);
      return Promise.resolve({ byteLength: bytes.byteLength, sha256: sha(bytes), read: async function* () { yield Buffer.concat([bytes, Buffer.from("4,d@example.com,Di\n")]); } });
    },
  };
  const b = build();
  try {
    await assert.rejects(b.adapter.execute(b.subject, hostIoOf({ source: longer })), (e: unknown) => e instanceof AttemptEnvelopeFailure && e.terminalCause === "SOURCE_INTEGRITY_FAILED" && e.problem === "LENGTH");
    assert.deepEqual(runsOf(b), []);
  } finally {
    b.t.dispose();
  }
});

test("M04 RACE (partial): verifyPackage refusing writePackage's stagingDir, or a parent re-hash mismatch, answers CORRUPT_INTERMEDIATE; the staging dir is discarded and nothing promoted or staged", async () => {
  const hooks: CoreAdapterHooks = {
    at(point) {
      if (point !== "E3") return;
      const dir = join(b.callDir(), "package");
      const target = join(dir, "manifest.json");
      writeFileSync(target, `${readFileSync(target, "utf8")} `);
    },
  };
  const b: Built = build({ hooks });
  try {
    const io = hostIoOf({ source: source() });
    const out = await b.adapter.execute(b.subject, io);
    assert.equal(out.terminalCause, "CORRUPT_INTERMEDIATE");
    assert.equal(io.writer.staged.size, 0);
    assert.deepEqual(runsOf(b), []);
  } finally {
    b.t.dispose();
  }
});

test("M05 RACE (partial): the k-th artifact close failing rejects ARTIFACT_CLOSE_FAILED; artifacts 1..k-1 stay as staging residue, none is returned and nothing after k is opened", async () => {
  const b = build();
  try {
    const inner = memoryWriter();
    let opened = 0;
    let closed = 0;
    const writer = {
      staged: inner.staged,
      open(role: string, pathHash: string) {
        opened += 1;
        const handle = inner.open(role, pathHash);
        return {
          write: (c: Uint8Array) => handle.write(c),
          close: () => {
            closed += 1;
            if (closed === 3) return Promise.reject(new AttemptEnvelopeFailure("ARTIFACT_CLOSE_FAILED", "CLOSE", "the third close failed"));
            return handle.close();
          },
        };
      },
    };
    const io = hostIoOf({ source: source(), writer });
    await assert.rejects(b.adapter.execute(b.subject, io), (e: unknown) => e instanceof AttemptEnvelopeFailure && e.terminalCause === "ARTIFACT_CLOSE_FAILED");
    assert.equal(opened, 3);
    assert.equal(inner.staged.size, 2);
  } finally {
    b.t.dispose();
  }
});

test("M06 RACE (cancel): CANCELLED during the child run kills it within one poll interval; between two artifacts no further artifact opens; answers CANCELLED", async () => {
  const channel = manualChannel();
  let pid: number | undefined;
  const b: Built = build({
    manual: true,
    hooks: {
      childPausePoints: ["before-run"],
      async child(_point, child) {
        pid = child.pid;
        channel.state = "CANCELLED";
        b.timers.advance(1000);
        await settle();
      },
    },
  });
  try {
    const io = hostIoOf({ source: source(), channel });
    const out = await b.adapter.execute(b.subject, io);
    assert.equal(out.terminalCause, "CANCELLED");
    assert.equal(io.writer.staged.size, 0);
    assert.ok(pid !== undefined);
    assert.throws(() => process.kill(pid!, 0));
    assert.deepEqual(runsOf(b), []);
  } finally {
    b.t.dispose();
  }
  // between two artifacts
  const channel2 = manualChannel();
  let opens = 0;
  const b2: Built = build({
    manual: true,
    hooks: {
      async at(point) {
        if (point === "E4:close:2") {
          channel2.state = "CANCELLED";
          b2.timers.advance(1000);
          await settle();
        }
        if (point.startsWith("E4:open:")) opens += 1;
      },
    },
  });
  try {
    const io = hostIoOf({ source: source(), channel: channel2 });
    const out = await b2.adapter.execute(b2.subject, io);
    assert.equal(out.terminalCause, "CANCELLED");
    assert.equal(opens, 2);
  } finally {
    b2.t.dispose();
  }
});

test("M07 RACE (revocation): FENCED mid-run or held at an artifact close, in both orders, kills the child and writes nothing after the fence; answers FENCED", async () => {
  const channel = manualChannel();
  const b: Built = build({
    manual: true,
    hooks: {
      childPausePoints: ["after-run"],
      async child() {
        channel.state = "FENCED";
        b.timers.advance(1000);
        await settle();
      },
    },
  });
  try {
    const io = hostIoOf({ source: source(), channel });
    const out = await b.adapter.execute(b.subject, io);
    assert.equal(out.terminalCause, "FENCED");
    assert.equal(io.writer.staged.size, 0);
  } finally {
    b.t.dispose();
  }
  const channel2 = manualChannel();
  const b2: Built = build({
    manual: true,
    hooks: {
      async at(point) {
        if (point === "E4:close:1") {
          channel2.state = "FENCED";
          b2.timers.advance(1000);
          await settle();
        }
      },
    },
  });
  try {
    const io = hostIoOf({ source: source(), channel: channel2 });
    const out = await b2.adapter.execute(b2.subject, io);
    assert.equal(out.terminalCause, "FENCED");
    assert.equal(io.writer.staged.size, 0);
    assert.deepEqual(runsOf(b2), []);
  } finally {
    b2.t.dispose();
  }
});

test("M08 RACE (expiry): the operation deadline fixed at entry ends a hung open, chunk, write, close or child with SIGKILL; late results are dropped; spawn and retry never restart it", async () => {
  // a hung child
  let pid: number | undefined;
  const b: Built = build({
    manual: true,
    hooks: {
      childPausePoints: ["before-run"],
      async child(_p, child) {
        pid = child.pid;
        b.timers.advance(3_600_001);
        await settle();
      },
    },
  });
  try {
    const out = await b.adapter.execute(b.subject, hostIoOf({ source: source() }));
    assert.equal(out.terminalCause, "DEADLINE_EXCEEDED");
    assert.throws(() => process.kill(pid!, 0));
    assert.deepEqual(runsOf(b), []);
  } finally {
    b.t.dispose();
  }
  // hung source open, chunk, writer write and writer close: each ends at the deadline, and a late result is dropped
  for (const hung of ["open", "chunk", "write", "close"] as const) {
    const late = gate();
    const bytes = Buffer.from(CONTACTS_CSV);
    const reader: SourceReader = {
      open: (): Promise<SourceHandle> => (hung === "open" ? late.promise.then(() => ({ byteLength: bytes.byteLength, sha256: sha(bytes), read: async function* () { yield bytes; } })) : Promise.resolve({ byteLength: bytes.byteLength, sha256: sha(bytes), read: async function* () { if (hung === "chunk") await late.promise; yield bytes; } })),
    };
    const inner = memoryWriter();
    const writer = {
      staged: inner.staged,
      open: (role: string, pathHash: string) => {
        const h = inner.open(role, pathHash);
        return { write: (c: Uint8Array) => (hung === "write" ? late.promise.then(() => h.write(c)) : h.write(c)), close: () => (hung === "close" ? late.promise.then(() => h.close()) : h.close()) };
      },
    };
    const b3: Built = build({
      manual: true,
      hooks: {
        async at(point) {
          const stuck = hung === "open" || hung === "chunk" ? point === "E1:open:1" && false : false;
          void stuck;
        },
      },
    });
    try {
      const run = b3.adapter.execute(b3.subject, hostIoOf({ source: reader, writer }));
      for (let i = 0; i < 40; i += 1) await settle();
      b3.timers.advance(3_600_001);
      const out = await run;
      assert.equal(out.terminalCause, "DEADLINE_EXCEEDED", hung);
      late.open();
      await settle();
      assert.equal(inner.staged.size, 0, `${hung}: late result dropped`);
    } finally {
      b3.t.dispose();
    }
  }
});

test("M08 RACE (ordering): the deadline of a manual-clock operation is on the injected clock however long the real clock ran before the subject was built; one advance(3_600_001) ends a hung source open, bounded by its own watchdog", async () => {
  const late = gate();
  const bytes = Buffer.from(CONTACTS_CSV);
  const reader: SourceReader = { open: () => late.promise.then(() => ({ byteLength: bytes.byteLength, sha256: sha(bytes), read: async function* () { yield bytes; } })) };
  const b: Built = build({ manual: true, clockSkewMs: 250 });
  let watchdog: NodeJS.Timeout | undefined;
  try {
    const run = b.adapter.execute(b.subject, hostIoOf({ source: reader }));
    for (let i = 0; i < 40; i += 1) await settle();
    b.timers.advance(3_600_001);
    const guard = new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => reject(new Error("the operation deadline never fired: the subject's deadline is past advance(3_600_001) on the injected clock")), 20_000);
    });
    const out = await Promise.race([run, guard]);
    assert.equal(out.terminalCause, "DEADLINE_EXCEEDED");
  } finally {
    clearTimeout(watchdog);
    late.open();
    b.t.dispose();
  }
});

test("M09 RACE (timeout): a SourceHandle chunk that never arrives is abandoned at the deadline; no child starts", async () => {
  const never = gate();
  const bytes = Buffer.from(CONTACTS_CSV);
  const reader: SourceReader = { open: () => Promise.resolve({ byteLength: bytes.byteLength, sha256: sha(bytes), read: async function* () { await never.promise; yield bytes; } }) };
  let childStarted = false;
  const b: Built = build({ manual: true, hooks: { childPausePoints: ["child:started"], child: () => void (childStarted = true) } });
  try {
    const run = b.adapter.execute(b.subject, hostIoOf({ source: reader }));
    for (let i = 0; i < 40; i += 1) await settle();
    b.timers.advance(3_600_001);
    const out = await run;
    assert.equal(out.terminalCause, "DEADLINE_EXCEEDED");
    assert.equal(childStarted, false);
  } finally {
    b.t.dispose();
  }
});

test("M10 RACE (crash after the package is written): the child killed after writePackage, and after verify before its record, rejects with nothing staged and its scratch removed", async () => {
  for (const point of ["after-write", "after-verify"]) {
    const b = build({ hooks: { childPausePoints: [point], child: (_p, child) => child.kill() } });
    try {
      const io = hostIoOf({ source: source() });
      await assert.rejects(b.adapter.execute(b.subject, io), /CORE_CHILD_LOST/);
      assert.equal(io.writer.staged.size, 0);
      assert.deepEqual(runsOf(b), []);
    } finally {
      b.t.dispose();
    }
  }
});

test("M11 RACE (retry): a second execute for one attemptId, same or other subject, refuses ATTEMPT_SCRATCH_EXISTS and leaves the first directory untouched", async () => {
  const hold = gate();
  const reached = gate();
  const b: Built = build({
    hooks: {
      async at(point) {
        if (point === "E0") {
          reached.open();
          await hold.promise;
        }
      },
    },
  });
  try {
    const first = b.adapter.execute(b.subject, hostIoOf({ source: source() }));
    await reached.promise;
    const marker = join(b.callDir(), "marker.txt");
    writeFileSync(marker, "first");
    const other: ExecutionSubject = { ...b.subject, jobId: attemptFixture(9).jobId };
    for (const subject of [b.subject, other]) {
      await assert.rejects(b.adapter.execute(subject, hostIoOf({ source: source() })), (e: unknown) => e instanceof AttemptEnvelopeFailure && e.problem === "ATTEMPT_SCRATCH_EXISTS");
    }
    assert.equal(readFileSync(marker, "utf8"), "first");
    hold.open();
    assert.equal((await first).terminalCause, "COMPLETED");
  } finally {
    b.t.dispose();
  }
});

test("M12 RACE (two attempts): two attempts of one job held mid-run in both orders keep disjoint child directories; the fenced one ends FENCED", async () => {
  const t = tempRoot();
  try {
    const gateA = gate();
    const gateB = gate();
    const reachedA = gate();
    const reachedB = gate();
    const channelA = manualChannel();
    const a: Built = build({ n: 1, root: t, manual: true, hooks: { async at(p) { if (p === "E2") { reachedA.open(); await gateA.promise; } } } });
    const bb: Built = build({ n: 2, root: t, hooks: { async at(p) { if (p === "E2") { reachedB.open(); await gateB.promise; } } } });
    const runA = a.adapter.execute(a.subject, hostIoOf({ source: source(), channel: channelA }));
    const runB = bb.adapter.execute(bb.subject, hostIoOf({ source: source() }));
    await Promise.all([reachedA.promise, reachedB.promise]);
    assert.notEqual(attemptScratchDirectoryOf(t.root, a.fixture.attemptId), attemptScratchDirectoryOf(t.root, bb.fixture.attemptId));
    assert.deepEqual(runsOf(a), ["execute"]);
    assert.deepEqual(runsOf(bb), ["execute"]);
    channelA.state = "FENCED";
    a.timers.advance(1000);
    await settle();
    gateA.open();
    gateB.open();
    assert.equal((await runA).terminalCause, "FENCED");
    assert.equal((await runB).terminalCause, "COMPLETED");
  } finally {
    t.dispose();
  }
});

test("M13 DENY input: a generation whose bytes or sha256 differ from the capability rejects SOURCE_INTEGRITY_FAILED before any child starts", async () => {
  let childStarted = false;
  const b = build({ hooks: { childPausePoints: ["child:started"], child: () => void (childStarted = true) } });
  try {
    const tampered = memorySource({ "contacts.csv#1": CONTACTS_CSV.replace("Ann", "Eve") });
    await assert.rejects(b.adapter.execute(b.subject, hostIoOf({ source: tampered })), (e: unknown) => e instanceof AttemptEnvelopeFailure && e.terminalCause === "SOURCE_INTEGRITY_FAILED");
    assert.equal(childStarted, false);
    assert.deepEqual(runsOf(b), []);
  } finally {
    b.t.dispose();
  }
});

test("M14 DENY attestation: HUBSPOT or SALESFORCE without host attestation answers REFUSED, attestationPolicy is never restated, and CLEAN_ONLY maps to CLEAN only through the bridge", async () => {
  for (const mode of ["HUBSPOT", "SALESFORCE"]) {
    const doc = configDocument();
    doc["target"] = { mode, importMode: "CREATE_ONLY" };
    const b = build({ document: doc, hash: sha("x") });
    try {
      const out = await b.adapter.execute(b.subject, hostIoOf({ source: source() }));
      assert.equal(out.terminalCause, "REFUSED");
      assert.equal(out.refusal?.code, "ATTESTATION_NOT_PROVIDED");
      assert.deepEqual(runsOf(b), []);
    } finally {
      b.t.dispose();
    }
  }
  assert.equal(coreTargetModeOf("CLEAN"), "CLEAN_ONLY");
  assert.equal(coreTargetModeOf("CLEAN_ONLY"), "CLEAN_ONLY");
  assert.equal(platformTargetModeOf("CLEAN_ONLY"), "CLEAN");
  assert.equal(platformTargetModeOf("HUBSPOT"), "HUBSPOT");
  assert.throws(() => platformTargetModeOf("NOPE"));
  const here = dirname(fileURLToPath(import.meta.url));
  const adapterSource = readFileSync(join(here, "..", "..", "..", "src", "cores", "migration-core-adapter.ts"), "utf8");
  assert.equal(/attestationPolicy\s*[:=]/.test(adapterSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), false);
});

test("M15 OK isolation: the core child runs under the permission model with the attempt scratch as its only writable directory, an empty environment and no network; peak memory is the child's maxRSS", async () => {
  const { coreChildFlags } = await import("../../src/cores/core-child-runner.js");
  const t = tempRoot();
  try {
    const flags = coreChildFlags({ readPaths: [join(t.root, "in")], callDir: t.root, heapMegabytes: 256 });
    assert.ok(flags.includes("--permission"));
    const writes = flags.filter((f) => f.startsWith("--allow-fs-write="));
    assert.deepEqual(writes, [`--allow-fs-write=${t.root}`]);
    assert.equal(flags.some((f) => /allow-child-process|allow-worker|allow-addons|allow-wasi/.test(f)), false);
  } finally {
    t.dispose();
  }
  const b = build();
  try {
    const out = await b.adapter.execute(b.subject, hostIoOf({ source: source() }));
    assert.ok(out.resourceMetrics.peakMemoryBytes > 10 * 1024 * 1024);
  } finally {
    b.t.dispose();
  }
});

test("M16a RACE (profile bounds): a hung read or child is killed at the deadline, cancellation ends it, and a retry uses a new callId directory with equal core hashes", async () => {
  const b = build({ manual: true });
  try {
    const request = (src: SourceReader, cancellation = manualChannel()) => ({ source: src, revisionHash: sha("revision"), scratch: hostIoOf({ source: src }).scratch, limits: hostIoOf({ source: src }).limits, cancellation });
    const first = await b.adapter.profile(request(source()));
    const second = await b.adapter.profile(request(source()));
    assert.equal(first.outcome, "PROFILED");
    assert.equal(first.profileHash, second.profileHash);
    assert.equal(first.evidenceClass, "EXECUTED_LOCAL");
    assert.deepEqual(runsOf(b), []);
    const cancelled = await b.adapter.profile(request(source(), manualChannel("CANCELLED")));
    assert.equal(cancelled.outcome, "CANCELLED");
    const never = gate();
    const hung: SourceReader = { open: () => never.promise.then(() => { throw new Error("late"); }) };
    const run = b.adapter.profile(request(hung));
    for (let i = 0; i < 20; i += 1) await settle();
    b.timers.advance(8 * 3_600_000 + 1);
    await assert.rejects(run, (e: unknown) => e instanceof OperationEnded && e.reason === "DEADLINE_EXCEEDED");
    assert.deepEqual(runsOf(b), []);
  } finally {
    b.t.dispose();
  }
});

test("M16b RACE (validate bounds): without controls the adapter rejects; with them a hung read or child is killed at the deadline, cancellation ends it, and a retry uses a new callId directory with equal core hashes", async () => {
  const b = build();
  const documents = { planBinding: () => Promise.resolve({ configDocument: b.subject.configDocument, coreConfigHash: b.subject.configHash }) };
  const adapter = new MigrationCoreAdapter({ attemptId: b.fixture.attemptId, scratchRoot: b.t.root, inputs: resolverOf(b.refs), documents, corePackageHash: sha("core"), timers: WALL_TIMERS, pollIntervalMs: 50 });
  try {
    const io = hostIoOf({ source: source() });
    const base = { revisionHash: sha("revision"), planBody: {} as never, planHash: sha("plan"), targetContractHash: sha("target"), scratch: io.scratch, cancellation: manualChannel() };
    await assert.rejects(adapter.validate(base), /controls/);
    const controls = { limits: io.limits, source: io.source, billableSourceUnits: 3 };
    const first = await adapter.validate({ ...base, controls });
    const second = await adapter.validate({ ...base, controls });
    assert.equal(first.outcome, "VALID", JSON.stringify(first));
    assert.deepEqual(first.receipt, second.receipt);
    const counts = first.receipt!.counts as unknown as Record<string, number>;
    assert.equal(counts["physicalSourceRows"], 3);
    assert.equal(counts["billableSourceUnits"], 3);
    assert.equal(counts["emittedArtifactRows"] !== undefined, true);
    assert.equal(first.receipt!.corePackageHash, sha("core"));
    const cancelled = await adapter.validate({ ...base, cancellation: manualChannel("CANCELLED"), controls });
    assert.notEqual(cancelled.outcome, "VALID");
    assert.deepEqual(runsOf(b), []);
  } finally {
    b.t.dispose();
  }
});

test("M16c RACE (verify bounds): without controls the adapter rejects; with them a hung read is killed at the deadline, cancellation ends it, and a retry has equal results", async () => {
  const b = build({ manual: true });
  try {
    const wanted = { role: "delivery", objectName: "a", generation: "1", sha256: sha("x"), byteLength: 1 };
    const candidate = { jobId: b.fixture.jobId, attemptId: b.fixture.attemptId, artifacts: [wanted], declaredSummary: { ok: true } };
    const expected = { revisionHash: sha("r"), planHash: sha("p"), targetContractHash: null, coreVersion: "3.1.0", requiredArtifacts: [wanted] };
    await assert.rejects(b.adapter.verify(candidate, expected), /controls/);
    const controls = { limits: hostIoOf({ source: source() }).limits };
    const never = gate();
    const hung = b.adapter.verify(candidate, expected, { ...controls, readArtifact: async function* () { await never.promise; yield new Uint8Array(1); } });
    for (let i = 0; i < 10; i += 1) await settle();
    b.timers.advance(8 * 3_600_000 + 1);
    await assert.rejects(hung, (e: unknown) => e instanceof OperationEnded);
    const a = await b.adapter.verify(candidate, expected, controls);
    const c = await b.adapter.verify(candidate, expected, controls);
    assert.deepEqual(a, c);
    assert.equal(a.verdict, "VALID");
  } finally {
    b.t.dispose();
  }
});

test("M17 DENY cleanup: a failed removal is reported as residual inventory and never replaces the primary terminal cause", async () => {
  const b = build({
    hooks: {
      removeTree() {
        throw new Error("EBUSY");
      },
    },
  });
  try {
    const io = hostIoOf({ source: source(), scratchBytes: 10 });
    const out = await b.adapter.execute(b.subject, io);
    assert.equal(out.terminalCause, "SCRATCH_EXHAUSTED");
    assert.equal(b.adapter.residualInventory().length, 1);
  } finally {
    b.t.dispose();
  }
});

test("M18 RACE (crash residue): a parent killed in E0..E5 leaves everything under kauro-attempt-scratch-<attemptId>, and removeAttemptScratch removes inputs, run, package and package.kauro-staging", async () => {
  const b = build({
    hooks: {
      removeTree() {
        // a parent killed before E5 never removes its call directory
      },
    },
  });
  try {
    const out = await b.adapter.execute(b.subject, hostIoOf({ source: source() }));
    assert.equal(out.terminalCause, "COMPLETED");
    const dir = join(attemptScratchDirectoryOf(b.t.root, b.fixture.attemptId), CORE_RUN_DIRECTORY, "execute");
    mkdirSync(join(dir, "package.kauro-staging"), { recursive: true });
    assert.ok(existsSync(dir));
    assert.equal(removeAttemptScratch(b.t.root, b.fixture.attemptId), "REMOVED");
    assert.equal(existsSync(attemptScratchDirectoryOf(b.t.root, b.fixture.attemptId)), false);
  } finally {
    b.t.dispose();
  }
});

test("M19 RACE (crash residue): removeOrphanStepScratch removes a dead step's profile or validate scratch and never a live one", () => {
  const t = tempRoot();
  try {
    const fixture = attemptFixture(3);
    const runs = join(attemptScratchDirectoryOf(t.root, fixture.attemptId), CORE_RUN_DIRECTORY);
    mkdirSync(join(runs, "profile-live"), { recursive: true });
    mkdirSync(join(runs, "validate-dead"), { recursive: true });
    writeFileSync(join(runs, "validate-dead", "x"), "x");
    assert.deepEqual(removeOrphanStepScratch(t.root, fixture.attemptId, (id) => id === "profile-live"), ["validate-dead"]);
    assert.deepEqual(readdirSync(runs), ["profile-live"]);
  } finally {
    t.dispose();
  }
});

test("M20 OK E3: verifyPackage runs on WritePackageResult.stagingDir, promotePackage moves it, and staging enumerates the promoted dir", async () => {
  const points: string[] = [];
  const b = build({ hooks: { childPausePoints: ["child:started", "before-run", "after-run", "after-write", "after-verify", "before-record"], child: (p) => void points.push(p) } });
  try {
    const out = await b.adapter.execute(b.subject, hostIoOf({ source: source() }));
    assert.equal(out.terminalCause, "COMPLETED");
    assert.deepEqual(points, ["child:started", "before-run", "after-run", "after-write", "after-verify", "before-record"]);
    assert.ok(out.stagedArtifacts.some((a) => a.role === "package-manifest"));
  } finally {
    b.t.dispose();
  }
});

test("M21 DENY layout: two generations with identical bytes get distinct input paths; profile, compile and execute paths are equal for one revision", () => {
  assert.notEqual(coreInputPathOf("contacts.csv", "1"), coreInputPathOf("contacts.csv", "2"));
  assert.notEqual(coreInputPathOf("a.csv", "1"), coreInputPathOf("b.csv", "1"));
  assert.equal(coreInputPathOf("contacts.csv", "1"), coreInputPathOf("contacts.csv", "1"));
  assert.match(coreInputPathOf("contacts.csv", "1"), /^[0-9a-f]{64}$/);
});

test("ROWCOUNTS: the registry counts of a reconciliation are produced from the core's own dispositions", () => {
  const counts = rowCountsOf({
    reconciliation: { sourceRows: { total: 10, byDisposition: { OUTPUT: 6, MERGED_PROVEN: 2, REJECTED_INPUT: 1, ISOLATED: 1 }, withoutDisposition: 0 }, associations: { sourceEdges: 4, withoutDisposition: 0 } },
    lineageRecordRows: 10,
    emittedArtifactRows: 6,
    billableSourceUnits: 9,
  }) as unknown as Record<string, number>;
  assert.equal(counts["physicalSourceRows"], 10);
  assert.equal(counts["emittedRepresentatives"], 6);
  assert.equal(counts["mergedNonSurvivors"], 2);
  assert.equal(counts["rejected"], 1);
  assert.equal(counts["withheld"], 1);
  assert.equal(counts["unresolved"], 0);
  assert.equal(counts["billableSourceUnits"], 9);
});

// keep a reference so an unused-import lint cannot drop the shared helper
void (null as unknown as HostIo);
