/**
 * CommerceReconciler — the one algorithm of design §6.3 for every capture path (CMD029's settle step, the application of a verified
 * webhook, CMD034, and the settle steps of CMD028 and CMD033), coded against the repository ports of @kauro/domain ports/commerce.
 * It runs inside the caller's SERVICE unit of work (kauro_payment: the only writer of provider-observed facts and of entitlements,
 * D-AUTH-B4) and never calls a provider: every observation arrives authenticated.
 *
 *  1. attribute — the webhook adopts its agency through the scope index (provider + environment + provider id); an unknown
 *     identity is an unattributed exception UNKNOWN_PROVIDER_REFERENCE, never a guess from a payload's agency (10);
 *  2. order the locks (§6.2) — the ids are read without a lock; the purchased subject is read after the shared halves of its
 *     transition locks (PurchasedSubjectReader: agency → capability → approval → source revision → target contract), then the
 *     fiscal profile and the quote, then the order's row lock (FOR UPDATE), which serializes every writer of the order's facts;
 *  3–6. planObservation decides; the executor performs the writes in the plan's lock order;
 *  7. each version's event (publishVersionEvent: exactly one per version, the planned type; D-CORE-B1), server requests' and cases'
 *     events only when they were created, and — for a webhook — the inbox record's settlement in the same transaction: APPLIED with
 *     the result event, REJECTED for a mismatch, IGNORED for a duplicate, stale or unknown reference, RETRYABLE when a completion
 *     waits for a provider query (D-PAY-B6).
 * A compare-and-swap that loses (a concurrent writer of an attempt, refund or entitlement that does not take the order's lock) aborts
 * the unit of work with a retryable STALE_VERSION: the caller retries the whole application.
 */
import type { UtcInstant } from "@kauro/contracts";
import type {
  CausationId,
  CommerceUnitOfWork,
  CommercialAuthorizationRecord,
  DomainEventRecord,
  EvidenceArtifactRef,
  InboxId,
  NormalizedProviderEvent,
  PaymentAttemptId,
  PaymentOrderId,
  ProviderExceptionKind,
  RefundRecord,
  ScopeKind,
  VersionedWrite,
} from "@kauro/domain";
import { DomainFailure, NotFoundFailure, providerScopeKey } from "@kauro/domain";
import type { CommerceReconciler, ProviderDispatchResult, ProviderOrderObservation, ReconcileResult } from "../ports.js";
import { MAX_ATTEMPTS_PER_OPERATION } from "../protocol.js";
import { publishVersionEvent } from "./events.js";
import { planObservation, type ObservationContent, type ObservationOrigin, type ObservationPlan } from "./observation.js";
import type { PurchasedSubjectReader } from "./subject.js";

export interface CommerceReconcilerDependencies {
  /** The column-scoped read of the purchased subject (D-CORE-B2). */
  readonly subjects: PurchasedSubjectReader;
  /** The payment provider adapter's allowlisted approval hosts (10). */
  readonly approvalHosts: ReadonlyArray<string>;
  readonly maxAttempts?: number;
}

function isOrderObservation(o: ProviderDispatchResult | ProviderOrderObservation): o is ProviderOrderObservation {
  return "orderStatus" in o;
}

function applied<T>(write: VersionedWrite<T>, what: string): T {
  if (write.kind === "STALE") {
    // a concurrent writer changed the row between the read and the write: the whole application is retried
    throw new DomainFailure("STALE_VERSION", `${what} changed concurrently: current is ${write.currentVersion} (${write.currentState})`, { currentVersion: write.currentVersion, currentState: write.currentState }, true);
  }
  return write.record;
}

function requireService(uow: CommerceUnitOfWork): void {
  if (uow.context.kind !== "SERVICE") throw new DomainFailure("INTEGRITY_FAILURE", "the reconciler runs in a SERVICE unit of work of the payment service (kauro_payment; D-AUTH-B4)");
}

export function createCommerceReconciler(deps: CommerceReconcilerDependencies): CommerceReconciler {
  const maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS_PER_OPERATION;

  async function planFor(uow: CommerceUnitOfWork, orderId: PaymentOrderId, origin: ObservationOrigin, content: ObservationContent, now: UtcInstant): Promise<ObservationPlan> {
    const c = uow.commerce;
    // ids first, without a lock (design §6.2): the order names its quote, the quote its subject
    const unlocked = await c.orders.get(orderId);
    if (unlocked === null) throw new NotFoundFailure("payment_order");
    const quote = await c.quotes.get(unlocked.quoteId);
    if (quote === null) throw new DomainFailure("INTEGRITY_FAILURE", "a payment order's quote is not visible to its payment service scope");
    // the shared halves of what an issuance relies on, in the platform's lock order, then the order's row lock
    const subject = await deps.subjects.subjectOf(uow, quote);
    const currentProfile = await c.fiscal.currentProfile(unlocked.agencyId);
    const order = await c.orders.lock(orderId);
    if (order === null) throw new NotFoundFailure("payment_order");
    const attempts = await c.attempts.listForOrder(orderId);
    const captures = await c.captures.listForOrder(orderId);
    const authorizations = new Map<string, CommercialAuthorizationRecord>();
    const ofQuote = await c.authorizations.findByQuote(quote.quoteId);
    if (ofQuote !== null) authorizations.set(ofQuote.authorizationId, ofQuote);
    const refunds: RefundRecord[] = [];
    for (const capture of captures) {
      const live = await c.authorizations.findLiveByCapture(capture.captureId);
      if (live !== null) authorizations.set(live.authorizationId, live);
      refunds.push(...(await c.refunds.listForCapture(capture.captureId)));
    }
    const observations = await c.observations.listForOrder(orderId);
    return planObservation(
      { now, order, quote, subject, currentProfile, attempts, captures, authorizations: [...authorizations.values()], refunds, observations, approvalHosts: deps.approvalHosts, maxAttempts },
      { origin, content, mint: () => uow.ids.next() },
    );
  }

  async function execute(uow: CommerceUnitOfWork, plan: ObservationPlan, causationId: CausationId, now: UtcInstant): Promise<{ readonly result: ReconcileResult; readonly published: ReadonlyArray<DomainEventRecord> }> {
    const c = uow.commerce;
    const before = uow.events.appended.length;
    const openedCases: Array<ReconcileResult["openedCases"][number]> = [];
    for (const step of plan.steps) {
      switch (step.op) {
        case "ORDER_TRANSITION":
          applied(await c.orders.transition(step.orderId, step.expectedVersion, step.change, now), "payment order");
          await publishVersionEvent(uow, step.event, causationId);
          break;
        case "ATTEMPT_TRANSITION":
          applied(await c.attempts.transition(step.attemptId, step.expectedVersion, step.change, now), "payment attempt");
          await publishVersionEvent(uow, step.event, causationId);
          break;
        case "CAPTURE_INSERT":
          await c.captures.insert(step.fact);
          await publishVersionEvent(uow, step.event, causationId);
          break;
        case "CAPTURE_ADVANCE":
          applied(await c.captures.advance(step.captureId, step.expectedVersion, step.change, now), "capture");
          await publishVersionEvent(uow, step.event, causationId);
          break;
        case "CAPTURE_FEE":
          applied(await c.captures.observeFee(step.captureId, step.expectedVersion, step.change, now), "capture");
          await publishVersionEvent(uow, step.event, causationId);
          break;
        case "CAPTURE_FUNDS":
          applied(await c.captures.observeFunds(step.captureId, step.expectedVersion, step.change, now), "capture");
          await publishVersionEvent(uow, step.event, causationId);
          break;
        case "AUTHORIZATION_ISSUE":
          await c.authorizations.issue(step.authorization);
          await publishVersionEvent(uow, step.event, causationId);
          break;
        case "AUTHORIZATION_TRANSITION":
          applied(await c.authorizations.transition(step.authorizationId, step.expectedVersion, step.change, now), "commercial authorization");
          await publishVersionEvent(uow, step.event, causationId);
          break;
        case "REFUND_TRANSITION":
          applied(await c.refunds.transition(step.refundId, step.expectedVersion, step.change, now), "refund");
          await publishVersionEvent(uow, step.event, causationId);
          break;
        case "REFUND_FILE": {
          // ON CONFLICT DO NOTHING: an open request of the same capture and origin is the answer, never an abort (D-REF-B1)
          const filed = await c.refunds.fileServerRequest(step.request);
          if (filed.filed) {
            await publishVersionEvent(uow, step.event, causationId);
            await uow.scopes.record(step.scope, now);
          }
          break;
        }
        case "CASE_OPEN": {
          const opened = await c.cases.open(step.entry);
          if (opened.opened) {
            await publishVersionEvent(uow, step.event, causationId);
            openedCases.push({ caseId: opened.record.caseId, kind: opened.record.kind });
          }
          break;
        }
        case "EXCEPTION":
          await c.exceptions.record(step.exception);
          break;
        case "SCOPE":
          await uow.scopes.record(step.entry, now);
          break;
        case "OBSERVATION":
          await c.observations.append(step.observation);
          break;
      }
    }
    const published = uow.events.appended.slice(before);
    return {
      result: {
        effects: plan.effects,
        openedCases,
        authorizationIssued: plan.authorizationIssued,
        resultEventId: published[0]?.eventId ?? null,
        providerQueryRequired: plan.providerQueryRequired,
      },
      published,
    };
  }

  /** The scope keys a verified event can be attributed by, most specific first (D-SCOPE-B1, B2). */
  function scopeKeysOf(event: NormalizedProviderEvent): ReadonlyArray<{ readonly kind: ScopeKind; readonly key: string }> {
    const out: Array<{ kind: ScopeKind; ref: string }> = [];
    if (event.capture !== undefined) out.push({ kind: "PROVIDER_CAPTURE", ref: event.capture.providerCaptureId });
    if (event.refund !== undefined) out.push({ kind: "PROVIDER_REFUND", ref: event.refund.providerRefundId }, { kind: "PROVIDER_CAPTURE", ref: event.refund.providerCaptureId });
    if (event.dispute !== undefined) out.push({ kind: "PROVIDER_CAPTURE", ref: event.dispute.providerCaptureId });
    if (event.capture?.providerOrderId != null) out.push({ kind: "PROVIDER_ORDER", ref: event.capture.providerOrderId });
    if (event.providerOrderId !== undefined) out.push({ kind: "PROVIDER_ORDER", ref: event.providerOrderId });
    const keys: Array<{ kind: ScopeKind; key: string }> = [];
    for (const { kind, ref } of out) {
      try {
        keys.push({ kind, key: providerScopeKey(event.provider, event.environment, ref) });
      } catch {
        // a reference outside the provider-id alphabet names nothing the index can hold
      }
    }
    return keys;
  }

  const empty = (resultEventId: ReconcileResult["resultEventId"]): ReconcileResult => ({ effects: [], openedCases: [], authorizationIssued: null, resultEventId, providerQueryRequired: false });

  return {
    async applyOrderObservation(uow, input) {
      requireService(uow);
      if (uow.commerceScope === null) throw new DomainFailure("INTEGRITY_FAILURE", "the SERVICE unit of work adopts the stored operation's agency before it reconciles (D-SCOPE-B1)");
      const observation = input.observation;
      const orderObservation = isOrderObservation(observation);
      let origin: ObservationOrigin;
      if (input.source === "PROVIDER_QUERY") {
        if (input.artifactRef === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a stored provider query is applied with its artifact (D-PAY-B3)");
        origin = { source: "PROVIDER_QUERY", artifactRef: input.artifactRef as EvidenceArtifactRef };
      } else {
        if (input.attemptId === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a dispatch response is applied with the attempt it answers (D-PAY-B3)");
        origin = { source: "DISPATCH_RESPONSE", attemptId: input.attemptId as PaymentAttemptId };
      }
      const content: ObservationContent = orderObservation ? { kind: "ORDER_OBSERVATION", observation } : { kind: "DISPATCH_RESULT", result: observation };
      if (!orderObservation && origin.source === "PROVIDER_QUERY") throw new DomainFailure("INTEGRITY_FAILURE", "a stored provider query is an order observation");
      const plan = await planFor(uow, input.orderId, origin, content, input.now);
      return (await execute(uow, plan, input.causationId, input.now)).result;
    },

    async applyProviderEvent(uow, input) {
      requireService(uow);
      const c = uow.commerce;
      const now = input.now;
      const event = input.event;
      const entry = await c.inbox.lockForApply(input.inboxId);
      if (entry === null) throw new NotFoundFailure("inbox_record");
      // a record already settled was applied once (15 "deduplicates by provider, environment and event ID")
      if (entry.state === "APPLIED" || entry.state === "IGNORED" || entry.state === "REJECTED") return { kind: "APPLIED", result: empty(entry.resultEventId ?? null) };
      if (entry.provider !== event.provider || entry.environment !== event.environment || entry.externalEventId !== event.externalEventId || entry.bodyHash !== event.bodyHash) {
        throw new DomainFailure("INTEGRITY_FAILURE", "the normalized event is not the recorded delivery of this inbox record");
      }
      const unattributed = async (kind: ProviderExceptionKind, outcome: "IGNORED" | "REJECTED") => {
        await c.exceptions.record({ source: "WEBHOOK", inboxId: input.inboxId as InboxId, provider: event.provider, environment: event.environment, kind, evidenceHash: event.bodyHash, observedAt: now });
        await c.inbox.settle(input.inboxId, { state: outcome }, now);
        return { kind: "EXCEPTION" as const, exceptionKind: kind };
      };
      // a delivery whose event id arrived with another body is never applied (B06 D-ING-1, KA012): the owner reviews the conflict
      if (entry.conflictingBodies > 0) return unattributed("BODY_CONFLICT", "REJECTED");
      // 1. attribute through the scope index, never through a payload's agency (10)
      let attribution: { readonly kind: ScopeKind; readonly key: string; readonly orderId: PaymentOrderId } | null = null;
      for (const k of scopeKeysOf(event)) {
        const found = await uow.scopes.resolve(k.kind, k.key);
        if (found !== null) {
          attribution = { kind: k.kind, key: k.key, orderId: found.orderId };
          break;
        }
      }
      if (attribution === null) return unattributed(event.kind === "UNRECOGNIZED" ? "UNRECOGNIZED_PROVIDER_STATE" : "UNKNOWN_PROVIDER_REFERENCE", "IGNORED");
      if (uow.commerceScope === null) {
        if ((await uow.adoptScope(attribution.kind, attribution.key)) === null) return unattributed("UNKNOWN_PROVIDER_REFERENCE", "IGNORED");
      }
      const plan = await planFor(uow, attribution.orderId, { source: "WEBHOOK", inboxId: input.inboxId as InboxId }, { kind: "PROVIDER_EVENT", event }, now);
      const { result, published } = await execute(uow, plan, input.causationId, now);
      const first = published[0];
      if (plan.providerQueryRequired && first === undefined) {
        // D-PAY-B6: a completion that waits for its instant is revisited once a provider query recorded the capture
        await c.inbox.settle(input.inboxId, { state: "RETRYABLE" }, now);
        return { kind: "APPLIED", result };
      }
      if (first !== undefined) await c.inbox.settle(input.inboxId, { state: "APPLIED", resultEventId: first.eventId }, now);
      else await c.inbox.settle(input.inboxId, { state: plan.exceptions.length > 0 ? "REJECTED" : "IGNORED" }, now);
      const exceptionKind = plan.exceptions[0];
      if (exceptionKind !== undefined && first === undefined) return { kind: "EXCEPTION", exceptionKind };
      return { kind: "APPLIED", result };
    },
  };
}

