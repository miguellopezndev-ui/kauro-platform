/**
 * The purchased subject as the payment service may read it (package B09, stage-2 mandate M3; decision D-CORE-B2 of
 * docs/design/B09-payments-fiscal.md; design §3.2, §6.2, §6.3 step 2): the facts an issuance of a CommercialAuthorization relies
 * on — the agency's state, the quoted plan and its approval, the quoted source revision, the quoted target contract and the
 * project's capability — read with exactly the columns migration 0013 grants kauro_payment (agencies id, version, state; projects
 * without `purpose`; plans without `body`; approvals, dataset revisions and target contracts by their hashes and instants), after
 * the shared halves of their transition locks in the platform's lock order (agency → capability → approval → source revision →
 * target contract; B06 D-TX-2), so a suspension, a withdrawal, an expiry or a supersession in flight is ordered before or after
 * the reading unit of work. The B06 repositories select every column (plan bodies, project purposes) and cannot run under
 * kauro_payment; this reader is what the M2 reconciler's `PurchasedSubjectReader` port binds to (apps/api src/edition.ts purchasedSubjectReader, for the request side and the payment service alike; decisions D-M3-B3, D-INT2-B2).
 * The database re-checks every fact at issuance anyway (kauro.commercial_authorizations_require_capture, KP004).
 *
 * The shape is the application port's own (`PurchasedSubject` of @kauro/application commerce/core/subject.ts), written
 * structurally here because the persistence adapter does not depend on the application package (the same rule as D-INSP-B1).
 * It runs in any commerce unit of work: TENANT (every column is visible) and SERVICE after it adopted the agency (the column
 * grants of 0013); a subject whose agency or project is not visible reads as null (it binds nothing).
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { AgencyId, AgencyState, ApprovalId, CapabilityId, PlanId, ProjectId, ServiceMode } from "@kauro/domain";
import { execute, instant, type Queryable } from "../sql.js";
import { awaitTransition } from "./tenancy.js";

/** The quote members the subject is read from. */
export interface QuotedSubject {
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly planId: PlanId;
  readonly approvalId: ApprovalId;
  readonly revisionHash: Sha256Hex;
  readonly targetContractHash: Sha256Hex;
  readonly mode: ServiceMode;
}

type PlanState = "DRAFT" | "VALIDATION_REQUIRED" | "VALIDATING" | "VALIDATED" | "APPROVED" | "SUPERSEDED" | "WITHDRAWN";
type CapabilityState = "DESIGN" | "IMPLEMENTED_UNACCEPTED" | "QUALIFIED_INTERNAL" | "AVAILABLE_LIMITED" | "AVAILABLE" | "SUSPENDED";

/** @kauro/application PurchasedSubject, structurally. */
export interface PurchasedSubjectFacts {
  readonly agencyState: AgencyState;
  readonly plan: { readonly state: PlanState; readonly approvalId?: ApprovalId; readonly bodyHash: Sha256Hex } | null;
  readonly approval: { readonly approvalHash: Sha256Hex; readonly withdrawnAt?: UtcInstant } | null;
  readonly revision: { readonly state: string } | null;
  readonly target: { readonly confirmed: boolean; readonly superseded: boolean } | null;
  readonly capability: { readonly capabilityId: CapabilityId; readonly capabilityVersion: string; readonly state: CapabilityState } | null;
}

export class PgPurchasedSubjects {
  constructor(private readonly db: Queryable) {}

  /**
   * The purchased subject of a quote, each fact read after the shared half of its transition lock in the platform's lock order.
   * Null when the quote's agency or project is not visible to the unit of work (a subject that cannot be read binds nothing).
   */
  async subjectOf(quote: QuotedSubject): Promise<PurchasedSubjectFacts | null> {
    // the agency (B06 D-TX-2: identity → membership → agency → client → capability)
    await awaitTransition(this.db, "kauro.agencies", quote.agencyId);
    const agency = (await execute<{ state: AgencyState }>(this.db, "SELECT state FROM kauro.agencies WHERE agency_id = $1", [quote.agencyId])).rows[0];
    if (agency === undefined) return null;
    const project = (
      await execute<{ mode: ServiceMode; capability_id: string; capability_version: string }>(
        this.db,
        "SELECT mode, capability_id, capability_version FROM kauro.projects WHERE agency_id = $1 AND project_id = $2",
        [quote.agencyId, quote.projectId],
      )
    ).rows[0];
    if (project === undefined) return null;
    // the capability of the project's mode (the transition subject of a mode is its mode, as B06 CreateProject reads it)
    await awaitTransition(this.db, "kauro.capabilities", project.mode);
    const capability = (await execute<{ state: CapabilityState }>(this.db, "SELECT state FROM kauro.capabilities WHERE capability_id = $1", [project.capability_id])).rows[0];
    // the approval (its withdrawal takes the exclusive half, migration 0015 approvals_transition_lock)
    await execute(this.db, "SELECT kauro.await_transition('kauro.approvals', $1)", [quote.approvalId]);
    const approval = (
      await execute<{ approval_hash: string; withdrawn_at: Date | null }>(this.db, "SELECT approval_hash, withdrawn_at FROM kauro.approvals WHERE agency_id = $1 AND approval_id = $2", [quote.agencyId, quote.approvalId])
    ).rows[0];
    // the quoted source revision and target contract of the project: the ids first, then their shared halves, then their facts
    const revisionId = (
      await execute<{ revision_id: string }>(this.db, "SELECT revision_id FROM kauro.dataset_revisions WHERE agency_id = $1 AND project_id = $2 AND manifest_hash = $3", [quote.agencyId, quote.projectId, quote.revisionHash])
    ).rows[0]?.revision_id;
    let revision: PurchasedSubjectFacts["revision"] = null;
    if (revisionId !== undefined) {
      await awaitTransition(this.db, "kauro.dataset_revisions", revisionId);
      const row = (await execute<{ state: string }>(this.db, "SELECT state FROM kauro.dataset_revisions WHERE agency_id = $1 AND revision_id = $2", [quote.agencyId, revisionId])).rows[0];
      revision = row === undefined ? null : { state: row.state };
    }
    const contractId = (
      await execute<{ contract_id: string }>(this.db, "SELECT contract_id FROM kauro.target_contracts WHERE agency_id = $1 AND project_id = $2 AND body_hash = $3", [quote.agencyId, quote.projectId, quote.targetContractHash])
    ).rows[0]?.contract_id;
    let target: PurchasedSubjectFacts["target"] = null;
    if (contractId !== undefined) {
      await awaitTransition(this.db, "kauro.target_contracts", contractId);
      const row = (
        await execute<{ confirmed_at: Date | null; superseded_at: Date | null }>(this.db, "SELECT confirmed_at, superseded_at FROM kauro.target_contracts WHERE agency_id = $1 AND contract_id = $2", [quote.agencyId, contractId])
      ).rows[0];
      target = row === undefined ? null : { confirmed: row.confirmed_at !== null, superseded: row.superseded_at !== null };
    }
    const plan = (
      await execute<{ state: PlanState; approval_id: string | null; body_hash: string }>(this.db, "SELECT state, approval_id, body_hash FROM kauro.plans WHERE agency_id = $1 AND plan_id = $2", [quote.agencyId, quote.planId])
    ).rows[0];
    return {
      agencyState: agency.state,
      plan: plan === undefined ? null : { state: plan.state, bodyHash: plan.body_hash, ...(plan.approval_id !== null ? { approvalId: plan.approval_id as ApprovalId } : {}) },
      approval: approval === undefined ? null : { approvalHash: approval.approval_hash, ...(approval.withdrawn_at !== null ? { withdrawnAt: instant(approval.withdrawn_at) } : {}) },
      revision,
      target,
      capability: capability === undefined ? null : { capabilityId: project.capability_id as CapabilityId, capabilityVersion: project.capability_version, state: capability.state },
    };
  }
}
