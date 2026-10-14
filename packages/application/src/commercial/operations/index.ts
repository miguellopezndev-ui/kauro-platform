/**
 * The operations and recovery commands of packages B16/B18 on B06's pipeline: CMD056 RecordIncident and CMD057 AuthorizeRecovery,
 * assembled over B09's request runtime and the collaborators a deployment binds. The api composition registers every handler returned here.
 */
import type { CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import type { CommercialCommandHandler } from "../agency/runtime.js";
import type { AuthorizeRecoveryBody, OpenBreakglassBody, RecordIncidentBody, RevokeBreakglassBody } from "../contracts.js";
import type { CommercialReadHandler } from "../statements/get-statement.js";
import type { BreakglassGrantView, BreakglassPreviewView, BreakglassRevocationView, IncidentView, RecoveryAuthorizationView } from "../views.js";
import { authorizeRecoveryHandler } from "./authorize-recovery.js";
import { breakglassPreviewHandler } from "./breakglass-preview.js";
import { openBreakglassHandler } from "./open-breakglass.js";
import { revokeBreakglassHandler } from "./revoke-breakglass.js";
import { recordIncidentHandler } from "./record-incident.js";
import type { OperationsRequestCollaborators, OperationsServiceRuntime } from "./runtime.js";

export interface OperationsCommandHandlers {
  readonly CMD054: CommercialCommandHandler<OpenBreakglassBody, BreakglassGrantView>;
  readonly CMD055: CommercialCommandHandler<RevokeBreakglassBody, BreakglassRevocationView>;
  readonly CMD056: CommercialCommandHandler<RecordIncidentBody, IncidentView>;
  readonly CMD057: CommercialCommandHandler<AuthorizeRecoveryBody, RecoveryAuthorizationView>;
}

export function createOperationsCommandHandlers(runtime: CommerceRequestRuntime, co: OperationsRequestCollaborators, service?: OperationsServiceRuntime): OperationsCommandHandlers {
  return Object.freeze({ CMD054: openBreakglassHandler(runtime, co), CMD055: revokeBreakglassHandler(runtime, co), CMD056: recordIncidentHandler(runtime, co, service), CMD057: authorizeRecoveryHandler(runtime, co) });
}

/** The breakglass preview read (package B16 lane L4): the grant's holder, under its grant's lock (GAP-BG-1). */
export function createOperationsReadHandlers(runtime: CommerceRequestRuntime, co: OperationsRequestCollaborators): { readonly PreviewTableUnderBreakglass: CommercialReadHandler<BreakglassPreviewView> } {
  return Object.freeze({ PreviewTableUnderBreakglass: breakglassPreviewHandler(runtime, co) });
}

export type { OperationsRequestCollaborators, OperationsServiceRuntime, OperationsServiceHold, OperationsServiceUnits } from "./runtime.js";
export { recordIncidentHandler, incidentView } from "./record-incident.js";
export { authorizeRecoveryHandler } from "./authorize-recovery.js";
export { openBreakglassHandler, breakglassGrantView } from "./open-breakglass.js";
export { revokeBreakglassHandler } from "./revoke-breakglass.js";
export { breakglassPreviewHandler } from "./breakglass-preview.js";
export { OPERATIONS_SERVICE_ACCESS, RECORD_INCIDENT_OUTCOMES, AUTHORIZE_RECOVERY_OUTCOMES, OPEN_BREAKGLASS_OUTCOMES, REVOKE_BREAKGLASS_OUTCOMES, BREAKGLASS_PREVIEW_OUTCOMES } from "./outcomes.js";
