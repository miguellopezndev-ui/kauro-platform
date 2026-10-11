/**
 * The capability commands of package B18 on B06's pipeline: CMD058 ChangeCapability and CMD059 RestrictCapability, assembled over B09's
 * request runtime and the collaborators a deployment binds. The api composition registers every handler returned here.
 */
import type { ChangeCapabilityBody, RestrictCapabilityBody } from "../contracts.js";
import type { CapabilityRestrictionView, CapabilityVersionView } from "../views.js";
import type { CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import type { CommercialCommandHandler } from "../agency/runtime.js";
import { changeCapabilityHandler } from "./change-capability.js";
import { restrictCapabilityHandler } from "./restrict-capability.js";
import type { CapabilityCommandCollaborators } from "./runtime.js";

export interface CapabilityCommandHandlers {
  readonly CMD058: CommercialCommandHandler<ChangeCapabilityBody, CapabilityVersionView>;
  readonly CMD059: CommercialCommandHandler<RestrictCapabilityBody, CapabilityRestrictionView>;
}

export function createCapabilityCommandHandlers(runtime: CommerceRequestRuntime, co: CapabilityCommandCollaborators): CapabilityCommandHandlers {
  return Object.freeze({ CMD058: changeCapabilityHandler(runtime, co), CMD059: restrictCapabilityHandler(runtime, co) });
}

export type { CapabilityCommandCollaborators } from "./runtime.js";
export { changeCapabilityHandler } from "./change-capability.js";
export { restrictCapabilityHandler } from "./restrict-capability.js";
export { CHANGE_CAPABILITY_OUTCOMES, RESTRICT_CAPABILITY_OUTCOMES } from "./outcomes.js";
