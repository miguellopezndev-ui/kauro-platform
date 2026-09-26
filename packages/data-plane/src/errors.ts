/**
 * The refusal a bounded parser raises when an untrusted source violates the inspection policy (04 "XLSX parser requirements": "The
 * inspection policy identifies the precise rejection or excluded feature"; 09 "Completion and inspection": precise failure classes).
 * A refusal carries a class of the ContainerInspection contract and a stable problem code; never a value of the file, a path of the
 * archive or any other customer text (10 "Responses and safe errors"). `part` is the SHA-256 digest of the part identity.
 *
 * Loaded inside the isolated child process: this module imports nothing but types.
 */
export type RefusalClass = "CORRUPT_STRUCTURE" | "ACTIVE_CONTENT" | "RESOURCE_LIMIT" | "UNSUPPORTED_FORMAT";

/** Precedence when several findings of one phase apply: a hostile structure first, then active content, then a limit. */
export const REFUSAL_PRECEDENCE: ReadonlyArray<RefusalClass> = ["CORRUPT_STRUCTURE", "ACTIVE_CONTENT", "RESOURCE_LIMIT", "UNSUPPORTED_FORMAT"];

export class InspectionRefusal extends Error {
  constructor(
    readonly refusal: RefusalClass,
    readonly code: string,
    readonly part?: string,
  ) {
    super(`${refusal}: ${code}`);
    this.name = "InspectionRefusal";
  }
}

/** A finding of one phase (the archive metadata, the relationships): recorded, then refused together by precedence. */
export interface Finding {
  readonly refusal: RefusalClass;
  readonly code: string;
  readonly part?: string;
}

export function refusalOf(findings: ReadonlyArray<Finding>): RefusalClass | undefined {
  return REFUSAL_PRECEDENCE.find((c) => findings.some((f) => f.refusal === c));
}

/** Raised by a record callback that has seen enough (a sample, a preview window): not an error of the input. */
export class StopParsing extends Error {
  constructor() {
    super("stop");
    this.name = "StopParsing";
  }
}
