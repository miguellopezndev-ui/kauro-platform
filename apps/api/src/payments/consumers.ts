/**
 * The payment service's consumers (docs/design/B09-payments-fiscal.md §8.1, D-CONS-B1; stage-2 mandate M3). Each receives the
 * outbox records of its registered event types (COMMERCE_EVENT_SUBSCRIPTIONS) from the payment dispatcher, at least once, and is
 * idempotent by its own durable identity (07 "Consumers deduplicate by their own durable inbox identity"):
 *
 *  FINANCE        planPostings (M2) → LedgerRepository.post: the balanced set the delivered event records, sourced by that event
 *                 (its id is the set's idempotency identity: a replay posts nothing), the fee and returns taken from the balance and
 *                 up to the movable balance the event names (D-LEDGER-B5, D-LEDGER-B6), its effective and observed date the event's
 *                 own instant. A case's resolution posts the reviewed correction its owner records (B12); without it nothing.
 *  FISCAL         planFiscalDocument (M2) → TaxDocumentRepository: the invoice of a completed capture under the profile version of
 *                 the sale's tax point (saleProfileAt, D-FISC-B6), blocked with its concrete fiscal action when the treatment is not
 *                 reviewed (R2-128), validated otherwise (the database re-checks it, KP011); the credit note of a completed refund
 *                 with exactly its invoice's snapshot (D-FISC-B5), validated once that invoice is issued (CMD035, B15). One live
 *                 document per subject is the identity. Blocked drafts are re-evaluated when the reviewed facts change.
 *  PAYMENT_SERVICE the watchdog of every dispatched attempt (payment_attempt.dispatching / provider_pending / uncertain, and the
 *                 attempt of refund.uncertain): not due before its dispatch deadline (the delivery is rescheduled just past it), then a
 *                 stored provider query applied through CMD034 (D-PROTO-B4); and the refund executor (refund.approved): CMD033
 *                 under the payment service's own identity with its journal key derived from the refund and its version, so a
 *                 redelivered approval resumes the one operation and never executes the refund twice.
 *
 * FINANCE and FISCAL run in one SERVICE unit of work that adopts the delivery's agency through its stored operation (the order the
 * event names, or the refund); PAYMENT_SERVICE drives several units of work around its provider calls (no call inside a transaction).
 */
import type { CommerceEventConsumer, CommerceEventDelivery, FiscalPlan } from "@kauro/application";
import { planFiscalDocument, planPostings } from "@kauro/application";
import type { UtcInstant } from "@kauro/contracts";
import type { AgencyId, CaptureId, CommerceUnitOfWork, CorrelationId, EventId, PaymentAttemptId, PaymentOrderId, RefundId, TaxDocumentId } from "@kauro/domain";
import { COMMERCE_EVENT_SUBSCRIPTIONS, DomainFailure, NotFoundFailure, toUtcInstant, uuidV7Timestamp } from "@kauro/domain";
import type { PaymentRuntime } from "./runtime.js";
import { causedBy } from "./runtime.js";
import { NotDueYet, executeRefund, watchAttempt } from "./service-commands.js";

export type ConsumerOutcome = "APPLIED" | "DUPLICATE" | "NOT_APPLICABLE";

/** The consumers of this package, by name (COMMERCE_CONSUMERS less the recurrence package's COMMISSIONS). */
export type PaymentConsumerName = "FINANCE" | "FISCAL" | "PAYMENT_SERVICE";

/** The event types a consumer is registered for (migration 0013 commerce_event_subscriptions; COMMERCE_EVENT_SUBSCRIPTIONS). */
export function eventTypesOf(consumer: PaymentConsumerName): ReadonlyArray<string> {
  return COMMERCE_EVENT_SUBSCRIPTIONS.filter((s) => s.consumer === consumer).map((s) => s.eventType);
}

/** What one delivery asks of the consumer that receives it. */
export interface DeliveryEffect {
  readonly consumer: PaymentConsumerName;
  handle(delivery: CommerceEventDelivery): Promise<ConsumerOutcome>;
}

/** When the event was recorded: the instant its UUIDv7 id was minted by the unit of work that published it. */
export function recordedAtOf(eventId: EventId): UtcInstant {
  return toUtcInstant(uuidV7Timestamp(eventId));
}

/**
 * Adopts the agency of a delivered commerce event through its stored operation (D-SCOPE-B1): a refund's own scope row, else the
 * order the payload names; the adopted agency must be the event's.
 */
async function adoptDelivery(uow: CommerceUnitOfWork, delivery: CommerceEventDelivery): Promise<AgencyId> {
  const kind = delivery.eventType.split(".")[0];
  let adopted: AgencyId | null = null;
  if (kind === "refund") adopted = await uow.adoptScope("REFUND", delivery.aggregateId);
  else {
    const orderId = delivery.payload["orderId"];
    if (typeof orderId === "string") adopted = await uow.adoptScope("PAYMENT_ORDER", orderId);
  }
  if (adopted === null || adopted !== delivery.agencyId) throw new DomainFailure("INTEGRITY_FAILURE", `${delivery.eventType} ${delivery.eventId} names no stored operation of its agency`);
  return adopted;
}

// --- FINANCE ----------------------------------------------------------------------------------------------------------------------

export function financeConsumer(): CommerceEventConsumer {
  return {
    consumer: "FINANCE",
    eventTypes: eventTypesOf("FINANCE"),
    async consume(uow, delivery, now) {
      // a case's resolution sources the reviewed correction its owner records (B12; D-LEDGER-B4): none exists here
      if (delivery.eventType === "reconciliation_case.resolved.v1") return "NOT_APPLICABLE";
      const agencyId = await adoptDelivery(uow, delivery);
      causedBy(uow, delivery.eventId);
      const plan = planPostings({ eventId: delivery.eventId, eventType: delivery.eventType, aggregateId: delivery.aggregateId, agencyId, payload: delivery.payload as Parameters<typeof planPostings>[0]["payload"], recordedAt: recordedAtOf(delivery.eventId) });
      if (plan.kind === "NOT_APPLICABLE") return "NOT_APPLICABLE";
      const posted = await uow.commerce.ledger.post(plan.set, now);
      return posted.posted ? "APPLIED" : "DUPLICATE";
    },
  };
}

// --- FISCAL ---------------------------------------------------------------------------------------------------------------------

/** How long a credit note of a refund whose invoice is not drafted yet waits before its delivery is tried again. */
export const AWAIT_INVOICE_SECONDS = 60;

async function applyFiscalPlan(uow: CommerceUnitOfWork, plan: FiscalPlan, now: UtcInstant): Promise<ConsumerOutcome> {
  const docs = uow.commerce.taxDocuments;
  const validated = async (documentId: TaxDocumentId, version: number): Promise<void> => {
    const w = await docs.transition(documentId, version, { state: "VALIDATED" }, now);
    if (w.kind === "STALE") throw new DomainFailure("STALE_VERSION", "the tax document changed while it was validated", { currentVersion: w.currentVersion, currentState: w.currentState }, true);
  };
  switch (plan.kind) {
    case "NONE":
      if (plan.reason === "ALREADY_DRAFTED" || plan.reason === "UNCHANGED") return "DUPLICATE";
      if (plan.reason === "AWAIT_INVOICE") throw new NotDueYet(toUtcInstant(Date.parse(now) + AWAIT_INVOICE_SECONDS * 1000));
      return "NOT_APPLICABLE";
    case "DRAFT": {
      const drafted = await docs.draft({ ...plan.document, documentId: uow.ids.next() as TaxDocumentId, createdAt: now });
      if (plan.validate) await validated(drafted.documentId, drafted.version);
      return "APPLIED";
    }
    case "REDRAFT": {
      const w = await docs.redraft(plan.documentId, plan.expectedVersion, plan.change, now);
      if (w.kind === "STALE") throw new DomainFailure("STALE_VERSION", "the draft changed while it was re-evaluated", { currentVersion: w.currentVersion, currentState: w.currentState }, true);
      if (plan.validate) await validated(plan.documentId, w.record.version);
      return "APPLIED";
    }
    case "VALIDATE":
      await validated(plan.documentId, plan.expectedVersion);
      return "APPLIED";
  }
}

export function fiscalConsumer(): CommerceEventConsumer {
  return {
    consumer: "FISCAL",
    eventTypes: eventTypesOf("FISCAL"),
    async consume(uow, delivery, now) {
      // a validated or uncertain document is the issuance command's (CMD035, package B15; Q-B09-6)
      if (delivery.eventType !== "capture.completed.v1" && delivery.eventType !== "refund.completed.v1") return "NOT_APPLICABLE";
      const agencyId = await adoptDelivery(uow, delivery);
      causedBy(uow, delivery.eventId);
      const c = uow.commerce;
      if (delivery.eventType === "capture.completed.v1") {
        const capture = await c.captures.get(delivery.aggregateId as CaptureId);
        if (capture === null) throw new NotFoundFailure("capture");
        const order = await c.orders.get(capture.orderId);
        const quote = order === null ? null : await c.quotes.get(order.quoteId);
        if (order === null || quote === null) throw new DomainFailure("INTEGRITY_FAILURE", "a capture's order and quote are visible to its scope");
        // the version every document of the sale takes: the one of the sale's tax point, the capture's completion (D-FISC-B6)
        const saleProfile = capture.providerCompletedAt === undefined ? null : await c.fiscal.saleProfileAt(agencyId, capture.providerCompletedAt);
        const currentProfile = await c.fiscal.currentProfile(agencyId);
        const chosen = saleProfile ?? currentProfile;
        const issuer = chosen === null ? null : await c.fiscal.getIssuer(chosen.operatorLegalRef);
        const existing = await c.taxDocuments.findLiveInvoice(capture.captureId);
        return applyFiscalPlan(uow, planFiscalDocument({ kind: "INVOICE", capture, order, priced: quote.tax, saleProfile, currentProfile, issuer, existing }), now);
      }
      const refund = await c.refunds.get(delivery.aggregateId as RefundId);
      if (refund === null) throw new NotFoundFailure("refund");
      const invoice = await c.taxDocuments.findLiveInvoice(refund.captureId);
      const existing = await c.taxDocuments.findLiveCreditNote(refund.refundId);
      return applyFiscalPlan(uow, planFiscalDocument({ kind: "CREDIT_NOTE", refund, invoice, existing }), now);
    },
  };
}

/**
 * Re-evaluates an agency's blocked drafts after its reviewed facts changed (design §8.1 FISCAL): a later review whose validity
 * reaches back to the sale resolves an unknown treatment; it never changes a known one (D-FISC-B6). Run in a SERVICE unit of work
 * that adopted the agency (through one of its stored operations); answers how many drafts moved.
 */
export async function reevaluateBlockedDrafts(uow: CommerceUnitOfWork, now: UtcInstant, limit = 50): Promise<number> {
  const c = uow.commerce;
  const agencyId = uow.commerceScope;
  if (agencyId === null) throw new DomainFailure("INTEGRITY_FAILURE", "the blocked drafts of an agency are re-evaluated in its adopted scope");
  let moved = 0;
  for (const draft of await c.taxDocuments.listBlockedDrafts(limit)) {
    const capture = await c.captures.get(draft.captureId);
    const order = capture === null ? null : await c.orders.get(capture.orderId);
    const quote = order === null ? null : await c.quotes.get(order.quoteId);
    if (capture === null || quote === null) continue;
    const saleProfile = capture.providerCompletedAt === undefined ? null : await c.fiscal.saleProfileAt(agencyId, capture.providerCompletedAt);
    const issuer = saleProfile === null ? null : await c.fiscal.getIssuer(saleProfile.operatorLegalRef);
    const invoice = draft.kind === "CREDIT_NOTE" ? await c.taxDocuments.findLiveInvoice(draft.captureId) : null;
    const outcome = await applyFiscalPlan(uow, planFiscalDocument({ kind: "REEVALUATE", draft, capture, priced: quote.tax, saleProfile, issuer, invoice }), now);
    if (outcome === "APPLIED") moved += 1;
  }
  return moved;
}

// --- PAYMENT_SERVICE --------------------------------------------------------------------------------------------------------------

/** The refund executor's journal key: derived from the refund and the version it was approved at (design §8.1). */
export function refundExecutionKey(refundId: string, version: number): string {
  return `refund-execute-${refundId}-v${version}`;
}

const SETTLED_ELSEWHERE = new Set(["STALE_VERSION", "PRECONDITION_FAILED", "PAYMENT_PENDING", "PAYMENT_UNCERTAIN", "IDEMPOTENCY_CONFLICT", "OPERATION_CANCELLED"]);

async function executeApprovedRefund(rt: PaymentRuntime, refundId: RefundId, version: number): Promise<ConsumerOutcome> {
  const result = await executeRefund(rt, {
    correlationId: rt.ids.next() as CorrelationId,
    idempotencyKey: refundExecutionKey(refundId, version),
    identity: rt.self,
    path: { refundId },
    body: { expectedVersion: version },
  });
  switch (result.kind) {
    case "COMPLETED":
    case "ACCEPTED":
      // an effect still unknown is durable and uncertain: the watchdog carries it on (refund.uncertain.v1, payment_attempt.uncertain.v1)
      return "APPLIED";
    case "CONFLICT":
      // the refund moved on (executed under another key, reversed, reconciled): nothing is left for this delivery
      if (SETTLED_ELSEWHERE.has(result.problem.code)) return "NOT_APPLICABLE";
      break;
    default:
      break;
  }
  throw new DomainFailure(result.problem.code, `the refund executor was answered ${result.problem.code}`, result.problem.reason !== undefined ? { reason: result.problem.reason } : {}, result.problem.retryable);
}

async function watchRefund(rt: PaymentRuntime, refundId: RefundId): Promise<ConsumerOutcome> {
  const context = { kind: "SERVICE" as const, serviceId: rt.self.serviceId, correlationId: rt.ids.next() as CorrelationId };
  const live = await rt.assembly.commerce.run(context, async (uow) => {
    if ((await uow.adoptScope("REFUND", refundId)) === null) return null;
    return uow.commerce.attempts.findLive({ refundId });
  });
  if (live === null) return "NOT_APPLICABLE";
  return watchAttempt(rt, live.orderId, live.attemptId);
}

// --- Payments V1 registration seam (lane KIT; docs/design/ACH-ROUTE.md) -----------------------------------------------------------

/** A bank-transfer delivery handler a lane registers for one (consumer, event type); it runs exactly like the handlers above. */
export type BankDeliveryHandler = (rt: PaymentRuntime, delivery: CommerceEventDelivery) => Promise<ConsumerOutcome>;

const bankHandlers = new Map<string, BankDeliveryHandler>();

/**
 * Registers the handler of an event type of the bank-transfer route for the payment service. One handler per type: a second registration
 * is a programming error and is refused, so two lanes can never both act on one delivery. With nothing registered the dispatch below is
 * exactly what it was (NOT_APPLICABLE). FINANCE needs no registration: planPostings dispatches to core/bank-postings and core/return-postings.
 */
export function registerBankDeliveryHandler(eventType: string, handler: BankDeliveryHandler): void {
  if (bankHandlers.has(eventType)) throw new Error(`a bank-transfer handler is already registered for ${eventType}`);
  bankHandlers.set(eventType, handler);
}

function bankHandlerOf(eventType: string): BankDeliveryHandler | undefined {
  return bankHandlers.get(eventType);
}

export function paymentServiceEffect(rt: PaymentRuntime): DeliveryEffect {
  return {
    consumer: "PAYMENT_SERVICE",
    async handle(delivery) {
      switch (delivery.eventType) {
        case "payment_attempt.dispatching.v1":
        case "payment_attempt.provider_pending.v1":
        case "payment_attempt.uncertain.v1": {
          const orderId = delivery.payload["orderId"];
          if (typeof orderId !== "string") throw new DomainFailure("INTEGRITY_FAILURE", `${delivery.eventType} ${delivery.eventId} names no order`);
          return watchAttempt(rt, orderId as PaymentOrderId, delivery.aggregateId as PaymentAttemptId);
        }
        case "refund.approved.v1":
          return executeApprovedRefund(rt, delivery.aggregateId as RefundId, delivery.aggregateVersion);
        case "refund.uncertain.v1":
          return watchRefund(rt, delivery.aggregateId as RefundId);
        default:
          return bankHandlerOf(delivery.eventType)?.(rt, delivery) ?? "NOT_APPLICABLE";
      }
    },
  };
}

/** A single-unit-of-work consumer as a dispatcher effect: one SERVICE unit of work per delivery. */
export function unitOfWorkEffect(rt: PaymentRuntime, consumer: CommerceEventConsumer): DeliveryEffect {
  return {
    consumer: consumer.consumer,
    async handle(delivery) {
      const context = { kind: "SERVICE" as const, serviceId: rt.self.serviceId, correlationId: rt.ids.next() as CorrelationId };
      return rt.assembly.commerce.run(context, (uow) => consumer.consume(uow, delivery, rt.clock.now()));
    },
  };
}

