/**
 * The terminal causes of the attempt envelope (design docs/design/B08-audit-approval-jobs.md D8-STG-1, D8-STG-2; S035). Each
 * piece of host I/O — AttemptScratchStore, FencedArtifactWriter, GenerationSourceReader — fails with exactly one of these and
 * then stays failed: a worker cannot swallow the error and go on to stage a package over an incomplete spill or artifact.
 * Messages name ids, sizes and tokens only, never a customer value.
 */
import type { WorkerFailureCause } from "@kauro/application";

export type AttemptFailureCause = Extract<
  WorkerFailureCause,
  | "SCRATCH_EXHAUSTED"
  | "SHORT_WRITE"
  | "CORRUPT_INTERMEDIATE"
  | "READBACK_MISMATCH"
  | "ARTIFACT_CLOSE_FAILED"
  | "OUTSIDE_CAPABILITY"
  | "SOURCE_INTEGRITY_FAILED"
  | "CANCELLED"
  | "FENCED"
>;

export class AttemptEnvelopeFailure extends Error {
  readonly terminalCause: AttemptFailureCause;
  /** A short token naming what exactly failed (QUOTA, NO_PROGRESS, DIGEST, OVERWRITE_REFUSED, ...). */
  readonly problem: string;
  constructor(terminalCause: AttemptFailureCause, problem: string, detail: string) {
    super(`${terminalCause} (${problem}): ${detail}`);
    this.name = "AttemptEnvelopeFailure";
    this.terminalCause = terminalCause;
    this.problem = problem;
  }
}

/** The worker's terminal cause of any error: an envelope failure's own, WORKER_ERROR for anything else. */
export function terminalCauseOf(error: unknown): WorkerFailureCause {
  return error instanceof AttemptEnvelopeFailure ? error.terminalCause : "WORKER_ERROR";
}
