/**
 * The world of the payment service's route tests (package B09, stage-2 mandate M3; docs/design/B09-case-map.md PLANNED (M3)): the
 * B06 world of support.ts — a real PostgreSQL 17 the test starts itself, the api's verified request-handler pool, the agencies,
 * people and B06 routes — plus the payment service composed by the real composition root: the verified kauro_payment,
 * kauro_control and kauro_ingress pools (openPaymentPools), M1's commerce unit of work over them, M2's reconciler bound to the
 * column-scoped purchased-subject read, and an api (assembleApi) that serves CMD030, CMD033 and CMD034 with its send guard over
 * the closed validator. Nothing fakes the database.
 *
 * What the tests bind that no deployment of this edition binds (D-FAKE-B1; evidence class SIMULATED, never integration — the real
 * adapters are package B15's): M2's labelled contract fakes of @kauro/application/testing — the PayPal Orders v2 provider, its
 * webhook verifier, the restricted evidence store, the service authenticator, the fiscal bridge and B07's lineage reader.
 *
 * Preconditions are written through M1's adapters (@kauro/persistence/testing paidPurchase, checkoutOrder, activateAgency and
 * recordReviewedFiscalProfile, the commerce unit of work for refunds and profiles) and, where a precondition is a provider effect
 * (an order the provider created, a capture whose response was lost), through M2's provider-effect runtime with the minimal
 * command halves of a capture — never through M4's routes. Plans are approved through B06's CMD025 route. Interleavings are fixed
 * by hold points and lock waits observed in pg_stat_activity; nothing sleeps.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { CommandResult, DurableOperation, ProtocolPoint, ProviderCommandHooks } from "@kauro/application";
import { operationOf, prepareProviderAttempt, providerEffectPhases, runProviderCommand } from "@kauro/application";
import {
  createEvidenceStoreFake,
  createFiscalBridgeFake,
  createPayPalContractFake,
  createServiceAuthenticatorFake,
  createSourceLineageFake,
  createWebhookVerifierFake,
  type EvidenceStoreFake,
  type FiscalBridgeFake,
  type PayPalContractFake,
  type ServiceAuthenticatorFake,
  type SourceLineageFake,
  type WebhookVerifierFake,
} from "@kauro/application/testing";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { AgencyId, CapabilityId, CausationId, CorrelationId, TargetInstanceRef, FiscalIssuerRef, FiscalProfileId, IdempotencyIdentity, JournalEntryId, MembershipId, PaymentAttemptId, PaymentEnvironment, PaymentOrderId, PlanId, ProjectId, RefundId, RevisionId, ServiceIdentity, UserId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure, deliveryPhaseOf, toUtcInstant } from "@kauro/domain";
import { ROLES, activateAgency, checkoutOrder, paidPurchase, recordReviewedFiscalProfile, type AgencyFixture, type CheckoutOrder, type PaidPurchase, type QualifiedRoute } from "@kauro/persistence/testing";
import { assembleApi, createBearerTokenAuthenticator, createPaymentService, loadContractSchemas, openPaymentPools, storeProviderQuery, type DispatchPass, type PaymentConsumerName, type PaymentHoldCommand, type PaymentHoldPoint, type PaymentPools, type PaymentService } from "../src/index.js";
import { approveThroughRoute, call, clock, ids, sha, type Call, type PlanFixture, type Reply, type World, world } from "./support.js";

// --- hold points of the payment service ------------------------------------------------------------------------------------------

/** A simulated process death at a hold point: not a DomainFailure, so the unit of work rolls back and the route answers INTERNAL_ERROR. */
export class SimulatedCrash extends Error {
  constructor(where: string) {
    super(`simulated crash ${where}`);
    this.name = "SimulatedCrash";
  }
}

export interface PaymentHoldHandle {
  /** Resolves when the held work reached the point (its transaction open, when the point is inside one). */
  readonly reached: Promise<void>;
  release(): void;
}

/** One-shot hold points of the payment service (assembly.hold), armed by a test: a crash, or a wait until released. */
export class PaymentHolds {
  readonly #armed = new Map<string, { readonly crash: boolean; readonly reached: () => void; readonly release: Promise<void> }>();

  arm(command: PaymentHoldCommand, point: PaymentHoldPoint, mode: "CRASH" | "WAIT"): PaymentHoldHandle {
    const key = `${command}:${point}`;
    if (this.#armed.has(key)) throw new Error(`hold ${key} is already armed`);
    let reached: () => void = () => undefined;
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release: () => void = () => undefined;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#armed.set(key, { crash: mode === "CRASH", reached, release: releasePromise });
    return { reached: reachedPromise, release };
  }

  async pass(command: PaymentHoldCommand, point: PaymentHoldPoint): Promise<void> {
    const key = `${command}:${point}`;
    const armed = this.#armed.get(key);
    if (armed === undefined) return;
    this.#armed.delete(key);
    armed.reached();
    if (armed.crash) throw new SimulatedCrash(key);
    await armed.release;
  }
}

// --- the payment world ---------------------------------------------------------------------------------------------------------

export interface PaymentWorld {
  /** The B06 world: its own app serves the B06 routes (CMD025 approvals). */
  readonly w: World;
  /** The same world with `app` the api that serves the payment routes (for support.ts call/outcome/asProblem). */
  readonly api: World;
  readonly app: FastifyInstance;
  readonly service: PaymentService;
  readonly pools: PaymentPools;
  readonly holds: PaymentHolds;
  /** M2's labelled contract fakes (CONTRACT_FAKE, SIMULATED). */
  readonly paypal: PayPalContractFake;
  readonly verifier: WebhookVerifierFake;
  readonly evidence: EvidenceStoreFake;
  readonly services: ServiceAuthenticatorFake;
  readonly fiscalBridge: FiscalBridgeFake;
  readonly lineage: SourceLineageFake;
  /** The platform's qualified merchant route (the fake's merchant) and fiscal issuer route. */
  readonly route: QualifiedRoute;
  readonly issuerRef: FiscalIssuerRef;
  /** A corporate person holding an ACTIVE KAURO_OWNER grant (the refund approver, the fiscal reviewer). */
  readonly kora: UserId;
  /** Agency A's reviewed fiscal profile (EXEMPT_EXPORT). */
  readonly profileId: FiscalProfileId;
  readonly hubspotCapabilityId: CapabilityId;
  readonly backgroundFailures: Array<{ readonly correlationId: string; readonly error: unknown }>;
  readonly internalErrors: Array<{ readonly correlationId: string; readonly error: unknown }>;
  stop(): Promise<void>;
}

export async function paymentWorld(): Promise<PaymentWorld> {
  const w = await world();
  const { h } = w;
  await activateAgency(h, w.A);
  const paypal = createPayPalContractFake({ clock });
  const verifier = createWebhookVerifierFake({ clock });
  const evidence = createEvidenceStoreFake({ clock });
  const services = createServiceAuthenticatorFake({ clock });
  const fiscalBridge = createFiscalBridgeFake();
  const lineage = createSourceLineageFake({ clock });
  const route = await h.qualifiedPaymentRoute({ payee: paypal.merchantId });
  const issuerRef = await h.qualifiedFiscalIssuer();
  const kora = (await h.person("kora-payment-owner")) as UserId;
  await h.grantKauroOwner(kora);
  const profileId = await recordReviewedFiscalProfile(h, { operatorUserId: kora, agencyId: w.A.agencyId, issuerRef });
  await h.publishCapability(w.hubspotCapabilityId, "AVAILABLE_LIMITED");
  const base = { host: "127.0.0.1", port: h.pg.port, database: ROLES.database, poolMax: 4 } as const;
  const pools = await openPaymentPools(w.db.pool, { payment: { ...base, user: ROLES.paymentLogin }, control: { ...base, user: ROLES.controlLogin }, ingress: { ...base, user: ROLES.ingressLogin } }, { clock, random: (n) => new Uint8Array(randomBytes(n)) });
  const holds = new PaymentHolds();
  const backgroundFailures: Array<{ correlationId: string; error: unknown }> = [];
  const internalErrors: Array<{ correlationId: string; error: unknown }> = [];
  const service = createPaymentService({
    assembly: { commerce: pools.commerce, ingress: pools.ingress, ingressFacts: pools.ingressFacts, provider: paypal, verifiers: [verifier], evidence, serviceAuthenticator: services, fiscalBridge, lineage, hold: (command, point) => holds.pass(command, point) },
    environment: "LOCAL",
    clock,
    ids,
    onBackgroundFailure: (correlationId, error) => backgroundFailures.push({ correlationId, error }),
  });
  const app = assembleApi({ environment: "LOCAL", unitOfWork: w.db.unitOfWork, database: w.db, authenticator: createBearerTokenAuthenticator(new Map()), validator: loadContractSchemas(), clock, ids, payments: service, onInternalError: (correlationId, error) => internalErrors.push({ correlationId, error }) });
  await app.ready();
  const api: World = { ...w, app };
  return {
    w,
    api,
    app,
    service,
    pools,
    holds,
    paypal,
    verifier,
    evidence,
    services,
    fiscalBridge,
    lineage,
    route,
    issuerRef,
    kora,
    profileId,
    hubspotCapabilityId: w.hubspotCapabilityId,
    backgroundFailures,
    internalErrors,
    async stop() {
      await app.close();
      await pools.close();
      await w.stop();
    },
  };
}

// --- purchases -------------------------------------------------------------------------------------------------------------------

/**
 * An APPROVED plan of a HUBSPOT project of agency A (the R2-077 band: 40,000 units at the founding rate is 129,500 less 32,375, a
 * service of 97,125; an EXEMPT_EXPORT treatment adds no tax): the project written through the ports, a sealed revision and a
 * confirmed target contract of the project, a VALIDATED plan naming both, approved through B06's CMD025 route.
 */
export async function approvedPlan(pw: PaymentWorld, seed: string, agency: AgencyFixture = pw.w.A): Promise<PlanFixture> {
  const { w } = pw;
  const clientId = agency.agencyId === w.A.agencyId ? w.clientA : w.clientB;
  const projectId = await w.h.app.run(w.h.tenant(agency.agencyId, agency.ownerUserId), async (uow) => {
    const id = uow.ids.next() as ProjectId;
    const revisionId = uow.ids.next() as RevisionId;
    const now = clock.now();
    const { project, revision } = await uow.projects.insertWithDraftRevision({
      projectId: id,
      agencyId: agency.agencyId,
      clientId,
      mode: "HUBSPOT",
      purpose: `Purchase ${seed}`,
      targetInstanceRef: uow.ids.next() as TargetInstanceRef,
      capabilityId: pw.hubspotCapabilityId,
      capabilityVersion: "R2-INITIAL",
      initialRevisionId: revisionId,
      createdByMembershipId: agency.ownerMembershipId,
      createdAt: now,
    });
    const actor = { kind: "USER", userId: agency.ownerUserId } as const;
    await uow.events.publish({ aggregateKind: "project", aggregateId: id, aggregateVersion: project.version, agencyId: agency.agencyId, eventType: "project.created.v1", actor, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { projectId: id, agencyId: agency.agencyId, clientId, mode: "HUBSPOT", capabilityId: pw.hubspotCapabilityId, capabilityVersion: "R2-INITIAL", initialRevisionId: revisionId, createdByMembershipId: agency.ownerMembershipId } });
    await uow.events.publish({ aggregateKind: "dataset_revision", aggregateId: revisionId, aggregateVersion: revision.version, agencyId: agency.agencyId, eventType: "dataset_revision.created.v1", actor, causationId: uow.ids.next() as CausationId, correlationId: uow.context.correlationId, payload: { revisionId, agencyId: agency.agencyId, projectId: id, state: revision.state } });
    return id;
  });
  const source = await w.revision(agency, projectId, "SEALED");
  const contractId = ids.next();
  const targetContractHash = sha(`hubspot-target-${contractId}`);
  await w.asTenant(agency, async (c) => {
    await c.query(
      `INSERT INTO kauro.target_contracts (contract_id, agency_id, project_id, mode, instance_id, importer_profile_id, importer_version, objects, schema_bundle_digest, body_hash, observed_at, confirmed_at, authority_evidence_hash, capability_version, created_at)
       VALUES ($1, $2, $3, 'HUBSPOT', $4, $5, 'R2-INITIAL', '[]'::jsonb, $6, $7, now(), now(), $8, 'R2-INITIAL', now())`,
      [contractId, agency.agencyId, projectId, ids.next(), ids.next(), sha("bundle"), targetContractHash, sha(`authority-${contractId}`)],
    );
  });
  const plan = await w.plan(agency, projectId, { revisionHash: source.revisionHash, targetContractHash, seed, state: "VALIDATED" });
  await approveThroughRoute(w, plan);
  return plan;
}

/** The provider order of a checkout, created at the provider fake the way CMD028's call would create it (amount and reference). */
async function providerOrderOf(pw: PaymentWorld, order: { readonly orderId: PaymentOrderId; readonly attemptId: PaymentAttemptId; readonly totalCents: bigint }): Promise<string> {
  const request = pw.paypal.prepareCreateOrder({ orderId: order.orderId, attemptId: order.attemptId, providerRequestId: `kauro-${order.attemptId}`, amountCents: order.totalCents, currency: "USD", description: "KAURO_PROJECT_PREPARATION", returnPath: `/app/checkout/${order.orderId}/return`, cancelPath: `/app/checkout/${order.orderId}/cancel` });
  const created = await pw.paypal.dispatch(request, toUtcInstant(clock.nowMs() + 60_000));
  if (created.kind !== "ORDER_CREATED") throw new Error(`the provider fake did not create the order: ${created.kind}`);
  return created.providerOrderId;
}

/** A checkout the provider created (the order CREATED, nothing captured), over a freshly approved HUBSPOT plan. */
export async function checkout(pw: PaymentWorld, seed: string): Promise<CheckoutOrder & { readonly plan: PlanFixture }> {
  const plan = await approvedPlan(pw, seed);
  const order = await checkoutOrder(pw.w.h, { agency: pw.w.A, planId: plan.planId as PlanId, route: pw.route, issuerRef: pw.issuerRef, profileId: pw.profileId, provider: { order: (o) => providerOrderOf(pw, o) } });
  return { ...order, plan };
}

/** A purchase paid at the provider by one capture that alone pays it, recorded with its CommercialAuthorization (paidPurchase). */
export async function paid(pw: PaymentWorld, seed: string, options: { readonly feeCents?: bigint } = {}): Promise<PaidPurchase & { readonly providerCaptureId: string; readonly plan: PlanFixture }> {
  const plan = await approvedPlan(pw, seed);
  let providerCaptureId = "";
  const purchase = await paidPurchase(pw.w.h, {
    agency: pw.w.A,
    planId: plan.planId as PlanId,
    route: pw.route,
    issuerRef: pw.issuerRef,
    profileId: pw.profileId,
    provider: {
      order: (o) => providerOrderOf(pw, o),
      capture: ({ providerOrderId }) => {
        pw.paypal.approve(providerOrderId);
        providerCaptureId = pw.paypal.captureAtProvider(providerOrderId, options.feeCents !== undefined ? { feeCents: options.feeCents } : {});
        return { providerCaptureId };
      },
    },
  });
  return { ...purchase, providerCaptureId, plan };
}

// --- webhook deliveries ----------------------------------------------------------------------------------------------------------

export interface Delivery {
  readonly reply: Reply;
  readonly eventId: string;
  readonly bytes: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
}

/** POSTs raw bytes to the webhook route as the provider does: no bearer token, no idempotency key, its own signature headers. */
export function postWebhook(pw: PaymentWorld, bytes: Uint8Array, headers: Readonly<Record<string, string>>, provider = "paypal"): Promise<Reply> {
  return call(pw.api, { url: `/api/v1/payments/webhooks/${provider}`, token: null, key: null, agency: null, rawBody: Buffer.from(bytes).toString("utf8"), headers: { ...headers } });
}

/** The provider fake's own event about one of its objects, signed by the verifier fake for `environment`, delivered to the route. */
export async function deliver(pw: PaymentWorld, eventType: string, subjectId: string, options: { readonly eventId?: string; readonly overrides?: Readonly<Record<string, unknown>>; readonly environment?: PaymentEnvironment; readonly tamper?: boolean; readonly createTime?: UtcInstant } = {}): Promise<Delivery> {
  const body = pw.paypal.webhookBody(eventType, subjectId, { ...(options.eventId !== undefined ? { eventId: options.eventId } : {}), ...(options.overrides !== undefined ? { overrides: options.overrides } : {}), ...(options.createTime !== undefined ? { createTime: options.createTime } : {}) });
  const signed = { ...pw.verifier.sign(body.bytes, options.environment !== undefined ? { environment: options.environment } : {}) };
  if (options.tamper === true) signed["paypal-transmission-sig"] = Buffer.from("forged-signature-of-another-sender").toString("base64");
  return { reply: await postWebhook(pw, body.bytes, signed), eventId: body.eventId, bytes: body.bytes, headers: signed };
}

// --- service calls ---------------------------------------------------------------------------------------------------------------

/** A bearer token of a service identity minted by the service authenticator fake (payment-service in LOCAL by default). */
export function serviceToken(pw: PaymentWorld, identity: Partial<ServiceIdentity> = {}): string {
  return pw.services.mint({ serviceId: identity.serviceId ?? "payment-service", audience: identity.audience ?? "kauro-api", environment: identity.environment ?? "LOCAL" }).slice("Bearer ".length);
}

export function execute(pw: PaymentWorld, refundId: string, body: unknown, options: Partial<Pick<Call, "key" | "token">> = {}): Promise<Reply> {
  return call(pw.api, { url: `/api/v1/refunds/${refundId}/execute`, agency: null, token: options.token === undefined ? serviceToken(pw) : options.token, ...(options.key !== undefined ? { key: options.key } : {}), body });
}

export function reconcile(pw: PaymentWorld, orderId: string, body: unknown, options: Partial<Pick<Call, "key" | "token">> = {}): Promise<Reply> {
  return call(pw.api, { url: `/api/v1/payment-orders/${orderId}/reconcile`, agency: null, token: options.token === undefined ? serviceToken(pw) : options.token, ...(options.key !== undefined ? { key: options.key } : {}), body });
}

/** The payment service's stored provider query of an order (outside any transaction), as the watchdog performs it. */
export function storeQuery(pw: PaymentWorld, providerOrderId: string): Promise<string> {
  return storeProviderQuery(pw.service.runtime, { providerOrderId, providerRequestId: "unused" });
}

export function dispatch(pw: PaymentWorld, consumer: PaymentConsumerName): Promise<DispatchPass> {
  return pw.service.dispatcher.runOnce(consumer, { limit: 100 });
}

// --- refunds (the request side's writes, through M1's adapters: never M4's routes) ----------------------------------------------

/** A customer refund request of a paid purchase (CMD031's write through the adapter, by the agency's owner). */
export async function requestedRefund(pw: PaymentWorld, purchase: PaidPurchase, serviceCents: bigint): Promise<RefundId> {
  const { w } = pw;
  return w.h.commerce.run(w.h.tenant(w.A.agencyId, w.A.ownerUserId), async (uow) => {
    const refundId = uow.ids.next() as RefundId;
    const live = await uow.commerce.authorizations.findLiveByCapture(purchase.captureId);
    const now = clock.now();
    await uow.commerce.refunds.request({
      refundId,
      agencyId: w.A.agencyId,
      projectId: purchase.projectId as ProjectId,
      orderId: purchase.orderId,
      captureId: purchase.captureId,
      origin: "CUSTOMER_REQUEST",
      reasonCode: "The client cancelled before execution",
      termsHash: purchase.termsHash,
      deliveryPhase: deliveryPhaseOf(live),
      proposed: { serviceCents, taxCents: 0n, excessCents: 0n },
      requestedByMembershipId: w.A.ownerMembershipId as MembershipId,
      requestedByUserId: w.A.ownerUserId,
      requestedAt: now,
    });
    await uow.scopes.record({ kind: "REFUND", key: refundId, agencyId: w.A.agencyId, orderId: purchase.orderId, refundId }, now);
    return refundId;
  });
}

/** A refund requested and approved by the corporate owner in the finance scope it adopts, with a fresh step-up (CMD032's write). */
export async function approvedRefund(pw: PaymentWorld, purchase: PaidPurchase, serviceCents: bigint): Promise<RefundId> {
  const refundId = await requestedRefund(pw, purchase, serviceCents);
  const proof = await pw.w.h.recordStepUp(pw.kora);
  await pw.w.h.commerce.run(pw.w.h.operator(pw.kora), async (uow) => {
    if ((await uow.adoptScope("REFUND", refundId)) === null) throw new Error("the corporate owner cannot adopt the refund's finance scope");
    const now = clock.now();
    const written = await uow.commerce.refunds.approve(
      refundId,
      1,
      { amounts: { serviceCents, taxCents: 0n, excessCents: 0n }, authorizationKind: "OWNER_STEP_UP", authorizationProofRef: proof, authorizationHash: sha(`authorization-${refundId}`), effectsHash: sha(`effects-${refundId}`), creditNoteRequired: serviceCents > 0n, approvedByUserId: pw.kora, approvedAt: now },
      now,
    );
    if (written.kind !== "APPLIED") throw new Error(`the approval of ${refundId} was stale`);
  });
  return refundId;
}

// --- a capture through M2's provider-effect runtime (the minimal command halves; never M4's route) --------------------------------

interface CaptureView {
  readonly order: { readonly orderId: string; readonly state: string; readonly version: number };
}

function captureHooks(pw: PaymentWorld, orderId: PaymentOrderId): ProviderCommandHooks<Record<string, never>, CaptureView> {
  return {
    async intent(uow, _body, causationId, now) {
      const entryId = causationId as string as JournalEntryId;
      const order = await uow.commerce.orders.lock(orderId);
      if (order === null) throw new NotFoundFailure("payment_order");
      if (order.state !== "CREATED" && order.state !== "APPROVED") throw new DomainFailure("PRECONDITION_FAILED", "the order is not capturable", { reason: "ORDER_NOT_CAPTURABLE" });
      const attempt = await prepareProviderAttempt(uow, { adapter: pw.paypal, subject: { effect: "CAPTURE", order }, ordinal: 1, intentEntryId: entryId, causationId, now });
      return { kind: "DISPATCH", operation: await operationOf(uow, "CAPTURE", entryId, attempt) };
    },
    async conclude(serviceUow, operation) {
      const order = await serviceUow.commerce.orders.get(operation.resource.id as PaymentOrderId);
      if (order === null) throw new NotFoundFailure("payment_order");
      return { kind: "CONCLUSIVE", status: 200, view: { order: { orderId: order.orderId, state: order.state, version: order.version } }, version: order.version, resourceKind: "payment_order", resourceId: order.orderId };
    },
  };
}

/**
 * A capture of an order by the agency's owner through M2's provider-effect runtime over the real commerce unit of work (T1, T2 and
 * T4 as the tenant, T3 as the payment service): the precondition of the tests that need a capture attempt in flight or uncertain.
 * `hold` pauses or crashes the run at a protocol point.
 */
export function captureRun(pw: PaymentWorld, orderId: PaymentOrderId, key: string, hold?: (point: ProtocolPoint, operation: DurableOperation | null) => Promise<void>): Promise<CommandResult<CaptureView>> {
  const { w } = pw;
  const tenant = w.h.tenant(w.A.agencyId, w.A.ownerUserId);
  const identity: IdempotencyIdentity = { environment: "LOCAL", actor: { kind: "USER", userId: w.A.ownerUserId }, agencyId: w.A.agencyId as AgencyId, operation: "CMD029", key };
  return runProviderCommand({
    effect: "CAPTURE",
    phases: providerEffectPhases("CAPTURE", { adapter: pw.paypal, reconciler: pw.service.runtime.reconciler, clock }, captureHooks(pw, orderId)),
    adapter: pw.paypal,
    clock,
    principal: { unitOfWork: pw.pools.commerce, context: tenant },
    service: { unitOfWork: pw.pools.commerce, context: { kind: "SERVICE", serviceId: "payment-service", correlationId: tenant.correlationId } },
    identity,
    digest: sha(`capture-${orderId}`) as Sha256Hex,
    correlationId: tenant.correlationId as CorrelationId,
    body: {},
    async access() {
      // the minimal half: the owner's membership is the fixture's; the access decision is M4's CMD029
    },
    ...(hold !== undefined ? { hold } : {}),
  });
}

// --- oracle reads ------------------------------------------------------------------------------------------------------------------

export async function rows<T extends Record<string, unknown>>(pw: PaymentWorld, sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
  return (await pw.w.h.oracle.query<T>(sql, [...params])).rows;
}

export type { CheckoutOrder, PaidPurchase };
export { sha };
