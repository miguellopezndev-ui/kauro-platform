/**
 * The event vocabulary of the payments and fiscal workflow (package B09; design §9). Appended to the registered vocabulary of
 * model/events.ts (EVENT_TYPES, AGGREGATE_KINDS, EVENT_PAYLOAD_ALLOWLIST, CONSUMERS, EVENT_SUBSCRIPTIONS) and seeded by
 * migration 0009 (kauro.event_types) and by the migrations that create each table (their rows of the shared registry kauro.aggregate_kinds, foundation 0008); the persistence tests prove the database and these lists equal.
 *
 * One event type per reachable state of each versioned commerce aggregate (`<kind>.<state>.v1`), as B06 does for the
 * DatasetRevision lifecycle: a back edge (a capture proved to have had no effect returns the order to APPROVED) publishes the
 * type of its target state and names `previousState`. Payloads follow the B06 rule (07 "references and safe counts, never CRM
 * rows or secrets"; D-EVT-2): ids, hashes, uppercase tokens, non-negative integers (amounts in minor units) and booleans. A
 * provider's own identifiers never enter a payload — a consumer reads them from the aggregate under its own policies — and
 * neither does a label: the refund's reasonCode is customer text (CMD031 `label`, B06 D-API-1) and stays on its row; the
 * server's own reasons travel as tokens under `outcomeCode`, `failureCode`, `revocationCode`, `rejectionCode`, `detailCode`.
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
  // a provider fact learned after the status is a new capture version with its own event, never a second completion (B09-F8,
  // B09-F15; D-EVT-B2): the fee the provider reported, and the provider's availability of the captured funds
  "capture.fee_observed.v1",
  "capture.funds_observed.v1",
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

/**
 * Registered destinations B09 adds (07 "consumer: Registered destination"): the ledger poster (FINANCE) and the fiscal document
 * drafter (FISCAL) are this package's consumers, run by the payment service; the payment service itself consumes the attempts it
 * must watch and the refunds it must execute (PAYMENT_SERVICE); COMMISSIONS is the recurrence and commission package's (B10).
 */
export const COMMERCE_CONSUMERS = ["COMMISSIONS", "FINANCE", "FISCAL", "PAYMENT_SERVICE"] as const;
export type CommerceConsumer = (typeof COMMERCE_CONSUMERS)[number];

const ATTEMPT = ["attemptId", "agencyId", "orderId", "refundId", "operation", "ordinal"] as const;

export const COMMERCE_EVENT_PAYLOAD_ALLOWLIST: Readonly<Record<CommerceEventType, ReadonlyArray<string>>> = Object.freeze({
  "quote.drafted.v1": ["quoteId", "agencyId", "projectId", "planId", "approvalId"],
  "quote.issued.v1": [
    "quoteId", "agencyId", "projectId", "planId", "approvalId", "planHash", "revisionHash", "targetContractHash", "mode", "billableUnits",
    "discountBps", "baseServiceCents", "discountCents", "serviceCents", "taxCents", "totalCents", "currency", "termsHash", "eligibilitySnapshotId",
    "fiscalProfileId", "taxTreatment", "pricePolicyVersion", "discountPolicyVersion", "previousState",
  ],
  "quote.accepted_for_checkout.v1": ["quoteId", "agencyId", "termsHash", "orderId", "previousState"],
  "quote.expired.v1": ["quoteId", "agencyId", "previousState"],
  "quote.superseded.v1": ["quoteId", "agencyId", "successorQuoteId", "previousState"],
  "quote.withdrawn.v1": ["quoteId", "agencyId", "previousState"],
  "payment_order.intent_created.v1": ["orderId", "agencyId", "projectId", "quoteId", "environment", "expectedAmountCents", "currency", "idempotencyHash"],
  "payment_order.creating.v1": ["orderId", "agencyId", "attemptId", "previousState"],
  "payment_order.created.v1": ["orderId", "agencyId", "attemptId", "previousState"],
  "payment_order.approved.v1": ["orderId", "agencyId", "attemptId", "previousState", "outcomeCode"],
  "payment_order.capturing.v1": ["orderId", "agencyId", "attemptId", "previousState"],
  "payment_order.capture_uncertain.v1": ["orderId", "agencyId", "attemptId", "previousState"],
  "payment_order.captured.v1": ["orderId", "agencyId", "captureId", "previousState"],
  "payment_order.failed.v1": ["orderId", "agencyId", "attemptId", "outcomeCode", "previousState"],
  "payment_order.cancelled.v1": ["orderId", "agencyId", "attemptId", "outcomeCode", "previousState"],
  "payment_order.expired.v1": ["orderId", "agencyId", "outcomeCode", "previousState"],
  "payment_attempt.prepared.v1": [...ATTEMPT, "requestHash"],
  "payment_attempt.dispatching.v1": [...ATTEMPT, "previousState"],
  "payment_attempt.provider_pending.v1": [...ATTEMPT, "evidenceHash", "previousState"],
  "payment_attempt.confirmed.v1": [...ATTEMPT, "evidenceHash", "previousState"],
  "payment_attempt.failed_no_effect.v1": [...ATTEMPT, "outcomeCode", "evidenceHash", "previousState"],
  "payment_attempt.uncertain.v1": [...ATTEMPT, "outcomeCode", "previousState"],
  "payment_attempt.cancelled_before_dispatch.v1": [...ATTEMPT, "outcomeCode", "previousState"],
  "capture.pending.v1": ["captureId", "agencyId", "orderId", "amountCents", "currency", "evidenceHash", "source"],
  "capture.completed.v1": [
    "captureId", "agencyId", "orderId", "projectId", "quoteId", "amountCents", "currency", "allocatedServiceCents", "allocatedTaxCents",
    "excessCents", "providerFeeCents", "previousStatus", "evidenceHash", "source",
  ],
  "capture.denied.v1": ["captureId", "agencyId", "orderId", "previousStatus", "evidenceHash", "source"],
  "capture.reversed.v1": [
    "captureId", "agencyId", "orderId", "projectId", "previousStatus", "reversedServiceCents", "reversedTaxCents", "reversedExcessCents",
    "evidenceHash", "source",
  ],
  "capture.fee_observed.v1": ["captureId", "agencyId", "orderId", "providerFeeCents", "currency", "evidenceHash", "source"],
  "capture.funds_observed.v1": ["captureId", "agencyId", "orderId", "fundsState", "previousFundsState", "amountCents", "currency", "evidenceHash", "source"],
  "commercial_authorization.issued.v1": [
    "authorizationId", "agencyId", "projectId", "quoteId", "orderId", "orderQuoteId", "captureId", "rebindingId", "approvalId", "approvalHash", "planHash",
    "revisionHash", "targetContractHash", "capabilityId", "capabilityVersion", "mode", "billableUnits", "honoredAfterPriceExpiry",
  ],
  "commercial_authorization.consumed.v1": ["authorizationId", "agencyId", "jobRef", "previousState"],
  "commercial_authorization.delivered.v1": ["authorizationId", "agencyId", "jobRef", "previousState"],
  "commercial_authorization.revoked.v1": ["authorizationId", "agencyId", "projectId", "captureId", "phase", "revocationCode", "previousState"],
  "refund.requested.v1": [
    "refundId", "agencyId", "projectId", "orderId", "captureId", "origin", "deliveryPhase", "proposedServiceCents", "proposedTaxCents",
    "proposedExcessCents",
  ],
  "refund.approved.v1": [
    "refundId", "agencyId", "captureId", "serviceCents", "taxCents", "excessCents", "authorizationKind", "authorizationHash", "effectsHash",
    "creditNoteRequired", "previousState", "attemptId",
  ],
  "refund.rejected.v1": ["refundId", "agencyId", "rejectionCode"],
  "refund.submitting.v1": ["refundId", "agencyId", "attemptId"],
  "refund.uncertain.v1": ["refundId", "agencyId", "attemptId"],
  "refund.completed.v1": [
    "refundId", "agencyId", "projectId", "orderId", "captureId", "serviceCents", "taxCents", "excessCents", "serviceBasisAfterCents", "previousState",
    "evidenceHash",
  ],
  "refund.failed.v1": ["refundId", "agencyId", "failureCode", "previousState"],
  "tax_document.drafted.v1": [
    "documentId", "agencyId", "orderId", "captureId", "refundId", "kind", "taxTreatment", "serviceCents", "taxCents", "blockedReason", "correctsDocumentId",
    "supersedesDocumentId",
  ],
  "tax_document.validated.v1": ["documentId", "agencyId", "kind", "fiscalProfileId", "issuerRef", "taxTreatment", "taxCents", "previousState"],
  "tax_document.submitting.v1": ["documentId", "agencyId", "issueRequestHash", "previousState"],
  "tax_document.issued.v1": ["documentId", "agencyId", "evidenceHash", "previousState"],
  "tax_document.uncertain.v1": ["documentId", "agencyId", "previousState"],
  "tax_document.rejected.v1": ["documentId", "agencyId", "rejectionCode", "previousState"],
  "tax_document.corrected.v1": ["documentId", "agencyId", "successorDocumentId", "previousState"],
  "reconciliation_case.opened.v1": ["caseId", "agencyId", "orderId", "captureId", "refundId", "kind", "detailCode", "amountCents", "currency"],
  "reconciliation_case.resolved.v1": ["caseId", "agencyId", "resolutionCode"],
});

export const COMMERCE_EVENT_SUBSCRIPTIONS: ReadonlyArray<{ readonly eventType: CommerceEventType; readonly consumer: "NOTIFICATIONS" | "EXECUTION_CONTROL" | CommerceConsumer }> = Object.freeze([
  { eventType: "quote.issued.v1", consumer: "NOTIFICATIONS" },
  // the payment service watches every dispatched attempt: past its dispatch deadline it reconciles by provider identity (D-PROTO-B4)
  { eventType: "payment_attempt.dispatching.v1", consumer: "PAYMENT_SERVICE" },
  { eventType: "payment_attempt.provider_pending.v1", consumer: "PAYMENT_SERVICE" },
  { eventType: "payment_attempt.uncertain.v1", consumer: "PAYMENT_SERVICE" },
  { eventType: "payment_order.capture_uncertain.v1", consumer: "NOTIFICATIONS" },
  { eventType: "payment_order.captured.v1", consumer: "NOTIFICATIONS" },
  // one reconciled financial event, several separate idempotent effects (TRANSITIONS "Cross-aggregate finalization")
  { eventType: "capture.completed.v1", consumer: "FINANCE" },
  { eventType: "capture.completed.v1", consumer: "FISCAL" },
  { eventType: "capture.completed.v1", consumer: "COMMISSIONS" },
  // a fee or a funds availability learned later is posted by the ledger only: it is not a new collection, so neither the fiscal
  // drafter nor the commission accrual receives it (B09-F8)
  { eventType: "capture.fee_observed.v1", consumer: "FINANCE" },
  { eventType: "capture.funds_observed.v1", consumer: "FINANCE" },
  { eventType: "capture.reversed.v1", consumer: "FINANCE" },
  { eventType: "capture.reversed.v1", consumer: "COMMISSIONS" },
  { eventType: "capture.reversed.v1", consumer: "NOTIFICATIONS" },
  { eventType: "commercial_authorization.issued.v1", consumer: "EXECUTION_CONTROL" },
  { eventType: "commercial_authorization.issued.v1", consumer: "NOTIFICATIONS" },
  { eventType: "commercial_authorization.revoked.v1", consumer: "EXECUTION_CONTROL" },
  { eventType: "commercial_authorization.revoked.v1", consumer: "NOTIFICATIONS" },
  { eventType: "refund.requested.v1", consumer: "NOTIFICATIONS" },
  // an approved refund (and one returned to APPROVED after a proved no-effect) is executed by the payment service (CMD033)
  { eventType: "refund.approved.v1", consumer: "PAYMENT_SERVICE" },
  { eventType: "refund.uncertain.v1", consumer: "PAYMENT_SERVICE" },
  { eventType: "refund.completed.v1", consumer: "FINANCE" },
  { eventType: "refund.completed.v1", consumer: "FISCAL" },
  { eventType: "refund.completed.v1", consumer: "COMMISSIONS" },
  { eventType: "refund.completed.v1", consumer: "NOTIFICATIONS" },
  { eventType: "refund.failed.v1", consumer: "NOTIFICATIONS" },
  // the issuance command of the fiscal integration package (CMD035, B15) takes validated documents and uncertain submissions
  { eventType: "tax_document.validated.v1", consumer: "FISCAL" },
  { eventType: "tax_document.uncertain.v1", consumer: "FISCAL" },
  { eventType: "tax_document.issued.v1", consumer: "NOTIFICATIONS" },
  { eventType: "reconciliation_case.opened.v1", consumer: "NOTIFICATIONS" },
  // the reviewed resolution of a case sources the correcting ledger postings it decides (D-LEDGER-B4; B09-F15)
  { eventType: "reconciliation_case.resolved.v1", consumer: "FINANCE" },
]);
