// AttemptScratchStore (mandate B08-WORKER-HOST; design D8-STG-2, S035): the real attempt-owned scratch of @kauro/data-plane over
// real files — no fake decides anything here. Its byte quota, its per-segment SHA-256 and its three distinct terminal causes
// (SCRATCH_EXHAUSTED, SHORT_WRITE, CORRUPT_INTERMEDIATE) are observed on the files themselves, the quota counter and the segment
// checksums; a sibling attempt's directory and a file outside every attempt stay byte-for-byte unchanged. A short write at the
// syscall is produced by a fault-injecting device that writes, for real, exactly the bytes it reports.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, symlinkSync, truncateSync, unlinkSync, writeFileSync, mkdirSync, writeSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AttemptScratchStore, attemptScratchDirectoryOf, removeAttemptScratch, type ScratchDevice } from "../src/index.js";
import { attemptFixture, failsWith, sha, snapshot } from "./support/attempt.js";
import { freshDir, removeDir } from "./support/harness.js";

const RECORDS = { schema: "records", schemaVersion: "1" } as const;

function storeOf(root: string, n: number, quotaBytes = 1 << 20, device?: ScratchDevice): AttemptScratchStore {
  const { attemptId } = attemptFixture(n, { job: 1 });
  return new AttemptScratchStore(device === undefined ? { root, attemptId, quotaBytes } : { root, attemptId, quotaBytes, device });
}

function filesIn(dir: string): string[] {
  return readdirSync(dir).sort();
}

/** Flips one byte of a file in place (same length). */
function flipByte(path: string, at: number): void {
  const bytes = readFileSync(path);
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  writeFileSync(path, bytes);
}

test("S035: the attempt scratch refuses a segment beyond its byte quota as SCRATCH_EXHAUSTED, a short write as SHORT_WRITE and a segment whose bytes no longer match their checksum as CORRUPT_INTERMEDIATE, never a completed segment, and its cleanup removes exactly the attempt's own directory", () => {
  const root = freshDir("attempt-scratch");
  try {
    const sentinel = join(root, "outside-every-attempt.txt");
    writeFileSync(sentinel, "a file of the host, outside every attempt");
    // a sibling attempt of the same job holds a sealed segment throughout
    const sibling = storeOf(root, 2);
    const siblingWriter = sibling.createSegment(RECORDS);
    siblingWriter.append("sibling-row");
    const siblingSegment = siblingWriter.seal();
    const siblingBefore = snapshot(sibling.directory);

    // SCRATCH_EXHAUSTED: the quota counter refuses the line that would pass it, before a byte of it reaches the device
    const quota = storeOf(root, 1, 64);
    assert.equal(quota.directory, attemptScratchDirectoryOf(root, attemptFixture(1, { job: 1 }).attemptId));
    const kept = quota.createSegment(RECORDS);
    kept.append("a".repeat(20));
    const keptSegment = kept.seal();
    assert.equal(keptSegment.byteLength, 21);
    assert.equal(keptSegment.rowCount, 1);
    assert.equal(keptSegment.sha256, sha(`${"a".repeat(20)}\n`), "the checksum is the SHA-256 of the segment's bytes");
    assert.deepEqual([...quota.readLines(keptSegment.segmentId)], ["a".repeat(20)]);
    const over = quota.createSegment(RECORDS);
    over.append("b".repeat(20));
    assert.equal(quota.usage().bytes, 42);
    failsWith(() => over.append("c".repeat(30)), "SCRATCH_EXHAUSTED", "QUOTA");
    assert.equal(quota.failure()?.terminalCause, "SCRATCH_EXHAUSTED");
    assert.ok(quota.usage().peakBytes <= 64, "the counter never passed the quota");
    assert.equal(quota.usage().quotaBytes, 64);
    failsWith(() => over.seal(), "SCRATCH_EXHAUSTED");
    failsWith(() => quota.list(), "SCRATCH_EXHAUSTED");
    failsWith(() => quota.readLines(keptSegment.segmentId), "SCRATCH_EXHAUSTED");
    failsWith(() => quota.createSegment(RECORDS), "SCRATCH_EXHAUSTED");
    assert.deepEqual(filesIn(quota.directory), [`${keptSegment.segmentId}.seg`], "the refused segment left no file, sealed or partial");

    // SHORT_WRITE at the syscall: the device wrote part of the bytes and then made no progress
    let calls = 0;
    const stalling = storeOf(root, 3, 1 << 20, {
      write(fd, buffer, offset, length) {
        calls += 1;
        return calls === 1 ? writeSync(fd, buffer, offset, Math.floor(length / 2)) : 0;
      },
    });
    const stalled = stalling.createSegment(RECORDS);
    stalled.append("row-1");
    stalled.append("row-2");
    failsWith(() => stalled.seal(), "SHORT_WRITE", "NO_PROGRESS");
    assert.equal(stalling.failure()?.terminalCause, "SHORT_WRITE");
    assert.deepEqual(filesIn(stalling.directory), [], "a short segment is never sealed and its partial file is removed");
    failsWith(() => stalling.list(), "SHORT_WRITE");

    // SHORT_WRITE on the device: the device holds fewer bytes than were written when the segment seals
    const losing = storeOf(root, 4);
    const lost = losing.createSegment(RECORDS);
    lost.append("d".repeat(70_000));
    truncateSync(join(losing.directory, `${lost.segmentId}.part`), 1_000);
    failsWith(() => lost.seal(), "SHORT_WRITE", "LENGTH_ON_DEVICE");
    assert.deepEqual(filesIn(losing.directory), []);

    // a full device is SCRATCH_EXHAUSTED, not a short write
    const full = storeOf(root, 5, 1 << 20, {
      write() {
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      },
    });
    const filling = full.createSegment(RECORDS);
    filling.append("row");
    failsWith(() => filling.seal(), "SCRATCH_EXHAUSTED", "DEVICE_FULL");
    assert.deepEqual(filesIn(full.directory), []);

    // CORRUPT_INTERMEDIATE: a sealed segment whose bytes changed, shrank, vanished or became a link is never read as complete
    const flipped = storeOf(root, 6);
    const flippedWriter = flipped.createSegment(RECORDS);
    for (const row of ["row-1", "row-2", "row-3"]) flippedWriter.append(row);
    const flippedSegment = flippedWriter.seal();
    flipByte(join(flipped.directory, `${flippedSegment.segmentId}.seg`), 7);
    failsWith(() => [...flipped.readLines(flippedSegment.segmentId)], "CORRUPT_INTERMEDIATE", "DIGEST");
    assert.equal(flipped.failure()?.terminalCause, "CORRUPT_INTERMEDIATE");
    failsWith(() => flipped.list(), "CORRUPT_INTERMEDIATE");

    const shrunk = storeOf(root, 7);
    const shrunkWriter = shrunk.createSegment(RECORDS);
    shrunkWriter.append("row-1");
    shrunkWriter.append("row-2");
    const shrunkSegment = shrunkWriter.seal();
    truncateSync(join(shrunk.directory, `${shrunkSegment.segmentId}.seg`), 3);
    const lines = shrunk.readLines(shrunkSegment.segmentId);
    failsWith(() => lines.next(), "CORRUPT_INTERMEDIATE", "LENGTH");

    const vanished = storeOf(root, 8);
    const vanishedWriter = vanished.createSegment(RECORDS);
    vanishedWriter.append("row");
    const vanishedSegment = vanishedWriter.seal();
    unlinkSync(join(vanished.directory, `${vanishedSegment.segmentId}.seg`));
    failsWith(() => [...vanished.readLines(vanishedSegment.segmentId)], "CORRUPT_INTERMEDIATE", "MISSING");

    const linked = storeOf(root, 9);
    const linkedWriter = linked.createSegment(RECORDS);
    linkedWriter.append("row");
    const linkedSegment = linkedWriter.seal();
    const segmentPath = join(linked.directory, `${linkedSegment.segmentId}.seg`);
    unlinkSync(segmentPath);
    symlinkSync(sibling.directory, segmentPath, "junction");
    failsWith(() => [...linked.readLines(linkedSegment.segmentId)], "CORRUPT_INTERMEDIATE", "NOT_A_FILE");

    // cleanup: each store removes exactly its own directory; an abandoned one (a dead worker's) is removed by the janitor's call
    for (const store of [quota, stalling, losing, full, flipped, shrunk, linked]) {
      store.dispose();
      assert.equal(existsSync(store.directory), false);
    }
    vanished.abandon();
    assert.ok(existsSync(vanished.directory), "an abandoned scratch stays for the janitor");
    assert.equal(removeAttemptScratch(root, attemptFixture(8, { job: 1 }).attemptId), "REMOVED");
    assert.equal(removeAttemptScratch(root, attemptFixture(8, { job: 1 }).attemptId), "ABSENT");
    assert.deepEqual(snapshot(sibling.directory), siblingBefore, "the sibling attempt's directory is unchanged");
    assert.deepEqual([...sibling.readLines(siblingSegment.segmentId)], ["sibling-row"], "and its segment still matches its checksum");
    assert.equal(readFileSync(sentinel, "utf8"), "a file of the host, outside every attempt");
    sibling.dispose();
    assert.deepEqual(filesIn(root), ["outside-every-attempt.txt"]);
  } finally {
    removeDir(root);
  }
});

test("the attempt scratch cannot be steered outside its own directory: a non-canonical attempt id, a relative root, a path-shaped schema, an unknown segment id and a link planted where its directory belongs are refused, spooled bytes count against the same quota, and cleanup never follows a link", () => {
  const root = freshDir("attempt-scratch-paths");
  try {
    const { attemptId } = attemptFixture(1);
    for (const bad of ["../escape", attemptId.toUpperCase(), `${attemptId}/..`, ""]) {
      assert.throws(() => new AttemptScratchStore({ root, attemptId: bad, quotaBytes: 1024 }), TypeError, `attempt id ${bad}`);
    }
    assert.throws(() => new AttemptScratchStore({ root: "relative-scratch", attemptId, quotaBytes: 1024 }), TypeError);
    for (const quotaBytes of [0, -1, 1.5, Number.NaN]) assert.throws(() => new AttemptScratchStore({ root, attemptId, quotaBytes }), TypeError);

    const store = new AttemptScratchStore({ root, attemptId, quotaBytes: 256 });
    for (const schema of ["a/b", "a\\b", "C:records", "", "x".repeat(65)]) {
      assert.throws(() => store.createSegment({ schema, schemaVersion: "1" }), TypeError, `schema ${schema}`);
    }
    assert.equal(store.failure(), null, "a refused schema names no file and fails nothing");

    // the artifact spool is scratch too: the same quota refuses it
    const spool = store.openSpool();
    spool.write(Buffer.alloc(200, 1));
    assert.equal(store.usage().bytes, 200);
    failsWith(() => spool.write(Buffer.alloc(100, 2)), "SCRATCH_EXHAUSTED", "QUOTA");
    assert.deepEqual(readdirSync(store.directory), [], "the refused spool left no file");
    store.dispose();

    // a segment id is a key of the store's own table, never a path
    const keyed = new AttemptScratchStore({ root, attemptId: attemptFixture(2).attemptId, quotaBytes: 1024 });
    failsWith(() => keyed.manifest("../../outside-every-attempt"), "CORRUPT_INTERMEDIATE", "SEGMENT_NOT_PRESENT");
    keyed.dispose();

    // a link planted where an attempt's directory belongs is refused, and removing it removes the link, never its target
    const victimRoot = join(root, "victim");
    mkdirSync(victimRoot);
    const victim = new AttemptScratchStore({ root: victimRoot, attemptId: attemptFixture(3).attemptId, quotaBytes: 1024 });
    const victimWriter = victim.createSegment(RECORDS);
    victimWriter.append("victim-row");
    victimWriter.seal();
    const victimBefore = snapshot(victim.directory);
    const hijacked = attemptFixture(4).attemptId;
    symlinkSync(victim.directory, attemptScratchDirectoryOf(root, hijacked), "junction");
    failsWith(() => new AttemptScratchStore({ root, attemptId: hijacked, quotaBytes: 1024 }), "OUTSIDE_CAPABILITY", "DIRECTORY_IS_A_LINK");
    assert.equal(removeAttemptScratch(root, hijacked), "REMOVED");
    assert.equal(existsSync(attemptScratchDirectoryOf(root, hijacked)), false);
    assert.deepEqual(snapshot(victim.directory), victimBefore, "the link's target is untouched");
    victim.dispose();
  } finally {
    removeDir(root);
  }
});
