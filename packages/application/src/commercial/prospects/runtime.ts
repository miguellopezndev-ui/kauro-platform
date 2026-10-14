/**
 * What the prospect, claim and attribution handlers run on (package B10, mandate B10-COMMANDS-PROSPECTS): B09's request runtime — the one
 * pipeline of B06 (authenticate → access decision → journal → execute) over the commerce unit of work, in the caller's OPERATOR context —
 * and the collaborators a deployment binds. The sales and attribution records are reached through accessors over the unit of work
 * (B09's purchasedSubjectsOf pattern; @kauro/persistence salesOf and attributionOf), so no shared factory is edited.
 */
import type { AgencyId, AttributionClaimId, AttributionRepository, CommerceUnitOfWork, SalesRepository, UnitOfWork } from "@kauro/domain";
import type { CommercialAuthorizer } from "../authorizer.js";

export interface ProspectCollaborators {
  /** The seller and corporate-owner access decisions (createCommercialAuthorizer over the principals the persistence package reads). */
  readonly authorizer: CommercialAuthorizer;
  /** The sales records of a unit of work (@kauro/persistence salesOf). */
  readonly sales: (uow: UnitOfWork) => SalesRepository;
  /** The attribution records of a unit of work (@kauro/persistence attributionOf). */
  readonly attribution: (uow: UnitOfWork) => AttributionRepository;
  /**
   * Whether a payment order of the agency was created before the claim was submitted, read in the owner's unit of work after its finance
   * scope was adopted (@kauro/persistence agencyOrderPrecedesClaim).
   */
  readonly orderPrecedesClaim: (uow: CommerceUnitOfWork, agencyId: AgencyId, claimId: AttributionClaimId) => Promise<boolean>;
}
