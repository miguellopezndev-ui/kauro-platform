/**
 * The accessors of B10's commission ledger and statement adapters over a unit of work of this package (mandate B10-ADAPTERS-LEDGER;
 * design §11; decision D10-STAGE-1): ledgerOf(uow) and statementsOf(uow) answer the adapters on the unit of work's own connection and
 * transaction — B09's purchasedSubjectsOf pattern, as salesOf and attributionOf do — so no stage-2 lane edits the shared factory. The
 * stage-2 integrator binds the same accessors into the commercial unit of work (CommercialUnitOfWork.commercial.ledger and .statements),
 * which is why they answer one adapter per unit of work: every call on a unit of work sees the same instance.
 */
import { DomainFailure, type UnitOfWork } from "@kauro/domain";
import { PgCommissionLedgerRepository } from "./repositories/commercial-ledger.js";
import { PgStatementRepository } from "./repositories/commercial-statements.js";
import type { Queryable } from "./sql.js";
import { PgCommerceUnitOfWork } from "./unit-of-work.js";

interface LedgerAdapters {
  readonly ledger: PgCommissionLedgerRepository;
  readonly statements: PgStatementRepository;
}

const bound = new WeakMap<PgCommerceUnitOfWork, LedgerAdapters>();

/**
 * The adapters of a commerce unit of work of this package (the commercial unit of work extends it), created once on its connection.
 * The connection is the unit of work's own (PgUnitOfWork keeps it protected; this module reads it for a unit of work it has checked
 * is this package's, so a foreign unit of work is refused, never given a connection).
 */
function adaptersOf(uow: UnitOfWork, what: string): LedgerAdapters {
  if (!(uow instanceof PgCommerceUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", `${what} are read in a commerce unit of work of @kauro/persistence`);
  let adapters = bound.get(uow);
  if (adapters === undefined) {
    const db = (uow as unknown as { readonly client: Queryable }).client;
    adapters = { ledger: new PgCommissionLedgerRepository(db, uow.ids), statements: new PgStatementRepository(db) };
    bound.set(uow, adapters);
  }
  return adapters;
}

/** The commission ledger of a unit of work (@kauro/domain CommissionLedgerRepository): completions, pools, lines, adjustments, holds, offsets. */
export function ledgerOf(uow: UnitOfWork): PgCommissionLedgerRepository {
  return adaptersOf(uow, "the commission ledger").ledger;
}

/** The calendars, periods, statements and payouts of a unit of work (@kauro/domain StatementRepository). */
export function statementsOf(uow: UnitOfWork): PgStatementRepository {
  return adaptersOf(uow, "the commission statements").statements;
}
