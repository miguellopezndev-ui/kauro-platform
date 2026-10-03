/**
 * The prospect, claim and attribution commands of package B10 on B06's pipeline (mandate B10-COMMANDS-PROSPECTS; design §5, §8, §12):
 * CMD045 RegisterProspect, CMD046 ClaimProspect and CMD047 AcceptAttribution, assembled over B09's request runtime and the collaborators
 * a deployment binds (the commercial authorizer, the sales and attribution accessors, the buyer type reader and the first-order read).
 * The api composition registers every handler returned here beside those of the other command lanes.
 */
import type { AcceptAttributionBody, ClaimProspectBody, RegisterProspectBody } from "../contracts.js";
import type { AttributionClaimView, AttributionView, ProspectView } from "../views.js";
import type { CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import type { CommercialCommandHandler } from "../agency/runtime.js";
import { acceptAttributionHandler } from "./accept-attribution.js";
import { claimProspectHandler } from "./claim-prospect.js";
import { registerProspectHandler } from "./register-prospect.js";
import type { ProspectCollaborators } from "./runtime.js";

export interface ProspectHandlers {
  readonly CMD045: CommercialCommandHandler<RegisterProspectBody, ProspectView>;
  readonly CMD046: CommercialCommandHandler<ClaimProspectBody, AttributionClaimView>;
  readonly CMD047: CommercialCommandHandler<AcceptAttributionBody, AttributionView>;
}

export function createProspectHandlers(runtime: CommerceRequestRuntime, co: ProspectCollaborators): ProspectHandlers {
  return Object.freeze({ CMD045: registerProspectHandler(runtime, co), CMD046: claimProspectHandler(runtime, co), CMD047: acceptAttributionHandler(runtime, co) });
}

export type { ProspectCollaborators } from "./runtime.js";
export { registerProspectHandler } from "./register-prospect.js";
export { claimProspectHandler, CLAIM_CONFLICT_REASONS } from "./claim-prospect.js";
export { acceptAttributionHandler, ALLOCATION_TOTAL_BPS } from "./accept-attribution.js";
