/**
 * The readings of execution that other packages' ports bind (package B08; docs/design/B08-audit-approval-jobs.md §10, D8-XPKG-3,
 * D8-XPKG-4, D8-CAP-2): B09's DeliveryCapacityPort over the capacity ledgers — read by the request handlers (kauro_app) and by the
 * payment service's SERVICE unit of its adopted agency (kauro_payment), column-scoped — and the job and package readings that extend,
 * by composition, the ActiveWork, CommercialConsequence and ExternalAction inspectors B09 already bound in apps/api/src/edition.ts.
 * They run in the caller's unit of work under its policies. The shapes are the application ports' own, written structurally here
 * because the persistence adapter does not depend on the application package (B09 D-INSP-B1); B08-COMMANDS-EXECUTION binds them.
 */
import type { Id, Sha256Hex } from "@kauro/contracts";
import { canonicalBytes, rawDigest } from "@kauro/contracts";
import { EXECUTION_POLICY, type AgencyId, type ClientId, type PlanId } from "@kauro/domain";
import { execute, int, type Queryable } from "../sql.js";

/** B09's checkoutCapacity answer (DeliveryCapacityPort): a slot of the agency's live-job bound is free, or the queue is full. */
export type CheckoutCapacity = { readonly available: true; readonly evidenceHash: Sha256Hex } | { readonly available: false; readonly reason: "ADMISSION_QUEUE_FULL" };

/** Platform domain of the capacity evidence a checkout cites (the agency's ledger as read). */
export const EXECUTION_CAPACITY_DOMAIN = "KAURO_EXECUTION_CAPACITY_V1";

export class PgExecutionReads {
  constructor(private readonly db: Queryable) {}

  /**
   * D8-CAP-2: checkout never sells into a hidden queue — the same ledger ExecuteProject's bound reads (three live jobs per agency).
   * Reads only the columns granted to both runtime groups (agency_id, live_jobs).
   */
  async checkoutCapacity(request: { readonly agencyId: AgencyId }): Promise<CheckoutCapacity> {
    const r = await execute<{ live: number }>(this.db, "SELECT coalesce((SELECT l.live_jobs FROM kauro.agency_execution_capacity l WHERE l.agency_id = $1), 0) AS live", [request.agencyId]);
    const live = int(r.rows[0]?.live ?? 0);
    if (live >= EXECUTION_POLICY.agencyLiveJobs) return { available: false, reason: "ADMISSION_QUEUE_FULL" };
    return { available: true, evidenceHash: rawDigest(canonicalBytes({ domain: EXECUTION_CAPACITY_DOMAIN, version: 1, payload: { agencyId: request.agencyId, liveJobs: live, liveLimit: EXECUTION_POLICY.agencyLiveJobs } })) };
  }

  /** ActiveWorkSummary.activeJobs: the live jobs of the client's projects (CMD010 reports, never decides, retained work). */
  async activeJobsOfClient(clientId: ClientId): Promise<number> {
    const r = await execute<{ n: string }>(
      this.db,
      `SELECT count(*)::text AS n FROM kauro.processing_jobs j JOIN kauro.projects p ON p.agency_id = j.agency_id AND p.project_id = j.project_id
        WHERE p.client_id = $1 AND j.state IN ('QUEUED', 'ADMITTED', 'RUNNING', 'VERIFYING', 'CANCEL_REQUESTED')`,
      [clientId],
    );
    return int(r.rows[0]?.n ?? "0");
  }

  /** The PROCESSING_JOB consequences a revision of an APPROVED plan would strand: its live jobs (UnreconciledConsequence). */
  async unreconciledJobsForPlan(planId: PlanId): Promise<ReadonlyArray<{ readonly kind: "PROCESSING_JOB"; readonly referenceId: Id }>> {
    const r = await execute<{ job_id: string }>(
      this.db,
      "SELECT job_id FROM kauro.processing_jobs WHERE plan_id = $1 AND state IN ('QUEUED', 'ADMITTED', 'RUNNING', 'VERIFYING', 'CANCEL_REQUESTED') ORDER BY created_at, job_id",
      [planId],
    );
    return r.rows.map((x) => ({ kind: "PROCESSING_JOB" as const, referenceId: x.job_id as Id }));
  }

  /** The packages of the plan that were delivered (ExternalActionInspector PACKAGE_DELIVERED; never promised reversible). */
  async deliveredPackagesForPlan(planId: PlanId): Promise<ReadonlyArray<{ readonly kind: "PACKAGE_DELIVERED"; readonly referenceId: Id }>> {
    const r = await execute<{ package_version_id: string }>(
      this.db,
      `SELECT p.package_version_id FROM kauro.package_versions p JOIN kauro.processing_jobs j ON j.agency_id = p.agency_id AND j.job_id = p.job_id
        WHERE j.plan_id = $1 AND p.available_at IS NOT NULL ORDER BY p.available_at, p.package_version_id`,
      [planId],
    );
    return r.rows.map((x) => ({ kind: "PACKAGE_DELIVERED" as const, referenceId: x.package_version_id as Id }));
  }
}
