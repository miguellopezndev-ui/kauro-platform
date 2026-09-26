// The domain halves of the fixes to the adversarial review of the B09 design (docs/design/B09-payments-fiscal.md §16 "Critique
// record"): deliverable capacity at checkout (B09-F5), the cumulative refund tax rule (B09-F6), the fiscal profile in force at the tax
// point (B09-F4), the quote's settled and re-bound paths (B09-F2), the capture's later facts as events of their own (B09-F8, B09-F15),
// the exception vocabulary (B09-F9) and the dispute boundary (B09-F14). Each test fails on the design it replaces.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAPTURE_MISMATCHES,
  COMMERCE_EVENT_PAYLOAD_ALLOWLIST,
  COMMERCE_EVENT_SUBSCRIPTIONS,
  COMMERCE_EVENT_TYPES,
  PROVIDER_EXCEPTION_KINDS,
  blockerFailure,
  checkRefundTax,
  checkoutBlockers,
  fundsPostings,
  isBalanced,
  profileInForceAt,
  quoteRelease,
  refundTaxFor,
  replacementBlockers,
  resolveFiscalTreatment,
  roundHalfUpBps,
  taxRemainingAfter,
  type AgencyId,
  type CheckoutFacts,
  type FiscalIssuerRecord,
  type FiscalIssuerRef,
  type FiscalProfileId,
  type FiscalProfileRecord,
  type QuoteId,
  type QuoteReleaseFacts,
  type ReplacementFacts,
  type TaxRuleSnapshot,
  type UserId,
} from "../src/index.js";

const RULE_19: TaxRuleSnapshot = { treatment: "DOMESTIC_TAXABLE", rule: "RATE_HALF_UP", rateBps: 1900 };
const ZERO: TaxRuleSnapshot = { treatment: "EXEMPT_EXPORT", rule: "ZERO_REVIEWED", rateBps: 0 };
const NONE = { serviceCents: 0n, taxCents: 0n, excessCents: 0n };

const profile: FiscalProfileRecord = {
  profileId: "01920000-0000-7000-8000-0000000f0100" as FiscalProfileId,
  agencyId: "01920000-0000-7000-8000-0000000a0001" as AgencyId,
  operatorLegalRef: "01920000-0000-7000-8000-0000000f0001" as FiscalIssuerRef,
  customerLegalRef: "01920000-0000-7000-8000-0000000c0001",
  serviceClassification: "DATA_PREPARATION_SERVICE",
  territory: "CO",
  taxTreatment: "DOMESTIC_TAXABLE",
  taxRule: "RATE_HALF_UP",
  taxRateBps: 1900,
  evidenceHash: "3".repeat(64),
  reviewedByUserId: "6f1b0d2e-3c4a-5b5c-9d6e-7f8091a2b3c4" as UserId,
  validFrom: "2026-09-01T00:00:00.000Z",
};

const issuer: FiscalIssuerRecord = {
  issuerRef: "01920000-0000-7000-8000-0000000f0001" as FiscalIssuerRef,
  jurisdiction: "CO",
  legalIdentityHash: "5".repeat(64),
  legalFactStatus: "PROFESSIONALLY_CONFIRMED",
  routeKind: "PROVIDER_API",
  integrationClass: "CONTRACT_FAKE",
  routeState: "QUALIFIED",
  numberingAuthorizationRef: "DIAN-18764000001",
  entitlementEvidenceHash: "6".repeat(64),
  validFrom: "2026-09-01T00:00:00.000Z",
};

function readyCheckout(overrides: Partial<CheckoutFacts> = {}): CheckoutFacts {
  return {
    now: "2026-09-24T12:00:00.000Z",
    quote: {
      state: "ISSUED",
      expiresAt: "2026-10-08T12:00:00.000Z",
      approvalId: "01920000-0000-7000-8000-00000000ab01" as never,
      planHash: "a".repeat(64),
      revisionHash: "b".repeat(64),
      targetContractHash: "c".repeat(64),
      tax: RULE_19,
    },
    agencyState: "ACTIVE",
    plan: { state: "APPROVED", approvalId: "01920000-0000-7000-8000-00000000ab01" as never, bodyHash: "a".repeat(64) },
    approval: {},
    revision: { state: "SEALED" },
    target: { confirmed: true, superseded: false },
    capability: { state: "AVAILABLE_LIMITED" },
    paymentRoute: { state: "QUALIFIED" },
    fiscalIssuerRoute: { state: "QUALIFIED" },
    fiscalProfile: profile,
    openOrder: null,
    paid: false,
    capacity: { available: true },
    ...overrides,
  };
}

test("B09-F5 (D-CAP-B1): checkout is refused CAPACITY_UNAVAILABLE / DELIVERY_CAPACITY_UNAVAILABLE when the processing admission reports no deliverable capacity or answers nothing", () => {
  assert.deepEqual(checkoutBlockers(readyCheckout()), []);
  assert.deepEqual(checkoutBlockers(readyCheckout({ capacity: { available: false } })), ["DELIVERY_CAPACITY_UNAVAILABLE"]);
  assert.deepEqual(checkoutBlockers(readyCheckout({ capacity: null })), ["DELIVERY_CAPACITY_UNAVAILABLE"]);
  const failure = blockerFailure("DELIVERY_CAPACITY_UNAVAILABLE");
  assert.equal(failure.code, "CAPACITY_UNAVAILABLE");
  assert.equal(failure.details.reason, "DELIVERY_CAPACITY_UNAVAILABLE");
  assert.equal(failure.status, 503);
  assert.equal(failure.retryable, true);
});

test("B09-F6 (D-REF-B6): refunded tax follows refunded service cumulatively at the sale's 19% rule — the one-cent sequence returns exactly the collected tax where per-refund rounding would leave a residue", () => {
  // a 2500-cent service sold at 1900 bps collects floor((2500 x 1900 + 5000) / 10000) = 475 of tax
  const allocation = { serviceCents: 2500n, taxCents: roundHalfUpBps(2500n, 1900), excessCents: 0n };
  assert.equal(allocation.taxCents, 475n);
  let committed = { ...NONE };
  let perRefundRounding = 0n;
  for (let i = 0; i < 2500; i += 1) {
    const tax = refundTaxFor(allocation, committed, 1n, RULE_19);
    assert.deepEqual(checkRefundTax(allocation, committed, { serviceCents: 1n, taxCents: tax, excessCents: 0n }, RULE_19), { kind: "OK" });
    // each step is exactly the difference of the rule applied to the remaining basis before and after it
    const before = allocation.serviceCents - committed.serviceCents;
    assert.equal(tax, taxRemainingAfter(allocation, before, RULE_19) - taxRemainingAfter(allocation, before - 1n, RULE_19));
    perRefundRounding += roundHalfUpBps(1n, 1900);
    committed = { serviceCents: committed.serviceCents + 1n, taxCents: committed.taxCents + tax, excessCents: 0n };
  }
  assert.deepEqual(committed, { serviceCents: 2500n, taxCents: 475n, excessCents: 0n }, "the cumulative refunds end at exactly the collected tax");
  assert.equal(perRefundRounding, 0n, "rounding each one-cent refund on its own would return no tax at all");
  // the approver cannot choose another split: a tax that does not follow the service is refused
  const partial = { serviceCents: 1000n, taxCents: 0n, excessCents: 0n };
  assert.deepEqual(checkRefundTax(allocation, NONE, partial, RULE_19), { kind: "TAX_INCONSISTENT", expectedTaxCents: 190n });
  assert.deepEqual(checkRefundTax(allocation, NONE, { ...partial, taxCents: 190n }, RULE_19), { kind: "OK" });
  // the whole remaining service releases the whole remaining tax; a reviewed zero releases none; an excess return names none
  assert.equal(refundTaxFor(allocation, { serviceCents: 1000n, taxCents: 190n, excessCents: 0n }, 1500n, RULE_19), 285n);
  assert.equal(refundTaxFor({ serviceCents: 2500n, taxCents: 0n, excessCents: 0n }, NONE, 700n, ZERO), 0n);
  assert.equal(refundTaxFor({ ...allocation, excessCents: 300n }, NONE, 0n, RULE_19), 0n);
  assert.throws(() => refundTaxFor(allocation, NONE, 2501n, RULE_19), RangeError);
});

test("B09-F4 (D-FISC-B4): a sale's document validates under the profile version in force at its tax point — superseded later or not; a version superseded before the tax point or effective only after it is not in force", () => {
  const taxPoint = "2026-09-20T10:00:00.000Z";
  const reReviewedAfterSale = { ...profile, supersededAt: "2026-09-21T00:00:00.000Z" };
  assert.equal(profileInForceAt(reReviewedAfterSale, taxPoint), true);
  const decision = resolveFiscalTreatment({ profile: reReviewedAfterSale, issuer, taxPoint, serviceCents: 97125n, priced: RULE_19 });
  assert.deepEqual(decision, { kind: "TREATMENT", snapshot: RULE_19, taxCents: 18454n });
  const successor = { ...profile, profileId: "01920000-0000-7000-8000-0000000f0200" as FiscalProfileId, validFrom: "2026-09-21T00:00:00.000Z", supersedesProfileId: profile.profileId };
  assert.equal(profileInForceAt(successor, taxPoint), false);
  assert.deepEqual(resolveFiscalTreatment({ profile: successor, issuer, taxPoint, serviceCents: 97125n, priced: RULE_19 }), { kind: "BLOCKED", blocker: "FISCAL_PROFILE_NOT_EFFECTIVE" });
  assert.equal(profileInForceAt({ ...profile, supersededAt: "2026-09-20T09:59:59.999Z" }, taxPoint), false);
  assert.equal(profileInForceAt({ ...profile, supersededAt: taxPoint }, taxPoint), false);
});

const QUOTE_B = "01920000-0000-7000-8000-00000000b002" as QuoteId;

test("B09-F2 (D-QUOTE-B4, D-QUOTE-B6): a paid quote is released only once its purchase is closed (wholly refunded or reversed) or re-bound to exactly its replacement; the included replacement needs an ACTIVE entitlement, an intact purchase, an issued replacement, an unused allowance and the source lineage", () => {
  const paid: QuoteReleaseFacts = {
    paymentInFlight: false,
    liveAuthorization: false,
    captures: [{ status: "COMPLETED", allocation: { serviceCents: 97125n, taxCents: 0n, excessCents: 0n }, returned: NONE }],
    reboundTo: null,
  };
  // the critic's P2: a paid capture with no entitlement locks the quote until its money is returned
  assert.deepEqual(quoteRelease(paid, { state: "WITHDRAWN" }), { kind: "BLOCKED", because: "PURCHASE_STANDS" });
  const refunded = { ...paid, captures: [{ ...paid.captures[0]!, returned: { serviceCents: 97125n, taxCents: 0n, excessCents: 0n } }] };
  assert.deepEqual(quoteRelease(refunded, { state: "SUPERSEDED", supersededBy: QUOTE_B }), { kind: "RELEASABLE" });
  assert.deepEqual(quoteRelease({ ...paid, captures: [{ ...paid.captures[0]!, status: "REVERSED" }] }, { state: "EXPIRED" }), { kind: "RELEASABLE" });
  assert.deepEqual(quoteRelease({ ...refunded, liveAuthorization: true }, { state: "WITHDRAWN" }), { kind: "BLOCKED", because: "PURCHASE_STANDS" });
  assert.deepEqual(quoteRelease({ ...refunded, paymentInFlight: true }, { state: "WITHDRAWN" }), { kind: "BLOCKED", because: "PAYMENT_IN_FLIGHT" });
  // re-bound: superseded by exactly the replacement, never withdrawn while the purchase stands
  const rebound = { ...paid, liveAuthorization: true, reboundTo: QUOTE_B };
  assert.deepEqual(quoteRelease(rebound, { state: "SUPERSEDED", supersededBy: QUOTE_B }), { kind: "RELEASABLE" });
  assert.deepEqual(quoteRelease(rebound, { state: "WITHDRAWN" }), { kind: "BLOCKED", because: "PURCHASE_STANDS" });

  const eligible: ReplacementFacts = {
    authorizationState: "ACTIVE",
    captureAlonePays: true,
    refundOpenOrCommitted: false,
    replacedQuoteState: "ACCEPTED_FOR_CHECKOUT",
    replacement: { state: "ISSUED", replacesTheQuote: true },
    replacementsUsed: 0,
    replacementsIncluded: 1,
    lineageReachesReplaced: true,
  };
  assert.deepEqual(replacementBlockers(eligible), []);
  assert.deepEqual(replacementBlockers({ ...eligible, authorizationState: "CONSUMED" }), ["EXECUTION_STARTED"]);
  assert.deepEqual(replacementBlockers({ ...eligible, refundOpenOrCommitted: true }), ["PURCHASE_NOT_INTACT"]);
  assert.deepEqual(replacementBlockers({ ...eligible, replacement: { state: "ISSUED", replacesTheQuote: false } }), ["NOT_A_REPLACEMENT"]);
  assert.deepEqual(replacementBlockers({ ...eligible, replacementsUsed: 1 }), ["ALLOWANCE_USED"]);
  assert.deepEqual(replacementBlockers({ ...eligible, lineageReachesReplaced: false }), ["LINEAGE_MISSING"]);
});

test("B09-F8/B09-F15 (D-EVT-B2): a fee or a funds availability learned after the completion is a capture event of its own for FINANCE only; the completion reaches FINANCE, FISCAL and COMMISSIONS once; the funds move from receivable to held to available and never to bank cash", () => {
  const consumers = (type: string) => COMMERCE_EVENT_SUBSCRIPTIONS.filter((s) => s.eventType === type).map((s) => s.consumer).sort();
  assert.deepEqual(consumers("capture.completed.v1"), ["COMMISSIONS", "FINANCE", "FISCAL"]);
  assert.deepEqual(consumers("capture.fee_observed.v1"), ["FINANCE"]);
  assert.deepEqual(consumers("capture.funds_observed.v1"), ["FINANCE"]);
  assert.deepEqual(consumers("reconciliation_case.resolved.v1"), ["FINANCE"]);
  assert.ok(COMMERCE_EVENT_TYPES.includes("capture.fee_observed.v1") && COMMERCE_EVENT_TYPES.includes("capture.funds_observed.v1"));
  assert.ok(COMMERCE_EVENT_PAYLOAD_ALLOWLIST["capture.fee_observed.v1"].includes("providerFeeCents"));
  assert.deepEqual(fundsPostings("UNKNOWN", "HELD", 97125n), [
    { account: "PSP_HELD", direction: "DEBIT", amountCents: 97125n },
    { account: "PSP_RECEIVABLE", direction: "CREDIT", amountCents: 97125n },
  ]);
  const released = fundsPostings("HELD", "AVAILABLE", 97125n);
  assert.deepEqual(released.map((l) => l.account), ["PSP_AVAILABLE", "PSP_HELD"]);
  assert.ok(isBalanced(released));
  assert.deepEqual(fundsPostings("AVAILABLE", "AVAILABLE", 97125n), []);
  for (const l of [...fundsPostings("UNKNOWN", "AVAILABLE", 1n), ...released]) assert.notEqual(l.account, "BANK_CASH");
});

test("B09-F9 (D-ING-B3): every capture mismatch matchCapture can answer is a provider exception kind of the same name", () => {
  for (const m of CAPTURE_MISMATCHES) assert.ok(PROVIDER_EXCEPTION_KINDS.includes(m), m);
  assert.deepEqual(
    [...PROVIDER_EXCEPTION_KINDS].sort(),
    ["BODY_CONFLICT", "UNKNOWN_PROVIDER_REFERENCE", "UNRECOGNIZED_PROVIDER_STATE", "WRONG_CURRENCY", "WRONG_ENVIRONMENT", "WRONG_ORDER", "WRONG_PAYEE", "WRONG_PROVIDER"],
  );
});
