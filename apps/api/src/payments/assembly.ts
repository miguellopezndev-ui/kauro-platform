/**
 * The payment service's composition (docs/design/B09-payments-fiscal.md §8.2, D-CTX-B1, D-PROTO-B5; stage-2 mandate M3): the
 * service routes (CMD033, CMD034), the settle steps of the provider-effect protocol, the application of provider events and the
 * consumers are units of work of the api authenticated as service identities, on a second verified pool whose login is a member
 * of kauro_payment only (B06's pool verification refuses a login in two groups, so the process holds one login per group); the
 * webhook's ingress half runs on the ingress pool (kauro_ingress, B06 PgInboxIngress, and its own security facts); the payment
 * dispatcher claims and settles outbox records and holds its per-consumer leases on the control pool (kauro_control, B06
 * PgOutboxDispatchStore and PgLeaseStore). The commerce unit-of-work factory of M1 routes each context to its group's pool:
 * TENANT and OPERATOR on the request handlers' pool, SERVICE on the payment pool, SYSTEM on the control pool.
 *
 * What an edition binds from outside (integration package B15, and B07/B08 for the platform ports): the provider adapter, the
 * webhook verifiers, the restricted evidence store, the service authenticator and the fiscal bridge. Nothing in the product
 * wiring binds a contract fake (D-FAKE-B1): the api's composition registers the payment routes whether or not a payment service
 * is bound, and without one the webhook answers PROVIDER_UNKNOWN (no provider is configured) and the service routes find no
 * verified service identity (AUTHENTICATION_REQUIRED, with the anonymous denial recorded).
 */
import type { DurableOperation, FiscalDocumentBridge, PaymentProviderAdapter, ProtocolPoint, ProviderEvidenceStore, ServiceAuthenticator, WebhookVerifier } from "@kauro/application";
import type { Clock, CommerceUnitOfWorkFactory, Environment, InboxIngress, RandomBytes } from "@kauro/domain";
import { createIdGenerator } from "@kauro/domain";
import type { IngressFactRecorder, KauroPool, PoolErrorSink, RuntimeRole } from "@kauro/persistence";
import { PgInboxIngress, PgIngressFactRecorder, createCommerceUnitOfWorkFactory, createPool } from "@kauro/persistence";
import type { DatabaseConnectionConfig } from "../config.js";

/** The external ports an edition binds to the payment service (B15 provider adapters); B07's lineage is the platform's own (edition.ts). */
export interface PaymentServiceAdapters {
  readonly provider: PaymentProviderAdapter;
  /** One verifier per provider whose webhooks the ingress accepts (the route's `{provider}`). */
  readonly verifiers: ReadonlyArray<WebhookVerifier>;
  readonly evidence: ProviderEvidenceStore;
  readonly serviceAuthenticator: ServiceAuthenticator;
  /** The fiscal adapter/bridge (prepare only in B09; issuance is CMD035, B15). */
  readonly fiscalBridge?: FiscalDocumentBridge;
}

/** The command a hold point belongs to. */
export type PaymentHoldCommand = "CMD030" | "CMD033" | "CMD034";

/**
 * Where a crash may be injected, or an interleaving fixed (tests only, like the B06 hold points): the provider-effect protocol's
 * points of CMD033 (ProviderCommandRun.hold); CMD030 after the ingress committed the delivery and inside the application before it
 * commits; CMD034 inside its unit of work before it commits.
 */
export type PaymentHoldPoint = ProtocolPoint | "AFTER_INGRESS" | "APPLICATION_BEFORE_COMMIT";

export type PaymentHold = (command: PaymentHoldCommand, point: PaymentHoldPoint, operation: DurableOperation | null) => Promise<void>;

/** Everything the payment service's routes, consumers and workers need. */
export interface PaymentServiceAssembly extends PaymentServiceAdapters {
  /** M1's commerce unit-of-work factory over the request handlers', the payment and the control pools. */
  readonly commerce: CommerceUnitOfWorkFactory;
  /** B06's PgInboxIngress on the ingress pool. */
  readonly ingress: InboxIngress;
  /** The ingress's own security facts, on the ingress pool (D-FACT-B1). */
  readonly ingressFacts: IngressFactRecorder;
  /** Crash injection of the provider-effect protocol (tests only). */
  readonly hold?: PaymentHold;
}

/** The logins of the payment service's pools: each a member of exactly its runtime group. */
export interface PaymentDatabases {
  readonly payment: DatabaseConnectionConfig & { readonly poolMax: number; readonly passwordFile?: string };
  readonly control: DatabaseConnectionConfig & { readonly poolMax: number; readonly passwordFile?: string };
  readonly ingress: DatabaseConnectionConfig & { readonly poolMax: number; readonly passwordFile?: string };
}

export interface PaymentPools {
  readonly commerce: CommerceUnitOfWorkFactory;
  readonly ingress: InboxIngress;
  readonly ingressFacts: IngressFactRecorder;
  readonly pools: { readonly payment: KauroPool; readonly control: KauroPool; readonly ingress: KauroPool };
  close(): Promise<void>;
}

/** Application name every connection of the payment service announces (pg_stat_activity; 07 "Connection budget"). */
export const PAYMENT_APPLICATION_NAME = "kauro-api-payment";

async function verified(pool: KauroPool, role: RuntimeRole): Promise<void> {
  const { client, connection } = await pool.acquire();
  client.release();
  if (connection.role !== role) throw new Error(`the payment service's ${role} pool logs in as ${connection.loginRole}, a member of ${connection.role} (08 Database isolation)`);
}

/**
 * Opens the payment service's verified pools beside the request handlers' pool the api already holds, and builds M1's commerce
 * unit-of-work factory over the three command groups, B06's inbox ingress and the ingress fact recorder. Nothing stays open when a
 * login is refused.
 */
export async function openPaymentPools(app: KauroPool, databases: PaymentDatabases, deps: { readonly clock: Clock; readonly random: RandomBytes; readonly statementTimeoutMs?: number; readonly onPoolError?: PoolErrorSink; readonly environment: Environment }): Promise<PaymentPools> {
  const open = (config: PaymentDatabases["payment"], suffix: string): KauroPool => {
    const { poolMax, password, passwordFile, tlsCaFile, ...connection } = config;
    // createPool applies connectionSecurityOf itself (DB-TLS-R4): TLS, DNS host and the password file outside LOCAL
    return createPool({ ...connection, environment: deps.environment, ...(password === undefined ? {} : { password }), ...(passwordFile === undefined ? {} : { passwordFile }), ...(tlsCaFile === undefined ? {} : { tlsCaFile }), max: poolMax, applicationName: `${PAYMENT_APPLICATION_NAME}-${suffix}`, ...(deps.onPoolError !== undefined ? { onError: deps.onPoolError } : {}) });
  };
  const payment = open(databases.payment, "service");
  const control = open(databases.control, "dispatcher");
  const ingressPool = open(databases.ingress, "ingress");
  const close = async (): Promise<void> => {
    await Promise.all([payment.end(), control.end(), ingressPool.end()]);
  };
  try {
    await verified(payment, "kauro_payment");
    await verified(control, "kauro_control");
    await verified(ingressPool, "kauro_ingress");
  } catch (e) {
    await close();
    throw e;
  }
  const ids = createIdGenerator(deps.clock, deps.random);
  return {
    commerce: createCommerceUnitOfWorkFactory({ app, payment, control }, { clock: deps.clock, random: deps.random, ...(deps.statementTimeoutMs !== undefined ? { defaultStatementTimeoutMs: deps.statementTimeoutMs } : {}) }),
    ingress: new PgInboxIngress(ingressPool, () => ids.next()),
    ingressFacts: new PgIngressFactRecorder(ingressPool, ids),
    pools: { payment, control, ingress: ingressPool },
    close,
  };
}
