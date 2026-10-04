/**
 * What every part of the commission service shares (docs/design/B10-commercial-domain.md §14; decisions D10-CTX-1, D10-CONS-1,
 * D10-BIND-1, D10-CLOCK-1; mandate B10-COMMISSION-SERVICE): the assembly of pools and ports, the deployment environment, the clock and
 * ids, the commission policy, the bound PreparationCompletionSource, the commission service's own identity for the work it starts
 * itself (each effect of the COMMISSIONS consumer and of the sweeps) and the sink of background failures.
 *
 * The clock is the dispatcher's only (lease and outbox claim instants, as B09's dispatcher reads them): every instant the ledger records
 * or compares is kauro.server_now(), read by each unit of work as `serverInstant()` (D10-CLOCK-1).
 */
import type { PreparationCompletionSource } from "@kauro/application";
import type { CausationId, Clock, CommissionPolicy, CorrelationId, Environment, IdGenerator, ServiceContext } from "@kauro/domain";
import { registryCommissionPolicy } from "@kauro/domain";
import { AuthorizationDeliveryCompletionSource, type PgCommercialUnitOfWork } from "@kauro/persistence";
import type { CommissionHold, CommissionServiceAssembly } from "./assembly.js";

/** The commission service's own identity (SERVICE_ROLE_TABLE: commission-service → COMMISSION_SERVICE; runs under kauro_commission). */
export const COMMISSION_SERVICE_ID = "commission-service";
/** The consumer of the commission service (COMMERCE_CONSUMERS; migration 0013's subscriptions and 0028's). */
export const COMMISSIONS_CONSUMER = "COMMISSIONS";
/**
 * How long a hold the commission service opens itself waits for its review (decision D10-SVC-3): a held provider completion
 * (PROVIDER_TIME_UNVERIFIED), held funds the provider gave no date for (FUNDS_HELD), an attribution under dispute. One week.
 */
export const HOLD_REVIEW_HOURS = 168;

export interface CommissionRuntime {
  readonly assembly: CommissionServiceAssembly;
  readonly environment: Environment;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly policy: CommissionPolicy;
  readonly completions: PreparationCompletionSource;
  readonly hold: CommissionHold | null;
  /** Receives a failure of work no request waits for (a consumer effect, a sweep item) by correlation id. */
  readonly onBackgroundFailure: (correlationId: string, error: unknown) => void;
}

export function createCommissionRuntime(input: {
  readonly assembly: CommissionServiceAssembly;
  readonly environment: Environment;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly onBackgroundFailure: (correlationId: string, error: unknown) => void;
}): CommissionRuntime {
  return {
    ...input,
    policy: input.assembly.policy ?? registryCommissionPolicy(),
    completions: input.assembly.completions ?? new AuthorizationDeliveryCompletionSource(),
    hold: input.assembly.hold ?? null,
  };
}

/** A SERVICE context of the commission service: each effect and each sweep item runs in a unit of work of its own. */
export function serviceContext(rt: CommissionRuntime): ServiceContext {
  return { kind: "SERVICE", serviceId: COMMISSION_SERVICE_ID, correlationId: rt.ids.next() as CorrelationId };
}

/**
 * One effect in its own SERVICE unit of work on kauro_commission that adopts the agency of its work item (D10-CTX-1) and names its
 * cause (the delivered event; for a sweep item, nothing outside its own unit of work).
 */
export function inAgency<T>(rt: CommissionRuntime, agencyId: string, cause: string | null, work: (uow: PgCommercialUnitOfWork) => Promise<T>): Promise<T> {
  return rt.assembly.units.run(serviceContext(rt), async (uow) => {
    await uow.adoptAgency(agencyId as Parameters<PgCommercialUnitOfWork["adoptAgency"]>[0]);
    if (cause !== null) uow.causedBy(cause as CausationId);
    return work(uow);
  });
}
