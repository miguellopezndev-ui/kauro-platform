/**
 * The event of a commerce aggregate version (design §9; D-EVT-B2, D-EVT-B3; B09-N1): every version a writer of the commerce core
 * produces is published with exactly the event type `commerceVersionEventType` names for what it records, with a payload of
 * COMMERCE_EVENT_PAYLOAD_ALLOWLIST, and its outbox records go to that type's subscribers (B06's EventPublisher fans out by
 * EVENT_SUBSCRIPTIONS). The database refuses anything else (KA003 at COMMIT, 42501 for a foreign outbox consumer).
 *
 * Who publishes (decision D-CORE-B1, design §12): the domain ports say "the caller publishes" (B06's practice) while the
 * persistence mandate M1 asks its adapters to publish each version in the same unit of work. The core is correct under both: it
 * plans every version's event, and after each write `publishVersionEvent` looks for an event of exactly that aggregate version in
 * the unit of work's appended events — an adapter that published it is checked (the type must be the planned one, else
 * INTEGRITY_FAILURE) and nothing is published twice; otherwise the core publishes the planned event itself. Exactly one event per
 * version reaches the outbox whichever side writes it.
 */
import type {
  AggregateKind,
  CausationId,
  CommerceAggregateKind,
  CommerceEventType,
  CommerceUnitOfWork,
  CommerceVersionChange,
  DomainEventRecord,
  EventPayload,
  SafePayloadValue,
  UnitOfWork,
} from "@kauro/domain";
import { COMMERCE_EVENT_PAYLOAD_ALLOWLIST, DomainFailure, actorOf, assertAllowlistedPayload, commerceVersionEventType, moneyCount } from "@kauro/domain";

/** A planned version event: the aggregate version it records, the type D-EVT-B3 names and its allowlisted payload. */
export interface VersionEvent {
  readonly kind: CommerceAggregateKind;
  readonly aggregateId: string;
  readonly version: number;
  readonly agencyId: string;
  readonly type: CommerceEventType;
  readonly payload: EventPayload;
}

/**
 * Builds the payload of an event type from the members a writer knows: only the members the type's allowlist names are kept
 * (07: references and safe counts; D-EVT-2), absent ones are dropped (a payload never carries `undefined`), money becomes a
 * count, and the result is checked against the allowlist's value rules (a label or free text refuses).
 */
export function payloadOf(type: CommerceEventType, members: Readonly<Record<string, SafePayloadValue | bigint | null | undefined>>): EventPayload {
  const allowed = COMMERCE_EVENT_PAYLOAD_ALLOWLIST[type];
  const out: Record<string, SafePayloadValue> = {};
  for (const [key, value] of Object.entries(members)) {
    if (value === undefined || value === null || !allowed.includes(key)) continue;
    out[key] = typeof value === "bigint" ? moneyCount(value) : value;
  }
  assertAllowlistedPayload(type, out);
  return Object.freeze(out);
}

/**
 * The event of one version: the type commerceVersionEventType names for the change (throws for a change the database would
 * refuse, e.g. two provider facts in one capture version) and the payload.
 */
export function versionEvent(
  kind: CommerceAggregateKind,
  aggregateId: string,
  version: number,
  agencyId: string,
  change: CommerceVersionChange,
  members: Readonly<Record<string, SafePayloadValue | bigint | null | undefined>>,
): VersionEvent {
  const type = commerceVersionEventType(kind, change);
  return { kind, aggregateId, version, agencyId, type, payload: payloadOf(type, members) };
}

function appendedFor(uow: UnitOfWork, kind: AggregateKind, aggregateId: string, version: number): DomainEventRecord | undefined {
  return uow.events.appended.find((e) => e.aggregateKind === kind && e.aggregateId === aggregateId && e.aggregateVersion === version);
}

/**
 * Publishes the event of a version the unit of work just wrote, unless its adapter already did (D-CORE-B1): exactly one event per
 * version, and always the planned type. Returns the event as recorded.
 */
export async function publishVersionEvent(uow: CommerceUnitOfWork, event: VersionEvent, causationId: CausationId): Promise<DomainEventRecord> {
  const existing = appendedFor(uow, event.kind, event.aggregateId, event.version);
  if (existing !== undefined) {
    if (existing.eventType !== event.type) {
      throw new DomainFailure("INTEGRITY_FAILURE", `${event.kind} ${event.aggregateId} version ${event.version} was published as ${existing.eventType}, not ${event.type}`, { reason: "EVENT_MISSING" });
    }
    return existing;
  }
  if (uow.context.kind === "ANONYMOUS") throw new DomainFailure("INTEGRITY_FAILURE", "an anonymous unit of work publishes no commerce event");
  const published = await uow.events.publish({
    aggregateKind: event.kind,
    aggregateId: event.aggregateId,
    aggregateVersion: event.version,
    agencyId: event.agencyId as Parameters<UnitOfWork["events"]["publish"]>[0]["agencyId"],
    eventType: event.type,
    actor: actorOf(uow.context),
    causationId,
    correlationId: uow.context.correlationId,
    payload: event.payload,
  });
  return published.event;
}
