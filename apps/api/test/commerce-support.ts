/**
 * The world of the request side's acceptance tests (package B09, implementation mandate M4; docs/design/B09-case-map.md): the api
 * test world of support.ts — the real Fastify server composed by the real composition root over a real PostgreSQL 17, the pg units
 * of work, the shipped authorizers and handlers, the closed validator — with the payment collaborators a deployment of this edition
 * does not bind, bound here as ApiAssembly.commerce:
 *
 *  - the payment service's units of work: the harness's commerce factory, whose SERVICE contexts run on its verified kauro_payment
 *    login (the settle step T3; D-PROTO-B5);
 *  - the labelled contract fakes of @kauro/application/testing (integrationClass / binding CONTRACT_FAKE, evidence class SIMULATED;
 *    D-FAKE-B1): the PayPal Orders v2 provider, B08's deliverable capacity and B07's source availability. Nothing they answer is a
 *    provider or platform fact; every case they take part in is PARTIAL at closure with the simulated half named;
 *  - the protocol holds of the provider-effect runtime (D-REQ-B6): a crash at a named protocol point ends the request like a process
 *    death there (the transport answers INTERNAL_ERROR), a pause keeps it at that point until the test releases it; no sleep
 *    synchronizes anything, and a lock wait is observed in pg_stat_activity.
 *
 * The purchases are the adapter-written fixtures of @kauro/persistence/testing (issueQuote, paidPurchase, activateAgency,
 * recordReviewedFiscalProfile) over a plan approved through the real CMD025 route; the api's clock can be moved forward to put a
 * price past its expiry without backdating any database row.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { CommerceReconciler, DurableOperation, ProtocolHold, ProtocolPoint } from "@kauro/application";
import { createCommerceReconciler } from "@kauro/application";
import {
  createDeliveryCapacityFake,
  createPayPalContractFake,
  createSourceAvailabilityFake,
  createWebhookVerifierFake,
  sealedAvailability,
  type DeliveryCapacityFake,
  type PayPalContractFake,
  type SourceAvailabilityFake,
  type WebhookVerifierFake,
} from "@kauro/application/testing";
import type { CausationId, Clock, FiscalIssuerRef, FiscalProfileId, InboxId, PlanId, ProjectId, UserId } from "@kauro/domain";
import { COMMERCE_EVENT_SUBSCRIPTIONS, toUtcInstant } from "@kauro/domain";
import { activateAgency, issueQuote, paidPurchase, recordReviewedFiscalProfile, type IssuedQuote, type PaidPurchase, type QualifiedRoute } from "@kauro/persistence/testing";
import { purchasedSubjectReader } from "../src/index.js";
import { SimulatedCrash, approveThroughRoute, call, freshKey, ids, sha, world, type Person, type PlanFixture, type Reply, type World } from "./support.js";

// --- the clock -------------------------------------------------------------------------------------------------------------------

/** The api's clock: real time, moved forward by `offsetMs` when a test needs a later instant (a price past its expiry). */
export interface ShiftingClock extends Clock {
  offsetMs: number;
}

export function shiftingClock(): ShiftingClock {
  const clock: ShiftingClock = {
    offsetMs: 0,
    now: () => toUtcInstant(Date.now() + clock.offsetMs),
    nowMs: () => Date.now() + clock.offsetMs,
  };
  return clock;
}

// --- protocol holds ----------------------------------------------------------------------------------------------------------------

export interface ProtocolHoldHandle {
  /** Resolves when the request reached the point (for a crash: when it was about to die there). */
  readonly reached: Promise<DurableOperation | null>;
  /** Lets a paused request continue. */
  release(): void;
}

/** One-shot holds at the points of the provider-effect protocol, armed per command (the runtime's `hold`, D-REQ-B6). */
export class ProtocolHolds {
  readonly #armed = new Map<string, { readonly mode: "CRASH" | "PAUSE"; readonly reached: (op: DurableOperation | null) => void; readonly release: Promise<void> }>();

  arm(command: "CMD028" | "CMD029", point: ProtocolPoint, mode: "CRASH" | "PAUSE"): ProtocolHoldHandle {
    const key = `${command} ${point}`;
    if (this.#armed.has(key)) throw new Error(`hold ${key} is already armed`);
    let reachedResolve: (op: DurableOperation | null) => void = () => undefined;
    const reached = new Promise<DurableOperation | null>((resolve) => {
      reachedResolve = resolve;
    });
    let releaseResolve: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    this.#armed.set(key, { mode, reached: reachedResolve, release });
    return { reached, release: () => releaseResolve() };
  }

  readonly hook: ProtocolHold = async (command, point, operation) => {
    const key = `${command} ${point}`;
    const armed = this.#armed.get(key);
    if (armed === undefined) return;
    this.#armed.delete(key);
    armed.reached(operation);
    if (armed.mode === "CRASH") throw new SimulatedCrash(`at ${point}`);
    await armed.release;
  };
}

// --- the world -------------------------------------------------------------------------------------------------------------------

/** The tables a payment command, its refusal or its fixtures can write (the "no committed state" oracle of the B09 tests). */
export const COMMERCE_TABLES = [
  "quotes",
  "price_eligibility_snapshots",
  "payment_orders",
  "payment_attempts",
  "provider_observations",
  "capture_facts",
  "commercial_authorizations",
  "refunds",
  "reconciliation_cases",
  "provider_event_exceptions",
  "commerce_scopes",
  "inbox_records",
  "domain_events",
  "outbox_records",
  "command_journal",
  "security_events",
] as const;
export type CommerceTable = (typeof COMMERCE_TABLES)[number];

export interface PaymentsWorld {
  readonly w: World;
  readonly clock: ShiftingClock;
  /** The labelled contract fakes (SIMULATED; D-FAKE-B1). */
  readonly provider: PayPalContractFake;
  readonly capacity: DeliveryCapacityFake;
  readonly sources: SourceAvailabilityFake;
  readonly verifier: WebhookVerifierFake;
  readonly holds: ProtocolHolds;
  /** The QUALIFIED merchant route of the fake's provider, environment and payee, and the qualified fiscal issuer. */
  readonly route: QualifiedRoute;
  readonly issuerRef: FiscalIssuerRef;
  readonly profileId: FiscalProfileId;
  /** A corporate owner (an individually managed corporate identity with an ACTIVE KAURO_OWNER grant; D-CORP-B1). */
  readonly kora: Person;
  readonly koraGrantId: string;
  /** The reconciler of the payment service's settle step, for applying a verified webhook as CMD030's application half does. */
  readonly reconciler: CommerceReconciler;
  /** An ISSUED quote over a plan of a fresh project approved through CMD025, its source available for the quote's promise. */
  readyQuote(label: string, treatment?: "EXEMPT_EXPORT" | "DOMESTIC_TAXABLE"): Promise<ReadyQuote>;
  /** A purchase paid by one capture with its entitlement, written through the commerce adapters (paidPurchase). */
  paidProject(label: string, treatment?: "EXEMPT_EXPORT" | "DOMESTIC_TAXABLE"): Promise<PaidPurchase & { readonly plan: PlanFixture }>;
  /**
   * A fiscal profile version recorded by the corporate owner in the agency's finance scope, superseding the current one at its own
   * instant (FiscalRepository.recordProfile; D-FISC-B6): REVIEW_REQUIRED (the explicit unknown), EXEMPT_EXPORT or DOMESTIC_TAXABLE 19%.
   */
  recordProfileVersion(treatment: "REVIEW_REQUIRED" | "EXEMPT_EXPORT" | "DOMESTIC_TAXABLE"): Promise<FiscalProfileId>;
  /** A verified provider event recorded by the ingress (kauro_ingress) and applied by the payment service through the reconciler. */
  applyWebhook(eventType: string, subjectId: string): Promise<{ readonly inboxId: InboxId; readonly outcome: string }>;
  /** Superuser oracle: the row count of every commerce and effect table, and the provider fake's calls and effects. */
  effects(): Promise<Readonly<Record<CommerceTable, number>> & { readonly providerCalls: number; readonly providerEffects: string }>;
  /** Superuser oracle: the events of an aggregate in version order, with their actor. */
  events(kind: string, id: string): Promise<ReadonlyArray<{ readonly version: number; readonly type: string; readonly actor: string; readonly payload: Record<string, unknown>; readonly eventId: string }>>;
  stop(): Promise<void>;
}

export interface ReadyQuote extends IssuedQuote {
  readonly plan: PlanFixture;
  readonly revisionId: string;
}

export async function paymentsWorld(): Promise<PaymentsWorld> {
  const clock = shiftingClock();
  const provider = createPayPalContractFake({ clock });
  const capacity = createDeliveryCapacityFake({ clock });
  const sources = createSourceAvailabilityFake({ clock });
  const verifier = createWebhookVerifierFake({ clock });
  const holds = new ProtocolHolds();
  const w = await world({ clock, commerce: (h) => ({ payment: h.commerce, provider, capacity, sources, protocolHold: holds.hook }) });
  // the agency sells: ACTIVE, the platform's qualified routes, a reviewed fiscal profile recorded by a corporate owner
  await activateAgency(w.h, w.A);
  const route = await w.h.qualifiedPaymentRoute({ provider: provider.provider, environment: provider.environment, payee: provider.merchantId });
  const issuerRef = await w.h.qualifiedFiscalIssuer();
  const kora = await w.person("kora-corporate-owner");
  const koraGrantId = await w.h.grantKauroOwner(kora.userId);
  // the agency's current reviewed profile version: the quotes of this world are issued under it (recordProfileVersion moves it)
  let profileId = await recordReviewedFiscalProfile(w.h, { operatorUserId: kora.userId as UserId, agencyId: w.A.agencyId, issuerRef });
  const reconciler = createCommerceReconciler({ subjects: purchasedSubjectReader, approvalHosts: provider.approvalHosts });
  const oracle = w.h.oracle;

  const approvedPlan = async (label: string): Promise<{ readonly plan: PlanFixture; readonly projectId: ProjectId }> => {
    const { projectId } = await w.project(w.A, w.clientA);
    const plan = await w.approvable(w.A, projectId, label);
    await approveThroughRoute(w, plan);
    return { plan, projectId };
  };

  const pw: PaymentsWorld = {
    w,
    clock,
    provider,
    capacity,
    sources,
    verifier,
    holds,
    route,
    issuerRef,
    get profileId() {
      return profileId;
    },
    kora,
    koraGrantId,
    reconciler,

    async readyQuote(label, treatment) {
      const { plan } = await approvedPlan(label);
      const quote = await issueQuote(w.h, { agency: w.A, planId: plan.planId as PlanId, issuerRef, profileId, ...(treatment !== undefined ? { treatment } : {}) });
      const r = await oracle.query<{ revision_id: string; sealed_at: Date }>("SELECT revision_id, sealed_at FROM kauro.dataset_revisions WHERE manifest_hash = $1", [quote.revisionHash]);
      const revision = r.rows[0];
      if (!revision) throw new Error("the quoted revision is not sealed");
      // B07's retention record of the sealed revision (SIMULATED until B07 is on main): available for the quote's promise
      sources.set(quote.revisionHash as Sha256Hex, sealedAvailability(revision.revision_id, toUtcInstant(revision.sealed_at.getTime()), quote.sourceAvailableUntil));
      return { ...quote, plan, revisionId: revision.revision_id };
    },

    async paidProject(label, treatment = "EXEMPT_EXPORT") {
      const { plan } = await approvedPlan(label);
      const purchase = await paidPurchase(w.h, { agency: w.A, planId: plan.planId as PlanId, route, issuerRef, profileId, treatment });
      return { ...purchase, plan };
    },

    recordProfileVersion(treatment) {
      return w.h.commerce.run(w.h.operator(kora.userId as UserId), async (uow) => {
        await uow.adoptFinanceScope(w.A.agencyId);
        const current = await uow.commerce.fiscal.currentProfile(w.A.agencyId);
        const profileId = uow.ids.next() as FiscalProfileId;
        const recordedAt = toUtcInstant(Date.now());
        const reviewed = treatment !== "REVIEW_REQUIRED";
        await uow.commerce.fiscal.recordProfile({
          profileId,
          agencyId: w.A.agencyId,
          operatorLegalRef: issuerRef,
          customerLegalRef: uow.ids.next(),
          serviceClassification: "Data services",
          territory: "Colombia and abroad",
          taxTreatment: treatment,
          taxRule: treatment === "REVIEW_REQUIRED" ? "UNRESOLVED" : treatment === "EXEMPT_EXPORT" ? "ZERO_REVIEWED" : "RATE_HALF_UP",
          taxRateBps: treatment === "DOMESTIC_TAXABLE" ? 1900 : 0,
          evidenceHash: sha(`fiscal-evidence-${profileId}`),
          ...(treatment === "EXEMPT_EXPORT" ? { exportEvidenceHash: sha(`export-facts-${profileId}`) } : {}),
          ...(reviewed ? { reviewedByUserId: kora.userId as UserId } : {}),
          validFrom: toUtcInstant(Date.parse(recordedAt) - 24 * 3_600_000),
          ...(current !== null ? { supersedesProfileId: current.profileId } : {}),
          recordedAt,
        });
        return profileId;
      }).then((recorded) => {
        if (treatment !== "REVIEW_REQUIRED") profileId = recorded;
        return recorded;
      });
    },

    async applyWebhook(eventType, subjectId) {
      const { bytes } = provider.webhookBody(eventType, subjectId);
      const verified = await verifier.verify({ bytes, headers: verifier.sign(bytes), receivedAt: clock.now() });
      if (verified.kind !== "VERIFIED") throw new Error(`the verifier refused the provider's own event: ${verified.reason}`);
      const event = verified.event;
      const recorded = await w.h.inboxIngress.record({ inboxId: ids.next() as InboxId, provider: event.provider, environment: event.environment, externalEventId: event.externalEventId, bodyHash: event.bodyHash, receivedAt: clock.now() });
      const applied = await w.h.commerce.run(w.h.service(), (uow) => reconciler.applyProviderEvent(uow, { event, inboxId: recorded.inboxId, causationId: ids.next() as CausationId, now: clock.now() }));
      return { inboxId: recorded.inboxId, outcome: applied.kind === "APPLIED" ? "APPLIED" : `EXCEPTION ${applied.exceptionKind}` };
    },

    async effects() {
      const r = await oracle.query<Record<CommerceTable, string>>(`SELECT ${COMMERCE_TABLES.map((t) => `(SELECT count(*) FROM kauro.${t})::text AS ${t}`).join(", ")}`);
      const row = r.rows[0];
      if (!row) throw new Error("the count query returned no row");
      const out = {} as Record<CommerceTable, number>;
      for (const t of COMMERCE_TABLES) out[t] = Number(row[t]);
      const e = provider.effects;
      return { ...out, providerCalls: provider.calls.length, providerEffects: `${e.ordersCreated}/${e.captures}/${e.refunds}` };
    },

    async events(kind, id) {
      const r = await oracle.query<{ aggregate_version: string; event_type: string; actor_kind: string; actor_id: string | null; payload: Record<string, unknown>; event_id: string }>(
        "SELECT aggregate_version, event_type, actor_kind, actor_id, payload, event_id FROM kauro.domain_events WHERE aggregate_kind = $1 AND aggregate_id = $2 ORDER BY aggregate_version",
        [kind, id],
      );
      return r.rows.map((x) => ({ version: Number(x.aggregate_version), type: x.event_type, actor: x.actor_kind === "SERVICE" ? `SERVICE ${x.actor_id}` : x.actor_kind, payload: x.payload, eventId: x.event_id }));
    },

    stop: () => w.stop(),
  };
  return pw;
}

// --- routes and calls ----------------------------------------------------------------------------------------------------------------

export const paymentRoutes = {
  createPaymentOrder: (quoteId: string) => `/api/v1/quotes/${quoteId}/payment-orders`,
  capturePayment: (orderId: string) => `/api/v1/payment-orders/${orderId}/capture`,
  requestRefund: (projectId: string) => `/api/v1/projects/${projectId}/refund-requests`,
  approveRefund: (refundId: string) => `/api/v1/refunds/${refundId}/approve`,
  getQuote: (quoteId: string) => `/api/v1/quotes/${quoteId}`,
  getPaymentOrder: (orderId: string) => `/api/v1/payment-orders/${orderId}`,
  getRefund: (refundId: string) => `/api/v1/refunds/${refundId}`,
  getRefundReview: (refundId: string) => `/api/v1/operations/refunds/${refundId}`,
};

/** A read of the agency (GET, no body, no key). */
export function read(w: World, url: string, token: string, agency: string | null = w.A.agencyId): Promise<Reply> {
  return call(w, { method: "GET", url, token, key: null, agency, contentType: null });
}

/** The READ envelope's data of a 200 reply, or a failure naming the reply. */
export function readData<T>(reply: Reply): T {
  if (reply.status !== 200) throw new Error(`expected 200, got ${reply.status}: ${reply.text}`);
  const body = reply.json<{ kind: string; data: T }>();
  if (body.kind !== "READ") throw new Error(`expected a READ reply: ${reply.text}`);
  return body.data;
}

/** The ACCEPTED envelope of a 202 reply. */
export function accepted(reply: Reply): { readonly kind: "ACCEPTED"; readonly operationId: string; readonly state: string; readonly statusPath: string; readonly pollAfterSeconds: number } {
  if (reply.status !== 202) throw new Error(`expected 202, got ${reply.status}: ${reply.text}`);
  return reply.json();
}

/** The provider's view of an instant `hours` after now (for the fakes' deadlines). */
export function hoursFromNow(clock: Clock, hours: number): UtcInstant {
  return toUtcInstant(clock.nowMs() + hours * 3_600_000);
}

export { freshKey };

/** The registered consumers of a commerce event type, sorted (an outbox record reaches only these; D-EVT-B3). */
export function subscribersOf(type: string): string[] {
  return COMMERCE_EVENT_SUBSCRIPTIONS.filter((s) => s.eventType === type).map((s) => s.consumer).sort();
}
