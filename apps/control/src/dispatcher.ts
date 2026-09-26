/**
 * The control-plane outbox dispatcher (07 "Outbox, inbox and event ordering": dispatch is at least once, consumers deduplicate and
 * verify state before an effect; 07 "Job and attempt states": a claim creates a monotonically increasing fence and a lease). It is
 * B06's primitives composed, nothing forked (docs/design/B07-upload-source-lifecycle.md §6, §12):
 *
 *   1. an unbound SYSTEM unit of work claims up to `limit` due records of one consumer (`OutboxDispatchStore.claim`: PENDING or
 *      RETRYABLE whose next attempt is due, or CLAIMED whose claim expired; attempts + 1 is the settlement fence);
 *   2. per record, the OUTBOX_DISPATCH lease of the record is claimed (`LeaseStore.claim`, fence + 1 on every owner change, an
 *      absolute deadline fixed by the first claim) and the full event is read; a record whose lease a live owner holds is left to
 *      it (its claim expires and the record is claimed again: at least once);
 *   3. the consumer handles the event in SYSTEM units of work bound to the event's agency (D-CTRL-1); it is idempotent by its own
 *      fences and the listed transitions;
 *   4. the outcome is settled under the attempt the claim holds: DONE → DELIVERED; RETRY → RETRYABLE at the consumer's instant, or
 *      DEAD_LETTER once the attempts are spent; DEAD_LETTER → DEAD_LETTER with the consumer's reason token. A settlement of a record
 *      claimed again since is FENCED and changes nothing.
 *
 * An exception a consumer did not answer is a failure of the attempt (retried, then dead-lettered), recorded by a safe token only
 * (10 "Responses and safe errors": never the SQL, a stack or customer text).
 */
import type { UtcInstant } from "@kauro/contracts";
import type { ConsumerOutcome, OutboxConsumer, OutboxDispatcher } from "@kauro/application";
import {
  isDomainFailure,
  textDigest,
  toUtcInstant,
  type AgencyId,
  type CorrelationId,
  type DomainEventRecord,
  type IdGenerator,
  type LeaseOwnerId,
  type OutboxDelivery,
  type ResourceId,
  type SourceUnitOfWorkFactory,
  type SystemContext,
} from "@kauro/domain";
import { discovery, tokenOf } from "./work.js";

/** The service token of a consumer's work (a SERVICE actor): UPLOAD_INSPECTION → upload-inspection. */
export function serviceOf(consumer: string): string {
  return consumer.toLowerCase().replace(/_/g, "-");
}

export interface DispatcherOptions {
  readonly units: SourceUnitOfWorkFactory;
  /** Mints this dispatcher's correlation ids (UUIDv7). */
  readonly ids: IdGenerator;
  /** This dispatcher instance's lease owner identity (UUIDv7): two dispatchers never share one. */
  readonly ownerId: LeaseOwnerId;
  /** How long a claim (and its lease) lasts before another dispatcher may take the record (default 300 s). */
  readonly claimSeconds?: number;
  /** Attempts after which a RETRY answer becomes DEAD_LETTER (default 8). */
  readonly maxAttempts?: number;
  /** The absolute deadline of a record's dispatch lease, counted from its event (default thirty days). */
  readonly leaseWindowSeconds?: number;
  /** Receives every settled failure (safe tokens only; default: none). */
  readonly onFailure?: (note: { readonly consumer: string; readonly outboxId: string; readonly attempt: number; readonly errorCode: string; readonly deadLettered: boolean }) => void;
}

export interface DispatchCounts {
  readonly delivered: number;
  readonly retried: number;
  readonly deadLettered: number;
}

const SERVICE = "outbox-dispatcher";

/** The answer of an attempt that threw: a retryable failure is retried after its hint, anything else after the backoff. */
function outcomeOfError(e: unknown): ConsumerOutcome {
  if (isDomainFailure(e)) {
    const afterSeconds = typeof e.details?.retryAfterSeconds === "number" ? e.details.retryAfterSeconds : 30;
    return { kind: "RETRY", afterSeconds, reason: tokenOf(e.reason === undefined ? e.code : `${e.code}_${e.reason}`) };
  }
  return { kind: "RETRY", afterSeconds: 30, reason: e instanceof Error ? tokenOf(`CONSUMER_${e.name}`) : "CONSUMER_FAILURE" };
}

export class PgOutboxDispatcher implements OutboxDispatcher {
  readonly #units: SourceUnitOfWorkFactory;
  readonly #ids: IdGenerator;
  readonly #ownerId: LeaseOwnerId;
  readonly #claimSeconds: number;
  readonly #maxAttempts: number;
  readonly #leaseWindowSeconds: number;
  readonly #onFailure: DispatcherOptions["onFailure"];

  constructor(options: DispatcherOptions) {
    this.#units = options.units;
    this.#ids = options.ids;
    this.#ownerId = options.ownerId;
    this.#claimSeconds = options.claimSeconds ?? 300;
    this.#maxAttempts = options.maxAttempts ?? 8;
    this.#leaseWindowSeconds = options.leaseWindowSeconds ?? 30 * 86_400;
    this.#onFailure = options.onFailure;
    if (!Number.isInteger(this.#claimSeconds) || this.#claimSeconds < 1 || this.#claimSeconds > 3600) throw new RangeError("claimSeconds is 1..3600");
    if (!Number.isInteger(this.#maxAttempts) || this.#maxAttempts < 1) throw new RangeError("maxAttempts is a positive integer");
  }

  async dispatchBatch(consumer: OutboxConsumer, limit: number, now: UtcInstant): Promise<DispatchCounts> {
    const unbound = (): SystemContext => discovery(SERVICE, this.#ids.next() as CorrelationId);
    const claimed = await this.#units.runSource(unbound(), (uow) => uow.outboxDispatch.claim(consumer.consumer, limit, now, this.#claimSeconds));
    let delivered = 0;
    let retried = 0;
    let deadLettered = 0;
    for (const delivery of claimed) {
      const settled = await this.#dispatchOne(consumer, delivery, now, unbound);
      if (settled === "DELIVERED") delivered += 1;
      else if (settled === "RETRYABLE") retried += 1;
      else if (settled === "DEAD_LETTER") deadLettered += 1;
    }
    return { delivered, retried, deadLettered };
  }

  async #dispatchOne(consumer: OutboxConsumer, delivery: OutboxDelivery, now: UtcInstant, unbound: () => SystemContext): Promise<"DELIVERED" | "RETRYABLE" | "DEAD_LETTER" | "LEFT"> {
    const leased = await this.#units.runSource(unbound(), async (uow) => {
      const event = await uow.events.get(delivery.event.eventId);
      if (event === null) return { kind: "MISSING" as const };
      const deadlineAt = toUtcInstant(Date.parse(event.createdAt) + this.#leaseWindowSeconds * 1000);
      const lease = await uow.leases.claim(
        {
          resourceKind: "OUTBOX_DISPATCH",
          resourceId: delivery.outboxId as unknown as ResourceId,
          ownerId: this.#ownerId,
          ttlSeconds: this.#claimSeconds,
          deadlineAt,
          subjectHash: textDigest(`${delivery.outboxId}|${event.eventId}|${consumer.consumer}`),
          costAuthorityId: null,
          checkpointHash: null,
        },
        now,
      );
      return { kind: lease.kind, event, reason: lease.kind === "REFUSED" ? lease.reason : undefined };
    });
    if (leased.kind === "HELD") return "LEFT";
    let outcome: ConsumerOutcome;
    if (leased.kind === "MISSING") outcome = { kind: "DEAD_LETTER", reason: "EVENT_NOT_FOUND" };
    else if (leased.kind === "REFUSED") outcome = { kind: "DEAD_LETTER", reason: tokenOf(`DISPATCH_${leased.reason ?? "REFUSED"}`) };
    else outcome = await this.#handle(consumer, leased.event);
    return this.#settle(consumer, delivery, outcome, now, unbound);
  }

  async #handle(consumer: OutboxConsumer, event: DomainEventRecord): Promise<ConsumerOutcome> {
    if (event.agencyId === undefined || event.agencyId === null) return { kind: "DEAD_LETTER", reason: "EVENT_WITHOUT_AGENCY" };
    const context: SystemContext = { kind: "SYSTEM", serviceId: serviceOf(consumer.consumer), correlationId: event.correlationId as CorrelationId, agencyId: event.agencyId as AgencyId };
    try {
      return await consumer.handle(event, context, this.#units);
    } catch (e) {
      return outcomeOfError(e);
    }
  }

  async #settle(consumer: OutboxConsumer, delivery: OutboxDelivery, outcome: ConsumerOutcome, now: UtcInstant, unbound: () => SystemContext): Promise<"DELIVERED" | "RETRYABLE" | "DEAD_LETTER" | "LEFT"> {
    const spent = delivery.attempt >= this.#maxAttempts;
    const plan =
      outcome.kind === "DONE"
        ? ({ state: "DELIVERED" } as const)
        : outcome.kind === "RETRY" && !spent
          ? ({ state: "RETRYABLE", errorCode: tokenOf(outcome.reason), retryAt: toUtcInstant(Date.parse(now) + Math.max(1, Math.round(outcome.afterSeconds)) * 1000) } as const)
          : ({ state: "DEAD_LETTER", errorCode: tokenOf(outcome.reason) } as const);
    const settled = await this.#units.runSource(unbound(), (uow) =>
      plan.state === "DELIVERED"
        ? uow.outboxDispatch.delivered(delivery.outboxId, delivery.attempt, now)
        : uow.outboxDispatch.failed(delivery.outboxId, delivery.attempt, plan.errorCode, plan.state === "RETRYABLE" ? plan.retryAt : null, now),
    );
    if (settled === "FENCED") return "LEFT";
    if (plan.state !== "DELIVERED") this.#onFailure?.({ consumer: consumer.consumer, outboxId: delivery.outboxId, attempt: delivery.attempt, errorCode: plan.errorCode, deadLettered: plan.state === "DEAD_LETTER" });
    return plan.state;
  }
}
