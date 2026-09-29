// Capture matching, monotonic capture facts, obligation allocation (S058, R2-140; 15 "Capture and authority", "Webhooks and
// reconciliation") and the commercial authority predicates (S057, S060; 07 "Quote and checkout states", "CommercialAuthorization").
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allocateCapture,
  authorizationBlockers,
  blockerFailure,
  captureStatusStep,
  checkoutBlockers,
  deliveryPhaseOf,
  honoredAfterPriceExpiry,
  isFullyPaid,
  matchCapture,
  revocationPhaseOf,
  splitObligation,
  type CheckoutFacts,
  type FiscalIssuerRef,
  type FiscalProfileId,
  type FiscalProfileRecord,
  type AgencyId,
  type ObservedCapture,
  type PaymentOrderRecord,
  type UserId,
} from "../src/index.js";

const ORDER = {
  provider: "contract-fake",
  environment: "SANDBOX",
  providerOrderId: "ORDER-1",
  payeeDigest: "e".repeat(64),
  currency: "USD",
} as const satisfies Pick<PaymentOrderRecord, "provider" | "environment" | "providerOrderId" | "payeeDigest" | "currency">;

function observed(overrides: Partial<ObservedCapture> = {}): ObservedCapture {
  return {
    provider: "contract-fake",
    environment: "SANDBOX",
    providerOrderId: "ORDER-1",
    providerCaptureId: "CAPTURE-1",
    status: "COMPLETED",
    amountCents: 97125n,
    currency: "USD",
    payeeDigest: "e".repeat(64),
    providerCompletedAt: "2026-09-24T12:00:00.000Z",
    fundsState: "HELD",
    feeCents: 5275n,
    evidenceHash: "f".repeat(64),
    ...overrides,
  };
}

test("S058: a capture of another provider, environment, order, payee or currency never matches the order; the amount is not identity", () => {
  assert.deepEqual(matchCapture(ORDER, observed()), { kind: "MATCH" });
  assert.deepEqual(matchCapture(ORDER, observed({ provider: "paypal" })), { kind: "MISMATCH", reason: "WRONG_PROVIDER" });
  assert.deepEqual(matchCapture(ORDER, observed({ environment: "LIVE" })), { kind: "MISMATCH", reason: "WRONG_ENVIRONMENT" });
  assert.deepEqual(matchCapture(ORDER, observed({ providerOrderId: "ORDER-2" })), { kind: "MISMATCH", reason: "WRONG_ORDER" });
  assert.deepEqual(matchCapture(ORDER, observed({ payeeDigest: "d".repeat(64) })), { kind: "MISMATCH", reason: "WRONG_PAYEE" });
  assert.deepEqual(matchCapture(ORDER, observed({ currency: "EUR" })), { kind: "MISMATCH", reason: "WRONG_CURRENCY" });
  assert.deepEqual(matchCapture(ORDER, observed({ amountCents: 1n })), { kind: "MATCH" }, "an amount difference is accounted by allocation, not rejected");
  assert.deepEqual(matchCapture(ORDER, observed({ providerOrderId: null })), { kind: "MATCH" }, "an event naming only the capture matches through the scope index");
});

test("capture facts only move forward: pending → completed | denied, completed → reversed (a reversal walks the completion first); old or contradictory events change nothing", () => {
  assert.deepEqual(captureStatusStep(null, "PENDING"), { kind: "INSERT", status: "PENDING" });
  assert.deepEqual(captureStatusStep("PENDING", "COMPLETED"), { kind: "ADVANCE", next: "COMPLETED", event: "provider_completed" });
  assert.deepEqual(captureStatusStep("PENDING", "DENIED"), { kind: "ADVANCE", next: "DENIED", event: "provider_denied" });
  assert.deepEqual(captureStatusStep("PENDING", "REVERSED"), { kind: "ADVANCE", next: "COMPLETED", event: "provider_completed", then: [{ next: "REVERSED", event: "provider_reversed" }] });
  assert.deepEqual(captureStatusStep("COMPLETED", "REVERSED"), { kind: "ADVANCE", next: "REVERSED", event: "provider_reversed" });
  assert.deepEqual(captureStatusStep("COMPLETED", "PENDING"), { kind: "STALE" }, "an old pending event cannot roll back a confirmed capture (15)");
  assert.deepEqual(captureStatusStep("REVERSED", "COMPLETED"), { kind: "STALE" }, "S059: a completion arriving after its reversal adds history only");
  assert.deepEqual(captureStatusStep("REVERSED", "PENDING"), { kind: "STALE" });
  assert.deepEqual(captureStatusStep("COMPLETED", "DENIED"), { kind: "INCONSISTENT" });
  assert.deepEqual(captureStatusStep("DENIED", "COMPLETED"), { kind: "INCONSISTENT" });
  assert.deepEqual(captureStatusStep("COMPLETED", "COMPLETED"), { kind: "SAME" });
});

test("R2-140: two full captures of one obligation — the first pays it, the second is entirely excess; one entitlement, capped basis", () => {
  const order = { expectedAmountCents: 97125n, expectedServiceCents: 97125n, expectedTaxCents: 0n, allocatedCents: 0n };
  const first = allocateCapture(order, 97125n);
  assert.deepEqual(first, { serviceCents: 97125n, taxCents: 0n, excessCents: 0n });
  const second = allocateCapture({ ...order, allocatedCents: 97125n }, 97125n);
  assert.deepEqual(second, { serviceCents: 0n, taxCents: 0n, excessCents: 97125n });
  assert.equal(isFullyPaid({ expectedAmountCents: 97125n, allocatedCents: 97125n }), true);
});

test("partial and over captures add up to exactly the quoted service and tax (cumulative split, service first on a tie)", () => {
  // service 97125 + tax 18454 (a synthetic reviewed rule) = 115579
  const base = { expectedAmountCents: 115579n, expectedServiceCents: 97125n, expectedTaxCents: 18454n };
  const one = allocateCapture({ ...base, allocatedCents: 0n }, 50000n);
  const two = allocateCapture({ ...base, allocatedCents: 50000n }, 65579n);
  assert.equal(one.serviceCents + two.serviceCents, 97125n);
  assert.equal(one.taxCents + two.taxCents, 18454n);
  assert.equal(one.excessCents + two.excessCents, 0n);
  const over = allocateCapture({ ...base, allocatedCents: 0n }, 120000n);
  assert.deepEqual(over, { serviceCents: 97125n, taxCents: 18454n, excessCents: 4421n });
  const under = allocateCapture({ ...base, allocatedCents: 0n }, 1n);
  assert.equal(under.serviceCents + under.taxCents, 1n);
  assert.deepEqual(splitObligation(base, 115579n), { serviceCents: 97125n, taxCents: 18454n });
  assert.throws(() => allocateCapture({ ...base, expectedTaxCents: 1n, allocatedCents: 0n }, 1n), RangeError);
});

const reviewed: FiscalProfileRecord = {
  profileId: "01920000-0000-7000-8000-0000000f0100" as FiscalProfileId,
  agencyId: "01920000-0000-7000-8000-0000000a0001" as AgencyId,
  operatorLegalRef: "01920000-0000-7000-8000-0000000f0001" as FiscalIssuerRef,
  customerLegalRef: "01920000-0000-7000-8000-0000000c0001",
  serviceClassification: "DATA_PREPARATION_SERVICE",
  territory: "US",
  taxTreatment: "EXEMPT_EXPORT",
  taxRule: "ZERO_REVIEWED",
  taxRateBps: 0,
  evidenceHash: "3".repeat(64),
  exportEvidenceHash: "4".repeat(64),
  reviewedByUserId: "6f1b0d2e-3c4a-5b5c-9d6e-7f8091a2b3c4" as UserId,
  validFrom: "2026-09-01T00:00:00.000Z",
  recordedAt: "2026-09-01T00:00:00.000Z",
};

function ready(overrides: Partial<CheckoutFacts> = {}): CheckoutFacts {
  return {
    now: "2026-09-24T12:00:00.000Z",
    quote: {
      state: "ISSUED",
      expiresAt: "2026-10-08T12:00:00.000Z",
      approvalId: "01920000-0000-7000-8000-00000000ab01" as never,
      planHash: "a".repeat(64),
      revisionHash: "b".repeat(64),
      targetContractHash: "c".repeat(64),
      tax: { treatment: "EXEMPT_EXPORT", rule: "ZERO_REVIEWED", rateBps: 0 },
    },
    agencyState: "ACTIVE",
    plan: { state: "APPROVED", approvalId: "01920000-0000-7000-8000-00000000ab01" as never, bodyHash: "a".repeat(64) },
    approval: {},
    revision: { state: "SEALED" },
    target: { confirmed: true, superseded: false },
    capability: { state: "AVAILABLE_LIMITED" },
    paymentRoute: { state: "QUALIFIED" },
    fiscalIssuerRoute: { state: "QUALIFIED" },
    fiscalProfile: reviewed,
    openOrder: null,
    paid: false,
    capacity: { available: true },
    ...overrides,
  };
}

test("checkout readiness: ready facts have no blocker; S060 — a price-valid quote whose source expired or was deleted blocks checkout", () => {
  assert.deepEqual(checkoutBlockers(ready()), []);
  assert.deepEqual(checkoutBlockers(ready({ revision: { state: "EXPIRED" } })), ["SOURCE_EXPIRED"]);
  assert.deepEqual(checkoutBlockers(ready({ revision: { state: "DELETED" } })), ["SOURCE_EXPIRED"]);
  assert.deepEqual(checkoutBlockers(ready({ revision: null })), ["SOURCE_EXPIRED"]);
  const failure = blockerFailure("SOURCE_EXPIRED");
  assert.equal(failure.code, "SOURCE_EXPIRED");
  assert.equal(failure.status, 422);
});

test("checkout readiness names every other material prerequisite, in the documented order", () => {
  assert.deepEqual(checkoutBlockers(ready({ now: "2026-10-08T12:00:00.000Z" })), ["QUOTE_EXPIRED"]);
  assert.deepEqual(checkoutBlockers(ready({ agencyState: "RESTRICTED" })), ["AGENCY_NOT_ACTIVE"]);
  assert.deepEqual(checkoutBlockers(ready({ quote: { ...ready().quote, state: "SUPERSEDED" } })), ["QUOTE_NOT_ACTIVE"]);
  assert.deepEqual(checkoutBlockers(ready({ plan: { state: "SUPERSEDED", bodyHash: "a".repeat(64) } })), ["APPROVAL_NOT_CURRENT"]);
  assert.deepEqual(checkoutBlockers(ready({ approval: { withdrawnAt: "2026-09-23T00:00:00.000Z" } })), ["APPROVAL_NOT_CURRENT"]);
  assert.deepEqual(checkoutBlockers(ready({ target: { confirmed: true, superseded: true } })), ["TARGET_STALE"]);
  assert.deepEqual(checkoutBlockers(ready({ capability: { state: "SUSPENDED" } })), ["CAPABILITY_RESTRICTED"]);
  assert.deepEqual(checkoutBlockers(ready({ paymentRoute: { state: "CONFIGURED" } })), ["PAYMENT_ROUTE_UNQUALIFIED"]);
  assert.deepEqual(checkoutBlockers(ready({ fiscalIssuerRoute: null })), ["FISCAL_ROUTE_UNQUALIFIED"]);
  assert.deepEqual(checkoutBlockers(ready({ fiscalProfile: { ...reviewed, taxTreatment: "REVIEW_REQUIRED", taxRule: "UNRESOLVED" } })), ["FISCAL_TREATMENT_UNREVIEWED"]);
  assert.deepEqual(checkoutBlockers(ready({ openOrder: { state: "CAPTURE_UNCERTAIN" } })), ["PAYMENT_UNCERTAIN"]);
  assert.deepEqual(checkoutBlockers(ready({ openOrder: { state: "CAPTURING" } })), ["PAYMENT_IN_PROGRESS"]);
  assert.deepEqual(checkoutBlockers(ready({ paid: true })), ["ALREADY_PAID"]);
  assert.deepEqual(checkoutBlockers(ready({ agencyState: "RESTRICTED", revision: { state: "EXPIRED" } })), ["AGENCY_NOT_ACTIVE", "SOURCE_EXPIRED"]);
  assert.equal(blockerFailure("PAYMENT_UNCERTAIN").code, "PAYMENT_UNCERTAIN");
  assert.equal(blockerFailure("PAYMENT_IN_PROGRESS").retryable, true);
});

test("authorization prerequisites at capture honor a still-valid scope after price expiry and never depend on fiscal issuance", () => {
  const accepted = { ...ready().quote, state: "ACCEPTED_FOR_CHECKOUT" as const };
  const facts = { ...ready({ now: "2026-10-09T00:00:00.000Z" }), quote: accepted, fiscalProfile: null };
  assert.deepEqual(authorizationBlockers(facts), []);
  assert.equal(honoredAfterPriceExpiry(accepted, "2026-10-08T12:00:00.001Z"), true);
  assert.equal(honoredAfterPriceExpiry(accepted, "2026-10-08T11:59:59.999Z"), false);
  // source expiry racing the capture: money is recorded, authority is not (transitions "Cross-aggregate finalization")
  assert.deepEqual(authorizationBlockers({ ...facts, revision: { state: "EXPIRED" } }), ["SOURCE_EXPIRED"]);
  assert.deepEqual(authorizationBlockers({ ...facts, quote: { ...accepted, state: "WITHDRAWN" } }), ["QUOTE_NOT_ACTIVE"]);
});

test("S059: the revocation phase is the state the authorization leaves; a refund request records the delivery phase", () => {
  assert.equal(revocationPhaseOf("ACTIVE"), "PRE_EXECUTION");
  assert.equal(revocationPhaseOf("CONSUMED"), "DURING_EXECUTION");
  assert.equal(revocationPhaseOf("DELIVERED"), "POST_DELIVERY");
  assert.throws(() => revocationPhaseOf("REVOKED"));
  assert.equal(deliveryPhaseOf(null), "NO_AUTHORIZATION");
  assert.equal(deliveryPhaseOf({ state: "CONSUMED" }), "DURING_EXECUTION");
  assert.equal(deliveryPhaseOf({ state: "REVOKED", revocationPhase: "POST_DELIVERY" }), "POST_DELIVERY");
});
