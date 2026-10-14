/**
 * The event vocabulary package B12 adds (docs/design/B12-outreach-plan.md rev 4 §1 CMD063 "One COMMIT: intent QUEUED + draft AUTHORIZED + event
 * outreach.send_intended.v1 + outbox"; migration 0088, lane K1b). Appended to the registered vocabulary of model/events.ts (EVENT_TYPES,
 * EVENT_PAYLOAD_ALLOWLIST, EVENT_SUBSCRIPTIONS, CONSUMERS, AGGREGATE_KINDS) and seeded by migration 0088 (kauro.event_types,
 * kauro.aggregate_kinds) in the same commit; the persistence tests prove the database and these lists equal.
 *
 * - outreach_send_intent is an AGENCY-LESS aggregate: its table (outreach_send_intents) carries no agency_id (B12's static gate: the outreach
 *   service holds no grant on a table with agency_id), so the registry row is agency_scoped = false, the event names no agency, and the
 *   database refuses an event of the kind that does.
 * - The event is born with the intent (version 1) in the same commit as the intent; the dispatcher (consumer OUTREACH_SENDER) is what the
 *   outbox record addresses. The intent's later states are rows of the intent, not new aggregate versions.
 * - The payload carries references only (ids, the sealed payload hash and two tokens): never an address, a subject, a body or a message.
 */

export const OUTREACH_AGGREGATE_KINDS = ["outreach_send_intent"] as const;
export const OUTREACH_EVENT_TYPES = ["outreach.send_intended.v1"] as const;
export type OutreachEventType = (typeof OUTREACH_EVENT_TYPES)[number];

/** The destination of B12's events: the outbound dispatcher (units D2..D5, lease OUTBOX_DISPATCH). */
export const OUTREACH_CONSUMERS = ["OUTREACH_SENDER"] as const;

/** Keys each B12 event type may carry: ids, the sealed payload hash and enumerated tokens only. */
export const OUTREACH_EVENT_PAYLOAD_ALLOWLIST: Readonly<Record<OutreachEventType, ReadonlyArray<string>>> = Object.freeze({
  "outreach.send_intended.v1": ["intentId", "draftId", "authorizationId", "senderId", "prospectId", "purpose", "route", "payloadHash"],
});

export const OUTREACH_EVENT_SUBSCRIPTIONS: ReadonlyArray<{ readonly eventType: OutreachEventType; readonly consumer: "OUTREACH_SENDER" }> = Object.freeze([
  Object.freeze({ eventType: "outreach.send_intended.v1" as const, consumer: "OUTREACH_SENDER" as const }),
]);
