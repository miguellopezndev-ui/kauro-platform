/**
 * The accessors of B10's sales and attribution adapters over a unit of work of this package (mandate B10-ADAPTERS-SALES; design
 * §11; decision D10-STAGE-1): salesOf(uow), attributionOf(uow) and commercialPrincipalsOf(uow) answer the adapters on the unit of
 * work's own connection and transaction — B09's purchasedSubjectsOf pattern — so no stage-2 lane edits the shared factory. The
 * stage-2 integrator binds the same accessors into the commercial unit of work (CommercialUnitOfWork.commercial.sales and
 * .attribution), which is why they answer one adapter per unit of work: every call on a unit of work sees the same instance.
 *
 * The api binds @kauro/application's CommercialPrincipalReader to commercialPrincipalsOf(uow).sellerOf and .ownerGrantOf.
 */
import { DomainFailure, type UnitOfWork } from "@kauro/domain";
import { PgAttributionRepository } from "./repositories/commercial-attribution.js";
import { PgCommercialPrincipalReader, PgSalesRepository } from "./repositories/commercial-sales.js";
import type { Queryable } from "./sql.js";
import { PgCommerceUnitOfWork } from "./unit-of-work.js";

interface SalesAdapters {
  readonly sales: PgSalesRepository;
  readonly attribution: PgAttributionRepository;
  readonly principals: PgCommercialPrincipalReader;
}

const bound = new WeakMap<PgCommerceUnitOfWork, SalesAdapters>();

/**
 * The adapters of a commerce unit of work of this package (the commercial unit of work extends it), created once on its connection.
 * The connection is the unit of work's own (PgUnitOfWork keeps it protected; this module reads it for a unit of work it has checked
 * is this package's, so a foreign unit of work is refused, never given a connection).
 */
function adaptersOf(uow: UnitOfWork, what: string): SalesAdapters {
  if (!(uow instanceof PgCommerceUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", `${what} are read in a commerce unit of work of @kauro/persistence`);
  let adapters = bound.get(uow);
  if (adapters === undefined) {
    const db = (uow as unknown as { readonly client: Queryable }).client;
    adapters = { sales: new PgSalesRepository(db, uow.ids), attribution: new PgAttributionRepository(db), principals: new PgCommercialPrincipalReader(db, uow.ids) };
    bound.set(uow, adapters);
  }
  return adapters;
}

/** The sales records of a unit of work (@kauro/domain SalesRepository): sellers, prospects, accounts, assistance, termination. */
export function salesOf(uow: UnitOfWork): PgSalesRepository {
  return adaptersOf(uow, "the sales records").sales;
}

/** The attribution records of a unit of work (@kauro/domain AttributionRepository): claims, allocations, entitlements. */
export function attributionOf(uow: UnitOfWork): PgAttributionRepository {
  return adaptersOf(uow, "the attribution records").attribution;
}

/** The seller row and the corporate grant of an identity, read after their transition locks (CommercialPrincipalReader). */
export function commercialPrincipalsOf(uow: UnitOfWork): PgCommercialPrincipalReader {
  return adaptersOf(uow, "the commercial principals").principals;
}
