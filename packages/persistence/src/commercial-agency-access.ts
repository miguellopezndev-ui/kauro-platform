/**
 * The accessor of B10's agency lifecycle adapter over a unit of work of this package (mandate B10-AGENCY-LIFECYCLE; design §11; decision
 * D10-STAGE-1): agencyLifecycleOf(uow) answers the adapter on the unit of work's own connection and transaction — B09's
 * purchasedSubjectsOf pattern — so no stage-2 lane edits the shared factory. The stage-2 integrator binds the same accessor into the
 * commercial unit of work (CommercialUnitOfWork.commercial.agencyLifecycle), which is why every call on one unit of work answers the
 * same instance.
 */
import { DomainFailure, type UnitOfWork } from "@kauro/domain";
import { PgAgencyLifecycleRepository } from "./repositories/commercial-agency-lifecycle.js";
import type { Queryable } from "./sql.js";
import { PgCommerceUnitOfWork } from "./unit-of-work.js";

const bound = new WeakMap<PgCommerceUnitOfWork, PgAgencyLifecycleRepository>();

/**
 * The agency lifecycle records of a commerce unit of work of this package (the commercial unit of work extends it), created once on its
 * connection. A foreign unit of work is refused, never given a connection.
 */
export function agencyLifecycleOf(uow: UnitOfWork): PgAgencyLifecycleRepository {
  if (!(uow instanceof PgCommerceUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the agency lifecycle records are read in a commerce unit of work of @kauro/persistence");
  let adapter = bound.get(uow);
  if (adapter === undefined) {
    adapter = new PgAgencyLifecycleRepository((uow as unknown as { readonly client: Queryable }).client, uow.ids);
    bound.set(uow, adapter);
  }
  return adapter;
}
