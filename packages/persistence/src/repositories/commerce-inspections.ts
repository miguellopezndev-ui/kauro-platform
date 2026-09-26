/**
 * The commerce queries behind B06's inspectors (design §14 M1; residual FINAL-N3): the commercial consequences resting on a plan's
 * approval that a revision of the APPROVED plan would strand (the registry Plan edge APPROVED -new_plan_revision-> SUPERSEDED,
 * guard "Commercial/execution consequences are reconciled"; B06 D-PLAN-4, CONSEQUENCES_UNRECONCILED), and the live commercial
 * authorizations a client's archive retains (CMD010 "active paid work has been reviewed"; B06 D-CMD-3). They run inside the
 * command's own unit of work under its tenant policies (a TENANT context reads its agency's quotes, orders and authorizations).
 *
 * The shapes are the application ports' own (UnreconciledConsequence, ActiveWorkSummary.liveCommercialAuthorizations of
 * @kauro/application ports/work-inspectors.ts), written structurally here because the persistence adapter does not depend on the
 * application package; the api composition binds them (decision D-INSP-B1 of docs/design/B09-payments-fiscal.md).
 */
import type { Id } from "@kauro/contracts";
import type { ClientId, PlanId } from "@kauro/domain";
import { execute, int, type Queryable } from "../sql.js";

/** One commercial fact bound to a plan's approval and not reconciled (the application's UnreconciledConsequence, less B08's jobs). */
export interface CommercialConsequence {
  readonly kind: "QUOTE" | "PAYMENT_ORDER" | "COMMERCIAL_AUTHORIZATION";
  /** The platform id of the fact (UUIDv7), never a customer value. */
  readonly referenceId: Id;
}

export class PgCommercialInspections {
  constructor(private readonly db: Queryable) {}

  /**
   * The commercial facts that rest on the plan and are not reconciled (D-INSP-B1), in a stable order: every live quote of the plan
   * (DRAFT, ISSUED, ACCEPTED_FOR_CHECKOUT — terms offered or accepted on the approval; reconciled by its withdrawal, supersession, or
   * for a paid purchase the refund or re-binding paths), every open payment order of those quotes (a checkout in flight), and every
   * live commercial authorization of the plan (ACTIVE, CONSUMED, DELIVERED — "a materially changed customer scope requires new
   * commercial analysis"). Processing jobs are B08's. Empty when the guard holds.
   */
  async unreconciledForPlan(planId: PlanId): Promise<ReadonlyArray<CommercialConsequence>> {
    const r = await execute<{ kind: CommercialConsequence["kind"]; reference_id: string }>(
      this.db,
      `SELECT 'QUOTE' AS kind, q.quote_id AS reference_id, q.created_at AS at FROM kauro.quotes q
        WHERE q.plan_id = $1 AND q.state IN ('DRAFT', 'ISSUED', 'ACCEPTED_FOR_CHECKOUT')
       UNION ALL
       SELECT 'PAYMENT_ORDER', o.order_id, o.created_at FROM kauro.payment_orders o JOIN kauro.quotes q ON q.agency_id = o.agency_id AND q.quote_id = o.quote_id
        WHERE q.plan_id = $1 AND o.state IN ('INTENT_CREATED', 'CREATING', 'CREATED', 'APPROVED', 'CAPTURING', 'CAPTURE_UNCERTAIN')
       UNION ALL
       SELECT 'COMMERCIAL_AUTHORIZATION', a.authorization_id, a.created_at FROM kauro.commercial_authorizations a
        WHERE a.plan_id = $1 AND a.state <> 'REVOKED'
       ORDER BY 1, 3, 2`,
      [planId],
    );
    return r.rows.map((x) => ({ kind: x.kind, referenceId: x.reference_id as Id }));
  }

  /** The live (non-revoked) commercial authorizations of the client's projects (ActiveWorkSummary.liveCommercialAuthorizations). */
  async liveAuthorizationsOfClient(clientId: ClientId): Promise<number> {
    const r = await execute<{ n: string }>(
      this.db,
      `SELECT count(*)::text AS n FROM kauro.commercial_authorizations a JOIN kauro.projects p ON p.agency_id = a.agency_id AND p.project_id = a.project_id
        WHERE p.client_id = $1 AND a.state <> 'REVOKED'`,
      [clientId],
    );
    return int(r.rows[0]?.n ?? "0");
  }
}
