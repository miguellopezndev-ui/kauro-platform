/**
 * The closed outcome catalogues of the B09 routes (B06 D-OUT-1; 10 "Contract tests and compatibility": the release includes an
 * error catalogue; 10 "Responses and safe errors": frontend control flow uses the code, the reason and the typed fields).
 *
 * Each entry is a ProblemOutcome of api/outcomes. Each route's catalogue is composed exactly as the B06 catalogues are
 * (ROUTE_OUTCOME_FRAGMENTS: every route's transport, admission, authentication, idempotency and platform outcomes, a path id, a
 * tenant's membership, the agency selector) with what B09 adds: the access outcomes of the principals B06 denies by default —
 * the corporate operator, the payment service, the authenticated provider — and the command-layer outcomes of each command and
 * read (design §8). tools/openapi.mjs documents them for the planned routes today; when implementation mandate M3 serves a
 * route, the api's send guard enforces the same list and the generated matrix records it.
 *
 * What is not a problem here: an ambiguous provider effect answers 202 ACCEPTED with the durable operation (D-PROTO-B2); a
 * provider event that cannot be applied is acknowledged 200 with its disposition (REJECTED, IGNORED, a recorded conflict) — the
 * provider is told it was received, and the finance review gets the exception (D-ING-B2).
 */
import type { FailureCode, FailureReason } from "@kauro/domain";
import { ROUTE_OUTCOME_FRAGMENTS, type FieldCode, type OutcomeLayer, type ProblemOutcome } from "../api/outcomes.js";
import type { CommerceCommandId } from "./contracts.js";
import type { CommerceReadOperationId } from "./response-schemas.js";

function outcome(layer: OutcomeLayer, code: FailureCode, reason: FailureReason | null, meaning: string, extra: { readonly fieldCodes?: ReadonlyArray<FieldCode>; readonly current?: "ALWAYS" | "SOMETIMES" } = {}): ProblemOutcome {
  return Object.freeze({ code, reason, layer, meaning, ...extra });
}

/** The corporate operator (KAURO_OWNER; D-CTX-B2, D-CORP-B1): identity status, the ACTIVE grant, then the stored operation. */
const OPERATOR_ACCESS: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("ACCESS", "NOT_AUTHORIZED", "CORPORATE_ROLE_MISSING", "the caller holds no ACTIVE KAURO_OWNER grant (read after its transition lock)"),
  outcome("ACCESS", "NOT_FOUND", null, "the stored operation is unknown to the operator's finance scope: a foreign and a nonexistent id answer alike"),
]);

/** The payment service (PAYMENT_SERVICE; D-CTX-B1, D-AUTHZ-B3): a verified service identity with the role, in its environment. */
const SERVICE_ACCESS: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("AUTHENTICATION", "AUTHENTICATION_REQUIRED", null, "no verified service identity (issuer, audience, expected identity): the anonymous denial is recorded"),
  outcome("ACCESS", "NOT_AUTHORIZED", "SERVICE_NOT_PERMITTED", "the verified service identity does not hold the command's technical role"),
  outcome("ACCESS", "NOT_AUTHORIZED", "SERVICE_ENVIRONMENT_MISMATCH", "the service identity was issued for another environment"),
  outcome("ACCESS", "NOT_FOUND", null, "the stored operation is unknown to the scope index: nothing is adopted and nothing written"),
]);

/** The provider ingress (AUTHENTICATED_PROVIDER; CMD030 precondition): signature, freshness, environment, bounded raw body. */
const PROVIDER_ACCESS: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("ADMISSION", "NOT_FOUND", "PROVIDER_UNKNOWN", "no verifier is configured for the provider named in the path"),
  outcome("ADMISSION", "INVALID_REQUEST", "PROVIDER_BODY_TOO_LARGE", "the raw body exceeds the provider's bound; nothing is verified or stored"),
  outcome("AUTHENTICATION", "AUTHENTICATION_REQUIRED", "PROVIDER_SIGNATURE_INVALID", "the provider signature over the exact raw bytes does not verify: nothing is stored but the anonymous denial"),
  outcome("AUTHENTICATION", "AUTHENTICATION_REQUIRED", "PROVIDER_EVENT_STALE", "the transmission is outside the freshness window (a replay is refused)"),
  outcome("AUTHENTICATION", "AUTHENTICATION_REQUIRED", "PROVIDER_ENVIRONMENT_MISMATCH", "the event was signed for another environment than this deployment's"),
]);

const NOT_VISIBLE = (what: string): ProblemOutcome => outcome("COMMAND", "NOT_FOUND", null, `${what} is not visible to the caller's scope`);
const STALE = (what: string): ProblemOutcome => outcome("COMMAND", "STALE_VERSION", null, `expectedVersion is not the ${what}'s current version; the current safe version and state come back`, { current: "ALWAYS" });
const PROVIDER_SERVICES = outcome("COMMAND", "INTEGRITY_FAILURE", "PROVIDER_SERVICES_UNAVAILABLE", "no payment provider adapter is bound in this edition (a deployment before B15 answers this inside the unit of work; nothing is written)");

/**
 * No deliverable capacity for the purchased scope: the processing package's admission (DeliveryCapacityPort, adapter B08) reports
 * none, or answers nothing (15 "PaymentOrder and intent" validates capacity; 07 "Payment readiness accounts for realistic delivery
 * capacity"; D-CAP-B1, B09-F5). Retryable: capacity is released as admitted work completes.
 */
const DELIVERY_CAPACITY = outcome("COMMAND", "CAPACITY_UNAVAILABLE", "DELIVERY_CAPACITY_UNAVAILABLE", "the processing admission reports no deliverable capacity for the purchased scope; retry later with the same key");

/** Blockers of checkout readiness shared by CMD028 and CMD029 (commerce/authority blockerFailure). */
const SUBJECT_BLOCKERS: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("COMMAND", "PRECONDITION_FAILED", "AGENCY_NOT_ACTIVE", "the agency is not ACTIVE (DRAFT, RESTRICTED, CLOSING or CLOSED block new purchases; 07)", { current: "ALWAYS" }),
  outcome("COMMAND", "PRECONDITION_FAILED", "APPROVAL_NOT_CURRENT", "the quoted plan is no longer APPROVED under the quoted, unwithdrawn approval of the quoted body"),
  outcome("COMMAND", "SOURCE_EXPIRED", null, "the quoted source revision is no longer SEALED (S060: a price-valid quote does not keep deleted data executable)"),
  outcome("COMMAND", "TARGET_STALE", null, "the quoted target contract is no longer confirmed and current"),
  outcome("COMMAND", "CAPABILITY_UNAVAILABLE", "MODE_NOT_OFFERED", "the project's capability is no longer offered"),
]);

/** The command-layer outcomes of each B09 command (design §8). */
const COMMAND_SPECIFIC: Readonly<Record<CommerceCommandId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  CMD028: [
    NOT_VISIBLE("the quote"),
    outcome("COMMAND", "STALE_VERSION", "HASH_MISMATCH", "termsHash is not the quote's terms: current.mismatch names it and the UI reloads the terms it displayed", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "QUOTE_NOT_ACTIVE", "the quote is not ISSUED or ACCEPTED_FOR_CHECKOUT", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "QUOTE_EXPIRED", "the price expired: checkout is blocked and a new quote is required", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "ALREADY_PAID", "a completed capture already pays this quote; no second purchase of the same subject"),
    outcome("COMMAND", "PAYMENT_UNCERTAIN", "CAPTURE_UNCERTAIN", "a capture of the project's open order may have happened: pay nothing again, refresh the status"),
    outcome("COMMAND", "PAYMENT_PENDING", "CAPTURE_IN_PROGRESS", "the project's open order is being captured; retry with the same key once it settles"),
    outcome("COMMAND", "PAYMENT_PENDING", "CREATION_IN_PROGRESS", "the project's open order is still being created at the provider; retry with the same key once it settles"),
    ...SUBJECT_BLOCKERS,
    DELIVERY_CAPACITY,
    outcome("COMMAND", "CAPABILITY_UNAVAILABLE", "PAYMENT_ROUTE_UNQUALIFIED", "no qualified merchant route for the provider and environment"),
    outcome("COMMAND", "CAPABILITY_UNAVAILABLE", "FISCAL_ROUTE_UNQUALIFIED", "the quoted fiscal issuer route is not qualified"),
    outcome("COMMAND", "PRECONDITION_FAILED", "FISCAL_TREATMENT_UNREVIEWED", "the agency's current fiscal profile carries no reviewed treatment (R2-082): the sale path is blocked"),
    outcome("COMMAND", "PRECONDITION_FAILED", "FISCAL_TREATMENT_CHANGED", "the reviewed treatment is no longer the one the quote was priced with: a new quote is required"),
    PROVIDER_SERVICES,
  ],
  CMD029: [
    NOT_VISIBLE("the payment order"),
    outcome("COMMAND", "INVALID_REQUEST", "PROVIDER_REFERENCE_MISMATCH", "providerApprovalRef does not name the stored provider order: a browser claim is never payment (S057)", { fieldCodes: ["UNKNOWN_REFERENCE"] }),
    outcome("COMMAND", "PRECONDITION_FAILED", "ORDER_NOT_CAPTURABLE", "the order is not CREATED or APPROVED (never created, failed, cancelled or expired)", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "ALREADY_PAID", "the order is already CAPTURED", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "QUOTE_NOT_ACTIVE", "the quote no longer governs checkout (superseded or withdrawn)"),
    outcome("COMMAND", "PRECONDITION_FAILED", "QUOTE_EXPIRED", "the price expired before the capture started (15 \"If the quote expires before provider capture starts, checkout is blocked\")"),
    outcome("COMMAND", "PAYMENT_PENDING", "CAPTURE_IN_PROGRESS", "a capture of this order is in flight under another key; retry with the same key once it settles"),
    outcome("COMMAND", "PAYMENT_UNCERTAIN", "CAPTURE_UNCERTAIN", "a capture of this order may have happened: it is reconciled, never repeated"),
    ...SUBJECT_BLOCKERS,
    DELIVERY_CAPACITY,
    outcome("COMMAND", "CAPABILITY_UNAVAILABLE", "PAYMENT_ROUTE_UNQUALIFIED", "the order's merchant route is no longer qualified"),
    // 15 "Price and source expiry races": the same terms are honored only while the legal treatment remains valid
    outcome("COMMAND", "CAPABILITY_UNAVAILABLE", "FISCAL_ROUTE_UNQUALIFIED", "the quoted fiscal issuer route is no longer qualified"),
    outcome("COMMAND", "PRECONDITION_FAILED", "FISCAL_TREATMENT_UNREVIEWED", "the agency's current fiscal profile no longer carries a reviewed treatment: the capture does not start"),
    outcome("COMMAND", "PRECONDITION_FAILED", "FISCAL_TREATMENT_CHANGED", "the reviewed treatment changed since the quote was priced: a new quote is required before any capture"),
    PROVIDER_SERVICES,
  ],
  // the provider is answered by the ingress alone: once the event is authenticated and recorded the reply is 200 with its inbox
  // disposition, whatever the application of the record later decides (D-ING-B1, D-ING-B2)
  CMD030: [],
  CMD031: [
    NOT_VISIBLE("the project"),
    outcome("COMMAND", "PRECONDITION_FAILED", "NOTHING_TO_REFUND", "the project has no completed capture with a refundable service or tax balance"),
    outcome("COMMAND", "PRECONDITION_FAILED", "REFUND_REQUEST_OPEN", "a request of this capture already awaits review; it is reviewed, not repeated"),
  ],
  CMD032: [
    STALE("refund"),
    outcome("COMMAND", "PRECONDITION_FAILED", "REFUND_NOT_REQUESTED", "the refund is not REQUESTED (already approved, rejected, executing or final)", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "CAPTURE_NOT_REFUNDABLE", "the capture is not COMPLETED (reversed captures already returned the money)"),
    outcome("COMMAND", "PRECONDITION_FAILED", "REFUND_EXCEEDS_REMAINING", "the amounts exceed the reconciled remaining capture, given every committed refund (CMD032 failure)"),
    outcome("COMMAND", "INVALID_REQUEST", "REFUND_COMPONENT_INVALID", "the amounts are empty, or name a component this refund does not carry", { fieldCodes: ["RANGE"] }),
    outcome("COMMAND", "PRECONDITION_FAILED", "REFUND_TAX_INCONSISTENT", "taxCents is not the tax the approved service releases under the sale's reviewed rule, given every committed refund (D-REF-B6)", { fieldCodes: ["RANGE"] }),
    outcome("COMMAND", "NOT_AUTHORIZED", "SELF_APPROVAL_FORBIDDEN", "the approver is the identity that requested the refund (segregation of duties, D-AUTHZ-B2)"),
    outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_MISSING", "authorizationRef names neither an applicable standing policy nor a step-up proof of the approver"),
    outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_STALE", "the approver's step-up is older than the freshness window"),
    outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_NOT_OWNED", "the proof is another identity's"),
    outcome("ASSURANCE", "ASSURANCE_REQUIRED", "POLICY_NOT_APPLICABLE", "the named standing policy does not cover this refund (origin, phase, scope or validity): a policy is referenced, never invented"),
  ],
  CMD033: [
    STALE("refund"),
    outcome("COMMAND", "PRECONDITION_FAILED", "REFUND_NOT_APPROVED", "the refund is not APPROVED (requested, rejected, completed or failed)", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "CAPTURE_NOT_REFUNDABLE", "the capture was reversed: the authorization lapsed and no refund is dispatched"),
    outcome("COMMAND", "PAYMENT_PENDING", "REFUND_IN_PROGRESS", "a submission of this refund is in flight under another key"),
    outcome("COMMAND", "PAYMENT_UNCERTAIN", "REFUND_UNCERTAIN", "a prior submission may have refunded: reconcile it (CMD034) before any new dispatch"),
    PROVIDER_SERVICES,
  ],
  CMD034: [
    outcome("COMMAND", "NOT_FOUND", "EVIDENCE_NOT_FOUND", "observationRef names no stored, authenticated provider observation"),
    outcome("COMMAND", "PRECONDITION_FAILED", "OBSERVATION_SUBJECT_MISMATCH", "the observation is about another order, provider or environment"),
  ],
});

// --- route catalogues ---------------------------------------------------------------------------------------------------------

const { EVERY_ROUTE, PATH_IDS, TENANT, AGENCY_HEADER, EVERY_READ, TENANT_READ, NO_QUERY } = ROUTE_OUTCOME_FRAGMENTS;

/** A person's identity outcomes: a service identity is not a person, so its route answers SERVICE_ACCESS instead. */
const PERSON_ONLY = new Set(["AUTHENTICATION_REQUIRED/-", "AUTHENTICATION_REQUIRED/SUBJECT_UNAUTHENTICATED", "NOT_AUTHORIZED/IDENTITY_DISABLED", "NOT_AUTHORIZED/IDENTITY_UNVERIFIED"]);
const keyOf = (o: ProblemOutcome): string => `${o.code}/${o.reason ?? "-"}`;

function compose(route: string, ...parts: ReadonlyArray<ReadonlyArray<ProblemOutcome>>): ReadonlyArray<ProblemOutcome> {
  const entries = parts.flat();
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(keyOf(e))) throw new TypeError(`${route}: the outcome ${keyOf(e)} is listed twice`);
    seen.add(keyOf(e));
  }
  return Object.freeze(entries);
}

const tenantCommand = (id: CommerceCommandId) => compose(id, EVERY_ROUTE, PATH_IDS, TENANT, AGENCY_HEADER, COMMAND_SPECIFIC[id]);
const operatorCommand = (id: CommerceCommandId) => compose(id, EVERY_ROUTE, PATH_IDS, OPERATOR_ACCESS, COMMAND_SPECIFIC[id]);
const serviceCommand = (id: CommerceCommandId) => compose(id, EVERY_ROUTE.filter((o) => !PERSON_ONLY.has(keyOf(o))), PATH_IDS, SERVICE_ACCESS, COMMAND_SPECIFIC[id]);
/** The webhook: the envelope's transport and the platform's own outcomes, the provider's admission and authentication; no key, no person. */
const providerCommand = (id: CommerceCommandId) =>
  compose(id, EVERY_ROUTE.filter((o) => o.layer === "TRANSPORT"), PROVIDER_ACCESS, EVERY_ROUTE.filter((o) => o.layer === "PLATFORM"), COMMAND_SPECIFIC[id]);

/** The closed problem catalogue of each B09 command route. */
export const COMMERCE_COMMAND_OUTCOMES: Readonly<Record<CommerceCommandId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  CMD028: tenantCommand("CMD028"),
  CMD029: tenantCommand("CMD029"),
  CMD030: providerCommand("CMD030"),
  CMD031: tenantCommand("CMD031"),
  CMD032: operatorCommand("CMD032"),
  CMD033: serviceCommand("CMD033"),
  CMD034: serviceCommand("CMD034"),
});

/** The closed problem catalogue of each B09 read route. */
export const COMMERCE_READ_OUTCOMES: Readonly<Record<CommerceReadOperationId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  GetQuote: compose("GetQuote", EVERY_READ, PATH_IDS, TENANT_READ, AGENCY_HEADER, NO_QUERY, [NOT_VISIBLE("the quote")]),
  GetPaymentOrder: compose("GetPaymentOrder", EVERY_READ, PATH_IDS, TENANT_READ, AGENCY_HEADER, NO_QUERY, [NOT_VISIBLE("the payment order")]),
  GetRefund: compose("GetRefund", EVERY_READ, PATH_IDS, TENANT_READ, AGENCY_HEADER, NO_QUERY, [NOT_VISIBLE("the refund")]),
  GetRefundReview: compose("GetRefundReview", EVERY_READ, PATH_IDS, NO_QUERY, OPERATOR_ACCESS),
});
