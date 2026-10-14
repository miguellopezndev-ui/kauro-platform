/**
 * SQLSTATE vocabulary raised by the kauro schema (migrations/0001; the KA07x class of the source lifecycle, migrations 0009..0012,
 * package B07; the KP class of the payments and fiscal workflow, migrations
 * 0013..0017, package B09; the KA08x class of processing authority, migrations 0021..0023, package B08) and its translation into
 * the failure taxonomy of @kauro/domain. Adapters catch a pg DatabaseError, read `code`, and raise the DomainFailure the command contract names;
 * the SQL message never leaves the server (10 "Responses and safe errors").
 */
import { DomainFailure, LiveQuoteChangedFailure, StaleVersionFailure, type FailureCode, type FailureReason } from "@kauro/domain";

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
  // Payments V1 (migration 0080, lane L-REFUND): a manual-rail refund or treasury refund completed without its recorded execution
  EXECUTION_EVIDENCE_MISSING: "KP014",
  // package B10 (migrations 0028..0031; docs/design/B10-commercial-domain.md §12): each stage-2 lane adds the KC codes its adapters
  // surface. B10-ADAPTERS-RECURRENCE: the designation's writes and the founding reservation's release (0028)
  DESIGNATION_REWRITE: "KC001",
  RESERVATION_RELEASE_REFUSED: "KC014",
  // package B10 (migrations 0028..0031; docs/design/B10-commercial-domain.md §12): the sales and attribution backstops (0029) the
  // sales adapters surface
  SHARES_NOT_WHOLE: "KC003",
  SELLER_NOT_ACTIVATABLE: "KC005",
  TAIL_NOT_ENUMERATED: "KC011",
  PROSPECT_SUPPRESSED: "KC016",
  // package B10 (migrations 0030 and 0031): the ledger and statement backstops (B10-ADAPTERS-LEDGER)
  COMMISSION_POOL_MISMATCH: "KC002",
  ELIGIBILITY_WITHOUT_FINAL_COMPLETION: "KC007",
  PAYEE_UNVERIFIED: "KC009",
  PAYOUT_NOT_SETTLED: "KC010",
  ADJUSTMENT_NOT_CUMULATIVE: "KC015",
  OFFSET_NOT_AUTHORIZED: "KC017",
  // package B10 (migration 0036, B10G-R2): an intent whose statement's payable lines cannot pay
  PAYOUT_LINES_NOT_PAYABLE: "KC018",
  // package B10 (migration 0037, B10G-R1): a line payable through a second live statement
  PAYABLE_OWNER: "KC019",
  // package B10 (migration 0040, B10G-R7 r2): a payout's step-up expired before its COMMIT
  STEP_UP_EXPIRED: "KC020",
  // package B10 (migration 0049, lane 6c ADV-1): a claim accepted past its review deadline, judged at COMMIT
  CLAIM_ACCEPTED_PAST_DEADLINE: "KC021",
  // package B10 lane OFFSET (migration 0055, G-ORD-1): a commission line a lock call named does not exist / a transaction's second lock call would have to wait
  COMMISSION_LINE_NOT_FOUND: "KC022",
  COMMISSION_LOCK_ORDER: "KC027",
  // package B10 (migration 0028): the agency closure residuals the lifecycle adapter surfaces (docs/design/B10-commercial-domain.md §12)
  CLOSURE_RESIDUALS_OPEN: "KC006",
  // package B08 (migrations 0021..0023; docs/design/B08-audit-approval-jobs.md §9, D8-SQL-1): the fence of an attempt or a step, the
  // authority an execution edge relies on, the capacity ledgers, the funded grant and the publication evidence
  EXECUTION_FENCE: "KA080",
  EXECUTION_AUTHORITY: "KA081",
  CAPACITY_LEDGER: "KA082",
  GRANT_UNFUNDED: "KA083",
  PUBLICATION_EVIDENCE: "KA084",
  // package B16 (tenant isolation, retention, deletion, breakglass, download, restore): KA085..KA094 are RESERVED for lanes L2..L8, named by
  // lane so two lanes never pick the same code (tools/test/ka-codes.test.mjs). A lane that raises one renames its constant to the
  // refusal it names, adds its MAP entry and its migration, and keeps the value.
  B16_L2_RETENTION_A: "KA085",
  B16_L2_RETENTION_B: "KA086",
  B16_L3_PROJECT_DELETION_REQUESTED: "KA087",
  B16_L3_DELETION_EVIDENCE: "KA088",
  // lane L4 (migration kauro.breakglass_grants_birth): the authorization does not justify the breakglass scope now
  B16_L4_BREAKGLASS_SCOPE_UNAUTHORIZED: "KA089",
  // L5 (CMD038, migration kauro.download_authorizations) raises KA094 from the top of the range down; L8 keeps one reserve at KA090
  B16_L8_RESERVE_A: "KA090",
  // L6 (0076): a claim while a restore holds the recovery gate closed; a restore step out of its journal order or unreconciled
  B16_L6_RECOVERY_GATE: "KA091",
  B16_L6_RESTORE_RECONCILIATION: "KA092",
  B16_L7_STAGE_RELEASE_A: "KA093",
  B16_L5_DOWNLOAD_AUTHORIZATION: "KA094",
  // package B12 (migration 0088, plan §3): the outreach bindings, the send fence (edges, claim columns, LOCK_NOT_HELD), the activity
  // facts and the non-owner suppression of a prospect; KC028..KC037 the outreach refusals the database backs (rule 17)
  OUTREACH_BINDING: "KA095",
  SEND_FENCE: "KA096",
  ACTIVITY_EVIDENCE: "KA097",
  OUTREACH_SUPPRESSION_SCOPE: "KA098",
  OUTREACH_ROUTE_FORBIDDEN: "KC028",
  SEND_UNCERTAIN_UNRESOLVED: "KC029",
  OUTREACH_GRANT_INVALID: "KC030",
  SENDER_NOT_VERIFIED: "KC031",
  OUTREACH_CAP_REACHED: "KC032",
  RESOURCE_NOT_CURRENT: "KC033",
  OUTREACH_PAUSED: "KC034",
  OUTREACH_REVIEW_INVALID: "KC035",
  OUTREACH_ALREADY_SENT: "KC036",
  OUTREACH_CALENDAR_UNAVAILABLE: "KC037",
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
  // never met by a handler that records the execution before the completion (ACH-ROUTE §7.22: never REFUNDED without execution evidence)
  KP014: { code: "INTEGRITY_FAILURE", reason: "EXECUTION_EVIDENCE_MISSING" },
  // package B10 (D10-ERR-1): a designation or a qualifying purchase is written by the designation trigger alone and never rewritten;
  // a founding reservation is released only once its quote ended, naming how, with its slot freed (a race with a checkout meets it)
  KC001: { code: "INTEGRITY_FAILURE", reason: "DESIGNATION_REWRITE" },
  KC014: { code: "PRECONDITION_FAILED", reason: "RESERVATION_RELEASE_REFUSED" },
  // B10's sales backstops answer as the commands would (design §12): an allocation whose shares are not exactly 10000 bps of accepted
  // claims under signed agreements, an activation missing a fact, a tail entry for an opportunity the termination could not
  // enumerate, a prospect whose organization or contact is suppressed
  KC003: { code: "PRECONDITION_FAILED", reason: "SHARES_NOT_WHOLE" },
  KC005: { code: "PRECONDITION_FAILED", reason: "SELLER_NOT_ACTIVATABLE" },
  KC011: { code: "PRECONDITION_FAILED", reason: "TAIL_NOT_ENUMERATED" },
  KC016: { code: "PRECONDITION_FAILED", reason: "PROSPECT_SUPPRESSED" },
  // B10's ledger backstops answer as the commands would (design 12): a pool that is not round(basis x rate) once and the exact sum of its
  // lines, an eligibility without a FINAL completion 720 hours old with funds available and no covering hold, and an adjustment that is not
  // the cumulative difference or a basis that rises are the database refusing what the adapter never writes (INTEGRITY_FAILURE); a payee
  // that is not a verified destination version, a payout without its settled evidence and an offset without signed terms are the caller's
  KC002: { code: "INTEGRITY_FAILURE", reason: "COMMISSION_POOL_MISMATCH" },
  KC007: { code: "INTEGRITY_FAILURE", reason: "ELIGIBILITY_WITHOUT_FINAL_COMPLETION" },
  KC015: { code: "INTEGRITY_FAILURE", reason: "ADJUSTMENT_NOT_CUMULATIVE" },
  KC009: { code: "PRECONDITION_FAILED", reason: "PAYEE_UNVERIFIED" },
  KC010: { code: "PRECONDITION_FAILED", reason: "PAYOUT_NOT_SETTLED" },
  KC017: { code: "PRECONDITION_FAILED", reason: "OFFSET_NOT_AUTHORIZED" },
  // an intent born while a payable line of its statement is not PAYABLE or carries a hold the statement does not withhold (0036): CMD052
  // refuses it first (STALE_VERSION LEDGER_CHANGED), so the database refusing it is an integrity failure
  KC018: { code: "INTEGRITY_FAILURE" },
  // a PAYABLE line itemized payable, or taken over, by a statement other than its owner's correcting one (0037): never written by the
  // commands, so the database refusing it is an integrity failure
  KC019: { code: "INTEGRITY_FAILURE" },
  // a payout whose step-up expired between its writes and its COMMIT (0040, D10-GAP-14): the approval's own outcome for a stale proof
  KC020: { code: "ASSURANCE_REQUIRED", reason: "STEP_UP_STALE" },
  // an acceptance whose claim's review deadline passed before its COMMIT (0049): CMD047's own outcome for a lapsed claim
  KC021: { code: "PRECONDITION_FAILED", reason: "CLAIM_EXPIRED" },
  // a commission line the lock call named is absent (0055), and a second B10 lock call that would block: the unit of work retries it (G-ORD-2)
  KC022: { code: "NOT_FOUND", reason: "COMMISSION_LINE_NOT_FOUND" },
  KC027: { code: "CAPACITY_UNAVAILABLE", reason: "LOCK_ORDER_CONTENTION" },
  // CLOSING -> CLOSED while a payment, refund, authorization, tax document or reconciliation case of the agency is open (D10-AGY-4)
  KC006: { code: "PRECONDITION_FAILED", reason: "CLOSURE_RESIDUALS_OPEN" },
  // package B08 (D8-SQL-1): the control plane treats a lost fence as "the attempt or step lost" (DONE); a lost authority refuses the
  // edge; a ledger edited around its jobs and a publication without its evidence are integrity failures; an unfunded dispatch is
  // BUDGET_EXHAUSTED
  KA080: { code: "PRECONDITION_FAILED", reason: "EXECUTION_FENCED" },
  KA081: { code: "PRECONDITION_FAILED", reason: "EXECUTION_AUTHORITY_LOST" },
  KA082: { code: "INTEGRITY_FAILURE", reason: "CAPACITY_LEDGER" },
  KA083: { code: "BUDGET_EXHAUSTED", reason: "NO_FUNDED_GRANT" },
  KA084: { code: "INTEGRITY_FAILURE", reason: "PUBLICATION_EVIDENCE_MISSING" },
  // package B16 L3 (migration 0071): nothing new enters a project whose deletion was requested; a deletion's closing facts need their evidence
  // KA085 (0069): the soft deadline of a retention record moved without its extension row, a bypassing writer only
  KA085: { code: "INTEGRITY_FAILURE" },
  KA087: { code: "PRECONDITION_FAILED", reason: "PROJECT_DELETION_REQUESTED" },
  KA088: { code: "INTEGRITY_FAILURE" },
  // B16 lane L4 (CMD054): a grant whose support case or incident does not justify its project now (another project or agency, closed,
  // resolved, a false positive, an incident not naming the project, a project on its way to deletion, a closed agency)
  KA089: { code: "PRECONDITION_FAILED", reason: "BREAKGLASS_SCOPE_UNAUTHORIZED" },
  // package B16 L6 (0076): a claim refused while a restore holds the recovery gate closed is retried once the gate opens; a restore
  // step the database refuses (out of journal order, a payment conflict, a release without its run) is unreconciled consequences
  KA091: { code: "CAPACITY_UNAVAILABLE", retryable: true },
  KA092: { code: "PRECONDITION_FAILED", reason: "CONSEQUENCES_UNRECONCILED" },
  // B16 L5 (0075): a download grant a request session wrote around CMD038 (package not AVAILABLE, changed membership, lifetime over 900 s,
  // an artifact that is not a live delivery copy). Only a bypassing writer reaches it: an integrity failure like KA088, never a retry
  KA094: { code: "INTEGRITY_FAILURE" },
  // package B12 (migration 0088): a binding, an activity fact or a non-owner suppression a handler that follows the domain never breaks;
  // a lost send fence (an edge, a claim column or a lock the writer did not hold) is the dispatcher's "lost", as KA080
  KA095: { code: "INTEGRITY_FAILURE", reason: "OUTREACH_BINDING" },
  KA096: { code: "PRECONDITION_FAILED", reason: "SEND_FENCED" },
  KA097: { code: "INTEGRITY_FAILURE", reason: "ACTIVITY_EVIDENCE" },
  KA098: { code: "INTEGRITY_FAILURE", reason: "OUTREACH_SUPPRESSION_SCOPE" },
  // the outreach refusals (plan §3): the command's own outcome when a race moved the fact after its read; the uncovered calendar is a
  // platform configuration gap (503, retryable once the calendar is extended)
  KC028: { code: "PRECONDITION_FAILED", reason: "OUTREACH_ROUTE_FORBIDDEN" },
  KC029: { code: "PRECONDITION_FAILED", reason: "SEND_UNCERTAIN_UNRESOLVED" },
  KC030: { code: "PRECONDITION_FAILED", reason: "OUTREACH_GRANT_INVALID" },
  KC031: { code: "PRECONDITION_FAILED", reason: "SENDER_NOT_VERIFIED" },
  KC032: { code: "PRECONDITION_FAILED", reason: "OUTREACH_CAP_REACHED" },
  KC033: { code: "PRECONDITION_FAILED", reason: "RESOURCE_NOT_CURRENT" },
  KC034: { code: "PRECONDITION_FAILED", reason: "OUTREACH_PAUSED" },
  KC035: { code: "PRECONDITION_FAILED", reason: "OUTREACH_REVIEW_INVALID" },
  KC036: { code: "PRECONDITION_FAILED", reason: "OUTREACH_ALREADY_SENT" },
  KC037: { code: "CAPACITY_UNAVAILABLE", reason: "OUTREACH_CALENDAR_UNAVAILABLE" },
  "23503": { code: "INVALID_REQUEST", reason: "UNKNOWN_REFERENCE" },
  "23514": { code: "INVALID_REQUEST" },
  "42501": { code: "NOT_FOUND", reason: "TENANT_CONTEXT_MISSING" },
  "40001": { code: "CAPACITY_UNAVAILABLE", retryable: true },
  "40P01": { code: "CAPACITY_UNAVAILABLE", retryable: true },
  "55P03": { code: "CAPACITY_UNAVAILABLE", retryable: true },
  "57014": { code: "CAPACITY_UNAVAILABLE", retryable: true },
  // the database ended the session itself: transaction_timeout (the limit of a bounded unit, D10-GAP-6a) or an administrator's termination.
  // The unit never committed, so the caller's retry with the same key is safe: the same retriable refusal as a statement timeout
  "25P04": { code: "CAPACITY_UNAVAILABLE", retryable: true },
  "57P01": { code: "CAPACITY_UNAVAILABLE", retryable: true },
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
 * Processing authority's capacity checks (package B08; D8-CAP-1, D8-CAP-2; migration 0021): no slot of the platform's active or
 * waiting bound, or of the agency's live-job bound, is free — CAPACITY_UNAVAILABLE EXECUTION_QUEUE_FULL, retryable once a slot frees.
 * Keyed by the constraint name the error carries, for its SQLSTATE.
 */
export const EXECUTION_CONSTRAINT_FAILURES: Readonly<Record<string, { readonly sqlState: string; readonly code: FailureCode; readonly reason: FailureReason; readonly retryable?: boolean }>> = Object.freeze({
  execution_capacity_active_within_limit: { sqlState: "23514", code: "CAPACITY_UNAVAILABLE", reason: "EXECUTION_QUEUE_FULL", retryable: true },
  execution_capacity_waiting_within_limit: { sqlState: "23514", code: "CAPACITY_UNAVAILABLE", reason: "EXECUTION_QUEUE_FULL", retryable: true },
  agency_execution_capacity_live_within_limit: { sqlState: "23514", code: "CAPACITY_UNAVAILABLE", reason: "EXECUTION_QUEUE_FULL", retryable: true },
});

/**
 * Audit authority's keys and grant checks (package B08, mandate B08-PERSISTENCE-AUDIT; D8-AUD-1, D8-GRANT-1, D8-SQL-1; migration
 * 0023): a grant's reservations past its ceiling or an AUDIT grant above the free-audit policy are BUDGET_EXHAUSTED / GRANT_CEILING, a
 * second audit of one (revision, target) is PRECONDITION_FAILED / AUDIT_EXISTS, and a second live audit of the agency is
 * ADMISSION_LIMITED / AUDIT_CONCURRENCY_LIMITED, retryable once the first ends. Keyed by the constraint (or unique index) name the
 * error carries, for its SQLSTATE.
 */
export const AUDIT_CONSTRAINT_FAILURES: Readonly<Record<string, { readonly sqlState: string; readonly code: FailureCode; readonly reason: FailureReason; readonly retryable?: boolean }>> = Object.freeze({
  cost_grants_within_ceiling: { sqlState: "23514", code: "BUDGET_EXHAUSTED", reason: "GRANT_CEILING" },
  cost_grants_audit_ceiling: { sqlState: "23514", code: "BUDGET_EXHAUSTED", reason: "GRANT_CEILING" },
  audits_one_per_subject: { sqlState: "23505", code: "PRECONDITION_FAILED", reason: "AUDIT_EXISTS" },
  audits_one_live_per_agency: { sqlState: "23505", code: "ADMISSION_LIMITED", reason: "AUDIT_CONCURRENCY_LIMITED", retryable: true },
  // B05 D5-11 (migration 0061): the pool's liability gate and the dispatch-time expiry clauses
  pool_liability_open: { sqlState: "KA083", code: "BUDGET_EXHAUSTED", reason: "NO_FUNDED_GRANT" },
  grant_expired_at_dispatch: { sqlState: "KA083", code: "BUDGET_EXHAUSTED", reason: "NO_FUNDED_GRANT" },
  pool_expired_at_dispatch: { sqlState: "KA083", code: "BUDGET_EXHAUSTED", reason: "NO_FUNDED_GRANT" },
  pool_liability_gate_absent: { sqlState: "KA006", code: "INTEGRITY_FAILURE", reason: "LIFECYCLE_BINDING_MISSING" },
  pool_liability_gate_scope: { sqlState: "KA006", code: "INTEGRITY_FAILURE", reason: "COMMITMENT_ISOLATION" },
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
  // design §12, D10-GAP-25: a second live quote of a project is STALE_VERSION (retryable); CMD027 adds the live quote as current
  quotes_one_live_per_project: () => new LiveQuoteChangedFailure("the project's live quote changed under this request (quotes_one_live_per_project)"),
});

/**
 * B10's sales unique indexes decided by their name (design §12): a second live prospect of a normalized organization key is
 * PROSPECT_EXISTS, a seller's second live claim on a prospect CLAIM_EXISTS, and a second frozen allocation of an agency
 * ATTRIBUTION_EXISTS ("the pool does not become 10% for each seller").
 */
export const COMMERCIAL_UNIQUE_FAILURES: Readonly<Record<string, () => DomainFailure>> = Object.freeze({
  prospects_one_live_per_organization: () => new DomainFailure("PRECONDITION_FAILED", "the organization already has a live prospect", { reason: "PROSPECT_EXISTS" }),
  attribution_claims_one_live_per_seller: () => new DomainFailure("PRECONDITION_FAILED", "the seller already has a live claim on the prospect", { reason: "CLAIM_EXISTS" }),
  attribution_allocations_one_per_agency: () => new DomainFailure("PRECONDITION_FAILED", "the agency already has a frozen attribution allocation", { reason: "ATTRIBUTION_EXISTS" }),
  // CMD054 (migration 0074): two opens of one project race on its one live grant; a step-up proof opens one grant; one authorization opens
  // one grant of a project — after its expiry a new justified grant is required (R2-050)
  breakglass_grants_one_live_per_project: () => new DomainFailure("PRECONDITION_FAILED", "the project already holds a live breakglass grant", { reason: "BREAKGLASS_GRANT_LIVE" }),
  breakglass_grants_proof_once: () => new DomainFailure("PRECONDITION_FAILED", "the step-up proof already opened a breakglass grant", { reason: "BREAKGLASS_PROOF_REUSED" }),
  breakglass_grants_one_per_authorization: () => new DomainFailure("PRECONDITION_FAILED", "this authorization already opened a grant of the project: a new justified grant is required", { reason: "BREAKGLASS_RENEWAL_REFUSED" }),
  // CMD048: two first assignments of one agency race to open its sales account; the loser finds it opened at version 1 (D10-ASSIGN-3)
  sales_accounts_pkey: () => new StaleVersionFailure(1, "ASSIGNED"),
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
 * B10's named checks of the recurrence and founding cohort (migration 0028), decided by their name: a reservation held for
 * reconciliation only after its end with its quote still in checkout is the edge's guard, which a sweep racing a checkout can meet
 * (PRECONDITION_FAILED, as B09's KA008 answers a quote that cannot leave checkout); the reservation's and the issuance's bindings are
 * written by the issuance core alone, so only a writer bypassing it meets them (INTEGRITY_FAILURE).
 */
const COMMERCIAL_CONSTRAINT_FAILURES: Readonly<Record<string, { readonly sqlState: string; readonly code: FailureCode; readonly reason?: FailureReason }>> = Object.freeze({
  founding_slot_reservations_hold_guard: { sqlState: "23514", code: "PRECONDITION_FAILED", reason: "UNLISTED_TRANSITION" },
  founding_slot_reservations_snapshot_binding: { sqlState: "23514", code: "INTEGRITY_FAILURE" },
  quote_issuances_binding: { sqlState: "23514", code: "INTEGRITY_FAILURE" },
  founding_slots_live_reservation_fk: { sqlState: "23503", code: "INTEGRITY_FAILURE" },
});

/**
 * Translates a database error code into a DomainFailure, or null when the adapter must decide by context (a unique violation
 * is IDEMPOTENCY replay, LAST-approval race or DRAFT_AGENCY_EXISTS depending on the constraint name it carries).
 */
export function failureOfSqlState(sqlState: string | undefined, constraint?: string): DomainFailure | null {
  if (!sqlState) return null;
  const source = constraint === undefined ? undefined : (SOURCE_CONSTRAINT_FAILURES[constraint] ?? EXECUTION_CONSTRAINT_FAILURES[constraint] ?? AUDIT_CONSTRAINT_FAILURES[constraint]);
  if (source !== undefined && source.sqlState === sqlState) {
    return new DomainFailure(source.code, `database refused the write (${sqlState} ${constraint ?? ""})`, { reason: source.reason }, source.retryable ?? false);
  }
  const commercial = constraint === undefined ? undefined : COMMERCIAL_CONSTRAINT_FAILURES[constraint];
  if (commercial !== undefined && commercial.sqlState === sqlState) {
    return new DomainFailure(commercial.code, `database refused the write (${sqlState} ${constraint ?? ""})`, commercial.reason === undefined ? {} : { reason: commercial.reason });
  }
  if (constraint !== undefined && COMMERCE_INTEGRITY_CONSTRAINTS.has(constraint) && (sqlState === SQLSTATE.CHECK_VIOLATION || sqlState === SQLSTATE.FOREIGN_KEY_VIOLATION || sqlState === SQLSTATE.UNIQUE_VIOLATION)) {
    return new DomainFailure("INTEGRITY_FAILURE", `database refused the write (${sqlState} ${constraint})`);
  }
  if (sqlState === SQLSTATE.UNIQUE_VIOLATION) {
    if (constraint === "agencies_one_draft_per_creator") return new DomainFailure("ADMISSION_LIMITED", "one draft agency per identity", { reason: "DRAFT_AGENCY_EXISTS" });
    const commerce = constraint === undefined ? undefined : COMMERCE_UNIQUE_FAILURES[constraint];
    if (commerce !== undefined) return commerce();
    const commercial = constraint === undefined ? undefined : COMMERCIAL_UNIQUE_FAILURES[constraint];
    if (commercial !== undefined) return commercial();
    // command_journal_identity (concurrent duplicate), approvals_one_live_per_plan (lost approval race) and
    // plans_supersedes_once (lost revision race) are decided by the handler, which re-reads the current row and answers
    // with the replayed result or STALE_VERSION carrying the current safe version; so are the commerce replay constraints
    // (COMMERCE_REPLAY_CONSTRAINTS).
    return null;
  }
  if (sqlState === SQLSTATE.CHECK_VIOLATION && constraint !== undefined && LABEL_CONSTRAINT_FIELDS[constraint] !== undefined) {
    return new DomainFailure("INVALID_REQUEST", `database refused the write (${sqlState} ${constraint})`, { reason: "SCHEMA_VIOLATION", fields: [{ field: LABEL_CONSTRAINT_FIELDS[constraint] as string, code: "FORMAT" }] });
  }
  // B10: an acceptance of a version retired between the read and the write (the guard of 0028 reads it after its transition lock)
  if (sqlState === SQLSTATE.CHECK_VIOLATION && constraint === "agency_agreement_acceptances_published") {
    return new DomainFailure("PRECONDITION_FAILED", "database refused the write (23514 agency_agreement_acceptances_published)", { reason: "AGREEMENT_VERSION_NOT_PUBLISHED" });
  }
  const m = MAP[sqlState];
  if (!m) return null;
  return new DomainFailure(m.code, `database refused the write (${sqlState})`, m.reason ? { reason: m.reason } : {}, m.retryable ?? false);
}
