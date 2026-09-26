// The local fiscal adapter boundary (R2-128 pure half; 15 "FiscalProfile"; R2-082 "no guessed zero VAT"). The tax rates below
// are synthetic reviewed inputs of a test, not statements of an applicable tax rate (reference/COMMERCIAL_LEDGER_WORKED_EXAMPLES
// "A fiscal amount used in an example is an assumed reviewed input").
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  quotableTaxRule,
  resolveFiscalTreatment,
  ruleSnapshotOf,
  taxOf,
  type FiscalIssuerRecord,
  type FiscalIssuerRef,
  type FiscalProfileId,
  type FiscalProfileRecord,
  type AgencyId,
  type UserId,
} from "../src/index.js";

const issuer: FiscalIssuerRecord = {
  issuerRef: "01920000-0000-7000-8000-0000000f0001" as FiscalIssuerRef,
  jurisdiction: "CO",
  legalIdentityHash: "1".repeat(64),
  legalFactStatus: "PROFESSIONALLY_CONFIRMED",
  routeKind: "MANUAL_BRIDGE",
  integrationClass: "CONTRACT_FAKE",
  routeState: "QUALIFIED",
  numberingAuthorizationRef: "01920000-0000-7000-8000-0000000f0002",
  entitlementEvidenceHash: "2".repeat(64),
  validFrom: "2026-09-01T00:00:00.000Z",
};

function profile(overrides: Partial<FiscalProfileRecord>): FiscalProfileRecord {
  return {
    profileId: "01920000-0000-7000-8000-0000000f0100" as FiscalProfileId,
    agencyId: "01920000-0000-7000-8000-0000000a0001" as AgencyId,
    operatorLegalRef: issuer.issuerRef,
    customerLegalRef: "01920000-0000-7000-8000-0000000c0001",
    serviceClassification: "DATA_PREPARATION_SERVICE",
    territory: "US",
    taxTreatment: "DOMESTIC_TAXABLE",
    taxRule: "RATE_HALF_UP",
    taxRateBps: 1900,
    evidenceHash: "3".repeat(64),
    reviewedByUserId: "6f1b0d2e-3c4a-5b5c-9d6e-7f8091a2b3c4" as UserId,
    validFrom: "2026-09-01T00:00:00.000Z",
    recordedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

const TAX_POINT = "2026-09-24T12:00:00.000Z";

test("R2-128: two sales with the same USD amount and foreign-looking customers get the reviewed treatment or a block — never an inferred exemption", () => {
  // sale A: domestic taxable under a reviewed rule (synthetic 1900 bps): 97125 x 1900 = 184537500 -> +5000 -> 18454
  const domestic = profile({ taxTreatment: "DOMESTIC_TAXABLE", taxRule: "RATE_HALF_UP", taxRateBps: 1900 });
  const a = resolveFiscalTreatment({ profile: domestic, issuer, taxPoint: TAX_POINT, serviceCents: 97125n, priced: ruleSnapshotOf(domestic) });
  assert.deepEqual(a, { kind: "TREATMENT", snapshot: { treatment: "DOMESTIC_TAXABLE", rule: "RATE_HALF_UP", rateBps: 1900 }, taxCents: 18454n });

  // sale B: the customer claims an export (foreign territory, USD) but no professional review exists: blocked, not zero-rated
  const claimed = profile({ territory: "US", taxTreatment: "REVIEW_REQUIRED", taxRule: "UNRESOLVED", taxRateBps: 0 });
  const b = resolveFiscalTreatment({ profile: claimed, issuer, taxPoint: TAX_POINT, serviceCents: 97125n, priced: null });
  assert.deepEqual(b, { kind: "BLOCKED", blocker: "FISCAL_TREATMENT_UNREVIEWED" });

  // control: the same export claim once reviewed (export evidence present) emits the reviewed exemption
  const reviewedExport = profile({ taxTreatment: "EXEMPT_EXPORT", taxRule: "ZERO_REVIEWED", taxRateBps: 0, exportEvidenceHash: "4".repeat(64) });
  const c = resolveFiscalTreatment({ profile: reviewedExport, issuer, taxPoint: TAX_POINT, serviceCents: 97125n, priced: ruleSnapshotOf(reviewedExport) });
  assert.deepEqual(c, { kind: "TREATMENT", snapshot: { treatment: "EXEMPT_EXPORT", rule: "ZERO_REVIEWED", rateBps: 0 }, taxCents: 0n });

  // the boundary receives no currency, address or email: the territory label alone never changes a reviewed conclusion
  const domesticUs = resolveFiscalTreatment({ profile: profile({ territory: "US" }), issuer, taxPoint: TAX_POINT, serviceCents: 97125n, priced: ruleSnapshotOf(domestic) });
  const domesticCo = resolveFiscalTreatment({ profile: profile({ territory: "CO" }), issuer, taxPoint: TAX_POINT, serviceCents: 97125n, priced: ruleSnapshotOf(domestic) });
  assert.deepEqual(domesticUs, domesticCo);
});

test("validation blockers in order: effectiveness, issuer binding, issuer facts, and a treatment changed after pricing", () => {
  const ok = profile({});
  const priced = ruleSnapshotOf(ok);
  const run = (p: FiscalProfileRecord, i: FiscalIssuerRecord = issuer, pr = priced) => resolveFiscalTreatment({ profile: p, issuer: i, taxPoint: TAX_POINT, serviceCents: 1000n, priced: pr });
  assert.equal(run(ok).kind, "TREATMENT");
  assert.deepEqual(run(profile({ validFrom: "2026-10-01T00:00:00.000Z" })), { kind: "BLOCKED", blocker: "FISCAL_PROFILE_NOT_EFFECTIVE" });
  assert.deepEqual(run(profile({ validUntil: "2026-09-20T00:00:00.000Z" })), { kind: "BLOCKED", blocker: "FISCAL_PROFILE_NOT_EFFECTIVE" });
  assert.deepEqual(run(profile({ supersededAt: "2026-09-23T00:00:00.000Z" })), { kind: "BLOCKED", blocker: "FISCAL_PROFILE_NOT_EFFECTIVE" });
  assert.deepEqual(run(profile({ operatorLegalRef: "01920000-0000-7000-8000-0000000f0999" as FiscalIssuerRef })), { kind: "BLOCKED", blocker: "FISCAL_ISSUER_MISMATCH" });
  assert.deepEqual(run(ok, { ...issuer, legalFactStatus: "OWNER_DECLARED" }), { kind: "BLOCKED", blocker: "ISSUER_FACTS_UNCONFIRMED" });
  const { numberingAuthorizationRef: _unused, ...noNumbering } = issuer;
  assert.deepEqual(run(ok, noNumbering), { kind: "BLOCKED", blocker: "ISSUER_FACTS_UNCONFIRMED" });
  // priced as an exemption, reviewed afterwards as taxable: a reviewed correction is needed, never a silent re-tax
  assert.deepEqual(run(ok, issuer, { treatment: "EXEMPT_EXPORT", rule: "ZERO_REVIEWED", rateBps: 0 }), { kind: "BLOCKED", blocker: "FISCAL_TREATMENT_CHANGED" });
});

test("tax is computed only by a reviewed rule; the unknown carries no rule and quoting is blocked", () => {
  assert.equal(taxOf(97125n, { treatment: "DOMESTIC_TAXABLE", rule: "RATE_HALF_UP", rateBps: 1900 }), 18454n);
  assert.equal(taxOf(97125n, { treatment: "OTHER_REVIEWED", rule: "ZERO_REVIEWED", rateBps: 0 }), 0n);
  assert.throws(() => taxOf(1n, { treatment: "OTHER_REVIEWED", rule: "ZERO_REVIEWED", rateBps: 5 }), RangeError);
  assert.throws(() => taxOf(1n, { treatment: "DOMESTIC_TAXABLE", rule: "RATE_HALF_UP", rateBps: 0 }), RangeError);
  assert.equal(ruleSnapshotOf(profile({ taxTreatment: "REVIEW_REQUIRED", taxRule: "UNRESOLVED", taxRateBps: 0 })), null);
  assert.deepEqual(quotableTaxRule(null, TAX_POINT), { kind: "BLOCKED", blocker: "FISCAL_TREATMENT_UNREVIEWED" });
  assert.deepEqual(quotableTaxRule(profile({ taxTreatment: "REVIEW_REQUIRED", taxRule: "UNRESOLVED", taxRateBps: 0 }), TAX_POINT), { kind: "BLOCKED", blocker: "FISCAL_TREATMENT_UNREVIEWED" });
  assert.deepEqual(quotableTaxRule(profile({}), TAX_POINT), { kind: "RULE", snapshot: { treatment: "DOMESTIC_TAXABLE", rule: "RATE_HALF_UP", rateBps: 1900 } });
});
