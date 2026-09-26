/**
 * The reads of the request side of the payments workflow (package B09, implementation mandate M4; design §6.2, §8 CMD028, CMD029,
 * CMD031, CMD032, §8.3; decision D-REQ-B2 of docs/design/B09-payments-fiscal.md). They run inside the caller's commerce unit of
 * work and under its policies — a TENANT context (the request handlers, kauro_app), an OPERATOR context in its adopted finance
 * scope, or a SERVICE context of the payment service (kauro_payment) after it adopted the stored operation's agency — and they
 * read nothing the caller's role may not read:
 *
 *  - `subjectOf` is the PostgreSQL adapter of the application port PurchasedSubjectReader (decision D-CORE-B2): the purchased
 *    subject a checkout and an issuance rely on, read after the shared halves of the transition locks in the platform's order
 *    (agency → capability → approval → source revision → target contract; design §6.2, B06 D-TX-2), selecting exactly the
 *    columns migration 0009 grants kauro_payment (never a plan body, a project purpose, a client or a person). The shape is the
 *    port's own, written structurally because @kauro/persistence does not depend on @kauro/application (as D-INSP-B1 does);
 *  - `awaitTransition` takes the shared half of a commerce transition subject the request side relies on without changing it —
 *    the quote a later order of an accepted quote only relies on, the capture and the entitlement an approval of a refund relies
 *    on (the database's own guards re-acquire the same locks: they are the backstop, never the only order);
 *  - the order, capture and policy queries the request side answers from (a quote's orders for ALREADY_PAID, a project's latest
 *    completed capture for a refund request, the ACTIVE standing refund policies an owner's review lists).
 */
import type { Capability, Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { AgencyState, ApprovalId, CapabilityId, CaptureId, PaymentOrderId, PaymentOrderState, PlanRecord, ProjectId, QuoteId, QuoteRecord, RefundPolicyId } from "@kauro/domain";
import { execute, instant, type Queryable } from "../sql.js";

/** The purchased subject as PurchasedSubjectReader answers it (the application port's shape, structurally). */
export interface PurchasedSubjectRow {
  readonly agencyState: AgencyState;
  readonly plan: Pick<PlanRecord, "state" | "approvalId" | "bodyHash"> | null;
  readonly approval: { readonly approvalHash: Sha256Hex; readonly withdrawnAt?: UtcInstant } | null;
  readonly revision: { readonly state: string } | null;
  readonly target: { readonly confirmed: boolean; readonly superseded: boolean } | null;
  readonly capability: { readonly capabilityId: CapabilityId; readonly capabilityVersion: string; readonly state: Capability["state"] } | null;
}

/** The commerce transition subjects the request side reads after their shared half (design §6.2, D-TX-B1). */
export type RequestTransitionSubject = "kauro.quotes" | "kauro.capture_facts" | "kauro.commercial_authorizations";

export class PgCommerceRequestReads {
  constructor(private readonly db: Queryable) {}

  private async await(kind: string, subject: string): Promise<void> {
    await execute(this.db, "SELECT kauro.await_transition($1, $2)", [kind, subject]);
  }

  /**
   * The purchased subject of a quote, after the shared halves of what it relies on, in the platform's lock order; null when the
   * quote's agency or project is not visible to the caller (the subject then binds nothing, and the caller answers accordingly).
   */
  async subjectOf(quote: Pick<QuoteRecord, "agencyId" | "projectId" | "planId" | "approvalId" | "mode" | "revisionHash" | "targetContractHash">): Promise<PurchasedSubjectRow | null> {
    await this.await("kauro.agencies", quote.agencyId);
    const agency = await execute<{ state: AgencyState }>(this.db, "SELECT state FROM kauro.agencies WHERE agency_id = $1", [quote.agencyId]);
    const agencyRow = agency.rows[0];
    if (!agencyRow) return null;
    const project = await execute<{ capability_id: string; capability_version: string }>(
      this.db,
      "SELECT capability_id, capability_version FROM kauro.projects WHERE agency_id = $1 AND project_id = $2",
      [quote.agencyId, quote.projectId],
    );
    const projectRow = project.rows[0];
    if (!projectRow) return null;
    // the capability's transition subject is its mode (B06 D-CAP-2: a suspension of the mode's offer takes the exclusive half)
    await this.await("kauro.capabilities", quote.mode);
    const capability = await execute<{ state: Capability["state"] }>(this.db, "SELECT state FROM kauro.capabilities WHERE capability_id = $1", [projectRow.capability_id]);
    await this.await("kauro.approvals", quote.approvalId);
    const approval = await execute<{ approval_hash: string; withdrawn_at: Date | null }>(
      this.db,
      "SELECT approval_hash, withdrawn_at FROM kauro.approvals WHERE agency_id = $1 AND approval_id = $2",
      [quote.agencyId, quote.approvalId],
    );
    const plan = await execute<{ state: PlanRecord["state"]; approval_id: string | null; body_hash: string }>(
      this.db,
      "SELECT state, approval_id, body_hash FROM kauro.plans WHERE agency_id = $1 AND plan_id = $2",
      [quote.agencyId, quote.planId],
    );
    // the revision of the quoted project whose manifest hash is the quoted revision hash, after its transition lock
    const revisionId = await execute<{ revision_id: string }>(
      this.db,
      "SELECT revision_id FROM kauro.dataset_revisions WHERE agency_id = $1 AND project_id = $2 AND manifest_hash = $3",
      [quote.agencyId, quote.projectId, quote.revisionHash],
    );
    let revision: PurchasedSubjectRow["revision"] = null;
    const revisionIdRow = revisionId.rows[0];
    if (revisionIdRow) {
      await this.await("kauro.dataset_revisions", revisionIdRow.revision_id);
      const r = await execute<{ state: string }>(this.db, "SELECT state FROM kauro.dataset_revisions WHERE agency_id = $1 AND revision_id = $2", [quote.agencyId, revisionIdRow.revision_id]);
      revision = r.rows[0] ? { state: r.rows[0].state } : null;
    }
    // the target contract of the quoted project whose body hash is the quoted target hash, after its transition lock
    const contractId = await execute<{ contract_id: string }>(
      this.db,
      "SELECT contract_id FROM kauro.target_contracts WHERE agency_id = $1 AND project_id = $2 AND body_hash = $3",
      [quote.agencyId, quote.projectId, quote.targetContractHash],
    );
    let target: PurchasedSubjectRow["target"] = null;
    const contractIdRow = contractId.rows[0];
    if (contractIdRow) {
      await this.await("kauro.target_contracts", contractIdRow.contract_id);
      const t = await execute<{ confirmed_at: Date | null; superseded_at: Date | null }>(
        this.db,
        "SELECT confirmed_at, superseded_at FROM kauro.target_contracts WHERE agency_id = $1 AND contract_id = $2",
        [quote.agencyId, contractIdRow.contract_id],
      );
      target = t.rows[0] ? { confirmed: t.rows[0].confirmed_at !== null, superseded: t.rows[0].superseded_at !== null } : null;
    }
    const approvalRow = approval.rows[0];
    const planRow = plan.rows[0];
    const capabilityRow = capability.rows[0];
    return {
      agencyState: agencyRow.state,
      plan: planRow ? { state: planRow.state, ...(planRow.approval_id !== null ? { approvalId: planRow.approval_id as ApprovalId } : {}), bodyHash: planRow.body_hash } : null,
      approval: approvalRow ? { approvalHash: approvalRow.approval_hash, ...(approvalRow.withdrawn_at !== null ? { withdrawnAt: instant(approvalRow.withdrawn_at) } : {}) } : null,
      revision,
      target,
      capability: capabilityRow ? { capabilityId: projectRow.capability_id as CapabilityId, capabilityVersion: projectRow.capability_version, state: capabilityRow.state } : null,
    };
  }

  /** The shared half of a commerce transition subject, held to COMMIT (kauro.await_transition; design §6.2). */
  async awaitTransition(kind: RequestTransitionSubject, subject: string): Promise<void> {
    await this.await(kind, subject);
  }

  /** The orders of a quote visible to the caller, oldest first (ALREADY_PAID and the quote's read). */
  async ordersOfQuote(quoteId: QuoteId): Promise<ReadonlyArray<{ readonly orderId: PaymentOrderId; readonly state: PaymentOrderState }>> {
    const r = await execute<{ order_id: string; state: PaymentOrderState }>(this.db, "SELECT order_id, state FROM kauro.payment_orders WHERE quote_id = $1 ORDER BY created_at, order_id", [quoteId]);
    return r.rows.map((x) => ({ orderId: x.order_id as PaymentOrderId, state: x.state }));
  }

  /** Whether a COMPLETED capture pays an order of the quote (ALREADY_PAID: a second purchase of the same subject is refused). */
  async completedCaptureOfQuote(quoteId: QuoteId): Promise<CaptureId | null> {
    const r = await execute<{ capture_id: string }>(
      this.db,
      `SELECT c.capture_id FROM kauro.capture_facts c JOIN kauro.payment_orders o ON o.agency_id = c.agency_id AND o.order_id = c.order_id
        WHERE o.quote_id = $1 AND c.status = 'COMPLETED' ORDER BY c.first_observed_at, c.capture_id LIMIT 1`,
      [quoteId],
    );
    return (r.rows[0]?.capture_id as CaptureId | undefined) ?? null;
  }

  /**
   * The latest COMPLETED capture of the project's orders (CMD031: the refund request is filed against it), by the provider's
   * completion instant; null when none is completed.
   */
  async latestCompletedCaptureOfProject(projectId: ProjectId): Promise<CaptureId | null> {
    const r = await execute<{ capture_id: string }>(
      this.db,
      `SELECT c.capture_id FROM kauro.capture_facts c JOIN kauro.payment_orders o ON o.agency_id = c.agency_id AND o.order_id = c.order_id
        WHERE o.project_id = $1 AND c.status = 'COMPLETED'
        ORDER BY c.provider_completed_at DESC NULLS LAST, c.first_observed_at DESC, c.capture_id DESC LIMIT 1`,
      [projectId],
    );
    return (r.rows[0]?.capture_id as CaptureId | undefined) ?? null;
  }

  /** The ACTIVE standing refund policies, oldest first and at most `limit` (the owner's review lists those that cover a refund). */
  async activeRefundPolicies(limit: number): Promise<ReadonlyArray<RefundPolicyId>> {
    const r = await execute<{ policy_id: string }>(this.db, "SELECT policy_id FROM kauro.refund_policies WHERE state = 'ACTIVE' ORDER BY created_at, policy_id LIMIT $1", [limit]);
    return r.rows.map((x) => x.policy_id as RefundPolicyId);
  }
}
