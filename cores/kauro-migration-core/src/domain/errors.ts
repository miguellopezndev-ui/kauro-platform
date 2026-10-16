import type { JsonObject } from '../util/json.js';

/**
 * Fatal error classes. A fatal error aborts the run: no package is produced and
 * the CLI exits non-zero.
 *
 * Row-level uncertainty is deliberately NOT in this list. An ambiguous phone
 * number or an unresolved association is a disposition on a row or an edge, not
 * a run failure. Only conditions that make the whole run untrustworthy belong
 * here.
 */
export const ERROR_CODES = [
  'INPUT_CORRUPT',
  'INPUT_UNSUPPORTED',
  'INPUT_LIMIT_EXCEEDED',
  'INPUT_DUPLICATE_FILE',
  'INPUT_NOT_FOUND',
  'ENCODING_UNKNOWN',
  'CONFIG_INVALID',
  'MAPPING_INVALID',
  'DESTINATION_MODE_UNSUPPORTED',
  'DESTINATION_OBJECT_UNSUPPORTED',
  'DESTINATION_FIELD_UNKNOWN',
  'DESTINATION_MATCH_UNSATISFIED',
  'TARGET_CONTRACT_INVALID',
  'TARGET_ARTIFACT_SECRET_PRESENT',
  'VENDOR_CONSTRAINT_FAILED',
  'RECONCILIATION_FAILED',
  'ARTIFACT_VERIFICATION_FAILED',
  'PACKAGE_INVALID',
  'SCRATCH_FAILED',
  'SCRATCH_QUOTA_EXCEEDED',
  'IDENTITY_GROUP_TOO_LARGE',
  'SOURCE_PROFILE_INVALID',
  'CANDIDATE_SET_INVALID',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Structured, actionable failure. `remedy` is written for the operator, not for a log parser. */
export class MigrationError extends Error {
  readonly code: ErrorCode;
  readonly remedy: string;
  readonly details: JsonObject;

  constructor(code: ErrorCode, message: string, remedy: string, details: JsonObject = {}) {
    super(`${code}: ${message}`);
    this.name = 'MigrationError';
    this.code = code;
    this.remedy = remedy;
    this.details = details;
  }

  toJson(): JsonObject {
    return {
      code: this.code,
      message: this.message,
      remedy: this.remedy,
      details: this.details,
    };
  }
}

export function isMigrationError(value: unknown): value is MigrationError {
  return value instanceof MigrationError;
}
