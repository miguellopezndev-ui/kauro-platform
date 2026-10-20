// UI32 Settings as data (registry: "Manage agency details and safe branding."). The display label, the legal identity and the closure are
// separate things: closure (CMD043) is the only command here, needs a fresh step-up proof, and is offered only when the server lists
// REQUEST_DELETION and the agency is not already closing. Nothing here compares a clock; the server judges the proof.
import type { AgencyClosureView, AgencyView } from "../../api/generated.ts";
import type { ApiClient } from "../../client/api-client.ts";
import type { IdentityCredential } from "../../client/identity/port.ts";
import type { OperationRunner, RunOutcome } from "../../client/operation-runner.ts";
import { runWithStepUp, type StepUpProof, type StepUpResult } from "../shared/step-up.tsx";

export interface SettingsModel {
  readonly canClose: boolean;
  /** Closure was already requested: the page says so and offers nothing. */
  readonly closing: boolean;
  /** The member is not allowed to close: the page says it is for an owner. */
  readonly mustAskOwner: boolean;
}

export function settingsModel(agency: AgencyView): SettingsModel {
  const closing = agency.state === "CLOSING" || agency.state === "CLOSED";
  // CMD043 is the owner's alone (B06 D-AUTHZ-1). An admin also holds REQUEST_DELETION (for a project's deletion), so the closure is
  // offered only where the server also lists MANAGE_AGENCY, which only an owner holds (Order 11 D-02: an admin saw a button that always
  // failed with ROLE_INSUFFICIENT). The server still decides; this only stops offering what it will refuse.
  const permitted = agency.permittedActions.includes("REQUEST_DELETION") && agency.permittedActions.includes("MANAGE_AGENCY");
  return { canClose: permitted && !closing, closing, mustAskOwner: !permitted && !closing };
}

/** CMD043 under the key derived from the agency and its version: a double activation, a lost answer and a reload replay it. The proof is read once and reused by same-key retries. */
export function closeAgency(client: ApiClient, runner: OperationRunner, agency: AgencyView, proof: StepUpProof): Promise<RunOutcome<AgencyClosureView>> {
  const assuranceProofRef = proof.take();
  return runner.run<AgencyClosureView>({
    command: "CMD043",
    subject: { kind: "SUBJECT", subjectId: agency.agencyId, subjectVersion: agency.version },
    send: (key) => client.call("CloseAgency", { path: { agencyId: agency.agencyId }, body: { expectedVersion: agency.version, assuranceProofRef }, idempotencyKey: key }),
  });
}

/** The closure with a fresh step-up: no proof, no request. An expired or refused proof is the STEP_UP state and leaves the page as it was. */
export function closeWithStepUp(client: ApiClient, runner: OperationRunner, agency: AgencyView, obtain: () => Promise<IdentityCredential | null>): Promise<StepUpResult<RunOutcome<AgencyClosureView>>> {
  return runWithStepUp({ client, obtain, command: (proof) => closeAgency(client, runner, agency, proof) });
}
