/**
 * The COMMISSIONS dispatcher (docs/design/B10-commercial-domain.md §14; decision D10-CONS-2; B06 D-LEASE-3, D-OUTBOX-1; B09 D-M3-B8,
 * D-CONS-B1): one bounded pass claims the consumer's due outbox records through B06's PgOutboxDispatchStore under kauro_control,
 * holding the consumer's lease (B06 PgLeaseStore, resource kind OUTBOX_DISPATCH, one resource for the consumer: a name-based UUID of
 * B10's own namespace, never B09's). The lease spends nothing — `costAuthorityId` and `checkpointHash` are null — so an expired lease is
 * resumed by whoever claims it next under the next fence, its former owner included, and needs no checkpoint (D-LEASE-3).
 *
 * The dispatcher never caches a fence: it takes it from each claim and each heartbeat. Each delivery's effect runs in its own SERVICE
 * unit of work of the commission service (the COMMISSIONS consumer, idempotent by durable identity), then — still the lease's holder,
 * proved by a heartbeat under the fence it holds — its outbox record is settled under the attempt it claimed, by B09's settlement rules:
 * DELIVERED; RETRYABLE at the instant a not-yet-due effect names or after a bounded backoff; DEAD_LETTER once the failure is not
 * retryable or the attempts are spent. A dispatcher whose heartbeat is refused (another owner took the lease over) settles nothing
 * more; a settlement another claim fenced settles nothing (B06: the attempt count is the fence). No file of apps/api/src/payments/ is
 * edited: its constants and NotDueYet are reused.
 */
import { createHash } from "node:crypto";
import type { CommerceEventDelivery } from "@kauro/application";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { AgencyId, CorrelationId, LeaseOwnerId, OutboxDelivery, ResourceId, SystemContext } from "@kauro/domain";
import { DomainFailure, isUuidV7, toUtcInstant } from "@kauro/domain";
import { DISPATCH_LEASE_DEADLINE, DISPATCH_LEASE_SECONDS, MAX_DELIVERY_ATTEMPTS, NotDueYet, OUTBOX_CLAIM_SECONDS, type ConsumerOutcome } from "../payments/index.js";
import type { CommissionsConsumer } from "./consumer.js";
import { COMMISSIONS_CONSUMER, type CommissionRuntime } from "./runtime.js";

const LEASE_NAMESPACE = "b10-commission-dispatcher";

/** The lease resource of the COMMISSIONS consumer: a stable UUID of its name (name-based, SHA-1 as RFC 9562 version 5, B10's namespace). */
export function commissionLeaseResource(): ResourceId {
  const hash = createHash("sha1").update(`${LEASE_NAMESPACE}:${COMMISSIONS_CONSUMER}`, "utf8").digest();
  const b = Uint8Array.prototype.slice.call(hash, 0, 16);
  b[6] = 0x50 | ((b[6] as number) & 0x0f);
  b[8] = 0x80 | ((b[8] as number) & 0x3f);
  const hex = Buffer.from(b).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}` as ResourceId;
}

function subjectHash(): Sha256Hex {
  return createHash("sha256").update(`B10 commission dispatcher|${COMMISSIONS_CONSUMER}`, "utf8").digest("hex");
}

export type CommissionDeliveryOutcome = ConsumerOutcome | "RESCHEDULED" | "FAILED" | "DEAD_LETTER" | "FENCED";

/** What one pass of the dispatcher did. */
export interface CommissionDispatchPass {
  readonly consumer: typeof COMMISSIONS_CONSUMER;
  /** Another dispatcher holds the lease: nothing was claimed. */
  readonly held: boolean;
  /** The fence the pass claimed the lease under (null when held). */
  readonly fence: number | null;
  readonly deliveries: ReadonlyArray<{ readonly eventId: string; readonly eventType: string; readonly outcome: CommissionDeliveryOutcome; readonly errorCode?: string }>;
}

export interface CommissionDispatcher {
  /** The instance's lease owner id (a UUIDv7). */
  readonly ownerId: LeaseOwnerId;
  runOnce(options?: { readonly limit?: number }): Promise<CommissionDispatchPass>;
}

function deliveryOf(d: OutboxDelivery): CommerceEventDelivery {
  if (d.event.agencyId === null) throw new DomainFailure("INTEGRITY_FAILURE", `${d.event.eventType} ${d.event.eventId} is not an agency's commerce event`);
  return { eventId: d.event.eventId, eventType: d.event.eventType, agencyId: d.event.agencyId as AgencyId, aggregateId: d.event.aggregateId, aggregateVersion: d.event.aggregateVersion, payload: d.event.payload };
}

function errorCodeOf(e: unknown): string {
  return e instanceof DomainFailure ? e.code : "UNEXPECTED_ERROR";
}

export function createCommissionDispatcher(rt: CommissionRuntime, consumer: CommissionsConsumer, options: { readonly ownerId?: LeaseOwnerId } = {}): CommissionDispatcher {
  const ownerId = options.ownerId ?? (rt.ids.next() as LeaseOwnerId);
  if (!isUuidV7(ownerId)) throw new DomainFailure("INTEGRITY_FAILURE", "a dispatcher's lease owner is a UUIDv7");
  const control = (): SystemContext => ({ kind: "SYSTEM", serviceId: "commission-dispatcher", correlationId: rt.ids.next() as CorrelationId });
  const resourceId = commissionLeaseResource();
  const units = rt.assembly.units;

  return {
    ownerId,
    async runOnce(runOptions = {}) {
      // the consumer's lease: one dispatcher at a time, its fence read from this claim (an expired lease is resumed under the next)
      const claim = await units.run(control(), (uow) =>
        uow.leases.claim({ resourceKind: "OUTBOX_DISPATCH", resourceId, ownerId, ttlSeconds: DISPATCH_LEASE_SECONDS, deadlineAt: DISPATCH_LEASE_DEADLINE, subjectHash: subjectHash(), costAuthorityId: null, checkpointHash: null }, rt.clock.now()),
      );
      if (claim.kind === "HELD") return { consumer: COMMISSIONS_CONSUMER, held: true, fence: null, deliveries: [] };
      if (claim.kind === "REFUSED") throw new DomainFailure("INTEGRITY_FAILURE", `the lease of ${COMMISSIONS_CONSUMER} was refused: ${claim.reason}`);
      const claimedFence = claim.lease.fence;
      let fence = claimedFence;
      if (rt.hold !== null) await rt.hold("BATCH_BEFORE_CLAIM", { eventId: null, ownerId });
      // the batch claim is fenced by the lease in its own unit of work (matrix row D): the heartbeat under (owner, fence, not expired) and the
      // claim commit together, and the heartbeat's row lock makes a takeover wait for this COMMIT. A dispatcher that lost the lease between
      // its lease claim and here claims nothing and the pass raises PRECONDITION_FAILED (reason LEASE_FENCED).
      const claimed = await units.run(control(), async (uow) => {
        const now = rt.clock.now();
        const lease = await uow.leases.heartbeat("OUTBOX_DISPATCH", resourceId, ownerId, claimedFence, DISPATCH_LEASE_SECONDS, now);
        if (lease === null) throw new DomainFailure("PRECONDITION_FAILED", `the dispatcher ${ownerId} no longer holds the lease of ${COMMISSIONS_CONSUMER} under fence ${claimedFence}: nothing was claimed`, { reason: "LEASE_FENCED" });
        return uow.outboxDispatch.claim(COMMISSIONS_CONSUMER, runOptions.limit ?? 25, now, OUTBOX_CLAIM_SECONDS);
      });
      const out: Array<CommissionDispatchPass["deliveries"][number]> = [];
      for (const d of claimed) {
        let outcome: CommissionDeliveryOutcome;
        let errorCode: string | undefined;
        let settle: { readonly kind: "DELIVERED" } | { readonly kind: "FAILED"; readonly code: string; readonly retryAt: UtcInstant | null };
        try {
          outcome = await consumer.handle(deliveryOf(d), { resourceId, ownerId, fence, now: () => rt.clock.now() });
          settle = { kind: "DELIVERED" };
        } catch (e) {
          if (e instanceof DomainFailure && e.details.reason === "LEASE_FENCED") {
            // the effect's COMMIT was fenced (matrix row L2): nothing was written, and a dispatcher that lost the lease settles nothing more
            out.push({ eventId: d.event.eventId, eventType: d.event.eventType, outcome: "FENCED", errorCode: "LEASE_FENCED" });
            break;
          }
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
        if (rt.hold !== null) await rt.hold("DELIVERY_BEFORE_SETTLE", { eventId: d.event.eventId, ownerId });
        // still the lease's holder under the fence it holds? one whose heartbeat is refused settles nothing more
        const renewed = await units.run(control(), async (uow) => {
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
      return { consumer: COMMISSIONS_CONSUMER, held: false, fence: claimedFence, deliveries: out };
    },
  };
}
