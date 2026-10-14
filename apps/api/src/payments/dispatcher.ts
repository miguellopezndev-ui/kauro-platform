/**
 * The payment dispatcher (docs/design/B09-payments-fiscal.md §8.2, D-CONS-B1; B06 D-OUTBOX-1 "held by the dispatcher of the
 * consumer's package"; stage-2 mandate M3): for each of this package's consumers — FINANCE, FISCAL, PAYMENT_SERVICE — one bounded
 * pass claims the consumer's due outbox records through B06's PgOutboxDispatchStore under kauro_control, holding the consumer's
 * lease (B06 PgLeaseStore, resource kind OUTBOX_DISPATCH, one resource per consumer, fenced): a second dispatcher of the same
 * consumer finds the lease HELD and does nothing, and one whose lease was taken over stops before its next settlement. Each
 * delivery's effect runs in its own SERVICE unit(s) of work under kauro_payment — delivery and effect are separate transactions,
 * so the consumers are idempotent (D-CONS-B1) — and its outbox record is then settled under the attempt it claimed: DELIVERED, or
 * RETRYABLE at the instant the effect named (a watchdog not yet due, a credit note awaiting its invoice) or after a bounded
 * backoff, or DEAD_LETTER once the failure is not retryable or the attempts are spent. A settlement another claim fenced settles
 * nothing (B06: the attempt count is the fence).
 */
import { createHash } from "node:crypto";
import type { CommerceEventDelivery } from "@kauro/application";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { AgencyId, CorrelationId, LeaseOwnerId, OutboxDelivery, ResourceId, SystemContext } from "@kauro/domain";
import { DomainFailure, isUuidV7, toUtcInstant } from "@kauro/domain";
import type { ConsumerOutcome, DeliveryEffect, PaymentConsumerName } from "./consumers.js";
import type { PaymentRuntime } from "./runtime.js";
import { NotDueYet } from "./service-commands.js";

/** The absolute deadline of a dispatcher lease (a lease of OUTBOX_DISPATCH spends nothing and serves until it is taken over). */
export const DISPATCH_LEASE_DEADLINE: UtcInstant = "2100-01-01T00:00:00.000Z" as UtcInstant;
/** How long a claimed outbox record stays the dispatcher's before another claim may take it (seconds). */
export const OUTBOX_CLAIM_SECONDS = 120;
/** How long a dispatcher's lease of a consumer lasts between heartbeats (seconds). */
export const DISPATCH_LEASE_SECONDS = 120;
/** Attempts after which a delivery that keeps failing is dead-lettered for the owner's review. */
export const MAX_DELIVERY_ATTEMPTS = 10;

const LEASE_NAMESPACE = "b09-payment-dispatcher";

/** The lease resource of a consumer: a stable UUID of its name (name-based, SHA-1 as RFC 9562 version 5 over a fixed namespace). */
export function leaseResourceOf(consumer: PaymentConsumerName): ResourceId {
  const hash = createHash("sha1").update(`${LEASE_NAMESPACE}:${consumer}`, "utf8").digest();
  const b = Uint8Array.prototype.slice.call(hash, 0, 16);
  b[6] = 0x50 | ((b[6] as number) & 0x0f);
  b[8] = 0x80 | ((b[8] as number) & 0x3f);
  const hex = Buffer.from(b).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}` as ResourceId;
}

function subjectHashOf(consumer: PaymentConsumerName): Sha256Hex {
  return createHash("sha256").update(`B09 payment dispatcher|${consumer}`, "utf8").digest("hex");
}

/** What one pass of the dispatcher did for one consumer. */
export interface DispatchPass {
  readonly consumer: PaymentConsumerName;
  /** Another dispatcher holds the consumer's lease: nothing was claimed. */
  readonly held: boolean;
  readonly deliveries: ReadonlyArray<{ readonly eventId: string; readonly eventType: string; readonly outcome: ConsumerOutcome | "RESCHEDULED" | "FAILED" | "DEAD_LETTER" | "FENCED"; readonly errorCode?: string }>;
}

/**
 * The closed set of agency-less events the payment dispatcher delivers, to PAYMENT_SERVICE only (docs/design/PV1-SETTLE-two-step.md
 * §3.0, F1): the owner's bank decisions the service consumes (D-ACH-16). Any other event without an agency is an INTEGRITY_FAILURE
 * dead letter, as before (never a blanket null agency).
 */
export const AGENCY_LESS_PAYMENT_EVENT_TYPES: ReadonlySet<string> = new Set(["bank_credit.received.v1", "bank_credit.matched.v1", "settlement_request.recorded.v1"]);

function deliveryOf(consumer: PaymentConsumerName, d: OutboxDelivery): CommerceEventDelivery {
  if (d.event.agencyId === null) {
    if (consumer !== "PAYMENT_SERVICE" || !AGENCY_LESS_PAYMENT_EVENT_TYPES.has(d.event.eventType)) throw new DomainFailure("INTEGRITY_FAILURE", `${d.event.eventType} ${d.event.eventId} is not an agency's commerce event`);
    return { eventId: d.event.eventId, eventType: d.event.eventType, agencyId: null, aggregateId: d.event.aggregateId, aggregateVersion: d.event.aggregateVersion, payload: d.event.payload };
  }
  return { eventId: d.event.eventId, eventType: d.event.eventType, agencyId: d.event.agencyId as AgencyId, aggregateId: d.event.aggregateId, aggregateVersion: d.event.aggregateVersion, payload: d.event.payload };
}

function errorCodeOf(e: unknown): string {
  return e instanceof DomainFailure ? e.code : "UNEXPECTED_ERROR";
}

export interface PaymentDispatcher {
  /** The instance's lease owner id (a UUIDv7). */
  readonly ownerId: LeaseOwnerId;
  /** One bounded pass for one consumer. */
  runOnce(consumer: PaymentConsumerName, options?: { readonly limit?: number }): Promise<DispatchPass>;
}

export function createPaymentDispatcher(rt: PaymentRuntime, effects: ReadonlyArray<DeliveryEffect>, options: { readonly ownerId?: LeaseOwnerId } = {}): PaymentDispatcher {
  const ownerId = options.ownerId ?? (rt.ids.next() as LeaseOwnerId);
  if (!isUuidV7(ownerId)) throw new DomainFailure("INTEGRITY_FAILURE", "a dispatcher's lease owner is a UUIDv7");
  const byConsumer = new Map<PaymentConsumerName, DeliveryEffect>(effects.map((e) => [e.consumer, e]));
  const control = (): SystemContext => ({ kind: "SYSTEM", serviceId: "payment-dispatcher", correlationId: rt.ids.next() as CorrelationId });

  return {
    ownerId,
    async runOnce(consumer, runOptions = {}) {
      const effect = byConsumer.get(consumer);
      if (effect === undefined) throw new DomainFailure("INTEGRITY_FAILURE", `no effect is bound to the consumer ${consumer}`);
      const resourceId = leaseResourceOf(consumer);
      // the consumer's lease: one dispatcher at a time, fenced
      const claim = await rt.assembly.commerce.run(control(), (uow) =>
        uow.leases.claim({ resourceKind: "OUTBOX_DISPATCH", resourceId, ownerId, ttlSeconds: DISPATCH_LEASE_SECONDS, deadlineAt: DISPATCH_LEASE_DEADLINE, subjectHash: subjectHashOf(consumer), costAuthorityId: null, checkpointHash: null }, rt.clock.now()),
      );
      if (claim.kind === "HELD") return { consumer, held: true, deliveries: [] };
      if (claim.kind === "REFUSED") throw new DomainFailure("INTEGRITY_FAILURE", `the lease of ${consumer} was refused: ${claim.reason}`);
      let fence = claim.lease.fence;
      const claimed = await rt.assembly.commerce.run(control(), (uow) => uow.outboxDispatch.claim(consumer, runOptions.limit ?? 25, rt.clock.now(), OUTBOX_CLAIM_SECONDS));
      const out: Array<DispatchPass["deliveries"][number]> = [];
      for (const d of claimed) {
        let outcome: DispatchPass["deliveries"][number]["outcome"];
        let errorCode: string | undefined;
        let settle: { readonly kind: "DELIVERED" } | { readonly kind: "FAILED"; readonly code: string; readonly retryAt: UtcInstant | null };
        try {
          outcome = await effect.handle(deliveryOf(consumer, d));
          settle = { kind: "DELIVERED" };
        } catch (e) {
          if (e instanceof NotDueYet) {
            outcome = "RESCHEDULED";
            settle = { kind: "FAILED", code: "NOT_DUE", retryAt: e.retryAt };
          } else {
            errorCode = errorCodeOf(e);
            const retryable = !(e instanceof DomainFailure) || e.retryable || e.code === "STALE_VERSION";
            const spent = d.attempt >= MAX_DELIVERY_ATTEMPTS;
            outcome = retryable && !spent ? "FAILED" : "DEAD_LETTER";
            settle = { kind: "FAILED", code: errorCode, retryAt: retryable && !spent ? toUtcInstant(rt.clock.nowMs() + Math.min(300, 2 ** d.attempt) * 1000) : null };
            rt.onBackgroundFailure(d.event.correlationId, e);
          }
        }
        // still the lease's holder? a dispatcher that was taken over settles nothing more
        const renewed = await rt.assembly.commerce.run(control(), async (uow) => {
          const lease = await uow.leases.heartbeat("OUTBOX_DISPATCH", resourceId, ownerId, fence, DISPATCH_LEASE_SECONDS, rt.clock.now());
          if (lease === null) return null;
          const now = rt.clock.now();
          const result = settle.kind === "DELIVERED" ? await uow.outboxDispatch.delivered(d.outboxId, d.attempt, now) : await uow.outboxDispatch.failed(d.outboxId, d.attempt, settle.code, settle.retryAt, now);
          return { lease, result };
        });
        if (renewed === null) {
          out.push({ eventId: d.event.eventId, eventType: d.event.eventType, outcome: "FENCED" });
          break;
        }
        fence = renewed.lease.fence;
        out.push({ eventId: d.event.eventId, eventType: d.event.eventType, outcome: renewed.result === "FENCED" ? "FENCED" : outcome, ...(errorCode !== undefined ? { errorCode } : {}) });
      }
      return { consumer, held: false, deliveries: out };
    },
  };
}
