// The domain halves of the fixes to the adversarial review of the B09 design (docs/design/B09-payments-fiscal.md §16 "Critique
// record"): deliverable capacity at checkout (B09-F5), the cumulative refund tax rule (B09-F6), the fiscal profile in force at the tax
// point (B09-F4), the quote's settled and re-bound paths (B09-F2), the capture's later facts as events of their own (B09-F8, B09-F15),
// the exception vocabulary (B09-F9) and the dispute boundary (B09-F14); and the re-check's residual findings (B09-N1, N3, N4, N5): the
// event each version publishes, the out-of-order reversal, the provider balance a posting takes money from, the version of a sale.
// Each test fails on the design it replaces.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAPTURE_MISMATCHES,
  COMMERCE_AGGREGATE_KINDS,
  COMMERCE_PLATFORM_MACHINES,
  COMMERCE_REQUEST_HANDLER_EVENT_TYPES,
  COMMERCE_STATE_EVENT_TYPES,
  COMMERCE_EVENT_PAYLOAD_ALLOWLIST,
  COMMERCE_EVENT_SUBSCRIPTIONS,
  COMMERCE_EVENT_TYPES,
  BANK_ACCOUNTS,
  PROVIDER_BALANCE_ACCOUNTS,
  PROVIDER_EXCEPTION_KINDS,
  blockerFailure,
  captureStatusStep,
  capturePostings,
  checkRefundTax,
  commerceVersionEventType,
  checkoutBlockers,
  fundsPostings,
  isBalanced,
  movableBalanceOf,
  profileInForceAt,
  providerFeePostings,
  quoteRelease,
  refundTaxFor,
  replacementBlockers,
  resolveFiscalTreatment,
  returnPostings,
  roundHalfUpBps,
  saleProfileAt,
  taxRemainingAfter,
  type AgencyId,
  type CheckoutFacts,
  type FiscalIssuerRecord,
  type FiscalIssuerRef,
  type FiscalProfileId,
  type FiscalProfileRecord,
  type PostingLine,
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
  recordedAt: "2026-09-01T00:00:00.000Z",
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

// --- the re-check's residual findings (design §16, B09-N1..B09-N8) ------------------------------------------------------------------

test("B09-N1 (D-EVT-B3): a commerce version publishes the event of the state it records — a capture's later fee or funds are one fact per version — and the request handlers may publish only their own edges' events", () => {
  // every state of every machine a commerce aggregate walks has exactly its event, and every event type is a state's or a later fact's
  const machineOf: Record<string, string> = { quote: "Quote", payment_order: "PaymentOrder", capture: "CaptureFact", commercial_authorization: "CommercialAuthorization", refund: "Refund", reconciliation_case: "ReconciliationCase" };
  for (const [kind, machine] of Object.entries(machineOf)) {
    const m = COMMERCE_PLATFORM_MACHINES.find((x) => x.contract === machine)!;
    const states = new Set([m.initial, ...m.transitions.flatMap((t) => [t.from, t.to])]);
    assert.deepEqual([...states].sort(), Object.keys(COMMERCE_STATE_EVENT_TYPES[kind as keyof typeof COMMERCE_STATE_EVENT_TYPES]).sort(), kind);
  }
  const covered = new Set([...Object.values(COMMERCE_STATE_EVENT_TYPES).flatMap((byState) => Object.values(byState)), "capture.fee_observed.v1", "capture.funds_observed.v1"]);
  assert.deepEqual([...covered].sort(), [...COMMERCE_EVENT_TYPES].sort());
  for (const kind of COMMERCE_AGGREGATE_KINDS) for (const type of Object.values(COMMERCE_STATE_EVENT_TYPES[kind])) assert.ok(type.startsWith(`${kind}.`), type);
  // the probe's forgeries have no admissible type: a REQUESTED refund is refund.requested.v1, a WITHDRAWN quote quote.withdrawn.v1
  assert.equal(commerceVersionEventType("refund", { previousState: null, state: "REQUESTED" }), "refund.requested.v1");
  assert.equal(commerceVersionEventType("quote", { previousState: "ISSUED", state: "WITHDRAWN" }), "quote.withdrawn.v1");
  assert.equal(commerceVersionEventType("payment_order", { previousState: "CAPTURING", state: "APPROVED" }), "payment_order.approved.v1", "a back edge publishes its target state's type");
  // a capture: its status versions, and one later provider fact per same-status version
  assert.equal(commerceVersionEventType("capture", { previousState: null, state: "COMPLETED", feeChanged: true }), "capture.completed.v1", "a fee reported with the completion travels in it");
  assert.equal(commerceVersionEventType("capture", { previousState: "COMPLETED", state: "COMPLETED", feeChanged: true }), "capture.fee_observed.v1");
  assert.equal(commerceVersionEventType("capture", { previousState: "COMPLETED", state: "COMPLETED", fundsChanged: true }), "capture.funds_observed.v1");
  assert.throws(() => commerceVersionEventType("capture", { previousState: "COMPLETED", state: "COMPLETED", feeChanged: true, fundsChanged: true }), RangeError, "two facts are two versions");
  assert.throws(() => commerceVersionEventType("capture", { previousState: "COMPLETED", state: "COMPLETED" }), RangeError, "a version records something");
  assert.throws(() => commerceVersionEventType("capture", { previousState: null, state: "COMPLETED", fundsChanged: true }), RangeError, "funds are a version of their own");
  assert.throws(() => commerceVersionEventType("capture", { previousState: "COMPLETED", state: "REVERSED", feeChanged: true }), RangeError);
  assert.throws(() => commerceVersionEventType("refund", { previousState: "APPROVED", state: "APPROVED", feeChanged: true }), RangeError);
  // the request handlers' events: no provider result, capture fact, execution, entitlement, fiscal document or case opening
  const handlers: ReadonlyArray<string> = [...COMMERCE_REQUEST_HANDLER_EVENT_TYPES.TENANT, ...COMMERCE_REQUEST_HANDLER_EVENT_TYPES.OPERATOR];
  for (const forbidden of ["refund.completed.v1", "capture.completed.v1", "capture.reversed.v1", "capture.fee_observed.v1", "capture.funds_observed.v1", "commercial_authorization.issued.v1", "commercial_authorization.revoked.v1", "payment_order.created.v1", "payment_order.captured.v1", "payment_attempt.confirmed.v1", "reconciliation_case.opened.v1", "tax_document.validated.v1"]) {
    assert.ok(!handlers.includes(forbidden), forbidden);
  }
  for (const t of COMMERCE_EVENT_TYPES.filter((x) => x.startsWith("quote."))) assert.ok(COMMERCE_REQUEST_HANDLER_EVENT_TYPES.TENANT.includes(t), t);
  assert.deepEqual([...COMMERCE_REQUEST_HANDLER_EVENT_TYPES.OPERATOR], ["refund.approved.v1", "refund.rejected.v1", "reconciliation_case.resolved.v1"]);
});

test("B09-N3 (D-PAY-B5): a capture first seen REVERSED, or reversed while known only as PENDING, is recorded as its completion and then its reversal — the CAPTURE posting its completion sources is what the CHARGEBACK returns; the machine has no PENDING → REVERSED edge", () => {
  assert.deepEqual(captureStatusStep(null, "REVERSED"), { kind: "INSERT", status: "COMPLETED", then: [{ next: "REVERSED", event: "provider_reversed" }] });
  assert.deepEqual(captureStatusStep("PENDING", "REVERSED"), { kind: "ADVANCE", next: "COMPLETED", event: "provider_completed", then: [{ next: "REVERSED", event: "provider_reversed" }] });
  const machine = COMMERCE_PLATFORM_MACHINES.find((m) => m.contract === "CaptureFact")!;
  assert.deepEqual(machine.transitions.filter((t) => t.to === "REVERSED").map((t) => t.from), ["COMPLETED"]);
  // the two versions publish capture.completed.v1 then capture.reversed.v1
  assert.equal(commerceVersionEventType("capture", { previousState: null, state: "COMPLETED" }), "capture.completed.v1");
  assert.equal(commerceVersionEventType("capture", { previousState: "COMPLETED", state: "REVERSED" }), "capture.reversed.v1");
  // the two posting sets of a born-reversed capture net the receivable to zero: debited by the completion, credited by the chargeback
  const allocation = { serviceCents: 97125n, taxCents: 0n, excessCents: 0n };
  const net = [...capturePostings(allocation), ...returnPostings(allocation, "UNKNOWN")]
    .filter((l) => l.account === "PSP_RECEIVABLE")
    .reduce((n, l) => n + (l.direction === "DEBIT" ? l.amountCents : -l.amountCents), 0n);
  assert.equal(net, 0n);
});

test("B09-N4 (D-LEDGER-B5): a capture's money sits in one provider balance at a time — its fee and every return are taken from the balance of the funds state their event names, and a funds observation moves the movable balance (the amount less the fee and the money returned), so no provider balance of the capture goes negative and none of it is ever bank money", () => {
  const balances = new Map<string, bigint>();
  const post = (ls: ReadonlyArray<PostingLine>, step: string): void => {
    assert.ok(isBalanced(ls), step);
    for (const l of ls) {
      assert.ok(!BANK_ACCOUNTS.includes(l.account), `${step}: ${l.account}`);
      balances.set(l.account, (balances.get(l.account) ?? 0n) + (l.direction === "DEBIT" ? l.amountCents : -l.amountCents));
    }
    for (const a of PROVIDER_BALANCE_ACCOUNTS) assert.ok((balances.get(a) ?? 0n) >= 0n, `${step}: ${a} is ${balances.get(a)}`);
  };
  const amount = 97125n;
  const fee = 5275n;
  post(capturePostings({ serviceCents: amount, taxCents: 0n, excessCents: 0n }), "completion");
  // the fee reported after the completion, while the funds are still UNKNOWN: taken from the receivable
  post(providerFeePostings(fee, "UNKNOWN"), "fee");
  // HELD: the receivable's balance moves, net of the fee — the design before this revision moved the whole 97125 and left the
  // receivable at -5275
  const held = movableBalanceOf({ amountCents: amount, providerFeeCents: fee, returnedCents: 0n });
  assert.equal(held, 91850n, "R2-078: the net of the actual fee");
  post(fundsPostings("UNKNOWN", "HELD", held), "held");
  assert.equal(balances.get("PSP_RECEIVABLE"), 0n);
  // a partial refund completed while the funds are held is returned from the held balance
  post(returnPostings({ serviceCents: 1000n, taxCents: 0n, excessCents: 0n }, "HELD"), "refund");
  // AVAILABLE: the held balance moves, net of the fee and of the money returned
  post(fundsPostings("HELD", "AVAILABLE", movableBalanceOf({ amountCents: amount, providerFeeCents: fee, returnedCents: 1000n })), "available");
  assert.deepEqual(PROVIDER_BALANCE_ACCOUNTS.map((a) => balances.get(a) ?? 0n), [0n, 0n, 90850n]);
  assert.equal(balances.get("PROCESSOR_EXPENSE"), fee);
  // a fee learned while the funds are available is taken from the available balance; nothing left to move posts nothing
  assert.deepEqual(providerFeePostings(5n, "AVAILABLE").map((l) => [l.account, l.direction]), [["PROCESSOR_EXPENSE", "DEBIT"], ["PSP_AVAILABLE", "CREDIT"]]);
  assert.equal(movableBalanceOf({ amountCents: 100n, providerFeeCents: 30n, returnedCents: 100n }), 0n);
  assert.deepEqual(fundsPostings("HELD", "AVAILABLE", 0n), []);
  // the funds' movements touch the provider balances only
  for (const [from, to] of [["UNKNOWN", "HELD"], ["UNKNOWN", "AVAILABLE"], ["HELD", "AVAILABLE"], ["AVAILABLE", "HELD"]] as const) {
    for (const l of fundsPostings(from, to, 1n)) assert.ok(PROVIDER_BALANCE_ACCOUNTS.includes(l.account), `${from} -> ${to}: ${l.account}`);
  }
});

test("B09-N5 (D-FISC-B4, D-FISC-B6): every document of a sale takes the version of the sale's tax point — a credit note drafted after a re-review keeps the invoice's version and is judged at the capture's completion, never at the refund's; a later version never replaces a reviewed treatment for the sale, and a later review resolves an unknown one", () => {
  const saleTaxPoint = "2026-09-20T10:00:00.000Z";
  const refundCompletedAt = "2026-09-25T10:00:00.000Z";
  const reReviewedAt = "2026-09-22T00:00:00.000Z";
  // the version of the sale, superseded by a re-review between the sale and the refund
  const ofTheSale: FiscalProfileRecord = { ...profile, supersededAt: reReviewedAt };
  const reReview: FiscalProfileRecord = { ...profile, profileId: "01920000-0000-7000-8000-0000000f0301" as FiscalProfileId, validFrom: reReviewedAt, recordedAt: reReviewedAt, supersedesProfileId: profile.profileId };
  assert.equal(saleProfileAt([reReview, ofTheSale], saleTaxPoint), ofTheSale, "the invoice's version");
  assert.equal(saleProfileAt([reReview, ofTheSale], refundCompletedAt), reReview, "the version current at the refund's completion, which a credit note never takes");
  // the credit note carries the invoice's snapshot and is judged at the sale's tax point
  assert.deepEqual(resolveFiscalTreatment({ profile: ofTheSale, issuer, taxPoint: saleTaxPoint, serviceCents: 1000n, priced: RULE_19 }), { kind: "TREATMENT", snapshot: RULE_19, taxCents: 190n });
  // judged at the refund's completion (the reading the domain contract carried before) it is blocked, although the database validates it
  assert.deepEqual(resolveFiscalTreatment({ profile: ofTheSale, issuer, taxPoint: refundCompletedAt, serviceCents: 1000n, priced: RULE_19 }), { kind: "BLOCKED", blocker: "FISCAL_PROFILE_NOT_EFFECTIVE" });
  // a retroactive re-review that changes the treatment: in force at the sale's tax point too, but the sale keeps its reviewed version
  const retroactive: FiscalProfileRecord = {
    ...profile,
    profileId: "01920000-0000-7000-8000-0000000f0302" as FiscalProfileId,
    taxTreatment: "EXEMPT_EXPORT",
    taxRule: "ZERO_REVIEWED",
    taxRateBps: 0,
    exportEvidenceHash: "4".repeat(64),
    validFrom: "2026-08-21T10:00:00.000Z",
    recordedAt: reReviewedAt,
    supersedesProfileId: profile.profileId,
  };
  assert.equal(profileInForceAt(retroactive, saleTaxPoint), true);
  assert.equal(saleProfileAt([retroactive, ofTheSale], saleTaxPoint), ofTheSale);
  assert.deepEqual(resolveFiscalTreatment({ profile: retroactive, issuer, taxPoint: saleTaxPoint, serviceCents: 97125n, priced: RULE_19 }), { kind: "BLOCKED", blocker: "FISCAL_TREATMENT_CHANGED" });
  // an unknown treatment at the sale's tax point is resolved by a later review whose validity reaches back to the sale
  const unknownAtSale: FiscalProfileRecord = { ...profile, taxTreatment: "REVIEW_REQUIRED", taxRule: "UNRESOLVED", taxRateBps: 0, supersededAt: reReviewedAt };
  const resolving: FiscalProfileRecord = { ...profile, profileId: "01920000-0000-7000-8000-0000000f0303" as FiscalProfileId, recordedAt: reReviewedAt, supersedesProfileId: profile.profileId };
  assert.equal(saleProfileAt([unknownAtSale, resolving], saleTaxPoint), resolving);
  assert.deepEqual(resolveFiscalTreatment({ profile: resolving, issuer, taxPoint: saleTaxPoint, serviceCents: 97125n, priced: RULE_19 }), { kind: "TREATMENT", snapshot: RULE_19, taxCents: 18454n });
  assert.equal(saleProfileAt([unknownAtSale], saleTaxPoint), unknownAtSale, "while unresolved, the unknown records its blocker");
  assert.equal(saleProfileAt([reReview], saleTaxPoint), null, "nothing in force at the tax point");
});
