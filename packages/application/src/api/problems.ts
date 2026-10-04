/**
 * Safe problem contract (10 "Responses and safe errors": type, title, status, code, correlationId, safe field errors,
 * retryability and permitted next-action references; never a stack trace, SQL, bucket name, session URI, raw cell value,
 * secret or foreign-resource existence). HTTP status follows this table (07: business state is never inferred from status
 * alone); frontends branch on `code`/`reason`, never on `title` prose.
 */
import type { FailureCode, FailureReason, FieldError } from "@kauro/domain";
import { DomainFailure, FAILURE_CODES } from "@kauro/domain";

export const PROBLEM_TYPE_PREFIX = "urn:kauro:problem:";

export interface NextAction {
  /** A stable action token the UI maps to its own control flow (e.g. RELOAD, COMPARE_VERSIONS, REAUTHENTICATE, RETRY_LATER). */
  readonly action: "RELOAD" | "COMPARE_VERSIONS" | "REAUTHENTICATE" | "STEP_UP" | "RETRY_LATER" | "RETRY_SAME_KEY" | "REQUEST_NEW_REVIEW" | "CONTACT_SUPPORT" | "CHOOSE_ANOTHER_MODE" | "SECURE_UPLOAD";
  /** Relative application path when the action has a destination; never an absolute or attacker-controllable URL. */
  readonly href?: string;
}

export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: FailureCode;
  readonly reason?: FailureReason;
  readonly correlationId: string;
  readonly errors?: ReadonlyArray<FieldError>;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly nextActions: ReadonlyArray<NextAction>;
  /** STALE_VERSION only: the current safe version/state the UI must reload or compare against. */
  readonly current?: { readonly version: number; readonly state: string; readonly successorId?: string; readonly mismatch?: ReadonlyArray<string> };
}

export const PROBLEM_STATUS: Readonly<Record<FailureCode, number>> = Object.freeze({
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

export const PROBLEM_TITLE: Readonly<Record<FailureCode, string>> = Object.freeze({
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
  BUDGET_EXHAUSTED: "The operating budget for this operation is exhausted",
  ADMISSION_LIMITED: "The request was not admitted by the abuse or capacity limits",
  CONTENT_REFUSED: "The submitted text looks like a secret or customer records and was not accepted",
  CAPACITY_UNAVAILABLE: "Capacity is temporarily unavailable",
  INTERNAL_ERROR: "An unexpected error was recorded under the correlation id",
});

/** Codes a client may retry with the same idempotency key once the named condition clears. */
export const RETRYABLE_CODES: ReadonlySet<FailureCode> = new Set<FailureCode>(["CAPACITY_UNAVAILABLE", "PAYMENT_PENDING", "INTERNAL_ERROR"]);

const NEXT_ACTIONS: Readonly<Record<FailureCode, ReadonlyArray<NextAction>>> = Object.freeze({
  INVALID_REQUEST: [],
  AUTHENTICATION_REQUIRED: [{ action: "REAUTHENTICATE" }],
  ASSURANCE_REQUIRED: [{ action: "STEP_UP" }],
  NOT_AUTHORIZED: [],
  NOT_FOUND: [],
  STALE_VERSION: [{ action: "RELOAD" }, { action: "COMPARE_VERSIONS" }],
  IDEMPOTENCY_CONFLICT: [],
  PRECONDITION_FAILED: [{ action: "RELOAD" }],
  PAYMENT_PENDING: [{ action: "RETRY_LATER" }],
  PAYMENT_UNCERTAIN: [{ action: "CONTACT_SUPPORT" }],
  OPERATION_CANCELLED: [{ action: "RELOAD" }],
  CAPABILITY_UNAVAILABLE: [{ action: "CHOOSE_ANOTHER_MODE" }],
  SOURCE_EXPIRED: [{ action: "REQUEST_NEW_REVIEW" }],
  TARGET_STALE: [{ action: "REQUEST_NEW_REVIEW" }],
  PLAN_NOT_VALIDATED: [{ action: "REQUEST_NEW_REVIEW" }],
  INTEGRITY_FAILURE: [{ action: "CONTACT_SUPPORT" }],
  BUDGET_EXHAUSTED: [{ action: "CONTACT_SUPPORT" }],
  ADMISSION_LIMITED: [{ action: "RETRY_LATER" }],
  CONTENT_REFUSED: [{ action: "SECURE_UPLOAD" }],
  CAPACITY_UNAVAILABLE: [{ action: "RETRY_SAME_KEY" }],
  INTERNAL_ERROR: [{ action: "RETRY_SAME_KEY" }],
});

/**
 * Reasons whose next step is not the code's: a job that already ended or was delivered is final, so reloading it or retrying changes nothing
 * and the answer offers no action (CancelJob, D8-CMD-2). Every other reason keeps the code's actions.
 */
const REASON_NEXT_ACTIONS: Readonly<Record<string, ReadonlyArray<NextAction>>> = Object.freeze({
  JOB_TERMINAL: [],
  AUDIT_TERMINAL: [],
  JOB_ALREADY_READY: [],
});

function nextActionsOf(failure: DomainFailure): ReadonlyArray<NextAction> {
  const reason = failure.details.reason;
  return (reason === undefined ? undefined : REASON_NEXT_ACTIONS[reason]) ?? NEXT_ACTIONS[failure.code];
}

/** Builds the wire problem for a domain failure; the message of the failure never leaves the server. */
export function problemOf(failure: DomainFailure, correlationId: string): Problem {
  const d = failure.details;
  const base = {
    type: PROBLEM_TYPE_PREFIX + failure.code,
    title: PROBLEM_TITLE[failure.code],
    status: PROBLEM_STATUS[failure.code],
    code: failure.code,
    correlationId,
    retryable: failure.retryable || RETRYABLE_CODES.has(failure.code),
    nextActions: nextActionsOf(failure),
  };
  return {
    ...base,
    ...(d.reason !== undefined ? { reason: d.reason } : {}),
    ...(d.fields !== undefined ? { errors: d.fields } : {}),
    ...(d.retryAfterSeconds !== undefined ? { retryAfterSeconds: d.retryAfterSeconds } : {}),
    ...(d.currentVersion !== undefined && d.currentState !== undefined
      ? {
          current: {
            version: d.currentVersion,
            state: d.currentState,
            ...(d.successorId !== undefined ? { successorId: d.successorId } : {}),
            ...(d.mismatch !== undefined ? { mismatch: d.mismatch } : {}),
          },
        }
      : {}),
  };
}

/** The opaque problem for an unexpected exception: only the correlation id and a safe classification (10). */
export function internalProblem(correlationId: string): Problem {
  return problemOf(new DomainFailure("INTERNAL_ERROR", "unexpected exception", {}, true), correlationId);
}

export function isFailureCode(v: unknown): v is FailureCode {
  return typeof v === "string" && (FAILURE_CODES as ReadonlyArray<string>).includes(v);
}
