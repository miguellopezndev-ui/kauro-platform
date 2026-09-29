/**
 * The closed outcome catalogues of the source lifecycle's routes (B07; docs/design/B07-upload-source-lifecycle.md §10), composed
 * from the pipeline's shared entries exactly as B06 composes its own (api/outcome-kit, decision D-OUT-1 of B06): every problem a
 * route may answer is one entry — code, reason, field codes, whether it carries the current safe version. Since mandate
 * B07-COMMANDS served these routes they are part of COMMAND_OUTCOMES / READ_OUTCOMES / INTAKE_OUTCOMES (api/outcomes): the api's
 * send guard refuses any other problem, the OpenAPI document lists them per status and the state/command/event matrix is
 * generated from them.
 *
 * The reasons are the FAILURE_REASONS of @kauro/domain; the codes are manual 10's stable codes plus B06's PRECONDITION_FAILED,
 * ADMISSION_LIMITED and INTERNAL_ERROR (B06 D-ERR-1..3). No entry names a bucket, an object name, a session URI or a raw value.
 */
import { OUTCOME_BLOCKS, closedCatalogue, problemOutcome as outcome, type ProblemOutcome } from "../api/outcome-kit.js";
import type { B07CommandId } from "./contracts.js";

const { EVERY_ROUTE, PATH_IDS, TENANT, AGENCY_HEADER, EVERY_READ, TENANT_READ, NO_QUERY, PAGINATED, COOKIE_CSRF } = OUTCOME_BLOCKS;

const NOT_VISIBLE = (what: string): ProblemOutcome => outcome("COMMAND", "NOT_FOUND", null, `${what} is not visible to the caller's agency`);
const STALE = (what: string): ProblemOutcome => outcome("COMMAND", "STALE_VERSION", null, `expectedVersion is not the ${what}'s current version; the current safe version and state come back`, { current: "ALWAYS" });
const SERVICES = outcome("COMMAND", "INTEGRITY_FAILURE", "SOURCE_SERVICES_UNAVAILABLE", "no object-storage adapter is bound in this edition (until the integration package binds one, D-SAPI-6); nothing was reserved");
const PROJECT_NOT_OPEN = outcome("COMMAND", "PRECONDITION_FAILED", "PROJECT_NOT_OPEN", "the project is not OPEN (closed or being deleted): it takes no new revision or upload", { current: "ALWAYS" });
const NOT_OWNED = outcome("COMMAND", "NOT_AUTHORIZED", "UPLOAD_NOT_OWNED", "the upload belongs to another requester of the agency (catalogue: the upload belongs to the caller)");
const UPLOADS_UNRESOLVED = outcome("COMMAND", "PRECONDITION_FAILED", "UPLOADS_UNRESOLVED", "a reservation, session or verification of the revision is still open: selection and seal need a settled inventory (D-SEL-3)", { current: "ALWAYS" });

/** The command-specific outcomes, by B07 command (design §11; reference/COMMAND_CATALOGUE preconditions and failures). */
const COMMAND_SPECIFIC: Readonly<Record<B07CommandId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  CMD012: [
    NOT_VISIBLE("the project"),
    STALE("project"),
    PROJECT_NOT_OPEN,
    outcome("COMMAND", "PRECONDITION_FAILED", "AGENCY_NOT_OPEN", "the agency accepts no new revision (not DRAFT or ACTIVE, B06 D-CMD-2)", { current: "ALWAYS" }),
    outcome("COMMAND", "INVALID_REQUEST", "UNKNOWN_REFERENCE", "supersedesRevisionId is not a revision of this project", { fieldCodes: ["UNKNOWN_REFERENCE"] }),
    outcome("COMMAND", "PRECONDITION_FAILED", "PREDECESSOR_NOT_CURRENT", "supersedesRevisionId is not the project's current revision (lineage is linear, D-REV-1); current names the current revision", { current: "ALWAYS" }),
  ],
  CMD013: [
    NOT_VISIBLE("the revision"),
    STALE("revision"),
    outcome("COMMAND", "PRECONDITION_FAILED", "AGENCY_NOT_ACTIVE", "customer data enters only an ACTIVE agency (07: DRAFT permits identity and agreement setup, not customer-data execution; B06 D-CMD-2)", { current: "ALWAYS" }),
    PROJECT_NOT_OPEN,
    outcome("COMMAND", "CAPABILITY_UNAVAILABLE", "MODE_NOT_OFFERED", "the project's mode is no longer offered (09 Upload reservation: the project capability is checked)"),
    outcome("COMMAND", "PRECONDITION_FAILED", "REVISION_NOT_ACCEPTING_UPLOADS", "the revision is not DRAFT or UPLOADING: adding a file after inspection or sealing needs a new revision", { current: "ALWAYS" }),
    outcome("COMMAND", "INVALID_REQUEST", "EMPTY_DECLARATION", "declaredBytes is 0: an upload declares its length", { fieldCodes: ["RANGE"] }),
    outcome("COMMAND", "PRECONDITION_FAILED", "FILE_TOO_LARGE", "declaredBytes exceeds the per-file envelope (policy input.fileBytes, 2,000,000,000)"),
    outcome("COMMAND", "PRECONDITION_FAILED", "REVISION_QUOTA_EXCEEDED", "the revision's reserved and admitted bytes with this declaration exceed 5,000,000,000 (R2-052: decided on the committed ledger)"),
    outcome("COMMAND", "PRECONDITION_FAILED", "REVISION_FILE_LIMIT", "the revision already holds fifty files (policy input.files)"),
    outcome("COMMAND", "ADMISSION_LIMITED", "UPLOAD_CONCURRENCY_LIMITED", "the agency already holds its concurrent upload sessions (policy capacity.agencyUploads, 2)"),
    outcome("COMMAND", "CAPACITY_UNAVAILABLE", "SESSION_ISSUE_FAILED", "the provider did not issue the session within its bound; the reservation stays pending and a retry with the same key resumes it (D-RUN-2)"),
    SERVICES,
  ],
  CMD014: [
    NOT_VISIBLE("the upload"),
    NOT_OWNED,
    outcome("COMMAND", "PRECONDITION_FAILED", "SESSION_NOT_ISSUED", "no provider session was issued for the upload yet (RESERVED)", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "COMPLETION_CLAIM_CONFLICT", "the upload is already being verified under another completion claim (a duplicate of the same claim answers the same 202, D-SAPI-5)", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "UPLOAD_ADMITTED", "the upload was already admitted", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "UPLOAD_CANCELLED", "the upload was cancelled: a late completion is never accepted (09 Resumable session security)", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "RESERVATION_EXPIRED", "the application acceptance deadline passed (twenty-four hours from initiation; never extended)", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "UPLOAD_TERMINAL", "inspection already rejected the upload; a corrected file is a new upload", { current: "ALWAYS" }),
    outcome("COMMAND", "INVALID_REQUEST", "COMPLETION_REF_MALFORMED", "providerCompletionRef is not a completion of this provider", { fieldCodes: ["FORMAT"] }),
    SERVICES,
  ],
  CMD015: [
    NOT_VISIBLE("the upload"),
    NOT_OWNED,
    STALE("upload"),
    outcome("COMMAND", "PRECONDITION_FAILED", "UPLOAD_ADMITTED", "the upload was admitted: its file leaves the revision by an explicit exclusion or a new revision, not by cancellation", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "UPLOAD_TERMINAL", "the upload's acceptance is already tombstoned (CANCELLED, EXPIRED or REJECTED)", { current: "ALWAYS" }),
  ],
  CMD016: [
    NOT_VISIBLE("the revision"),
    STALE("revision"),
    outcome("COMMAND", "PRECONDITION_FAILED", "REVISION_NOT_SELECTABLE", "the revision is not DRAFT, UPLOADING, INSPECTING or READY_TO_SEAL (on an UPLOADING revision the selection closes the intake: all_uploads_completed, D-INTAKE-1)", { current: "ALWAYS" }),
    UPLOADS_UNRESOLVED,
    outcome("COMMAND", "INVALID_REQUEST", "UNKNOWN_REFERENCE", "selectionManifestRef is not a selection manifest of this revision", { fieldCodes: ["UNKNOWN_REFERENCE"] }),
    outcome("COMMAND", "PRECONDITION_FAILED", "SELECTION_STALE", "the manifest was made against another inventory: a missing or newly changed table invalidates it (catalogue CMD016 failure)", { current: "ALWAYS" }),
    outcome("COMMAND", "INVALID_REQUEST", "SELECTION_INCOMPLETE", "a candidate file or table of the inventory has no explicit disposition"),
    outcome("COMMAND", "INVALID_REQUEST", "SELECTION_UNKNOWN_TABLE", "the manifest names a table or file the inventory does not have"),
    outcome("COMMAND", "INVALID_REQUEST", "SELECTION_FILE_NOT_ADMITTED", "an included file is not an admitted file of this project"),
    outcome("COMMAND", "INVALID_REQUEST", "HIDDEN_SHEET_NOT_ACKNOWLEDGED", "a hidden worksheet is included without its explicit acknowledgement (no hidden-sheet silent inclusion)"),
    outcome("COMMAND", "INVALID_REQUEST", "FORMULA_POLICY_REQUIRED", "an included worksheet with formulas names no formula policy (04 XLSX parser requirements)"),
    outcome("COMMAND", "INVALID_REQUEST", "EXCLUSION_REASON_REQUIRED", "an exclusion names no reason (the sealed manifest records exclusions and reasons, 03)"),
    outcome("COMMAND", "INVALID_REQUEST", "PARSER_CHOICE_INVALID", "an included table's parser choice does not fit its kind or its detected facts"),
    outcome("COMMAND", "INVALID_REQUEST", "PROJECTION_INVALID", "a projection names columns or tables the selection does not include"),
    outcome("COMMAND", "INVALID_REQUEST", "PROJECTION_KEY_NOT_CONFIRMED", "a referenced-entity projection's key is not confirmed (03 Count the correct population)"),
    outcome("COMMAND", "INVALID_REQUEST", "SELECTED_COLUMNS_LIMIT", "a table selects more than 800 columns (policy input.columns)"),
    outcome("COMMAND", "PRECONDITION_FAILED", "SELECTION_BYTES_LIMIT", "the selected files exceed the revision envelope (50 files, 5,000,000,000 bytes)"),
    outcome("COMMAND", "PRECONDITION_FAILED", "REUSE_NOT_AVAILABLE", "a reused file is no longer an admitted file of this project (its intake expired, the retention of its sealed bytes ended, or its generation was lost), or its bytes were first sealed more than fourteen days ago (the hard cap belongs to the bytes, D-RET-3)"),
  ],
  CMD017: [
    NOT_VISIBLE("the revision"),
    STALE("revision"),
    outcome("COMMAND", "STALE_VERSION", "HASH_MISMATCH", "selectionHash is not the hash of the selection the revision binds; current.mismatch names it", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "REVISION_SEALED", "the revision is already sealed; current carries its version", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "REVISION_NOT_READY_TO_SEAL", "the revision's selected scope is not evaluated and admitted (not READY_TO_SEAL)", { current: "ALWAYS" }),
    UPLOADS_UNRESOLVED,
    outcome("COMMAND", "PRECONDITION_FAILED", "INPUT_NOT_ADMITTED", "an included file's admission was revoked (its intake expired or its generation was lost): no executable sealed revision is left", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "GENERATION_CHANGED", "an included file's accepted generation, digest or length is not the one the evaluation counted", { current: "ALWAYS" }),
    // design §11 CMD017 step 8 (D-RET-3): the first seal of the bytes is fourteen days old or more — the record would be born
    // expired; reuse after the window needs a new upload (decision D-CMD-6: the specified answer the catalogue had omitted)
    outcome("COMMAND", "PRECONDITION_FAILED", "REUSE_NOT_AVAILABLE", "a reused file's bytes were first sealed fourteen days ago or more: their hard cap is behind this seal, so reuse needs a new upload (D-RET-3)", { current: "ALWAYS" }),
  ],
});

const HEADER_COMMANDS: ReadonlySet<B07CommandId> = new Set(["CMD012", "CMD013", "CMD014", "CMD015", "CMD016", "CMD017"]);

function commandCatalogue(command: B07CommandId): ReadonlyArray<ProblemOutcome> {
  return closedCatalogue(command, [...EVERY_ROUTE, ...COOKIE_CSRF, ...PATH_IDS, ...TENANT, ...(HEADER_COMMANDS.has(command) ? AGENCY_HEADER : []), ...COMMAND_SPECIFIC[command]]);
}

/** The closed problem catalogue of each B07 command. */
export const SOURCE_COMMAND_OUTCOMES: Readonly<Record<B07CommandId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  CMD012: commandCatalogue("CMD012"),
  CMD013: commandCatalogue("CMD013"),
  CMD014: commandCatalogue("CMD014"),
  CMD015: commandCatalogue("CMD015"),
  CMD016: commandCatalogue("CMD016"),
  CMD017: commandCatalogue("CMD017"),
});

// --- auxiliary routes (design §10.2; decisions D-SEL-2, D-SAPI-1) ---------------------------------------------------------------

/** The auxiliary routes of the source lifecycle, by operation id (contracts.ts SOURCE_ROUTES carries method, path and role). */
export type SourceRouteId = "SubmitSelectionManifest" | "GetSelectionManifest" | "GetRevision" | "GetInspection" | "ListUploads" | "GetUpload" | "GetUploadSession" | "PreviewTable";
/** The document intake among them (a POST that stores a document, D-SEL-2). */
export type SourceIntakeId = "SubmitSelectionManifest";
/** The reads among them (GET, served as manual-10 reads). */
export type SourceReadId = Exclude<SourceRouteId, SourceIntakeId>;

const SELECTION_DOCUMENT: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("COMMAND", "INVALID_REQUEST", "SELECTION_MANIFEST_MISMATCH", "the document names another revision than the path"),
  outcome("COMMAND", "INVALID_REQUEST", "EXCLUSION_REASON_REQUIRED", "an exclusion names no reason"),
  outcome("COMMAND", "INVALID_REQUEST", "HIDDEN_SHEET_NOT_ACKNOWLEDGED", "a hidden worksheet is included without its explicit acknowledgement"),
  outcome("COMMAND", "INVALID_REQUEST", "PARSER_CHOICE_INVALID", "an included table's parser choice does not fit its kind"),
  outcome("COMMAND", "INVALID_REQUEST", "PROJECTION_INVALID", "a projection or association names what the document does not include"),
  // a referenced-entity projection without the key the agency confirmed is a defect of the document itself (03 "Count the correct
  // population"): the intake refuses it with CMD016's own reason (decision D-CMD-6: the catalogue completed where it was silent)
  outcome("COMMAND", "INVALID_REQUEST", "PROJECTION_KEY_NOT_CONFIRMED", "a referenced-entity projection names no key the agency confirmed"),
  outcome("COMMAND", "INVALID_REQUEST", "SELECTED_COLUMNS_LIMIT", "a table selects more than 800 columns"),
]);

const ROUTE_SPECIFIC: Readonly<Record<SourceRouteId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  /** Non-journaled, content-idempotent intake (D-SEL-2): a body admission route without an idempotency key. */
  SubmitSelectionManifest: [
    ...EVERY_ROUTE.filter((o) => o.layer !== "IDEMPOTENCY" && o.reason !== "IDEMPOTENCY_KEY_MISSING" && o.reason !== "IDEMPOTENCY_KEY_INVALID"),
    ...COOKIE_CSRF,
    ...PATH_IDS,
    ...TENANT,
    ...AGENCY_HEADER,
    NOT_VISIBLE("the revision"),
    outcome("COMMAND", "PRECONDITION_FAILED", "REVISION_NOT_SELECTABLE", "the revision takes no new selection (not DRAFT, UPLOADING, INSPECTING or READY_TO_SEAL)", { current: "ALWAYS" }),
    ...SELECTION_DOCUMENT,
  ],
  GetSelectionManifest: [...EVERY_READ, ...PATH_IDS, ...TENANT_READ, ...AGENCY_HEADER, NO_QUERY, NOT_VISIBLE("the selection manifest")],
  GetRevision: [...EVERY_READ, ...PATH_IDS, ...TENANT_READ, ...AGENCY_HEADER, NO_QUERY, NOT_VISIBLE("the revision")],
  GetInspection: [...EVERY_READ, ...PATH_IDS, ...TENANT_READ, ...AGENCY_HEADER, NO_QUERY, NOT_VISIBLE("the revision")],
  ListUploads: [...EVERY_READ, ...PATH_IDS, ...TENANT_READ, ...AGENCY_HEADER, ...PAGINATED, NOT_VISIBLE("the revision")],
  GetUpload: [...EVERY_READ, ...PATH_IDS, ...TENANT_READ, ...AGENCY_HEADER, NO_QUERY, NOT_VISIBLE("the upload")],
  /** The protected session read: the requester only, the command's role (D-SESSION-2). */
  GetUploadSession: [...EVERY_READ, ...PATH_IDS, ...TENANT, ...AGENCY_HEADER, NO_QUERY, NOT_VISIBLE("the upload")],
  /** 10 "A preview endpoint returns a bounded authorized sample with safe display escaping and no shared caching" (D-SAPI-7). */
  PreviewTable: [
    ...EVERY_READ,
    ...PATH_IDS,
    ...TENANT_READ,
    ...AGENCY_HEADER,
    NO_QUERY,
    NOT_VISIBLE("the table"),
    outcome("COMMAND", "PRECONDITION_FAILED", "INPUT_NOT_ADMITTED", "the table's file is not an admitted file of the revision's project"),
    SERVICES,
  ],
});

/** The closed problem catalogue of each auxiliary route. */
export const SOURCE_ROUTE_OUTCOMES: Readonly<Record<SourceRouteId, ReadonlyArray<ProblemOutcome>>> = Object.freeze(
  Object.fromEntries(Object.entries(ROUTE_SPECIFIC).map(([id, entries]) => [id, closedCatalogue(id, entries)])) as Record<SourceRouteId, ReadonlyArray<ProblemOutcome>>,
);
