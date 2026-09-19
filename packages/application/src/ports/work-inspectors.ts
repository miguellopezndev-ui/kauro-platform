/**
 * Inspectors that let a B06 command report, not decide, the work other aggregates hold:
 * - ActiveWorkInspector (CMD010): "active paid work has been reviewed" — archiving stops new projects and retains active work;
 *   the command returns what it retained so the caller reviewed it (07 "Client and project routes"). In B06 the only known
 *   work is open projects; jobs and commercial authorizations extend the summary in their packages.
 * - ExternalActionInspector (CMD026): "already completed external/customer actions are identified separately" — withdrawal
 *   revokes future execution authority; completed CRM imports and stages are named, never promised reversible (12/05).
 */
import type { Id } from "@kauro/contracts";
import type { ClientId, PlanId, UnitOfWork } from "@kauro/domain";

export interface ActiveWorkSummary {
  readonly openProjects: number;
  readonly activeJobs: number;
  readonly liveCommercialAuthorizations: number;
}

export interface ActiveWorkInspector {
  inspectClient(uow: UnitOfWork, clientId: ClientId): Promise<ActiveWorkSummary>;
}

export interface CompletedExternalAction {
  readonly kind: "IMPORT_STAGE_VERIFIED" | "IMPORT_STAGE_REPORTED" | "PACKAGE_DELIVERED";
  /** The platform id of the stage or package (UUIDv7); it is carried in approval.withdrawn.v1, so never a customer value. */
  readonly referenceId: Id;
}

export interface ExternalActionInspector {
  completedForPlan(uow: UnitOfWork, planId: PlanId): Promise<ReadonlyArray<CompletedExternalAction>>;
}
