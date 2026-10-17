/**
 * Why a report could not be produced and staged inside an attempt (B13 x B08; docs/design/B13-report-delivery.md). A refusal is a
 * closed code and a detail that never quotes package content. The stage turns it into the attempt's REFUSED outcome, so a package
 * whose report failed is never published without it.
 */
export const REPORT_STAGE_ERROR_CODES = [
  // the platform's inputs
  "FACTS_UNAVAILABLE",
  "FACTS_FOREIGN_SCOPE",
  "FACTS_MALFORMED",
  "TERMS_UNAVAILABLE",
  "TERMS_UNVERIFIABLE",
  "COUNTS_UNAVAILABLE",
  "COUNTS_MISMATCH",
  "COUNTS_UNRESOLVED",
  // the package the core staged
  "PACKAGE_NOT_STAGED",
  "PACKAGE_TOO_LARGE",
  "PACKAGE_UNREADABLE",
  "MODEL_REFUSED",
  // the PDF
  "PDF_FAILED",
  "PDF_ENGINE_FAILED",
  "PDF_NOT_GENUINE",
  "IDENTITY_FOREIGN",
  "SCOPE_FOREIGN",
  "REPORT_ALREADY_STAGED",
  // its storage
  "OBJECT_NOT_THIS_WRITERS",
  "STORED_BYTES_DIFFER",
  "VERIFICATION_UNCERTAIN",
  "WRITER_UNSUPPORTED",
  "CANCELLED",
] as const;
export type ReportStageErrorCode = (typeof REPORT_STAGE_ERROR_CODES)[number];

export class ReportStageError extends Error {
  override readonly name = "ReportStageError";
  readonly code: ReportStageErrorCode;
  /** The closed codes of the underlying refusal (a ReportModelError's problems), when there are any. */
  readonly problems: readonly string[];
  constructor(code: ReportStageErrorCode, detail: string, options: { readonly problems?: readonly string[]; readonly cause?: unknown } = {}) {
    const problems = options.problems ?? [];
    super(`${code}: ${detail}${problems.length > 0 ? ` [${problems.join(", ")}]` : ""}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.problems = problems;
  }
}
