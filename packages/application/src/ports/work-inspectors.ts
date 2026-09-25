/**
 * Inspectors that let a B06 command report, not decide, the work other aggregates hold:
 * - ActiveWorkInspector (CMD010): "active paid work has been reviewed" — archiving stops new projects and retains active work;
 *   the command returns what it retained so the caller reviewed it (07 "Client and project routes"). In B06 the only known
 *   work is open projects; jobs and commercial authorizations extend the summary in their packages.
 * - ExternalActionInspector (CMD026): "already completed external/customer actions are identified separately" — withdrawal
 *   revokes future execution authority; completed CRM imports and stages are named, never promised reversible (12/05).
 * - CommercialConsequenceInspector (CMD023 on an APPROVED plan): the registry Plan edge APPROVED -new_plan_revision->
 *   SUPERSEDED is guarded by "Commercial/execution consequences are reconciled" with the effect "Pause affected future work
 *   pending new approval". The inspector names the commercial and execution facts that still rest on the plan's approval and
 *   are not reconciled; any of them refuses the revision until its owning package reconciles it (07 "Aggregate ownership":
 *   Quote, PaymentOrder, CommercialAuthorization and ProcessingJob own those facts; 07 "CommercialAuthorization": "A
 *   materially changed customer scope requires new commercial analysis").
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

export interface UnreconciledConsequence {
  readonly kind: "QUOTE" | "PAYMENT_ORDER" | "COMMERCIAL_AUTHORIZATION" | "PROCESSING_JOB";
  /** The platform id of the fact (UUIDv7), never a customer value. */
  readonly referenceId: Id;
}

export interface CommercialConsequenceInspector {
  /** The unreconciled commercial or execution facts bound to the plan's approval (empty when the guard holds). */
  unreconciledForPlan(uow: UnitOfWork, planId: PlanId): Promise<ReadonlyArray<UnreconciledConsequence>>;
}
