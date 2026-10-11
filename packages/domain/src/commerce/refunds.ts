/**
 * Refund arithmetic and authority (15 "Refund policy and calculation": a customer request is recorded with project, reason,
 * requested scope and current processing/delivery state and is not itself permission for a provider transfer; a partial refund
 * names the affected service component and allocates tax consistently; the total refunded cannot exceed the confirmed captured
 * amount minus earlier refunds and relevant reversals; concurrent refund requests serialize that invariant. CMD032 failure: "a
 * standing authorized policy must be referenced rather than invented". R2-081: many partial refunds end at exactly zero
 * remaining basis.)
 *
 * A capture has three refundable components: its allocated service, its allocated tax and its excess over the obligation. The
 * remaining balance of each is `allocated - committed`, where the refunds that are APPROVED, SUBMITTING, UNCERTAIN or COMPLETED
 * commit (D-REF-B3). The database keeps the same invariant under the capture's commitment lock (migration 0016,
 * kauro.refunds_commitment_ceiling, SQLSTATE KP003), so two approvals of one capture serialize and the second one sees the first.
 *
 * The refund's reasonCode is the registry `label` of CMD031 (customer text; B06 D-API-1): nothing here branches on it. What a
 * refund is — a customer request, an excess return, Kauro's own remedy — is its server-recorded origin, and whether a standing
 * policy covers it is decided by facts (origin, delivery phase, amounts), never by the words of the reason.
 */
import { canonicalBytes, rawDigest, type Sha256Hex, type UtcInstant } from "@kauro/contracts";
import { DomainFailure } from "../model/errors.js";
import { instantMs } from "../model/fields.js";
import { assertMoney, formatMoney, roundHalfUpBps } from "./money.js";
import type { CaptureFactRecord, DeliveryPhase, RefundAuthorizationKind, RefundComponents, RefundOrigin, RefundPolicyRecord, RefundState, TaxRuleSnapshot } from "./records.js";

export const ZERO_COMPONENTS: RefundComponents = Object.freeze({ serviceCents: 0n, taxCents: 0n, excessCents: 0n });

/** The refund states that commit their approved components against the capture (D-REF-B3). */
export const COMMITTING_REFUND_STATES: ReadonlySet<RefundState> = new Set<RefundState>(["APPROVED", "SUBMITTING", "UNCERTAIN", "COMPLETED"]);

export function componentsTotal(c: RefundComponents): bigint {
  return assertMoney(c.serviceCents + c.taxCents + c.excessCents);
}

export function addComponents(a: RefundComponents, b: RefundComponents): RefundComponents {
  return { serviceCents: assertMoney(a.serviceCents + b.serviceCents), taxCents: assertMoney(a.taxCents + b.taxCents), excessCents: assertMoney(a.excessCents + b.excessCents) };
}

/**
 * What can still be refunded from a capture, given what the refunds of that capture already commit; nothing when the capture
 * is not COMPLETED (pending, denied or reversed: a reversed capture's money already went back through the chargeback).
 */
export function refundableBalance(capture: Pick<CaptureFactRecord, "status" | "allocation">, committed: RefundComponents): RefundComponents {
  if (capture.status !== "COMPLETED") return ZERO_COMPONENTS;
  return {
    serviceCents: assertMoney(capture.allocation.serviceCents - committed.serviceCents),
    taxCents: assertMoney(capture.allocation.taxCents - committed.taxCents),
    excessCents: assertMoney(capture.allocation.excessCents - committed.excessCents),
  };
}

/**
 * The server's proposal a request records for review (CMD031 "possible service/tax allocation is visible but not
 * self-approved"): the whole remaining service with its remaining tax for a customer request or a remedy; only the excess for
 * an excess return (R2-140). The approver decides the amounts (CMD032); the proposal is never an authorization.
 */
export function proposeRefund(origin: RefundOrigin, balance: RefundComponents): RefundComponents {
  // the whole remaining service releases the whole remaining tax, which is exactly what D-REF-B6 derives for it
  return origin === "EXCESS_CAPTURE"
    ? { serviceCents: 0n, taxCents: 0n, excessCents: balance.excessCents }
    : { serviceCents: balance.serviceCents, taxCents: balance.taxCents, excessCents: 0n };
}

/**
 * The amounts an approval authorizes from the two money members of CMD032 (serviceCents, taxCents): a service refund authorizes
 * exactly them; an excess return (R2-140) names zero service and zero tax and authorizes the excess the reconciler recorded in
 * the request — the catalogue's fields name the service/tax split, and an excess is neither (D-REF-B2).
 */
export function approvedComponents(origin: RefundOrigin, proposed: RefundComponents, requested: { readonly serviceCents: bigint; readonly taxCents: bigint }): RefundComponents {
  if (origin === "EXCESS_CAPTURE") return { serviceCents: requested.serviceCents, taxCents: requested.taxCents, excessCents: proposed.excessCents };
  return { serviceCents: requested.serviceCents, taxCents: requested.taxCents, excessCents: 0n };
}

export type RefundAmountCheck =
  | { readonly kind: "OK" }
  | { readonly kind: "EMPTY" }
  | { readonly kind: "WRONG_COMPONENT" }
  | { readonly kind: "EXCEEDS"; readonly fields: ReadonlyArray<"serviceCents" | "taxCents" | "excessCents"> };

/** CMD032 "The total cannot exceed reconciled remaining capture": per component; an excess return carries only excess. */
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
 * The tax a capture keeps while `basisCents` of its allocated service is not refunded (D-REF-B6; migration 0016
 * kauro.refund_tax_remaining, the same function): the whole collected tax while no service is refunded, nothing once no service
 * basis remains, and in between the sale's reviewed rule applied once to the remaining basis — RATE_HALF_UP floor((B x r + 5000) /
 * 10000), the quote's own rounding; ZERO_REVIEWED zero — never more than the tax the capture collected. 15 "Exact representation
 * and rounding": "A partial refund allocates service and tax components explicitly ... any rounding remainder follows a
 * deterministic rule"; 15 "Refund policy and calculation": "allocates tax consistently"; reference/HASHING: recompute cumulatively
 * from the remaining service basis and take the difference, so a sequence of partial refunds ends at exactly the collected tax.
 */
export function taxRemainingAfter(allocation: Pick<RefundComponents, "serviceCents" | "taxCents">, basisCents: bigint, rule: TaxRuleSnapshot): bigint {
  assertMoney(allocation.serviceCents);
  assertMoney(allocation.taxCents);
  if (basisCents >= allocation.serviceCents) return allocation.taxCents;
  if (basisCents <= 0n || rule.rule === "ZERO_REVIEWED") return 0n;
  const byRule = roundHalfUpBps(basisCents, rule.rateBps);
  return byRule < allocation.taxCents ? byRule : allocation.taxCents;
}

/**
 * The tax component a refund of `serviceCents` carries, given the components the capture's committing refunds already hold: the
 * tax the refunded service releases under the sale's rule, cumulatively (the database re-checks it under the capture's commitment
 * lock, KP012 REFUND_TAX_INCONSISTENT). A proposal (CMD031) and an approval (CMD032) use it; an excess return carries none.
 */
export function refundTaxFor(allocation: RefundComponents, committed: RefundComponents, serviceCents: bigint, rule: TaxRuleSnapshot): bigint {
  const basisAfter = allocation.serviceCents - committed.serviceCents - serviceCents;
  if (basisAfter < 0n) throw new RangeError("the refund exceeds the remaining service basis");
  // B09-TAX-ROUNDING: the tax follows the service refunded; a refund with no service carries none, and a rounding cent a failed booked
  // refund left unreturned stays with the remaining balance until the refund that takes the service it belongs to.
  if (serviceCents === 0n) return 0n;
  return assertMoney(allocation.taxCents - taxRemainingAfter(allocation, basisAfter, rule) - committed.taxCents);
}

export type RefundTaxCheck = { readonly kind: "OK" } | { readonly kind: "TAX_INCONSISTENT"; readonly expectedTaxCents: bigint };

/** CMD032: the approved tax is exactly the tax the approved service releases (D-REF-B6); an excess return names none. */
export function checkRefundTax(allocation: RefundComponents, committed: RefundComponents, requested: RefundComponents, rule: TaxRuleSnapshot): RefundTaxCheck {
  const expected = refundTaxFor(allocation, committed, requested.serviceCents, rule);
  return requested.taxCents === expected ? { kind: "OK" } : { kind: "TAX_INCONSISTENT", expectedTaxCents: expected };
}

/** The failure CMD032 answers for a tax component that does not follow the refunded service (a racing approval can meet it). */
export function refundTaxFailure(): DomainFailure {
  return new DomainFailure("PRECONDITION_FAILED", "the tax component does not follow the refunded service under the sale's reviewed rule", {
    reason: "REFUND_TAX_INCONSISTENT",
    fields: [{ field: "taxCents", code: "RANGE" }],
  });
}

/**
 * Whether a standing policy covers the refund in front of the approver (D-REF-B4): it must be ACTIVE and valid at the approval
 * instant, apply to the refund's origin and delivery phase, and its scope must match the amounts — FULL_REMAINING only for the
 * whole remaining service and tax, EXCESS_ONLY only for an excess return, BOUNDED only up to its ceiling. Anything else is not
 * covered; the approver then needs a fresh step-up of their own (08 "High-impact actions require recent step-up: ... significant
 * refund").
 */
export function policyCovers(policy: RefundPolicyRecord, input: { readonly at: UtcInstant; readonly origin: RefundOrigin; readonly phase: DeliveryPhase; readonly balance: RefundComponents; readonly requested: RefundComponents }): boolean {
  const at = instantMs(input.at);
  if (policy.state !== "ACTIVE" || instantMs(policy.validFrom) > at || (policy.validUntil !== undefined && instantMs(policy.validUntil) <= at)) return false;
  if (policy.appliesToOrigin !== input.origin) return false;
  if (policy.appliesToPhase === "PRE_EXECUTION" && input.phase !== "PRE_EXECUTION" && input.phase !== "NO_AUTHORIZATION") return false;
  switch (policy.refundScope) {
    case "FULL_REMAINING":
      return input.origin !== "EXCESS_CAPTURE" && input.requested.serviceCents === input.balance.serviceCents && input.requested.taxCents === input.balance.taxCents && input.requested.excessCents === 0n;
    case "EXCESS_ONLY":
      return input.origin === "EXCESS_CAPTURE" && input.requested.serviceCents === 0n && input.requested.taxCents === 0n && input.requested.excessCents === input.balance.excessCents;
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
  /** Service basis of the capture after this refund (commission recomputes cumulatively from it; 17; R2-081). */
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
  /** The approved reason: the request's reasonCode (a label; digests may cover labels, payloads never carry them). */
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
      return new DomainFailure("INVALID_REQUEST", "a refund authorizes a positive amount", { reason: "REFUND_COMPONENT_INVALID", fields: [{ field: "serviceCents", code: "RANGE" }, { field: "taxCents", code: "RANGE" }] });
    case "WRONG_COMPONENT":
      return new DomainFailure("INVALID_REQUEST", "the amounts name a component this refund does not carry", { reason: "REFUND_COMPONENT_INVALID", fields: [{ field: "serviceCents", code: "RANGE" }, { field: "taxCents", code: "RANGE" }] });
    case "EXCEEDS":
      return new DomainFailure("PRECONDITION_FAILED", "the refund exceeds the reconciled remaining capture", { reason: "REFUND_EXCEEDS_REMAINING" });
  }
}
