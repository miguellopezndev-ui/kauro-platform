/**
 * Failure taxonomy (07 "Command outcomes and error taxonomy"; 10 "Responses and safe errors").
 *
 * The stable codes of manual 10 are the wire codes. Three platform codes are added where the list of the authority has no
 * member for a distinct class the seven B06 commands need (decisions D-ERR-1..3 in docs/design/B06-domain-db-authz.md):
 * PRECONDITION_FAILED (an aggregate is not in a state the listed transition allows), ADMISSION_LIMITED (an abuse or
 * capacity admission limit refused the request) and INTERNAL_ERROR (an unexpected exception, reported only by correlation id).
 * A reason code narrows a code without becoming control-flow prose: frontends branch on `code` and `reason`, never on `title`.
 *
 * The typed error contract of a failure is (code, reason, safe title, HTTP status, retryability, safe details). 10 "Responses
 * and safe errors": problems "exclude stack traces, SQL, bucket names, session URIs, raw cell values, internal secrets and
 * foreign-resource existence" — a DomainFailure message therefore never interpolates a customer value (labels, purposes,
 * tokens); it names ids, states, versions and field names only. 07: "HTTP status follows the API contract; business state is
 * not inferred solely from status code" — the status is a projection of the code, never the other way round.
 */
import { COMMERCE_FAILURE_REASONS } from "../commerce/failure-reasons.js";
import { COMMERCIAL_FAILURE_REASONS } from "../commercial/failure-reasons.js";
import { EXECUTION_FAILURE_REASONS } from "./execution/failure-reasons.js";
import { AUDIT_FAILURE_REASONS } from "./audit/failure-reasons.js";

export const FAILURE_CODES = [
  "INVALID_REQUEST",
  "AUTHENTICATION_REQUIRED",
  "ASSURANCE_REQUIRED",
  "NOT_AUTHORIZED",
  "NOT_FOUND",
  "STALE_VERSION",
  "IDEMPOTENCY_CONFLICT",
  "CAPABILITY_UNAVAILABLE",
  "SOURCE_EXPIRED",
  "TARGET_STALE",
  "PLAN_NOT_VALIDATED",
  "PAYMENT_PENDING",
  "PAYMENT_UNCERTAIN",
  "BUDGET_EXHAUSTED",
  "CAPACITY_UNAVAILABLE",
  "INTEGRITY_FAILURE",
  "OPERATION_CANCELLED",
  "PRECONDITION_FAILED",
  "ADMISSION_LIMITED",
  "CONTENT_REFUSED",
  "INTERNAL_ERROR",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** Codes named by manual 10 "Responses and safe errors" (the platform additions are the rest of FAILURE_CODES). */
export const AUTHORITY_FAILURE_CODES: ReadonlySet<FailureCode> = new Set<FailureCode>([
  "INVALID_REQUEST", "AUTHENTICATION_REQUIRED", "ASSURANCE_REQUIRED", "NOT_AUTHORIZED", "NOT_FOUND", "STALE_VERSION",
  "IDEMPOTENCY_CONFLICT", "CAPABILITY_UNAVAILABLE", "SOURCE_EXPIRED", "TARGET_STALE", "PLAN_NOT_VALIDATED", "PAYMENT_PENDING",
  "PAYMENT_UNCERTAIN", "BUDGET_EXHAUSTED", "CAPACITY_UNAVAILABLE", "INTEGRITY_FAILURE", "OPERATION_CANCELLED",
]);

/**
 * HTTP status of each code (10 "Responses and safe errors"; 07 "Command outcomes": CONFLICT carries the current safe version,
 * REJECTED a stable reason, UNAVAILABLE a retry policy). The API package projects a failure through this table; the table
 * lives in the domain because the code is the business classification and the status is derived from it.
 */
export const FAILURE_HTTP_STATUS: Readonly<Record<FailureCode, number>> = Object.freeze({
  INVALID_REQUEST: 400,
  AUTHENTICATION_REQUIRED: 401,
  ASSURANCE_REQUIRED: 403,
  NOT_AUTHORIZED: 403,
  NOT_FOUND: 404,
  STALE_VERSION: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PRECONDITION_FAILED: 409,
  PAYMENT_PENDING: 409,
  PAYMENT_UNCERTAIN: 409,
  OPERATION_CANCELLED: 409,
  CAPABILITY_UNAVAILABLE: 422,
  SOURCE_EXPIRED: 422,
  TARGET_STALE: 422,
  PLAN_NOT_VALIDATED: 422,
  INTEGRITY_FAILURE: 422,
  BUDGET_EXHAUSTED: 429,
  ADMISSION_LIMITED: 429,
  CONTENT_REFUSED: 422,
  CAPACITY_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
});

/** Safe display title per code: fixed prose that never carries a value of the request or of another tenant. */
export const FAILURE_TITLES: Readonly<Record<FailureCode, string>> = Object.freeze({
  INVALID_REQUEST: "The request is structurally invalid",
  AUTHENTICATION_REQUIRED: "Authentication is required",
  ASSURANCE_REQUIRED: "A recent step-up authentication is required",
  NOT_AUTHORIZED: "The caller is not authorized for this operation",
  NOT_FOUND: "The resource was not found",
  STALE_VERSION: "The resource changed since it was read",
  IDEMPOTENCY_CONFLICT: "The idempotency key was reused with a different request",
  PRECONDITION_FAILED: "The resource is not in a state that permits this operation",
  PAYMENT_PENDING: "A payment is still pending",
  PAYMENT_UNCERTAIN: "A payment outcome is uncertain and must be reconciled",
  OPERATION_CANCELLED: "The operation was cancelled",
  CAPABILITY_UNAVAILABLE: "The requested capability is not available",
  SOURCE_EXPIRED: "The source revision is no longer available",
  TARGET_STALE: "The target contract is no longer current",
  PLAN_NOT_VALIDATED: "The plan has no current valid validation",
  INTEGRITY_FAILURE: "An integrity check failed",
  ADMISSION_LIMITED: "The request was not admitted by the abuse or capacity limits",
  CONTENT_REFUSED: "The submitted text looks like a secret or customer records and was not accepted",
  BUDGET_EXHAUSTED: "The operating budget for this operation is exhausted",
  CAPACITY_UNAVAILABLE: "Capacity is temporarily unavailable",
  INTERNAL_ERROR: "An unexpected error was recorded under the correlation id",
});

/**
 * Codes a client may retry with the same idempotency key once the named condition clears (10 "Idempotency contract": a
 * server error before intent persistence can be retried according to the returned policy; the client never mints a new key
 * because it got no answer). Every other code is final for that request.
 */
export const RETRYABLE_FAILURE_CODES: ReadonlySet<FailureCode> = new Set<FailureCode>(["CAPACITY_UNAVAILABLE", "PAYMENT_PENDING", "INTERNAL_ERROR"]);

/**
 * Safe reason codes: machine tokens that narrow a failure code. They never carry customer values. The list is closed so a
 * frontend and the acceptance harness can enumerate the outcomes a command can produce.
 */
export const FAILURE_REASONS = [
  // authorization (08 "Identity is not permission")
  "SUBJECT_UNAUTHENTICATED",
  "IDENTITY_UNVERIFIED",
  "IDENTITY_DISABLED",
  "NOT_A_MEMBER",
  "MEMBERSHIP_SUSPENDED",
  "MEMBERSHIP_NOT_ACTIVE",
  "ROLE_INSUFFICIENT",
  "NOT_APPROVAL_CONTROLLER",
  "STEP_UP_MISSING",
  "STEP_UP_STALE",
  "STEP_UP_NOT_OWNED",
  "TENANT_CONTEXT_MISSING",
  // the browser session boundary (B11 design D-AUTH-4, D-AUTH-5): every defect of an identity token is one reason (no account
  // enumeration); a proven account whose e-mail is unverified; a request carrying a session cookie and another credential (or
  // two session cookies); an unsafe cookie-authenticated request from outside the exact application origin, or without the
  // session's CSRF token
  "IDENTITY_TOKEN_INVALID",
  "EMAIL_NOT_VERIFIED",
  "AMBIGUOUS_CREDENTIALS",
  "ORIGIN_REJECTED",
  "CSRF_TOKEN_INVALID",
  // aggregate state (07 state machines, reference/TRANSITIONS_AND_EVENT_EFFECTS.md)
  "UNLISTED_TRANSITION",
  "AGENCY_NOT_OPEN",
  "AGENCY_NOT_ACTIVE",
  "AGREEMENTS_INCOMPLETE",
  "CLIENT_ARCHIVED",
  "PLAN_NOT_APPROVED",
  "PLAN_SUPERSEDED",
  "PLAN_WITHDRAWN",
  "NO_SEMANTIC_CHANGE",
  // Plan edge APPROVED -new_plan_revision-> SUPERSEDED, guard "Commercial/execution consequences are reconciled"
  "CONSEQUENCES_UNRECONCILED",
  // membership, invitation and ownership (07 "Agency and membership states"; 08 "Invitation, recovery and ownership transfer")
  "INVITATION_EXPIRED",
  "INVITATION_NOT_EXPIRED",
  "INVITATION_CONSUMED",
  "INVITATION_REVOKED",
  "INVITATION_TOKEN_MISMATCH",
  // the database's half of the invitation rules (migration 0002 KA011): an invitation consumed, revoked or past its deadline,
  // or an acceptance without a consumed invitation of that role
  "INVITATION_NOT_OPEN",
  "MEMBER_ALREADY_LIVE",
  "ROLE_NOT_GRANTABLE",
  "OWNER_PROTECTED",
  "SELF_TARGET",
  "RECIPIENT_NOT_ACTIVE",
  "RECIPIENT_UNVERIFIED",
  "RECIPIENT_ACCEPTANCE_MISSING",
  "CROSS_AGENCY",
  // structural / bindings
  "UNKNOWN_REFERENCE",
  "HASH_MISMATCH",
  "RECEIPT_NOT_CURRENT",
  "RECEIPT_BLOCKING",
  "DISCLOSURES_INCOMPLETE",
  "MODE_NOT_OFFERED",
  "CAPABILITY_MODE_MISMATCH",
  "TARGET_INSTANCE_REQUIRED",
  // typed plan patch compilation (CMD023 precondition: "The typed patch names existing candidates/fields and permitted effects")
  "PATCH_UNKNOWN_CANDIDATE",
  "PATCH_UNKNOWN_FIELD",
  "PATCH_EFFECT_NOT_PERMITTED",
  "PATCH_MALFORMED",
  // request admission at the HTTP boundary (10 "Request envelope": content type, size, syntax, duplicate keys, schema, headers)
  "CONTENT_TYPE_UNSUPPORTED",
  "BODY_TOO_LARGE",
  "JSON_SYNTAX",
  "JSON_DUPLICATE_KEY",
  "JSON_DEPTH_EXCEEDED",
  "JSON_STRING_TOO_LONG",
  "SCHEMA_VIOLATION",
  "IDEMPOTENCY_KEY_MISSING",
  "IDEMPOTENCY_KEY_INVALID",
  "AGENCY_SELECTOR_INVALID",
  "PATH_ID_INVALID",
  // HTTP framing at the boundary (review findings R39, R40, R41): a single-valued envelope header sent more than once, a
  // request the HTTP layer cannot read (undecodable target, parser error, body length not the declared one), a request
  // that did not arrive completely within the request timeout
  "HEADER_REPEATED",
  "REQUEST_MALFORMED",
  "REQUEST_TIMEOUT",
  // admission (08 "Abuse controls")
  "DRAFT_AGENCY_EXISTS",
  "CREATION_RATE_LIMITED",
  // idempotency (10 "Idempotency contract")
  "REQUEST_DIGEST_DIFFERS",
  "OPERATION_PENDING",
  // ownership invariant (07 "Agency and membership states")
  "LAST_OWNER_PROTECTED",
  // integrity (database discipline, persistence migrations, deployment completeness)
  "PLAN_SERVICES_UNAVAILABLE",
  // a reply its route's response contract refuses is never sent (10 "Responses and safe errors": a validated DTO)
  "RESPONSE_CONTRACT_VIOLATION",
  "EVENT_MISSING",
  // a plan body whose KAURO_PLAN_BODY_V1 digest is not the hash recorded or claimed for it (re-check finding N10)
  "BODY_DIGEST_MISMATCH",
  "VERSION_DISCIPLINE",
  "IMMUTABLE_COLUMN",
  "LIVE_APPROVAL_UNBOUND",
  "LEASE_FENCED",
  "RESUME_WITHOUT_CHECKPOINT",
  "DEADLINE_IMMUTABLE",
  // dispatch materialization (S089: reject runnable materialization until actual dependencies are resolved)
  "UPSTREAM_UNRESOLVED",
  // provider ingress (15 "Webhooks and reconciliation"; migration 0005 KA012): a recorded event with a conflicting delivery
  // cannot be applied before it is reconciled
  "INBOX_BODY_CONFLICT",
  // a list read's cursor that is not one this server issued for this caller, scope, filter and order (10 "Cursors are opaque,
  // integrity-protected and bound to actor scope, filter, sort and snapshot policy"; R2-060; re-check finding N16)
  "CURSOR_INVALID",
  // source lifecycle (B07, docs/design/B07-upload-source-lifecycle.md §8): revision and project state
  "PROJECT_NOT_OPEN",
  "PREDECESSOR_NOT_CURRENT",
  "REVISION_NOT_ACCEPTING_UPLOADS",
  "REVISION_NOT_SELECTABLE",
  "REVISION_NOT_READY_TO_SEAL",
  "REVISION_SEALED",
  "REVISION_NOT_MUTABLE",
  "UPLOADS_UNRESOLVED",
  "INSPECTION_PENDING",
  "EVALUATION_PENDING",
  "INPUT_NOT_ADMITTED",
  // source lifecycle: the intake envelope and admission (09 "Initial intake envelope", "Upload reservation")
  "EMPTY_DECLARATION",
  "FILE_TOO_LARGE",
  "REVISION_QUOTA_EXCEEDED",
  "REVISION_FILE_LIMIT",
  "UPLOAD_CONCURRENCY_LIMITED",
  // source lifecycle: upload sessions (09 "Resumable session security", "Completion and inspection")
  "UPLOAD_NOT_OWNED",
  "SESSION_NOT_ISSUED",
  "SESSION_ISSUE_FAILED",
  "UPLOAD_VERIFYING",
  "UPLOAD_TERMINAL",
  "UPLOAD_ADMITTED",
  "UPLOAD_CANCELLED",
  "RESERVATION_EXPIRED",
  "COMPLETION_REF_MALFORMED",
  "COMPLETION_CLAIM_CONFLICT",
  // source lifecycle: selection and seal (09 "Accepted immutability and sealing"; CMD016, CMD017)
  "SELECTION_MANIFEST_MISMATCH",
  "SELECTION_STALE",
  "SELECTION_INCOMPLETE",
  "SELECTION_UNKNOWN_TABLE",
  "SELECTION_FILE_NOT_ADMITTED",
  "HIDDEN_SHEET_NOT_ACKNOWLEDGED",
  "FORMULA_POLICY_REQUIRED",
  "EXCLUSION_REASON_REQUIRED",
  "PARSER_CHOICE_INVALID",
  "PROJECTION_INVALID",
  "PROJECTION_KEY_NOT_CONFIRMED",
  "SELECTED_COLUMNS_LIMIT",
  "SELECTION_BYTES_LIMIT",
  "REUSE_NOT_AVAILABLE",
  "GENERATION_CHANGED",
  "GENERATION_NOT_OBSERVED",
  // source lifecycle: integrity (migrations 0009..0012) and deployment completeness
  "QUOTA_LEDGER",
  "FENCE_DISCIPLINE",
  "LIFECYCLE_BINDING_MISSING",
  "SOURCE_SERVICES_UNAVAILABLE",
  // support cases (B11 CMD044; placed before B09's list by the trunk sync so that B09, B08 and B10 keep their order, D11-SYNC-1, D-SUP-2, D-SUP-4): the bounded detector refused the summary, and the covered-hours calendar does not
  // reach the request date (fail closed rather than guess a review date)
  "SECRET_LIKE_CONTENT",
  "RECORD_LIKE_CONTENT",
  "SUPPORT_CALENDAR_UNAVAILABLE",
  // the public inquiry (B11 W5b, D-PUB-3): refused by the per-address or per-e-mail limiter; its origin rule reuses ORIGIN_REJECTED
  // (W2) and its detector the support reasons above
  "INQUIRY_RATE_LIMITED",
  // payments and fiscal workflow (package B09; docs/design/B09-payments-fiscal.md §7.2)
  ...COMMERCE_FAILURE_REASONS,
  // processing authority (package B08; docs/design/B08-audit-approval-jobs.md §9, D8-SQL-1)
  ...EXECUTION_FAILURE_REASONS,
  // audit authority (package B08, mandate B08-PERSISTENCE-AUDIT; the audit keys of migration 0023)
  ...AUDIT_FAILURE_REASONS,
  // agency recurrence and commissions (package B10; docs/design/B10-commercial-domain.md §12)
  ...COMMERCIAL_FAILURE_REASONS,
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

/**
 * The field code of a typed-patch rejection (CMD023): the reference resolved, the patch it names was refused by the compiler,
 * and the field says why with the same token as the problem reason (10 "frontend control flow uses the code and typed
 * fields" — a field never contradicts the reason).
 */
export type TypedPatchFieldCode = "PATCH_UNKNOWN_CANDIDATE" | "PATCH_UNKNOWN_FIELD" | "PATCH_EFFECT_NOT_PERMITTED" | "PATCH_MALFORMED";

export interface FieldError {
  /** Field name of the request body (no customer value is ever echoed). */
  readonly field: string;
  readonly code: "REQUIRED" | "UNKNOWN_FIELD" | "TYPE" | "FORMAT" | "RANGE" | "UNKNOWN_REFERENCE" | "ENUM" | TypedPatchFieldCode;
}

export interface FailureDetails {
  readonly reason?: FailureReason;
  readonly fields?: ReadonlyArray<FieldError>;
  /** Present on STALE_VERSION: the current safe version and state the UI must reload or compare against (10). */
  readonly currentVersion?: number;
  readonly currentState?: string;
  /** Present on STALE_VERSION raised by a hash binding mismatch: which named hashes did not match the current subject. */
  readonly mismatch?: ReadonlyArray<string>;
  /** Present when the subject was superseded: where the current content lives. */
  readonly successorId?: string;
  readonly retryAfterSeconds?: number;
}

/** A failure the domain or application raises; adapters and the API translate it, never the reverse. */
export class DomainFailure extends Error {
  readonly code: FailureCode;
  readonly retryable: boolean;
  readonly details: FailureDetails;
  constructor(code: FailureCode, message: string, details: FailureDetails = {}, retryable = RETRYABLE_FAILURE_CODES.has(code)) {
    super(message);
    this.name = "DomainFailure";
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
  /** HTTP status the API contract assigns to the code (10). */
  get status(): number {
    return FAILURE_HTTP_STATUS[this.code];
  }
  /** Fixed safe title of the code (10): never the message, which is for server logs. */
  get title(): string {
    return FAILURE_TITLES[this.code];
  }
  get reason(): FailureReason | undefined {
    return this.details.reason;
  }
}

export class StaleVersionFailure extends DomainFailure {
  constructor(currentVersion: number, currentState: string, extra: Omit<FailureDetails, "currentVersion" | "currentState"> = {}) {
    super("STALE_VERSION", `stale version: current is ${currentVersion} (${currentState})`, { ...extra, currentVersion, currentState });
    this.name = "StaleVersionFailure";
  }
}

export class IdempotencyConflictFailure extends DomainFailure {
  constructor() {
    super("IDEMPOTENCY_CONFLICT", "idempotency key reused with a different request digest", { reason: "REQUEST_DIGEST_DIFFERS" });
    this.name = "IdempotencyConflictFailure";
  }
}

/** An aggregate is not in a state the operation requires (07: a listed edge still requires its guard). */
export class PreconditionFailure extends DomainFailure {
  constructor(reason: FailureReason, message: string, extra: Omit<FailureDetails, "reason"> = {}) {
    super("PRECONDITION_FAILED", message, { ...extra, reason });
    this.name = "PreconditionFailure";
  }
}

/** Structural refusal of a body member; the field name is safe, the value is never echoed (10). */
export class InvalidRequestFailure extends DomainFailure {
  constructor(fields: ReadonlyArray<FieldError>, reason?: FailureReason) {
    super("INVALID_REQUEST", `invalid request: ${fields.map((f) => `${f.field}:${f.code}`).join(", ")}`, reason ? { fields, reason } : { fields });
    this.name = "InvalidRequestFailure";
  }
}

/** The caller is authenticated but the stored authority does not permit the operation (08 default deny). */
export class NotAuthorizedFailure extends DomainFailure {
  constructor(reason: FailureReason, message: string) {
    super("NOT_AUTHORIZED", message, { reason });
    this.name = "NotAuthorizedFailure";
  }
}

/** A resource that is foreign, nonexistent or invisible under the bound context (08: equivalent safe visibility). */
export class NotFoundFailure extends DomainFailure {
  constructor(resourceKind: string, reason?: FailureReason) {
    super("NOT_FOUND", `${resourceKind} not found in this scope`, reason ? { reason } : {});
    this.name = "NotFoundFailure";
  }
}

export function isDomainFailure(e: unknown): e is DomainFailure {
  return e instanceof DomainFailure;
}

/** The wire-safe projection of a failure: what a Problem response may carry (10), nothing else. */
export interface FailureContract {
  readonly code: FailureCode;
  readonly status: number;
  readonly title: string;
  readonly retryable: boolean;
  readonly reason?: FailureReason;
  readonly fields?: ReadonlyArray<FieldError>;
  readonly current?: { readonly version: number; readonly state: string; readonly successorId?: string; readonly mismatch?: ReadonlyArray<string> };
  readonly retryAfterSeconds?: number;
}

export function describeFailure(failure: DomainFailure): FailureContract {
  const d = failure.details;
  const out: {
    code: FailureCode;
    status: number;
    title: string;
    retryable: boolean;
    reason?: FailureReason;
    fields?: ReadonlyArray<FieldError>;
    current?: { version: number; state: string; successorId?: string; mismatch?: ReadonlyArray<string> };
    retryAfterSeconds?: number;
  } = { code: failure.code, status: failure.status, title: failure.title, retryable: failure.retryable };
  if (d.reason !== undefined) out.reason = d.reason;
  if (d.fields !== undefined) out.fields = d.fields;
  if (d.retryAfterSeconds !== undefined) out.retryAfterSeconds = d.retryAfterSeconds;
  if (d.currentVersion !== undefined && d.currentState !== undefined) {
    const current: { version: number; state: string; successorId?: string; mismatch?: ReadonlyArray<string> } = { version: d.currentVersion, state: d.currentState };
    if (d.successorId !== undefined) current.successorId = d.successorId;
    if (d.mismatch !== undefined) current.mismatch = d.mismatch;
    out.current = current;
  }
  return out;
}
