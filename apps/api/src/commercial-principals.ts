/**
 * The CommercialPrincipalReader of the deployment (package B10, design §2, D10-CTX-1): the seller row and the corporate KAURO_OWNER grant
 * of an identity, each read by the persistence adapter inside the decision's own unit of work after its transition lock. A thin binding:
 * the adapter (commercialPrincipalsOf) is per unit of work, the port takes the unit of work of the decision.
 */
import type { CommercialPrincipalReader } from "@kauro/application";
import { commercialPrincipalsOf } from "@kauro/persistence";

export const commercialPrincipalReader: CommercialPrincipalReader = {
  binding: "PLATFORM",
  sellerOf: (uow, userId) => commercialPrincipalsOf(uow).sellerOf(userId),
  ownerGrantOf: (uow, userId) => commercialPrincipalsOf(uow).ownerGrantOf(userId),
};
