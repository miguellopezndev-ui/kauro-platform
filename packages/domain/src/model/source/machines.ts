/**
 * Platform state machines of the source lifecycle (B07). The registry defines DatasetRevision's machine (used as is: registry
 * state_transitions.json, seeded by migration 0003) but gives the UploadSession contract a state enum without a machine, and has
 * no contract for the object registry or the admitted-file lifecycle. These machines are declared here in the registry's own
 * shape and unlisted-transition policy (decisions D-UP-1, D-OBJ-1, D-FILE-1 in docs/design/B07-upload-source-lifecycle.md) so the
 * same `transition` guard applies; migrations 0008 and 0009 seed exactly these edges and the persistence test proves it.
 *
 * Kept apart from B06's PLATFORM_STATE_MACHINES (EndClient, Project) so neither package rewrites the other's list;
 * `machine()` consults both.
 */
import type { StateMachine } from "@kauro/contracts";

const UNLISTED = "REJECT_UNLESS_A_NEW_VERSIONED_CONTRACT_IS_ACCEPTED";

export const SOURCE_LIFECYCLE_STATE_MACHINES: ReadonlyArray<StateMachine> = Object.freeze([
  {
    // UploadSession contract: "Application acceptance and provider session lifetime are independent."
    contract: "UploadSession",
    initial: "RESERVED",
    terminal: ["CANCELLED", "EXPIRED", "REJECTED"],
    transitions: [
      {
        from: "RESERVED",
        event: "session_issued",
        to: "UPLOADING",
        guard: "The requester is still authorized, the reservation is unexpired and this issuance attempt holds the session fence (CMD013 phase 2).",
        effect: "Store the encrypted provider session reference and return it only to the requester through the protected response.",
      },
      {
        from: "UPLOADING",
        event: "completion_reported",
        to: "VERIFYING",
        guard: "The requester reports completion before the application deadline (CMD014).",
        effect: "Record the completion claim as a claim; schedule observation and inspection; nothing is admitted yet.",
      },
      {
        from: "VERIFYING",
        event: "completion_not_observed",
        to: "UPLOADING",
        guard: "The provider holds no final object for the session.",
        effect: "The requester may resume from the provider-confirmed offset and report again before the deadline.",
      },
      {
        from: "VERIFYING",
        event: "inspection_admitted",
        to: "ADMITTED",
        guard: "Observed bytes within the reservation, consistent claim, server digest, structure valid, full scan coverage without detection, declared format detected, accepted generation promoted and re-verified; the current inspection attempt holds the fence.",
        effect: "Create the admitted source file, its table inventory and its receipt; release the upload slot; keep the observed bytes against the revision envelope.",
      },
      {
        from: "VERIFYING",
        event: "inspection_rejected",
        to: "REJECTED",
        guard: "An inspection result fails the admission contract; the current inspection attempt holds the fence.",
        effect: "Record the receipt and the rejection class; release quota and slot; tombstone acceptance; schedule quarantine cleanup.",
      },
      {
        from: "RESERVED",
        event: "cancel_upload",
        to: "CANCELLED",
        guard: "The requester or an agency owner/admin cancels under the expected version, or the revision is replaced (CMD015, CMD012).",
        effect: "Tombstone acceptance; release quota and slot; there is no provider session to cancel yet.",
      },
      {
        from: "UPLOADING",
        event: "cancel_upload",
        to: "CANCELLED",
        guard: "Same cancellation authority; the cancellation fence wins the transaction.",
        effect: "Tombstone acceptance; release quota and slot; request provider cancellation; late objects remain quarantined and are deleted.",
      },
      {
        from: "VERIFYING",
        event: "cancel_upload",
        to: "CANCELLED",
        guard: "Same cancellation authority; cancellation remains valid while verification races.",
        effect: "Tombstone acceptance; a later inspection result is refused; anything it promoted is registered as residual and deleted.",
      },
      {
        from: "RESERVED",
        event: "reservation_expired",
        to: "EXPIRED",
        guard: "Server time reached the application deadline (twenty-four hours from initiation).",
        effect: "Tombstone acceptance; release quota and slot.",
      },
      {
        from: "UPLOADING",
        event: "reservation_expired",
        to: "EXPIRED",
        guard: "Server time reached the application deadline.",
        effect: "Tombstone acceptance; release quota and slot; request provider cancellation; clean late objects.",
      },
      {
        from: "VERIFYING",
        event: "reservation_expired",
        to: "EXPIRED",
        guard: "Server time reached the application deadline before inspection finished.",
        effect: "Tombstone acceptance; refuse the pending inspection result; clean quarantined and promoted objects.",
      },
      {
        from: "ADMITTED",
        event: "intake_deadline_reached",
        to: "EXPIRED",
        guard: "The application deadline passed and the admitted file is part of no sealed revision (unsealed intake, D-RET-1).",
        effect: "Release the bytes held against the revision envelope; schedule deletion of the accepted generation unless another revision's seal retains it.",
      },
    ],
    unlistedTransition: UNLISTED,
  },
  {
    // 09 "Storage zones and object registry": the registry is authoritative for intended objects; a database deletion flag alone
    // never proves absence, so DELETED records the provider result.
    contract: "StoredObject",
    initial: "INTENDED",
    terminal: ["DELETED"],
    transitions: [
      { from: "INTENDED", event: "provider_object_observed", to: "PRESENT", guard: "A provider stat returned a generation and length for the registered name.", effect: "Record generation, length and observation time (set once)." },
      { from: "PRESENT", event: "bytes_verified", to: "VERIFIED", guard: "The server re-read the complete generation and computed its SHA-256.", effect: "Record the digest (set once)." },
      { from: "INTENDED", event: "deletion_requested", to: "DELETION_REQUESTED", guard: "The owning acceptance was tombstoned, the intake expired or managed deletion covers the scope.", effect: "Schedule deletion under generation precondition." },
      { from: "PRESENT", event: "deletion_requested", to: "DELETION_REQUESTED", guard: "Same.", effect: "Same." },
      { from: "VERIFIED", event: "deletion_requested", to: "DELETION_REQUESTED", guard: "Same, and no sealed revision retains the generation.", effect: "Same." },
      { from: "DELETION_REQUESTED", event: "deletion_confirmed", to: "DELETED", guard: "The provider deleted the generation or a stat observed its absence.", effect: "Record the result and time; the row remains as absence evidence." },
      { from: "DELETION_REQUESTED", event: "deletion_failed", to: "DELETION_FAILED", guard: "The provider refused or failed the delete.", effect: "Record the result; the retry and the remaining object are visible to operations." },
      { from: "DELETION_FAILED", event: "deletion_retried", to: "DELETION_REQUESTED", guard: "The bounded retry policy admits another attempt.", effect: "Count the attempt." },
    ],
    unlistedTransition: UNLISTED,
  },
  {
    // FileManifest.admitted is a derived server decision; admission is revoked (never restored) when the accepted generation is lost.
    contract: "SourceFile",
    initial: "ADMITTED",
    terminal: ["ADMISSION_REVOKED"],
    transitions: [
      {
        from: "ADMITTED",
        event: "admission_revoked",
        to: "ADMISSION_REVOKED",
        guard: "The accepted generation is missing, differs from the admitted one, or its intake expired unsealed.",
        effect: "The file can no longer enter a selection or a seal; a replacement is a new upload and generation.",
      },
    ],
    unlistedTransition: UNLISTED,
  },
]);

/** Upload states that hold quota against the revision envelope (bytes and file count); mirrors kauro.upload_holds_file. */
export const UPLOAD_QUOTA_HOLDING_STATES: ReadonlySet<string> = new Set(["RESERVED", "UPLOADING", "VERIFYING", "ADMITTED"]);
/** Upload states that occupy one of the agency's concurrent upload slots; mirrors kauro.upload_holds_slot. */
export const UPLOAD_SLOT_HOLDING_STATES: ReadonlySet<string> = new Set(["RESERVED", "UPLOADING", "VERIFYING"]);
/** Upload states in which the application still accepts a completion for the reservation. */
export const UPLOAD_LIVE_STATES: ReadonlySet<string> = new Set(["RESERVED", "UPLOADING", "VERIFYING"]);
/** Upload states that tombstone application acceptance for good (a late completion can never resurrect them). */
export const UPLOAD_TOMBSTONE_STATES: ReadonlySet<string> = new Set(["CANCELLED", "EXPIRED", "REJECTED"]);

/** DatasetRevision states in which the revision is mutable (the registry edges cancel_revision leave these). */
export const REVISION_MUTABLE_STATES: ReadonlySet<string> = new Set(["DRAFT", "UPLOADING", "INSPECTING", "READY_TO_SEAL"]);
/** DatasetRevision states that accept a new upload reservation (DRAFT -> UPLOADING, or UPLOADING itself). */
export const REVISION_UPLOAD_STATES: ReadonlySet<string> = new Set(["DRAFT", "UPLOADING"]);
/** DatasetRevision states in which a selection can be bound (previously_admitted_inputs_selected, selection_changes, or in place). */
export const REVISION_SELECTABLE_STATES: ReadonlySet<string> = new Set(["DRAFT", "INSPECTING", "READY_TO_SEAL"]);
