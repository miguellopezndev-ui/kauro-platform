/**
 * The execution policy values of package B08 (docs/design/B08-audit-approval-jobs.md D8-CAP-1, D8-ATT-1, D8-ATT-2, D8-RET-1,
 * D8-DL-1; Q8-2, Q8-3), each tied to the vendored registry policy it comes from. Migrations 0019 and 0020 carry the same numbers
 * in their CHECK constraints and guards; the domain test proves these equal the registry's.
 */
export const EXECUTION_POLICY = Object.freeze({
  /** capacity.heavyActive: at most one ACTIVE heavy job on the platform (07 "Job and attempt states"; R2-046). */
  heavyActive: 1,
  /** capacity.heavyQueued: at most three admitted jobs WAITING for the active slot (R2-046). */
  heavyQueued: 3,
  /** Live jobs of one agency (QUEUED, admitted or cancelling): capacity.heavyQueued, since the registry has no per-agency bound (Q8-2). */
  agencyLiveJobs: 3,
  /** The JOB_ATTEMPT lease time to live (D8-ATT-2). */
  leaseSeconds: 120,
  /** How often the monitor heartbeats a live attempt's lease (D8-ATT-2). */
  heartbeatSeconds: 30,
  /** Attempts of one job, all inside the original deadlines (Q8-3, D8-ATT-1). */
  maxAttempts: 3,
  /** retention.ordinaryPaidNoTerminalHours (48 h): the delivery deadline from the capture's completion (D8-RET-1). */
  deliveryDeadlineSeconds: 172_800,
  /** capacity.executionSeconds: the execution wall from the launch intent, never past the delivery deadline (D8-DL-1). */
  executionSeconds: 28_800,
  /** retention.paidDaysHardFromCapture (14 days): the PAID_ORDINARY hard deadline from the capture's completion (D8-RET-1). */
  paidOrdinaryHardSeconds: 1_209_600,
  /** retention.paidDaysFromFirstPackage (7 days): the PAID_ORDINARY soft deadline from the first package (D8-RET-1). */
  paidOrdinarySoftSeconds: 604_800,
} as const);

export type ExecutionPolicy = typeof EXECUTION_POLICY;
