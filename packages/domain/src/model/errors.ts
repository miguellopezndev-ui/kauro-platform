/**
 * Failure taxonomy (07 "Command outcomes and error taxonomy"; 10 "Responses and safe errors").
 *
 * The stable codes of manual 10 are the wire codes. Three platform codes are added where the list of the authority has no
 * member for a distinct class the seven B06 commands need (decisions D-ERR-1..3 in docs/design/B06-domain-db-authz.md):
 * PRECONDITION_FAILED (an aggregate is not in a state the listed transition allows), ADMISSION_LIMITED (an abuse or
 * capacity admission limit refused the request) and INTERNAL_ERROR (an unexpected exception, reported only by correlation id).
 * A reason code narrows a code without becoming control-flow prose: frontends branch on `code` and `reason`, never on `title`.
 */
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
  // aggregate state (07 state machines, reference/TRANSITIONS_AND_EVENT_EFFECTS.md)
  "UNLISTED_TRANSITION",
  "AGENCY_NOT_OPEN",
  "CLIENT_ARCHIVED",
  "PLAN_NOT_APPROVED",
  "PLAN_SUPERSEDED",
  "PLAN_WITHDRAWN",
  "NO_SEMANTIC_CHANGE",
  // structural / bindings
  "UNKNOWN_REFERENCE",
  "HASH_MISMATCH",
  "RECEIPT_NOT_CURRENT",
  "RECEIPT_BLOCKING",
  "DISCLOSURES_INCOMPLETE",
  "MODE_NOT_OFFERED",
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
  "CORRELATION_ID_INVALID",
  // admission (08 "Abuse controls")
  "DRAFT_AGENCY_EXISTS",
  "CREATION_RATE_LIMITED",
  // idempotency (10 "Idempotency contract")
  "REQUEST_DIGEST_DIFFERS",
  "OPERATION_PENDING",
  // ownership invariant (07 "Agency and membership states")
  "LAST_OWNER_PROTECTED",
  // integrity (database discipline, persistence migrations)
  "EVENT_MISSING",
  "VERSION_DISCIPLINE",
  "IMMUTABLE_COLUMN",
  "LEASE_FENCED",
  "RESUME_WITHOUT_CHECKPOINT",
  "DEADLINE_IMMUTABLE",
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export interface FieldError {
  /** Field name of the request body (no customer value is ever echoed). */
  readonly field: string;
  readonly code: "REQUIRED" | "UNKNOWN_FIELD" | "TYPE" | "FORMAT" | "RANGE" | "UNKNOWN_REFERENCE" | "ENUM";
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
  constructor(code: FailureCode, message: string, details: FailureDetails = {}, retryable = false) {
    super(message);
    this.name = "DomainFailure";
    this.code = code;
    this.details = details;
    this.retryable = retryable;
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

export function isDomainFailure(e: unknown): e is DomainFailure {
  return e instanceof DomainFailure;
}
