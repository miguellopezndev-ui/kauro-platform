/**
 * Scan coverage evaluation (S054; 09 "Scanner coverage": ClamAV can skip oversized files and assume them clean, so a zero exit
 * code alone is not admission evidence; the preflight compares expected parts and bytes to actual scan coverage; a part the
 * engine cannot inspect under its effective limits causes INCOMPLETE_SCAN and blocks admission; stale signatures block new
 * admission; the expected outcome for incomplete coverage is rejection, not "clean with warning"; 21 "Sabotage of evaluators":
 * "a scanner skip labelled clean" must be detected).
 *
 * The scanner port reports what it did per part; this pure function — owned by the domain because nothing else may decide it —
 * derives the FileManifest.scanState. The engine's exit code and verdict are recorded by the caller and never consulted here.
 * The database repeats the decisive rule (inspection_receipts_clean_means_covered): a receipt cannot store COVERED_CLEAN with
 * fewer scanned parts or bytes than expected.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import { instantMs } from "../fields.js";
import { SIGNATURE_MAX_AGE_SECONDS } from "./policy.js";

/** Part kinds of the expected scan set (tokens; the part's archive path is never stored, only its digest). */
export type ScanPartKind = "CONTAINER" | "CSV_BODY" | "WORKBOOK_PART" | "WORKSHEET_PART" | "SHARED_STRINGS_PART" | "STYLES_PART" | "RELATIONSHIPS_PART" | "OTHER_PART";

export interface ExpectedScanPart {
  /** SHA-256 of the part identity (the container itself, or the normalized archive path of an allowed part). */
  readonly partDigest: Sha256Hex;
  readonly partKind: ScanPartKind;
  /** Bytes the part holds (the container length, or the part's verified expanded length). */
  readonly bytes: number;
}

export type ScanPartOutcome =
  | "CLEAN"
  | "DETECTED"
  | "SKIPPED_SIZE_LIMIT"
  | "SKIPPED_SCAN_LIMIT"
  | "SKIPPED_RECURSION_LIMIT"
  | "SKIPPED_UNSUPPORTED"
  | "ENCRYPTED"
  | "TIMEOUT"
  | "ERROR";

export interface ScannedPart {
  readonly partDigest: Sha256Hex;
  readonly scannedBytes: number;
  readonly outcome: ScanPartOutcome;
}

/** What the MalwareScanner port returns (application port; the engine adapter or its labelled contract fake). */
export interface ScannerReport {
  readonly engine: string;
  readonly engineVersion: string;
  readonly signatureVersion: string;
  readonly signaturesPublishedAt: UtcInstant;
  /** Digest of the effective scanner configuration (limits, recursion, timeouts) — compared with the pinned one. */
  readonly configHash: Sha256Hex;
  readonly scannedAt: UtcInstant;
  /** Recorded as evidence; never decisive (S054). */
  readonly exitCode: number;
  /** The engine's own summary; recorded as evidence; never decisive (S054). */
  readonly verdict: "CLEAN" | "INFECTED" | "ERROR";
  readonly parts: ReadonlyArray<ScannedPart>;
}

/**
 * The accepted scanner configuration (09: pinned engine, signatures, limits, recursion, timeout, memory envelope). The signature
 * age limit is not a per-call choice: it is the pinned SIGNATURE_MAX_AGE_SECONDS (D-SCAN-2), which the database pins too
 * (inspection_receipts.signature_max_age_seconds = 86400; B07-F4).
 */
export interface ScanCoveragePolicy {
  readonly pinnedConfigHash: Sha256Hex;
}

/** The object the expected parts must describe: its observed length (the provider's, S053), which the container part must equal. */
export interface ScannedObject {
  readonly observedBytes: number;
}

export type ScanCoverageReason =
  | "NO_EXPECTED_PARTS"
  | "CONTAINER_NOT_COVERED"
  | "DETECTED"
  | "ENGINE_ERROR"
  | "TIMEOUT"
  | "UNEXPECTED_PART"
  | "CONFIG_NOT_PINNED"
  | "SIGNATURES_UNAVAILABLE"
  | "STALE_SIGNATURES"
  | "SIGNATURES_FROM_THE_FUTURE"
  | "PART_MISSING"
  | "PART_SKIPPED"
  | "PART_ENCRYPTED"
  | "BYTES_SHORT";

export interface PartCoverage {
  readonly partDigest: Sha256Hex;
  readonly partKind: ScanPartKind | "UNEXPECTED";
  readonly expectedBytes: number;
  readonly scannedBytes: number;
  readonly outcome: ScanPartOutcome | "MISSING";
}

export interface ScanCoverage {
  readonly scanState: "COVERED_CLEAN" | "BLOCKED" | "NOT_SCANNED" | "ERROR";
  /** Every finding, in a stable order; empty only for COVERED_CLEAN. */
  readonly reasons: ReadonlyArray<ScanCoverageReason>;
  readonly expectedParts: number;
  readonly expectedBytes: number;
  /** Parts scanned completely and clean (the only parts that count as covered). */
  readonly scannedParts: number;
  /** Bytes of the parts counted in scannedParts. */
  readonly scannedBytes: number;
  readonly coverage: ReadonlyArray<PartCoverage>;
}

const SKIPS: ReadonlySet<ScanPartOutcome> = new Set(["SKIPPED_SIZE_LIMIT", "SKIPPED_SCAN_LIMIT", "SKIPPED_RECURSION_LIMIT", "SKIPPED_UNSUPPORTED"]);

const REASON_ORDER: ReadonlyArray<ScanCoverageReason> = [
  "NO_EXPECTED_PARTS",
  "CONTAINER_NOT_COVERED",
  "DETECTED",
  "ENGINE_ERROR",
  "TIMEOUT",
  "UNEXPECTED_PART",
  "CONFIG_NOT_PINNED",
  "SIGNATURES_UNAVAILABLE",
  "SIGNATURES_FROM_THE_FUTURE",
  "STALE_SIGNATURES",
  "PART_MISSING",
  "PART_SKIPPED",
  "PART_ENCRYPTED",
  "BYTES_SHORT",
];

/** The signature database's publication instant, or null when the report names no feed (an empty version, an absent or non-instant time). */
function signatureInstantMs(report: ScannerReport): number | null {
  if (typeof report.signatureVersion !== "string" || report.signatureVersion.length === 0) return null;
  if (typeof report.signaturesPublishedAt !== "string") return null;
  const ms = Date.parse(report.signaturesPublishedAt);
  return Number.isFinite(ms) ? ms : null;
}

function isCount(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

/**
 * Derives the scan state. Precedence: a detection is a fact whatever else happened (BLOCKED); an engine failure or timeout, or an
 * accounting the platform cannot reconcile, is ERROR (a transient infrastructure failure may be retried within the original
 * deadline); anything short of full coverage by a pinned, fresh engine is NOT_SCANNED; only then COVERED_CLEAN.
 *
 * Coverage is judged against THIS object (B07-F4; 09 "demonstrate coverage for every admitted container"): the expected parts must
 * contain exactly one CONTAINER part whose length is the object's observed length — an expected list without the container, or
 * with the container at another length (a caller that expects "1 byte" of a 100-byte object), is CONTAINER_NOT_COVERED, never
 * clean.
 */
export function evaluateScanCoverage(expected: ReadonlyArray<ExpectedScanPart>, report: ScannerReport, policy: ScanCoveragePolicy, object: ScannedObject): ScanCoverage {
  const reasons = new Set<ScanCoverageReason>();
  const containers = expected.filter((p) => p.partKind === "CONTAINER");
  if (containers.length !== 1 || containers[0]?.bytes !== object.observedBytes || !isCount(object.observedBytes)) reasons.add("CONTAINER_NOT_COVERED");
  const byDigest = new Map<string, ScannedPart>();
  for (const p of report.parts) {
    if (!isCount(p.scannedBytes) || byDigest.has(p.partDigest)) {
      reasons.add("UNEXPECTED_PART");
      continue;
    }
    byDigest.set(p.partDigest, p);
  }
  const expectedDigests = new Set<string>();
  let expectedBytes = 0;
  let scannedParts = 0;
  let scannedBytes = 0;
  const coverage: PartCoverage[] = [];
  if (expected.length === 0) reasons.add("NO_EXPECTED_PARTS");
  for (const part of expected) {
    if (!isCount(part.bytes) || expectedDigests.has(part.partDigest)) {
      reasons.add("UNEXPECTED_PART");
      continue;
    }
    expectedDigests.add(part.partDigest);
    expectedBytes += part.bytes;
    const scanned = byDigest.get(part.partDigest);
    if (scanned === undefined) {
      reasons.add("PART_MISSING");
      coverage.push({ partDigest: part.partDigest, partKind: part.partKind, expectedBytes: part.bytes, scannedBytes: 0, outcome: "MISSING" });
      continue;
    }
    coverage.push({ partDigest: part.partDigest, partKind: part.partKind, expectedBytes: part.bytes, scannedBytes: scanned.scannedBytes, outcome: scanned.outcome });
    switch (scanned.outcome) {
      case "DETECTED":
        reasons.add("DETECTED");
        break;
      case "ERROR":
        reasons.add("ENGINE_ERROR");
        break;
      case "TIMEOUT":
        reasons.add("TIMEOUT");
        break;
      case "ENCRYPTED":
        reasons.add("PART_ENCRYPTED");
        break;
      case "CLEAN":
        if (scanned.scannedBytes !== part.bytes) {
          // a "clean" part the engine read only partially — the ClamAV skip that exits 0 (S054) — is not coverage
          reasons.add("BYTES_SHORT");
        } else {
          scannedParts += 1;
          scannedBytes += part.bytes;
        }
        break;
      default:
        if (SKIPS.has(scanned.outcome)) reasons.add("PART_SKIPPED");
        else reasons.add("ENGINE_ERROR");
    }
  }
  for (const p of report.parts) {
    if (!expectedDigests.has(p.partDigest)) {
      reasons.add("UNEXPECTED_PART");
      coverage.push({ partDigest: p.partDigest, partKind: "UNEXPECTED", expectedBytes: 0, scannedBytes: isCount(p.scannedBytes) ? p.scannedBytes : 0, outcome: p.outcome });
    }
  }
  if (report.configHash !== policy.pinnedConfigHash) reasons.add("CONFIG_NOT_PINNED");
  // a scanner with no signature feed (no version, or no publication instant that is an instant) has no freshness to judge: that is
  // never coverage (S076 "No PASS from missing results") and never an exception that skips the verdict — it is NOT_SCANNED
  const published = signatureInstantMs(report);
  const scannedAt = instantMs(report.scannedAt);
  if (published === null) reasons.add("SIGNATURES_UNAVAILABLE");
  else if (published > scannedAt) reasons.add("SIGNATURES_FROM_THE_FUTURE");
  else if (scannedAt - published > SIGNATURE_MAX_AGE_SECONDS * 1000) reasons.add("STALE_SIGNATURES");

  let scanState: ScanCoverage["scanState"];
  if (reasons.has("DETECTED")) scanState = "BLOCKED";
  else if (reasons.has("ENGINE_ERROR") || reasons.has("TIMEOUT") || reasons.has("UNEXPECTED_PART")) scanState = "ERROR";
  else if (reasons.size > 0) scanState = "NOT_SCANNED";
  else scanState = "COVERED_CLEAN";
  return {
    scanState,
    reasons: REASON_ORDER.filter((r) => reasons.has(r)),
    expectedParts: expectedDigests.size,
    expectedBytes,
    scannedParts,
    scannedBytes,
    coverage,
  };
}
