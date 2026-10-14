/**
 * The accessor of the breakglass adapter over a unit of work of this package (the B10 accessor pattern: operationsOf): breakglassOf(uow)
 * answers the adapter on the unit of work's own connection and transaction, one instance per unit of work. Only the corporate owner's
 * request units (PgCommerceUnitOfWork, OPERATOR context) reach it; the policies of migration 0074 decide what each statement may read.
 */
import { DomainFailure, type UnitOfWork } from "@kauro/domain";
import { PgBreakglassRepository } from "./repositories/breakglass.js";
import type { Queryable } from "./sql.js";
import { PgCommerceUnitOfWork } from "./unit-of-work.js";

const bound = new WeakMap<PgCommerceUnitOfWork, PgBreakglassRepository>();

export function breakglassOf(uow: UnitOfWork): PgBreakglassRepository {
  if (!(uow instanceof PgCommerceUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the breakglass records are read in a commerce unit of work of @kauro/persistence");
  let adapter = bound.get(uow);
  if (adapter === undefined) {
    adapter = new PgBreakglassRepository((uow as unknown as { readonly client: Queryable }).client);
    bound.set(uow, adapter);
  }
  return adapter;
}
