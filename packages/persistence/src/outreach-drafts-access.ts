/**
 * The accessor of package B12's draft, content and resource records over a unit of work of this package (lane L-DRAFT; the pattern of
 * commercial-sales-access.ts): one PgOutreachDrafts per unit of work, on the unit's own connection and transaction, so every advisory
 * subject it takes is released by that unit's COMMIT or ROLLBACK. A foreign unit of work is refused, never given a connection.
 */
import { DomainFailure, type UnitOfWork } from "@kauro/domain";
import { PgOutreachDrafts } from "./repositories/commercial-outreach-drafts.js";
import type { Queryable } from "./sql.js";
import { PgCommerceUnitOfWork } from "./unit-of-work.js";

const bound = new WeakMap<PgCommerceUnitOfWork, PgOutreachDrafts>();

export function outreachDraftsOf(uow: UnitOfWork): PgOutreachDrafts {
  if (!(uow instanceof PgCommerceUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the outreach drafts are read in a commerce unit of work of @kauro/persistence");
  let drafts = bound.get(uow);
  if (drafts === undefined) {
    drafts = new PgOutreachDrafts((uow as unknown as { readonly client: Queryable }).client);
    bound.set(uow, drafts);
  }
  return drafts;
}
