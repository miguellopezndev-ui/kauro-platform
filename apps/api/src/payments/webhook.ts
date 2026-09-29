/**
 * ReceivePaymentWebhook (CMD030, POST /api/v1/payments/webhooks/{provider}; docs/design/B09-payments-fiscal.md §8 CMD030, D-IDEM-B1,
 * D-ING-B1..B3, D-FACT-B1; stage-2 mandate M3). Two halves:
 *
 *  Ingress (the provider's request): the provider is configured (NOT_FOUND PROVIDER_UNKNOWN); the raw body is within its bound
 *    (PROVIDER_BODY_TOO_LARGE); the provider's WebhookVerifier checks the signature over the exact raw bytes, the freshness and the
 *    environment before anything is stored or trusted (AUTHENTICATION_REQUIRED with the reason, and the ANONYMOUS denial recorded
 *    by the ingress — nothing else); the verified bytes go to the restricted evidence store (content-addressed; its reference is the
 *    normalized command's providerEventArtifactRef); B06's InboxIngress records the delivery once per (provider, environment, event
 *    id) — RECORDED, a DUPLICATE of the same body, or a BODY_CONFLICT recorded beside the event and never absorbed — and the
 *    ingress records its ALLOW fact. The provider is answered 200 WebhookAck with the disposition only (D-ING-B2).
 *  Application (the payment service, kauro_payment): immediately after the ingress, or later by the inbox worker, in one SERVICE
 *    unit of work — M2's reconciler locks the record for apply, attributes it through the scope index (never a payload's agency),
 *    reconciles it with its order under the order's row lock and settles the record in the same transaction (APPLIED with the
 *    result event, REJECTED for a mismatch, IGNORED for a stale, duplicate or unknown reference, RETRYABLE while a completion waits
 *    for its instant, D-PAY-B6). A record whose event id arrived with another body is never APPLIED (B06 KA012): it becomes a
 *    BODY_CONFLICT exception for the owner's review and, unless it was settled before the conflict arrived, is REJECTED.
 *
 * The inbox worker claims RECEIVED and RETRYABLE records through B06's PgInboxConsumerStore under kauro_control (a claim moves them
 * to PROCESSING; an application that failed leaves them to be claimed again once the claim is stale), finds each record's verified
 * body in the content-addressed store by the record's body hash, and applies it exactly as the ingress does: a crash between the
 * ingress commit and the application leaves a RECEIVED record that is applied once. A record whose completion waits for its
 * instant (D-PAY-B6) triggers a stored provider query of its order, applied through CMD034.
 */
import type { StoredEvidence, WebhookAck } from "@kauro/application";
import { REQUEST_SCHEMA_PREFIX, problemOf, type Problem, type SchemaValidator } from "@kauro/application";
import type { CausationId, CommerceUnitOfWork, CorrelationId, InboxId, NormalizedProviderEvent, PaymentOrderId, ServiceContext, SystemContext } from "@kauro/domain";
import { COMMERCE_POLICY_VERSION, DomainFailure, providerScopeKey } from "@kauro/domain";
import type { PaymentRuntime } from "./runtime.js";
import { PROVIDER_INGRESS_ID, causedBy } from "./runtime.js";
import { reconcilePayment, storeProviderQuery } from "./service-commands.js";

export interface WebhookRequest {
  /** The route's `{provider}`, as received. */
  readonly provider: string;
  /** The exact raw body bytes (never re-serialized: the signature covers these). */
  readonly bytes: Uint8Array;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly correlationId: CorrelationId;
}

export type WebhookOutcome = { readonly kind: "ACK"; readonly ack: WebhookAck } | { readonly kind: "PROBLEM"; readonly problem: Problem };

type InboxState = WebhookAck["inboxState"];

function problem(code: DomainFailure["code"], reason: DomainFailure["details"]["reason"], correlationId: string): WebhookOutcome {
  return { kind: "PROBLEM", problem: problemOf(new DomainFailure(code, `webhook refused: ${String(reason ?? code)}`, reason !== undefined ? { reason } : {}), correlationId) };
}

function isProviderEvent(value: StoredEvidence["normalized"]): value is NormalizedProviderEvent {
  return typeof value === "object" && value !== null && "externalEventId" in value && "bodyHash" in value;
}

function serviceContext(rt: PaymentRuntime, correlationId: CorrelationId): ServiceContext {
  return { kind: "SERVICE", serviceId: rt.self.serviceId, correlationId };
}

/** The ingress half and the immediate application of one provider delivery (design §8 CMD030). */
export async function receiveWebhook(rt: PaymentRuntime, validator: SchemaValidator, request: WebhookRequest): Promise<WebhookOutcome> {
  const correlationId = request.correlationId;
  const verifier = rt.verifiers.get(request.provider);
  if (verifier === undefined) return problem("NOT_FOUND", "PROVIDER_UNKNOWN", correlationId);
  if (request.bytes.byteLength > verifier.maxBodyBytes) return problem("INVALID_REQUEST", "PROVIDER_BODY_TOO_LARGE", correlationId);
  const receivedAt = rt.clock.now();
  const verification = await verifier.verify({ bytes: request.bytes, headers: request.headers, receivedAt });
  if (verification.kind === "REJECTED") {
    // an unverified sender is nobody: its denial is the ingress's anonymous fact, and nothing else is stored (08 Audit events)
    await rt.assembly.ingressFacts.record({ outcome: "DENY", actor: { kind: "ANONYMOUS" }, reasonCode: verification.reason, policyVersion: COMMERCE_POLICY_VERSION, correlationId, occurredAt: rt.clock.now() });
    return problem("AUTHENTICATION_REQUIRED", verification.reason, correlationId);
  }
  const event = verification.event;
  if (event.provider !== verifier.provider || event.environment !== verifier.environment) throw new DomainFailure("INTEGRITY_FAILURE", "the verifier classified an event of another provider or environment than its own");
  // the exact bytes in the restricted store: content-addressed, their digest is the inbox record's body hash (10)
  const stored = await rt.assembly.evidence.put({
    kind: "WEBHOOK_BODY",
    provider: event.provider,
    environment: event.environment,
    capturedAt: receivedAt,
    authenticatedBy: "WEBHOOK_SIGNATURE",
    normalized: event,
    integrationClass: verifier.integrationClass,
    bytes: request.bytes,
  });
  if (stored.sha256 !== event.bodyHash) throw new DomainFailure("INTEGRITY_FAILURE", "the stored body is not the verified body");
  // the normalized inbox command (COMMAND_CATALOGUE: not the vendor's payload schema) is checked like any command body
  const command = { providerEventArtifactRef: stored.artifactRef };
  if (validator.validate(`${REQUEST_SCHEMA_PREFIX}CMD030` as Parameters<SchemaValidator["validate"]>[0], command).kind !== "VALID") {
    throw new DomainFailure("INTEGRITY_FAILURE", "the evidence store's reference is not an id of the normalized command");
  }
  const recorded = await rt.assembly.ingress.record({ inboxId: rt.ids.next() as InboxId, provider: event.provider, environment: event.environment, externalEventId: event.externalEventId, bodyHash: event.bodyHash, receivedAt });
  await rt.assembly.ingressFacts.record({ outcome: "ALLOW", actor: { kind: "SERVICE", serviceId: PROVIDER_INGRESS_ID }, reasonCode: "PROVIDER_EVENT_AUTHENTICATED", policyVersion: COMMERCE_POLICY_VERSION, correlationId, occurredAt: rt.clock.now() });
  // the delivery is durable from here on (a crash now leaves a RECEIVED record the inbox worker applies once)
  await rt.assembly.hold?.("CMD030", "AFTER_INGRESS", null);
  let inboxState: InboxState = "RECEIVED";
  try {
    inboxState = recorded.kind === "BODY_CONFLICT" ? await settleConflict(rt, recorded.inboxId, correlationId) : await applyInboxRecord(rt, recorded.inboxId, event, correlationId);
  } catch (e) {
    // the delivery is recorded: the inbox worker applies it; the provider is answered with what the ingress settled (D-ING-B2)
    rt.onBackgroundFailure(correlationId, e);
  }
  return { kind: "ACK", ack: { received: true, inboxState, duplicate: recorded.kind === "DUPLICATE", conflict: recorded.kind === "BODY_CONFLICT" } };
}

/**
 * Applies one inbox record's verified event in a SERVICE unit of work (M2's reconciler: attribute, reconcile, settle), and answers
 * the record's state after it. A record whose completion waits for its instant (D-PAY-B6) is followed by a stored provider query of
 * its order, applied through CMD034 under the payment service's own identity.
 */
export async function applyInboxRecord(rt: PaymentRuntime, inboxId: InboxId, event: NormalizedProviderEvent, correlationId: CorrelationId): Promise<InboxState> {
  const outcome = await rt.assembly.commerce.run(serviceContext(rt, correlationId), async (uow) => {
    causedBy(uow, inboxId);
    const applied = await rt.reconciler.applyProviderEvent(uow, { event, inboxId, causationId: inboxId as string as CausationId, now: rt.clock.now() });
    const entry = await uow.commerce.inbox.lockForApply(inboxId);
    // the order the event was attributed to, for a completion that needs a provider query (D-PAY-B6)
    let orderId: PaymentOrderId | null = null;
    if (applied.kind === "APPLIED" && applied.result.providerQueryRequired) orderId = await attributedOrder(uow, event);
    await rt.assembly.hold?.("CMD030", "APPLICATION_BEFORE_COMMIT", null);
    return { state: entry?.state ?? "RECEIVED", orderId };
  });
  if (outcome.orderId !== null) await reconcileByQuery(rt, outcome.orderId, correlationId);
  return outcome.state === "PROCESSING" ? "RECEIVED" : outcome.state;
}

/** The order the scope index attributes an event to (the reconciler's own attribution; D-SCOPE-B1). */
async function attributedOrder(uow: CommerceUnitOfWork, event: NormalizedProviderEvent): Promise<PaymentOrderId | null> {
  const refs: Array<readonly ["PROVIDER_CAPTURE" | "PROVIDER_ORDER", string]> = [];
  if (event.capture !== undefined) refs.push(["PROVIDER_CAPTURE", event.capture.providerCaptureId]);
  if (event.capture?.providerOrderId != null) refs.push(["PROVIDER_ORDER", event.capture.providerOrderId]);
  if (event.providerOrderId !== undefined) refs.push(["PROVIDER_ORDER", event.providerOrderId]);
  for (const [kind, ref] of refs) {
    let key: string;
    try {
      key = providerScopeKey(event.provider, event.environment, ref);
    } catch {
      continue;
    }
    const entry = await uow.scopes.resolve(kind, key);
    if (entry !== null) return entry.orderId;
  }
  return null;
}

/** D-PAY-B6: the payment service stores a provider query of the order and applies it (CMD034) under its own identity. */
async function reconcileByQuery(rt: PaymentRuntime, orderId: PaymentOrderId, correlationId: CorrelationId): Promise<void> {
  const order = await rt.assembly.commerce.run(serviceContext(rt, correlationId), async (uow) => {
    if ((await uow.adoptScope("PAYMENT_ORDER", orderId)) === null) return null;
    return uow.commerce.orders.get(orderId);
  });
  if (order === null || order.providerOrderId === undefined) return;
  const observationRef = await storeProviderQuery(rt, { providerOrderId: order.providerOrderId, providerRequestId: order.orderId });
  const result = await reconcilePayment(rt, { correlationId, idempotencyKey: `completion-query-${observationRef}`, identity: rt.self, path: { orderId }, body: { observationRef } });
  if (result.kind !== "COMPLETED" && result.kind !== "ACCEPTED") throw new DomainFailure(result.problem.code, `the provider query of ${orderId} was answered ${result.problem.code}`, result.problem.reason !== undefined ? { reason: result.problem.reason } : {}, result.problem.retryable);
}

/**
 * A delivery of a recorded event id with another body (B06 D-ING-1): never absorbed and never applied (KA012). The record becomes
 * a BODY_CONFLICT exception for the owner's review (one per source and kind, unattributed: no order takes it), and is REJECTED
 * unless it was settled before the conflict arrived (a settled record stays settled; the conflict is history for reconciliation).
 */
export async function settleConflict(rt: PaymentRuntime, inboxId: InboxId, correlationId: CorrelationId): Promise<InboxState> {
  return rt.assembly.commerce.run(serviceContext(rt, correlationId), async (uow) => {
    const c = uow.commerce;
    const entry = await c.inbox.lockForApply(inboxId);
    if (entry === null) throw new DomainFailure("INTEGRITY_FAILURE", "a recorded delivery is visible to the payment service");
    const now = rt.clock.now();
    await c.exceptions.record({ source: "WEBHOOK", inboxId, provider: entry.provider, environment: entry.environment, kind: "BODY_CONFLICT", evidenceHash: entry.bodyHash, observedAt: now });
    if (entry.state === "APPLIED" || entry.state === "IGNORED" || entry.state === "REJECTED") return entry.state;
    const settled = await c.inbox.settle(inboxId, { state: "REJECTED" }, now);
    return settled.state === "PROCESSING" ? "RECEIVED" : settled.state;
  });
}

/** What one pass of the inbox worker did. */
export interface InboxPass {
  readonly claimed: number;
  readonly applied: ReadonlyArray<{ readonly inboxId: InboxId; readonly state: InboxState }>;
  /** Records whose verified body the store does not hold (left to be claimed again; reported to the background sink). */
  readonly missingEvidence: ReadonlyArray<InboxId>;
}

/**
 * One bounded pass of the payment service's inbox worker (D-ING-B1): claims up to `limit` RECEIVED or RETRYABLE records (and
 * PROCESSING ones whose claim is older than `staleClaimSeconds`) under kauro_control, then applies each one's verified event in a
 * SERVICE unit of work of its own.
 */
export async function runInboxPass(rt: PaymentRuntime, options: { readonly limit?: number; readonly staleClaimSeconds?: number } = {}): Promise<InboxPass> {
  const correlationId = rt.ids.next() as CorrelationId;
  const system: SystemContext = { kind: "SYSTEM", serviceId: "payment-inbox-worker", correlationId };
  const claimed = await rt.assembly.commerce.run(system, (uow) => uow.inbox.claim(options.limit ?? 25, options.staleClaimSeconds ?? 300));
  const applied: Array<{ inboxId: InboxId; state: InboxState }> = [];
  const missingEvidence: InboxId[] = [];
  for (const record of claimed) {
    try {
      if (record.conflictingBodies > 0) {
        applied.push({ inboxId: record.inboxId, state: await settleConflict(rt, record.inboxId, correlationId) });
        continue;
      }
      const stored = await rt.assembly.evidence.findByDigest(record.bodyHash);
      if (stored === null || stored.kind !== "WEBHOOK_BODY" || !isProviderEvent(stored.normalized) || stored.normalized.bodyHash !== record.bodyHash) {
        missingEvidence.push(record.inboxId);
        rt.onBackgroundFailure(correlationId, new DomainFailure("INTEGRITY_FAILURE", `inbox record ${record.inboxId} has no verified body in the evidence store`));
        continue;
      }
      applied.push({ inboxId: record.inboxId, state: await applyInboxRecord(rt, record.inboxId, stored.normalized, correlationId) });
    } catch (e) {
      rt.onBackgroundFailure(correlationId, e);
    }
  }
  return { claimed: claimed.length, applied, missingEvidence };
}
