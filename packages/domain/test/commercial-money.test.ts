// The commission arithmetic of package B10 against the worked examples' integer cents (reference/COMMERCIAL_LEDGER_WORKED_EXAMPLES
// examples 1, 2, 4, 6, 7, 8 and 23; 17 "Commission basis", "Refunds after payout and negative balances", "Performance and
// compensation evolution"; design D10-POOL-1, D10-ADJ-1, D10-ADJ-2, D10-NEG-1, D10-GUARD-1). Every amount is computed over B09's
// money kernel, never a second rounding; the expected cents are the examples' hand-calculated values written here, never read
// back from the function under test (21 "Independent oracles").
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allocatePool,
  applyNegativeBalance,
  baseServiceCents,
  commissionBasis,
  commissionPoolCents,
  compensationGuard,
  discountCents,
  entitlementAdjustment,
  linePosition,
  quoteAmounts,
  quoteEligibility,
  recomputePool,
  registryCommissionPolicy,
  registryPricePolicy,
  roundHalfUpBps,
  DomainFailure,
  type CommissionPoolState,
  type ProjectId,
  type RefundComponents,
} from "../src/index.js";

const NO_TAX = { treatment: "EXEMPT_EXPORT", rule: "ZERO_REVIEWED", rateBps: 0 } as const;
const SELLER = "0192a000-0000-7000-8000-00000000000a";
const LINE = "0192a000-0000-7000-8000-0000000000b1";

function allocation(serviceCents: bigint, taxCents = 0n, excessCents = 0n): RefundComponents {
  return { serviceCents, taxCents, excessCents };
}

test("R2-079 (example 1): a first-project pool at 1000 bps on a 97125-cent service collection is 9713 cents rounded half-up once; the 5275-cent processor fee, the collected tax and any excess change nothing in the basis", () => {
  const policy = registryCommissionPolicy();
  assert.equal(policy.firstBps, 1000);
  const basis = commissionBasis({ status: "COMPLETED", allocation: allocation(97125n), providerFeeCents: 5275n, completedServiceRefundCents: 0n });
  assert.equal(basis, 97125n);
  // 97125 x 1000 = 97 125 000; + 5000; floor / 10000 = 9713 (9712.5 rounded half up once)
  assert.equal(commissionPoolCents(basis, 1000), 9713n);
  // the processor fee, the tax collected beside the service and any excess over the obligation never enter the basis
  for (const fee of [undefined, 0n, 5275n, 97125n]) {
    for (const tax of [0n, 18454n]) {
      for (const excess of [0n, 1n, 97125n]) {
        const b = commissionBasis({ status: "COMPLETED", allocation: allocation(97125n, tax, excess), ...(fee === undefined ? {} : { providerFeeCents: fee }), completedServiceRefundCents: 0n });
        assert.equal(b, 97125n, `fee ${fee} tax ${tax} excess ${excess}`);
        assert.equal(commissionPoolCents(b, 1000), 9713n);
      }
    }
  }
  // the fee-net proceeds (91850) would be another basis and another pool: the rule never uses them
  assert.equal(commissionPoolCents(97125n - 5275n, 1000), 9185n);
  // one beneficiary holds the whole pool; one pool, never one per seller
  assert.deepEqual([...allocatePool(9713n, [{ sellerId: SELLER, shareBps: 10_000 }])], [[SELLER, 9713n]]);
  // a reversed capture has a zero basis; a capture not completed has no basis at all
  assert.equal(commissionBasis({ status: "REVERSED", allocation: allocation(97125n), completedServiceRefundCents: 0n }), 0n);
  assert.throws(() => commissionBasis({ status: "PENDING", allocation: allocation(0n), completedServiceRefundCents: 0n }), RangeError);
  assert.throws(() => commissionBasis({ status: "COMPLETED", allocation: allocation(97125n), completedServiceRefundCents: 97126n }), RangeError);
});

test("R2-080 (examples 2 and 6): 129500 at a 500-bps repeat discount is 123025; its 400-bps pool is 4921; after a 20000-cent service refund the cumulative entitlement is 4121 and the adjustment -800; refunding the remaining 103025 posts -4121, so the adjustments sum to -4921", () => {
  const prices = registryPricePolicy();
  const policy = registryCommissionPolicy();
  const base = baseServiceCents(prices, "HUBSPOT", 50_000);
  assert.equal(base, 129500n);
  const quoted = quoteAmounts({ baseServiceCents: base as bigint, discountBps: 500, tax: NO_TAX });
  assert.equal(quoted.discountCents, 6475n);
  assert.equal(quoted.serviceCents, 123025n);
  assert.equal(policy.repeatBps, 400);
  const basis = commissionBasis({ status: "COMPLETED", allocation: allocation(123025n), completedServiceRefundCents: 0n });
  assert.equal(commissionPoolCents(basis, 400), 4921n);

  const accrued: CommissionPoolState = { basisCents: 123025n, rateBps: 400, lines: [{ lineId: LINE, sellerId: SELLER, shareBps: 10_000, cumulativeCents: 4921n }] };
  const partial = recomputePool(accrued, { kind: "REFUND_COMPLETED", serviceBasisAfterCents: 123025n - 20000n });
  assert.equal(partial.pool.basisCents, 103025n);
  assert.equal(partial.poolCents, 4121n);
  assert.deepEqual(partial.adjustments, [
    { lineId: LINE, sellerId: SELLER, reason: "REFUND", direction: "DECREASE", amountCents: 800n, signedCents: -800n, previousCumulativeCents: 4921n, newCumulativeCents: 4121n },
  ]);
  // B09's kernel posts the same difference: the adjustment is recomputed cumulatively, never a second negative accrual
  assert.equal(entitlementAdjustment(4921n, 103025n, 400), -800n);

  const full = recomputePool(partial.pool, { kind: "REFUND_COMPLETED", serviceBasisAfterCents: 0n });
  assert.equal(full.poolCents, 0n);
  assert.deepEqual(full.adjustments, [
    { lineId: LINE, sellerId: SELLER, reason: "REFUND", direction: "DECREASE", amountCents: 4121n, signedCents: -4121n, previousCumulativeCents: 4121n, newCumulativeCents: 0n },
  ]);
  const total = [...partial.adjustments, ...full.adjustments].reduce((sum, a) => sum + a.signedCents, 0n);
  assert.equal(total, -4921n);
  // the basis only falls (D10-ADJ-2): a replay of the first refund's event, or a reversal after the full refund, adds nothing
  assert.deepEqual(recomputePool(full.pool, { kind: "REFUND_COMPLETED", serviceBasisAfterCents: 103025n }).adjustments, []);
  assert.deepEqual(recomputePool(full.pool, { kind: "CAPTURE_REVERSED" }).adjustments, []);
  // a reversal of the partly refunded capture posts one REVERSAL adjustment to zero
  assert.deepEqual(recomputePool(partial.pool, { kind: "CAPTURE_REVERSED" }).adjustments.map((a) => [a.reason, a.signedCents, a.newCumulativeCents]), [["REVERSAL", -4121n, 0n]]);
});

test("R2-097 (example 8): a 9713-cent pool split 6000/4000 allocates 5828 and 3885, split 5000/5000 between seller_a and seller_b allocates 4857 and 4856, and a one-cent pool at 3333/3333/3334 gives the cent to the third; every allocation sums to the pool after each cumulative refund down to zero", () => {
  const sixty = "0192a000-0000-7000-8000-000000000061";
  const forty = "0192a000-0000-7000-8000-000000000040";
  const split = allocatePool(9713n, [{ sellerId: sixty, shareBps: 6000 }, { sellerId: forty, shareBps: 4000 }]);
  assert.equal(split.get(sixty), 5828n);
  assert.equal(split.get(forty), 3885n);
  // 50/50: floors 4856 and 4856 leave one cent, equal remainders, the byte-order tie-break gives it to seller_a (input order irrelevant)
  const halves = allocatePool(9713n, [{ sellerId: "seller_b", shareBps: 5000 }, { sellerId: "seller_a", shareBps: 5000 }]);
  assert.equal(halves.get("seller_a"), 4857n);
  assert.equal(halves.get("seller_b"), 4856n);
  // a one-cent pool: the third beneficiary's remainder (0.3334) is the largest, whatever its id's order
  const cent = allocatePool(1n, [{ sellerId: "seller_a", shareBps: 3333 }, { sellerId: "seller_b", shareBps: 3333 }, { sellerId: "seller_c", shareBps: 3334 }]);
  assert.deepEqual([cent.get("seller_a"), cent.get("seller_b"), cent.get("seller_c")], [0n, 0n, 1n]);
  // two sellers share one pool: never two 10 % pools
  assert.equal([...split.values()].reduce((s, v) => s + v, 0n), 9713n);
  // a split must be whole: 9999 or 10001 bps is refused SHARES_NOT_WHOLE
  for (const shares of [[6000, 3999], [6000, 4001]]) {
    assert.throws(
      () => allocatePool(9713n, [{ sellerId: sixty, shareBps: shares[0] as number }, { sellerId: forty, shareBps: shares[1] as number }]),
      (e: unknown) => e instanceof DomainFailure && e.code === "PRECONDITION_FAILED" && e.reason === "SHARES_NOT_WHOLE",
    );
  }

  // cumulative refunds of the 97125-cent first purchase down to zero: every step reallocates the recomputed pool exactly
  let state: CommissionPoolState = {
    basisCents: 97125n,
    rateBps: 1000,
    lines: [
      { lineId: "0192a000-0000-7000-8000-0000000000c1", sellerId: sixty, shareBps: 6000, cumulativeCents: 5828n },
      { lineId: "0192a000-0000-7000-8000-0000000000c2", sellerId: forty, shareBps: 4000, cumulativeCents: 3885n },
    ],
  };
  const posted = new Map<string, bigint>([[sixty, 0n], [forty, 0n]]);
  for (const after of [90000n, 65432n, 20001n, 12345n, 1n, 0n]) {
    const step = recomputePool(state, { kind: "REFUND_COMPLETED", serviceBasisAfterCents: after });
    assert.equal(step.poolCents, roundHalfUpBps(after, 1000), `pool at basis ${after}`);
    assert.equal(step.pool.lines.reduce((s, l) => s + l.cumulativeCents, 0n), step.poolCents, `allocations sum to the pool at basis ${after}`);
    for (const a of step.adjustments) posted.set(a.sellerId, (posted.get(a.sellerId) as bigint) + a.signedCents);
    state = step.pool;
  }
  assert.deepEqual(state.lines.map((l) => l.cumulativeCents), [0n, 0n]);
  // every beneficiary's adjustments total exactly its original allocation: a full refund leaves no residue
  assert.equal(posted.get(sixty), -5828n);
  assert.equal(posted.get(forty), -3885n);
});

test("R2-104 (example 7): a paid 4921-cent line revised to 4121 shows accrual 4921, payout 4921, adjustment -800 and balance -800; a later eligible amount is offset only under SIGNED_FUTURE_OFFSET terms, otherwise the balance is an owner REPAYMENT_REVIEW, WRITE_OFF or DISPUTE item", () => {
  const position = linePosition({ accrualCents: 4921n, adjustmentsCents: [-800n], paidCents: 4921n });
  assert.deepEqual(position, { accrualCents: 4921n, payoutCents: 4921n, adjustmentCents: -800n, balanceCents: -800n });
  // the historical payout stays a real 4921-cent transfer: nothing in the position rewrites it
  assert.equal(position.payoutCents, 4921n);

  // signed future-offset terms: a later 3000-cent eligible amount pays 2200 after the 800 are recovered
  assert.deepEqual(applyNegativeBalance({ balanceCents: -800n, eligibleCents: 3000n, offsetTerms: "SIGNED_FUTURE_OFFSET" }), {
    offsetCents: 800n,
    payableCents: 2200n,
    remainingBalanceCents: 0n,
    recovery: null,
  });
  // an eligible amount smaller than the negative balance is offset to zero and the rest stays visible, carried to the next statement
  assert.deepEqual(applyNegativeBalance({ balanceCents: -800n, eligibleCents: 500n, offsetTerms: "SIGNED_FUTURE_OFFSET" }), {
    offsetCents: 500n,
    payableCents: 0n,
    remainingBalanceCents: -300n,
    recovery: null,
  });
  // no offset terms: the eligible amount is paid in full and the negative balance becomes the owner's contractual resolution item
  assert.deepEqual(applyNegativeBalance({ balanceCents: -800n, eligibleCents: 3000n, offsetTerms: "NONE" }), {
    offsetCents: 0n,
    payableCents: 3000n,
    remainingBalanceCents: -800n,
    recovery: { amountCents: 800n, actions: ["REPAYMENT_REVIEW", "WRITE_OFF", "DISPUTE"] },
  });
  // with nothing eligible and no terms, the item still names the concrete actions: never an indefinite invisible hold
  assert.deepEqual(applyNegativeBalance({ balanceCents: -800n, eligibleCents: 0n, offsetTerms: "NONE" }).recovery, { amountCents: 800n, actions: ["REPAYMENT_REVIEW", "WRITE_OFF", "DISPUTE"] });
  // a non-negative balance offsets nothing and needs no recovery; the payable is never negative (nothing debits the seller)
  assert.deepEqual(applyNegativeBalance({ balanceCents: 0n, eligibleCents: 4121n, offsetTerms: "SIGNED_FUTURE_OFFSET" }), { offsetCents: 0n, payableCents: 4121n, remainingBalanceCents: 0n, recovery: null });
  assert.throws(() => applyNegativeBalance({ balanceCents: 1n, eligibleCents: 0n, offsetTerms: "NONE" }), RangeError);
  // an unpaid line's position is its accrual and adjustments, owed to the seller
  assert.deepEqual(linePosition({ accrualCents: 4921n, adjustmentsCents: [-800n], paidCents: 0n }), { accrualCents: 4921n, payoutCents: 0n, adjustmentCents: -800n, balanceCents: 4121n });
});

test("R2-105 (example 23): a 100000-cent retainer plus 150000 cents of commission against 1500000 cents of attributable net service is 16.67%, EXCEEDS_PLANNING_GUARD above 1500 bps by exact integer comparison, labelled a business planning guard and never a legal ceiling", () => {
  const review = compensationGuard({ retainerCents: 100000n, commissionAccruedCents: 150000n, attributableNetServiceCents: 1500000n });
  assert.deepEqual(review, {
    retainerCents: 100000n,
    commissionAccruedCents: 150000n,
    attributableNetServiceCents: 1500000n,
    ratioBps: 1667n,
    ratioText: "16.67%",
    thresholdBps: 1500,
    result: "EXCEEDS_PLANNING_GUARD",
    label: "BUSINESS_PLANNING_GUARD",
    legalCeiling: false,
    refuses: false,
  });
  // exactly 15 % is within the guard; one cent more exceeds it although its displayed ratio still rounds to 15.00 %
  const at = compensationGuard({ retainerCents: 0n, commissionAccruedCents: 225000n, attributableNetServiceCents: 1500000n });
  assert.deepEqual([at.ratioBps, at.ratioText, at.result], [1500n, "15.00%", "WITHIN_PLANNING_GUARD"]);
  const above = compensationGuard({ retainerCents: 0n, commissionAccruedCents: 225001n, attributableNetServiceCents: 1500000n });
  assert.deepEqual([above.ratioBps, above.ratioText, above.result], [1500n, "15.00%", "EXCEEDS_PLANNING_GUARD"]);
  // 10 % commission alone is within it: the retainer is what moves the full acquisition cost past the guard
  assert.equal(compensationGuard({ retainerCents: 0n, commissionAccruedCents: 150000n, attributableNetServiceCents: 1500000n }).result, "WITHIN_PLANNING_GUARD");
  // no attributable service: any compensation exceeds the guard, none is within it; the ratio is undefined, never a division by zero
  assert.deepEqual(
    [compensationGuard({ retainerCents: 100000n, commissionAccruedCents: 0n, attributableNetServiceCents: 0n })].map((r) => [r.ratioBps, r.ratioText, r.result, r.refuses]),
    [[null, null, "EXCEEDS_PLANNING_GUARD", false]],
  );
  assert.equal(compensationGuard({ retainerCents: 0n, commissionAccruedCents: 0n, attributableNetServiceCents: 0n }).result, "WITHIN_PLANNING_GUARD");
});

test("R2-136 (example 4): a synthetic 1002-cent basis at a 2500-bps discount rounds the 250.5-cent discount once to 251 and nets 751, never 752 by rounding the complementary 7500 bps, and is no price band of the schedule", () => {
  const prices = registryPricePolicy();
  // the founding rate reserved for the quote is the applied rate (MAX_NOT_STACKED over the tier of two prior projects)
  const eligibility = quoteEligibility(prices, {
    asOf: "2026-10-01T15:00:00.000Z",
    qualifyingProjectIds: ["0192a000-0000-7000-8000-0000000000d1" as ProjectId, "0192a000-0000-7000-8000-0000000000d2" as ProjectId],
    founding: { eligible: true, slotReserved: true },
  });
  assert.equal(eligibility.appliedDiscountBps, 2500);
  // 1002 x 2500 = 2 505 000 = 250.5 cents; + 5000; floor / 10000 = 251
  assert.equal(discountCents(1002n, eligibility.appliedDiscountBps), 251n);
  const amounts = quoteAmounts({ baseServiceCents: 1002n, discountBps: eligibility.appliedDiscountBps, tax: NO_TAX });
  assert.equal(amounts.discountCents, 251n);
  assert.equal(amounts.serviceCents, 751n);
  // rounding the complementary 7500 bps of the base gives 752: the forbidden second formula
  assert.equal(roundHalfUpBps(1002n, 7500), 752n);
  assert.notEqual(amounts.serviceCents, roundHalfUpBps(1002n, 7500));
  // the vector is synthetic: no band of the schedule, in any mode, is 1002 cents
  for (const band of prices.bands) for (const cents of Object.values(band.baseCents)) assert.notEqual(cents, 1002n);
});
