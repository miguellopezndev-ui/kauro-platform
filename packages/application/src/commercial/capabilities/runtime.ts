/**
 * What the capability commands' handlers run on (package B18): B09's request runtime (the one pipeline of B06 over the commerce unit of
 * work, `runCommerceCommand`) and the collaborators a deployment binds: the capability governance records of a unit of work (the
 * persistence adapter capabilityGovernanceOf) and the corporate owner's access decision (the CommercialAuthorizer).
 */
import type { CapabilityGovernanceRepository, UnitOfWork } from "@kauro/domain";
import type { CommercialAuthorizer } from "../authorizer.js";

export interface CapabilityCommandCollaborators {
  /** The capability governance records of a unit of work (@kauro/persistence capabilityGovernanceOf). */
  readonly governance: (uow: UnitOfWork) => CapabilityGovernanceRepository;
  /** The corporate owner's access decision (createCommercialAuthorizer over the grant). */
  readonly authorizer: CommercialAuthorizer;
}
