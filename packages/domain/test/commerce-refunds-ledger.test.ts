// Refund balances, standing-policy applicability and authorization digests (15 "Refund policy and calculation"; CMD031,
// CMD032), and the balanced operational ledger postings (15 "Operational ledger"; reference/HASHING "Ledger posting").
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capturePostings,
  checkRefundAmounts,
  componentsTotal,
  isBalanced,
  policyCovers,
  proposeRefund,
  providerFeePostings,
  refundAuthorizationHash,
  refundEffectsHash,
  refundableBalance,
  returnPostings,
  authorizationPreimageMoney,
  approvedComponents,
  addComponents,
  ZERO_COMPONENTS,
  type CaptureFactRecord,
  type RefundPolicyRecord,
  type RefundPolicyId,
  type UserId,
  type AssuranceProofId,
} from "../src/index.js";

type CaptureShape = Pick<CaptureFactRecord, "status" | "allocation">;

function capture(status: CaptureFactRecord["status"] = "COMPLETED", allocation = { serviceCents: 97125n, taxCents: 18454n, excessCents: 0n }): CaptureShape {
  return { status, allocation };
}

test("refundable balance is the allocated components minus the committed refunds; nothing is refundable from a pending, denied or reversed capture", () => {
  assert.deepEqual(refundableBalance(capture(), { serviceCents: 20000n, taxCents: 3800n, excessCents: 0n }), { serviceCents: 77125n, taxCents: 14654n, excessCents: 0n });
  for (const status of ["PENDING", "DENIED", "REVERSED"] as const) assert.equal(componentsTotal(refundableBalance(capture(status), ZERO_COMPONENTS)), 0n, status);
  assert.deepEqual(addComponents({ serviceCents: 1n, taxCents: 2n, excessCents: 3n }, { serviceCents: 10n, taxCents: 20n, excessCents: 30n }), { serviceCents: 11n, taxCents: 22n, excessCents: 33n });
});

test("CMD031 proposal is visible but never an authorization: the remaining service with its tax, or only the excess", () => {
  const balance = refundableBalance(capture("COMPLETED", { serviceCents: 97125n, taxCents: 0n, excessCents: 97125n }), ZERO_COMPONENTS);
  assert.deepEqual(proposeRefund("CUSTOMER_REQUEST", balance), { serviceCents: 97125n, taxCents: 0n, excessCents: 0n });
  assert.deepEqual(proposeRefund("EXCESS_CAPTURE", balance), { serviceCents: 0n, taxCents: 0n, excessCents: 97125n });
  // CMD032 names serviceCents and taxCents only: an excess return approves zero of both and authorizes the recorded excess (D-REF-B2)
  assert.deepEqual(approvedComponents("EXCESS_CAPTURE", { serviceCents: 0n, taxCents: 0n, excessCents: 97125n }, { serviceCents: 0n, taxCents: 0n }), { serviceCents: 0n, taxCents: 0n, excessCents: 97125n });
  assert.deepEqual(approvedComponents("CUSTOMER_REQUEST", { serviceCents: 97125n, taxCents: 0n, excessCents: 0n }, { serviceCents: 20000n, taxCents: 0n }), { serviceCents: 20000n, taxCents: 0n, excessCents: 0n });
});

test("CMD032: the total cannot exceed the reconciled remaining capture, per component; an excess return carries only excess", () => {
  const balance = refundableBalance(capture(), ZERO_COMPONENTS);
  assert.deepEqual(checkRefundAmounts("CUSTOMER_REQUEST", balance, { serviceCents: 97125n, taxCents: 18454n, excessCents: 0n }), { kind: "OK" });
  assert.deepEqual(checkRefundAmounts("CUSTOMER_REQUEST", balance, { serviceCents: 97126n, taxCents: 0n, excessCents: 0n }), { kind: "EXCEEDS", fields: ["serviceCents"] });
  assert.deepEqual(checkRefundAmounts("CUSTOMER_REQUEST", balance, { serviceCents: 0n, taxCents: 18455n, excessCents: 0n }), { kind: "EXCEEDS", fields: ["taxCents"] });
  assert.deepEqual(checkRefundAmounts("CUSTOMER_REQUEST", balance, { serviceCents: 0n, taxCents: 0n, excessCents: 0n }), { kind: "EMPTY" });
  assert.deepEqual(checkRefundAmounts("CUSTOMER_REQUEST", balance, { serviceCents: 1n, taxCents: 0n, excessCents: 1n }), { kind: "WRONG_COMPONENT" });
  assert.deepEqual(checkRefundAmounts("EXCESS_CAPTURE", { serviceCents: 0n, taxCents: 0n, excessCents: 97125n }, { serviceCents: 1n, taxCents: 0n, excessCents: 0n }), { kind: "WRONG_COMPONENT" });
});

test("R2-081 at the refund boundary: 25 one-cent service refunds consume a 25-cent service capture to exactly zero; the 26th exceeds", () => {
  let refunded = 0n;
  for (let i = 0; i < 25; i++) {
    const balance = refundableBalance(capture("COMPLETED", { serviceCents: 25n, taxCents: 0n, excessCents: 0n }), { serviceCents: refunded, taxCents: 0n, excessCents: 0n });
    assert.deepEqual(checkRefundAmounts("CUSTOMER_REQUEST", balance, { serviceCents: 1n, taxCents: 0n, excessCents: 0n }), { kind: "OK" });
    refunded += 1n;
  }
  const exhausted = refundableBalance(capture("COMPLETED", { serviceCents: 25n, taxCents: 0n, excessCents: 0n }), { serviceCents: refunded, taxCents: 0n, excessCents: 0n });
  assert.equal(componentsTotal(exhausted), 0n);
  assert.equal(checkRefundAmounts("CUSTOMER_REQUEST", exhausted, { serviceCents: 1n, taxCents: 0n, excessCents: 0n }).kind, "EXCEEDS");
});

const policy: RefundPolicyRecord = {
  policyId: "01920000-0000-7000-8000-00000000b001" as RefundPolicyId,
  policyKind: "PRE_EXECUTION_CANCELLATION",
  policyVersion: "R2-2026-09",
  refundScope: "FULL_REMAINING",
  appliesToPhase: "PRE_EXECUTION",
  appliesToOrigin: "CUSTOMER_REQUEST",
  conditionsHash: "5".repeat(64),
  authorizedByUserId: "6f1b0d2e-3c4a-5b5c-9d6e-7f8091a2b3c4" as UserId,
  authorizationProofRef: "01920000-0000-7000-8000-00000000b002" as AssuranceProofId,
  state: "ACTIVE",
  validFrom: "2026-09-01T00:00:00.000Z",
};

test("a standing policy covers only the refund it describes: origin, phase, scope, validity and state (CMD032 'referenced rather than invented')", () => {
  const balance = refundableBalance(capture("COMPLETED", { serviceCents: 97125n, taxCents: 18454n, excessCents: 97125n }), ZERO_COMPONENTS);
  const full = { serviceCents: 97125n, taxCents: 18454n, excessCents: 0n };
  const at = "2026-09-24T12:00:00.000Z";
  assert.equal(policyCovers(policy, { at, origin: "CUSTOMER_REQUEST", phase: "PRE_EXECUTION", balance, requested: full }), true);
  assert.equal(policyCovers(policy, { at, origin: "CUSTOMER_REQUEST", phase: "DURING_EXECUTION", balance, requested: full }), false);
  assert.equal(policyCovers(policy, { at, origin: "CUSTOMER_REQUEST", phase: "PRE_EXECUTION", balance, requested: { ...full, serviceCents: 97124n } }), false);
  assert.equal(policyCovers({ ...policy, state: "RETIRED" }, { at, origin: "CUSTOMER_REQUEST", phase: "PRE_EXECUTION", balance, requested: full }), false);
  assert.equal(policyCovers({ ...policy, validUntil: "2026-09-10T00:00:00.000Z" }, { at, origin: "CUSTOMER_REQUEST", phase: "PRE_EXECUTION", balance, requested: full }), false);
  const excessPolicy: RefundPolicyRecord = { ...policy, policyKind: "EXCESS_CAPTURE_RETURN", refundScope: "EXCESS_ONLY", appliesToPhase: "ANY", appliesToOrigin: "EXCESS_CAPTURE" };
  // a policy of another origin never covers the refund, whatever its amounts
  assert.equal(policyCovers({ ...policy, appliesToOrigin: "KAURO_REMEDY" }, { at, origin: "CUSTOMER_REQUEST", phase: "PRE_EXECUTION", balance, requested: full }), false);
  assert.equal(policyCovers(excessPolicy, { at, origin: "EXCESS_CAPTURE", phase: "POST_DELIVERY", balance, requested: { serviceCents: 0n, taxCents: 0n, excessCents: 97125n } }), true);
  assert.equal(policyCovers(excessPolicy, { at, origin: "CUSTOMER_REQUEST", phase: "POST_DELIVERY", balance, requested: full }), false);
  const bounded: RefundPolicyRecord = { ...policy, refundScope: "BOUNDED", maxRefundCents: 1000n, appliesToPhase: "ANY" };
  assert.equal(policyCovers(bounded, { at, origin: "CUSTOMER_REQUEST", phase: "POST_DELIVERY", balance, requested: { serviceCents: 1000n, taxCents: 0n, excessCents: 0n } }), true);
  assert.equal(policyCovers(bounded, { at, origin: "CUSTOMER_REQUEST", phase: "POST_DELIVERY", balance, requested: { serviceCents: 1001n, taxCents: 0n, excessCents: 0n } }), false);
});

test("the refund authorization and effects digests bind the named preimage", () => {
  const effects = {
    refundId: "01920000-0000-7000-8000-00000000c001",
    captureId: "01920000-0000-7000-8000-00000000c002",
    termsHash: "7".repeat(64),
    deliveryPhase: "PRE_EXECUTION" as const,
    creditNoteRequired: true,
    serviceBasisAfterCents: "0",
    revokesAuthorization: true,
  };
  const effectsHash = refundEffectsHash(effects);
  const preimage = {
    refundId: effects.refundId,
    agencyId: "01920000-0000-7000-8000-00000000c003",
    captureId: effects.captureId,
    ...authorizationPreimageMoney({ serviceCents: 97125n, taxCents: 18454n, excessCents: 0n }),
    reasonCode: "The project was cancelled before processing",
    authorizationKind: "OWNER_STEP_UP" as const,
    authorizationRef: "01920000-0000-7000-8000-00000000c004",
    approvedByUserId: "6f1b0d2e-3c4a-5b5c-9d6e-7f8091a2b3c4",
    approvedAt: "2026-09-24T12:00:00.000Z",
    effectsHash,
  };
  const h = refundAuthorizationHash(preimage);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(refundAuthorizationHash({ ...preimage }), h);
  assert.notEqual(refundAuthorizationHash({ ...preimage, serviceCents: "97124" }), h);
  assert.notEqual(refundAuthorizationHash({ ...preimage, authorizationKind: "STANDING_POLICY" }), h);
  assert.notEqual(refundEffectsHash({ ...effects, creditNoteRequired: false }), effectsHash);
});

test("ledger postings balance, omit zero lines and keep capture, excess, fee and returns on distinct accounts", () => {
  const cap = capturePostings({ serviceCents: 97125n, taxCents: 18454n, excessCents: 0n });
  assert.deepEqual(cap.map((l) => [l.account, l.direction, l.amountCents]), [
    ["PSP_RECEIVABLE", "DEBIT", 115579n],
    ["CONTRACT_LIABILITY", "CREDIT", 97125n],
    ["TAX_PAYABLE", "CREDIT", 18454n],
  ]);
  assert.equal(isBalanced(cap), true);
  // R2-140: the second full capture is entirely an overpayment obligation, never service
  const excess = capturePostings({ serviceCents: 0n, taxCents: 0n, excessCents: 97125n });
  assert.deepEqual(excess.map((l) => [l.account, l.direction, l.amountCents]), [["PSP_RECEIVABLE", "DEBIT", 97125n], ["CUSTOMER_OVERPAYMENT", "CREDIT", 97125n]]);
  const fee = providerFeePostings(5275n, "UNKNOWN", 115579n);
  assert.deepEqual(fee.map((l) => [l.account, l.direction]), [["PROCESSOR_EXPENSE", "DEBIT"], ["PSP_RECEIVABLE", "CREDIT"]]);
  const back = returnPostings({ serviceCents: 20000n, taxCents: 3800n, excessCents: 0n }, "UNKNOWN", 110304n);
  assert.equal(isBalanced(back), true);
  assert.deepEqual(back.at(-1), { account: "PSP_RECEIVABLE", direction: "CREDIT", amountCents: 23800n });
  assert.deepEqual(providerFeePostings(0n, "UNKNOWN", 115579n), []);
  assert.equal(isBalanced([{ account: "PSP_RECEIVABLE", direction: "DEBIT", amountCents: 1n }]), false);
});
