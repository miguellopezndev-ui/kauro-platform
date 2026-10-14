/**
 * What the operations and recovery commands run on (package B16/B18; decision B18-OPS-1).
 *
 * CMD056 RecordIncident (owner or operations service) and CMD057 AuthorizeRecovery (owner, fresh step-up) are request handlers over B09's
 * request runtime; the operations records reach the unit of work through the accessor operationsOf (@kauro/persistence). The operations
 * service's route (CMD056 and CMD059 as the service) runs in a SERVICE unit of work of the commission group's factory, as the verified
 * service identity, journaled under it with no agency (migration 0059).
 */
import type { UtcInstant } from "@kauro/contracts";
import type { BreakglassRepository, Clock, CommerceUnitOfWork, Environment, ExecutionContext, OperationsRepository, UnitOfWork } from "@kauro/domain";
import type { AssuranceVerifier } from "../../ports/assurance-and-admission.js";
import type { B07Collaborators } from "../../sources/handlers/shared.js";
import type { CommercialAuthorizer } from "../authorizer.js";

/** CMD056 and CMD057: the owner's request side (kauro_app). */
export interface OperationsRequestCollaborators {
  readonly operations: (uow: UnitOfWork) => OperationsRepository;
  readonly authorizer: CommercialAuthorizer;
  /** B06's step-up verifier (08): CMD057's authorizationRef, CMD054's assuranceProofRef. */
  readonly assurance: AssuranceVerifier;
  /** The breakglass records (package B16 lane L4) on the unit of work's own transaction: breakglassOf (@kauro/persistence). */
  readonly breakglass: (uow: UnitOfWork) => BreakglassRepository;
  /** B07's object-storage adapter and preview reader, for the breakglass preview; absent or unbound, it answers SOURCE_SERVICES_UNAVAILABLE. */
  readonly sources?: Pick<B07Collaborators, "providers" | "preview">;
}

/** Where an operations service command is held by a test, inside its unit of work before COMMIT (only tests bind it). */
export type OperationsServiceHold = (command: "CMD056" | "CMD059", point: "BEFORE_COMMIT") => Promise<void>;

/** The unit-of-work factory of the commission group (decision B18-OPS-1: the operations service is a member of that group's role). */
export interface OperationsServiceUnits {
  run<T>(context: ExecutionContext, work: (uow: CommerceUnitOfWork) => Promise<T>): Promise<T>;
}

/** CMD056 and CMD059 as the operations service. */
export interface OperationsServiceRuntime {
  readonly units: OperationsServiceUnits;
  readonly environment: Environment;
  readonly clock: Clock;
  readonly authorizer: CommercialAuthorizer;
  /** The server's instant of the unit of work (kauro.server_now()). */
  readonly serverNow: (uow: UnitOfWork) => Promise<UtcInstant>;
  readonly operations: (uow: UnitOfWork) => OperationsRepository;
  readonly hold?: OperationsServiceHold;
}
