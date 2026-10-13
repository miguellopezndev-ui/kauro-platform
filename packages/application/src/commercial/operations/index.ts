/**
 * The operations and recovery commands of packages B16/B18 on B06's pipeline: CMD056 RecordIncident and CMD057 AuthorizeRecovery,
 * assembled over B09's request runtime and the collaborators a deployment binds. The api composition registers every handler returned here.
 */
import type { CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import type { CommercialCommandHandler } from "../agency/runtime.js";
import type { AuthorizeRecoveryBody, RecordIncidentBody } from "../contracts.js";
import type { IncidentView, RecoveryAuthorizationView } from "../views.js";
import { authorizeRecoveryHandler } from "./authorize-recovery.js";
import { recordIncidentHandler } from "./record-incident.js";
import type { OperationsRequestCollaborators, OperationsServiceRuntime } from "./runtime.js";

export interface OperationsCommandHandlers {
  readonly CMD056: CommercialCommandHandler<RecordIncidentBody, IncidentView>;
  readonly CMD057: CommercialCommandHandler<AuthorizeRecoveryBody, RecoveryAuthorizationView>;
}

export function createOperationsCommandHandlers(runtime: CommerceRequestRuntime, co: OperationsRequestCollaborators, service?: OperationsServiceRuntime): OperationsCommandHandlers {
  return Object.freeze({ CMD056: recordIncidentHandler(runtime, co, service), CMD057: authorizeRecoveryHandler(runtime, co) });
}

export type { OperationsRequestCollaborators, OperationsServiceRuntime, OperationsServiceHold, OperationsServiceUnits } from "./runtime.js";
export { recordIncidentHandler, incidentView } from "./record-incident.js";
export { authorizeRecoveryHandler } from "./authorize-recovery.js";
export { OPERATIONS_SERVICE_ACCESS, RECORD_INCIDENT_OUTCOMES, AUTHORIZE_RECOVERY_OUTCOMES } from "./outcomes.js";
