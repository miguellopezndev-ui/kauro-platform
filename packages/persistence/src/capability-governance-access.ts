/**
 * The accessor of B18's capability governance adapter over a unit of work of this package (the B10 accessor pattern: agencyLifecycleOf):
 * capabilityGovernanceOf(uow) answers the adapter on the unit of work's own connection and transaction, one instance per unit of work.
 */
import { DomainFailure, type UnitOfWork } from "@kauro/domain";
import { PgCapabilityGovernanceRepository } from "./repositories/capability-governance.js";
import type { Queryable } from "./sql.js";
import { PgCommerceUnitOfWork } from "./unit-of-work.js";

const bound = new WeakMap<PgCommerceUnitOfWork, PgCapabilityGovernanceRepository>();

export function capabilityGovernanceOf(uow: UnitOfWork): PgCapabilityGovernanceRepository {
  if (!(uow instanceof PgCommerceUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the capability governance records are read in a commerce unit of work of @kauro/persistence");
  let adapter = bound.get(uow);
  if (adapter === undefined) {
    adapter = new PgCapabilityGovernanceRepository((uow as unknown as { readonly client: Queryable }).client);
    bound.set(uow, adapter);
  }
  return adapter;
}
