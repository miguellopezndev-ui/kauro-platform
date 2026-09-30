/**
 * The control plane's discovery of execution work (package B08, mandate B08-CONTROL-EXECUTION; docs/design/B08-audit-approval-jobs.md
 * §4, §6, §7, §11; decisions D8-SCHED-1, D8-ATT-1, D8-ATT-2, D8-DL-1, D8-JAN-1, D8-CANCEL-2, D8-CEX-1): what JOB_EXECUTION,
 * EXECUTION_CONTROL and the sweepers ATTEMPT_MONITOR, JOB_DEADLINES and STAGING_JANITOR read to find their work, and the inputs an
 * attempt executes. Reads only, over the grants migrations 0021 and 0022 (and B07's source grants) already give the control plane:
 * ids and states across agencies from an unbound SYSTEM unit (the jobs and attempts of every agency, D8-PEX-6), and the attempt's
 * inputs from a unit bound to the job's agency (the plan body and the sealed ACCEPTED generations, column-scoped). Every deadline is
 * compared with kauro.server_now() in SQL (D8-CLOCK-1): no method takes an instant from its caller. The pg implementation is
 * @kauro/persistence's; the writes stay the ExecutionStore's.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { CommercialAuthorizationId } from "../commerce/records.js";
import type { AgencyId, ApprovalId, PlanId, RevisionId } from "../model/ids.js";
import type { ProcessingAttemptId, ProcessingJobId } from "../model/execution/ids.js";
import type { ProcessingJobRecord } from "../model/execution/records.js";

/** A job the control plane found work for, with the agency its SYSTEM unit of work binds (B07 D-CTRL-1). */
export interface ExecutionJobRef {
  readonly jobId: ProcessingJobId;
  readonly agencyId: AgencyId;
}

/** An attempt the control plane found work for. */
export interface ExecutionAttemptRef {
  readonly attemptId: ProcessingAttemptId;
  readonly jobId: ProcessingJobId;
  readonly agencyId: AgencyId;
}

/**
 * A fact whose loss cancels the live jobs relying on it (D8-CANCEL-2): the entitlement (B09's commercial_authorization.revoked.v1),
 * the approval or the plan (B06's approval.withdrawn.v1, plan.withdrawn.v1, plan.superseded.v1), the source revision (B07's
 * dataset_revision.superseded.v1 and .expired.v1, and the revisions a source_file.admission_revoked.v1 names as sealing the file).
 */
export type ExecutionFact =
  | { readonly kind: "AUTHORIZATION"; readonly authorizationId: CommercialAuthorizationId }
  | { readonly kind: "APPROVAL"; readonly approvalId: ApprovalId }
  | { readonly kind: "PLAN"; readonly planId: PlanId }
  | { readonly kind: "REVISION"; readonly revisionId: RevisionId };

/** One sealed ACCEPTED generation the attempt may read, as the seal recorded it (the AttemptCapability's, D8-STG-1). */
export interface ExecutionSourceGeneration {
  readonly objectName: string;
  readonly generation: string;
  readonly sha256: Sha256Hex;
  readonly byteLength: number;
}

/** What an attempt executes (04 "executePlan"): the approved plan's closed body and the sealed source's included generations. */
export interface ExecutionInput {
  readonly planBody: unknown;
  readonly acceptedGenerations: ReadonlyArray<ExecutionSourceGeneration>;
}

export interface ExecutionDiscovery {
  /** kauro.server_now() of this unit of work, exact to the microsecond (D8-CLOCK-1). */
  serverNow(): Promise<UtcInstant>;
  /** JOB_EXECUTION's launch order (D8-SCHED-1): ADMITTED, uncancelled jobs holding a WAITING slot, by admission instant and job id. */
  launchCandidates(limit: number): Promise<ReadonlyArray<ExecutionJobRef>>;
  /** ATTEMPT_MONITOR's work: the uncancelled ADMITTED or RUNNING jobs holding the ACTIVE slot (their current attempt is watched). */
  monitoredJobs(limit: number): Promise<ReadonlyArray<ExecutionJobRef>>;
  /** JOB_DEADLINES: live, uncancelled jobs whose delivery deadline — or execution deadline once launched — is at or before the server clock. */
  jobsPastDeadline(limit: number): Promise<ReadonlyArray<ExecutionJobRef>>;
  /**
   * STAGING_JANITOR's work (D8-JAN-1): ended attempts without a cleanup record whose staging no package still needs — none, or one
   * AVAILABLE, RETIRED or DELETED (its delivery copies are the package); a REVOKED package's staging is private evidence, kept.
   */
  attemptsToClean(limit: number): Promise<ReadonlyArray<ExecutionAttemptRef>>;
  /** EXECUTION_CONTROL (D8-CANCEL-2): the agency's live, uncancelled jobs that rely on the fact. */
  liveJobsRelyingOn(agencyId: AgencyId, fact: ExecutionFact): Promise<ReadonlyArray<ExecutionJobRef>>;
  /** The job's attempt inputs, read in a unit bound to the job's agency. */
  executionInput(job: ProcessingJobRecord): Promise<ExecutionInput>;
}
