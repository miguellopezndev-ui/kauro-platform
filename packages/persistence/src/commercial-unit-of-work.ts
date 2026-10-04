/**
 * The commercial unit of work of package B10 (@kauro/domain CommercialUnitOfWork; docs/design/B10-commercial-domain.md §11; D10-CTX-1):
 * B09's commerce unit of work (through B08's audit unit of work, D10-SYNC-2) — the same transaction on the same connection, context binding, publisher, journal and security
 * events — with the recurrence and founding repositories on that connection and the adoption of the agency of a durable work item
 * (`adoptAgency`, the commission and finance services only). Its factory routes the commission and finance services to the verified
 * kauro_commission pool beside B09's groups.
 *
 * The other stage-2 lanes (agency lifecycle, sales and attribution, the commission ledger and statements) reach their repositories
 * through accessors over this unit of work the way recurrenceOf and foundingOf do, so they never edit the factory; the stage-2
 * integrator binds them into `commercial` (D10-STAGE-1).
 */
import {
  DomainFailure,
  isUuidV7,
  registryPricePolicy,
  type AgencyId,
  type Clock,
  type ExecutionContext,
  type PricePolicy,
  type UnitOfWork,
  type UnitOfWorkOptions,
} from "@kauro/domain";
import type { PoolClient } from "pg";
import { PgFoundingRepository } from "./repositories/commercial-founding.js";
import { PgRecurrenceRepository } from "./repositories/commercial-recurrence.js";
import {
  PgAuditUnitOfWork,
  PgAuditUnitOfWorkFactory,
  isCommissionServiceContext,
  type CommercePools,
  type TrackingIdGenerator,
  type UnitOfWorkDependencies,
} from "./unit-of-work.js";

/** The dependencies of a commercial unit-of-work factory: B06's and, for CMD027's pricing, the price policies it may quote under. */
export interface CommercialDependencies extends UnitOfWorkDependencies {
  /** The price policies the issuance core prices under, by version; defaults to the registry's. Each needs its row in price_policies. */
  readonly pricePolicies?: ReadonlyArray<PricePolicy>;
}

// D10-SYNC-2: the commercial unit of work extends B08's audit unit of work (itself the execution unit of work over B09's commerce unit
// of work), so the api's one routed request factory serves the commercial, execution and audit stores on the same connection.
export class PgCommercialUnitOfWork extends PgAuditUnitOfWork {
  readonly recurrence: PgRecurrenceRepository;
  readonly founding: PgFoundingRepository;

  constructor(client: PoolClient, context: ExecutionContext, ids: TrackingIdGenerator, clock: Clock, pricePolicies: ReadonlyArray<PricePolicy>) {
    super(client, context, ids, clock);
    this.founding = new PgFoundingRepository(client);
    this.recurrence = new PgRecurrenceRepository(
      { db: client, ids, clock, events: this.events, provenance: () => this.provenance() },
      this.commerce.quotes,
      this.founding,
      new Map(pricePolicies.map((p) => [p.version, p])),
    );
  }

  /**
   * SERVICE contexts of the commission and finance services only, at most once and never beside adoptScope: binds the agency of a
   * durable work item (an event's agency, a reservation's), so the agency-scoped rows of that agency pass their policies (D10-CTX-1).
   * Never an agency a request names. Any other use is INTEGRITY_FAILURE.
   */
  async adoptAgency(agencyId: AgencyId): Promise<void> {
    if (!isCommissionServiceContext(this.context)) throw new DomainFailure("INTEGRITY_FAILURE", "only the commission or finance service adopts the agency of a work item");
    if (!isUuidV7(agencyId)) throw new DomainFailure("INTEGRITY_FAILURE", "an adopted agency is an agency id (UUIDv7)");
    await this.bindServiceAgency(agencyId);
  }
}

export class PgCommercialUnitOfWorkFactory extends PgAuditUnitOfWorkFactory {
  readonly #pricePolicies: ReadonlyArray<PricePolicy>;

  constructor(pools: CommercePools, deps: CommercialDependencies) {
    super(pools, deps);
    this.#pricePolicies = deps.pricePolicies ?? [registryPricePolicy()];
  }

  protected override createUnitOfWork(client: PoolClient, context: ExecutionContext, ids: TrackingIdGenerator, clock: Clock): PgCommercialUnitOfWork {
    return new PgCommercialUnitOfWork(client, context, ids, clock, this.#pricePolicies);
  }

  override run<T>(context: ExecutionContext, work: (uow: PgCommercialUnitOfWork) => Promise<T>, options?: UnitOfWorkOptions): Promise<T> {
    return super.run(context, (uow) => work(uow as PgCommercialUnitOfWork), options);
  }
}

export function createCommercialUnitOfWorkFactory(pools: CommercePools, deps: CommercialDependencies): PgCommercialUnitOfWorkFactory {
  return new PgCommercialUnitOfWorkFactory(pools, deps);
}

/** The recurrence repository of a commercial unit of work of this package (D10-CTX-1: the other lanes' accessors are of this form). */
export function recurrenceOf(uow: UnitOfWork): PgRecurrenceRepository {
  if (!(uow instanceof PgCommercialUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the recurrence repository needs a commercial unit of work of @kauro/persistence");
  return uow.recurrence;
}

/** The founding cohort's repository of a commercial unit of work of this package. */
export function foundingOf(uow: UnitOfWork): PgFoundingRepository {
  if (!(uow instanceof PgCommercialUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the founding repository needs a commercial unit of work of @kauro/persistence");
  return uow.founding;
}
