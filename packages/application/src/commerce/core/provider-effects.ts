/**
 * The provider-effect runtime (design §6.1; D-PROTO-B1..B6, D-JOURNAL-B1): the phases of a command with an external effect —
 * CMD028 (CREATE_ORDER), CMD029 (CAPTURE), CMD033 (REFUND) — and `runProviderCommand`, which sequences them with the B06 journal:
 *
 *   T1 intent   the principal's unit of work, in B06's pipeline order: access decision → journal reserve (RESERVED) → assurance →
 *               the command's own locked preconditions and durable intent (the caller's `intent`: order or refund, the attempt
 *               PREPARED with its exact request hash — prepareProviderAttempt —, the scope rows, events) → COMMIT
 *   T2 claim    the principal's unit of work: the order's row lock, the attempt PREPARED → DISPATCHING with the database's own
 *               deadline (the claim writes no instant of its own: DISPATCH_DEADLINE_SECONDS on the database's clock,
 *               payment_attempts_dispatch_deadline_bound; D-PROTO-B6) and the aggregate's dispatch edge — the single serialization
 *               point of "dispatch at most once"; the request is re-prepared from durable facts and must hash to the attempt's
 *   call        outside any transaction: exactly that request under `kauro-<attemptId>`, bounded by the deadline
 *   T3 settle   a SERVICE unit of work of the payment service (kauro_payment) that adopts the stored operation's agency
 *               (PAYMENT_ORDER / REFUND scope) and applies the result through the CommerceReconciler; never the journal
 *   T4 complete the principal's unit of work: COMMITTED with the conclusive 2xx answer, or UNCERTAIN with a 202 AcceptedResponse
 *               naming the durable operation when the effect is unknown or in flight
 *
 * Resume (same key and digest; the journal answers PENDING for RESERVED and UNCERTAIN): the access decision runs again, the
 * operation is found by its journal entry and continued from its durable state (nextProtocolStep): PREPARED → claim and call;
 * DISPATCHING / PROVIDER_PENDING / UNCERTAIN → observe by the attempt's request identity (never a second dispatch) and settle when
 * conclusive, else 202; a creation that proved no effect with attempts left → a new deliberate attempt; settled → T4 only.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type {
  CaptureFactRecord,
  CausationId,
  Clock,
  CommerceUnitOfWork,
  CommerceUnitOfWorkFactory,
  CorrelationId,
  ExecutionContext,
  FailureCode,
  IdempotencyIdentity,
  JournalEntryId,
  PaymentAttemptId,
  PaymentAttemptRecord,
  PaymentOrderId,
  PaymentOrderRecord,
  ProviderRequest,
  RefundId,
  RefundRecord,
  ServiceContext,
} from "@kauro/domain";
import { DomainFailure, IdempotencyConflictFailure, NotFoundFailure, providerRequestHash, providerRequestIdOf } from "@kauro/domain";
import { judgedUnderHold, type RequestAuthority } from "../../api/authority.js";
import type { CommandResult } from "../../api/envelope.js";
import { problemOf } from "../../api/problems.js";
import type { CommerceReconciler, PaymentProviderAdapter, ProviderDispatchResult, ProviderOrderObservation } from "../ports.js";
import { MAX_ATTEMPTS_PER_OPERATION, PENDING_POLL_AFTER_SECONDS, type DispatchTicket, type DurableOperation, type IntentOutcome, type ProviderCommandPhases, type ProviderEffect, type SettleOutcome } from "../protocol.js";
import { publishVersionEvent, versionEvent } from "./events.js";
import { nextProtocolStep, settledOutcome, type ProtocolState } from "./protocol-steps.js";

// --- the exact request of an attempt ----------------------------------------------------------------------------------------------

/** The web surface's return and cancel paths of a checkout: deterministic from the order, because the request hash covers them. */
export function checkoutPaths(orderId: string): { readonly returnPath: string; readonly cancelPath: string } {
  return { returnPath: `/app/checkout/${orderId}/return`, cancelPath: `/app/checkout/${orderId}/cancel` };
}

export type AttemptSubject =
  | { readonly effect: "CREATE_ORDER"; readonly order: PaymentOrderRecord }
  | { readonly effect: "CAPTURE"; readonly order: PaymentOrderRecord }
  | { readonly effect: "REFUND"; readonly order: PaymentOrderRecord; readonly refund: RefundRecord; readonly capture: CaptureFactRecord };

/** The exact normalized request an attempt of this subject may send (its digest is the attempt's requestHash; reference/HASHING). */
export function attemptRequest(adapter: PaymentProviderAdapter, subject: AttemptSubject, attemptId: string): ProviderRequest {
  const providerRequestId = providerRequestIdOf(attemptId);
  switch (subject.effect) {
    case "CREATE_ORDER":
      return adapter.prepareCreateOrder({
        orderId: subject.order.orderId,
        attemptId,
        providerRequestId,
        amountCents: subject.order.expectedAmountCents,
        currency: subject.order.currency,
        description: "KAURO_PROJECT_PREPARATION",
        ...checkoutPaths(subject.order.orderId),
      });
    case "CAPTURE":
      if (subject.order.providerOrderId === undefined) throw new DomainFailure("PRECONDITION_FAILED", "an order without its provider identity cannot be captured", { reason: "ORDER_NOT_CAPTURABLE" });
      return adapter.prepareCapture({ orderId: subject.order.orderId, attemptId, providerRequestId, providerOrderId: subject.order.providerOrderId, amountCents: subject.order.expectedAmountCents, currency: subject.order.currency });
    case "REFUND": {
      const approved = subject.refund.approved;
      if (approved === undefined) throw new DomainFailure("PRECONDITION_FAILED", "only an approved refund is executed", { reason: "REFUND_NOT_APPROVED" });
      const amountCents = approved.amounts.serviceCents + approved.amounts.taxCents + approved.amounts.excessCents;
      return adapter.prepareRefund({ refundId: subject.refund.refundId, attemptId, providerRequestId, providerCaptureId: subject.capture.providerCaptureId, amountCents, currency: subject.order.currency });
    }
  }
}

/**
 * T1's durable attempt (and a later deliberate attempt of a creation): the attempt PREPARED with the digest of its exact request and
 * its provider request identity `kauro-<attemptId>`, and its event — before any call is possible (D-PROTO-B1). The caller holds the
 * aggregate's row lock and has checked the preconditions.
 */
export async function prepareProviderAttempt(
  uow: CommerceUnitOfWork,
  input: { readonly adapter: PaymentProviderAdapter; readonly subject: AttemptSubject; readonly ordinal: number; readonly intentEntryId?: JournalEntryId; readonly causationId: CausationId; readonly now: UtcInstant },
): Promise<PaymentAttemptRecord> {
  const attemptId = uow.ids.next() as PaymentAttemptId;
  const request = attemptRequest(input.adapter, input.subject, attemptId);
  const order = input.subject.order;
  const refundId = input.subject.effect === "REFUND" ? input.subject.refund.refundId : undefined;
  const attempt = await uow.commerce.attempts.prepare({
    attemptId,
    agencyId: order.agencyId,
    orderId: order.orderId,
    ...(refundId !== undefined ? { refundId } : {}),
    operation: input.subject.effect,
    ordinal: input.ordinal,
    provider: order.provider,
    environment: order.environment,
    requestHash: providerRequestHash(request),
    providerRequestId: providerRequestIdOf(attemptId),
    ...(input.intentEntryId !== undefined ? { intentEntryId: input.intentEntryId } : {}),
    startedAt: input.now,
  });
  await publishVersionEvent(
    uow,
    versionEvent("payment_attempt", attemptId, attempt.version, order.agencyId, { previousState: null, state: "PREPARED" }, {
      attemptId,
      agencyId: order.agencyId,
      orderId: order.orderId,
      refundId,
      operation: input.subject.effect,
      ordinal: input.ordinal,
      requestHash: attempt.requestHash,
    }),
    input.causationId,
  );
  return attempt;
}

// --- durable operations -----------------------------------------------------------------------------------------------------------

async function subjectOf(uow: CommerceUnitOfWork, effect: ProviderEffect, attempt: PaymentAttemptRecord, lock: boolean): Promise<AttemptSubject> {
  const c = uow.commerce;
  // the claim locks the order only where it writes it: a creation's first claim (INTENT_CREATED → CREATING), a capture's claim
  // (CREATED | APPROVED → CAPTURING) and a refund's claim (the payment service's own). A later attempt of a creation leaves the order
  // CREATING and writes only the attempt, whose compare-and-swap is the serialization point; the request handlers may not lock an
  // order they do not move (payment_orders_tenant_claim admits INTENT_CREATED, CREATED and APPROVED only; D-AUTH-B4, D-REQ-B8)
  const unlocked = await c.orders.get(attempt.orderId);
  const writes = lock && (effect !== "CREATE_ORDER" || unlocked?.state === "INTENT_CREATED");
  const order = writes ? await c.orders.lock(attempt.orderId) : unlocked;
  if (order === null) throw new NotFoundFailure("payment_order");
  if (effect !== "REFUND") return { effect, order };
  if (attempt.refundId === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a REFUND attempt names its refund");
  const refund = await c.refunds.get(attempt.refundId);
  if (refund === null) throw new NotFoundFailure("refund");
  const capture = await c.captures.get(refund.captureId);
  if (capture === null) throw new DomainFailure("INTEGRITY_FAILURE", "a refund's capture is visible to its scope");
  return { effect, order, refund, capture };
}

/** The durable operation of an attempt, with the provider identities a read-only observation needs (D-CORE-B4). */
export async function operationOf(uow: CommerceUnitOfWork, effect: ProviderEffect, journalEntryId: JournalEntryId, attempt: PaymentAttemptRecord): Promise<DurableOperation> {
  const subject = await subjectOf(uow, effect, attempt, false);
  const resource =
    subject.effect === "REFUND"
      ? { kind: "refund" as const, id: subject.refund.refundId, statusPath: `/api/v1/refunds/${subject.refund.refundId}` }
      : { kind: "payment_order" as const, id: subject.order.orderId, statusPath: `/api/v1/payment-orders/${subject.order.orderId}` };
  return {
    journalEntryId,
    attempt,
    resource,
    ...(subject.order.providerOrderId !== undefined ? { providerOrderId: subject.order.providerOrderId } : {}),
    ...(subject.effect === "REFUND" ? { providerCaptureId: subject.capture.providerCaptureId } : {}),
  };
}

async function protocolStateOf(uow: CommerceUnitOfWork, effect: ProviderEffect, operation: DurableOperation, maxAttempts: number): Promise<{ readonly state: ProtocolState; readonly attempt: PaymentAttemptRecord }> {
  const attempt = await uow.commerce.attempts.get(operation.attempt.attemptId);
  if (attempt === null) throw new NotFoundFailure("payment_attempt");
  let aggregateState: ProtocolState["aggregateState"];
  if (effect === "REFUND") {
    const refund = await uow.commerce.refunds.get(operation.resource.id as RefundId);
    if (refund === null) throw new NotFoundFailure("refund");
    aggregateState = refund.state;
  } else {
    const order = await uow.commerce.orders.get(operation.resource.id as PaymentOrderId);
    if (order === null) throw new NotFoundFailure("payment_order");
    aggregateState = order.state;
  }
  return { state: { effect, attempt, aggregateState, maxAttempts }, attempt };
}

// --- the phases -------------------------------------------------------------------------------------------------------------------

export interface ProviderEffectDependencies {
  readonly adapter: PaymentProviderAdapter;
  readonly reconciler: CommerceReconciler;
  readonly clock: Clock;
  readonly maxAttempts?: number;
}

/** The command-specific halves of a provider command: M4 (CMD028, CMD029) and M3 (CMD033) supply them. */
export interface ProviderCommandHooks<Body, View> {
  /** T1 after the reservation and the assurance: locked preconditions and the durable intent (prepareProviderAttempt). */
  intent(uow: CommerceUnitOfWork, body: Body, causationId: CausationId, now: UtcInstant): Promise<IntentOutcome<View>>;
  /** The conclusive answer, built from durable facts in the SERVICE unit of work that settled (or re-read) the operation. */
  conclude(serviceUow: CommerceUnitOfWork, operation: DurableOperation): Promise<Extract<SettleOutcome<View>, { kind: "CONCLUSIVE" }>>;
}

/** The phases of one provider effect (commerce/protocol ProviderCommandPhases). */
export function providerEffectPhases<Body, View>(effect: ProviderEffect, deps: ProviderEffectDependencies, hooks: ProviderCommandHooks<Body, View>): ProviderCommandPhases<Body, View> {
  const maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS_PER_OPERATION;
  const scopeKind = effect === "REFUND" ? "REFUND" : "PAYMENT_ORDER";

  async function adopt(serviceUow: CommerceUnitOfWork, operation: DurableOperation): Promise<void> {
    if (serviceUow.context.kind !== "SERVICE") throw new DomainFailure("INTEGRITY_FAILURE", "T3 settles in a SERVICE unit of work of the payment service (D-PROTO-B5)");
    if (serviceUow.commerceScope !== null) return;
    if ((await serviceUow.adoptScope(scopeKind, operation.resource.id)) === null) throw new NotFoundFailure(operation.resource.kind);
  }

  return {
    intent: (uow, body, causationId, now) => hooks.intent(uow, body, causationId, now),

    async claim(uow, operation, now): Promise<DispatchTicket | null> {
      const c = uow.commerce;
      // the order's row lock first (payment order → attempt → refund, design §6.2), then the attempt
      const subject = await subjectOf(uow, effect, operation.attempt, true);
      const attempt = await c.attempts.lock(operation.attempt.attemptId);
      if (attempt === null || attempt.state !== "PREPARED") return null;
      // the aggregate's own dispatch edge must be open; otherwise the intent is left for the sweep (cancel before dispatch)
      const order = subject.order;
      if (effect === "CREATE_ORDER" && order.state !== "INTENT_CREATED" && order.state !== "CREATING") return null;
      if (effect === "CAPTURE" && order.state !== "CREATED" && order.state !== "APPROVED") return null;
      if (subject.effect === "REFUND" && subject.refund.state !== "APPROVED") return null;
      const request = attemptRequest(deps.adapter, subject, attempt.attemptId);
      if (providerRequestHash(request) !== attempt.requestHash) {
        throw new DomainFailure("INTEGRITY_FAILURE", `attempt ${attempt.attemptId} would send another request than the one it recorded; nothing is sent`);
      }
      // dispatch_intent_committed: the deadline is the database's (now() + DISPATCH_DEADLINE_SECONDS in the claim's statement)
      const w = await c.attempts.transition(attempt.attemptId, attempt.version, { state: "DISPATCHING", lastObservedAt: now }, now);
      if (w.kind === "STALE") return null;
      const claimed = w.record;
      if (claimed.dispatchDeadlineAt === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a claimed attempt carries its dispatch deadline (payment_attempts_dispatch_deadline)");
      const causationId = operation.journalEntryId as string as CausationId;
      await publishVersionEvent(
        uow,
        versionEvent("payment_attempt", claimed.attemptId, claimed.version, order.agencyId, { previousState: "PREPARED", state: "DISPATCHING" }, {
          attemptId: claimed.attemptId,
          agencyId: order.agencyId,
          orderId: order.orderId,
          refundId: claimed.refundId,
          operation: claimed.operation,
          ordinal: claimed.ordinal,
          previousState: "PREPARED",
        }),
        causationId,
      );
      if (subject.effect === "REFUND") {
        const refund = subject.refund;
        const r = await c.refunds.transition(refund.refundId, refund.version, { state: "SUBMITTING" }, now);
        if (r.kind === "STALE") throw new DomainFailure("STALE_VERSION", "the refund changed while its attempt was claimed", { currentVersion: r.currentVersion, currentState: r.currentState }, true);
        await publishVersionEvent(uow, versionEvent("refund", refund.refundId, r.record.version, order.agencyId, { previousState: "APPROVED", state: "SUBMITTING" }, { refundId: refund.refundId, agencyId: order.agencyId, attemptId: claimed.attemptId }), causationId);
      } else if ((effect === "CREATE_ORDER" && order.state === "INTENT_CREATED") || effect === "CAPTURE") {
        const to = effect === "CREATE_ORDER" ? "CREATING" : "CAPTURING";
        const o = await c.orders.transition(order.orderId, order.version, { state: to }, now);
        if (o.kind === "STALE") throw new DomainFailure("STALE_VERSION", "the order changed while its attempt was claimed", { currentVersion: o.currentVersion, currentState: o.currentState }, true);
        await publishVersionEvent(uow, versionEvent("payment_order", order.orderId, o.record.version, order.agencyId, { previousState: order.state, state: to }, { orderId: order.orderId, agencyId: order.agencyId, attemptId: claimed.attemptId, previousState: order.state }), causationId);
      }
      return { attempt: claimed, deadline: claimed.dispatchDeadlineAt, request };
    },

    dispatch: (ticket) => deps.adapter.dispatch(ticket.request, ticket.deadline),

    async observe(operation): Promise<ProviderDispatchResult | ProviderOrderObservation | null> {
      const attempt = operation.attempt;
      switch (effect) {
        case "CREATE_ORDER":
          return deps.adapter.observeOrder({ providerRequestId: attempt.providerRequestId });
        case "CAPTURE":
          if (operation.providerOrderId === undefined) return null;
          return deps.adapter.observeOrder({ providerOrderId: operation.providerOrderId });
        case "REFUND": {
          if (operation.providerCaptureId === undefined) return null;
          const found = await deps.adapter.observeRefund({ providerCaptureId: operation.providerCaptureId, providerRequestId: attempt.providerRequestId });
          if (!("kind" in found)) return { kind: "REFUND_OBSERVED", refund: found };
          // absence proves no effect only after the dispatch deadline: until then the call may still be in flight (D-PROTO-B6)
          const deadline = attempt.dispatchDeadlineAt;
          if (found.absenceIsProof && deadline !== undefined && deps.clock.nowMs() >= Date.parse(deadline)) return { kind: "PROVED_NO_EFFECT", outcomeCode: "REFUND_NOT_FOUND", evidenceHash: found.evidenceHash };
          return null;
        }
      }
    },

    async settle(serviceUow, input): Promise<SettleOutcome<View>> {
      await adopt(serviceUow, input.operation);
      const attempt = input.operation.attempt;
      if (input.result !== null) {
        await deps.reconciler.applyOrderObservation(serviceUow, {
          orderId: attempt.orderId,
          source: "DISPATCH_RESPONSE",
          observation: input.result,
          attemptId: attempt.attemptId,
          causationId: input.causationId,
          now: input.now,
        });
      }
      const { state, attempt: current } = await protocolStateOf(serviceUow, effect, input.operation, maxAttempts);
      const operation = { ...input.operation, attempt: current };
      if (settledOutcome(state) === "CONCLUSIVE") return hooks.conclude(serviceUow, operation);
      return { kind: "PENDING", operation };
    },

    async complete(uow, operation, outcome): Promise<CommandResult<View>> {
      if (outcome.kind === "CONCLUSIVE") {
        const committed = await uow.journal.commit(operation.journalEntryId, { responseStatus: outcome.status, responseBody: outcome.view, resourceKind: outcome.resourceKind, resourceId: outcome.resourceId });
        if (committed.state !== "COMMITTED" || committed.responseStatus !== outcome.status || committed.responseBody === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the journal did not record the response of this command");
        return { kind: "COMPLETED", status: outcome.status, view: committed.responseBody as View, version: outcome.version, replayed: false };
      }
      // the effect is unknown or in flight: the entry says so and the answer is the durable operation (D-PROTO-B2, D-JOURNAL-B1)
      await uow.journal.markUncertain(operation.journalEntryId);
      const { state } = await protocolStateOf(uow, effect, operation, maxAttempts);
      return { kind: "ACCEPTED", status: 202, operationId: operation.resource.id, state: state.aggregateState, statusPath: operation.resource.statusPath, pollAfterSeconds: PENDING_POLL_AFTER_SECONDS };
    },

    async resume(uow, journalEntryId): Promise<DurableOperation | null> {
      const c = uow.commerce;
      if (effect === "CREATE_ORDER") {
        const order = await c.orders.findByIntentEntry(journalEntryId);
        if (order === null) return null;
        // the latest attempt of the logical operation (a later deliberate attempt carries no journal entry of its own)
        const attempts = (await c.attempts.listForOrder(order.orderId)).filter((a) => a.operation === "CREATE_ORDER");
        const latest = attempts.reduce<PaymentAttemptRecord | null>((best, a) => (best === null || a.ordinal > best.ordinal ? a : best), null);
        return latest === null ? null : operationOf(uow, effect, journalEntryId, latest);
      }
      const attempt = await c.attempts.findByIntentEntry(journalEntryId);
      return attempt === null ? null : operationOf(uow, effect, journalEntryId, attempt);
    },
  };
}

// --- the runner ---------------------------------------------------------------------------------------------------------------------

/** Where a crash can be injected (tests): inside T1 before it commits, and after each durable step of the protocol. */
export type ProtocolPoint = "INTENT_BEFORE_COMMIT" | "AFTER_INTENT" | "AFTER_CLAIM" | "AFTER_CALL" | "AFTER_SETTLE";

export interface ProviderCommandRun<Body, View> {
  readonly effect: ProviderEffect;
  readonly phases: ProviderCommandPhases<Body, View>;
  readonly adapter: PaymentProviderAdapter;
  readonly clock: Clock;
  /** The principal's units of work (TENANT for CMD028/CMD029, SERVICE for CMD033) and, for a SERVICE principal, its stored operation. */
  readonly principal: { readonly unitOfWork: CommerceUnitOfWorkFactory; readonly context: ExecutionContext; readonly storedOperation?: { readonly kind: "PAYMENT_ORDER" | "REFUND"; readonly key: string } };
  /** The payment service's units of work (T3). */
  readonly service: { readonly unitOfWork: CommerceUnitOfWorkFactory; readonly context: ServiceContext };
  readonly identity: IdempotencyIdentity;
  readonly digest: Sha256Hex;
  readonly correlationId: CorrelationId;
  readonly body: Body;
  /**
   * The request's credential (a person's command): fenced and judged in T1 as its last lock, before its intent or its answer commits and
   * before a replay is answered (rule 16). Absent for a SERVICE principal, whose identity was verified as it stands.
   */
  readonly authority?: RequestAuthority;
  readonly maxAttempts?: number;
  /** The access decision, before the reservation (B06 D-PIPE-1); throws a DomainFailure to deny. A SERVICE principal adopts its scope here. */
  access(uow: CommerceUnitOfWork): Promise<void>;
  /** The assurance of a new execution, after the reservation; throws a DomainFailure to deny. */
  assure?(uow: CommerceUnitOfWork): Promise<void>;
  /** Records the durable fact of an authorization denial in its own transaction (B06 D-FACT-1; D-FACT-B1). */
  recordDenial?(failure: DomainFailure): Promise<void>;
  /** Crash injection (tests only): a throw here ends the run like a process death at that point. */
  hold?(point: ProtocolPoint, operation: DurableOperation | null): Promise<void>;
}

const CONFLICT_CODES: ReadonlySet<FailureCode> = new Set(["STALE_VERSION", "IDEMPOTENCY_CONFLICT", "PRECONDITION_FAILED", "PAYMENT_PENDING", "PAYMENT_UNCERTAIN", "OPERATION_CANCELLED"]);
/** Handler-level failures that are authorization facts; every failure of the access decision itself is one too (B06 runCommand). */
const DENIAL_CODES: ReadonlySet<FailureCode> = new Set(["AUTHENTICATION_REQUIRED", "ASSURANCE_REQUIRED", "NOT_AUTHORIZED"]);

function resultOf<View>(failure: DomainFailure, correlationId: string): CommandResult<View> {
  const problem = problemOf(failure, correlationId);
  if (CONFLICT_CODES.has(failure.code)) return { kind: "CONFLICT", problem };
  if (failure.code === "CAPACITY_UNAVAILABLE") return { kind: "UNAVAILABLE", problem };
  return { kind: "REJECTED", problem };
}

/** The version a journaled view carries: at its top level or on the aggregate it names (order, refund, quote). */
function versionOf(view: unknown): number {
  if (typeof view === "object" && view !== null) {
    const v = view as Record<string, unknown>;
    if (typeof v["version"] === "number") return v["version"];
    for (const key of ["order", "refund", "quote"]) {
      const inner = v[key];
      if (typeof inner === "object" && inner !== null && typeof (inner as Record<string, unknown>)["version"] === "number") return (inner as Record<string, unknown>)["version"] as number;
    }
  }
  throw new DomainFailure("INTEGRITY_FAILURE", "journaled response carries no aggregate version");
}

type First<View> =
  | { readonly kind: "REPLAY"; readonly status: 200 | 201; readonly view: View }
  | { readonly kind: "FINAL"; readonly result: CommandResult<View> }
  | { readonly kind: "DISPATCH"; readonly operation: DurableOperation }
  | { readonly kind: "RESUME"; readonly operation: DurableOperation };

/**
 * Runs one provider command end to end (T1, T2, call, T3, T4), or resumes it under the same key. A DomainFailure becomes the
 * command's CONFLICT / REJECTED / UNAVAILABLE answer (an authorization denial is recorded through `recordDenial`); any other
 * exception — a crash, a lost connection — propagates, and the same key later converges from whatever became durable.
 */
export async function runProviderCommand<Body, View>(run: ProviderCommandRun<Body, View>): Promise<CommandResult<View>> {
  const maxAttempts = run.maxAttempts ?? MAX_ATTEMPTS_PER_OPERATION;
  const principal = <T>(work: (uow: CommerceUnitOfWork) => Promise<T>): Promise<T> =>
    run.principal.unitOfWork.run(run.principal.context, async (uow) => {
      const stored = run.principal.storedOperation;
      if (stored !== undefined && uow.commerceScope === null && (await uow.adoptScope(stored.kind, stored.key)) === null) throw new NotFoundFailure(stored.kind === "REFUND" ? "refund" : "payment_order");
      return work(uow);
    });
  const service = <T>(work: (uow: CommerceUnitOfWork) => Promise<T>): Promise<T> => run.service.unitOfWork.run(run.service.context, work);

  let first: First<View>;
  let accessDenied = false;
  try {
    first = await run.principal.unitOfWork.run(run.principal.context, async (uow): Promise<First<View>> => {
      try {
        await run.access(uow);
      } catch (e) {
        accessDenied = e instanceof DomainFailure;
        throw e;
      }
      const reservation = await uow.journal.reserve(run.identity, run.digest, run.correlationId);
      switch (reservation.kind) {
        case "REPLAY": {
          const status = reservation.entry.responseStatus;
          if ((status !== 200 && status !== 201) || reservation.entry.responseBody === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "journaled entry is COMMITTED without a complete response");
          await judgedUnderHold(run.authority, uow, run.clock);
          return { kind: "REPLAY", status, view: reservation.entry.responseBody as View };
        }
        case "CONFLICT":
          throw new IdempotencyConflictFailure();
        case "PENDING": {
          const operation = await run.phases.resume(uow, reservation.entry.entryId);
          if (operation === null) throw new DomainFailure("INTEGRITY_FAILURE", "a pending journal entry names no durable operation");
          return { kind: "RESUME", operation };
        }
        case "RESERVED": {
          await run.assure?.(uow);
          const now = run.clock.now();
          const outcome = await run.phases.intent(uow, run.body, reservation.entryId as string as CausationId, now);
          // rule 16 (Order 15 F-04, review R-01): T1 is where the person authorizes the effect; its credential is fenced here as the unit's
          // last lock, so a logout committed while T1 ran leaves no intent (no provider call follows) and one that starts later waits for it
          await judgedUnderHold(run.authority, uow, run.clock);
          if (outcome.kind === "FINAL") {
            const committed = await uow.journal.commit(reservation.entryId, { responseStatus: outcome.status, responseBody: outcome.view, resourceKind: outcome.resourceKind, resourceId: outcome.resourceId });
            return { kind: "FINAL", result: { kind: "COMPLETED", status: outcome.status, view: committed.responseBody as View, version: outcome.version, replayed: false } };
          }
          await run.hold?.("INTENT_BEFORE_COMMIT", outcome.operation);
          return { kind: "DISPATCH", operation: outcome.operation };
        }
      }
    });
  } catch (e) {
    if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
    if (accessDenied || DENIAL_CODES.has(e.code)) await run.recordDenial?.(e);
    return resultOf<View>(e, run.correlationId);
  }
  switch (first.kind) {
    case "REPLAY":
      return { kind: "COMPLETED", status: first.status, view: first.view, version: versionOf(first.view), replayed: true };
    case "FINAL":
      return first.result;
    case "DISPATCH":
      await run.hold?.("AFTER_INTENT", first.operation);
      break;
    case "RESUME":
      break;
  }

  try {
    return await continueOperation(first.operation, first.kind === "DISPATCH");
  } catch (e) {
    if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
    return resultOf<View>(e, run.correlationId);
  }

  async function complete(operation: DurableOperation, outcome: SettleOutcome<View>): Promise<CommandResult<View>> {
    return principal(async (uow) => {
      // T4 is idempotent: an entry another resume already committed is answered from the journal
      const entry = await uow.journal.find(run.identity);
      if (entry !== null && entry.state === "COMMITTED") {
        const status = entry.responseStatus;
        if ((status !== 200 && status !== 201) || entry.responseBody === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "journaled entry is COMMITTED without a complete response");
        return { kind: "COMPLETED", status, view: entry.responseBody as View, version: versionOf(entry.responseBody), replayed: true };
      }
      if (outcome.kind === "PENDING" && entry !== null && entry.state === "UNCERTAIN") {
        const { state } = await protocolStateOf(uow, run.effect, operation, maxAttempts);
        return { kind: "ACCEPTED", status: 202, operationId: operation.resource.id, state: state.aggregateState, statusPath: operation.resource.statusPath, pollAfterSeconds: PENDING_POLL_AFTER_SECONDS };
      }
      return run.phases.complete(uow, operation, outcome);
    });
  }

  async function settle(operation: DurableOperation, result: ProviderDispatchResult | ProviderOrderObservation | null): Promise<SettleOutcome<View>> {
    return service((uow) => run.phases.settle(uow, { operation, result, now: run.clock.now(), causationId: operation.journalEntryId as string as CausationId }));
  }

  async function continueOperation(start: DurableOperation, claimNow: boolean): Promise<CommandResult<View>> {
    let operation = start;
    let claim = claimNow;
    let observed = false;
    // each pass makes durable progress (a claim, a settlement, a new attempt); the bound is the protocol's own
    for (let pass = 0; pass < 4 * maxAttempts + 4; pass++) {
      const { state, attempt } = await principal((uow) => protocolStateOf(uow, run.effect, operation, maxAttempts));
      operation = { ...operation, attempt };
      const step = claim ? ({ kind: "CLAIM" } as const) : nextProtocolStep(state);
      claim = false;
      switch (step.kind) {
        case "CLAIM": {
          const ticket = await principal((uow) => run.phases.claim(uow, operation, run.clock.now()));
          // another claimant of the same operation dispatches it; this request answers with the durable operation
          if (ticket === null) return complete(operation, { kind: "PENDING", operation });
          operation = { ...operation, attempt: ticket.attempt };
          await run.hold?.("AFTER_CLAIM", operation);
          const result = await run.phases.dispatch(ticket);
          await run.hold?.("AFTER_CALL", operation);
          const outcome = await settle(operation, result);
          await run.hold?.("AFTER_SETTLE", operation);
          if (outcome.kind === "CONCLUSIVE") return complete(operation, outcome);
          operation = outcome.operation;
          observed = true;
          break;
        }
        case "OBSERVE": {
          if (observed) return complete(operation, { kind: "PENDING", operation });
          const observation = await run.phases.observe(operation);
          const outcome = await settle(operation, observation);
          await run.hold?.("AFTER_SETTLE", operation);
          if (outcome.kind === "CONCLUSIVE") return complete(operation, outcome);
          operation = outcome.operation;
          observed = true;
          break;
        }
        case "NEW_ATTEMPT": {
          // a creation that proved no effect: a new deliberate attempt under a new request identity (D-PROTO-B3)
          const attempt = await principal(async (uow) => {
            // the order stays CREATING: only the new attempt is written, and the one-live-attempt index and the ordinal sequence decide
            // between two resumes that both saw the proved no-effect (the request handlers may not lock a CREATING order; D-REQ-B8)
            const order = await uow.commerce.orders.get(operation.resource.id as PaymentOrderId);
            if (order === null) throw new NotFoundFailure("payment_order");
            return prepareProviderAttempt(uow, { adapter: run.adapter, subject: { effect: "CREATE_ORDER", order }, ordinal: step.ordinal, causationId: operation.journalEntryId as string as CausationId, now: run.clock.now() });
          });
          operation = { ...operation, attempt };
          claim = true;
          observed = false;
          break;
        }
        case "COMPLETE": {
          const outcome = await settle(operation, null);
          return complete(operation, outcome);
        }
      }
    }
    throw new DomainFailure("INTEGRITY_FAILURE", "the provider-effect protocol made no durable progress within its bound");
  }
}

