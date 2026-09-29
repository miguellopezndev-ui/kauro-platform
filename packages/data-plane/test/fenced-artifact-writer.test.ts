// FencedArtifactWriter and GenerationSourceReader (mandate B08-WORKER-HOST; design D8-STG-1, D8-STG-4, D8-STG-5, S035): the real
// host I/O of @kauro/data-plane over B07's object-storage fake. CONTRACT FAKE — SIMULATED: the storage's generations, sessions,
// preconditions and call log are the labelled fake's (evidence class SIMULATED, provider token contract-fake-storage), consumed
// from its single owner @kauro/application/testing and never copied; the writer's decisions — what is a staged artifact, what
// is refused, which name it may touch — are the real code's. A short or corrupting network is a holder that rewrites chunks on
// their way to the fake's session; an out-of-band overwrite is the fake's own `plantObject` at a hold point.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readStagedManifest, stagedArtifactObjectNameOf, type AttemptCapability, type CancellationChannel, type ResumableUploadPort } from "@kauro/application";
import { ContractFakeObjectStorage } from "@kauro/application/testing";
import { AttemptScratchStore, FencedArtifactWriter, GenerationSourceReader } from "../src/index.js";
import { SESSION_ORIGIN, attemptFixture, collect, failsWith, holderOf, manualChannel, payloadOf, rejectsWith, scriptedChannel, sha, type AttemptFixture } from "./support/attempt.js";
import { freshDir, removeDir } from "./support/harness.js";

const CHUNK = 1_024;

interface Case {
  readonly fixture: AttemptFixture;
  readonly scratch: AttemptScratchStore;
  readonly writer: FencedArtifactWriter;
  nameOf(role: string, path: string): string;
}

function caseOf(
  root: string,
  storage: ContractFakeObjectStorage,
  n: number,
  options: { readonly uploads?: ResumableUploadPort; readonly cancellation?: CancellationChannel; readonly quotaBytes?: number; readonly capability?: AttemptCapability } = {},
): Case {
  const fixture = attemptFixture(n);
  const scratch = new AttemptScratchStore({ root, attemptId: fixture.attemptId, quotaBytes: options.quotaBytes ?? 1 << 20 });
  const writer = new FencedArtifactWriter({
    capability: options.capability ?? fixture.capability,
    storage,
    uploads: options.uploads ?? holderOf(storage),
    scratch,
    cancellation: options.cancellation ?? manualChannel(),
    origin: SESSION_ORIGIN,
    timeoutMs: 30_000,
    uploadChunkBytes: CHUNK,
  });
  return { fixture, scratch, writer, nameOf: (role, path) => stagedArtifactObjectNameOf(fixture.prefix, role, sha(path)) };
}

async function writeAll(writer: FencedArtifactWriter, role: string, path: string, bytes: Uint8Array): Promise<ReturnType<FencedArtifactWriter["open"]>> {
  const handle = writer.open(role, sha(path));
  for (let offset = 0; offset < bytes.length; offset += 1_000) await handle.write(bytes.subarray(offset, offset + 1_000));
  return handle;
}

test("S035: the fenced artifact writer never turns a failed close, a short write or a read-back mismatch into a staged artifact, and writes nothing outside the attempt's staging prefix", async () => {
  const root = freshDir("fenced-writer");
  const storage = new ContractFakeObjectStorage({ chunkMultipleBytes: CHUNK });
  const staging = storage.location("STAGING");
  const bytes = payloadOf(3_000);
  try {
    // the baseline: written in chunks, closed, uploaded in chunk multiples, re-read, and only then a staged artifact
    const ok = caseOf(root, storage, 1);
    const staged = await (await writeAll(ok.writer, "records", "path-1", bytes)).close();
    const [live] = storage.generationsOf(staging, ok.nameOf("records", "path-1"));
    assert.ok(live !== undefined && live.status === "LIVE" && live.origin === "SESSION");
    assert.deepEqual(staged, { role: "records", objectName: ok.nameOf("records", "path-1"), generation: live.generation, sha256: sha(bytes), byteLength: 3_000 });
    assert.equal(live.sha256, sha(bytes));
    assert.deepEqual(ok.writer.artifacts(), [staged]);
    assert.equal(ok.scratch.usage().bytes, 0, "the spool is released once the artifact exists");

    // a failed close: the provider refuses the session — nothing is created and nothing is staged, for good
    const refused = caseOf(root, storage, 2);
    storage.failNext("createResumableSession", { code: "UNAVAILABLE" });
    await rejectsWith((await writeAll(refused.writer, "records", "path-1", bytes)).close(), "ARTIFACT_CLOSE_FAILED", "SESSION_NOT_CREATED");
    assert.deepEqual(storage.generationsOf(staging, refused.nameOf("records", "path-1")), []);
    assert.deepEqual(refused.writer.artifacts(), []);
    failsWith(() => refused.writer.open("records", sha("path-2")), "ARTIFACT_CLOSE_FAILED");

    // a failed close: the name already holds a generation — the generation-0 precondition refuses the overwrite, the old one stays
    const occupied = caseOf(root, storage, 3);
    const earlier = storage.plantObject(staging, occupied.nameOf("records", "path-1"), Buffer.from("an earlier generation"));
    await rejectsWith((await writeAll(occupied.writer, "records", "path-1", bytes)).close(), "ARTIFACT_CLOSE_FAILED", "OVERWRITE_REFUSED");
    assert.deepEqual(
      storage.generationsOf(staging, occupied.nameOf("records", "path-1")).map((g) => [g.generation, g.status, g.origin]),
      [[earlier.generation, "LIVE", "PLANTED"]],
    );
    assert.deepEqual(occupied.writer.artifacts(), []);

    // a short write: the final chunk loses its last byte on the way, the provider refuses the length
    const shortFinal = caseOf(root, storage, 4, { uploads: holderOf(storage, (chunk, final) => (final ? chunk.subarray(0, chunk.length - 1) : chunk)) });
    await rejectsWith((await writeAll(shortFinal.writer, "records", "path-1", bytes)).close(), "SHORT_WRITE");
    assert.deepEqual(storage.generationsOf(staging, shortFinal.nameOf("records", "path-1")), []);
    // a short write: a middle chunk loses a byte, the provider refuses the misaligned chunk
    const shortMiddle = caseOf(root, storage, 5, { uploads: holderOf(storage, (chunk, final) => (final ? chunk : chunk.subarray(1))) });
    await rejectsWith((await writeAll(shortMiddle.writer, "records", "path-1", bytes)).close(), "SHORT_WRITE");
    assert.deepEqual(storage.generationsOf(staging, shortMiddle.nameOf("records", "path-1")), []);
    assert.deepEqual([...shortFinal.writer.artifacts(), ...shortMiddle.writer.artifacts()], []);

    // a read-back mismatch: a byte flips on the way, the provider finalizes a generation of the right length and other bytes
    const flipped = caseOf(root, storage, 6, {
      uploads: holderOf(storage, (chunk, final) => {
        if (!final) return chunk;
        const copy = Buffer.from(chunk);
        copy[0] = (copy[0] ?? 0) ^ 0xff;
        return copy;
      }),
    });
    await rejectsWith((await writeAll(flipped.writer, "records", "path-1", bytes)).close(), "READBACK_MISMATCH", "DIGEST");
    const [corrupt] = storage.generationsOf(staging, flipped.nameOf("records", "path-1"));
    assert.ok(corrupt !== undefined && corrupt.status === "LIVE" && corrupt.sha256 !== sha(bytes), "the object exists, private, for the janitor");
    assert.deepEqual(flipped.writer.artifacts(), [], "but it is never a staged artifact");

    // a read-back mismatch: the generation is replaced out of band before the writer re-reads it
    const replaced = caseOf(root, storage, 7);
    const handle = await writeAll(replaced.writer, "records", "path-1", bytes);
    const hold = storage.holdNext("read");
    const closing = handle.close();
    await hold.reached;
    storage.plantObject(staging, replaced.nameOf("records", "path-1"), Buffer.from("a replacement"), { overwrite: true });
    hold.release();
    await rejectsWith(closing, "READBACK_MISMATCH", "READBACK_FAILED");
    assert.deepEqual(replaced.writer.artifacts(), []);

    // nothing outside the prefix: every session any writer asked for and every object in the zone is its own attempt's
    const cases = [ok, refused, occupied, shortFinal, shortMiddle, flipped, replaced];
    const own = new Set(cases.map((c) => c.nameOf("records", "path-1")));
    const sessions = storage.calls("createResumableSession").map((c) => String(c.request["objectName"]));
    assert.equal(sessions.length, 7);
    assert.ok(sessions.every((name) => own.has(name)), "every session names the writer's own deterministic name");
    const listed = (await storage.list(staging, "staging/")).objects.map((o) => o.objectName).sort();
    assert.deepEqual(listed, [ok, occupied, flipped, replaced].map((c) => c.nameOf("records", "path-1")).sort());
    for (const c of cases) assert.ok(c.nameOf("records", "path-1").startsWith(c.fixture.prefix));

    // a capability naming another attempt's prefix, a scratch of another attempt, the manifest role, a path-shaped role and a
    // malformed path hash are refused before any provider call
    const callsBefore = storage.calls().length;
    const other = attemptFixture(8);
    const forged: AttemptCapability = { ...ok.fixture.capability, stagingPrefix: other.prefix };
    failsWith(() => caseOf(root, storage, 9, { capability: { ...attemptFixture(9).capability, stagingPrefix: other.prefix } }), "OUTSIDE_CAPABILITY", "PREFIX_NOT_THE_ATTEMPTS");
    failsWith(
      () => new FencedArtifactWriter({ capability: forged, storage, uploads: holderOf(storage), scratch: ok.scratch, cancellation: manualChannel(), origin: SESSION_ORIGIN, timeoutMs: 30_000 }),
      "OUTSIDE_CAPABILITY",
      "PREFIX_NOT_THE_ATTEMPTS",
    );
    const foreignScratch = new AttemptScratchStore({ root, attemptId: other.attemptId, quotaBytes: 1024 });
    failsWith(
      () => new FencedArtifactWriter({ capability: ok.fixture.capability, storage, uploads: holderOf(storage), scratch: foreignScratch, cancellation: manualChannel(), origin: SESSION_ORIGIN, timeoutMs: 30_000 }),
      "OUTSIDE_CAPABILITY",
      "SCRATCH_NOT_THE_ATTEMPTS",
    );
    for (const [role, path] of [["manifest", sha("x")], ["../records", sha("x")], ["records", "not-a-digest"]] as const) {
      const fresh = caseOf(root, storage, 10 + role.length + path.length);
      failsWith(() => fresh.writer.open(role, path), "OUTSIDE_CAPABILITY");
      failsWith(() => fresh.writer.open("records", sha("y")), "OUTSIDE_CAPABILITY", undefined);
      fresh.scratch.dispose();
    }
    assert.equal(storage.calls().length, callsBefore, "no refused writer reached the provider");
    for (const c of cases) c.scratch.dispose();
    foreignScratch.dispose();
  } finally {
    removeDir(root);
  }
});

test("the fenced artifact writer checks its cancellation channel before every effect, spools within the attempt's scratch quota, stops at a corrupt spool before finalizing, and writes exactly one manifest naming the artifacts it closed and re-read", async () => {
  const root = freshDir("fenced-writer-effects");
  const storage = new ContractFakeObjectStorage({ chunkMultipleBytes: CHUNK });
  const staging = storage.location("STAGING");
  const bytes = payloadOf(3_000);
  try {
    // FENCED before the close: no session at all
    const fenced = caseOf(root, storage, 1, { cancellation: manualChannel("FENCED") });
    await rejectsWith((await writeAll(fenced.writer, "records", "path-1", bytes)).close(), "FENCED");
    assert.equal(storage.calls("createResumableSession").length, 0);
    // CANCELLED after the session was created and before its final chunk: the session never finalizes
    const cancelled = caseOf(root, storage, 2, { cancellation: scriptedChannel("CONTINUE", "CANCELLED") });
    await rejectsWith((await writeAll(cancelled.writer, "records", "path-1", bytes)).close(), "CANCELLED");
    assert.equal(storage.calls("createResumableSession").length, 1);
    assert.deepEqual(storage.generationsOf(staging, cancelled.nameOf("records", "path-1")), []);
    assert.ok(storage.sessionViews().every((s) => s.state !== "FINALIZED"));

    // the spool is scratch: a quota below the artifact refuses it as SCRATCH_EXHAUSTED before any provider call
    const small = caseOf(root, storage, 3, { quotaBytes: 2_000 });
    const smallHandle = small.writer.open("records", sha("path-1"));
    await smallHandle.write(bytes.subarray(0, 1_500));
    await rejectsWith(smallHandle.write(bytes.subarray(1_500)), "SCRATCH_EXHAUSTED", "QUOTA");
    await rejectsWith(smallHandle.close(), "SCRATCH_EXHAUSTED");
    assert.equal(storage.calls("createResumableSession").length, 1);

    // a spool whose bytes changed on the scratch device is CORRUPT_INTERMEDIATE before the final chunk: nothing finalizes
    const tampered = caseOf(root, storage, 4);
    const tamperedHandle = await writeAll(tampered.writer, "records", "path-1", bytes);
    const [spoolFile] = readdirSync(tampered.scratch.directory);
    assert.ok(spoolFile !== undefined);
    const spooled = readFileSync(join(tampered.scratch.directory, spoolFile));
    spooled[2_500] = (spooled[2_500] ?? 0) ^ 0x01;
    writeFileSync(join(tampered.scratch.directory, spoolFile), spooled);
    await rejectsWith(tamperedHandle.close(), "CORRUPT_INTERMEDIATE", "DIGEST");
    assert.deepEqual(storage.generationsOf(staging, tampered.nameOf("records", "path-1")), []);

    // the manifest: refused while an artifact is open, then written once at the attempt's manifest name, naming exactly the
    // artifacts the writer closed and re-read; a second manifest and any later artifact are refused
    const done = caseOf(root, storage, 5);
    const first = await (await writeAll(done.writer, "records", "path-1", bytes)).close();
    const open = done.writer.open("dispositions", sha("path-2"));
    await open.write(payloadOf(10, 2));
    await rejectsWith(done.writer.writeManifest({ fence: 1, inputBindingHash: done.fixture.subject.inputBindingHash, declaredSummary: { ok: true } }), "ARTIFACT_CLOSE_FAILED", "ARTIFACT_OPEN");
    const done2 = caseOf(root, storage, 6);
    const a = await (await writeAll(done2.writer, "records", "path-1", bytes)).close();
    const b = await (await writeAll(done2.writer, "dispositions", "path-2", payloadOf(10, 2))).close();
    const reference = await done2.writer.writeManifest({ fence: 1, inputBindingHash: done2.fixture.subject.inputBindingHash, declaredSummary: { ok: true } });
    assert.equal(reference.objectName, done2.fixture.capability.manifestObjectName);
    const manifestBytes = await collect(storage.read(staging, reference.objectName, reference.generation));
    const reading = readStagedManifest(manifestBytes, {
      jobId: done2.fixture.jobId,
      attemptId: done2.fixture.attemptId,
      fence: 1,
      inputBindingHash: done2.fixture.subject.inputBindingHash,
      stagingPrefix: done2.fixture.prefix,
      manifestObjectName: done2.fixture.capability.manifestObjectName,
    });
    assert.ok(reading.ok, JSON.stringify(reading));
    assert.equal(reading.manifestHash, sha(manifestBytes));
    assert.deepEqual(reading.payload.artifacts, [a, b].sort((x, y) => (x.objectName < y.objectName ? -1 : 1)));
    assert.deepEqual(reading.payload.declaredSummary, { ok: true });
    await rejectsWith(done2.writer.writeManifest({ fence: 1, inputBindingHash: done2.fixture.subject.inputBindingHash, declaredSummary: null }), "ARTIFACT_CLOSE_FAILED", "MANIFEST_WRITTEN");
    failsWith(() => done2.writer.open("records", sha("path-3")), "ARTIFACT_CLOSE_FAILED", "MANIFEST_WRITTEN");
    assert.equal(storage.generationsOf(staging, reference.objectName).length, 1);
    assert.ok(first.objectName.startsWith(done.fixture.prefix));
    for (const c of [fenced, cancelled, small, tampered, done, done2]) c.scratch.dispose();
  } finally {
    removeDir(root);
  }
});

test("the generation source reader opens only the sealed ACCEPTED generations the capability names and re-verifies each one's digest and length while it streams, never a newer generation of the same name", async () => {
  const storage = new ContractFakeObjectStorage();
  const accepted = storage.location("ACCEPTED");
  const probe = attemptFixture(1);
  const nameOf = (file: number): string => `accepted/${probe.agencyId}/${probe.projectId}/${attemptFixture(100 + file).attemptId}`;
  const source = payloadOf(200_000, 3);
  const sealed = storage.plantObject(accepted, nameOf(1), source);
  const lying = storage.plantObject(accepted, nameOf(2), payloadOf(50, 4));
  const longer = storage.plantObject(accepted, nameOf(3), payloadOf(80, 5));
  const replaced = storage.plantObject(accepted, nameOf(4), payloadOf(60, 6));
  const fixture = attemptFixture(1, {
    accepted: [
      { objectName: nameOf(1), generation: sealed.generation, sha256: sha(source), byteLength: source.length },
      { objectName: nameOf(2), generation: lying.generation, sha256: sha("other bytes"), byteLength: 50 },
      { objectName: nameOf(3), generation: longer.generation, sha256: sha(payloadOf(79, 5)), byteLength: 79 },
      { objectName: nameOf(4), generation: replaced.generation, sha256: sha(payloadOf(60, 6)), byteLength: 60 },
    ],
  });
  const reader = new GenerationSourceReader({ capability: fixture.capability, storage });

  const handle = await reader.open({ objectName: nameOf(1), generation: sealed.generation });
  assert.equal(handle.byteLength, source.length);
  assert.equal(handle.sha256, sha(source));
  assert.ok((await collect(handle.read())).equals(source));
  assert.ok((await collect(handle.read())).equals(source), "each pass is verified again");

  const readsBefore = storage.calls("read").length;
  await rejectsWith(reader.open({ objectName: nameOf(1), generation: String(BigInt(sealed.generation) + 1n) }), "OUTSIDE_CAPABILITY", "SOURCE_NOT_IN_CAPABILITY");
  await rejectsWith(reader.open({ objectName: nameOf(5), generation: sealed.generation }), "OUTSIDE_CAPABILITY", "SOURCE_NOT_IN_CAPABILITY");
  assert.equal(storage.calls("read").length, readsBefore, "a refused open reads nothing");

  await rejectsWith(collect((await reader.open({ objectName: nameOf(2), generation: lying.generation })).read()), "SOURCE_INTEGRITY_FAILED", "DIGEST");
  await rejectsWith(collect((await reader.open({ objectName: nameOf(3), generation: longer.generation })).read()), "SOURCE_INTEGRITY_FAILED", "LENGTH");
  storage.plantObject(accepted, nameOf(4), payloadOf(60, 7), { overwrite: true });
  await rejectsWith(collect((await reader.open({ objectName: nameOf(4), generation: replaced.generation })).read()), "SOURCE_INTEGRITY_FAILED", "SOURCE_UNREADABLE");
  assert.ok(storage.calls("read").every((c) => c.request["generation"] !== storage.generationsOf(accepted, nameOf(4)).at(-1)?.generation), "never the newer generation");

  const foreign = attemptFixture(2, { agency: 1999, accepted: [{ objectName: nameOf(1), generation: sealed.generation, sha256: sha(source), byteLength: source.length }] });
  failsWith(() => new GenerationSourceReader({ capability: foreign.capability, storage }), "OUTSIDE_CAPABILITY", "SOURCE_NOT_THE_PROJECTS_ACCEPTED_OBJECT");
});
