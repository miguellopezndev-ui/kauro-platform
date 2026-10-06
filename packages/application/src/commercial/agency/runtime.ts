/**
 * What the agency lifecycle's handlers run on (package B10, mandate B10-AGENCY-LIFECYCLE): B09's request runtime — the one pipeline of B06
 * (authenticate → access decision → journal → execute) over the commerce unit of work, whose runner `runCommerceCommand` is reused as it
 * is — and the three collaborators a deployment binds. The lifecycle records are reached through an accessor over the unit of work
 * (B09's purchasedSubjectsOf pattern; the persistence adapter's `agencyLifecycleOf`), so no shared factory is edited; B06's
 * ActiveWorkInspector and step-up verifier are the ports B06 already defines.
 */
import type { AgencyLifecycleRepository, UnitOfWork } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import type { AssuranceVerifier } from "../../ports/assurance-and-admission.js";
import type { CommandSpec } from "../../ports/command-handler.js";
import type { ActiveWorkInspector } from "../../ports/work-inspectors.js";
import type { CommercialCommandSpec } from "../contracts.js";
import type { ProviderCallTimer } from "../ports.js";

export interface AgencyLifecycleCollaborators {
  /** The agency lifecycle records of a unit of work (@kauro/persistence agencyLifecycleOf): agreements, acceptances, closures, decisions. */
  readonly lifecycle: (uow: UnitOfWork) => AgencyLifecycleRepository;
  /** B06's inspector of the work an agency retains (its open projects, active jobs and live authorizations, per client). */
  readonly activeWork: ActiveWorkInspector;
  /** The step-up verifier of CMD043 (08 "High-impact actions require recent step-up"; D-ASSUR-1). */
  readonly assurance: AssuranceVerifier;
  /** The bound of the inspector's call (PROVIDER_CALL_TIMEOUT_MS): realProviderCallTimer when absent; a fault cell binds a clock-driven one. */
  readonly providerTimer?: ProviderCallTimer;
}

/** A served B10 command: its catalogue spec, the spec the transport's admission reads, and its execution. */
export interface CommercialCommandHandler<Body, View> {
  readonly spec: CommercialCommandSpec<Body>;
  readonly admission: CommandSpec<Body>;
  execute(envelope: CommandEnvelope<Body>): Promise<CommandResult<View>>;
}

/**
 * The spec the transport's admission reads (admitStructure: path ids, the agency selector, the closed request schema): an agency
 * command whose path names the agency takes it from the path.
 */
export function commercialAdmissionSpecOf<Body>(spec: CommercialCommandSpec<Body>): CommandSpec<Body> {
  return Object.freeze({
    id: spec.id as unknown as CommandSpec<Body>["id"],
    name: spec.name,
    method: spec.method,
    path: spec.path,
    role: spec.role,
    scope: spec.scope === "AGENCY_PATH" ? "AGENCY_PATH" : spec.scope === "AGENCY_HEADER" ? "AGENCY_HEADER" : "NONE",
    aggregateParam: spec.aggregateParam,
    expectedVersionRequired: spec.expectedVersionRequired,
    stepUpRequired: spec.stepUp,
    authorityHashFields: spec.authorityHashFields,
    fields: spec.fields,
  } satisfies CommandSpec<Body>);
}
