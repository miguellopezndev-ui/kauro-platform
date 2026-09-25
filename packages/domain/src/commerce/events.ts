/**
 * The event vocabulary of the payments and fiscal workflow (package B09; design §9). Appended to the registered vocabulary of
 * model/events.ts (EVENT_TYPES, AGGREGATE_KINDS, EVENT_PAYLOAD_ALLOWLIST, CONSUMERS, EVENT_SUBSCRIPTIONS) and seeded by
 * migration 0008 (kauro.event_types, kauro.aggregate_kinds); the persistence test proves the database and this list equal.
 *
 * One event type per reachable state of each versioned commerce aggregate (`<kind>.<state>.v1`); a back edge publishes the
 * type of its target state with `previousState`. Payloads follow the B06 rule (07 "references and safe counts, never CRM rows
 * or secrets"): ids, hashes, uppercase tokens, non-negative integers (amounts in minor units) and booleans. A provider's own
 * identifiers never enter a payload — consumers read them from the aggregate — and neither does a label.
 */

export const COMMERCE_AGGREGATE_KINDS = ["quote", "payment_order", "payment_attempt", "capture", "commercial_authorization", "refund", "tax_document", "reconciliation_case"] as const;
export type CommerceAggregateKind = (typeof COMMERCE_AGGREGATE_KINDS)[number];

export const COMMERCE_EVENT_TYPES = [
  "quote.drafted.v1",
  "quote.issued.v1",
  "quote.accepted_for_checkout.v1",
  "quote.expired.v1",
  "quote.superseded.v1",
  "quote.withdrawn.v1",
  "payment_order.intent_created.v1",
  "payment_order.creating.v1",
  "payment_order.created.v1",
  "payment_order.approved.v1",
  "payment_order.capturing.v1",
  "payment_order.capture_uncertain.v1",
  "payment_order.captured.v1",
  "payment_order.failed.v1",
  "payment_order.cancelled.v1",
  "payment_order.expired.v1",
  "payment_attempt.prepared.v1",
  "payment_attempt.dispatching.v1",
  "payment_attempt.provider_pending.v1",
  "payment_attempt.confirmed.v1",
  "payment_attempt.failed_no_effect.v1",
  "payment_attempt.uncertain.v1",
  "payment_attempt.cancelled_before_dispatch.v1",
  "capture.pending.v1",
  "capture.completed.v1",
  "capture.denied.v1",
  "capture.reversed.v1",
  "commercial_authorization.issued.v1",
  "commercial_authorization.consumed.v1",
  "commercial_authorization.delivered.v1",
  "commercial_authorization.revoked.v1",
  "refund.requested.v1",
  "refund.approved.v1",
  "refund.rejected.v1",
  "refund.submitting.v1",
  "refund.uncertain.v1",
  "refund.completed.v1",
  "refund.failed.v1",
  "tax_document.drafted.v1",
  "tax_document.validated.v1",
  "tax_document.submitting.v1",
  "tax_document.issued.v1",
  "tax_document.uncertain.v1",
  "tax_document.rejected.v1",
  "tax_document.corrected.v1",
  "reconciliation_case.opened.v1",
  "reconciliation_case.resolved.v1",
] as const;
export type CommerceEventType = (typeof COMMERCE_EVENT_TYPES)[number];

/** Registered destinations B09 adds (07 "consumer: Registered destination"); dispatchers arrive with their packages. */
export const COMMERCE_CONSUMERS = ["COMMISSIONS", "FINANCE", "PAYMENT_SERVICE", "FISCAL"] as const;
export type CommerceConsumer = (typeof COMMERCE_CONSUMERS)[number];

const ATTEMPT = ["attemptId", "agencyId", "orderId", "refundId", "operation"] as const;

export const COMMERCE_EVENT_PAYLOAD_ALLOWLIST: Readonly<Record<CommerceEventType, ReadonlyArray<string>>> = Object.freeze({
  "quote.drafted.v1": ["quoteId", "agencyId", "projectId"],
  "quote.issued.v1": [
    "quoteId", "agencyId", "projectId", "planId", "approvalId", "planHash", "revisionHash", "mode", "billableUnits", "discountBps",
    "serviceCents", "taxCents", "totalCents", "currency", "termsHash", "eligibilitySnapshotId", "fiscalProfileId", "taxTreatment",
    "pricePolicyVersion", "previousState",
  ],
  "quote.accepted_for_checkout.v1": ["quoteId", "agencyId", "termsHash", "orderId"],
  "quote.expired.v1": ["quoteId", "agencyId", "previousState"],
  "quote.superseded.v1": ["quoteId", "agencyId", "successorQuoteId", "previousState"],
  "quote.withdrawn.v1": ["quoteId", "agencyId", "reasonCode", "previousState"],
  "payment_order.intent_created.v1": ["orderId", "agencyId", "projectId", "quoteId", "environment", "expectedAmountCents", "currency", "idempotencyHash", "attemptId"],
  "payment_order.creating.v1": ["orderId", "agencyId", "attemptId", "previousState"],
  "payment_order.created.v1": ["orderId", "agencyId", "attemptId", "previousState"],
  "payment_order.approved.v1": ["orderId", "agencyId", "attemptId", "previousState", "reasonCode"],
  "payment_order.capturing.v1": ["orderId", "agencyId", "attemptId", "previousState"],
  "payment_order.capture_uncertain.v1": ["orderId", "agencyId", "attemptId", "previousState"],
  "payment_order.captured.v1": ["orderId", "agencyId", "captureId", "previousState"],
  "payment_order.failed.v1": ["orderId", "agencyId", "attemptId", "reasonCode", "previousState"],
  "payment_order.cancelled.v1": ["orderId", "agencyId", "attemptId", "reasonCode", "previousState"],
  "payment_order.expired.v1": ["orderId", "agencyId", "reasonCode", "previousState"],
  "payment_attempt.prepared.v1": [...ATTEMPT, "requestHash"],
  "payment_attempt.dispatching.v1": [...ATTEMPT, "previousState"],
  "payment_attempt.provider_pending.v1": [...ATTEMPT, "evidenceHash", "previousState"],
  "payment_attempt.confirmed.v1": [...ATTEMPT, "evidenceHash", "previousState"],
  "payment_attempt.failed_no_effect.v1": [...ATTEMPT, "reasonCode", "evidenceHash", "previousState"],
  "payment_attempt.uncertain.v1": [...ATTEMPT, "reasonCode", "previousState"],
  "payment_attempt.cancelled_before_dispatch.v1": [...ATTEMPT, "reasonCode", "previousState"],
  "capture.pending.v1": ["captureId", "agencyId", "orderId", "amountCents", "currency", "evidenceHash"],
  "capture.completed.v1": [
    "captureId", "agencyId", "orderId", "projectId", "quoteId", "amountCents", "currency", "allocatedServiceCents", "allocatedTaxCents",
    "excessCents", "previousStatus", "evidenceHash",
  ],
  "capture.denied.v1": ["captureId", "agencyId", "orderId", "previousStatus", "evidenceHash"],
  "capture.reversed.v1": [
    "captureId", "agencyId", "orderId", "projectId", "previousStatus", "reversedServiceCents", "reversedTaxCents", "reversedExcessCents",
    "evidenceHash",
  ],
  "commercial_authorization.issued.v1": [
    "authorizationId", "agencyId", "projectId", "quoteId", "orderId", "captureId", "approvalId", "approvalHash", "planHash", "revisionHash",
    "targetContractHash", "capabilityId", "capabilityVersion", "mode", "billableUnits", "honoredAfterPriceExpiry",
  ],
  "commercial_authorization.consumed.v1": ["authorizationId", "agencyId", "jobRef", "previousState"],
  "commercial_authorization.delivered.v1": ["authorizationId", "agencyId", "jobRef", "previousState"],
  "commercial_authorization.revoked.v1": ["authorizationId", "agencyId", "projectId", "captureId", "phase", "reasonCode", "previousState"],
  "refund.requested.v1": [
    "refundId", "agencyId", "projectId", "orderId", "captureId", "origin", "reasonCode", "deliveryPhase", "proposedServiceCents",
    "proposedTaxCents", "proposedExcessCents",
  ],
  "refund.approved.v1": [
    "refundId", "agencyId", "captureId", "serviceCents", "taxCents", "excessCents", "authorizationKind", "authorizationHash", "effectsHash",
    "creditNoteRequired", "previousState", "attemptId", "reasonCode",
  ],
  "refund.rejected.v1": ["refundId", "agencyId", "reasonCode"],
  "refund.submitting.v1": ["refundId", "agencyId", "attemptId"],
  "refund.uncertain.v1": ["refundId", "agencyId", "attemptId"],
  "refund.completed.v1": ["refundId", "agencyId", "projectId", "captureId", "serviceCents", "taxCents", "excessCents", "previousState", "evidenceHash", "creditNoteId"],
  "refund.failed.v1": ["refundId", "agencyId", "reasonCode"],
  "tax_document.drafted.v1": ["documentId", "agencyId", "orderId", "captureId", "refundId", "kind", "taxTreatment", "serviceCents", "taxCents", "blockedReason"],
  "tax_document.validated.v1": ["documentId", "agencyId", "kind", "fiscalProfileId", "taxTreatment", "taxCents", "previousState"],
  "tax_document.submitting.v1": ["documentId", "agencyId", "issueRequestHash", "previousState"],
  "tax_document.issued.v1": ["documentId", "agencyId", "evidenceHash", "previousState"],
  "tax_document.uncertain.v1": ["documentId", "agencyId", "previousState"],
  "tax_document.rejected.v1": ["documentId", "agencyId", "reasonCode", "previousState"],
  "tax_document.corrected.v1": ["documentId", "agencyId", "successorDocumentId", "previousState"],
  "reconciliation_case.opened.v1": ["caseId", "agencyId", "orderId", "captureId", "refundId", "kind", "detailCode", "amountCents", "currency"],
  "reconciliation_case.resolved.v1": ["caseId", "agencyId", "resolution"],
});

export const COMMERCE_EVENT_SUBSCRIPTIONS: ReadonlyArray<{ readonly eventType: CommerceEventType; readonly consumer: "NOTIFICATIONS" | "EXECUTION_CONTROL" | CommerceConsumer }> = Object.freeze([
  { eventType: "quote.issued.v1", consumer: "NOTIFICATIONS" },
  // the payment service is the watchdog of every dispatched attempt: after its deadline it reconciles by provider identity
  { eventType: "payment_attempt.dispatching.v1", consumer: "PAYMENT_SERVICE" },
  { eventType: "payment_attempt.provider_pending.v1", consumer: "PAYMENT_SERVICE" },
  { eventType: "payment_attempt.uncertain.v1", consumer: "PAYMENT_SERVICE" },
  { eventType: "payment_attempt.uncertain.v1", consumer: "FINANCE" },
  { eventType: "payment_order.capture_uncertain.v1", consumer: "NOTIFICATIONS" },
  { eventType: "payment_order.captured.v1", consumer: "NOTIFICATIONS" },
  { eventType: "capture.completed.v1", consumer: "COMMISSIONS" },
  { eventType: "capture.completed.v1", consumer: "FINANCE" },
  { eventType: "capture.reversed.v1", consumer: "COMMISSIONS" },
  { eventType: "capture.reversed.v1", consumer: "FINANCE" },
  { eventType: "capture.reversed.v1", consumer: "NOTIFICATIONS" },
  { eventType: "commercial_authorization.issued.v1", consumer: "EXECUTION_CONTROL" },
  { eventType: "commercial_authorization.issued.v1", consumer: "NOTIFICATIONS" },
  { eventType: "commercial_authorization.revoked.v1", consumer: "EXECUTION_CONTROL" },
  { eventType: "commercial_authorization.revoked.v1", consumer: "NOTIFICATIONS" },
  { eventType: "commercial_authorization.revoked.v1", consumer: "FINANCE" },
  { eventType: "refund.requested.v1", consumer: "FINANCE" },
  { eventType: "refund.requested.v1", consumer: "NOTIFICATIONS" },
  { eventType: "refund.approved.v1", consumer: "PAYMENT_SERVICE" },
  { eventType: "refund.approved.v1", consumer: "NOTIFICATIONS" },
  { eventType: "refund.uncertain.v1", consumer: "PAYMENT_SERVICE" },
  { eventType: "refund.uncertain.v1", consumer: "FINANCE" },
  { eventType: "refund.completed.v1", consumer: "COMMISSIONS" },
  { eventType: "refund.completed.v1", consumer: "FISCAL" },
  { eventType: "refund.completed.v1", consumer: "NOTIFICATIONS" },
  { eventType: "refund.failed.v1", consumer: "FINANCE" },
  { eventType: "refund.failed.v1", consumer: "NOTIFICATIONS" },
  { eventType: "tax_document.drafted.v1", consumer: "FINANCE" },
  { eventType: "tax_document.validated.v1", consumer: "FISCAL" },
  { eventType: "tax_document.uncertain.v1", consumer: "FISCAL" },
  { eventType: "tax_document.uncertain.v1", consumer: "FINANCE" },
  { eventType: "tax_document.issued.v1", consumer: "NOTIFICATIONS" },
  { eventType: "reconciliation_case.opened.v1", consumer: "FINANCE" },
]);
