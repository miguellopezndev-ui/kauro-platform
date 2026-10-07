/**
 * The commission service's composition (docs/design/B10-commercial-domain.md §2, §14; decisions D10-CTX-1, D10-CONS-2, D10-BIND-1;
 * mandate B10-COMMISSION-SERVICE): the COMMISSIONS consumer, the sweeps and their effects are SERVICE units of work of the identity
 * commission-service on a verified pool whose login is a member of kauro_commission only; the COMMISSIONS dispatcher claims and settles
 * outbox records and holds its lease on a verified pool of kauro_control (B06 PgOutboxDispatchStore and PgLeaseStore). B10's commercial
 * unit-of-work factory routes each context to its group's pool: SERVICE commission-service to kauro_commission, SYSTEM to kauro_control.
 *
 * What it binds from outside: PreparationCompletionSource. The platform's binding is B09's delivered authorization
 * (AuthorizationDeliveryCompletionSource, D10-BIND-1), which this composition binds when nothing else is given; B13's staged purchases
 * bind their own. Nothing in the product wiring binds a contract fake (D10-FAKE-1): a test hands its fake to createCommissionService.
 */
import type { PreparationCompletionSource } from "@kauro/application";
import type { Clock, CommissionPolicy, Environment, RandomBytes } from "@kauro/domain";
import type { KauroPool, PgCommercialUnitOfWorkFactory, PoolErrorSink, RuntimeRole } from "@kauro/persistence";
import { connectionSecurityOf, createCommercialUnitOfWorkFactory, createPool } from "@kauro/persistence";
import type { DatabaseConnectionConfig } from "../config.js";

/** Where an interleaving is fixed or a crash injected (tests only, like B09's hold points): after an effect, before its settlement. */
export type CommissionHoldPoint = "DELIVERY_BEFORE_SETTLE";

export type CommissionHold = (point: CommissionHoldPoint, subject: { readonly eventId: string; readonly ownerId: string }) => Promise<void>;

/** Everything the commission service's consumer, dispatcher and sweeps need. */
export interface CommissionServiceAssembly {
  /** B10's commercial unit-of-work factory over the kauro_commission and kauro_control pools. */
  readonly units: PgCommercialUnitOfWorkFactory;
  /** The completions of a purchase; the platform's delivered authorization when the composition binds nothing else. */
  readonly completions?: PreparationCompletionSource;
  /** The commission policy the ledger follows; the registry's (R2-INITIAL) by default. */
  readonly policy?: CommissionPolicy;
  /** Interleavings of the dispatcher (tests only). */
  readonly hold?: CommissionHold;
}

/** The logins of the commission service's pools: each a member of exactly its runtime group. */
export interface CommissionDatabases {
  readonly commission: DatabaseConnectionConfig & { readonly poolMax: number; readonly passwordFile?: string };
  readonly control: DatabaseConnectionConfig & { readonly poolMax: number; readonly passwordFile?: string };
}

export interface CommissionPools {
  readonly units: PgCommercialUnitOfWorkFactory;
  readonly pools: { readonly commission: KauroPool; readonly control: KauroPool };
  close(): Promise<void>;
}

/** Application name every connection of the commission service announces (pg_stat_activity; 07 "Connection budget"). */
export const COMMISSION_APPLICATION_NAME = "kauro-api-commission";

async function verified(pool: KauroPool, role: RuntimeRole): Promise<void> {
  const { client, connection } = await pool.acquire();
  client.release();
  if (connection.role !== role) throw new Error(`the commission service's ${role} pool logs in as ${connection.loginRole}, a member of ${connection.role} (08 Database isolation)`);
}

/**
 * Opens the commission service's verified pools and builds B10's commercial unit-of-work factory over them. Nothing stays open when
 * a login is refused.
 */
export async function openCommissionPools(databases: CommissionDatabases, deps: { readonly clock: Clock; readonly random: RandomBytes; readonly statementTimeoutMs?: number; readonly onPoolError?: PoolErrorSink; readonly environment: Environment }): Promise<CommissionPools> {
  const open = (config: CommissionDatabases["commission"], suffix: string): KauroPool => {
    const { poolMax, password, passwordFile, tlsCaFile, ...connection } = config;
    const security = connectionSecurityOf(deps.environment, { host: connection.host, ...(password === undefined ? {} : { password }), ...(passwordFile === undefined ? {} : { passwordFile }), ...(tlsCaFile === undefined ? {} : { tlsCaFile }) });
    return createPool({ ...connection, ...security, max: poolMax, applicationName: `${COMMISSION_APPLICATION_NAME}-${suffix}`, ...(deps.onPoolError !== undefined ? { onError: deps.onPoolError } : {}) });
  };
  const commission = open(databases.commission, "service");
  const control = open(databases.control, "dispatcher");
  const close = async (): Promise<void> => {
    await Promise.all([commission.end(), control.end()]);
  };
  try {
    await verified(commission, "kauro_commission");
    await verified(control, "kauro_control");
  } catch (e) {
    await close();
    throw e;
  }
  return {
    units: createCommercialUnitOfWorkFactory({ commission, control }, { clock: deps.clock, random: deps.random, ...(deps.statementTimeoutMs !== undefined ? { defaultStatementTimeoutMs: deps.statementTimeoutMs } : {}) }),
    pools: { commission, control },
    close,
  };
}
