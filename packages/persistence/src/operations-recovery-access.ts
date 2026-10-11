/**
 * The accessor of the operations and recovery adapter over a unit of work of this package (the B10 accessor pattern: agencyLifecycleOf):
 * operationsOf(uow) answers the adapter on the unit of work's own connection and transaction, one instance per unit of work. The owner's
 * request units and the operations service's SERVICE units are both PgCommerceUnitOfWork; the policies of 0057 decide what each may write.
 */
import { DomainFailure, type UnitOfWork } from "@kauro/domain";
import { PgOperationsRepository } from "./repositories/operations-recovery.js";
import type { Queryable } from "./sql.js";
import { PgCommerceUnitOfWork } from "./unit-of-work.js";

const bound = new WeakMap<PgCommerceUnitOfWork, PgOperationsRepository>();

export function operationsOf(uow: UnitOfWork): PgOperationsRepository {
  if (!(uow instanceof PgCommerceUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the operations records are read in a commerce unit of work of @kauro/persistence");
  let adapter = bound.get(uow);
  if (adapter === undefined) {
    adapter = new PgOperationsRepository((uow as unknown as { readonly client: Queryable }).client);
    bound.set(uow, adapter);
  }
  return adapter;
}
