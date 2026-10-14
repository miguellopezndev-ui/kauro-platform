/** The accessor of the L-AUTH adapter over a commerce unit of work (the operationsOf pattern): one instance, one OutreachLocks, per unit of work. */
import { DomainFailure, type UnitOfWork } from "@kauro/domain";
import { PgOutreachAuth } from "./repositories/commercial-outreach-auth.js";
import type { Queryable } from "./sql.js";
import { PgCommerceUnitOfWork } from "./unit-of-work.js";

const bound = new WeakMap<PgCommerceUnitOfWork, PgOutreachAuth>();

export function outreachAuthOf(uow: UnitOfWork): PgOutreachAuth {
  if (!(uow instanceof PgCommerceUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the outreach authorizations are read in a commerce unit of work of @kauro/persistence");
  let adapter = bound.get(uow);
  if (adapter === undefined) {
    adapter = new PgOutreachAuth((uow as unknown as { readonly client: Queryable }).client);
    bound.set(uow, adapter);
  }
  return adapter;
}
