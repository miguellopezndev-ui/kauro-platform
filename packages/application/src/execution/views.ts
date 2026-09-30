/**
 * The safe DTO of a processing job (B08; docs/design/B08-audit-approval-jobs.md §12, Q8-8; 10 "Responses and safe errors": never a
 * provider identity, an object name, a prompt or a customer value). It is the TypeScript shape of the closed JobView schema of
 * execution/response-views (derived from the registry Job contract); a test keeps the two member for member.
 *
 * The provider's own state is derived from the job row (never a provider identifier): LAUNCHING once the job is admitted and the
 * provider has not started it, RUNNING while it runs, FINISHED once its output is being verified. Only the package id appears
 * (Q8-8), and only once the publication committed.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { JobState } from "@kauro/domain";

/** The operations a caller may issue on a job (informative, never authority; B06 D-PERM-1). */
export const EXECUTION_RESOURCE_ACTIONS = ["CancelJob"] as const;
export type ExecutionResourceAction = (typeof EXECUTION_RESOURCE_ACTIONS)[number];

/** What the provider is doing for the live attempt, as far as the platform's own record shows it. */
export const ACTIVE_PROVIDER_STATES = ["LAUNCHING", "RUNNING", "FINISHED"] as const;
export type ActiveProviderState = (typeof ACTIVE_PROVIDER_STATES)[number];

export interface JobView {
  readonly jobId: string;
  readonly projectId: string;
  readonly authorizationId: string;
  readonly state: JobState;
  /** The physical attempt ordinal (0 while QUEUED). */
  readonly attempt: number;
  readonly version: number;
  readonly queuedAt: UtcInstant;
  /** The instant the delivery must have happened by: the capture's completion plus forty-eight hours (D8-RET-1). */
  readonly deliveryDeadlineAt: UtcInstant;
  /** The absolute execution boundary, set at launch (absent before). */
  readonly executionDeadlineAt?: UtcInstant;
  /** How many cancellations the job recorded (CMD037 moves it once). */
  readonly cancelVersion: number;
  readonly cancelRequestedAt?: UtcInstant;
  readonly activeProviderState?: ActiveProviderState;
  /** The accepted output, present only after the verified publication (Q8-8: only the package id). */
  readonly publishedPackageId?: string;
  readonly permittedActions: ReadonlyArray<ExecutionResourceAction>;
}
