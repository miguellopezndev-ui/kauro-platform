/**
 * Refund arithmetic and authority (15 "Refund policy and calculation": a customer request is recorded with project, reason,
 * requested scope and current processing/delivery state and is not itself permission for a provider transfer; a partial refund
 * names the affected service component and allocates tax consistently; the total refunded cannot exceed the confirmed
 * captured amount minus earlier refunds and relevant reversals. CMD032 failure: "a standing authorized policy must be
 * referenced rather than invented". R2-081: many partial refunds end at exactly zero remaining basis.)
 *
 * A capture has three refundable components: its allocated service, its allocated tax and its excess over the obligation. The
 * remaining balance of each is `allocated - committed`, where approved, in-flight and completed refunds commit (the database
 * keeps the same counters under the capture row lock, kauro.maintain_capture_refunds, KA010).
 */
import { DomainFailure } from "../model/errors.js";
import { instantMs } from "../model/fields.js";
import { canonicalBytes, rawDigest, type Sha256Hex, type UtcInstant } from "@kauro/contracts";
import { assertMoney, formatMoney } from "./money.js";
import type { CaptureFactRecord, DeliveryPhase, RefundAuthorizationKind, RefundComponents, RefundOrigin, RefundPolicyRecord } from "./records.js";

/** Closed refund reason vocabulary (CMD031 reasonCode; a token, never free text that could carry customer data). */
export const REFUND_REASON_CODES = [
  "CUSTOMER_CANCELLATION_BEFORE_PROCESSING",
  "UNREMEDIED_KAURO_DEFECT",
  "SOURCE_UNAVAILABLE_RECOVERY_DECLINED",
  "SCOPE_NOT_DELIVERABLE",
  "DUPLICATE_PAYMENT",
  "EXCESS_CAPTURE",
  "OTHER_REVIEWED",
] as const;
export type RefundReasonCode = (typeof REFUND_REASON_CODES)[number];

export function isRefundReasonCode(v: unknown): v is RefundReasonCode {
  return typeof v === "string" && (REFUND_REASON_CODES as ReadonlyArray<string>).includes(v);
}

export const ZERO_COMPONENTS: RefundComponents = Object.freeze({ serviceCents: 0n, taxCents: 0n, excessCents: 0n });

export function componentsTotal(c: RefundComponents): bigint {
  return assertMoney(c.serviceCents + c.taxCents + c.excessCents);
}

/** What can still be refunded from a capture; nothing when the capture is not COMPLETED (pending, denied or reversed). */
export function refundableBalance(capture: Pick<CaptureFactRecord, "status" | "allocatedServiceCents" | "allocatedTaxCents" | "excessCents" | "refundedServiceCents" | "refundedTaxCents" | "refundedExcessCents">): RefundComponents {
  if (capture.status !== "COMPLETED") return ZERO_COMPONENTS;
  return {
    serviceCents: assertMoney(capture.allocatedServiceCents - capture.refundedServiceCents),
    taxCents: assertMoney(capture.allocatedTaxCents - capture.refundedTaxCents),
    excessCents: assertMoney(capture.excessCents - capture.refundedExcessCents),
  };
}

/**
 * The server's proposal a request records for review (CMD031 "possible service/tax allocation is visible but not
 * self-approved"): the whole remaining service with its remaining tax for a customer request or a remedy; only the excess for
 * an excess return (R2-140). The approver decides the amounts (CMD032); the proposal is never an authorization.
 */
export function proposeRefund(origin: RefundOrigin, balance: RefundComponents): RefundComponents {
  return origin === "EXCESS_CAPTURE"
    ? { serviceCents: 0n, taxCents: 0n, excessCents: balance.excessCents }
    : { serviceCents: balance.serviceCents, taxCents: balance.taxCents, excessCents: 0n };
}

export type RefundAmountCheck =
  | { readonly kind: "OK" }
  | { readonly kind: "EMPTY" }
  | { readonly kind: "WRONG_COMPONENT" }
  | { readonly kind: "EXCEEDS"; readonly fields: ReadonlyArray<"serviceCents" | "taxCents" | "excessCents"> };

/** CMD032 "The total cannot exceed reconciled remaining capture": per component, and an excess return carries only excess. */
export function checkRefundAmounts(origin: RefundOrigin, balance: RefundComponents, requested: RefundComponents): RefundAmountCheck {
  if (componentsTotal(requested) === 0n) return { kind: "EMPTY" };
  if (origin === "EXCESS_CAPTURE" ? requested.serviceCents !== 0n || requested.taxCents !== 0n : requested.excessCents !== 0n) return { kind: "WRONG_COMPONENT" };
  const fields: Array<"serviceCents" | "taxCents" | "excessCents"> = [];
  if (requested.serviceCents > balance.serviceCents) fields.push("serviceCents");
  if (requested.taxCents > balance.taxCents) fields.push("taxCents");
  if (requested.excessCents > balance.excessCents) fields.push("excessCents");
  return fields.length > 0 ? { kind: "EXCEEDS", fields } : { kind: "OK" };
}

/**
 * Whether a standing policy covers the refund in front of the approver (D-REF-B4): it must be ACTIVE and valid at the
 * approval instant, apply to the delivery phase, and its scope must match the amounts — FULL_REMAINING only for the whole
 * remaining service and tax, EXCESS_ONLY only for an excess return, BOUNDED only up to its ceiling. Anything else is not
 * covered; the approver then needs a fresh step-up.
 */
export function policyCovers(policy: RefundPolicyRecord, input: { readonly at: UtcInstant; readonly origin: RefundOrigin; readonly phase: DeliveryPhase; readonly balance: RefundComponents; readonly requested: RefundComponents }): boolean {
  const at = instantMs(input.at);
  if (policy.state !== "ACTIVE" || instantMs(policy.validFrom) > at || (policy.validUntil !== undefined && instantMs(policy.validUntil) <= at)) return false;
  if (policy.appliesToPhase === "PRE_EXECUTION" && input.phase !== "PRE_EXECUTION") return false;
  switch (policy.refundScope) {
    case "FULL_REMAINING":
      return input.origin !== "EXCESS_CAPTURE" && input.requested.serviceCents === input.balance.serviceCents && input.requested.taxCents === input.balance.taxCents && input.requested.excessCents === 0n;
    case "EXCESS_ONLY":
      return input.origin === "EXCESS_CAPTURE" && input.requested.serviceCents === 0n && input.requested.taxCents === 0n;
    case "BOUNDED":
      return policy.maxRefundCents !== undefined && componentsTotal(input.requested) <= policy.maxRefundCents;
  }
}

/** Refund.authorizationHash under the platform domain KAURO_REFUND_AUTHORIZATION_V1 (the named preimage of the approval). */
export const REFUND_AUTHORIZATION_DOMAIN = "KAURO_REFUND_AUTHORIZATION_V1";
/** The prepared commission/fiscal effects of an approval (CMD032 precondition) under KAURO_REFUND_EFFECTS_V1. */
export const REFUND_EFFECTS_DOMAIN = "KAURO_REFUND_EFFECTS_V1";

export interface RefundEffects {
  readonly refundId: string;
  readonly captureId: string;
  readonly termsHash: Sha256Hex;
  readonly deliveryPhase: DeliveryPhase;
  /** A credit note is required when a service or tax component is refunded (an excess return needs none). */
  readonly creditNoteRequired: boolean;
  /** Service basis of the capture after this refund (commission recomputes cumulatively from it; 17). */
  readonly serviceBasisAfterCents: string;
  /** True when the refund leaves no service basis and the authorization must be revoked. */
  readonly revokesAuthorization: boolean;
}

export function refundEffectsHash(e: RefundEffects): Sha256Hex {
  return rawDigest(canonicalBytes({ domain: REFUND_EFFECTS_DOMAIN, version: 1, payload: e }));
}

export interface RefundAuthorizationPreimage {
  readonly refundId: string;
  readonly agencyId: string;
  readonly captureId: string;
  readonly serviceCents: string;
  readonly taxCents: string;
  readonly excessCents: string;
  readonly reasonCode: string;
  readonly authorizationKind: RefundAuthorizationKind;
  /** The assurance proof id (OWNER_STEP_UP) or the refund policy id (STANDING_POLICY). */
  readonly authorizationRef: string;
  readonly approvedByUserId: string;
  readonly approvedAt: UtcInstant;
  readonly effectsHash: Sha256Hex;
}

export function refundAuthorizationHash(p: RefundAuthorizationPreimage): Sha256Hex {
  return rawDigest(canonicalBytes({ domain: REFUND_AUTHORIZATION_DOMAIN, version: 1, payload: p }));
}

export function authorizationPreimageMoney(c: RefundComponents): Pick<RefundAuthorizationPreimage, "serviceCents" | "taxCents" | "excessCents"> {
  return { serviceCents: formatMoney(c.serviceCents), taxCents: formatMoney(c.taxCents), excessCents: formatMoney(c.excessCents) };
}

/** Raises the failure CMD032 answers for an amount check that is not OK. */
export function refundAmountFailure(check: Exclude<RefundAmountCheck, { kind: "OK" }>): DomainFailure {
  switch (check.kind) {
    case "EMPTY":
      return new DomainFailure("INVALID_REQUEST", "a refund authorizes a positive amount", { fields: [{ field: "serviceCents", code: "RANGE" }, { field: "taxCents", code: "RANGE" }] });
    case "WRONG_COMPONENT":
      return new DomainFailure("INVALID_REQUEST", "the amounts name a component this refund does not carry", { fields: [{ field: "serviceCents", code: "RANGE" }] });
    case "EXCEEDS":
      return new DomainFailure("PRECONDITION_FAILED", "the refund exceeds the reconciled remaining capture", { reason: "REFUND_EXCEEDS_REMAINING" });
  }
}
