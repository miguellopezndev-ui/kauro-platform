// Scan coverage through the labelled contract fake of MalwareScannerPort (S054 "Antivirus exits clean because the file exceeded its
// scan limit -> NOT_SCANNED/BLOCKED; a fully covered harmless file passes"; 09 "Scanner coverage"; design D-SCAN-1, D-SCAN-2,
// D-INSP-4). CONTRACT FAKE — SIMULATED: the engine's behaviour is the fake's (evidence class SIMULATED, contract-fake-* tokens), never
// EXECUTED_PROVIDER; ClamAV with pinned limits and signatures is LATER: B15. What is real here: the expected scan parts are the real
// container inspector's (the container at its verified length and every part at its verified expanded length), the scan state is the
// domain's evaluateScanCoverage (the exit code and verdict never decide), the rejection class is this package's classification, and
// the scan instant is read from a real PostgreSQL 17 clock after the bytes were read.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { after, before, test } from "node:test";
import type { StorageLocation } from "@kauro/application";
import { SIGNATURE_MAX_AGE_SECONDS, evaluateScanCoverage, type ExpectedScanPart, type ScanCoverage, type ScannerReport } from "@kauro/domain";
import { IsolatedContainerInspector, inspectionLimits, partDigestOf, rejectionClassOfScan } from "../src/index.js";
import { ContractFakeMalwareScanner, FAKE_SCANNER_ENGINE, FAKE_SCANNER_ENGINE_VERSION, FAKE_SCANNER_EVIDENCE_CLASS, FAKE_SCANNER_SIGNATURE_VERSION, eicarTestToken, type ContractFakeScannerOptions } from "../src/testing/index.js";
import { startDatabaseClock, type DatabaseClock } from "./support/database-clock.js";
import { freshDir, removeDir, source } from "./support/harness.js";
import { patternedBytes } from "./support/patterns.js";
import { buildWorkbook, type SheetSpec } from "./support/workbook.js";

const MIB = 1_048_576;
/** The pinned engine limits of this test's fake (ClamAV MaxFileSize, MaxScanSize). */
const PINNED = Object.freeze({ maxFileSizeBytes: MIB, maxScanSizeBytes: 64 * MIB });
const LOCATION: StorageLocation = Object.freeze({ provider: "test-memory", locationRef: "quarantine" });
const BENIGN: ReadonlyArray<SheetSpec> = [{ name: "Contacts", rows: [["Id", "Name"], [1, "Ana"], [2, "Bo"]] }];

let clock: DatabaseClock;
let scratch: string;
const inspector = new IsolatedContainerInspector();

before(async () => {
  clock = await startDatabaseClock();
  scratch = freshDir("scan");
});

after(async () => {
  await clock.stop();
  removeDir(scratch);
});

interface Scanned {
  readonly report: ScannerReport;
  readonly coverage: ScanCoverage;
  /** The order in which the fake consumed the object's bytes and consulted the database clock. */
  readonly events: ReadonlyArray<"bytes" | "clock">;
  /** Database readings taken by the test immediately before and after the scan. */
  readonly window: readonly [string, string];
  readonly scanner: ContractFakeMalwareScanner;
}

/** Scans `bytes` through a fresh fake bound to the database clock and evaluates the coverage against the object. */
async function scan(bytes: Buffer, expected: ReadonlyArray<ExpectedScanPart>, options: Omit<ContractFakeScannerOptions, "databaseClock" | "read"> = {}, observedBytes = bytes.length, chunk = 65_536): Promise<Scanned> {
  const events: Array<"bytes" | "clock"> = [];
  const stream = source(bytes, chunk);
  const scanner = new ContractFakeMalwareScanner({
    limits: PINNED,
    ...options,
    databaseClock: async () => {
      events.push("clock");
      return clock.now();
    },
    read: async function* read() {
      for await (const piece of stream()) {
        events.push("bytes");
        yield piece;
      }
    },
  });
  const before = await clock.now();
  const report = await scanner.scan({ location: LOCATION, objectName: "quarantine/object", generation: "1", parts: expected });
  const afterScan = await clock.now();
  const coverage = evaluateScanCoverage(expected, report, { pinnedConfigHash: scanner.pinnedConfigHash }, { observedBytes });
  return { report, coverage, events, window: [before, afterScan], scanner };
}

async function expectedPartsOf(bytes: Buffer, declaredFormat: "CSV" | "XLSX" = "XLSX"): Promise<ReadonlyArray<ExpectedScanPart>> {
  const r = await inspector.inspect({ open: source(bytes), declaredFormat, observedBytes: bytes.length, limits: inspectionLimits(), scratchDir: scratch });
  assert.equal(r.refusal, undefined, JSON.stringify(r.problems));
  assert.deepEqual(readdirSync(scratch), [], "the inspection leaves its scratch empty");
  return r.expectedScanParts;
}

function containerOf(bytes: Buffer): ExpectedScanPart {
  return { partDigest: createHash("sha256").update(bytes).digest("hex"), partKind: "CONTAINER", bytes: bytes.length };
}

/** Labels (21 "Evidence classes"): every record of the fake says SIMULATED and carries contract-fake-* tokens. */
function assertLabelled(s: Scanned): void {
  assert.equal(s.scanner.evidenceClass, "SIMULATED");
  assert.equal(FAKE_SCANNER_EVIDENCE_CLASS, "SIMULATED");
  assert.equal(s.report.engine, FAKE_SCANNER_ENGINE);
  for (const token of [s.report.engine, s.report.engineVersion, s.report.signatureVersion]) assert.match(token, /^contract-fake-/);
  assert.equal(s.report.engineVersion, FAKE_SCANNER_ENGINE_VERSION);
  assert.ok(s.scanner.calls.length > 0 && s.scanner.calls.every((c) => c.evidenceClass === "SIMULATED" && c.engine === FAKE_SCANNER_ENGINE));
}

/** D-INSP-4: the scan instant is a database reading taken after the object's bytes were read, inside the scan's window. */
function assertDatabaseInstant(s: Scanned): void {
  assert.ok(clock.readings.includes(s.report.scannedAt), "the scan instant is one of the database's readings");
  assert.equal(s.events.filter((e) => e === "clock").length, 1, "the clock is consulted once per scan");
  assert.equal(s.events.at(-1), "clock", "after every byte the scan read");
  assert.ok(s.window[0] <= s.report.scannedAt && s.report.scannedAt <= s.window[1], `${s.window[0]} <= ${s.report.scannedAt} <= ${s.window[1]}`);
}

test("S054: an oversized part the labelled fake scanner skips with exit code 0 yields NOT_SCANNED INCOMPLETE_SCAN; the harmless file it covers fully, container at its observed length, is COVERED_CLEAN", { timeout: 300_000 }, async () => {
  // the harmless file: every expected part scanned completely, the container at the object's observed length
  const harmless = buildWorkbook({ sheets: BENIGN });
  const harmlessParts = await expectedPartsOf(harmless);
  assert.deepEqual(harmlessParts[0], containerOf(harmless), "the container is expected at its verified length");
  assert.ok(harmlessParts.length > 1 && harmlessParts.slice(1).every((p) => p.partKind !== "CONTAINER"), "and every expanded part besides it");
  const clean = await scan(harmless, harmlessParts);
  assertLabelled(clean);
  assertDatabaseInstant(clean);
  assert.deepEqual([clean.report.exitCode, clean.report.verdict], [0, "CLEAN"]);
  assert.equal(clean.coverage.scanState, "COVERED_CLEAN");
  assert.deepEqual(clean.coverage.reasons, []);
  assert.equal(clean.coverage.expectedParts, harmlessParts.length);
  assert.equal(clean.coverage.scannedParts, harmlessParts.length, "every expected part scanned completely");
  assert.equal(clean.coverage.scannedBytes, harmlessParts.reduce((n, p) => n + p.bytes, 0));
  assert.equal(clean.coverage.coverage[0]?.scannedBytes, harmless.length, "the container's bytes were read from the object: all of them");
  assert.equal(rejectionClassOfScan(clean.coverage), undefined);

  // the same workbook with a 3 MiB part: above the pinned maximum file size of the engine, which skips it and still exits 0, CLEAN
  const image = patternedBytes(3 * MIB);
  const oversized = buildWorkbook({ sheets: BENIGN, extra: [{ name: "xl/media/image1.bin", data: image }] });
  assert.ok(oversized.length < PINNED.maxFileSizeBytes, "the container itself is within the engine's limit (it compresses the part)");
  const oversizedParts = await expectedPartsOf(oversized);
  const big = oversizedParts.find((p) => p.partDigest === partDigestOf("xl/media/image1.bin"));
  assert.deepEqual(big, { partDigest: partDigestOf("xl/media/image1.bin"), partKind: "OTHER_PART", bytes: image.length }, "the part is expected at its verified expanded length");
  const skipped = await scan(oversized, oversizedParts);
  assertLabelled(skipped);
  assertDatabaseInstant(skipped);
  assert.deepEqual([skipped.report.exitCode, skipped.report.verdict], [0, "CLEAN"], "the engine exits 0 with a clean verdict (the S054 hazard)");
  assert.deepEqual(skipped.report.parts.find((p) => p.partDigest === big.partDigest), { partDigest: big.partDigest, scannedBytes: 0, outcome: "SKIPPED_SIZE_LIMIT" });
  assert.equal(skipped.coverage.scanState, "NOT_SCANNED", "never clean with a warning (21: a scanner skip labelled clean)");
  assert.deepEqual(skipped.coverage.reasons, ["PART_SKIPPED"]);
  assert.equal(skipped.coverage.scannedParts, oversizedParts.length - 1);
  assert.equal(rejectionClassOfScan(skipped.coverage), "INCOMPLETE_SCAN");

  // the same object scanned by an engine pinned with a maximum file size that covers the part: every byte scanned, clean
  const wide = await scan(oversized, oversizedParts, { limits: { maxFileSizeBytes: 4 * MIB, maxScanSizeBytes: 64 * MIB } });
  assert.equal(wide.coverage.scanState, "COVERED_CLEAN");
  assert.equal(wide.coverage.scannedBytes, oversizedParts.reduce((n, p) => n + p.bytes, 0));
  assert.notEqual(wide.scanner.pinnedConfigHash, skipped.scanner.pinnedConfigHash, "the limits are part of the pinned configuration");
});

test("S054 neighbours through the labelled fake: a scan budget spent mid-object, an encrypted, failing or timed-out part, the EICAR test token, stale or future signatures, a drifted configuration and a container at another length than observed are never COVERED_CLEAN, each with its rejection class", { timeout: 300_000 }, async () => {
  const harmless = buildWorkbook({ sheets: BENIGN });
  const parts = await expectedPartsOf(harmless);
  const container = parts[0] as ExpectedScanPart;
  const second = parts[1] as ExpectedScanPart;
  const third = parts[2] as ExpectedScanPart;
  const outcome = async (label: string, bytes: Buffer, expected: ReadonlyArray<ExpectedScanPart>, options: Omit<ContractFakeScannerOptions, "databaseClock" | "read">, observedBytes: number = bytes.length, chunk?: number): Promise<Scanned> => {
    const s = await scan(bytes, expected, options, observedBytes, chunk);
    assertLabelled(s);
    assertDatabaseInstant(s);
    assert.notEqual(s.coverage.scanState, "COVERED_CLEAN", label);
    return s;
  };

  // the engine's scan budget runs out inside the second part: that part is "clean" with part of its bytes, the rest skipped, exit 0
  const budget = await outcome("scan budget", harmless, parts, { limits: { maxFileSizeBytes: PINNED.maxFileSizeBytes, maxScanSizeBytes: container.bytes + 10 } });
  assert.deepEqual([budget.report.exitCode, budget.report.verdict], [0, "CLEAN"]);
  assert.deepEqual(budget.report.parts[1], { partDigest: second.partDigest, scannedBytes: 10, outcome: "CLEAN" });
  assert.equal(budget.report.parts[2]?.outcome, "SKIPPED_SCAN_LIMIT");
  assert.deepEqual([budget.coverage.scanState, budget.coverage.reasons, rejectionClassOfScan(budget.coverage)], ["NOT_SCANNED", ["PART_SKIPPED", "BYTES_SHORT"], "INCOMPLETE_SCAN"]);

  const encrypted = await outcome("encrypted", harmless, parts, { script: { encryptedParts: [second.partDigest] } });
  assert.deepEqual([encrypted.coverage.scanState, encrypted.coverage.reasons, rejectionClassOfScan(encrypted.coverage)], ["NOT_SCANNED", ["PART_ENCRYPTED"], "INCOMPLETE_SCAN"]);

  const failing = await outcome("engine error", harmless, parts, { script: { erroredParts: [second.partDigest] } });
  assert.deepEqual([failing.report.exitCode, failing.report.verdict], [2, "ERROR"]);
  assert.deepEqual([failing.coverage.scanState, failing.coverage.reasons, rejectionClassOfScan(failing.coverage)], ["ERROR", ["ENGINE_ERROR"], "TRANSIENT_INFRASTRUCTURE"]);

  const timeout = await outcome("timeout", harmless, parts, { script: { timeoutAtPart: third.partDigest } });
  assert.deepEqual([timeout.report.exitCode, timeout.report.verdict, timeout.report.parts.length], [2, "ERROR", 3], "nothing after the timed-out part is reported");
  assert.deepEqual([timeout.coverage.scanState, rejectionClassOfScan(timeout.coverage)], ["ERROR", "TRANSIENT_INFRASTRUCTURE"]);
  assert.ok(timeout.coverage.reasons.includes("TIMEOUT") && timeout.coverage.reasons.includes("PART_MISSING"));

  // the EICAR test token (assembled at run time, never written to disk), split across the stream's chunks: a detection
  const token = Buffer.from(eicarTestToken());
  const infected = Buffer.concat([Buffer.from("id,note\n1,"), token, Buffer.from("\n")]);
  const detection = await outcome("EICAR", infected, [containerOf(infected)], {}, infected.length, 7);
  assert.deepEqual([detection.report.exitCode, detection.report.verdict], [1, "INFECTED"]);
  assert.deepEqual([detection.coverage.scanState, detection.coverage.reasons, rejectionClassOfScan(detection.coverage)], ["BLOCKED", ["DETECTED"], "DETECTED_MALWARE"]);
  // its negative control: the same text without the token, the same chunking, is covered and clean
  const plain = Buffer.from("id,note\n1,harmless\n");
  const plainScan = await scan(plain, [containerOf(plain)], {}, plain.length, 7);
  assert.equal(plainScan.coverage.scanState, "COVERED_CLEAN");

  // signatures: the pinned maximum age (86,400 s) is fresh at its boundary, stale one second beyond it, and never from the future
  assert.equal(SIGNATURE_MAX_AGE_SECONDS, 86_400);
  const boundary = await scan(harmless, parts, { signatures: { ageSecondsAtScan: SIGNATURE_MAX_AGE_SECONDS } });
  assert.equal(boundary.coverage.scanState, "COVERED_CLEAN");
  assert.equal(boundary.report.signatureVersion, FAKE_SCANNER_SIGNATURE_VERSION);
  const stale = await outcome("stale", harmless, parts, { signatures: { ageSecondsAtScan: SIGNATURE_MAX_AGE_SECONDS + 1 } });
  assert.deepEqual([stale.report.exitCode, stale.report.verdict], [0, "CLEAN"]);
  assert.deepEqual([stale.coverage.scanState, stale.coverage.reasons, rejectionClassOfScan(stale.coverage)], ["NOT_SCANNED", ["STALE_SIGNATURES"], "STALE_SIGNATURES"]);
  const future = await outcome("future", harmless, parts, { signatures: { ageSecondsAtScan: -60 } });
  assert.deepEqual([future.coverage.reasons, rejectionClassOfScan(future.coverage)], [["SIGNATURES_FROM_THE_FUTURE"], "STALE_SIGNATURES"]);

  // the engine ran another configuration than the pinned one: exit 0, clean verdict, not coverage
  const drift = await outcome("drift", harmless, parts, { script: { effectiveConfigDrift: true } });
  assert.deepEqual([drift.report.exitCode, drift.report.verdict], [0, "CLEAN"]);
  assert.notEqual(drift.report.configHash, drift.scanner.pinnedConfigHash);
  assert.deepEqual([drift.coverage.reasons, rejectionClassOfScan(drift.coverage)], [["CONFIG_NOT_PINNED"], "INCOMPLETE_SCAN"]);

  // the container at another length than the provider observed (B07-F4): the expected set is not this object's
  const longer = await outcome("observed longer", harmless, parts, {}, harmless.length + 1);
  assert.deepEqual([longer.coverage.reasons, rejectionClassOfScan(longer.coverage)], [["CONTAINER_NOT_COVERED"], "INCOMPLETE_SCAN"]);
  // and an object shorter than its expected container: the engine reads what is there, which is not the container
  const claimed = { ...container, bytes: container.bytes + 10 };
  const shorter = await outcome("object shorter", harmless, [claimed, ...parts.slice(1)], {}, claimed.bytes);
  assert.equal(shorter.report.parts[0]?.scannedBytes, harmless.length);
  assert.deepEqual([shorter.coverage.reasons, rejectionClassOfScan(shorter.coverage)], [["BYTES_SHORT"], "INCOMPLETE_SCAN"]);
});
