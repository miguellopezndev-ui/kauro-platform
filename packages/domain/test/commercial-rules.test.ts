// The recurrence, founding, residual and prospect rules of package B10 (16 "Recurrence decision", "Founding incentive"; 17 "First
// qualifying project", "Recurring entitlement"; 18 "Prospect qualification"; reference/COMMERCIAL_LEDGER_WORKED_EXAMPLES examples 2,
// 3 and 4; design D10-REC-1, D10-FOUND-3, D10-RATE-1, D10-PROS-1 and section 12). The expected sets, tiers, rates and keys are
// written here from the authority's words, never read back from the function under test (21 "Independent oracles").
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acquisitionRate,
  COMMERCE_FAILURE_REASONS,
  EXECUTION_FAILURE_REASONS,
  AUDIT_FAILURE_REASONS,
  COMMERCIAL_FAILURE_REASONS,
  FAILURE_REASONS,
  foundingEligibility,
  organizationKeyOf,
  qualifyingProjectsAt,
  quoteEligibility,
  recurrenceWindowEndsAt,
  registryCommissionPolicy,
  registryPricePolicy,
  type AgencyId,
  type ProjectId,
  type QualifyingPurchaseFacts,
} from "../src/index.js";
import { TARGET_FAILURE_REASONS } from "../src/model/target-contract.js";
import { IMPORT_STAGE_FAILURE_REASONS } from "../src/model/import-stage.js";
import { CAPABILITY_FAILURE_REASONS } from "../src/model/capability-governance.js";
import { RECOVERY_FAILURE_REASONS } from "../src/model/operations-recovery.js";

const AGENCY = "0192a000-0000-7000-8000-0000000000a1" as AgencyId;
const OTHER_AGENCY = "0192a000-0000-7000-8000-0000000000a2" as AgencyId;
const project = (n: number) => `0192a000-0000-7000-8000-${n.toString(16).padStart(12, "0")}` as ProjectId;
/** Project of End Client A (the agency's first paid project) and of End Client B (the project being quoted). */
const PROJECT_OF_CLIENT_A = project(0xa01);
const PROJECT_OF_CLIENT_B = project(0xb01);

function purchase(projectId: ProjectId, confirmedAt: string, over: Partial<QualifyingPurchaseFacts> = {}): QualifyingPurchaseFacts {
  return { agencyId: AGENCY, projectId, confirmedAt, allocatedServiceCents: 123025n, completedServiceRefundCents: 0n, captureStatus: "COMPLETED", ...over };
}

test("R2-086: the eligibility set of an agency with one qualifying prior project for End Client A counts it for a quote of End Client B's project and selects 500 bps; the quoted project is never in its own set", () => {
  const prices = registryPricePolicy();
  const asOf = "2027-03-01T15:00:00.000Z";
  const history = [purchase(PROJECT_OF_CLIENT_A, "2026-09-12T14:00:00.000Z")];
  // the rule has no end-client input at all: another client's project of the same agency counts
  const set = qualifyingProjectsAt(history, { agencyId: AGENCY, asOf, projectId: PROJECT_OF_CLIENT_B });
  assert.deepEqual(set, [PROJECT_OF_CLIENT_A]);
  const eligibility = quoteEligibility(prices, { asOf, qualifyingProjectIds: set, founding: { eligible: false, slotReserved: false } });
  assert.equal(eligibility.qualifyingCount, 1);
  assert.equal(eligibility.repeatDiscountBps, 500);
  assert.equal(eligibility.appliedDiscountBps, 500);
  assert.equal(eligibility.foundingOffer, "NOT_ELIGIBLE");
  assert.equal(eligibility.lookbackStartsAt, "2026-03-01T15:00:00.000Z");
  // a second paid purchase of the quoted project itself is never in its own set
  const withOwn = [...history, purchase(PROJECT_OF_CLIENT_B, "2026-12-01T15:00:00.000Z")];
  assert.deepEqual(qualifyingProjectsAt(withOwn, { agencyId: AGENCY, asOf, projectId: PROJECT_OF_CLIENT_B }), [PROJECT_OF_CLIENT_A]);
  // quoting End Client A's project again: its own purchase is excluded, the set is empty and the tier 0 bps
  const own = qualifyingProjectsAt(history, { agencyId: AGENCY, asOf, projectId: PROJECT_OF_CLIENT_A });
  assert.deepEqual(own, []);
  assert.equal(quoteEligibility(prices, { asOf, qualifyingProjectIds: own, founding: { eligible: false, slotReserved: false } }).appliedDiscountBps, 0);
  // [as_of - 8760 h, as_of): the lookback start is inside, as_of itself and later are outside; another agency's purchase never counts
  const edge = "2026-03-01T15:00:00.000Z";
  const bounded = [
    purchase(project(0xc01), edge),
    purchase(project(0xc02), "2026-03-01T14:59:59.999Z"),
    purchase(project(0xc03), asOf),
    purchase(project(0xc04), "2027-03-02T15:00:00.000Z"),
    purchase(project(0xc05), "2026-10-01T15:00:00.000Z", { agencyId: OTHER_AGENCY }),
  ];
  assert.deepEqual(qualifyingProjectsAt(bounded, { agencyId: AGENCY, asOf, projectId: PROJECT_OF_CLIENT_B }), [project(0xc01)]);
  // the set only reads confirmed qualifying purchases: an instant that is not canonical is a programming error
  assert.throws(() => qualifyingProjectsAt(history, { agencyId: AGENCY, asOf: "2027-03-01", projectId: PROJECT_OF_CLIENT_B }), RangeError);
});

test("R2-087 and R2-088 (example 4): nine prior qualifying projects select 500 bps, ten 1000, twenty-four 1000 and twenty-five 1500; the current project never counts toward its own threshold and a project counts once however many captures it has", () => {
  const prices = registryPricePolicy();
  const asOf = "2027-06-01T15:00:00.000Z";
  const current = project(0xfff);
  const tierOf = (prior: number): number => {
    const history: QualifyingPurchaseFacts[] = [];
    for (let i = 1; i <= prior; i++) history.push(purchase(project(i), `2027-01-${String(1 + (i % 28)).padStart(2, "0")}T15:00:00.000Z`));
    // the current project's own earlier purchase never counts toward its threshold
    history.push(purchase(current, "2027-02-01T15:00:00.000Z"));
    // the first prior project purchased again after a full refund: two purchases, one project, counted once
    if (prior > 0) {
      history.push(purchase(project(1), "2026-08-01T15:00:00.000Z", { completedServiceRefundCents: 123025n }));
      history.push(purchase(project(1), "2027-04-01T15:00:00.000Z"));
    }
    const set = qualifyingProjectsAt(history, { agencyId: AGENCY, asOf, projectId: current });
    assert.equal(set.length, prior, `${prior} prior projects, each once`);
    assert.equal(new Set(set).size, set.length);
    assert.ok(!set.includes(current), "never the quoted project");
    const e = quoteEligibility(prices, { asOf, qualifyingProjectIds: set, founding: { eligible: false, slotReserved: false } });
    assert.equal(e.qualifyingCount, prior);
    assert.equal(e.appliedDiscountBps, e.repeatDiscountBps);
    return e.repeatDiscountBps;
  };
  assert.equal(tierOf(0), 0);
  assert.equal(tierOf(1), 500);
  assert.equal(tierOf(9), 500);
  assert.equal(tierOf(10), 1000);
  assert.equal(tierOf(24), 1000);
  assert.equal(tierOf(25), 1500);
  assert.equal(tierOf(26), 1500);
  // the snapshot's set is the distinct set: a caller's duplicate id is refused, never counted twice
  assert.throws(() => quoteEligibility(prices, { asOf, qualifyingProjectIds: [project(1), project(1)], founding: { eligible: false, slotReserved: false } }), RangeError);
  // the founding rate is the maximum with the tier, never a sum (MAX_NOT_STACKED), and only with a reserved slot
  const two = [project(1), project(2)];
  const reserved = quoteEligibility(prices, { asOf, qualifyingProjectIds: two, founding: { eligible: true, slotReserved: true } });
  assert.deepEqual([reserved.repeatDiscountBps, reserved.foundingDiscountBps, reserved.appliedDiscountBps, reserved.foundingOffer], [500, 2500, 2500, "RESERVED"]);
  const none = quoteEligibility(prices, { asOf, qualifyingProjectIds: two, founding: { eligible: true, slotReserved: false } });
  assert.deepEqual([none.foundingDiscountBps, none.appliedDiscountBps, none.foundingOffer], [0, 500, "NONE_AVAILABLE"]);
  const twentyFive = Array.from({ length: 25 }, (_, i) => project(i + 1));
  assert.equal(quoteEligibility(prices, { asOf, qualifyingProjectIds: twentyFive, founding: { eligible: true, slotReserved: true } }).appliedDiscountBps, 2500);
  assert.throws(() => quoteEligibility(prices, { asOf, qualifyingProjectIds: two, founding: { eligible: false, slotReserved: true } }), RangeError);
  // founding eligibility (D10-FOUND-3): no qualifying purchase, no reservation in the cohort, a recorded buyer type of either value
  assert.deepEqual(foundingEligibility({ hasQualifyingPurchase: false, hasCohortReservation: false, buyerType: "AGENCY" }), { eligible: true });
  assert.deepEqual(foundingEligibility({ hasQualifyingPurchase: false, hasCohortReservation: false, buyerType: "IN_HOUSE" }), { eligible: true });
  assert.deepEqual(foundingEligibility({ hasQualifyingPurchase: true, hasCohortReservation: false, buyerType: "AGENCY" }), { eligible: false, reason: "QUALIFYING_PURCHASE_EXISTS" });
  assert.deepEqual(foundingEligibility({ hasQualifyingPurchase: false, hasCohortReservation: true, buyerType: "AGENCY" }), { eligible: false, reason: "COHORT_RESERVATION_EXISTS" });
  assert.deepEqual(foundingEligibility({ hasQualifyingPurchase: false, hasCohortReservation: false, buyerType: null }), { eligible: false, reason: "BUYER_TYPE_UNSET" });
});

test("R2-098 (example 3): the buyer's recurrence discount and the seller's residual are decided apart — a discount with a residual, a discount without one after the window, a residual without a discount and neither all occur", () => {
  const prices = registryPricePolicy();
  const terms = registryCommissionPolicy();
  // the seller's window: from the first qualifying confirmation, 09:00 America/Bogota on 12 September 2026, to 09:00 on 12 September 2027
  const first = "2026-09-12T14:00:00.000Z";
  const windowEndsAt = recurrenceWindowEndsAt(first, terms);
  assert.equal(windowEndsAt, "2027-09-12T14:00:00.000Z");
  const p1 = project(0x101);
  const decide = (history: QualifyingPurchaseFacts[], quoted: ProjectId, asOf: string, confirmationSeq: number, providerCompletedAt: string) => {
    const buyer = quoteEligibility(prices, { asOf, qualifyingProjectIds: qualifyingProjectsAt(history, { agencyId: AGENCY, asOf, projectId: quoted }), founding: { eligible: false, slotReserved: false } });
    const confirmedAt = new Date(Date.parse(providerCompletedAt) + 60_000).toISOString();
    const seller = acquisitionRate(terms, { confirmationSeq, confirmedAt, orderCreatedAt: asOf, providerCompletedAt, windowEndsAt });
    return { discountBps: buyer.appliedDiscountBps, residual: seller };
  };

  // 1. a discount with a residual: two qualifying prior projects, the capture completed inside the window
  const a = decide([purchase(p1, first), purchase(project(0x102), "2027-03-01T15:00:00.000Z")], project(0x103), "2027-06-01T15:00:00.000Z", 3, "2027-06-05T15:00:00.000Z");
  assert.deepEqual(a, { discountBps: 500, residual: { kind: "REPEAT", rateBps: 400 } });
  // 2. a discount without a residual: two qualifying projects in the lookback, the capture completed after the window
  const b = decide(
    [purchase(p1, first), purchase(project(0x102), "2027-08-01T15:00:00.000Z"), purchase(project(0x103), "2027-10-01T15:00:00.000Z")],
    project(0x104), "2027-10-15T15:00:00.000Z", 4, "2027-10-20T15:00:00.000Z",
  );
  assert.deepEqual(b, { discountBps: 500, residual: { kind: "NONE", reason: "WINDOW_ENDED" } });
  // 3. a residual without a discount: the only prior project was fully refunded (no loyalty count), the capture inside the window
  const c = decide([purchase(p1, first, { completedServiceRefundCents: 123025n })], project(0x102), "2027-01-10T15:00:00.000Z", 2, "2027-01-12T15:00:00.000Z");
  assert.deepEqual(c, { discountBps: 0, residual: { kind: "REPEAT", rateBps: 400 } });
  // 4. neither: the first project fell out of the 365-day lookback and the capture completed after the window
  const d = decide([purchase(p1, first)], project(0x102), "2027-09-20T15:00:00.000Z", 2, "2027-09-25T15:00:00.000Z");
  assert.deepEqual(d, { discountBps: 0, residual: { kind: "NONE", reason: "WINDOW_ENDED" } });
  // the first qualifying purchase itself earns the first rate, whatever the buyer's discount
  assert.deepEqual(acquisitionRate(terms, { confirmationSeq: 1, confirmedAt: first, orderCreatedAt: "2026-09-10T15:00:00.000Z", providerCompletedAt: "2026-09-12T13:59:00.000Z", windowEndsAt }), { kind: "FIRST", rateBps: 1000 });
});

test("CMD045: the organization key KAURO_PROSPECT_ORGANIZATION_V1 normalizes case, IDNA, a leading www. and a trailing dot, so every spelling of one business domain has one key and a re-imported list maps to the same keys", () => {
  const plain = organizationKeyOf("example.com");
  assert.ok(plain !== null);
  assert.equal(plain.domain, "example.com");
  assert.match(plain.key, /^[0-9a-f]{64}$/);
  for (const spelling of ["Example.COM", "WWW.example.com", "www.Example.com.", "example.com.", "  example.com ", "ｅｘａｍｐｌｅ.com", "www.www.example.com"]) {
    assert.deepEqual(organizationKeyOf(spelling), plain, spelling);
  }
  // IDNA: the Unicode and the ASCII (punycode) spellings of one domain are one organization
  const munich = organizationKeyOf("xn--mnchen-3ya.de");
  assert.ok(munich !== null);
  assert.equal(munich.domain, "xn--mnchen-3ya.de");
  for (const spelling of ["münchen.de", "MÜNCHEN.DE.", "www.München.de", "WWW.XN--MNCHEN-3YA.DE"]) assert.deepEqual(organizationKeyOf(spelling), munich, spelling);
  // distinct domains have distinct keys: a leading www. label is a spelling, any other subdomain or a www-prefixed name is not
  const keys = new Set(["example.com", "example.org", "shop.example.com", "wwwexample.com", "www1.example.com"].map((d) => organizationKeyOf(d)?.key));
  assert.equal(keys.size, 5);
  // the key is the domain-separated digest of the normalized domain, never the bare domain
  assert.notEqual(plain.key, "example.com");
  assert.notEqual(organizationKeyOf("example.com")?.key, organizationKeyOf("example.co")?.key);
  // a re-imported list of the same organizations, spelled otherwise, maps to exactly the same keys
  const imported = ["Example.com", "münchen.de", "Shop.Example.COM."].map((d) => organizationKeyOf(d)?.key);
  const reimported = ["www.EXAMPLE.com.", "XN--MNCHEN-3YA.DE", "shop.example.com"].map((d) => organizationKeyOf(d)?.key);
  assert.deepEqual(reimported, imported);
  // what is not a business domain has no key: empty, a URL, a single label, an address, empty labels, a bad hyphen, a space
  for (const bad of ["", "   ", "https://example.com", "example.com/about", "localhost", "192.168.0.1", "example..com", "-a.com", "a-.com", "exa mple.com", "www.", "."]) {
    assert.equal(organizationKeyOf(bad), null, bad);
  }
});

test("every B10 failure reason of design section 12 is registered once in FAILURE_REASONS and no reason of B06, B07 or B09 is redefined", () => {
  // section 12's new reasons, then the reasons its KC translations name that the list does not repeat (D10-ERR-1)
  const section12 = [
    "BUYER_TYPE_UNSET", "NO_BILLABLE_UNITS", "ENVELOPE_NOT_OFFERED", "BILLING_PROFILE_MISMATCH", "AGREEMENT_VERSION_NOT_PUBLISHED",
    "AGENCY_NOT_DRAFT", "CLOSURE_OBLIGATIONS_UNRECONCILED", "CLOSURE_RESIDUALS_OPEN", "REPLACEMENT_SCOPE_CHANGED",
    "REPLACEMENT_ALLOWANCE_SPENT", "EXECUTION_STARTED", "SELLER_NOT_ACTIVE", "SELLER_NOT_ACTIVATABLE", "AGREEMENT_VERSION_MISMATCH",
    "PROSPECT_EXISTS", "PROSPECT_SUPPRESSED", "SOURCE_EVIDENCE_INVALID", "CLAIM_EVIDENCE_INSUFFICIENT", "CLAIM_EXISTS",
    "CLAIM_NOT_REVIEWABLE", "CLAIM_AFTER_FIRST_ORDER", "ATTRIBUTION_EXISTS", "SHARES_NOT_WHOLE", "IN_HOUSE_NOT_ATTRIBUTABLE",
    "SERVICE_ASSIGNMENT_UNPREPARED", "TAIL_NOT_ENUMERATED", "TERMINATION_TERMS_UNPREPARED", "INPUTS_UNRECONCILED", "LEDGER_CHANGED",
    "PERIOD_NOT_DUE", "PAYEE_UNVERIFIED", "NOTHING_PAYABLE", "FUNDS_UNAVAILABLE", "PAYOUT_EVIDENCE_MISMATCH", "PAYOUT_NOT_SETTLED",
    "OFFSET_NOT_AUTHORIZED", "CALENDAR_UNAVAILABLE", "PAYOUT_EVIDENCE_UNAVAILABLE",
    "DESIGNATION_REWRITE", "COMMISSION_POOL_MISMATCH", "ELIGIBILITY_WITHOUT_FINAL_COMPLETION", "ADJUSTMENT_NOT_CUMULATIVE",
    "RESERVATION_RELEASE_REFUSED",
  ];
  assert.equal(section12.length, 43);
  assert.deepEqual([...COMMERCIAL_FAILURE_REASONS], section12, "the B10 list is section 12's, in its order");
  // later packages append after B10's: B17 (CMD018/CMD019) target-contract reasons, B17 (CMD040/CMD041) import-stage reasons, then B18 (CMD058/CMD059) capability reasons, then the recovery reasons (CMD057)
  const later = [...TARGET_FAILURE_REASONS, ...IMPORT_STAGE_FAILURE_REASONS, ...CAPABILITY_FAILURE_REASONS, ...RECOVERY_FAILURE_REASONS];
  assert.deepEqual(FAILURE_REASONS.slice(FAILURE_REASONS.length - later.length), later, "B17 and B18 tail");
  const all: ReadonlyArray<string> = FAILURE_REASONS.slice(0, FAILURE_REASONS.length - later.length);
  for (const r of section12) {
    assert.equal(all.filter((x) => x === r).length, 1, `${r} is registered exactly once`);
    assert.match(r, /^[A-Z][A-Z0-9_]{2,63}$/);
  }
  // appended after every earlier reason: the B06 and B07 reasons, B09's list and B08's lists (on main before B10, D10-SYNC-3) keep
  // their positions and none is a B10 reason
  assert.deepEqual(all.slice(all.length - section12.length), section12, "appended at the end, once");
  const earlier = all.slice(0, all.length - section12.length);
  const b08 = [...EXECUTION_FAILURE_REASONS, ...AUDIT_FAILURE_REASONS];
  assert.deepEqual(earlier.slice(earlier.length - b08.length), b08, "B08's reasons stand where they stood, after B09's");
  assert.deepEqual(earlier.slice(earlier.length - b08.length - COMMERCE_FAILURE_REASONS.length, earlier.length - b08.length), [...COMMERCE_FAILURE_REASONS], "B09's reasons stand where they stood");
  for (const r of earlier) assert.ok(!section12.includes(r), `${r} is not redefined by B10`);
  assert.equal(new Set(all).size, all.length);
  // the ledger's hold reasons are not failure reasons: a held line is a state, never a refused request
  for (const hold of ["PROVIDER_TIME_UNVERIFIED", "FUNDS_HELD", "PAYOUT_FAILED"]) assert.ok(!all.includes(hold), hold);
});
