/**
 * SQLSTATE vocabulary raised by the kauro schema (migrations/0001; the KA07x class of the source lifecycle, migrations 0009..0012,
 * package B07; the KP class of the payments and fiscal workflow, migrations
 * 0013..0017, package B09; the KA08x class of processing authority, migrations 0019..0021, package B08) and its translation into
 * the failure taxonomy of @kauro/domain. Adapters catch a pg DatabaseError, read `code`, and raise the DomainFailure the command contract names;
 * the SQL message never leaves the server (10 "Responses and safe errors").
 */
import { DomainFailure, type FailureCode, type FailureReason } from "@kauro/domain";

export const SQLSTATE = Object.freeze({
  LAST_OWNER: "KA001",
  VERSION_DISCIPLINE: "KA002",
  EVENT_MISSING: "KA003",
  IMMUTABLE_COLUMN: "KA004",
  LEASE: "KA005",
  CONTEXT: "KA006",
  JOURNAL: "KA007",
  UNLISTED_TRANSITION: "KA008",
  UPSTREAM_UNRESOLVED: "KA009",
  // a membership or invitation write without the acting session's team authority (migration 0002, re-check finding N11)
  MEMBERSHIP_AUTHORITY: "KA010",
  // an invitation consumed, revoked or expired, or an acceptance without a consumed invitation (0002, finding N19)
  INVITATION_NOT_OPEN: "KA011",
  // an inbox record settled while a delivery of the same event carried another body (0005, finding N2)
  INBOX_BODY_CONFLICT: "KA012",
  // a live approval on a plan that is not APPROVED under it (migration 0004, the deferred constraint triggers
  // plans_live_approval_binding and approvals_live_approval_binding; decision D-PLAN-4)
  LIVE_APPROVAL_UNBOUND: "KA020",
  // B07 source lifecycle (migrations 0009..0012; decision D-SQL-1: a range of its own): a quota ledger that disagrees with its
  // uploads, a fence that moved backwards or a stale attempt that wrote, a lifecycle transition without the facts its state needs
  QUOTA_LEDGER: "KA070",
  FENCE_DISCIPLINE: "KA071",
  LIFECYCLE_BINDING: "KA072",
  // package B09 (migrations 0013..0017; docs/design/B09-payments-fiscal.md §7): the database backstops of the commerce rules
  LEDGER_UNBALANCED: "KP001",
  OBLIGATION_OVER_ALLOCATED: "KP002",
  REFUND_EXCEEDS_REMAINING: "KP003",
  AUTHORITY_WITHOUT_CAPTURE: "KP004",
  FACT_REGRESSION: "KP005",
  AUTHORITY_OUTLIVES_REVERSAL: "KP006",
  CORPORATE_ROLE_MISSING: "KP007",
  SELF_APPROVAL_FORBIDDEN: "KP008",
  COMMITMENT_ISOLATION: "KP009",
  POLICY_NOT_APPLICABLE: "KP010",
  FISCAL_VALIDATION_REFUSED: "KP011",
  REFUND_TAX_INCONSISTENT: "KP012",
  REPLACEMENT_REFUSED: "KP013",
  // package B08 (migrations 0019..0021; docs/design/B08-audit-approval-jobs.md §9, D8-SQL-1): the fence of an attempt or a step, the
  // authority an execution edge relies on, the capacity ledgers, the funded grant and the publication evidence
  EXECUTION_FENCE: "KA080",
  EXECUTION_AUTHORITY: "KA081",
  CAPACITY_LEDGER: "KA082",
  GRANT_UNFUNDED: "KA083",
  PUBLICATION_EVIDENCE: "KA084",
  // PostgreSQL classes the adapters also translate
  UNIQUE_VIOLATION: "23505",
  FOREIGN_KEY_VIOLATION: "23503",
  CHECK_VIOLATION: "23514",
  RLS_VIOLATION: "42501",
  SERIALIZATION_FAILURE: "40001",
  DEADLOCK_DETECTED: "40P01",
  LOCK_NOT_AVAILABLE: "55P03",
  // statement_timeout / lock wait cancelled inside a unit of work: resource saturation, retryable (07 "Command outcomes")
  QUERY_CANCELED: "57014",
});

const MAP: Readonly<Record<string, { code: FailureCode; reason?: FailureReason; retryable?: boolean }>> = Object.freeze({
  KA001: { code: "PRECONDITION_FAILED", reason: "LAST_OWNER_PROTECTED" },
  KA002: { code: "INTEGRITY_FAILURE", reason: "VERSION_DISCIPLINE" },
  KA003: { code: "INTEGRITY_FAILURE", reason: "EVENT_MISSING" },
  KA004: { code: "INTEGRITY_FAILURE", reason: "IMMUTABLE_COLUMN" },
  KA005: { code: "PRECONDITION_FAILED", reason: "LEASE_FENCED" },
  KA006: { code: "NOT_FOUND", reason: "TENANT_CONTEXT_MISSING" },
  KA007: { code: "PRECONDITION_FAILED", reason: "UNLISTED_TRANSITION" },
  KA008: { code: "PRECONDITION_FAILED", reason: "UNLISTED_TRANSITION" },
  KA009: { code: "PRECONDITION_FAILED", reason: "UPSTREAM_UNRESOLVED" },
  KA010: { code: "NOT_AUTHORIZED", reason: "ROLE_INSUFFICIENT" },
  KA011: { code: "PRECONDITION_FAILED", reason: "INVITATION_NOT_OPEN" },
  KA012: { code: "PRECONDITION_FAILED", reason: "INBOX_BODY_CONFLICT" },
  KA020: { code: "INTEGRITY_FAILURE", reason: "LIVE_APPROVAL_UNBOUND" },
  KA070: { code: "INTEGRITY_FAILURE", reason: "QUOTA_LEDGER" },
  KA071: { code: "PRECONDITION_FAILED", reason: "FENCE_DISCIPLINE" },
  KA072: { code: "INTEGRITY_FAILURE", reason: "LIFECYCLE_BINDING_MISSING" },
  // a handler that follows the domain rules never meets these; the ones a racing request can meet answer as the command would
  KP001: { code: "INTEGRITY_FAILURE", reason: "LEDGER_UNBALANCED" },
  KP002: { code: "INTEGRITY_FAILURE", reason: "OBLIGATION_OVER_ALLOCATED" },
  KP003: { code: "PRECONDITION_FAILED", reason: "REFUND_EXCEEDS_REMAINING" },
  KP004: { code: "INTEGRITY_FAILURE", reason: "AUTHORITY_WITHOUT_CAPTURE" },
  KP005: { code: "INTEGRITY_FAILURE", reason: "FACT_REGRESSION" },
  KP006: { code: "INTEGRITY_FAILURE", reason: "AUTHORITY_OUTLIVES_REVERSAL" },
  KP007: { code: "NOT_AUTHORIZED", reason: "CORPORATE_ROLE_MISSING" },
  KP008: { code: "NOT_AUTHORIZED", reason: "SELF_APPROVAL_FORBIDDEN" },
  KP009: { code: "INTEGRITY_FAILURE", reason: "COMMITMENT_ISOLATION" },
  KP010: { code: "ASSURANCE_REQUIRED", reason: "POLICY_NOT_APPLICABLE" },
  KP011: { code: "INTEGRITY_FAILURE", reason: "FISCAL_VALIDATION_REFUSED" },
  // a racing approval of another refund of the capture can change the basis the tax follows (D-REF-B6)
  KP012: { code: "PRECONDITION_FAILED", reason: "REFUND_TAX_INCONSISTENT" },
  // the included source replacement is used, execution started, or the purchase is not intact (D-QUOTE-B6)
  KP013: { code: "PRECONDITION_FAILED", reason: "REPLACEMENT_NOT_ALLOWED" },
  // package B08 (D8-SQL-1): the control plane treats a lost fence as "the attempt or step lost" (DONE); a lost authority refuses the
  // edge; a ledger edited around its jobs and a publication without its evidence are integrity failures; an unfunded dispatch is
  // BUDGET_EXHAUSTED
  KA080: { code: "PRECONDITION_FAILED", reason: "EXECUTION_FENCED" },
  KA081: { code: "PRECONDITION_FAILED", reason: "EXECUTION_AUTHORITY_LOST" },
  KA082: { code: "INTEGRITY_FAILURE", reason: "CAPACITY_LEDGER" },
  KA083: { code: "BUDGET_EXHAUSTED", reason: "NO_FUNDED_GRANT" },
  KA084: { code: "INTEGRITY_FAILURE", reason: "PUBLICATION_EVIDENCE_MISSING" },
  "23503": { code: "INVALID_REQUEST", reason: "UNKNOWN_REFERENCE" },
  "23514": { code: "INVALID_REQUEST" },
  "42501": { code: "NOT_FOUND", reason: "TENANT_CONTEXT_MISSING" },
  "40001": { code: "CAPACITY_UNAVAILABLE", retryable: true },
  "40P01": { code: "CAPACITY_UNAVAILABLE", retryable: true },
  "55P03": { code: "CAPACITY_UNAVAILABLE", retryable: true },
  "57014": { code: "CAPACITY_UNAVAILABLE", retryable: true },
});

/**
 * The request fields whose label CHECK constraints the migrations name (re-check finding N6): the request schema refuses
 * exactly what kauro.is_label refuses, so these can only fire when a writer bypassed the schema; when one does, the refusal still
 * names the field instead of answering a reasonless 400 (10 "frontend control flow uses the code and typed fields").
 */
export const LABEL_CONSTRAINT_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  agencies_display_name_label: "displayName",
  end_clients_display_name_label: "displayName",
  projects_purpose_label: "purpose",
  approvals_withdraw_reason_label: "reasonCode",
  // B07: CMD013 ReserveUpload displayName (migration 0009)
  upload_sessions_display_name_label: "displayName",
  // B09: CMD031 RequestRefund reasonCode (migration 0016)
  refunds_reason_code_label: "reasonCode",
});

/**
 * B07's refusal translation (docs/design/B07-upload-source-lifecycle.md §3.3): the constraints of the source lifecycle whose
 * refusal is a business outcome a request can meet — the intake envelope and the agency's session limit decided on the committed
 * ledgers (R2-052), a project's one mutable revision and a predecessor replaced once — and the deadline checks a writer on the
 * wrong side of the server clock meets (D-EXP-1: the same class as KA072, "a deadline edge on the wrong side of its deadline").
 * Keyed by the constraint (or unique index) name the error carries, for its SQLSTATE.
 */
export const SOURCE_CONSTRAINT_FAILURES: Readonly<Record<string, { readonly sqlState: string; readonly code: FailureCode; readonly reason: FailureReason; readonly retryable?: boolean }>> = Object.freeze({
  revision_quota_bytes_within_envelope: { sqlState: "23514", code: "PRECONDITION_FAILED", reason: "REVISION_QUOTA_EXCEEDED" },
  revision_quota_files_within_envelope: { sqlState: "23514", code: "PRECONDITION_FAILED", reason: "REVISION_FILE_LIMIT" },
  upload_sessions_reserved_bytes_check: { sqlState: "23514", code: "PRECONDITION_FAILED", reason: "FILE_TOO_LARGE" },
  // a slot frees when a live session ends: the caller may retry later (429)
  upload_capacity_within_limit: { sqlState: "23514", code: "ADMISSION_LIMITED", reason: "UPLOAD_CONCURRENCY_LIMITED", retryable: true },
  dataset_revisions_one_mutable_per_project: { sqlState: "23505", code: "PRECONDITION_FAILED", reason: "REVISION_NOT_MUTABLE" },
  dataset_revisions_supersedes_once: { sqlState: "23505", code: "PRECONDITION_FAILED", reason: "PREDECESSOR_NOT_CURRENT" },
  retention_records_expiry_not_early: { sqlState: "23514", code: "INTEGRITY_FAILURE", reason: "LIFECYCLE_BINDING_MISSING" },
  upload_sessions_expiry_not_early: { sqlState: "23514", code: "INTEGRITY_FAILURE", reason: "LIFECYCLE_BINDING_MISSING" },
});

/**
 * Processing authority's capacity checks (package B08; D8-CAP-1, D8-CAP-2; migration 0019): no slot of the platform's active or
 * waiting bound, or of the agency's live-job bound, is free — CAPACITY_UNAVAILABLE EXECUTION_QUEUE_FULL, retryable once a slot frees.
 * Keyed by the constraint name the error carries, for its SQLSTATE.
 */
export const EXECUTION_CONSTRAINT_FAILURES: Readonly<Record<string, { readonly sqlState: string; readonly code: FailureCode; readonly reason: FailureReason; readonly retryable?: boolean }>> = Object.freeze({
  execution_capacity_active_within_limit: { sqlState: "23514", code: "CAPACITY_UNAVAILABLE", reason: "EXECUTION_QUEUE_FULL", retryable: true },
  execution_capacity_waiting_within_limit: { sqlState: "23514", code: "CAPACITY_UNAVAILABLE", reason: "EXECUTION_QUEUE_FULL", retryable: true },
  agency_execution_capacity_live_within_limit: { sqlState: "23514", code: "CAPACITY_UNAVAILABLE", reason: "EXECUTION_QUEUE_FULL", retryable: true },
});

/**
 * Commerce unique indexes a racing request can meet, decided by their name (package B09, design §7): a second open checkout of a
 * project is PAYMENT_PENDING (retry with the same key once the open order settles), a second open request of a capture and origin
 * is REFUND_REQUEST_OPEN, and a second capture.completed.v1 of one capture is an integrity failure (a reconciler that follows
 * D-EVT-B2 never meets it).
 */
const COMMERCE_UNIQUE_FAILURES: Readonly<Record<string, () => DomainFailure>> = Object.freeze({
  payment_orders_one_open_per_project: () => new DomainFailure("PAYMENT_PENDING", "the project already has an open checkout", { reason: "CREATION_IN_PROGRESS" }, true),
  refunds_one_requested_per_origin: () => new DomainFailure("PRECONDITION_FAILED", "a request of this capture already awaits review", { reason: "REFUND_REQUEST_OPEN" }),
  domain_events_capture_completed_once: () => new DomainFailure("INTEGRITY_FAILURE", "a capture publishes its completion once", { reason: "EVENT_MISSING" }),
});

/**
 * Commerce unique indexes the handler decides (it re-reads the current row, B06 practice): the replayed or current entitlement
 * (commercial_authorizations_one_*), and the capture identity already recorded (capture_facts_provider_identity: the observation is a
 * DUPLICATE). They surface as ConstraintViolation carrying the constraint name; `commerceReplayOf` names what the handler answers.
 */
export const COMMERCE_REPLAY_CONSTRAINTS: Readonly<Record<string, "AUTHORIZATION_REPLAY" | "DUPLICATE_CAPTURE">> = Object.freeze({
  commercial_authorizations_one_per_quote: "AUTHORIZATION_REPLAY",
  commercial_authorizations_one_original_per_capture: "AUTHORIZATION_REPLAY",
  commercial_authorizations_one_per_rebinding: "AUTHORIZATION_REPLAY",
  commercial_authorizations_one_live_per_capture: "AUTHORIZATION_REPLAY",
  commercial_authorizations_one_live_per_project: "AUTHORIZATION_REPLAY",
  capture_facts_provider_identity: "DUPLICATE_CAPTURE",
});

/** What a unique violation of a commerce write means to its handler, when it is one of COMMERCE_REPLAY_CONSTRAINTS. */
export function commerceReplayOf(sqlState: string | undefined, constraint: string | undefined): "AUTHORIZATION_REPLAY" | "DUPLICATE_CAPTURE" | null {
  if (sqlState !== SQLSTATE.UNIQUE_VIOLATION || constraint === undefined) return null;
  return COMMERCE_REPLAY_CONSTRAINTS[constraint] ?? null;
}

/**
 * Checks and keys that only a writer bypassing the domain rules meets (design §7, the second revision's guards): the claim's own
 * deadline (payment_attempts_dispatch_deadline_bound; the claim writes the database's deadline), the fiscal lineage
 * (fiscal_profiles_supersession_lineage, fiscal_profiles_successor_fk; a re-review writes its two instants as one), the ledger's
 * account rules (ledger_entries_funds_accounts, ledger_entries_bank_accounts; postings come from planPostings) and the attempt and
 * case bindings of D-BIND-B2. They are integrity failures, never B06's default INVALID_REQUEST.
 */
export const COMMERCE_INTEGRITY_CONSTRAINTS: ReadonlySet<string> = new Set([
  "payment_attempts_dispatch_deadline_bound",
  "fiscal_profiles_supersession_lineage",
  "fiscal_profiles_successor_fk",
  "ledger_entries_funds_accounts",
  "ledger_entries_bank_accounts",
  "payment_attempts_order_binding",
  "provider_observations_attempt_fk",
  "capture_facts_attempt_fk",
  "provider_event_exceptions_attempt_fk",
  "reconciliation_cases_capture_order_fk",
  "reconciliation_cases_refund_order_fk",
  "reconciliation_cases_refund_capture_fk",
  "reconciliation_cases_refund_own_capture_fk",
]);

/**
 * Translates a database error code into a DomainFailure, or null when the adapter must decide by context (a unique violation
 * is IDEMPOTENCY replay, LAST-approval race or DRAFT_AGENCY_EXISTS depending on the constraint name it carries).
 */
export function failureOfSqlState(sqlState: string | undefined, constraint?: string): DomainFailure | null {
  if (!sqlState) return null;
  const source = constraint === undefined ? undefined : (SOURCE_CONSTRAINT_FAILURES[constraint] ?? EXECUTION_CONSTRAINT_FAILURES[constraint]);
  if (source !== undefined && source.sqlState === sqlState) {
    return new DomainFailure(source.code, `database refused the write (${sqlState} ${constraint ?? ""})`, { reason: source.reason }, source.retryable ?? false);
  }
  if (constraint !== undefined && COMMERCE_INTEGRITY_CONSTRAINTS.has(constraint) && (sqlState === SQLSTATE.CHECK_VIOLATION || sqlState === SQLSTATE.FOREIGN_KEY_VIOLATION || sqlState === SQLSTATE.UNIQUE_VIOLATION)) {
    return new DomainFailure("INTEGRITY_FAILURE", `database refused the write (${sqlState} ${constraint})`);
  }
  if (sqlState === SQLSTATE.UNIQUE_VIOLATION) {
    if (constraint === "agencies_one_draft_per_creator") return new DomainFailure("ADMISSION_LIMITED", "one draft agency per identity", { reason: "DRAFT_AGENCY_EXISTS" });
    const commerce = constraint === undefined ? undefined : COMMERCE_UNIQUE_FAILURES[constraint];
    if (commerce !== undefined) return commerce();
    // command_journal_identity (concurrent duplicate), approvals_one_live_per_plan (lost approval race) and
    // plans_supersedes_once (lost revision race) are decided by the handler, which re-reads the current row and answers
    // with the replayed result or STALE_VERSION carrying the current safe version; so are the commerce replay constraints
    // (COMMERCE_REPLAY_CONSTRAINTS).
    return null;
  }
  if (sqlState === SQLSTATE.CHECK_VIOLATION && constraint !== undefined && LABEL_CONSTRAINT_FIELDS[constraint] !== undefined) {
    return new DomainFailure("INVALID_REQUEST", `database refused the write (${sqlState} ${constraint})`, { reason: "SCHEMA_VIOLATION", fields: [{ field: LABEL_CONSTRAINT_FIELDS[constraint] as string, code: "FORMAT" }] });
  }
  const m = MAP[sqlState];
  if (!m) return null;
  return new DomainFailure(m.code, `database refused the write (${sqlState})`, m.reason ? { reason: m.reason } : {}, m.retryable ?? false);
}
