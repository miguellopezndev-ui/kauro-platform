// S076 (A scanner lacks feeds or an action/image is not pinned -> No PASS from missing results): a scanner report that carries no
// signature feed (no version, no publication instant, or one that is not an instant) is never COVERED_CLEAN; it is NOT_SCANNED, with
// the signature-only rejection class, whatever the engine's exit code and verdict say. The scan state is the domain's
// evaluateScanCoverage (D-SCAN-1); the rejection class is this package's classification.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { evaluateScanCoverage, type ExpectedScanPart, type ScannerReport } from "@kauro/domain";
import { rejectionClassOfScan } from "../src/index.js";

const CONFIG = createHash("sha256").update("pinned-config").digest("hex");
const PART: ExpectedScanPart = { partDigest: createHash("sha256").update("container").digest("hex"), partKind: "CONTAINER", bytes: 100 };
const FED: ScannerReport = {
  engine: "contract-fake-engine",
  engineVersion: "contract-fake-engine-1",
  signatureVersion: "contract-fake-signatures-1",
  signaturesPublishedAt: "2026-10-13T10:00:00.000Z",
  configHash: CONFIG,
  scannedAt: "2026-10-13T11:00:00.000Z",
  exitCode: 0,
  verdict: "CLEAN",
  parts: [{ partDigest: PART.partDigest, scannedBytes: 100, outcome: "CLEAN" }],
} as ScannerReport;

const evaluate = (report: ScannerReport) => evaluateScanCoverage([PART], report, { pinnedConfigHash: CONFIG } as never, { observedBytes: 100 });

test("S076: a scanner with no signature feed yields NOT_SCANNED, never PASS", () => {
  // the control: the same fully covered, clean, pinned scan with a fresh feed is the only thing that passes
  const fed = evaluate(FED);
  assert.deepEqual([fed.scanState, fed.reasons, rejectionClassOfScan(fed)], ["COVERED_CLEAN", [], undefined]);

  const noFeed: ReadonlyArray<readonly [string, Partial<Record<keyof ScannerReport, unknown>>]> = [
    ["empty publication instant", { signaturesPublishedAt: "" }],
    ["publication instant absent", { signaturesPublishedAt: undefined }],
    ["publication instant not an instant", { signaturesPublishedAt: "never" }],
    ["signature version empty", { signatureVersion: "" }],
    ["signature version absent", { signatureVersion: undefined }],
    ["neither version nor instant", { signatureVersion: "", signaturesPublishedAt: "" }],
  ];
  for (const [label, override] of noFeed) {
    const report = { ...FED, ...override } as ScannerReport;
    let coverage;
    try {
      coverage = evaluate(report);
    } catch (e) {
      assert.fail(`${label}: the evaluation threw (${String(e)}) instead of answering NOT_SCANNED`);
    }
    assert.notEqual(coverage.scanState, "COVERED_CLEAN", label);
    assert.equal(coverage.scanState, "NOT_SCANNED", label);
    assert.ok(coverage.reasons.length > 0, `${label}: a reason is recorded`);
    assert.equal(coverage.scannedParts, 1, `${label}: the part itself was scanned; only the missing feed denies the pass`);
    assert.equal(rejectionClassOfScan(coverage), "STALE_SIGNATURES", `${label}: a signature-only rejection`);
  }
});
