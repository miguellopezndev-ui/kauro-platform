/**
 * The normalized provider vocabulary (10 "Provider adapter contract": each adapter implements prepare, dispatch, observe,
 * reconcile and classify; prepared intent is durable before a potentially billable dispatch; provider-specific ids are
 * namespaced by environment and account; timeout, connection reset, rejected request, accepted-but-pending response, unknown
 * status and confirmed terminal state are distinct; unknown statuses are never coerced to success or failure).
 *
 * The domain never sees a vendor payload: an adapter (payment processor, fiscal authority) classifies what it received into
 * these closed shapes, and an unknown status arrives as UNRECOGNIZED (15 "Unknown provider statuses become
 * UNRECOGNIZED_PROVIDER_STATE and block consequential assumptions").
 */
import { DOMAINS, canonicalBytes, rawDigest, structuredDigest, type CanonicalValue, type Sha256Hex, type UtcInstant } from "@kauro/contracts";
import type { BankAccountRef, BankCreditId, BankCreditStatus, BankRail, CaptureStatus, FundsState, ObservedBankRail, PaymentEnvironment, ProviderExceptionKind, ScopeKind } from "./records.js";

/** The provider exception vocabulary, in the order of migration 0016 provider_event_exceptions.kind (the persistence test proves it equal). */
export const PROVIDER_EXCEPTION_KINDS: ReadonlyArray<ProviderExceptionKind> = Object.freeze([
  "UNKNOWN_PROVIDER_REFERENCE",
  "WRONG_PROVIDER",
  "WRONG_ORDER",
  "WRONG_PAYEE",
  "WRONG_CURRENCY",
  "WRONG_ENVIRONMENT",
  "UNRECOGNIZED_PROVIDER_STATE",
  "BODY_CONFLICT",
]);

/** What a dispatch or an observation proved (10: "which observations can prove no effect, which prove an effect and which remain uncertain"). */
export type ProviderOutcomeKind = "COMPLETED" | "PENDING" | "PROVED_NO_EFFECT" | "AMBIGUOUS" | "UNRECOGNIZED";

/** Safe classification of an ambiguous transport result; never "no effect". */
export type AmbiguityReason = "TIMEOUT" | "CONNECTION_RESET" | "PROVIDER_5XX" | "UNREADABLE_RESPONSE" | "OBSERVATION_LOST";

/**
 * The exact normalized request an attempt is allowed to send (reference/HASHING "Provider request hash: complete actual
 * method/endpoint-profile/body/semantically relevant headers after minimization, excluding secrets by explicit credential
 * reference"; excluded: retry counters and transport timing). Its digest is PaymentAttempt.requestHash.
 */
export interface ProviderRequest {
  readonly method: "POST" | "GET";
  /** A versioned endpoint profile of the adapter, e.g. ORDERS_V2_CREATE, ORDERS_V2_CAPTURE, CAPTURES_V2_REFUND. */
  readonly endpointProfile: string;
  readonly body: CanonicalValue;
  /** Semantically relevant headers only, e.g. the provider idempotency key; never a credential value. */
  readonly headers: Readonly<Record<string, string>>;
  /** The name/version of the credential in the secret manager (08 "Secrets and supply chain"), never its value. */
  readonly credentialRef: string;
}

export function providerRequestHash(request: ProviderRequest): Sha256Hex {
  return structuredDigest(DOMAINS.PROVIDER_REQUEST, 1, request);
}

/**
 * The provider idempotency/request identity of an attempt (sent as the provider's idempotency header where the endpoint
 * documents one; 15 "Provider idempotency support is used only where documented for the exact endpoint; local idempotency
 * remains necessary"). Deterministic from the attempt: a retry of the same attempt can only ever repeat the same request.
 */
export function providerRequestIdOf(attemptId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(attemptId)) throw new TypeError("an attempt id is a UUIDv7");
  return `kauro-${attemptId}`;
}

/**
 * The furthest a dispatched attempt's deadline may lie ahead of its claim (D-PROTO-B4, D-PROTO-B6; B09-N7): the bounded call's
 * timeout plus the watchdog's margin (@kauro/application commerce/protocol DISPATCH_TIMEOUT_SECONDS + DISPATCH_WATCHDOG_MARGIN_SECONDS,
 * proven equal by the application test). The claim edge PREPARED → DISPATCHING is refused by the database when the deadline it
 * records is not in the future or lies further ahead than this (migration 0015 payment_attempts_dispatch_deadline_bound), so the
 * role that claims an attempt cannot keep it out of the watchdog's due set.
 */
export const DISPATCH_DEADLINE_SECONDS = 60;

/** The scope-index key of a provider identity: `<provider>|<ENVIRONMENT>|<external id>` (migration 0013 commerce_scopes). */
export function providerScopeKey(provider: string, environment: PaymentEnvironment, externalId: string): string {
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(provider)) throw new TypeError("provider label");
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(externalId)) throw new TypeError("provider external identity");
  return `${provider}|${environment}|${externalId}`;
}

export interface ScopeKey {
  readonly kind: ScopeKind;
  readonly key: string;
}

/** A capture as an adapter observed it (authenticated response, verified webhook or query), already normalized. */
export interface ObservedCapture {
  readonly provider: string;
  readonly environment: PaymentEnvironment;
  readonly providerOrderId: string | null;
  readonly providerCaptureId: string;
  readonly status: CaptureStatus;
  readonly amountCents: bigint;
  /** ISO 4217 as observed; a currency other than the order's is a mismatch, never converted. */
  readonly currency: string;
  readonly payeeDigest: Sha256Hex;
  readonly providerCompletedAt: UtcInstant | null;
  readonly fundsState: FundsState;
  /** The fee the provider reported for this capture, when it did. */
  readonly feeCents: bigint | null;
  readonly evidenceHash: Sha256Hex;
}

/** A refund as an adapter observed it. */
export interface ObservedRefund {
  readonly provider: string;
  readonly environment: PaymentEnvironment;
  readonly providerCaptureId: string;
  readonly providerRefundId: string;
  /**
   * The platform's own refund reference the provider's refund resource names — the refund id the platform's refund request carried
   * (PayPal `invoice_id`), part of the exact request whose digest is the attempt's request hash — or null for a refund whose resource
   * names none (one made outside the platform). With the provider refund id and the attempt's own dispatch response it is the only
   * evidence that binds a provider refund to a local refund: an amount is never an identity (B09-R1).
   */
  readonly platformRefundRef: string | null;
  readonly status: "COMPLETED" | "PENDING" | "FAILED";
  readonly amountCents: bigint;
  readonly currency: string;
  readonly evidenceHash: Sha256Hex;
}

/** A dispute as an adapter observed it: the provider's case identity, the disputed amount and the provider's hold. */
export interface ObservedDispute {
  readonly provider: string;
  readonly environment: PaymentEnvironment;
  readonly providerCaptureId: string;
  readonly providerDisputeId: string;
  readonly status: "OPEN" | "CLOSED_WON";
  readonly amountCents: bigint;
  readonly currency: string;
  /** A server token of the provider's reason category; never provider prose. */
  readonly reasonCode: string;
  readonly responseDueAt: UtcInstant | null;
  readonly evidenceHash: Sha256Hex;
}

export type NormalizedProviderEventKind =
  | "ORDER_APPROVED"
  | "ORDER_VOIDED"
  | "CAPTURE_COMPLETED"
  | "CAPTURE_PENDING"
  | "CAPTURE_DENIED"
  | "CAPTURE_REVERSED"
  | "REFUND_COMPLETED"
  | "REFUND_PENDING"
  | "REFUND_FAILED"
  /**
   * A dispute (chargeback claim) opened on a capture: the provider holds the disputed funds; the capture stays COMPLETED and its
   * entitlement live until the provider actually reverses it (CAPTURE_REVERSED); the reconciler opens a DISPUTE_OPEN case with the
   * amount and records the funds HELD (D-DISPUTE-B1). The dispute workflow itself — deadlines, evidence, response — is the
   * integration package's (B15; Q-B09-17).
   */
  | "DISPUTE_OPENED"
  /** A dispute closed in the merchant's favor: the funds are released (a loss arrives as CAPTURE_REVERSED). */
  | "DISPUTE_CLOSED"
  | "UNRECOGNIZED";

/** A verified provider event after classification (the webhook row of CMD030 is this normalized form, not the vendor schema). */
export interface NormalizedProviderEvent {
  readonly kind: NormalizedProviderEventKind;
  readonly provider: string;
  readonly environment: PaymentEnvironment;
  readonly externalEventId: string;
  readonly providerOrderId?: string;
  readonly capture?: ObservedCapture;
  readonly refund?: ObservedRefund;
  readonly dispute?: ObservedDispute;
  /** Provider chronology of the event (never used to roll a fact back). */
  readonly providerEventAt?: UtcInstant;
  /** SHA-256 of the exact authenticated raw body (InboxRecord.bodyHash). */
  readonly bodyHash: Sha256Hex;
}

/** PaymentOrder.idempotencyHash: the intent binding (same key, other payload conflicts). Platform domain KAURO_PAYMENT_INTENT_V1. */
export const PAYMENT_INTENT_DOMAIN = "KAURO_PAYMENT_INTENT_V1";

export interface PaymentIntentPreimage {
  readonly quoteId: string;
  readonly termsHash: Sha256Hex;
  readonly expectedAmountCents: string;
  readonly currency: "USD";
  readonly routeId: string;
  readonly provider: string;
  readonly environment: PaymentEnvironment;
}

export function paymentIntentHash(p: PaymentIntentPreimage): Sha256Hex {
  return rawDigest(canonicalBytes({ domain: PAYMENT_INTENT_DOMAIN, version: 1, payload: p }));
}

// --- bank evidence vocabulary (Payments V1, ACH-ROUTE D-ACH-15, §6.1; DV1-01: provider-neutral) -------------------------------------------
//
// Normalized shapes a bank-evidence classifier produces from authenticated, hash-verified stored bytes. A field the bytes do not show is
// null, never inferred (ACH-R7-03, K-8). The vendor payload, its field names and statement formats live only in the adapter package.

/** The opaque locator of an artifact and its expected digest; never classifier input (the bytes come from the restricted store). */
export interface BankEvidenceRef {
  readonly evidenceHash: Sha256Hex;
  readonly artifactRef: string;
}

/** The result of the pure classification of stored bytes: only CLASSIFIED permits comparison and a later effect (fail closed). */
export const EVIDENCE_REJECTION_CODES = ["UNKNOWN_EVIDENCE", "MALFORMED_EVIDENCE", "HASH_MISMATCH", "UNAUTHENTICATED_EVIDENCE"] as const;
export type EvidenceRejectionCode = (typeof EVIDENCE_REJECTION_CODES)[number];
export type EvidenceClassification<T> =
  | { readonly kind: "CLASSIFIED"; readonly value: T }
  | { readonly kind: "REJECTED"; readonly code: EvidenceRejectionCode };

/** The safe operational condition of exactly one refused request (never evidence of a money effect, never an AmbiguityReason). */
export const OPERATIONAL_CODES = ["AUTH_FAILED", "PERMISSION_DENIED", "SCA_REQUIRED", "RATE_LIMITED", "CAPABILITY_UNAVAILABLE", "VALIDATION_REJECTED"] as const;
export type OperationalCode = (typeof OPERATIONAL_CODES)[number];
export interface Operational {
  readonly code: OperationalCode;
  readonly requestHash: Sha256Hex;
  readonly retryAfterSeconds?: number;
}

/** What one port read returned. COMPLETED means conclusive port evidence: the inner status still decides whether money completed. */
export type BankOutcome<T> =
  | ({ readonly kind: "COMPLETED"; readonly value: T } & BankEvidenceRef)
  | ({ readonly kind: "PENDING"; readonly retryAfterSeconds?: number } & BankEvidenceRef)
  | ({ readonly kind: "PROVED_NO_EFFECT"; readonly outcomeCode: string; readonly absenceIsProof: true } & BankEvidenceRef)
  | { readonly kind: "AMBIGUOUS"; readonly reason: AmbiguityReason }
  | ({ readonly kind: "UNRECOGNIZED"; readonly safeStatusCode: string } & BankEvidenceRef)
  /** The provider refused this read; dispatch refusals are Phase 2. */
  | { readonly kind: "REFUSED"; readonly operational: Operational };

/** The receiving account's details as verified (restricted instruction data: never telemetry, logs or events). */
export interface UsdBankAccountDetails {
  readonly accountRef: BankAccountRef;
  readonly detailsVersion: string;
  readonly currency: "USD";
  readonly acceptedRails: ReadonlyArray<BankRail>;
  readonly payeeDigest: Sha256Hex;
  readonly beneficiaryName: string;
  readonly bankName: string;
  readonly routingNumber: string;
  readonly accountNumber: string;
  readonly accountType: "CHECKING" | "SAVINGS";
  readonly additionalFields: Readonly<Record<string, string>>;
  readonly verifiedAt: UtcInstant;
}

export interface IncomingCredit extends BankEvidenceRef {
  readonly accountRef: BankAccountRef;
  readonly creditId: BankCreditId;
  readonly environment: PaymentEnvironment;
  readonly rail: ObservedBankRail;
  /** Observed, not silently constrained to USD. */
  readonly currency: string;
  /** null blocks exact-payment application. */
  readonly grossCents: bigint | null;
  readonly netCents: bigint | null;
  /** Unknown is null, never zero; an explicit observed zero is valid. */
  readonly feeCents: bigint | null;
  readonly payeeDigest: Sha256Hex;
  readonly reference: string | null;
  readonly payerDigest: Sha256Hex | null;
  readonly payerEvidenceRef: string | null;
  readonly status: BankCreditStatus;
  /** D-ACH-18 principal of a return of this credit. */
  readonly reversedCents: bigint | null;
  readonly fundsState: FundsState;
  readonly bookedAt: UtcInstant | null;
  readonly observedAt: UtcInstant;
}

export interface CreditPage {
  readonly credits: ReadonlyArray<IncomingCredit>;
  readonly nextCursor: string;
  readonly complete: boolean;
  readonly coverageStart: UtcInstant;
  readonly coverageEnd: UtcInstant;
}

/**
 * The destination fields as the evidence shows them; null when absent. `full` is restricted: never persisted in clear, logged or put in
 * an event; the application keys it into the destination fingerprint in memory and discards it (DV1-10).
 */
export interface DestinationEvidence {
  readonly accountDigest: Sha256Hex | null;
  readonly accountLast4: string | null;
  readonly routingDigest: Sha256Hex | null;
  readonly full: { readonly routingNumber: string; readonly accountNumber: string; readonly holderName: string } | null;
  readonly recipientRef: string | null;
  readonly recipientVersion: string | null;
}

export const OUTBOUND_EVIDENCE_STATUSES = ["SENT", "COMPLETED", "BOUNCED", "CANCELLED", "UNRECOGNIZED"] as const;
/** A classified manual execution artifact, e.g. a send receipt (D-ACH-21, DV1-08). */
export interface OutboundEvidence extends BankEvidenceRef {
  readonly bankExecutionId: string;
  readonly accountRef: BankAccountRef;
  readonly destination: DestinationEvidence;
  /** As the provider shows it, never repaired. */
  readonly reference: string | null;
  readonly executedAt: UtcInstant | null;
  readonly amountCents: bigint;
  readonly currency: string;
  readonly feeCents: bigint | null;
  readonly status: (typeof OUTBOUND_EVIDENCE_STATUSES)[number];
  readonly returnedCents: bigint | null;
  readonly observedAt: UtcInstant;
}

export const STATEMENT_DEBIT_STATUSES = ["SENT", "COMPLETED", "RETURNED", "UNRECOGNIZED"] as const;
/** An outgoing line on the route's balance. */
export interface StatementDebit extends BankEvidenceRef {
  readonly accountRef: BankAccountRef;
  /** The statement-line identity, stable. */
  readonly debitId: string;
  /** null when the line carries none: an unrecorded debit by definition. */
  readonly bankExecutionId: string | null;
  readonly amountCents: bigint;
  readonly currency: string;
  readonly feeCents: bigint | null;
  readonly destination: DestinationEvidence;
  readonly reference: string | null;
  readonly executedAt: UtcInstant | null;
  readonly status: (typeof STATEMENT_DEBIT_STATUSES)[number];
  readonly returnedCents: bigint | null;
  readonly bookedAt: UtcInstant | null;
  readonly observedAt: UtcInstant;
}

export interface DebitPage {
  readonly debits: ReadonlyArray<StatementDebit>;
  readonly nextCursor: string;
  readonly complete: boolean;
  readonly coverageStart: UtcInstant;
  readonly coverageEnd: UtcInstant;
}

/** One owner-imported statement artifact, classified (SI1). */
export interface StatementPage extends BankEvidenceRef {
  readonly accountRef: BankAccountRef;
  readonly coverageStart: UtcInstant;
  readonly coverageEnd: UtcInstant;
  readonly credits: ReadonlyArray<IncomingCredit>;
  readonly debits: ReadonlyArray<StatementDebit>;
}

/**
 * The provider's settlement record of the route account for a period (ST1, PV1-SETTLE D-SET-2; R2 15 "Settlement and withdrawal"):
 * the period's gross, the withdrawal's fee, the balance held at its end, and the withdrawal it released to the bank. `withdrawalId`
 * is the withdrawal's statement-line identity on the route account (the debit a later NX check finds explained by the settlement).
 */
export interface SettlementEvidence extends BankEvidenceRef {
  readonly accountRef: BankAccountRef;
  readonly currency: string;
  readonly periodStart: UtcInstant;
  readonly periodEnd: UtcInstant;
  readonly withdrawalId: string;
  readonly grossCents: bigint;
  readonly feeCents: bigint;
  readonly heldCents: bigint;
  readonly withdrawnCents: bigint;
  readonly observedAt: UtcInstant;
}

/** The receiving bank's own record of a withdrawal's arrival (ST1, D-SET-2): the only source of bank-available money (D-LEDGER-B5). */
export interface BankReceiptEvidence extends BankEvidenceRef {
  /** The receiving account as the bank shows it (never the route account). */
  readonly accountRef: string;
  /** The provider withdrawal this receipt cites. */
  readonly withdrawalId: string;
  readonly bankTransactionId: string;
  readonly currency: string;
  readonly receivedCents: bigint;
  /** The receiving account's available balance after the receipt, as the bank shows it. */
  readonly bankAvailableCents: bigint;
  readonly bookedAt: UtcInstant;
  readonly observedAt: UtcInstant;
}
