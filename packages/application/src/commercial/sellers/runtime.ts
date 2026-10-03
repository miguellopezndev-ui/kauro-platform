/**
 * What the seller commands' handlers run on (package B10, mandate B10-COMMANDS-SELLERS): B09's request runtime — the one pipeline of B06
 * (authenticate → access decision → journal → execute) over the commerce unit of work, whose runner `runCommerceCommand` is reused as it
 * is — and the collaborators a deployment binds. The sales and attribution records are reached through accessors over the unit of work
 * (B09's purchasedSubjectsOf pattern; the persistence adapters' `salesOf` and `attributionOf`), so no shared factory is edited. The
 * corporate owner's access is the CommercialAuthorizer's (design §2, D10-CTX-1); CMD049's fresh step-up is B06's AssuranceVerifier.
 */
import type { AttributionRepository, SalesRepository, UnitOfWork } from "@kauro/domain";
import type { AssuranceVerifier } from "../../ports/assurance-and-admission.js";
import type { CommercialAuthorizer } from "../authorizer.js";

export interface SellerCommandCollaborators {
  /** The sales records of a unit of work (@kauro/persistence salesOf): sellers, agreements, service assignments, accounts, terminations. */
  readonly sales: (uow: UnitOfWork) => SalesRepository;
  /** The attribution records of a unit of work (@kauro/persistence attributionOf): claims and entitlements. */
  readonly attribution: (uow: UnitOfWork) => AttributionRepository;
  /** The corporate owner's access decision (createCommercialAuthorizer over the seller row and the grant). */
  readonly authorizer: CommercialAuthorizer;
  /** B06's step-up verifier (08 "High-impact actions require recent step-up"; D-ASSUR-1): CMD049. */
  readonly assurance: AssuranceVerifier;
}
