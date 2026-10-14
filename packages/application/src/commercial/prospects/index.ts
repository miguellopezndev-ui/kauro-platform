/**
 * The prospect, claim and attribution commands of package B10 on B06's pipeline (mandate B10-COMMANDS-PROSPECTS; design §5, §8, §12):
 * CMD045 RegisterProspect, CMD046 ClaimProspect and CMD047 AcceptAttribution, assembled over B09's request runtime and the collaborators
 * a deployment binds (the commercial authorizer, the sales and attribution accessors, the buyer type reader and the first-order read).
 * The api composition registers every handler returned here beside those of the other command lanes.
 */
import type { AcceptAttributionBody, ClaimProspectBody, RecordProspectContactBody, RecordProspectSourceBody, RegisterProspectBody } from "../contracts.js";
import type { AttributionClaimView, AttributionView, ProspectContactView, ProspectSourceView, ProspectView } from "../views.js";
import type { CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import type { CommercialCommandHandler } from "../agency/runtime.js";
import { acceptAttributionHandler } from "./accept-attribution.js";
import { claimProspectHandler } from "./claim-prospect.js";
import { recordContactHandler } from "./record-contact.js";
import { recordSourceHandler } from "./record-source.js";
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
export { acceptAttributionHandler, ALLOCATION_TOTAL_BPS, DECISION_REASONS } from "./accept-attribution.js";

/** The two B12 prospect-intake commands (lane L-SOURCE), keyed by operation id; the api composition replaces their NOT_BUILT stubs with these. */
export interface ProspectIntakeHandlers {
  readonly RecordProspectSource: CommercialCommandHandler<RecordProspectSourceBody, ProspectSourceView>;
  readonly RecordProspectContact: CommercialCommandHandler<RecordProspectContactBody, ProspectContactView>;
}

export function createProspectIntakeHandlers(runtime: CommerceRequestRuntime, co: ProspectCollaborators): ProspectIntakeHandlers {
  return Object.freeze({ RecordProspectSource: recordSourceHandler(runtime, co), RecordProspectContact: recordContactHandler(runtime, co) });
}

export { recordSourceHandler } from "./record-source.js";
export { recordContactHandler } from "./record-contact.js";
export { contactKey } from "./contact-key.js";
