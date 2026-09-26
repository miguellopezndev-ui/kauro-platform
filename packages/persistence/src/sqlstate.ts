/**
 * SQLSTATE vocabulary raised by the kauro schema (migrations/0001; the KP class of the payments and fiscal workflow, migrations
 * 0008..0012, package B09) and its translation into the failure taxonomy of @kauro/domain. Adapters catch a pg DatabaseError, read `code`, and raise the DomainFailure the command contract names;
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
  // package B09 (migrations 0008..0012; docs/design/B09-payments-fiscal.md §7.3): the database backstops of the commerce rules
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
  refunds_reason_code_label: "reasonCode",
});

/**
 * Translates a database error code into a DomainFailure, or null when the adapter must decide by context (a unique violation
 * is IDEMPOTENCY replay, LAST-approval race or DRAFT_AGENCY_EXISTS depending on the constraint name it carries).
 */
export function failureOfSqlState(sqlState: string | undefined, constraint?: string): DomainFailure | null {
  if (!sqlState) return null;
  if (sqlState === SQLSTATE.UNIQUE_VIOLATION) {
    if (constraint === "agencies_one_draft_per_creator") return new DomainFailure("ADMISSION_LIMITED", "one draft agency per identity", { reason: "DRAFT_AGENCY_EXISTS" });
    // command_journal_identity (concurrent duplicate), approvals_one_live_per_plan (lost approval race) and
    // plans_supersedes_once (lost revision race) are decided by the handler, which re-reads the current row and answers
    // with the replayed result or STALE_VERSION carrying the current safe version.
    return null;
  }
  if (sqlState === SQLSTATE.CHECK_VIOLATION && constraint !== undefined && LABEL_CONSTRAINT_FIELDS[constraint] !== undefined) {
    return new DomainFailure("INVALID_REQUEST", `database refused the write (${sqlState} ${constraint})`, { reason: "SCHEMA_VIOLATION", fields: [{ field: LABEL_CONSTRAINT_FIELDS[constraint] as string, code: "FORMAT" }] });
  }
  const m = MAP[sqlState];
  if (!m) return null;
  return new DomainFailure(m.code, `database refused the write (${sqlState})`, m.reason ? { reason: m.reason } : {}, m.retryable ?? false);
}
