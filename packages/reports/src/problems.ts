/**
 * Why a package or a report input is refused. A refusal lists every problem it found, each with a closed code and the artifact
 * it is about; it never quotes a cell value (customer data stays in the package, not in an error message or a log).
 */
export const PROBLEM_CODES = [
  "MANIFEST_MISSING",
  "MANIFEST_MALFORMED",
  "UNSUPPORTED_FORMAT",
  "UNSAFE_PATH",
  "DUPLICATE_PATH",
  "AREA_KIND_MISMATCH",
  "ARTIFACT_MISSING",
  "ARTIFACT_UNDECLARED",
  "ARTIFACT_BYTES_MISMATCH",
  "ARTIFACT_ROWS_MISMATCH",
  "ARTIFACT_UNREADABLE",
  "RECONCILIATION_MALFORMED",
  "RECONCILIATION_MISMATCH",
  "IMPORT_OBJECT_UNKNOWN",
  "UNRESOLVED_DECISIONS",
  "FACTS_MALFORMED",
  "BRANDING_UNSAFE",
  "DECLARED_COUNTS_MISMATCH",
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

export interface Problem {
  readonly code: ProblemCode;
  /** The package path or input field the problem is about (never a value from inside a file). */
  readonly subject: string;
  readonly detail: string;
}

export class ReportModelError extends Error {
  override readonly name = "ReportModelError";
  readonly problems: readonly Problem[];
  constructor(problems: readonly Problem[]) {
    super(`report model refused: ${problems.map((p) => `${p.code} ${p.subject}`).join("; ")}`);
    this.problems = problems;
  }
}

export class Problems {
  readonly list: Problem[] = [];
  add(code: ProblemCode, subject: string, detail: string): void {
    this.list.push({ code, subject, detail });
  }
  throwIfAny(): void {
    if (this.list.length > 0) throw new ReportModelError(this.list);
  }
}
