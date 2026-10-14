/**
 * The accessor of package B12's send records over a unit of work of this package (lane L-SEND; the pattern of outreach-drafts-access.ts):
 * one PgOutreachSend per unit of work, on the unit's own connection and transaction, so every advisory subject it takes is released by
 * that unit's COMMIT or ROLLBACK. Ids come from the unit's own generator. A foreign unit of work is refused, never given a connection.
 */
import { DomainFailure, type UnitOfWork } from "@kauro/domain";
import { PgOutreachSend } from "./repositories/commercial-outreach-send.js";
import type { Queryable } from "./sql.js";
import { PgCommerceUnitOfWork } from "./unit-of-work.js";

const bound = new WeakMap<PgCommerceUnitOfWork, PgOutreachSend>();

export function outreachSendOf(uow: UnitOfWork): PgOutreachSend {
  if (!(uow instanceof PgCommerceUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the outreach sends are read in a commerce unit of work of @kauro/persistence");
  let sends = bound.get(uow);
  if (sends === undefined) {
    sends = new PgOutreachSend((uow as unknown as { readonly client: Queryable }).client, () => uow.ids.next());
    bound.set(uow, sends);
  }
  return sends;
}
