// Orchestration tests of the commerce core's executors (implementation mandate M2; design §3.4, §6.1, §6.3): the CommerceReconciler,
// the provider-effect runtime (providerEffectPhases, runProviderCommand) and the CommerceAuthorizer, over the in-memory commerce store
// (B06's createInMemoryPorts extended under its rule: pure orchestration only, never a database, never case evidence) and the
// labelled contract fakes of the payment provider and the webhook verifier (SIMULATED). What PostgreSQL 17 decides — row locks, the
// KP guards, the policies of kauro_app and kauro_payment — is M1's and the command tests' (M3, M4). The command halves used here (the
// intent and the conclusion of a provider command) are minimal test hooks, not the handlers of CMD028, CMD029 or CMD033 (M4, M3).
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgencyId,
  AssuranceProofId,
  EvidenceArtifactRef,
  CommerceUnitOfWork,
  IdempotencyIdentity,
  InboxId,
  JournalEntryId,
  NormalizedProviderEvent,
  ObservedCapture,
  PaymentOrderId,
  PaymentOrderRecord,
  RefundComponents,
  RefundId,
  RefundPolicyId,
  RefundPolicyRecord,
  UserId,
} from "@kauro/domain";
import { COMMERCE_EVENT_SUBSCRIPTIONS, DomainFailure, NotAuthorizedFailure, NotFoundFailure, isBalanced, paymentIntentHash, policyCovers, providerRequestHash, refundableBalance } from "@kauro/domain";
import {
  attemptRequest,
  createCommerceAuthorizer,
  createCommerceReconciler,
  operationOf,
  planPostings,
  prepareProviderAttempt,
  providerEffectPhases,
  publishVersionEvent,
  runProviderCommand,
  versionEvent,
  type AssuranceOutcome,
  type AssuranceVerifier,
  type CommandResult,
  type CommerceReconciler,
  type DurableOperation,
  type ProtocolPoint,
  type ProviderCommandHooks,
  type ProviderCommandRun,
  type ProviderEffect,
} from "../src/index.js";
import { createEvidenceStoreFake, createWebhookVerifierFake, type WebhookVerifierFake } from "../src/commerce/testing/index.js";
import { R2_077, commerceWorld, sha, type CommerceWorld } from "./commerce-support.js";

// --- fixtures ----------------------------------------------------------------------------------------------------------------------

function reconcilerOf(w: CommerceWorld): CommerceReconciler {
  return createCommerceReconciler({ subjects: w.ports.subjects, approvalHosts: w.provider.approvalHosts });
}

interface Delivery {
  readonly event: NormalizedProviderEvent;
  readonly inboxId: InboxId;
  readonly recorded: "RECORDED" | "DUPLICATE" | "BODY_CONFLICT";
}

/** The provider's own webhook about one of its objects, verified over its exact bytes and recorded by the ingress half. */
async function deliver(w: CommerceWorld, verifier: WebhookVerifierFake, eventType: string, subjectId: string, options?: Parameters<CommerceWorld["provider"]["webhookBody"]>[2]): Promise<Delivery> {
  const { bytes } = w.provider.webhookBody(eventType, subjectId, options);
  const verified = await verifier.verify({ bytes, headers: verifier.sign(bytes), receivedAt: w.clock.now() });
  if (verified.kind !== "VERIFIED") throw new Error(`the verifier refused the provider's own event: ${verified.reason}`);
  const e = verified.event;
  const recorded = w.ports.recordDelivery({ provider: e.provider, environment: e.environment, externalEventId: e.externalEventId, bodyHash: e.bodyHash });
  return { event: e, inboxId: recorded.inboxId, recorded: recorded.kind };
}

function applyWebhook(w: CommerceWorld, reconciler: CommerceReconciler, d: Delivery) {
  return w.ports.unitOfWork.run(w.service(), (uow) => reconciler.applyProviderEvent(uow, { event: d.event, inboxId: d.inboxId, causationId: w.causation(), now: w.clock.now() }));
}

const subscribersOf = (type: string): string[] => COMMERCE_EVENT_SUBSCRIPTIONS.filter((s) => s.eventType === type).map((s) => s.consumer).sort();
const outboxOf = (w: CommerceWorld, eventId: string): string[] => w.store().base.outbox.filter((o) => o.eventId === eventId).map((o) => o.consumer).sort();
const eventTypes = (w: CommerceWorld): string[] => w.store().base.events.map((e) => e.eventType);
const PAYMENT_SERVICE = { kind: "SERVICE", serviceId: "payment-service" } as const;

/** An order whose capture completed at the provider and was applied from the provider's webhook: CAPTURED and entitled. */
async function paidOrder(w: CommerceWorld): Promise<{ readonly order: PaymentOrderRecord; readonly providerCaptureId: string }> {
  const order = await w.seedOrder("APPROVED");
  const providerCaptureId = w.provider.captureAtProvider(order.providerOrderId!);
  const d = await deliver(w, createWebhookVerifierFake({ clock: w.clock }), "PAYMENT.CAPTURE.COMPLETED", providerCaptureId);
  const applied = await applyWebhook(w, reconcilerOf(w), d);
  assert.equal(applied.kind === "APPLIED" ? applied.result.authorizationIssued !== null : false, true);
  return { order: w.store().orders.get(order.orderId)!, providerCaptureId };
}

/** An agency's refund request (the request handlers) approved by a corporate owner in its finance scope (the minimal CMD031/CMD032). */
async function approvedRefund(w: CommerceWorld, order: PaymentOrderRecord, amounts: RefundComponents): Promise<RefundId> {
  const capture = [...w.store().captures.values()].find((c) => c.orderId === order.orderId)!;
  const now = w.clock.now();
  const refundId = await w.ports.unitOfWork.run(w.tenant(), async (uow) => {
    const id = uow.ids.next() as RefundId;
    await uow.commerce.refunds.request({ refundId: id, agencyId: w.agencyId, projectId: w.projectId, orderId: order.orderId, captureId: capture.captureId, origin: "CUSTOMER_REQUEST", reasonCode: "The customer cancelled the project", termsHash: order.termsHash, deliveryPhase: "PRE_EXECUTION", proposed: amounts, requestedByMembershipId: w.billing.membershipId, requestedByUserId: w.billing.userId, requestedAt: now });
    await publishVersionEvent(uow, versionEvent("refund", id, 1, w.agencyId, { previousState: null, state: "REQUESTED" }, { refundId: id, agencyId: w.agencyId, projectId: w.projectId, orderId: order.orderId, captureId: capture.captureId, origin: "CUSTOMER_REQUEST", deliveryPhase: "PRE_EXECUTION", proposedServiceCents: amounts.serviceCents, proposedTaxCents: amounts.taxCents, proposedExcessCents: amounts.excessCents }), w.causation());
    await uow.scopes.record({ kind: "REFUND", key: id, agencyId: w.agencyId, orderId: order.orderId, refundId: id }, now);
    return id;
  });
  await w.ports.unitOfWork.run(w.operator(), async (uow) => {
    assert.equal(await uow.adoptScope("REFUND", refundId), w.agencyId);
    const approval = { amounts, authorizationKind: "OWNER_STEP_UP" as const, authorizationHash: sha(`authorization-${refundId}`), effectsHash: sha(`effects-${refundId}`), creditNoteRequired: true, approvedByUserId: w.owner.userId, approvedAt: now };
    const written = await uow.commerce.refunds.approve(refundId, 1, approval, now);
    assert.equal(written.kind, "APPLIED");
    await publishVersionEvent(uow, versionEvent("refund", refundId, 2, w.agencyId, { previousState: "REQUESTED", state: "APPROVED" }, { refundId, agencyId: w.agencyId, captureId: capture.captureId, serviceCents: amounts.serviceCents, taxCents: amounts.taxCents, excessCents: amounts.excessCents, authorizationKind: approval.authorizationKind, authorizationHash: approval.authorizationHash, effectsHash: approval.effectsHash, creditNoteRequired: true, previousState: "REQUESTED" }), w.causation());
  });
  return refundId;
}

// --- minimal command halves (the real ones are M4's CMD028/CMD029 and M3's CMD033) ------------------------------------------------------

type OrderView = { readonly order: { readonly orderId: string; readonly state: string; readonly version: number; readonly providerOrderId: string | null } };
type CaptureView = OrderView & { readonly captureIds: ReadonlyArray<string>; readonly authorizationId: string | null };
type RefundView = { readonly refund: { readonly refundId: string; readonly state: string; readonly version: number } };
type Body = Record<string, never>;

function orderViewOf(order: PaymentOrderRecord): OrderView["order"] {
  return { orderId: order.orderId, state: order.state, version: order.version, providerOrderId: order.providerOrderId ?? null };
}

const entryOf = (causationId: unknown): JournalEntryId => causationId as JournalEntryId;

function createOrderHooks(w: CommerceWorld): ProviderCommandHooks<Body, OrderView> {
  return {
    async intent(uow, _body, causationId, now) {
      const entryId = entryOf(causationId);
      const route = await uow.commerce.routes.findQualified("paypal", "SANDBOX");
      if (route === null) throw new Error("the fixture route is qualified");
      const q = w.quote;
      const orderId = uow.ids.next() as PaymentOrderId;
      const idempotencyHash = paymentIntentHash({ quoteId: q.quoteId, termsHash: q.termsHash, expectedAmountCents: q.totalCents.toString(), currency: "USD", routeId: route.routeId, provider: route.provider, environment: route.environment });
      const order = await uow.commerce.orders.insert({ orderId, agencyId: w.agencyId, projectId: w.projectId, quoteId: q.quoteId, approvalId: q.approvalId, route, expectedAmountCents: q.totalCents, expectedServiceCents: q.serviceCents, expectedTaxCents: q.taxCents, termsHash: q.termsHash, idempotencyHash, createdByMembershipId: w.billing.membershipId, intentEntryId: entryId, createdAt: now });
      await publishVersionEvent(uow, versionEvent("payment_order", orderId, order.version, w.agencyId, { previousState: null, state: "INTENT_CREATED" }, { orderId, agencyId: w.agencyId, projectId: w.projectId, quoteId: q.quoteId, environment: route.environment, expectedAmountCents: q.totalCents, currency: "USD", idempotencyHash }), causationId);
      await uow.scopes.record({ kind: "PAYMENT_ORDER", key: orderId, agencyId: w.agencyId, orderId }, now);
      const attempt = await prepareProviderAttempt(uow, { adapter: w.provider, subject: { effect: "CREATE_ORDER", order }, ordinal: 1, intentEntryId: entryId, causationId, now });
      return { kind: "DISPATCH", operation: await operationOf(uow, "CREATE_ORDER", entryId, attempt) };
    },
    async conclude(serviceUow, operation) {
      const order = await serviceUow.commerce.orders.get(operation.resource.id as PaymentOrderId);
      if (order === null) throw new Error("the settled order is visible to the payment service");
      return { kind: "CONCLUSIVE", status: 201, view: { order: orderViewOf(order) }, version: order.version, resourceKind: "payment_order", resourceId: order.orderId };
    },
  };
}

function captureHooks(w: CommerceWorld, orderId: PaymentOrderId): ProviderCommandHooks<Body, CaptureView> {
  return {
    async intent(uow, _body, causationId, now) {
      const entryId = entryOf(causationId);
      const order = await uow.commerce.orders.lock(orderId);
      if (order === null) throw new NotFoundFailure("payment_order");
      if (order.state !== "CREATED" && order.state !== "APPROVED") throw new DomainFailure("PRECONDITION_FAILED", "the order is not capturable", { reason: "ORDER_NOT_CAPTURABLE" });
      const attempt = await prepareProviderAttempt(uow, { adapter: w.provider, subject: { effect: "CAPTURE", order }, ordinal: 1, intentEntryId: entryId, causationId, now });
      return { kind: "DISPATCH", operation: await operationOf(uow, "CAPTURE", entryId, attempt) };
    },
    async conclude(serviceUow, operation) {
      const order = (await serviceUow.commerce.orders.get(operation.resource.id as PaymentOrderId))!;
      const captures = await serviceUow.commerce.captures.listForOrder(order.orderId);
      const live = captures.length === 0 ? null : await serviceUow.commerce.authorizations.findLiveByCapture(captures[0]!.captureId);
      return { kind: "CONCLUSIVE", status: 200, view: { order: orderViewOf(order), captureIds: captures.map((c) => c.captureId), authorizationId: live?.authorizationId ?? null }, version: order.version, resourceKind: "payment_order", resourceId: order.orderId };
    },
  };
}

function refundHooks(w: CommerceWorld, refundId: RefundId): ProviderCommandHooks<Body, RefundView> {
  return {
    async intent(uow, _body, causationId, now) {
      const entryId = entryOf(causationId);
      const refund = await uow.commerce.refunds.lock(refundId);
      if (refund === null) throw new NotFoundFailure("refund");
      if (refund.state !== "APPROVED") throw new DomainFailure("PRECONDITION_FAILED", "only an approved refund is executed", { reason: "REFUND_NOT_APPROVED" });
      const order = (await uow.commerce.orders.get(refund.orderId))!;
      const capture = (await uow.commerce.captures.get(refund.captureId))!;
      const attempt = await prepareProviderAttempt(uow, { adapter: w.provider, subject: { effect: "REFUND", order, refund, capture }, ordinal: 1, intentEntryId: entryId, causationId, now });
      return { kind: "DISPATCH", operation: await operationOf(uow, "REFUND", entryId, attempt) };
    },
    async conclude(serviceUow, operation) {
      const refund = (await serviceUow.commerce.refunds.get(operation.resource.id as RefundId))!;
      return { kind: "CONCLUSIVE", status: 200, view: { refund: { refundId: refund.refundId, state: refund.state, version: refund.version } }, version: refund.version, resourceKind: "refund", resourceId: refund.refundId };
    },
  };
}

interface RunOptions {
  readonly key: string;
  readonly operation: "CMD028" | "CMD029" | "CMD033";
  readonly digest?: string;
  readonly crashAt?: ProtocolPoint;
  readonly denied?: DomainFailure;
  /** A SERVICE principal (CMD033) acting on its stored operation; otherwise the agency's billing member (TENANT). */
  readonly storedOperation?: { readonly kind: "PAYMENT_ORDER" | "REFUND"; readonly key: string };
  readonly inspect?: (point: ProtocolPoint, operation: DurableOperation | null) => void;
}

function commandRun<View>(w: CommerceWorld, effect: ProviderEffect, hooks: ProviderCommandHooks<Body, View>, o: RunOptions): { readonly run: ProviderCommandRun<Body, View>; readonly denials: DomainFailure[] } {
  const stored = o.storedOperation;
  const context = stored !== undefined ? w.service() : w.tenant();
  const identity: IdempotencyIdentity = { environment: "SANDBOX", actor: stored !== undefined ? PAYMENT_SERVICE : { kind: "USER", userId: w.billing.userId }, agencyId: w.agencyId, operation: o.operation, key: o.key };
  const denials: DomainFailure[] = [];
  const run: ProviderCommandRun<Body, View> = {
    effect,
    phases: providerEffectPhases(effect, { adapter: w.provider, reconciler: reconcilerOf(w), clock: w.clock }, hooks),
    adapter: w.provider,
    clock: w.clock,
    principal: { unitOfWork: w.ports.unitOfWork, context, ...(stored !== undefined ? { storedOperation: stored } : {}) },
    service: { unitOfWork: w.ports.unitOfWork, context: w.service() },
    identity,
    digest: o.digest ?? sha("the request body"),
    correlationId: context.correlationId,
    body: {},
    async access(uow) {
      if (o.denied !== undefined) throw o.denied;
      // a SERVICE principal's scope is its stored operation's (D-SCOPE-B1): adopted with the access decision
      if (stored !== undefined && (await uow.adoptScope(stored.kind, stored.key)) === null) throw new NotFoundFailure(stored.kind === "REFUND" ? "refund" : "payment_order");
    },
    async recordDenial(failure) {
      denials.push(failure);
    },
    async hold(point, operation) {
      o.inspect?.(point, operation);
      if (point === o.crashAt) throw new Error(`crash injected at ${point}`);
    },
  };
  return { run, denials };
}

const dispatches = (w: CommerceWorld, endpoint: string) => w.provider.calls.filter((c) => c.operation === `DISPATCH ${endpoint}`);
const completed = <V>(r: CommandResult<V>): Extract<CommandResult<V>, { kind: "COMPLETED" }> => {
  assert.equal(r.kind, "COMPLETED", JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  return r as Extract<CommandResult<V>, { kind: "COMPLETED" }>;
};
const journalEntries = (w: CommerceWorld) => [...w.store().base.journal.values()];

// --- the reconciler ------------------------------------------------------------------------------------------------------------

test("CommerceReconciler — a verified capture webhook is attributed through the scope index, never a payload's agency, and applied in one SERVICE unit of work: the capture fact with its allocation, the CAPTURED order and one CommercialAuthorization, each version with exactly the event commerceVersionEventType names and outbox records only for its subscribers, whoever publishes it (D-CORE-B1); the inbox record is APPLIED with the first event, and a redelivery adds nothing", async () => {
  for (const publication of ["CALLER", "ADAPTER"] as const) {
    const w = commerceWorld({ publication });
    const verifier = createWebhookVerifierFake({ clock: w.clock });
    const reconciler = reconcilerOf(w);
    const order = await w.seedOrder("APPROVED");
    const providerCaptureId = w.provider.captureAtProvider(order.providerOrderId!);
    const d = await deliver(w, verifier, "PAYMENT.CAPTURE.COMPLETED", providerCaptureId);
    assert.equal(d.recorded, "RECORDED");
    let adopted: string | null = "none";
    const applied = await w.ports.unitOfWork.run(w.service(), async (uow) => {
      assert.equal(uow.commerceScope, null, "a SERVICE unit of work starts with no agency (D-SCOPE-B1)");
      const r = await reconciler.applyProviderEvent(uow, { event: d.event, inboxId: d.inboxId, causationId: w.causation(), now: w.clock.now() });
      adopted = uow.commerceScope;
      return r;
    });
    assert.equal(adopted, w.agencyId, `${publication}: the agency of the provider order the scope index holds`);
    assert.equal(applied.kind, "APPLIED");
    if (applied.kind !== "APPLIED") return;
    const s = w.store();
    const [capture, ...others] = [...s.captures.values()];
    assert.equal(others.length, 0);
    assert.deepEqual([capture!.status, capture!.providerCaptureId, capture!.amountCents, capture!.fundsState, capture!.firstObservationSource], ["COMPLETED", providerCaptureId, R2_077.total, "UNKNOWN", "WEBHOOK"]);
    assert.deepEqual(capture!.allocation, { serviceCents: R2_077.service, taxCents: R2_077.tax, excessCents: 0n });
    assert.deepEqual([s.orders.get(order.orderId)!.state, s.orders.get(order.orderId)!.allocatedCents], ["CAPTURED", R2_077.total]);
    const authorizations = [...s.authorizations.values()];
    assert.equal(authorizations.length, 1);
    assert.deepEqual([authorizations[0]!.state, authorizations[0]!.captureId, authorizations[0]!.quoteId], ["ACTIVE", capture!.captureId, w.quote.quoteId]);
    assert.equal(applied.result.authorizationIssued, authorizations[0]!.authorizationId);
    assert.deepEqual(eventTypes(w), ["payment_order.captured.v1", "capture.completed.v1", "commercial_authorization.issued.v1"]);
    for (const e of s.base.events) {
      assert.deepEqual(e.actor, PAYMENT_SERVICE, "a provider fact and an entitlement are the payment service's (D-AUTH-B4)");
      assert.deepEqual(outboxOf(w, e.eventId), subscribersOf(e.eventType), `${e.eventType}: its outbox records reach its subscribers only`);
    }
    assert.equal(s.scopes.get(`PROVIDER_CAPTURE|paypal|SANDBOX|${providerCaptureId}`)?.captureId, capture!.captureId, "the provider key it learned (D-SCOPE-B2)");
    assert.deepEqual(s.observations.map((o) => [o.source, o.inboxId, o.subjectKind, o.effect]), [["WEBHOOK", d.inboxId, "CAPTURE", "ADVANCED"]]);
    const inbox = s.inbox.get(d.inboxId)!;
    assert.deepEqual([inbox.state, inbox.resultEventId], ["APPLIED", s.base.events[0]!.eventId]);
    assert.equal(applied.result.resultEventId, s.base.events[0]!.eventId);

    // the same event delivered again is the same inbox record; the settled record applies nothing again
    const again = await deliver(w, verifier, "PAYMENT.CAPTURE.COMPLETED", providerCaptureId, { eventId: d.event.externalEventId });
    assert.deepEqual([again.recorded, again.inboxId], ["DUPLICATE", d.inboxId]);
    const replay = await applyWebhook(w, reconciler, again);
    assert.ok(replay.kind === "APPLIED" && replay.result.effects.length === 0 && replay.result.resultEventId === s.base.events[0]!.eventId);
    assert.equal(w.store().base.events.length, 3, "no second capture, entitlement or commission event");
  }
});

test("CommerceReconciler — what no order can take is a provider exception, never a fact of an order (S058, D-ING-B2, D-ING-B3): an unknown provider reference is unattributed and IGNORED with no agency adopted, a capture paid to another payee is WRONG_PAYEE of the order and REJECTED, and a record whose event id arrived with another body is never APPLIED (BODY_CONFLICT, REJECTED)", async () => {
  const w = commerceWorld();
  const verifier = createWebhookVerifierFake({ clock: w.clock });
  const reconciler = reconcilerOf(w);
  const order = await w.seedOrder("APPROVED");

  // a provider order no platform order learned (made at the provider outside the platform)
  const strayRequest = w.provider.prepareCreateOrder({ orderId: "stray", attemptId: w.ids.next(), providerRequestId: "kauro-stray", amountCents: 100n, currency: "USD", description: "KAURO_PROJECT_PREPARATION", returnPath: "/r", cancelPath: "/c" });
  const stray = await w.provider.dispatch(strayRequest, new Date(w.clock.nowMs() + 60_000).toISOString());
  if (stray.kind !== "ORDER_CREATED") throw new Error("the fake creates by default");
  w.provider.approve(stray.providerOrderId);
  const unknown = await deliver(w, verifier, "PAYMENT.CAPTURE.COMPLETED", w.provider.captureAtProvider(stray.providerOrderId));
  const r1 = await w.ports.unitOfWork.run(w.service(), async (uow) => {
    const r = await reconciler.applyProviderEvent(uow, { event: unknown.event, inboxId: unknown.inboxId, causationId: w.causation(), now: w.clock.now() });
    assert.equal(uow.commerceScope, null, "nothing is adopted from a guess");
    return r;
  });
  assert.deepEqual(r1, { kind: "EXCEPTION", exceptionKind: "UNKNOWN_PROVIDER_REFERENCE" });
  const x1 = w.store().exceptions.find((x) => x.inboxId === unknown.inboxId)!;
  assert.deepEqual([x1.source, x1.kind, x1.agencyId, x1.orderId], ["WEBHOOK", "UNKNOWN_PROVIDER_REFERENCE", undefined, undefined]);
  assert.equal(w.store().inbox.get(unknown.inboxId)!.state, "IGNORED");

  // a capture of the order paid to another merchant: the order's own exception, the record REJECTED, no capture fact
  const wrong = await deliver(w, verifier, "PAYMENT.CAPTURE.COMPLETED", w.provider.captureAtProvider(order.providerOrderId!, { merchantId: "ANOTHERMERCHANT" }));
  assert.deepEqual(await applyWebhook(w, reconciler, wrong), { kind: "EXCEPTION", exceptionKind: "WRONG_PAYEE" });
  const x2 = w.store().exceptions.find((x) => x.inboxId === wrong.inboxId)!;
  assert.deepEqual([x2.source, x2.kind, x2.agencyId, x2.orderId, x2.amountCents], ["WEBHOOK", "WRONG_PAYEE", w.agencyId, order.orderId, R2_077.total]);
  assert.equal(w.store().inbox.get(wrong.inboxId)!.state, "REJECTED");
  assert.equal(w.store().captures.size, 0);
  assert.equal(w.store().orders.get(order.orderId)!.state, "APPROVED");
  assert.deepEqual(w.store().observations.map((o) => o.effect), ["MISMATCH"]);

  // the same event id delivered with another body: a recorded conflict, never absorbed and never applied
  const genuine = await deliver(w, verifier, "CHECKOUT.ORDER.APPROVED", order.providerOrderId!, { eventId: "WH-CONFLICTING" });
  const other = await deliver(w, verifier, "CHECKOUT.ORDER.APPROVED", order.providerOrderId!, { eventId: "WH-CONFLICTING", overrides: { status: "VOIDED" } });
  assert.deepEqual([other.recorded, other.inboxId], ["BODY_CONFLICT", genuine.inboxId]);
  assert.deepEqual(await applyWebhook(w, reconciler, genuine), { kind: "EXCEPTION", exceptionKind: "BODY_CONFLICT" });
  assert.equal(w.store().inbox.get(genuine.inboxId)!.state, "REJECTED");
  assert.equal(w.store().base.events.length, 0, "no fact of any order changed");
});

test("CommerceReconciler — D-PAY-B6 (residual FINAL-N2): a reversal webhook without the capture's completion instant applies nothing and leaves its record RETRYABLE; a stored provider query then records the completion and the reversal (D-PAY-B5), whose events source the CAPTURE and CHARGEBACK postings once; the record's retry is a duplicate — a tax point is never invented", async () => {
  const w = commerceWorld();
  const verifier = createWebhookVerifierFake({ clock: w.clock });
  const reconciler = reconcilerOf(w);
  const order = await w.seedOrder("APPROVED");
  const providerCaptureId = w.provider.captureAtProvider(order.providerOrderId!);
  const completedAt = w.clock.now();
  w.clock.advance(3_600_000);
  w.provider.updateCapture(providerCaptureId, { status: "REVERSED" });
  const d = await deliver(w, verifier, "PAYMENT.CAPTURE.REVERSED", providerCaptureId);
  assert.equal(d.event.capture?.providerCompletedAt, null, "the reversal's resource carries the reversal's times only");
  const first = await applyWebhook(w, reconciler, d);
  assert.ok(first.kind === "APPLIED" && first.result.providerQueryRequired);
  assert.equal(w.store().inbox.get(d.inboxId)!.state, "RETRYABLE");
  assert.deepEqual([w.store().captures.size, w.store().observations.length, w.store().base.events.length], [0, 0, 0]);

  // the watchdog's stored provider query (CMD034's observationRef): the provider's view with the completion instant
  const evidence = createEvidenceStoreFake({ clock: w.clock });
  const view = await w.provider.observeOrder({ providerOrderId: order.providerOrderId! });
  const bytes = new TextEncoder().encode(JSON.stringify(view, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  const { artifactRef } = await evidence.put({ kind: "PROVIDER_QUERY", provider: "paypal", environment: "SANDBOX", capturedAt: w.clock.now(), authenticatedBy: "PROVIDER_API_RESPONSE", normalized: view, integrationClass: "CONTRACT_FAKE", bytes });
  const stored = await evidence.get(artifactRef);
  const query = await w.ports.unitOfWork.run(w.service(), async (uow) => {
    assert.equal(await uow.adoptScope("PAYMENT_ORDER", order.orderId), w.agencyId);
    return reconciler.applyOrderObservation(uow, { orderId: order.orderId, source: "PROVIDER_QUERY", observation: w.provider.classifyOrderObservation(stored!), artifactRef: artifactRef as EvidenceArtifactRef, causationId: w.causation(), now: w.clock.now() });
  });
  assert.equal(query.providerQueryRequired, false);
  const capture = [...w.store().captures.values()][0]!;
  assert.deepEqual([capture.status, capture.providerCompletedAt, capture.version], ["REVERSED", completedAt, 2], "completed then reversed, the completion instant kept as the tax point");
  assert.deepEqual(eventTypes(w), ["payment_order.captured.v1", "capture.completed.v1", "capture.reversed.v1", "reconciliation_case.opened.v1"]);
  assert.equal(w.store().authorizations.size, 0, "a reversed capture carries no authority");
  assert.deepEqual([...w.store().cases.values()].map((c) => [c.kind, c.captureId, c.orderId]), [["REVERSAL", capture.captureId, order.orderId]]);

  // FINANCE (M3's consumer) posts each event once: the completion's CAPTURE set and the reversal's CHARGEBACK set return it
  const sources = w.store().base.events.filter((e) => e.eventType === "capture.completed.v1" || e.eventType === "capture.reversed.v1");
  await w.ports.unitOfWork.run(w.service(), async (uow) => {
    await uow.adoptScope("PAYMENT_ORDER", order.orderId);
    for (const e of sources) {
      const plan = planPostings({ eventId: e.eventId, eventType: e.eventType, aggregateId: e.aggregateId, agencyId: e.agencyId as AgencyId, payload: e.payload, recordedAt: e.createdAt });
      assert.equal(plan.kind, "POST");
      if (plan.kind !== "POST") continue;
      assert.ok(isBalanced(plan.set.lines));
      assert.equal((await uow.commerce.ledger.post(plan.set, w.clock.now())).posted, true);
      assert.equal((await uow.commerce.ledger.post(plan.set, w.clock.now())).posted, false, "a replayed delivery posts nothing");
    }
  });
  const receivable = w.store().ledger.filter((l) => l.accountCode === "PSP_RECEIVABLE").reduce((n, l) => n + (l.direction === "DEBIT" ? l.amountCents : -l.amountCents), 0n);
  assert.deepEqual([...new Set(w.store().ledger.map((l) => l.sourceKind))].sort(), ["CAPTURE", "CHARGEBACK"]);
  assert.equal(receivable, 0n, "the chargeback returns what the capture brought in");

  // the webhook's retry: the reversal is already recorded — a duplicate, IGNORED
  const retry = await applyWebhook(w, reconciler, d);
  assert.ok(retry.kind === "APPLIED" && retry.result.effects.every((e) => e.effect === "DUPLICATE"));
  assert.equal(w.store().inbox.get(d.inboxId)!.state, "IGNORED");
  assert.equal(w.store().base.events.length, 4);
});

test("CommerceReconciler — only a SERVICE unit of work that adopted the stored operation's agency applies an observation (D-AUTH-B4, D-SCOPE-B1); a compare-and-swap lost to a concurrent writer aborts the whole application with a retryable STALE_VERSION and nothing of it commits; the retry applies it once", async () => {
  const w = commerceWorld();
  const reconciler = reconcilerOf(w);
  const order = await w.seedOrder("CAPTURING");
  const attempt = w.seedAttempt(order, "CAPTURE", "DISPATCHING");
  w.provider.captureAtProvider(order.providerOrderId!);
  const capture: ObservedCapture = (await w.provider.observeOrder({ providerOrderId: order.providerOrderId! })).captures[0]!;
  const input = { orderId: order.orderId, source: "DISPATCH_RESPONSE" as const, observation: { kind: "CAPTURE_OBSERVED" as const, capture }, attemptId: attempt.attemptId, causationId: w.causation(), now: w.clock.now() };
  const integrity = (e: unknown) => e instanceof DomainFailure && e.code === "INTEGRITY_FAILURE";
  await assert.rejects(w.ports.unitOfWork.run(w.tenant(), (uow) => reconciler.applyOrderObservation(uow, input)), integrity, "the request handlers never apply a provider result");
  await assert.rejects(w.ports.unitOfWork.run(w.service(), (uow) => reconciler.applyOrderObservation(uow, input)), integrity, "a SERVICE unit of work adopts its stored operation first");

  await assert.rejects(
    w.ports.unitOfWork.run(w.service(), async (uow) => {
      await uow.adoptScope("PAYMENT_ORDER", order.orderId);
      // a writer that does not take the order's row lock changed the attempt between the read and the write
      const attempts = { ...uow.commerce.attempts, transition: async () => ({ kind: "STALE" as const, currentVersion: attempt.version + 1, currentState: "UNCERTAIN" }) };
      const racing = Object.create(uow, { commerce: { value: { ...uow.commerce, attempts } } }) as CommerceUnitOfWork;
      return reconciler.applyOrderObservation(racing, input);
    }),
    (e: unknown) => e instanceof DomainFailure && e.code === "STALE_VERSION" && e.retryable && e.details.currentVersion === attempt.version + 1,
  );
  assert.deepEqual([w.store().captures.size, w.store().orders.get(order.orderId)!.state, w.store().base.events.length], [0, "CAPTURING", 0], "the unit of work rolled back as a whole");

  const applied = await w.ports.unitOfWork.run(w.service(), async (uow) => {
    await uow.adoptScope("PAYMENT_ORDER", order.orderId);
    return reconciler.applyOrderObservation(uow, input);
  });
  assert.notEqual(applied.authorizationIssued, null);
  assert.equal(w.store().attempts.get(attempt.attemptId)!.state, "CONFIRMED");
  assert.equal([...w.store().captures.values()][0]!.attemptId, attempt.attemptId, "the capture names the attempt of its own order (D-BIND-B2)");
});

test("CommerceReconciler — a capture's dispatch response and its webhook together yield one fact and one authorization, in either order: the first records the capture and issues the entitlement, the second confirms or duplicates it", async () => {
  for (const webhookFirst of [true, false]) {
    const w = commerceWorld();
    const verifier = createWebhookVerifierFake({ clock: w.clock });
    const reconciler = reconcilerOf(w);
    const order = await w.seedOrder("CAPTURING");
    const attempt = w.seedAttempt(order, "CAPTURE", "DISPATCHING");
    const providerCaptureId = w.provider.captureAtProvider(order.providerOrderId!);
    const response = (await w.provider.observeOrder({ providerOrderId: order.providerOrderId! })).captures[0]!;
    const d = await deliver(w, verifier, "PAYMENT.CAPTURE.COMPLETED", providerCaptureId);
    const settle = () =>
      w.ports.unitOfWork.run(w.service(), async (uow) => {
        await uow.adoptScope("PAYMENT_ORDER", order.orderId);
        return reconciler.applyOrderObservation(uow, { orderId: order.orderId, source: "DISPATCH_RESPONSE", observation: { kind: "CAPTURE_OBSERVED", capture: response }, attemptId: attempt.attemptId, causationId: w.causation(), now: w.clock.now() });
      });
    if (webhookFirst) {
      await applyWebhook(w, reconciler, d);
      const second = await settle();
      assert.deepEqual([second.authorizationIssued, second.effects], [null, [{ about: "CAPTURE", effect: "DUPLICATE" }]]);
    } else {
      await settle();
      const second = await applyWebhook(w, reconciler, d);
      assert.ok(second.kind === "APPLIED" && second.result.authorizationIssued === null);
      assert.equal(w.store().inbox.get(d.inboxId)!.state, "IGNORED");
    }
    const s = w.store();
    assert.deepEqual([s.captures.size, s.authorizations.size, s.orders.get(order.orderId)!.state, s.attempts.get(attempt.attemptId)!.state], [1, 1, "CAPTURED", "CONFIRMED"], webhookFirst ? "webhook first" : "response first");
    assert.equal(s.base.events.filter((e) => e.eventType === "capture.completed.v1").length, 1);
  }
});

test("publishVersionEvent (D-CORE-B1) — exactly one event per version whichever side writes it: an event its adapter already published for the version is used, never published twice, and one of another type than the planned one is INTEGRITY_FAILURE", async () => {
  const w = commerceWorld({ publication: "ADAPTER" });
  const order = await w.seedOrder("CREATED");
  await w.ports.unitOfWork.run(w.service(), async (uow) => {
    await uow.adoptScope("PAYMENT_ORDER", order.orderId);
    const written = await uow.commerce.orders.transition(order.orderId, order.version, { state: "APPROVED" }, w.clock.now());
    assert.equal(written.kind, "APPLIED");
    const planned = versionEvent("payment_order", order.orderId, order.version + 1, w.agencyId, { previousState: "CREATED", state: "APPROVED" }, { orderId: order.orderId, agencyId: w.agencyId, previousState: "CREATED" });
    const recorded = await publishVersionEvent(uow, planned, w.causation());
    assert.equal(uow.events.appended.length, 1);
    assert.equal(recorded.eventId, uow.events.appended[0]!.eventId);
    const other = versionEvent("payment_order", order.orderId, order.version + 1, w.agencyId, { previousState: "CREATED", state: "CANCELLED" }, { orderId: order.orderId, agencyId: w.agencyId });
    await assert.rejects(publishVersionEvent(uow, other, w.causation()), (e: unknown) => e instanceof DomainFailure && e.code === "INTEGRITY_FAILURE");
  });
  // a change the database would refuse has no event type at all: two provider facts in one capture version
  assert.throws(() => versionEvent("capture", order.orderId, 3, w.agencyId, { previousState: "COMPLETED", state: "COMPLETED", feeChanged: true, fundsChanged: true }, {}), /exactly one later provider fact/);
});

// --- the provider-effect runtime ------------------------------------------------------------------------------------------------

test("runProviderCommand — CREATE_ORDER: the intent (order INTENT_CREATED, attempt PREPARED with the digest of its exact request, journal RESERVED) commits before any provider call; the claim records the database's dispatch deadline with the creating edge; the payment service settles the provider order in its own unit of work; the journal commits 201; an identical retry replays with no call and the same key with another digest is IDEMPOTENCY_CONFLICT with no effect", async () => {
  const w = commerceWorld();
  const seen = new Map<ProtocolPoint, { readonly orders: number; readonly attempt: string | undefined; readonly order: string | undefined; readonly calls: number; readonly journal: string | undefined; readonly deadline: string | undefined }>();
  const snapshot = (point: ProtocolPoint) => {
    const s = w.store();
    const order = [...s.orders.values()][0];
    const attempt = [...s.attempts.values()][0];
    seen.set(point, { orders: s.orders.size, attempt: attempt?.state, order: order?.state, calls: w.provider.calls.length, journal: journalEntries(w)[0]?.state, deadline: attempt?.dispatchDeadlineAt });
  };
  const claimedAt = w.clock.nowMs();
  const { run } = commandRun(w, "CREATE_ORDER", createOrderHooks(w), { key: "create-order-key-0001", operation: "CMD028", inspect: snapshot });
  const result = completed(await runProviderCommand(run));
  assert.equal(result.status, 201);
  assert.equal(result.replayed, false);
  assert.deepEqual(seen.get("AFTER_INTENT"), { orders: 1, attempt: "PREPARED", order: "INTENT_CREATED", calls: 0, journal: "RESERVED", deadline: undefined }, "T1 committed before the call");
  assert.deepEqual(seen.get("AFTER_CLAIM"), { orders: 1, attempt: "DISPATCHING", order: "CREATING", calls: 0, journal: "RESERVED", deadline: new Date(claimedAt + 60_000).toISOString() }, "T2: the database's deadline, now + 60 s (D-PROTO-B6)");
  assert.equal(seen.get("AFTER_CALL")!.calls, 1);
  assert.equal(seen.get("AFTER_CALL")!.order, "CREATING", "nothing of the provider's answer is recorded before T3");

  const s = w.store();
  const order = [...s.orders.values()][0]!;
  const attempt = [...s.attempts.values()][0]!;
  assert.deepEqual([order.state, attempt.state, attempt.ordinal], ["CREATED", "CONFIRMED", 1]);
  assert.equal(attempt.requestHash, providerRequestHash(attemptRequest(w.provider, { effect: "CREATE_ORDER", order }, attempt.attemptId)), "the attempt recorded the digest of exactly the request it sent");
  assert.deepEqual(dispatches(w, "ORDERS_V2_CREATE").map((c) => c.identity), [`kauro-${attempt.attemptId}`]);
  assert.deepEqual(result.view, { order: { orderId: order.orderId, state: "CREATED", version: order.version, providerOrderId: order.providerOrderId } });
  assert.equal(s.scopes.get(`PROVIDER_ORDER|paypal|SANDBOX|${order.providerOrderId}`)?.orderId, order.orderId);
  const actors = s.base.events.map((e) => [e.eventType, e.actor.kind]);
  assert.deepEqual(actors, [
    ["payment_order.intent_created.v1", "USER"],
    ["payment_attempt.prepared.v1", "USER"],
    ["payment_attempt.dispatching.v1", "USER"],
    ["payment_order.creating.v1", "USER"],
    ["payment_order.created.v1", "SERVICE"],
    ["payment_attempt.confirmed.v1", "SERVICE"],
  ], "the request handlers write the intent and the claim, the payment service what the provider answered (D-AUTH-B4, D-PROTO-B5)");
  const entry = journalEntries(w)[0]!;
  assert.deepEqual([entry.state, entry.responseStatus, entry.resourceId], ["COMMITTED", 201, order.orderId]);

  const replay = completed(await runProviderCommand(commandRun(w, "CREATE_ORDER", createOrderHooks(w), { key: "create-order-key-0001", operation: "CMD028" }).run));
  assert.deepEqual([replay.replayed, replay.view], [true, result.view]);
  const conflict = await runProviderCommand(commandRun(w, "CREATE_ORDER", createOrderHooks(w), { key: "create-order-key-0001", operation: "CMD028", digest: sha("another body") }).run);
  assert.equal(conflict.kind === "CONFLICT" ? conflict.problem.code : conflict.kind, "IDEMPOTENCY_CONFLICT");
  assert.deepEqual([w.provider.calls.length, w.store().base.events.length, w.store().orders.size], [1, 6, 1], "neither the replay nor the conflict wrote or called anything");
});

test("runProviderCommand — crash injection on both sides of the intent commit and around the provider call: before the intent commits nothing is left and the same key is a new execution; after it, after the claim, after the call and after the settle, the same key converges to one provider order — after the call it is observed by the attempt's request identity, never created twice (D-PROTO-B2, D-CASEMAP-B1)", async () => {
  const points: ReadonlyArray<ProtocolPoint> = ["INTENT_BEFORE_COMMIT", "AFTER_INTENT", "AFTER_CLAIM", "AFTER_CALL", "AFTER_SETTLE"];
  for (const crashAt of points) {
    const w = commerceWorld();
    const key = `crash-${crashAt.toLowerCase().replace(/_/g, "-")}-0001`;
    await assert.rejects(runProviderCommand(commandRun(w, "CREATE_ORDER", createOrderHooks(w), { key, operation: "CMD028", crashAt }).run), /crash injected/);
    if (crashAt === "INTENT_BEFORE_COMMIT") {
      assert.deepEqual([w.store().orders.size, w.store().attempts.size, journalEntries(w).length, w.store().base.events.length, w.provider.calls.length], [0, 0, 0, 0, 0], "nothing survives a crash before the intent commits");
    }
    let result = await runProviderCommand(commandRun(w, "CREATE_ORDER", createOrderHooks(w), { key, operation: "CMD028" }).run);
    if (crashAt === "AFTER_CLAIM") {
      // the claim committed but the call never happened: until the dispatch deadline the provider's silence proves nothing
      assert.equal(result.kind, "ACCEPTED", `${crashAt}: 202 while the effect is unknown`);
      assert.equal(journalEntries(w)[0]!.state, "UNCERTAIN");
      w.clock.advance(61_000);
      result = await runProviderCommand(commandRun(w, "CREATE_ORDER", createOrderHooks(w), { key, operation: "CMD028" }).run);
    }
    const done = completed(result);
    assert.equal(done.status, 201, crashAt);
    const s = w.store();
    assert.equal(s.orders.size, 1, `${crashAt}: one order`);
    assert.equal(w.provider.effects.ordersCreated, 1, `${crashAt}: one provider order`);
    const order = [...s.orders.values()][0]!;
    assert.equal(order.state, "CREATED");
    assert.equal(done.view.order.providerOrderId, order.providerOrderId);
    const creates = dispatches(w, "ORDERS_V2_CREATE");
    const attempts = [...s.attempts.values()].sort((a, b) => a.ordinal - b.ordinal);
    if (crashAt === "AFTER_CLAIM") {
      assert.deepEqual(attempts.map((a) => [a.ordinal, a.state, a.outcomeCode]), [[1, "FAILED_NO_EFFECT", "NOT_FOUND_BY_REQUEST_ID"], [2, "CONFIRMED", undefined]], "the silent attempt proved no effect after its deadline; a new deliberate attempt (D-PROTO-B3)");
      assert.deepEqual(creates.map((c) => c.identity), [`kauro-${attempts[1]!.attemptId}`]);
    } else {
      assert.deepEqual(attempts.map((a) => a.state), ["CONFIRMED"]);
      assert.equal(creates.length, 1, `${crashAt}: one create call`);
    }
    if (crashAt === "AFTER_CALL") {
      assert.deepEqual(w.provider.calls.map((c) => c.operation), ["DISPATCH ORDERS_V2_CREATE", "OBSERVE_ORDER_BY_REQUEST"], "the resume observed by request identity");
      assert.equal(s.observations.at(-1)?.source, "DISPATCH_RESPONSE");
    }
    if (crashAt === "AFTER_SETTLE") assert.deepEqual(w.provider.calls.map((c) => c.operation), ["DISPATCH ORDERS_V2_CREATE"], "a crash between T3 and T4 repeats only T4");
    const entry = journalEntries(w);
    assert.deepEqual(entry.map((e) => [e.state, e.responseStatus]), [["COMMITTED", 201]], `${crashAt}: one journal entry, committed once`);
  }
});

test("runProviderCommand — an ambiguous creation answers 202 with the durable operation and leaves the journal UNCERTAIN with a visible case; the same key later observes the order by its request identity and commits 201 (one provider order); a creation that proved no effect takes a new deliberate attempt under a new request identity, and after the third the order FAILED", async () => {
  const w = commerceWorld();
  w.provider.program("ORDERS_V2_CREATE", { kind: "AMBIGUOUS", reason: "TIMEOUT", effect: "APPLIED" });
  const key = "ambiguous-create-0001";
  const first = await runProviderCommand(commandRun(w, "CREATE_ORDER", createOrderHooks(w), { key, operation: "CMD028" }).run);
  assert.equal(first.kind, "ACCEPTED");
  if (first.kind !== "ACCEPTED") return;
  const order = [...w.store().orders.values()][0]!;
  const attempt = [...w.store().attempts.values()][0]!;
  assert.deepEqual([first.status, first.operationId, first.state, first.statusPath, first.pollAfterSeconds], [202, order.orderId, "CREATING", `/api/v1/payment-orders/${order.orderId}`, 5]);
  assert.deepEqual([attempt.state, attempt.outcomeCode, journalEntries(w)[0]!.state], ["UNCERTAIN", "TIMEOUT", "UNCERTAIN"]);
  assert.deepEqual([...w.store().cases.values()].map((c) => [c.kind, c.evidenceHash, c.orderId]), [["UNCERTAIN_EFFECT", attempt.requestHash, order.orderId]], "the case names the exact request whose effect is unresolved");
  const resumed = completed(await runProviderCommand(commandRun(w, "CREATE_ORDER", createOrderHooks(w), { key, operation: "CMD028" }).run));
  assert.equal(resumed.view.order.state, "CREATED");
  assert.deepEqual([journalEntries(w)[0]!.state, w.provider.effects.ordersCreated, dispatches(w, "ORDERS_V2_CREATE").length], ["COMMITTED", 1, 1]);
  assert.equal(w.store().attempts.get(attempt.attemptId)!.state, "CONFIRMED");

  // proved no effect: a new deliberate attempt, then (all three spent) the order fails
  const w2 = commerceWorld();
  w2.provider.program("ORDERS_V2_CREATE", { kind: "PROVED_NO_EFFECT", outcomeCode: "VALIDATION_ERROR" });
  const retried = completed(await runProviderCommand(commandRun(w2, "CREATE_ORDER", createOrderHooks(w2), { key: "no-effect-create-0001", operation: "CMD028" }).run));
  assert.equal(retried.view.order.state, "CREATED");
  const tries = [...w2.store().attempts.values()].sort((a, b) => a.ordinal - b.ordinal);
  assert.deepEqual(tries.map((a) => [a.ordinal, a.state]), [[1, "FAILED_NO_EFFECT"], [2, "CONFIRMED"]]);
  assert.deepEqual(dispatches(w2, "ORDERS_V2_CREATE").map((c) => c.identity), tries.map((a) => `kauro-${a.attemptId}`), "each attempt under its own request identity");

  const w3 = commerceWorld();
  for (let i = 0; i < 3; i++) w3.provider.program("ORDERS_V2_CREATE", { kind: "PROVED_NO_EFFECT", outcomeCode: "VALIDATION_ERROR" });
  const spent = completed(await runProviderCommand(commandRun(w3, "CREATE_ORDER", createOrderHooks(w3), { key: "spent-create-0001", operation: "CMD028" }).run));
  assert.equal(spent.view.order.state, "FAILED");
  assert.deepEqual([...w3.store().attempts.values()].map((a) => a.state), ["FAILED_NO_EFFECT", "FAILED_NO_EFFECT", "FAILED_NO_EFFECT"]);
  assert.equal(w3.provider.effects.ordersCreated, 0);
});

test("runProviderCommand — CAPTURE: dispatched once under the attempt's identity, the authenticated completion recorded by the payment service with the CAPTURED order and one CommercialAuthorization; a crash after the call resumes by observing the provider order and never dispatches again; of two claims of one attempt only one wins, and a second capture command while one is in flight is PAYMENT_PENDING", async () => {
  const w = commerceWorld();
  const order = await w.seedOrder("APPROVED");
  const done = completed(await runProviderCommand(commandRun(w, "CAPTURE", captureHooks(w, order.orderId), { key: "capture-key-00001", operation: "CMD029" }).run));
  const attempt = [...w.store().attempts.values()][0]!;
  assert.deepEqual([done.status, done.view.order.state, done.view.captureIds.length, typeof done.view.authorizationId], [200, "CAPTURED", 1, "string"]);
  assert.deepEqual(dispatches(w, "ORDERS_V2_CAPTURE").map((c) => c.identity), [`kauro-${attempt.attemptId}`]);
  const capture = [...w.store().captures.values()][0]!;
  assert.deepEqual([capture.attemptId, capture.firstObservationSource, attempt.state], [attempt.attemptId, "DISPATCH_RESPONSE", "CONFIRMED"]);

  // a crash between the claim and the settle, after the call: the resume observes the order and records the one capture
  const w2 = commerceWorld();
  const order2 = await w2.seedOrder("APPROVED");
  await assert.rejects(runProviderCommand(commandRun(w2, "CAPTURE", captureHooks(w2, order2.orderId), { key: "capture-key-00002", operation: "CMD029", crashAt: "AFTER_CALL" }).run), /crash injected/);
  assert.equal(w2.store().captures.size, 0, "the provider captured; nothing is recorded before T3");
  const resumed = completed(await runProviderCommand(commandRun(w2, "CAPTURE", captureHooks(w2, order2.orderId), { key: "capture-key-00002", operation: "CMD029" }).run));
  assert.deepEqual([resumed.view.order.state, w2.store().captures.size, w2.store().authorizations.size, w2.provider.effects.captures, dispatches(w2, "ORDERS_V2_CAPTURE").length], ["CAPTURED", 1, 1, 1, 1]);
  assert.deepEqual(w2.provider.calls.map((c) => c.operation).slice(-2), ["DISPATCH ORDERS_V2_CAPTURE", "OBSERVE_ORDER"]);

  // two claimants of one PREPARED attempt: the compare-and-swap admits one, the other never calls the provider
  const w3 = commerceWorld();
  const order3 = await w3.seedOrder("APPROVED");
  const hooks = captureHooks(w3, order3.orderId);
  await assert.rejects(runProviderCommand(commandRun(w3, "CAPTURE", hooks, { key: "capture-key-00003", operation: "CMD029", crashAt: "AFTER_INTENT" }).run), /crash injected/);
  const phases = providerEffectPhases("CAPTURE", { adapter: w3.provider, reconciler: reconcilerOf(w3), clock: w3.clock }, hooks);
  const entryId = journalEntries(w3)[0]!.entryId;
  const operation = (await w3.ports.unitOfWork.run(w3.tenant(), (uow) => phases.resume(uow, entryId)))!;
  const winner = await w3.ports.unitOfWork.run(w3.tenant(), (uow) => phases.claim(uow, operation, w3.clock.now()));
  const loser = await w3.ports.unitOfWork.run(w3.tenant(), (uow) => phases.claim(uow, operation, w3.clock.now()));
  assert.ok(winner !== null && winner.attempt.state === "DISPATCHING");
  assert.equal(loser, null);
  assert.equal(dispatches(w3, "ORDERS_V2_CAPTURE").length, 0, "no capture was sent by either claimant");
  // meanwhile a second capture command under another key finds the live attempt
  const w4 = commerceWorld();
  const order4 = await w4.seedOrder("APPROVED");
  await assert.rejects(runProviderCommand(commandRun(w4, "CAPTURE", captureHooks(w4, order4.orderId), { key: "capture-key-00004", operation: "CMD029", crashAt: "AFTER_INTENT" }).run), /crash injected/);
  const second = await runProviderCommand(commandRun(w4, "CAPTURE", captureHooks(w4, order4.orderId), { key: "capture-key-00005", operation: "CMD029" }).run);
  assert.deepEqual(second.kind === "CONFLICT" ? [second.problem.code, second.problem.reason] : second.kind, ["PAYMENT_PENDING", "CAPTURE_IN_PROGRESS"]);
  assert.deepEqual([w4.store().attempts.size, journalEntries(w4).length], [1, 1], "the refused command left nothing");
});

test("runProviderCommand — REFUND by the payment service principal on its stored operation: the approved refund goes SUBMITTING then COMPLETED once, refund.completed.v1 naming the service basis left and the funds state its money is taken from (D-LEDGER-B5); an ambiguous refund answers 202 UNCERTAIN with a visible case, and its resume observes it by the capture and the request identity and never dispatches it again", async () => {
  const w = commerceWorld();
  const { order } = await paidOrder(w);
  const amounts = { serviceCents: 1000n, taxCents: 190n, excessCents: 0n };
  const refundId = await approvedRefund(w, order, amounts);
  const before = w.store().base.events.length;
  const done = completed(await runProviderCommand(commandRun(w, "REFUND", refundHooks(w, refundId), { key: "execute-refund-0001", operation: "CMD033", storedOperation: { kind: "REFUND", key: refundId } }).run));
  assert.deepEqual([done.status, done.view.refund.state], [200, "COMPLETED"]);
  const events = w.store().base.events.slice(before);
  assert.deepEqual(events.map((e) => [e.eventType, e.actor.kind]), [
    ["payment_attempt.prepared.v1", "SERVICE"],
    ["payment_attempt.dispatching.v1", "SERVICE"],
    ["refund.submitting.v1", "SERVICE"],
    ["payment_attempt.confirmed.v1", "SERVICE"],
    ["refund.completed.v1", "SERVICE"],
  ]);
  const completedEvent = events.at(-1)!;
  assert.deepEqual(
    [completedEvent.payload["serviceCents"], completedEvent.payload["taxCents"], completedEvent.payload["serviceBasisAfterCents"], completedEvent.payload["fundsState"], completedEvent.payload["movableBalanceCents"]],
    [1000, 190, Number(R2_077.service - 1000n), "UNKNOWN", Number(R2_077.total)],
  );
  assert.deepEqual(outboxOf(w, completedEvent.eventId), ["COMMISSIONS", "FINANCE", "FISCAL", "NOTIFICATIONS"]);
  assert.deepEqual([dispatches(w, "CAPTURES_V2_REFUND").length, w.provider.effects.refunds], [1, 1]);
  assert.equal([...w.store().authorizations.values()][0]!.state, "ACTIVE", "a partial refund leaves the service basis and the entitlement");
  assert.deepEqual(journalEntries(w).map((e) => [e.identity.actor.kind, e.state, e.responseStatus]), [["SERVICE", "COMMITTED", 200]]);

  // ambiguous: UNCERTAIN (202); the resume observes and completes it without a second dispatch
  const w2 = commerceWorld();
  const paid2 = await paidOrder(w2);
  const refund2 = await approvedRefund(w2, paid2.order, amounts);
  w2.provider.program("CAPTURES_V2_REFUND", { kind: "AMBIGUOUS", reason: "CONNECTION_RESET", effect: "APPLIED" });
  const run = () => commandRun(w2, "REFUND", refundHooks(w2, refund2), { key: "execute-refund-0002", operation: "CMD033", storedOperation: { kind: "REFUND", key: refund2 } }).run;
  const pending = await runProviderCommand(run());
  assert.ok(pending.kind === "ACCEPTED" && pending.state === "UNCERTAIN" && pending.statusPath === `/api/v1/refunds/${refund2}`);
  assert.deepEqual([w2.store().refunds.get(refund2)!.state, journalEntries(w2)[0]!.state], ["UNCERTAIN", "UNCERTAIN"]);
  const uncertainCase = [...w2.store().cases.values()].find((c) => c.kind === "UNCERTAIN_EFFECT")!;
  assert.deepEqual([uncertainCase.refundId, uncertainCase.orderId], [refund2, paid2.order.orderId]);
  const finished = completed(await runProviderCommand(run()));
  assert.equal(finished.view.refund.state, "COMPLETED");
  assert.deepEqual([dispatches(w2, "CAPTURES_V2_REFUND").length, w2.provider.effects.refunds, journalEntries(w2)[0]!.state], [1, 1, "COMMITTED"]);
  assert.ok(w2.provider.calls.some((c) => c.operation === "OBSERVE_REFUND_BY_REQUEST"));
});

test("runProviderCommand — the claim sends only the request the attempt recorded: an attempt whose recorded digest is not its durable request is refused INTEGRITY_FAILURE with nothing sent; an access denial is recorded as a durable fact and reserves nothing", async () => {
  const w = commerceWorld();
  const order = await w.seedOrder("APPROVED");
  const attempt = w.seedAttempt(order, "CAPTURE", "PREPARED");
  w.store().attempts.set(attempt.attemptId, { ...attempt, requestHash: sha("a request this attempt never recorded") });
  const phases = providerEffectPhases("CAPTURE", { adapter: w.provider, reconciler: reconcilerOf(w), clock: w.clock }, captureHooks(w, order.orderId));
  const operation = await w.ports.unitOfWork.run(w.tenant(), (uow) => operationOf(uow, "CAPTURE", w.ids.next() as JournalEntryId, attempt));
  await assert.rejects(w.ports.unitOfWork.run(w.tenant(), (uow) => phases.claim(uow, operation, w.clock.now())), (e: unknown) => e instanceof DomainFailure && e.code === "INTEGRITY_FAILURE");
  assert.deepEqual([w.store().attempts.get(attempt.attemptId)!.state, dispatches(w, "ORDERS_V2_CAPTURE").length], ["PREPARED", 0]);

  const { run, denials } = commandRun(w, "CAPTURE", captureHooks(w, order.orderId), { key: "denied-capture-01", operation: "CMD029", denied: new NotAuthorizedFailure("ROLE_INSUFFICIENT", "a viewer cannot capture") });
  const denied = await runProviderCommand(run);
  assert.deepEqual(denied.kind === "REJECTED" ? [denied.problem.code, denied.problem.reason] : denied.kind, ["NOT_AUTHORIZED", "ROLE_INSUFFICIENT"]);
  assert.equal(denials.length, 1);
  assert.deepEqual([journalEntries(w).length, dispatches(w, "ORDERS_V2_CAPTURE").length], [0, 0]);
});

// --- the commerce authorizer -------------------------------------------------------------------------------------------------------

function assurance(fresh: ReadonlySet<string>, stale: ReadonlySet<string>): AssuranceVerifier & { readonly calls: Array<{ readonly userId: UserId; readonly proofRef: AssuranceProofId | undefined }> } {
  const calls: Array<{ readonly userId: UserId; readonly proofRef: AssuranceProofId | undefined }> = [];
  return {
    calls,
    async verifyStepUp(_uow, userId, proofRef, now): Promise<AssuranceOutcome> {
      calls.push({ userId, proofRef });
      if (proofRef !== undefined && fresh.has(proofRef)) return { kind: "FRESH", proofId: proofRef, issuedAt: now, freshUntil: new Date(Date.parse(now) + 900_000).toISOString() as never };
      if (proofRef !== undefined && stale.has(proofRef)) return { kind: "STALE", reason: "STEP_UP_STALE" };
      return { kind: "MISSING", reason: "STEP_UP_MISSING" };
    },
  };
}

test("CommerceAuthorizer.authorizeService — D-AUTHZ-B3: a verified service identity is allowed only the technical role the code-owned table gives it, in the environment it was issued for; the ingress identity asking for PAYMENT_SERVICE, an unknown identity or a prototype member, and an identity of another environment are refused with their reason", () => {
  const w = commerceWorld();
  const authorizer = createCommerceAuthorizer({ clock: w.clock, assurance: assurance(new Set(), new Set()) });
  const identity = { serviceId: "payment-service", audience: "kauro-api", environment: "SANDBOX" as const };
  assert.deepEqual(authorizer.authorizeService({ identity, role: "PAYMENT_SERVICE", deploymentEnvironment: "SANDBOX" }), { kind: "ALLOW", serviceId: "payment-service", role: "PAYMENT_SERVICE", policyVersion: "B09-1" });
  const reason = (serviceId: string, env: "SANDBOX" | "LIVE" = "SANDBOX") => {
    const d = authorizer.authorizeService({ identity: { ...identity, serviceId }, role: "PAYMENT_SERVICE", deploymentEnvironment: env });
    return d.kind === "DENY" ? [d.code, d.reason] : d.kind;
  };
  assert.deepEqual(reason("provider-ingress"), ["NOT_AUTHORIZED", "SERVICE_NOT_PERMITTED"]);
  assert.deepEqual(reason("fiscal-service"), ["NOT_AUTHORIZED", "SERVICE_NOT_PERMITTED"]);
  assert.deepEqual(reason("someone-else"), ["NOT_AUTHORIZED", "SERVICE_NOT_PERMITTED"]);
  assert.deepEqual(reason("constructor"), ["NOT_AUTHORIZED", "SERVICE_NOT_PERMITTED"]);
  assert.deepEqual(reason("payment-service", "LIVE"), ["NOT_AUTHORIZED", "SERVICE_ENVIRONMENT_MISMATCH"]);
  assert.equal(authorizer.authorizeService({ identity: { ...identity, serviceId: "provider-ingress" }, role: "AUTHENTICATED_PROVIDER", deploymentEnvironment: "SANDBOX" }).kind, "ALLOW");
});

test("CommerceAuthorizer.authorizeOperator — D-CORP-B1: an ACTIVE, verified corporate identity with its own ACTIVE KAURO_OWNER grant, read after its lock, adopts the refund's agency as its finance scope; without the grant it is CORPORATE_ROLE_MISSING, an unknown refund is NOT_FOUND without a reason, an unverified or disabled identity is refused, and a unit of work that does not run for the caller is unauthenticated", async () => {
  const w = commerceWorld();
  const authorizer = createCommerceAuthorizer({ clock: w.clock, assurance: assurance(new Set(), new Set()) });
  const order = await w.seedOrder("CAPTURED");
  const refundId = w.ids.next() as RefundId;
  w.store().scopes.set(`REFUND|${refundId}`, { kind: "REFUND", key: refundId, agencyId: w.agencyId, orderId: order.orderId, refundId });
  const decide = (identity = w.owner.identity, key: string = refundId, context = w.operator()) =>
    w.ports.unitOfWork.run(context, async (uow) => {
      const d = await authorizer.authorizeOperator(uow, { identity, role: "KAURO_OWNER", storedOperation: { kind: "REFUND", key } });
      return { d, scope: uow.commerceScope };
    });
  const allowed = await decide();
  assert.deepEqual([allowed.d, allowed.scope], [{ kind: "ALLOW", userId: w.owner.userId, policyVersion: "B09-1" }, w.agencyId]);
  const code = async (p: Promise<{ readonly d: Awaited<ReturnType<typeof authorizer.authorizeOperator>> }>) => {
    const { d } = await p;
    return d.kind === "DENY" ? [d.code, d.reason] : d.kind;
  };
  assert.deepEqual(await code(decide(w.owner.identity, w.ids.next())), ["NOT_FOUND", null], "a foreign and an unknown refund look alike");
  assert.deepEqual(await code(decide(w.billing.identity, refundId, w.operator(w.billing.userId))), ["NOT_AUTHORIZED", "CORPORATE_ROLE_MISSING"], "an agency member holds no corporate grant");
  assert.deepEqual(await code(decide({ ...w.owner.identity, mfaEnrolledAt: null })), ["NOT_AUTHORIZED", "IDENTITY_UNVERIFIED"]);
  assert.deepEqual(await code(decide({ ...w.owner.identity, state: "DISABLED" })), ["NOT_AUTHORIZED", "IDENTITY_DISABLED"]);
  assert.deepEqual(await code(decide(w.owner.identity, refundId, w.operator(w.billing.userId))), ["AUTHENTICATION_REQUIRED", "SUBJECT_UNAUTHENTICATED"], "the unit of work runs for another person");
  assert.deepEqual(await code(decide(w.owner.identity, refundId, w.tenant() as never)), ["AUTHENTICATION_REQUIRED", "SUBJECT_UNAUTHENTICATED"], "an agency context is not an operator");
  for (const [k, g] of w.store().grants) w.store().grants.set(k, { ...g, state: "REVOKED", revokedAt: w.clock.now() });
  assert.deepEqual(await code(decide()), ["NOT_AUTHORIZED", "CORPORATE_ROLE_MISSING"], "a revoked grant grants nothing");
});

test("CommerceAuthorizer.assureOperator — D-REF-B4: a standing policy that covers the locked refund is its assurance; one that does not cover it is POLICY_NOT_APPLICABLE, never a silent fallback to anything else; otherwise the operator's own fresh step-up proof, and a stale or missing proof is refused", async () => {
  const w = commerceWorld();
  const fresh = w.ids.next() as AssuranceProofId;
  const stale = w.ids.next() as AssuranceProofId;
  const verifier = assurance(new Set([fresh]), new Set([stale]));
  const authorizer = createCommerceAuthorizer({ clock: w.clock, assurance: verifier });
  const policyId = w.ids.next() as RefundPolicyId;
  const policy: RefundPolicyRecord = { policyId, policyKind: "PRE_EXECUTION_CANCELLATION", policyVersion: "R2-INITIAL", refundScope: "FULL_REMAINING", appliesToPhase: "PRE_EXECUTION", appliesToOrigin: "CUSTOMER_REQUEST", conditionsHash: sha("conditions"), authorizedByUserId: w.owner.userId, authorizationProofRef: fresh, state: "ACTIVE", validFrom: w.clock.now() };
  w.store().refundPolicies.set(policyId, policy);
  const balance = refundableBalance({ status: "COMPLETED", allocation: { serviceCents: R2_077.service, taxCents: R2_077.tax, excessCents: 0n } }, { serviceCents: 0n, taxCents: 0n, excessCents: 0n });
  const covers = (requested: RefundComponents) => async (id: RefundPolicyId) => id === policyId && policyCovers(policy, { at: w.clock.now(), origin: "CUSTOMER_REQUEST", phase: "PRE_EXECUTION", balance, requested });
  const assure = (authorizationRef: string, requested: RefundComponents = balance) =>
    w.ports.unitOfWork.run(w.operator(), (uow) => authorizer.assureOperator(uow, { userId: w.owner.userId, authorizationRef, covers: covers(requested) }));
  assert.deepEqual(await assure(policyId), { kind: "ALLOW", assuranceClass: "STANDING_POLICY", policyId, policyVersion: "B09-1" });
  const partial = await assure(policyId, { serviceCents: 1000n, taxCents: 190n, excessCents: 0n });
  assert.deepEqual(partial.kind === "DENY" ? [partial.code, partial.reason] : partial.kind, ["ASSURANCE_REQUIRED", "POLICY_NOT_APPLICABLE"]);
  assert.equal(verifier.calls.length, 0, "a cited policy is judged as such, never replaced by a step-up");
  assert.deepEqual(await assure(fresh), { kind: "ALLOW", assuranceClass: "STEP_UP", proofRef: fresh, policyVersion: "B09-1" });
  const staleDecision = await assure(stale);
  assert.deepEqual(staleDecision.kind === "DENY" ? [staleDecision.code, staleDecision.reason] : staleDecision.kind, ["ASSURANCE_REQUIRED", "STEP_UP_STALE"]);
  const missing = await assure("not-a-proof-reference");
  assert.deepEqual(missing.kind === "DENY" ? [missing.code, missing.reason] : missing.kind, ["ASSURANCE_REQUIRED", "STEP_UP_MISSING"]);
  assert.deepEqual(verifier.calls.map((c) => [c.userId, c.proofRef]), [[w.owner.userId, fresh], [w.owner.userId, fresh], [w.owner.userId, stale], [w.owner.userId, undefined]], "the operator's own proof, never another person's (the fresh one read again for the judgment at the COMMIT)");
});

// STEPUP-AT-COMMIT defect 4 (B09 provider path): the revision's deadline is judged at an instant sampled AFTER the availability read.
test("revisionForCheckout with the process clock: a source deadline that passes while the availability read waits expires the revision (EXPIRED), judged after the read, not at the instant sampled before it", async () => {
  const { revisionForCheckout, fixedClock } = await import("../src/index.js");
  const clock = fixedClock();
  const before = clock.now();
  const deadline = new Date(clock.nowMs() + 1_000).toISOString();
  const quote = { agencyId: "a", projectId: "p", revisionHash: "h", sourceAvailableUntil: deadline } as never;
  const sources = {
    availabilityOf: async () => {
      clock.advance(2_000); // the read waits past the deadline
      return { state: "SEALED", effectiveDeadline: deadline };
    },
  };
  const sealed = { state: "SEALED" } as never;
  // the instant sampled before the read still sits before the deadline: the old judgment passes it
  assert.deepEqual(await revisionForCheckout({} as never, { sources } as never, quote, sealed, before), sealed, "judged at the earlier sample the revision looks available");
  const clock2 = fixedClock();
  const sources2 = {
    availabilityOf: async () => {
      clock2.advance(2_000);
      return { state: "SEALED", effectiveDeadline: new Date(Date.UTC(2026, 8, 19, 12, 0, 1)).toISOString() };
    },
  };
  assert.deepEqual(await revisionForCheckout({} as never, { sources: sources2 } as never, quote, sealed, clock2.now(), clock2), { state: "EXPIRED" }, "judged after the read the deadline has passed");
});
