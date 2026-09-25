// Exact money and the offer arithmetic of package B09 against hand-calculated oracles (reference/HASHING_AND_ACCOUNTING_RULES
// "Hand-calculated examples"; 16 "Quote calculation"; R2-077, R2-078, R2-081; 21 "Independent oracles": the expected values
// below are literals from the authority, never outputs of the helper under test).
import assert from "node:assert/strict";
import { test } from "node:test";
import { policy } from "@kauro/contracts";
import {
  allocateLargestRemainder,
  baseServiceCents,
  cumulativeEntitlement,
  entitlementAdjustment,
  formatMoney,
  illustrativeProcessorFee,
  isMoneyText,
  parseMoney,
  pricePolicyFrom,
  quoteAmounts,
  quoteTermsHash,
  registryPricePolicy,
  repeatDiscountBps,
  roundHalfUpBps,
  selectDiscount,
  termsMoney,
  DomainFailure,
  type QuoteTermsPreimage,
} from "../src/index.js";

const NO_TAX = { treatment: "EXEMPT_EXPORT", rule: "ZERO_REVIEWED", rateBps: 0 } as const;

test("R2-077: founding HubSpot 1-50k — base 129500, 2500 bps → discount 32375, service 97125, no cent drift", () => {
  const p = registryPricePolicy();
  assert.equal(p.version, "R2-INITIAL");
  const base = baseServiceCents(p, "HUBSPOT", 50_000);
  assert.equal(base, 129500n);
  const selection = selectDiscount(p, { qualifyingCount: 0, foundingSlotReserved: true });
  assert.deepEqual(selection, { repeatDiscountBps: 0, foundingDiscountBps: 2500, appliedDiscountBps: 2500 });
  const a = quoteAmounts({ baseServiceCents: base as bigint, discountBps: selection.appliedDiscountBps, tax: NO_TAX });
  assert.equal(a.discountCents, 32375n);
  assert.equal(a.serviceCents, 97125n);
  assert.equal(a.totalCents, 97125n);
  // the float path the rule forbids drifts on the same inputs only by luck; the integer path is exact for every basis
  for (let b = 1; b <= 200_000; b += 7) {
    assert.equal(roundHalfUpBps(BigInt(b), 2500), BigInt(Math.floor((b * 2500 + 5000) / 10000)), `basis ${b}`);
  }
});

test("16 worked quotes: band boundary 50000 / 50001 and the 5 / 10 / 15 percent repeat tiers of the first HubSpot band", () => {
  const p = registryPricePolicy();
  assert.equal(baseServiceCents(p, "HUBSPOT", 50_000), 129500n);
  assert.equal(baseServiceCents(p, "HUBSPOT", 50_001), 199500n);
  assert.equal(baseServiceCents(p, "CLEAN", 1), 69500n);
  assert.equal(baseServiceCents(p, "SALESFORCE", 1_000_000), 499500n);
  // zero units never create a minimum-price sale; beyond the last band is the future schedule, not an offer (16)
  assert.equal(baseServiceCents(p, "CLEAN", 0), null);
  assert.equal(baseServiceCents(p, "CLEAN", 1_000_001), null);
  const tiers: Array<[number, number]> = [[0, 0], [1, 500], [9, 500], [10, 1000], [24, 1000], [25, 1500], [400, 1500]];
  for (const [count, bps] of tiers) assert.equal(repeatDiscountBps(p, count), bps, `count ${count}`);
  const service = (bps: number) => quoteAmounts({ baseServiceCents: 129500n, discountBps: bps, tax: NO_TAX }).serviceCents;
  assert.equal(service(500), 123025n); // USD 1,230.25
  assert.equal(service(1000), 116550n); // USD 1,165.50
  assert.equal(service(1500), 110075n); // USD 1,100.75
  // discounts select the maximum eligible rate, never a sum (a founding agency with repeat history gets 25 %, not 30 %)
  assert.equal(selectDiscount(p, { qualifyingCount: 3, foundingSlotReserved: true }).appliedDiscountBps, 2500);
  assert.equal(selectDiscount(p, { qualifyingCount: 30, foundingSlotReserved: false }).appliedDiscountBps, 1500);
});

test("R2-078: illustrative PSP fee on 97125 at 540 bps + 30 is 5275, net 91850 (half up once)", () => {
  const out = illustrativeProcessorFee(97125n, { rateBps: 540, fixedCents: 30n });
  assert.equal(out.feeCents, 5275n);
  assert.equal(out.netCents, 91850n);
  // 97125 x 540 = 52447500 -> +5000 -> 5245 (floor), + 30 fixed
  assert.equal(roundHalfUpBps(97125n, 540), 5245n);
});

test("half-up boundaries and the representable envelope", () => {
  assert.equal(roundHalfUpBps(1n, 5000), 1n); // 0.5 rounds up
  assert.equal(roundHalfUpBps(1n, 4999), 0n);
  assert.equal(roundHalfUpBps(3n, 5000), 2n); // 1.5 -> 2
  assert.equal(roundHalfUpBps(0n, 10000), 0n);
  assert.throws(() => roundHalfUpBps(-1n, 100), RangeError);
  assert.throws(() => roundHalfUpBps(1n, 10001), RangeError);
  assert.throws(() => roundHalfUpBps(1n, 1.5), RangeError);
  assert.equal(parseMoney("serviceCents", "97125"), 97125n);
  assert.equal(formatMoney(9007199254740991n), "9007199254740991");
  for (const bad of ["-1", "01", "1.0", "", "9007199254740992", "1e3"]) {
    assert.equal(isMoneyText(bad), false, bad);
    assert.throws(() => parseMoney("serviceCents", bad), (e: unknown) => e instanceof DomainFailure && e.code === "INVALID_REQUEST");
  }
  assert.throws(() => parseMoney("serviceCents", 97125), (e: unknown) => e instanceof DomainFailure && e.details.fields?.[0]?.code === "TYPE");
});

test("largest-remainder allocation: 101 over 6000/4000 is 61/40; one cent over 50/50 goes to the lower id; shares always sum", () => {
  const a = allocateLargestRemainder(101n, [{ key: "seller_a", weight: 6000n }, { key: "seller_b", weight: 4000n }]);
  assert.deepEqual([a.get("seller_a"), a.get("seller_b")], [61n, 40n]);
  const b = allocateLargestRemainder(1n, [{ key: "seller_b", weight: 5000n }, { key: "seller_a", weight: 5000n }]);
  assert.deepEqual([b.get("seller_a"), b.get("seller_b")], [1n, 0n]);
  // worked example 8: USD 97.13 split 50/50 -> 48.57 / 48.56 with the byte-order tie-break
  const c = allocateLargestRemainder(9713n, [{ key: "seller_a", weight: 5000n }, { key: "seller_b", weight: 5000n }]);
  assert.deepEqual([c.get("seller_a"), c.get("seller_b")], [4857n, 4856n]);
  // one cent over 33.33 / 33.33 / 33.34 goes to the largest fractional remainder
  const d = allocateLargestRemainder(1n, [{ key: "a", weight: 3333n }, { key: "b", weight: 3333n }, { key: "c", weight: 3334n }]);
  assert.deepEqual([d.get("a"), d.get("b"), d.get("c")], [0n, 0n, 1n]);
  for (let total = 0n; total < 500n; total += 13n) {
    const s = allocateLargestRemainder(total, [{ key: "service", weight: 97125n }, { key: "tax", weight: 18454n }]);
    assert.equal((s.get("service") as bigint) + (s.get("tax") as bigint), total);
  }
});

test("R2-080 arithmetic kernel: 4 % of 123025 is 4921; after a 20000 service refund 4121; the adjustment is -800", () => {
  assert.equal(cumulativeEntitlement(123025n, 400), 4921n);
  assert.equal(cumulativeEntitlement(103025n, 400), 4121n);
  assert.equal(entitlementAdjustment(4921n, 103025n, 400), -800n);
  assert.equal(cumulativeEntitlement(97125n, 1000), 9713n); // R2-079 first commission
});

test("R2-081: one-cent service refunds down to zero leave exactly zero cumulative entitlement and no residue", () => {
  const rate = 1000;
  let basis = 97125n;
  let posted = cumulativeEntitlement(basis, rate);
  assert.equal(posted, 9713n);
  let adjustments = 0n;
  let naiveRefunds = 0n; // the defect the cumulative rule prevents: rounding each refund on its own
  while (basis > 0n) {
    basis -= 1n;
    const adjustment = entitlementAdjustment(posted, basis, rate);
    adjustments += adjustment;
    posted += adjustment;
    naiveRefunds += roundHalfUpBps(1n, rate);
  }
  assert.equal(basis, 0n);
  assert.equal(posted, 0n);
  assert.equal(adjustments, -9713n, "every adjustment together reverses exactly the original entitlement");
  assert.equal(naiveRefunds, 0n, "per-refund rounding would have removed nothing and left a 9713-cent residue");
});

test("quote terms hash: KAURO_QUOTE_TERMS_V1 over the named preimage; any amount, date or version change moves it", () => {
  const amounts = quoteAmounts({ baseServiceCents: 129500n, discountBps: 2500, tax: NO_TAX });
  const terms: QuoteTermsPreimage = {
    quoteId: "01920000-0000-7000-8000-00000000a001",
    agencyId: "01920000-0000-7000-8000-00000000a002",
    projectId: "01920000-0000-7000-8000-00000000a003",
    planId: "01920000-0000-7000-8000-00000000a004",
    approvalId: "01920000-0000-7000-8000-00000000a005",
    planHash: "a".repeat(64),
    revisionHash: "b".repeat(64),
    targetContractHash: "c".repeat(64),
    mode: "HUBSPOT",
    billableUnits: 50000,
    pricePolicyVersion: "R2-INITIAL",
    discountPolicyVersion: "R2-INITIAL",
    eligibilitySnapshotId: "01920000-0000-7000-8000-00000000a006",
    ...termsMoney(amounts),
    fiscalProfileId: "01920000-0000-7000-8000-00000000a007",
    taxTreatment: "EXEMPT_EXPORT",
    taxRule: "ZERO_REVIEWED",
    taxRateBps: 0,
    currency: "USD",
    issuedAt: "2026-09-24T12:00:00.000Z",
    expiresAt: "2026-10-08T12:00:00.000Z",
    sourceAvailableUntil: "2026-10-01T12:00:00.000Z",
    termsVersion: "TERMS-2026-09",
  };
  assert.equal(terms.serviceCents, "97125");
  const h = quoteTermsHash(terms);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(quoteTermsHash({ ...terms }), h);
  assert.notEqual(quoteTermsHash({ ...terms, totalCents: "97126" }), h);
  assert.notEqual(quoteTermsHash({ ...terms, sourceAvailableUntil: "2026-10-02T12:00:00.000Z" }), h);
  assert.notEqual(quoteTermsHash({ ...terms, termsVersion: "TERMS-2026-10" }), h);
});

test("the price policy is read from the registry and a malformed policy refuses to price", () => {
  const raw = policy() as Record<string, unknown>;
  const p = pricePolicyFrom(raw);
  assert.equal(p.bands.length, 4);
  assert.equal(p.quoteDays, 14);
  assert.equal(p.repeatLookbackDays, 365);
  assert.equal(p.foundingDiscountBps, 2500);
  const pricing = raw["pricing"] as Record<string, unknown>;
  assert.throws(() => pricePolicyFrom({ ...raw, pricing: { ...pricing, discountCombination: "SUM" } }), TypeError);
  assert.throws(() => pricePolicyFrom({ ...raw, pricing: { ...pricing, bands: [] } }), TypeError);
  assert.throws(() => pricePolicyFrom({ ...raw, money: { currency: "EUR", minorUnit: 2, rounding: "HALF_UP_ON_NONNEGATIVE_RATIONAL" } }), TypeError);
});
