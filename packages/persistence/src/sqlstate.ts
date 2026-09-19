/**
 * SQLSTATE vocabulary raised by the kauro schema (migrations/0001) and its translation into the failure taxonomy of
 * @kauro/domain. Adapters catch a pg DatabaseError, read `code`, and raise the DomainFailure the command contract names;
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
  // PostgreSQL classes the adapters also translate
  UNIQUE_VIOLATION: "23505",
  FOREIGN_KEY_VIOLATION: "23503",
  CHECK_VIOLATION: "23514",
  RLS_VIOLATION: "42501",
  SERIALIZATION_FAILURE: "40001",
  DEADLOCK_DETECTED: "40P01",
  LOCK_NOT_AVAILABLE: "55P03",
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
  "23503": { code: "INVALID_REQUEST", reason: "UNKNOWN_REFERENCE" },
  "23514": { code: "INVALID_REQUEST" },
  "42501": { code: "NOT_FOUND", reason: "TENANT_CONTEXT_MISSING" },
  "40001": { code: "CAPACITY_UNAVAILABLE", retryable: true },
  "40P01": { code: "CAPACITY_UNAVAILABLE", retryable: true },
  "55P03": { code: "CAPACITY_UNAVAILABLE", retryable: true },
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
  const m = MAP[sqlState];
  if (!m) return null;
  return new DomainFailure(m.code, `database refused the write (${sqlState})`, m.reason ? { reason: m.reason } : {}, m.retryable ?? false);
}
