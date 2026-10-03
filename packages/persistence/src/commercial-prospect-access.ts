/**
 * The one read CMD047 needs beyond the sales and attribution adapters (mandate B10-COMMANDS-PROSPECTS; design §5 "Attribution",
 * decision D10-ATTR-1): whether a payment order of the agency exists from before a claim was submitted — "a claim must be submitted
 * before the first paid order" (17). Read on the unit of work's own connection after the owner adopted the agency's finance scope, so
 * the order table's policies admit it; the comparison is made in SQL between the two stored instants, never against a rounded copy.
 */
import { DomainFailure, type AgencyId, type AttributionClaimId, type UnitOfWork } from "@kauro/domain";
import { execute, type Queryable } from "./sql.js";
import { PgCommerceUnitOfWork } from "./unit-of-work.js";

/** True when the agency has a payment order created strictly before the claim's submission instant. */
export async function agencyOrderPrecedesClaim(uow: UnitOfWork, agencyId: AgencyId, claimId: AttributionClaimId): Promise<boolean> {
  if (!(uow instanceof PgCommerceUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the agency's orders are read in a commerce unit of work of @kauro/persistence");
  const db = (uow as unknown as { readonly client: Queryable }).client;
  const r = await execute<{ preceded: boolean }>(
    db,
    `SELECT EXISTS (
       SELECT 1 FROM kauro.payment_orders po
        WHERE po.agency_id = $1 AND po.created_at < (SELECT c.submitted_at FROM kauro.attribution_claims c WHERE c.claim_id = $2)) AS preceded`,
    [agencyId, claimId],
  );
  return r.rows[0]?.preceded === true;
}
