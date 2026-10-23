/**
 * Source-lifecycle policy values (B07). Each value is either copied from the vendored R2 policy registry (registry/policy.json,
 * provenance-checked by @kauro/contracts; the domain test compares every copy with the registry) or a recorded decision where the
 * authority names the rule but not the number (docs/design/B07-upload-source-lifecycle.md §1 and §12, open questions).
 *
 * The database repeats the envelope as CHECK constraints (migration 0009: upload_sessions.reserved_bytes, revision_quota,
 * upload_capacity), so a handler that skipped a check still cannot oversubscribe a revision (07: application checks improve
 * messages but cannot be the sole protection).
 */

/** Registry policy.input: conjunctive intake limits (09 "Initial intake envelope"). */
export const INPUT_ENVELOPE = Object.freeze({
  /** Files per revision. */
  files: 50,
  /** Bytes per file. */
  fileBytes: 2_000_000_000,
  /** Bytes per revision (R2-052). */
  revisionBytes: 5_000_000_000,
  /** Selected columns per table (09 "800 selected columns per table"). */
  columns: 800,
  /** Decoded bytes per cell. */
  decodedCellBytes: 1_048_576,
  /** Decoded bytes per parsed record. */
  decodedRecordBytes: 8_388_608,
  /** Cumulative XLSX expansion (09: 20 GiB). */
  xlsxExpandedTotalBytes: 21_474_836_480,
  /** Per expanded XLSX part (09: 1 GiB). */
  xlsxExpandedPartBytes: 1_073_741_824,
  /** Association candidates per project before edge deduplication (03). */
  associationCandidates: 5_000_000,
});

/** Registry policy.capacity.agencyUploads: concurrent upload sessions per agency (09 "two sessions per agency"). */
export const AGENCY_UPLOAD_SESSIONS = 2;

/** Registry policy.retention values the source lifecycle computes deadlines from (all durations are exact elapsed seconds/days). */
export const SOURCE_RETENTION = Object.freeze({
  /** Upload reservation lifetime from initiation (09: twenty-four hours; polling never extends it). */
  uploadReservationSeconds: 86_400,
  /** Unpaid source soft interval from ready or the applicable terminal event (09). */
  unpaidDaysFromReady: 7,
  /** Unpaid source hard cap from sealing (09). */
  unpaidDaysHardFromSeal: 14,
  /** The hard cap is never extended (registry retention.extendHardCap). */
  extendHardCap: false,
});

/** Retention policy label recorded on every RetentionRecord this edition creates (RetentionRecord.policyVersion). */
export const RETENTION_POLICY_VERSION = "R2-RETENTION-1";

/**
 * CP-01.02 (owner, 2026-10-22; activation OFF until Order 19B adopts it and LEGAL_PROCEDURE_C2 records LR-01): retention policy
 * R2-RETENTION-2. The free check (UNPAID) may pass 14 days from sealing only through the project's one extension, never past 17 days.
 */
export const RETENTION_POLICY_R2_2 = Object.freeze({
  policyVersion: "R2-RETENTION-2",
  /** The UNPAID ceiling from sealing through the one extension (retention.extendHardCapExceptions). */
  unpaidExtendedDaysFromSeal: 17,
});

/**
 * The edition a stored RetentionRecord.policyVersion belongs to (CP-01.02 "Retention label defect"): the column is immutable, so both
 * labels this platform wrote before R2-RETENTION-2 (R2-RETENTION-1 on UNPAID records, R2-INITIAL on paid ordinary ones) read as the
 * first edition; R2-RETENTION-2 is the second. Any other label is unknown.
 */
export function retentionPolicyEditionOf(label: string): 1 | 2 | null {
  if (label === "R2-RETENTION-1" || label === "R2-INITIAL") return 1;
  if (label === RETENTION_POLICY_R2_2.policyVersion) return 2;
  return null;
}

/** Pricing definition that decides which object occurrences are billable units (registry policy.pricing.scheduleVersion). */
export const PRICING_DEFINITION = "R2-INITIAL";

/**
 * Decision D-SESSION-3: the provider-side lifetime assumed for a resumable session when the storage adapter does not report one.
 * 09 "Resumable session security": a Cloud Storage resumable session URI can remain usable for up to a week unless cancelled.
 * The reconciliation of an UNCERTAIN or UNSUPPORTED provider cancellation runs until this horizon.
 */
export const PROVIDER_SESSION_LIFETIME_SECONDS = 604_800;

/**
 * Decision D-SCAN-2 (open question Q-B07-3): malware signatures older than this at scan time do not produce COVERED_CLEAN
 * (09: "Stale signatures beyond the recorded policy block new admission until refreshed"; the registry records no value). Pinned,
 * never chosen per scan: evaluateScanCoverage uses it, and the database refuses a receipt recording any other maximum age
 * (inspection_receipts.signature_max_age_seconds = 86400, migration 0010; B07-F4).
 */
export const SIGNATURE_MAX_AGE_SECONDS = 86_400;

/**
 * Decision D-RUN-2: a pending two-phase command (journal RESERVED after its intent committed) is resumed by a retry with the same
 * idempotency key only once it is older than this grace; a younger one answers OPERATION_PENDING (retry later), so a double
 * submission never issues two provider sessions.
 */
export const PENDING_RESUME_GRACE_SECONDS = 30;

/** Decision D-RUN-2: the bounded wait for one provider call made between the two units of work of a command. */
export const PROVIDER_CALL_TIMEOUT_MS = 10_000;

/**
 * Decision D-HOLD-2 (B07-R1): the bound of one seal attempt's provider holds. A hold is recorded INTENDED before the provider call and
 * must be SEALED by its seal's own transaction before this bound; past it the control plane may abandon and release it (a crash
 * between the hold and the commit), and the database refuses to seal it (object_holds_attempt_bound = intended_at + 900 s, migration
 * 0020). Longer than a seal's worst case — up to fifty bounded provider calls (PROVIDER_CALL_TIMEOUT_MS each) and its unit of work —
 * and far shorter than any retention deadline, so an orphan hold never outlives its purpose by more than a sweep interval.
 */
export const SEAL_HOLD_ATTEMPT_SECONDS = 900;

/**
 * Decision D-HOLD-3 (B07-R1, second re-check): the bound of one release claim of an object's seal holds. A release is carried out by
 * exactly one caller, the one whose claim (its fence token) the database recorded; the claimant issues its provider call only while
 * the claim holds — this long after it began the unit of work that took the claim, on its own monotonic clock — and bounds the call
 * by PROVIDER_CALL_TIMEOUT_MS. Past the claim's bound another caller may claim the release again. No hold of the object is intended
 * while any claim may still land: until it is answered, or until `claim_expires_at` + PROVIDER_CALL_TIMEOUT_MS (`in_flight_until`,
 * migration 0020 CHECKs both intervals: 900 s and 10 s). That time bound is defense in depth only: a call that outlives it is fenced by
 * the provider itself, since every release names the metageneration of the hold incarnation it releases (D-HOLD-4).
 */
export const HOLD_RELEASE_CLAIM_SECONDS = 900;

/**
 * Decision D-HOLD-2 (B07-R1, second re-check): after its commit the seal re-asserts every sealed hold at the provider — the
 * idempotent placement with the generation precondition, then a re-observation of the generation and its hold flag — and re-places
 * a hold found missing on the live generation, at most this many rounds before it leaves the hold unconfirmed for OBJECT_INVENTORY.
 */
export const HOLD_REASSERTION_ROUNDS = 3;

/**
 * Decision D-HOLD-4 (B07-R1, third re-check): the release calls one claimant issues under one claim at most. A release names the
 * metageneration of the hold incarnation it releases; when the provider refuses it (412) or none is recorded, the claimant re-observes
 * the generation and, only when it is still live and held, records the observed metageneration under its live claim and releases
 * again — never more than this many times before it leaves the release to the next claim.
 */
export const HOLD_RELEASE_ROUNDS = 2;

/** Decision D-SAPI-2: a completion reference longer than this is refused structurally (text field of CMD014). */
export const COMPLETION_REF_MAX_CHARS = 4_096;

/** Decision D-SAPI-3: polling guidance of the ACCEPTED answer of CompleteUpload (10: status URL and allowed polling guidance). */
export const COMPLETION_POLL_AFTER_SECONDS = 5;

/** The most one explicit soft-deadline extension may ask for (registry CMD060 "at most 259200 seconds within the original hard cap"; 09: seventy-two hours). */
export const RETENTION_EXTENSION_MAX_SECONDS = 259_200;
