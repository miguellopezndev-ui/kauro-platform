/**
 * The work item of one control-plane effect and the unit-of-work discipline every consumer and sweeper of this package follows
 * (docs/design/B07-upload-source-lifecycle.md §12; decisions D-CTRL-1, D-CTRL-2, D-LOCK-2, D-CLOCK-1).
 *
 * - A unit of work that changes a tenant's rows runs in a SYSTEM context bound to the agency of its work item (D-CTRL-1): the
 *   agency comes from the durable work item — the outbox event's agency, or the row a sweep discovered — never from a request.
 *   Discovery across tenants runs unbound and reads only the columns granted to the control plane.
 * - Every event the control plane appends is its own edge's, as a SERVICE actor of the work item's agency (D-CTRL-2), caused by
 *   the event or sweep that produced the work and correlated with it.
 * - A compare-and-swap the control plane loses (the aggregate moved since it was read) or a fence it no longer holds (KA071) means
 *   another writer settled the subject first: the work is DONE, never retried against the new state (07 "consumers deduplicate
 *   by their own durable identity and verify state before an effect").
 */
import type { UtcInstant } from "@kauro/contracts";
import {
  isDomainFailure,
  type AgencyId,
  type AggregateKind,
  type CausationId,
  type CorrelationId,
  type EventPayload,
  type EventType,
  type SourceUnitOfWork,
  type SystemContext,
  type VersionedWrite,
} from "@kauro/domain";

/** Who acts, for which agency, caused by what (the provenance of every write and event of one piece of control-plane work). */
export interface WorkItem {
  /** The control-plane service token (a SERVICE actor; `^[a-z][a-z0-9_-]{1,63}$`, the registry's creator shape). */
  readonly serviceId: string;
  readonly agencyId: AgencyId;
  readonly correlationId: CorrelationId;
  /** The event (or sweep run) whose work this is. */
  readonly causationId: CausationId;
}

/** The SYSTEM context bound to the work item's agency (D-CTRL-1). */
export function boundTo(item: WorkItem): SystemContext {
  return { kind: "SYSTEM", serviceId: item.serviceId, correlationId: item.correlationId, agencyId: item.agencyId };
}

/** The unbound SYSTEM context of cross-tenant discovery (no agency: only the columns granted to the control plane are readable). */
export function discovery(serviceId: string, correlationId: CorrelationId): SystemContext {
  return { kind: "SYSTEM", serviceId, correlationId };
}

/** Appends the event of a control-plane edge (D-CTRL-2): the work item's agency, a SERVICE actor, its causation and correlation. */
export async function publish(uow: SourceUnitOfWork, item: WorkItem, kind: AggregateKind, aggregateId: string, version: number, eventType: EventType, payload: EventPayload): Promise<void> {
  await uow.events.publish({
    aggregateKind: kind,
    aggregateId,
    aggregateVersion: version,
    agencyId: item.agencyId,
    eventType,
    actor: { kind: "SERVICE", serviceId: item.serviceId },
    causationId: item.causationId,
    correlationId: item.correlationId,
    payload,
  });
}

/**
 * The control plane lost the subject to another writer: a compare-and-swap found another version, or the attempt no longer holds
 * its fence. Thrown inside a unit of work (which then rolls back) and answered DONE by the pipeline.
 */
export class SettledElsewhere extends Error {
  constructor(readonly what: string) {
    super(`${what}: the subject was settled by another writer`);
    this.name = "SettledElsewhere";
  }
}

/** The record of an APPLIED write; a STALE one means another writer moved the aggregate first (SettledElsewhere). */
export function applied<T>(write: VersionedWrite<T>, what: string): T {
  if (write.kind !== "APPLIED") throw new SettledElsewhere(what);
  return write.record;
}

/**
 * Whether an error means the control plane's attempt lost (a stale fence, KA071; or SettledElsewhere, which the unit of work hands
 * back as the cause of its INTERNAL_ERROR): DONE, not a failure.
 */
export function lostTheSubject(e: unknown): boolean {
  if (e instanceof SettledElsewhere) return true;
  if (!isDomainFailure(e)) return false;
  return e.reason === "FENCE_DISCIPLINE" || e.cause instanceof SettledElsewhere;
}

const INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/;

/** Microseconds since the epoch of an ISO-8601 UTC instant with up to six fractional digits (the database's exact instants). */
export function microsOf(instant: UtcInstant): bigint {
  const m = INSTANT.exec(instant);
  if (m === null || m[1] === undefined) throw new RangeError(`not an ISO-8601 UTC instant: ${instant}`);
  const seconds = Date.parse(`${m[1]}Z`);
  if (!Number.isFinite(seconds)) throw new RangeError(`not an ISO-8601 UTC instant: ${instant}`);
  return BigInt(seconds) * 1000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/** `a` strictly after `b`, exact to the microsecond (a deadline "ahead of the server clock" is `isAfter(deadline, now)`). */
export function isAfter(a: UtcInstant, b: UtcInstant): boolean {
  return microsOf(a) > microsOf(b);
}

/** A safe token for an outbox error code (kauro.is_token: `^[A-Z][A-Z0-9_]{2,63}$`). */
export function tokenOf(value: string): string {
  const token = value.toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^[^A-Z]+/, "");
  return token.length >= 3 ? token.slice(0, 64) : "CONTROL_PLANE_FAILURE";
}
