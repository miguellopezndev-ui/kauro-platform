// O27A: the FedACH calendar (CP-01.11 evidence.calendar, decision O27A-CAL-1) and the pending-payment hold (CP-01.11, activation OFF).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  O27A_ACTIVATION,
  PENDING_PAYMENT_HOLD_POLICY,
  endedUnpaidInWindow,
  fedAchCalendar,
  fedAchClosedWeekdays,
  fedAchDayEndsAt,
  holdDates,
  holdEnding,
  isBankingDay,
  lateCreditTreatment,
  nthBankingDayAfter,
  requestHold,
  type HoldRecord,
  type QuoteForHold,
  type TransferProof,
} from "../src/index.js";

const CAL = fedAchCalendar(2023, 2028);
const ON = { ...O27A_ACTIVATION, pendingPaymentHold: true };

test("O27A-CAL: the 2026 FedACH closures match the Federal Reserve's published 2026 schedule", () => {
  assert.deepEqual(fedAchClosedWeekdays(2026), ["2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25"]);
  // Independence Day 2026 is a Saturday: the Reserve Banks open Friday 3 July (the federal-employee rule does not apply)
  assert.equal(isBankingDay("2026-07-03", CAL), true);
});

test("O27A-CAL: a Sunday holiday closes the Monday after; a Saturday holiday closes nothing", () => {
  const y2027 = fedAchClosedWeekdays(2027);
  assert.ok(y2027.includes("2027-07-05"), "4 July 2027 is a Sunday");
  assert.ok(!y2027.includes("2027-06-18") && !y2027.includes("2027-12-24"), "19 June and 25 December 2027 are Saturdays");
  assert.ok(fedAchClosedWeekdays(2023).includes("2023-01-02"));
  assert.ok(!fedAchClosedWeekdays(2023).includes("2023-11-10"));
  assert.equal(isBankingDay("2026-10-24", CAL), false, "Saturday");
  assert.equal(isBankingDay("2030-01-02", CAL), null, "outside the version: unknown, never guessed");
});

test("O27A-CAL: counts skip weekends and holidays and refuse to count beyond the version", () => {
  assert.equal(nthBankingDayAfter("2026-10-22", 5, CAL), "2026-10-29");
  assert.equal(nthBankingDayAfter("2026-10-09", 5, CAL), "2026-10-19", "Columbus Day 12 Oct is skipped");
  assert.equal(nthBankingDayAfter("2026-11-24", 5, CAL), "2026-12-02", "Thanksgiving 26 Nov is skipped");
  assert.equal(nthBankingDayAfter("2028-12-28", 5, CAL), null);
  // the day ends at 00:00 New York of the next day, across the DST change (EDT -4, EST -5)
  assert.equal(new Date(fedAchDayEndsAt("2026-10-29")).toISOString(), "2026-10-30T04:00:00.000Z");
  assert.equal(new Date(fedAchDayEndsAt("2026-11-05")).toISOString(), "2026-11-06T05:00:00.000Z");
});

test("O27A-HOLD: effective end is the earlier of five banking days and 24 days from sealing; the extension never adds", () => {
  const base = { sealedAt: "2026-10-20T12:00:00.000Z", extensionEndsAt: null, calendar: CAL };
  assert.deepEqual(holdDates({ ...base, acceptedAt: "2026-10-22T19:00:00.000Z" }), {
    businessDaysEndAt: "2026-10-30T04:00:00.000Z",
    ceilingAt: "2026-11-13T12:00:00.000Z",
    effectiveEndAt: "2026-10-30T04:00:00.000Z",
    whichApplied: "BUSINESS_DAYS",
  });
  // the acceptance's New York date is what counts: 01:00Z on the 23rd is still the 22nd in New York
  assert.equal(holdDates({ ...base, acceptedAt: "2026-10-23T01:00:00.000Z" })?.businessDaysEndAt, "2026-10-30T04:00:00.000Z");
  const ceiling = holdDates({ ...base, sealedAt: "2026-10-10T00:00:00.000Z", acceptedAt: "2026-10-29T15:00:00.000Z" });
  assert.equal(ceiling?.effectiveEndAt, "2026-11-03T00:00:00.000Z");
  assert.equal(ceiling?.whichApplied, "CEILING");
  const ext = holdDates({ ...base, acceptedAt: "2026-10-22T19:00:00.000Z", extensionEndsAt: "2026-11-01T00:00:00.000Z" });
  assert.equal(ext?.effectiveEndAt, "2026-11-01T00:00:00.000Z", "the later date applies, not the sum");
  assert.equal(ext?.whichApplied, "EXTENSION");
  const capped = holdDates({ ...base, acceptedAt: "2026-10-22T19:00:00.000Z", extensionEndsAt: "2026-12-31T00:00:00.000Z" });
  assert.equal(capped?.effectiveEndAt, "2026-11-13T12:00:00.000Z", "within the absolute ceiling");
});

const quote: QuoteForHold = {
  quoteId: "q1",
  organizationId: "org1",
  sealedSetId: "s1",
  amountCents: 125_000n,
  currency: "USD",
  reference: "KAURO-ABCD-1234",
  sealedAt: "2026-10-20T12:00:00.000Z",
  extensionEndsAt: null,
  paid: false,
};
const proof: TransferProof = { route: "ACH", currency: "USD", amountCents: 125_000n, reference: "KAURO-ABCD-1234", sentAt: "2026-10-22T14:00:00.000Z" };
const NOW = "2026-10-22T19:00:00.000Z";
const ask = (over: Partial<Parameters<typeof requestHold>[0]> = {}) => requestHold({ quote, proof, stepUpFresh: true, now: NOW, existing: [], calendar: CAL, activation: ON, ...over });

test("O27A-HOLD: OFF by default — nothing is granted without the activation", () => {
  assert.equal(O27A_ACTIVATION.pendingPaymentHold, false);
  assert.deepEqual(requestHold({ quote, proof, stepUpFresh: true, now: NOW, existing: [], calendar: CAL }), { kind: "REFUSED", reason: "HOLD_NOT_ACTIVE" });
});

test("O27A-HOLD: granted with its dates; never a payment and never an execution authority", () => {
  const d = ask();
  assert.equal(d.kind, "GRANTED");
  if (d.kind !== "GRANTED") return;
  assert.equal(d.hold.effectiveEndAt, "2026-10-30T04:00:00.000Z");
  assert.equal(d.hold.isPayment, false);
  assert.equal(d.hold.authorizesExecution, false);
  assert.equal(PENDING_PAYMENT_HOLD_POLICY.isPayment, false);
});

test("O27A-HOLD: the proof is a transfer already sent with the exact amount, reference, route and currency, under step-up", () => {
  assert.deepEqual(ask({ stepUpFresh: false }), { kind: "REFUSED", reason: "STEP_UP_REQUIRED" });
  assert.deepEqual(ask({ proof: { ...proof, amountCents: 124_999n } }), { kind: "REFUSED", reason: "AMOUNT_MISMATCH" });
  assert.deepEqual(ask({ proof: { ...proof, amountCents: 125_001n } }), { kind: "REFUSED", reason: "AMOUNT_MISMATCH" });
  assert.deepEqual(ask({ proof: { ...proof, reference: "KAURO-ABCD-1235" } }), { kind: "REFUSED", reason: "REFERENCE_MISMATCH" });
  assert.deepEqual(ask({ proof: { ...proof, route: "WIRE" } }), { kind: "REFUSED", reason: "ROUTE_NOT_ACH" });
  assert.deepEqual(ask({ proof: { ...proof, currency: "COP" } }), { kind: "REFUSED", reason: "CURRENCY_NOT_USD" });
  assert.deepEqual(ask({ proof: { ...proof, sentAt: "2026-10-23T00:00:00.000Z" } }), { kind: "REFUSED", reason: "TRANSFER_NOT_SENT_YET" });
  assert.deepEqual(ask({ quote: { ...quote, paid: true } }), { kind: "REFUSED", reason: "QUOTE_ALREADY_PAID" });
});

const hold = (over: Partial<HoldRecord>): HoldRecord => ({ holdId: "h", organizationId: "org1", quoteId: "qx", sealedSetId: "sx", state: "ENDED_UNPAID", effectiveEndAt: "2026-10-01T00:00:00.000Z", endedAt: "2026-10-01T00:00:00.000Z", ...over });

test("O27A-HOLD abuse: one per quote and one per sealed set, ever (never renewable), whatever the earlier hold's state", () => {
  for (const state of ["ACTIVE", "PAID", "ENDED_UNPAID"] as const) {
    assert.deepEqual(ask({ existing: [hold({ quoteId: "q1", state })] }), { kind: "REFUSED", reason: "HOLD_EXISTS_FOR_QUOTE" });
    // a new quote over the same sealed set does not buy a second hold
    assert.deepEqual(ask({ existing: [hold({ sealedSetId: "s1", state })] }), { kind: "REFUSED", reason: "HOLD_EXISTS_FOR_SEALED_SET" });
  }
});

test("O27A-HOLD abuse: the third hold after two ended unpaid in a rolling 90 days needs the owner; older or other organizations do not count", () => {
  const two = [hold({ holdId: "a", endedAt: "2026-09-01T00:00:00.000Z" }), hold({ holdId: "b", quoteId: "qy", sealedSetId: "sy", endedAt: "2026-10-10T00:00:00.000Z" })];
  const d = ask({ existing: two });
  assert.equal(d.kind, "OWNER_REVIEW_REQUIRED");
  const old = [hold({ holdId: "a", endedAt: "2026-07-24T19:00:00.000Z" }), hold({ holdId: "b", quoteId: "qy", sealedSetId: "sy", endedAt: "2026-10-10T00:00:00.000Z" })];
  assert.equal(endedUnpaidInWindow(old, "org1", NOW), 1, "exactly 90 days before is outside the window");
  assert.equal(ask({ existing: old }).kind, "GRANTED");
  const otherOrg = two.map((h) => ({ ...h, organizationId: "org2" }));
  assert.equal(ask({ existing: otherOrg }).kind, "GRANTED");
  const paid = two.map((h) => ({ ...h, state: "PAID" as const }));
  assert.equal(ask({ existing: paid }).kind, "GRANTED");
});

test("O27A-HOLD: a calendar that does not cover the count refuses; a ceiling already passed refuses", () => {
  assert.deepEqual(ask({ calendar: fedAchCalendar(2026, 2026), now: "2026-12-29T15:00:00.000Z", proof: { ...proof, sentAt: "2026-12-29T00:00:00.000Z" }, quote: { ...quote, sealedAt: "2026-12-20T00:00:00.000Z" } }), { kind: "REFUSED", reason: "CALENDAR_UNAVAILABLE" });
  assert.deepEqual(ask({ quote: { ...quote, sealedAt: "2026-09-01T00:00:00.000Z" } }), { kind: "REFUSED", reason: "CEILING_PASSED" });
});

test("O27A-HOLD: ending — only a reconciled payment before the end keeps the data; otherwise DELETE; a late credit is refunded, never revived", () => {
  const h = { state: "ACTIVE" as const, effectiveEndAt: "2026-10-30T04:00:00.000Z" };
  assert.deepEqual(holdEnding(h, { confirmedPaymentAt: null, now: "2026-10-29T00:00:00.000Z" }), { kind: "STILL_ACTIVE" });
  assert.deepEqual(holdEnding(h, { confirmedPaymentAt: "2026-10-28T00:00:00.000Z", now: "2026-10-29T00:00:00.000Z" }), { kind: "PAID" });
  assert.deepEqual(holdEnding(h, { confirmedPaymentAt: null, now: "2026-10-30T04:00:00.000Z" }), { kind: "ENDED_UNPAID", retention: "DELETE" });
  assert.deepEqual(holdEnding(h, { confirmedPaymentAt: "2026-10-30T04:00:00.000Z", now: "2026-10-30T05:00:00.000Z" }), { kind: "ENDED_UNPAID", retention: "DELETE" });
  assert.deepEqual(lateCreditTreatment({ state: "ENDED_UNPAID" }), { kind: "REVIEW_AND_REFUND", revivesData: false });
  assert.throws(() => holdEnding({ ...h, state: "PAID" as never }, { confirmedPaymentAt: null, now: NOW }));
});
