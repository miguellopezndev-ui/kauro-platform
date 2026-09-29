/**
 * Safe reason codes of processing authority (package B08; docs/design/B08-audit-approval-jobs.md §9 "SQLSTATE translation",
 * D8-SQL-1). They narrow the stable failure codes exactly like the B06, B07 and B09 reasons do — machine tokens that never carry a
 * customer value — and are appended to the closed FAILURE_REASONS list of model/errors.ts. This module imports nothing: the
 * failure taxonomy depends on it, never the reverse.
 */
export const EXECUTION_FAILURE_REASONS = [
  // KA080: an attempt or step that is not the lease's current owner at its fence, or an object outside its own prefix
  "EXECUTION_FENCED",
  // KA081: the authorization, the cancellation or a bound fact no longer admits the edge
  "EXECUTION_AUTHORITY_LOST",
  // KA082: a capacity ledger disagrees with the jobs it summarizes
  "CAPACITY_LEDGER",
  // the ledgers' CHECKs: no slot of the global or the agency's bound is free (retryable)
  "EXECUTION_QUEUE_FULL",
  // KA084: a package without its read-back or verification evidence
  "PUBLICATION_EVIDENCE_MISSING",
  // KA083 and the grant ceiling of migration 0021 (the audit half of B08): translated here with the rest of D8-SQL-1
  "NO_FUNDED_GRANT",
  "GRANT_CEILING",
  // ExecuteProject (CMD036): the commercial authorization is no longer ACTIVE, so no job may be bound to it (D8-AUTH-1)
  "AUTHORIZATION_REVOKED",
  // CancelJob (CMD037): the job already ended (FAILED, CANCELLED or EXPIRED) — a cancellation has nothing left to stop
  "JOB_TERMINAL",
  // CancelJob (CMD037): the publication committed first (S062) — the job is READY and its package is the answer, never a rollback
  "JOB_ALREADY_READY",
] as const;

export type ExecutionFailureReason = (typeof EXECUTION_FAILURE_REASONS)[number];
