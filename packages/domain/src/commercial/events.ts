/**
 * The event vocabulary package B10 adds (docs/design/B10-commercial-domain.md §9, §14; D10-FIRST-2, D10-EVT-1). Appended to the
 * registered vocabulary of model/events.ts (EVENT_TYPES, EVENT_PAYLOAD_ALLOWLIST, EVENT_SUBSCRIPTIONS) and seeded by migration 0028
 * (kauro.event_types, kauro.commerce_event_subscriptions) in the same commit; the persistence tests prove the database and these
 * lists equal.
 *
 * - agency.first_purchase_designated.v1 records the Agency version that mirrors the agency's first qualifying purchase into
 *   agencies.first_qualifying_capture_id (registry Agency.firstQualifyingCaptureId), written once by the commission service's
 *   COMMISSIONS consumer. Its payload names ids only; no consumer is registered for it.
 * - COMMISSIONS subscribes to the capture's funds availability (a line due for eligibility waits for AVAILABLE funds; D10-ELIG-1) and
 *   to the authorization's delivery (the FINAL completion of a single-stage purchase; D10-BIND-1), beside their B09 destinations.
 *
 * The corporate aggregates of B10 (sellers, prospects, claims, entitlements, statements, payout intents) publish no domain event: their
 * history is kauro.commercial_transitions plus security facts (D10-EVT-1).
 */

export const COMMERCIAL_EVENT_TYPES = ["agency.first_purchase_designated.v1"] as const;
export type CommercialEventType = (typeof COMMERCIAL_EVENT_TYPES)[number];

/** Keys each B10 event type may carry: ids only. */
export const COMMERCIAL_EVENT_PAYLOAD_ALLOWLIST: Readonly<Record<CommercialEventType, ReadonlyArray<string>>> = Object.freeze({
  "agency.first_purchase_designated.v1": ["agencyId", "firstQualifyingCaptureId", "firstAuthorizationId", "firstProjectId"],
});

/** The registered destinations B10 adds to B09's commerce events (migration 0028 inserts the same rows into kauro.commerce_event_subscriptions). */
export const COMMERCIAL_EVENT_SUBSCRIPTIONS: ReadonlyArray<{ readonly eventType: "capture.funds_observed.v1" | "commercial_authorization.delivered.v1"; readonly consumer: "COMMISSIONS" }> = Object.freeze([
  { eventType: "capture.funds_observed.v1", consumer: "COMMISSIONS" },
  { eventType: "commercial_authorization.delivered.v1", consumer: "COMMISSIONS" },
]);
