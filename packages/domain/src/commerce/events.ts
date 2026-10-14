/**
 * The event vocabulary of the payments and fiscal workflow (package B09; design §9). Appended to the registered vocabulary of
 * model/events.ts (EVENT_TYPES, AGGREGATE_KINDS, EVENT_PAYLOAD_ALLOWLIST, CONSUMERS, EVENT_SUBSCRIPTIONS) and seeded by
 * migration 0013 (kauro.event_types) and by the migrations that create each table (their rows of the shared registry kauro.aggregate_kinds, foundation 0008); the persistence tests prove the database and these lists equal.
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
 * The event that records a version of a commerce aggregate (decision D-EVT-B3; B09-N1): the type of the state the version
 * records — `<kind>.<state>.v1`, and for the states whose event names the act (a quote DRAFT is drafted, an authorization ACTIVE
 * is issued, a document DRAFT is drafted, a case OPEN is opened) that act's type. A back edge publishes the type of its target
 * state. Migration 0013 mirrors this table in kauro.commerce_event_bindings (event type → aggregate kind and recorded state or
 * fact), every commerce table's deferred trigger `<table>_event_type_per_version` (kauro.require_commerce_event_type) refuses a
 * version whose event is another type, and domain_events_commerce_kind refuses a commerce event type on an aggregate of another
 * kind (KA003); the persistence test proves the table and these lists equal.
 */
export const COMMERCE_STATE_EVENT_TYPES: Readonly<Record<CommerceAggregateKind, Readonly<Record<string, CommerceEventType>>>> = Object.freeze({
  quote: {
    DRAFT: "quote.drafted.v1",
    ISSUED: "quote.issued.v1",
    ACCEPTED_FOR_CHECKOUT: "quote.accepted_for_checkout.v1",
    EXPIRED: "quote.expired.v1",
    SUPERSEDED: "quote.superseded.v1",
    WITHDRAWN: "quote.withdrawn.v1",
  },
  payment_order: {
    INTENT_CREATED: "payment_order.intent_created.v1",
    CREATING: "payment_order.creating.v1",
    CREATED: "payment_order.created.v1",
    APPROVED: "payment_order.approved.v1",
    CAPTURING: "payment_order.capturing.v1",
    CAPTURE_UNCERTAIN: "payment_order.capture_uncertain.v1",
    CAPTURED: "payment_order.captured.v1",
    FAILED: "payment_order.failed.v1",
    CANCELLED: "payment_order.cancelled.v1",
    EXPIRED: "payment_order.expired.v1",
  },
  payment_attempt: {
    PREPARED: "payment_attempt.prepared.v1",
    DISPATCHING: "payment_attempt.dispatching.v1",
    PROVIDER_PENDING: "payment_attempt.provider_pending.v1",
    CONFIRMED: "payment_attempt.confirmed.v1",
    FAILED_NO_EFFECT: "payment_attempt.failed_no_effect.v1",
    UNCERTAIN: "payment_attempt.uncertain.v1",
    CANCELLED_BEFORE_DISPATCH: "payment_attempt.cancelled_before_dispatch.v1",
  },
  capture: {
    PENDING: "capture.pending.v1",
    COMPLETED: "capture.completed.v1",
    DENIED: "capture.denied.v1",
    REVERSED: "capture.reversed.v1",
  },
  commercial_authorization: {
    ACTIVE: "commercial_authorization.issued.v1",
    CONSUMED: "commercial_authorization.consumed.v1",
    DELIVERED: "commercial_authorization.delivered.v1",
    REVOKED: "commercial_authorization.revoked.v1",
  },
  refund: {
    REQUESTED: "refund.requested.v1",
    APPROVED: "refund.approved.v1",
    REJECTED: "refund.rejected.v1",
    SUBMITTING: "refund.submitting.v1",
    UNCERTAIN: "refund.uncertain.v1",
    COMPLETED: "refund.completed.v1",
    FAILED: "refund.failed.v1",
  },
  tax_document: {
    DRAFT: "tax_document.drafted.v1",
    VALIDATED: "tax_document.validated.v1",
    SUBMITTING: "tax_document.submitting.v1",
    ISSUED: "tax_document.issued.v1",
    UNCERTAIN: "tax_document.uncertain.v1",
    REJECTED: "tax_document.rejected.v1",
    CORRECTED: "tax_document.corrected.v1",
  },
  reconciliation_case: {
    OPEN: "reconciliation_case.opened.v1",
    RESOLVED: "reconciliation_case.resolved.v1",
  },
});

/**
 * What a commerce aggregate version changed, as its writer knows it: the state before (null at birth) and after, and — for a
 * capture — whether it learned the provider's fee or the funds' availability in this version.
 */
export interface CommerceVersionChange {
  readonly previousState: string | null;
  readonly state: string;
  readonly feeChanged?: boolean;
  readonly fundsChanged?: boolean;
}

/**
 * The event type of a commerce aggregate version (D-EVT-B2, D-EVT-B3; B09-N1). Every version publishes the type of the state it
 * records, except a capture version that keeps its status: it records one later provider fact, the fee (capture.fee_observed.v1)
 * or the funds' availability (capture.funds_observed.v1), never both — two facts are two versions. A capture's funds availability
 * is only ever a version of its own (a capture is born with funds UNKNOWN), so the FUNDS postings chain from the receivable its
 * CAPTURE posting debited; a fee learned with the completion travels in capture.completed.v1 (providerFeeCents). Throws when the
 * change is not one the database admits (kauro.require_commerce_event_type answers KA003 for it).
 */
export function commerceVersionEventType(kind: CommerceAggregateKind, change: CommerceVersionChange): CommerceEventType {
  const byState = COMMERCE_STATE_EVENT_TYPES[kind];
  const stateType = byState[change.state];
  if (stateType === undefined) throw new RangeError(`${kind} has no state ${change.state}`);
  const fee = change.feeChanged === true;
  const funds = change.fundsChanged === true;
  if (kind !== "capture") {
    if (fee || funds) throw new RangeError(`${kind} records no provider fee or funds`);
    return stateType;
  }
  if (change.previousState !== change.state) {
    if (funds) throw new RangeError("a capture's funds availability is a version of its own (capture.funds_observed.v1)");
    if (fee && change.state !== "COMPLETED") throw new RangeError("a capture learns its fee with its completion or in a version of its own");
    return stateType;
  }
  if (fee && !funds) return "capture.fee_observed.v1";
  if (funds && !fee) return "capture.funds_observed.v1";
  throw new RangeError("a capture version that keeps its status records exactly one later provider fact: the fee or the funds");
}

/**
 * The commerce events the request handlers (kauro_app) may publish at all (D-AUTH-B4, D-EVT-B3; B09-N1): an agency member (TENANT
 * context) the quote lifecycle, the intent and claim edges of a provider effect and its own refund request; a corporate owner in
 * its finance scope (OPERATOR context) the review of a refund and the resolution of a case. Every other commerce event — a
 * provider result, a capture fact and its later facts, a refund's execution, an entitlement's issuance and revocation, a fiscal
 * document, a case's opening — is the payment service's (kauro_payment) or, for consumption and delivery, the processing package's.
 * Migration 0013's restrictive policy domain_events_commerce_request_handlers admits exactly these lists
 * (kauro.commerce_event_bindings.request_handler; the persistence test proves both equal).
 */
export const COMMERCE_REQUEST_HANDLER_EVENT_TYPES: Readonly<{ readonly TENANT: ReadonlyArray<CommerceEventType>; readonly OPERATOR: ReadonlyArray<CommerceEventType> }> = Object.freeze({
  TENANT: [
    "quote.drafted.v1",
    "quote.issued.v1",
    "quote.accepted_for_checkout.v1",
    "quote.expired.v1",
    "quote.superseded.v1",
    "quote.withdrawn.v1",
    "payment_order.intent_created.v1",
    "payment_order.creating.v1",
    "payment_order.capturing.v1",
    "payment_attempt.prepared.v1",
    "payment_attempt.dispatching.v1",
    "refund.requested.v1",
  ],
  OPERATOR: ["refund.approved.v1", "refund.rejected.v1", "reconciliation_case.resolved.v1"],
});

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
  // fundsState: the balance the returned money is taken from, as the capture's funds stood at this version (D-LEDGER-B5);
  // movableBalanceCents: the capture's movable balance before the money left, the most taken from that balance (D-LEDGER-B6)
  "capture.reversed.v1": [
    "captureId", "agencyId", "orderId", "projectId", "previousStatus", "reversedServiceCents", "reversedTaxCents", "reversedExcessCents",
    "fundsState", "movableBalanceCents", "evidenceHash", "source",
  ],
  "capture.fee_observed.v1": ["captureId", "agencyId", "orderId", "providerFeeCents", "fundsState", "movableBalanceCents", "currency", "evidenceHash", "source"],
  // amountCents: the capture's movable balance at this version (commerce/ledger movableBalanceOf), the amount the FUNDS postings move
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
  // fundsState and movableBalanceCents: the balance the refunded money is taken from, and the capture's movable balance before this
  // refund, read after the completions of the same capture that committed before it (D-LEDGER-B5, D-LEDGER-B6); returned*Cents: what
  // this completion returns from the capture's unreturned components — its approved components, or nothing when the capture's
  // reversal already returned them (commerce/ledger refundReturnOf, D-LEDGER-B7; B09-R2). serviceCents, taxCents and excessCents stay
  // the approved components the credit note and the commissions follow.
  "refund.completed.v1": [
    "refundId", "agencyId", "projectId", "orderId", "captureId", "serviceCents", "taxCents", "excessCents", "serviceBasisAfterCents", "fundsState",
    "movableBalanceCents", "returnedServiceCents", "returnedTaxCents", "returnedExcessCents", "previousState", "evidenceHash",
  ],
  "refund.failed.v1": ["refundId", "agencyId", "failureCode", "previousState"],
  "tax_document.drafted.v1": [
    "documentId", "agencyId", "orderId", "captureId", "refundId", "kind", "taxTreatment", "serviceCents", "taxCents", "blockedReason", "correctsDocumentId",
    "supersedesDocumentId",
  ],
  "tax_document.validated.v1": ["documentId", "agencyId", "kind", "fiscalProfileId", "issuerRef", "taxTreatment", "taxCents", "previousState"],
  "tax_document.submitting.v1": ["documentId", "agencyId", "orderId", "issueRequestHash", "previousState"],
  "tax_document.issued.v1": ["documentId", "agencyId", "orderId", "evidenceHash", "previousState"],
  "tax_document.uncertain.v1": ["documentId", "agencyId", "orderId", "previousState"],
  "tax_document.rejected.v1": ["documentId", "agencyId", "orderId", "rejectionCode", "previousState"],
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
  // the processing package's delivery of the entitlement reaches the agency (package B08, migration 0022; D8-XPKG-7)
  { eventType: "commercial_authorization.delivered.v1", consumer: "NOTIFICATIONS" },
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
  // CMD035's reconciler watches every submission past its deadline, and an issued invoice validates the credit notes drafted against
  // it while it was SUBMITTING (B15 M6, M19; migration 0074 inserts the same rows)
  { eventType: "tax_document.submitting.v1", consumer: "FISCAL" },
  { eventType: "tax_document.issued.v1", consumer: "FISCAL" },
  { eventType: "tax_document.issued.v1", consumer: "NOTIFICATIONS" },
  { eventType: "reconciliation_case.opened.v1", consumer: "NOTIFICATIONS" },
  // the reviewed resolution of a case sources the correcting ledger postings it decides (D-LEDGER-B4; B09-F15)
  { eventType: "reconciliation_case.resolved.v1", consumer: "FINANCE" },
]);

/**
 * The event names the Payments V1 bank-transfer route will publish (docs/design/ACH-ROUTE.md D-ACH-11, D-ACH-18, DV1-08; lane KIT). They
 * are NAMES ONLY, deliberately not in COMMERCE_EVENT_TYPES: an event type needs an aggregate kind registered in kauro.aggregate_kinds with
 * an agency_id and version column, and the route-scope aggregates (credit, attempt, treasury refund) have none yet. The lane that first
 * publishes one registers its kind, its binding and its allowlist together (and its subscribers in COMMERCE_EVENT_SUBSCRIPTIONS);
 * core/bank-postings.ts and core/return-postings.ts take their postings from these names.
 */
export const BANK_POSTING_EVENT_TYPES = ["bank_credit.received.v1", "bank_credit.assigned.v1", "bank_credit.reversed.v1"] as const;
export const RETURN_POSTING_EVENT_TYPES = ["outbound.over_returned.v1", "outbound.bounced.v1", "outbound.resent.v1"] as const;
export type BankPostingEventType = (typeof BANK_POSTING_EVENT_TYPES)[number] | (typeof RETURN_POSTING_EVENT_TYPES)[number];
