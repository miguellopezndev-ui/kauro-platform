/**
 * The reads of the request side of the payments workflow (package B09, implementation mandate M4; design §6.2, §8 CMD028, CMD029,
 * CMD031, CMD032, §8.3; decision D-REQ-B2 of docs/design/B09-payments-fiscal.md). They run inside the caller's commerce unit of
 * work and under its policies — a TENANT context (the request handlers, kauro_app), an OPERATOR context in its adopted finance
 * scope, or a SERVICE context of the payment service (kauro_payment) after it adopted the stored operation's agency — and they
 * read nothing the caller's role may not read:
 *
 *  - the purchased subject is not read here: the one adapter of the application port PurchasedSubjectReader is PgPurchasedSubjects
 *    (repositories/commerce-subject.ts; D-CORE-B2, D-M3-B3), which the request side binds too (decision D-INT2-B2);
 *  - `awaitTransition` takes the shared half of a commerce transition subject the request side relies on without changing it —
 *    the quote a later order of an accepted quote only relies on, the capture and the entitlement an approval of a refund relies
 *    on (the database's own guards re-acquire the same locks: they are the backstop, never the only order);
 *  - the order, capture and policy queries the request side answers from (a quote's orders for ALREADY_PAID, a project's latest
 *    completed capture for a refund request, the ACTIVE standing refund policies an owner's review lists).
 */
import type { CaptureId, PaymentOrderId, PaymentOrderState, ProjectId, QuoteId, RefundPolicyId } from "@kauro/domain";
import { execute, type Queryable } from "../sql.js";

/** The commerce transition subjects the request side reads after their shared half (design §6.2, D-TX-B1). */
export type RequestTransitionSubject = "kauro.quotes" | "kauro.capture_facts" | "kauro.commercial_authorizations";

export class PgCommerceRequestReads {
  constructor(private readonly db: Queryable) {}

  private async await(kind: string, subject: string): Promise<void> {
    await execute(this.db, "SELECT kauro.await_transition($1, $2)", [kind, subject]);
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
