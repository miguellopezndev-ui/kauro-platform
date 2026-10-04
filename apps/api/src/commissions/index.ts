/**
 * The commission service of package B10 in the api (docs/design/B10-commercial-domain.md §14; mandate B10-COMMISSION-SERVICE): its
 * composition (assembly.ts), its runtime and identity (runtime.ts), the COMMISSIONS consumer (consumer.ts) run by the COMMISSIONS
 * dispatcher (dispatcher.ts), and the sweeps with the cycle that runs them (sweeps.ts). `createCommissionService` binds them over one
 * assembly; B10-INTEGRATION entered PERIODS (periods.ts) into the cycle, after the five sweeps.
 */
import type { BankingCalendarSource, StatementServiceHold } from "@kauro/application";
import type { Clock, Environment, IdGenerator, LeaseOwnerId } from "@kauro/domain";
import type { CommissionServiceAssembly } from "./assembly.js";
import { commissionsConsumer, type CommissionsConsumer } from "./consumer.js";
import { createCommissionDispatcher, type CommissionDispatcher } from "./dispatcher.js";
import { createPeriodsSweep } from "./periods.js";
import { createCommissionRuntime, type CommissionRuntime } from "./runtime.js";
import { COMMISSION_SWEEPS, runSweep, type CommissionSweepName, type CycleSweep, type SweepReport } from "./sweeps.js";

export interface CommissionService {
  readonly runtime: CommissionRuntime;
  readonly consumer: CommissionsConsumer;
  /** The service's own COMMISSIONS dispatcher. */
  readonly dispatcher: CommissionDispatcher;
  /** Another dispatcher of the same consumer (another process's, a test's second instance), with its own lease owner id. */
  dispatcherOf(options?: { readonly ownerId?: LeaseOwnerId }): CommissionDispatcher;
  /** One bounded pass of one sweep. */
  runSweep(sweep: CommissionSweepName, options?: { readonly limit?: number }): Promise<SweepReport>;
  /** One bounded pass of every sweep in order, PERIODS last (open the month, close each due period through CMD051), then those `also` names. */
  runCycle(options?: { readonly limit?: number; readonly also?: ReadonlyArray<CycleSweep> }): Promise<ReadonlyArray<SweepReport>>;
}

export function createCommissionService(input: {
  readonly assembly: CommissionServiceAssembly;
  readonly environment: Environment;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** The ports of the PERIODS sweep: the banking calendar CMD051 dates a close with (the platform's recorded one when absent) and a test's hold. */
  readonly periods?: { readonly calendar?: BankingCalendarSource; readonly hold?: StatementServiceHold };
  /** Receives a failure of work no request waits for, by correlation id; default: one stderr line with the safe classification. */
  readonly onBackgroundFailure?: (correlationId: string, error: unknown) => void;
}): CommissionService {
  const runtime = createCommissionRuntime({
    assembly: input.assembly,
    environment: input.environment,
    clock: input.clock,
    ids: input.ids,
    onBackgroundFailure: input.onBackgroundFailure ?? ((correlationId, error) => process.stderr.write(`kauro-api commission background failure correlation=${correlationId} class=${error instanceof Error ? error.name : typeof error}\n`)),
  });
  const consumer = commissionsConsumer(runtime);
  return {
    runtime,
    consumer,
    dispatcher: createCommissionDispatcher(runtime, consumer),
    dispatcherOf: (options) => createCommissionDispatcher(runtime, consumer, options ?? {}),
    runSweep: (sweep, options) => runSweep(runtime, sweep, options ?? {}),
    async runCycle(options = {}) {
      const limit = options.limit ?? 100;
      const out: SweepReport[] = [];
      for (const sweep of COMMISSION_SWEEPS) out.push(await runSweep(runtime, sweep, { limit }));
      out.push(await createPeriodsSweep(runtime, input.periods ?? {}).run({ limit }));
      for (const extra of options.also ?? []) out.push(await extra.run({ limit }));
      return out;
    },
  };
}

export { openCommissionPools, COMMISSION_APPLICATION_NAME } from "./assembly.js";
export type { CommissionServiceAssembly, CommissionDatabases, CommissionPools, CommissionHold, CommissionHoldPoint } from "./assembly.js";
export { COMMISSION_SERVICE_ID, COMMISSIONS_CONSUMER, HOLD_REVIEW_HOURS, createCommissionRuntime } from "./runtime.js";
export type { CommissionRuntime } from "./runtime.js";
export { commissionsConsumer } from "./consumer.js";
export type { CommissionsConsumer } from "./consumer.js";
export { commissionLeaseResource, createCommissionDispatcher } from "./dispatcher.js";
export type { CommissionDispatcher, CommissionDispatchPass, CommissionDeliveryOutcome } from "./dispatcher.js";
export { COMMISSION_SWEEPS, runSweep } from "./sweeps.js";
export type { CommissionSweepName, CycleSweep, SweepReport } from "./sweeps.js";
// mandate B10-STATEMENTS-PAYOUTS: the commission group's service routes (CMD051, CMD053) and the PERIODS sweep
export { registerCommissionRoutes, statementServiceRuntime } from "./routes.js";
export type { CommissionRoutesBinding, CommissionRouteDependencies } from "./routes.js";
export { createPeriodsSweep, periodCloseKey } from "./periods.js";
