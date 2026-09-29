/**
 * The rejection class of a scan and of an inspection (09 "Completion and inspection": the precise classes; decision D-INSP-3).
 * The scan state itself is the domain's (evaluateScanCoverage, D-SCAN-1): BLOCKED is DETECTED_MALWARE; NOT_SCANNED is
 * STALE_SIGNATURES when only the signature database is wrong (stale, or published after the scan), otherwise INCOMPLETE_SCAN
 * (a skipped, short, encrypted or missing part, a container not covered at its observed length, an unpinned configuration, nothing
 * expected); ERROR is TRANSIENT_INFRASTRUCTURE (retried within the deadline). The database pairs them the same way
 * (inspection_receipts_blocked_is_detection, inspection_receipts_incomplete_is_not_scanned).
 */
import type { ContainerInspection } from "@kauro/application";
import type { RejectionClass, ScanCoverage } from "@kauro/domain";

const SIGNATURE_ONLY: ReadonlySet<string> = new Set(["STALE_SIGNATURES", "SIGNATURES_FROM_THE_FUTURE"]);

export function rejectionClassOfScan(coverage: ScanCoverage): RejectionClass | undefined {
  switch (coverage.scanState) {
    case "COVERED_CLEAN":
      return undefined;
    case "BLOCKED":
      return "DETECTED_MALWARE";
    case "ERROR":
      return "TRANSIENT_INFRASTRUCTURE";
    case "NOT_SCANNED":
      return coverage.reasons.length > 0 && coverage.reasons.every((r) => SIGNATURE_ONLY.has(r)) ? "STALE_SIGNATURES" : "INCOMPLETE_SCAN";
  }
}

/** The rejection class an inspection's refusal decides (undefined: the structure passed). */
export function rejectionClassOfInspection(inspection: ContainerInspection): RejectionClass | undefined {
  return inspection.refusal;
}
