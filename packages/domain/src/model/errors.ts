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
  // membership, invitation and ownership (07 "Agency and membership states"; 08 "Invitation, recovery and ownership transfer")
  "INVITATION_EXPIRED",
  "INVITATION_NOT_EXPIRED",
  "INVITATION_CONSUMED",
  "INVITATION_REVOKED",
  "INVITATION_TOKEN_MISMATCH",
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
  "CORRELATION_ID_INVALID",
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
