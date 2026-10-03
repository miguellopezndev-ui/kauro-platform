/**
 * The agency lifecycle of package B10 on B06's pipeline (mandate B10-AGENCY-LIFECYCLE; design §4, §8.1, §13): CMD002 ActivateAgency and
 * CMD043 CloseAgency, assembled over B09's request runtime and the three collaborators a deployment binds (agency lifecycle records,
 * B06's ActiveWorkInspector and step-up verifier). The api composition registers every handler returned here; the stage-2 integrator
 * merges them with those of the other command lanes.
 */
import type { CloseAgencyBody, ActivateAgencyBody } from "../contracts.js";
import type { AgencyActivationView, AgencyClosureView } from "../views.js";
import type { CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { activateAgencyHandler } from "./activate-agency.js";
import { closeAgencyHandler } from "./close-agency.js";
import type { AgencyLifecycleCollaborators, CommercialCommandHandler } from "./runtime.js";

export interface AgencyLifecycleHandlers {
  readonly CMD002: CommercialCommandHandler<ActivateAgencyBody, AgencyActivationView>;
  readonly CMD043: CommercialCommandHandler<CloseAgencyBody, AgencyClosureView>;
}

export function createAgencyLifecycleHandlers(runtime: CommerceRequestRuntime, co: AgencyLifecycleCollaborators): AgencyLifecycleHandlers {
  return Object.freeze({ CMD002: activateAgencyHandler(runtime, co), CMD043: closeAgencyHandler(runtime, co) });
}

export type { AgencyLifecycleCollaborators, CommercialCommandHandler } from "./runtime.js";
export { commercialAdmissionSpecOf } from "./runtime.js";
export { activateAgencyHandler } from "./activate-agency.js";
export { closeAgencyHandler, CLOSURE_DELETION_DELAY_HOURS } from "./close-agency.js";
