/**
 * The error taxonomy and the explicit outcomes of the canon §29. Every
 * failure this core reports is one of these; there is no "best effort".
 */
export const TASK_OUTCOMES = Object.freeze([
  'PROPOSED',
  'ABSTAINED',
  'REQUIRES_AGENCY_DECISION',
  'INVALID_SCHEMA',
  'INVALID_SEMANTICS',
  'FORBIDDEN_PROPOSAL',
  'STALE_INPUT',
  'INCOMPATIBLE_CONTRACT_VERSION',
  'BUDGET_EXHAUSTED',
  'PROVIDER_RETRYABLE_FAILURE',
  'PROVIDER_TERMINAL_FAILURE',
] as const);
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];

export const ERROR_CODES = Object.freeze([
  'INCOMPATIBLE_CONTRACT_VERSION',
  'INVALID_SCHEMA',
  'INVALID_SEMANTICS',
  'FORBIDDEN_PROPOSAL',
  'STALE_INPUT',
  'BUDGET_EXHAUSTED',
  'BUDGET_RESERVATION_CONFLICT',
  'EGRESS_BLOCKED',
  'TENANT_MISMATCH',
  'INVALID_TRANSITION',
  'RUN_CANCELLED',
  'DEADLINE_PASSED',
  'PROVIDER_RETRYABLE_FAILURE',
  'PROVIDER_TERMINAL_FAILURE',
  'PROVIDER_AMBIGUOUS',
  'VALIDATION_PORT_UNAVAILABLE',
  'VALIDATION_STALE',
  'MEMORY_SCOPE_VIOLATION',
  'CONTRACT_VIOLATION',
  'IDENTITY_CONFLICT',
  'LEDGER_CONFLICT',
  /** A worker that does not hold the run's lease: another live worker owns the attempt; nothing is reserved or sent. */
  'WORKER_NOT_OWNER',
  /** A write from an owner the lease has moved away from: the response, transition, outcome or result it carried is discarded, never appended beside the new owner's. */
  'LEDGER_FENCED',
] as const);
export type ErrorCode = (typeof ERROR_CODES)[number];

export class IntelligenceError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(code: ErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(`${code}: ${message}`);
    this.name = 'IntelligenceError';
    this.code = code;
    this.details = details;
  }
}

export function isIntelligenceError(value: unknown): value is IntelligenceError {
  return value instanceof IntelligenceError;
}

/** Assert with a typed error rather than a bare throw; callers branch on the code. */
export function contract(condition: unknown, code: ErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}): asserts condition {
  if (!condition) throw new IntelligenceError(code, message, details);
}
