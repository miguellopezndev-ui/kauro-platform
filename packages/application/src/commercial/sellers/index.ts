/**
 * The seller commands of package B10 on B06's pipeline (mandate B10-COMMANDS-SELLERS; design §5, §8.2, §13): CMD048 AssignAccount, CMD049
 * ActivateSeller and CMD050 TerminateSeller, assembled over B09's request runtime and the collaborators a deployment binds (the sales and
 * attribution records, the commercial authorizer, B06's step-up verifier). The api composition registers every handler returned here; the
 * integrator merges them with those of the other command lanes.
 */
import type { AssignAccountBody, ActivateSellerBody, TerminateSellerBody } from "../contracts.js";
import type { SalesAccountView, SellerTerminationView, SellerView } from "../views.js";
import type { CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import type { CommercialCommandHandler } from "../agency/runtime.js";
import { activateSellerHandler } from "./activate-seller.js";
import { assignAccountHandler } from "./assign-account.js";
import type { SellerCommandCollaborators } from "./runtime.js";
import { terminateSellerHandler } from "./terminate-seller.js";

export interface SellerCommandHandlers {
  readonly CMD048: CommercialCommandHandler<AssignAccountBody, SalesAccountView>;
  readonly CMD049: CommercialCommandHandler<ActivateSellerBody, SellerView>;
  readonly CMD050: CommercialCommandHandler<TerminateSellerBody, SellerTerminationView>;
}

export function createSellerCommandHandlers(runtime: CommerceRequestRuntime, co: SellerCommandCollaborators): SellerCommandHandlers {
  return Object.freeze({ CMD048: assignAccountHandler(runtime, co), CMD049: activateSellerHandler(runtime, co), CMD050: terminateSellerHandler(runtime, co) });
}

export type { SellerCommandCollaborators } from "./runtime.js";
export { activateSellerHandler } from "./activate-seller.js";
export { assignAccountHandler } from "./assign-account.js";
export { terminateSellerHandler, TERMINATION_TAIL_HOURS } from "./terminate-seller.js";
export { ASSIGN_ACCOUNT_OUTCOMES, ACTIVATE_SELLER_OUTCOMES, TERMINATE_SELLER_OUTCOMES, CORPORATE_OWNER_ACCESS } from "./outcomes.js";
