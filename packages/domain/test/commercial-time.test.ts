// The time rules of package B10 (17 "Recurring entitlement", "Accrual, eligibility and payout", "Business-day calendar"; policy
// commission.recurrenceCalendarMonths, calendarMonthRollover, operationalTimezone, subsequentCutoff,
// eligibilityDaysAfterFinalCompletion, statementBusinessDay, payBusinessDay; reference/COMMERCIAL_LEDGER_WORKED_EXAMPLES examples 10,
// 11, 15 and 21; design D10-ATTR-2, D10-RATE-1, D10-ELIG-1, D10-CAL-1, D10-CLOCK-1). Every expected instant and date below is
// hand-calculated from the example's wall times (America/Bogota is UTC-05:00 all year), never read back from the function.
import assert from "node:assert/strict";
import { test } from "node:test";
import { acquisitionRate, bankingDayAfterMonthEnd, commissionPeriodOf, eligibilityDecision, recurrenceWindowEndsAt, registryCommissionPolicy, type EligibilityFacts } from "../src/index.js";

test("R2-094 (example 11): a first confirmation at 2028-02-29T15:00:00Z (10:00 America/Bogota) ends its window exclusively at 2029-02-28T15:00:00Z and one at 2026-09-12T14:00:00Z at 2027-09-12T14:00:00Z — twelve calendar months at the same wall time with the day clamped, never 365 days", () => {
  const terms = registryCommissionPolicy();
  assert.equal(terms.recurrenceCalendarMonths, 12);
  assert.equal(terms.operationalTimeZone, "America/Bogota");
  assert.equal(recurrenceWindowEndsAt("2028-02-29T15:00:00.000Z", terms), "2029-02-28T15:00:00.000Z");
  assert.equal(recurrenceWindowEndsAt("2026-09-12T14:00:00.000Z", terms), "2027-09-12T14:00:00.000Z");
  // the example's own leap date: 29 February 2024 at 10:00 in Bogota ends at 10:00 on 28 February 2025
  assert.equal(recurrenceWindowEndsAt("2024-02-29T15:00:00.000Z", terms), "2025-02-28T15:00:00.000Z");
  // never 365 days: across a leap day a fixed 8760 h would end a day early (2028-02-29 and 2028-09-11)
  assert.equal(recurrenceWindowEndsAt("2027-03-01T15:00:00.000Z", terms), "2028-03-01T15:00:00.000Z");
  assert.equal(recurrenceWindowEndsAt("2027-09-12T14:00:00.000Z", terms), "2028-09-12T14:00:00.000Z");
  // the wall time and the calendar day are Bogota's, never UTC's: 23:30 on 30 December 2026 in Bogota is 04:30Z on the 31st
  assert.equal(recurrenceWindowEndsAt("2026-12-31T04:30:00.000Z", terms), "2027-12-31T04:30:00.000Z");
  // 02:00Z on 29 February 2028 is still 21:00 on the 28th in Bogota: nothing to clamp, the end is 21:00 on 28 February 2029
  assert.equal(recurrenceWindowEndsAt("2028-02-29T02:00:00.000Z", terms), "2029-03-01T02:00:00.000Z");
  // 23:59:59 on 29 February 2028 in Bogota is 04:59:59Z on 1 March: clamped to 23:59:59 on 28 February 2029
  assert.equal(recurrenceWindowEndsAt("2028-03-01T04:59:59.000Z", terms), "2029-03-01T04:59:59.000Z");
  // the instant keeps its milliseconds; an instant that is not canonical is refused
  assert.equal(recurrenceWindowEndsAt("2026-09-12T14:00:00.123Z", terms), "2027-09-12T14:00:00.123Z");
  assert.throws(() => recurrenceWindowEndsAt("2026-09-12T09:00:00-05:00", terms), RangeError);
});

test("R2-101: eligibility is due 720 hours after a FINAL completion; a STAGE completion starts no clock, and funds not AVAILABLE or a covering hold keep a due line from ELIGIBLE", () => {
  const terms = registryCommissionPolicy();
  assert.equal(terms.eligibilityHoursAfterFinalCompletion, 720);
  const stage = { kind: "STAGE", completedAt: "2026-10-01T15:00:00.000Z" } as const;
  const final = { kind: "FINAL", completedAt: "2026-10-20T15:00:00.000Z" } as const;
  // 720 h after 2026-10-20T15:00:00Z is 2026-11-19T15:00:00Z (thirty days of exactly 24 h)
  const dueAt = "2026-11-19T15:00:00.000Z";
  const facts: EligibilityFacts = { completions: [final], fundsState: "AVAILABLE", unpaidCents: 4921n, openHoldCents: 0n };
  assert.deepEqual(eligibilityDecision(terms, facts, dueAt), { state: "ELIGIBLE", eligibleAt: dueAt });
  assert.deepEqual(eligibilityDecision(terms, facts, "2026-11-19T14:59:59.999Z"), { state: "NOT_DUE", eligibleAt: dueAt });
  // a STAGE completion starts nothing: 720 h after it, and months later, the line still awaits its FINAL completion
  assert.deepEqual(eligibilityDecision(terms, { ...facts, completions: [stage] }, "2026-10-31T15:00:00.000Z"), { state: "AWAITING_FINAL_COMPLETION", eligibleAt: null });
  assert.deepEqual(eligibilityDecision(terms, { ...facts, completions: [stage] }, "2027-06-01T15:00:00.000Z"), { state: "AWAITING_FINAL_COMPLETION", eligibleAt: null });
  assert.deepEqual(eligibilityDecision(terms, { ...facts, completions: [] }, "2027-06-01T15:00:00.000Z"), { state: "AWAITING_FINAL_COMPLETION", eligibleAt: null });
  // stage, then final: the clock is the FINAL completion's, never the STAGE's
  assert.deepEqual(eligibilityDecision(terms, { ...facts, completions: [stage, final] }, "2026-10-31T15:00:00.000Z"), { state: "NOT_DUE", eligibleAt: dueAt });
  assert.deepEqual(eligibilityDecision(terms, { ...facts, completions: [final, stage] }, dueAt), { state: "ELIGIBLE", eligibleAt: dueAt });
  // due, but the capture's funds are HELD by the provider or not yet observed: never ELIGIBLE
  assert.deepEqual(eligibilityDecision(terms, { ...facts, fundsState: "HELD" }, dueAt), { state: "FUNDS_NOT_AVAILABLE", eligibleAt: dueAt, fundsState: "HELD" });
  assert.deepEqual(eligibilityDecision(terms, { ...facts, fundsState: "UNKNOWN" }, dueAt), { state: "FUNDS_NOT_AVAILABLE", eligibleAt: dueAt, fundsState: "UNKNOWN" });
  // due with funds available, but an OPEN hold covers the whole unpaid amount: the line is held; a partial hold leaves it on its path
  assert.deepEqual(eligibilityDecision(terms, { ...facts, openHoldCents: 4921n }, dueAt), { state: "HELD", eligibleAt: dueAt });
  assert.deepEqual(eligibilityDecision(terms, { ...facts, openHoldCents: 1000n }, dueAt), { state: "ELIGIBLE", eligibleAt: dueAt });
  // one completion per purchase and kind: two FINAL completions are a programming error, never the earlier or later one
  assert.throws(() => eligibilityDecision(terms, { ...facts, completions: [final, { kind: "FINAL", completedAt: "2026-10-21T15:00:00.000Z" }] }, dueAt), RangeError);
  assert.throws(() => eligibilityDecision(terms, { ...facts, openHoldCents: 4922n }, dueAt), RangeError);
});

test("R2-138 (example 11): the subsequent rate is 400 bps iff the verified provider completion precedes the exclusive window end — one second before qualifies, exactly at the end does not — whatever the quote, confirmation or notification instant", () => {
  const terms = registryCommissionPolicy();
  assert.deepEqual([terms.firstBps, terms.repeatBps], [1000, 400]);
  // the first qualifying confirmation at 09:00 on 12 September 2026 in Bogota: the window ends at 09:00 on 12 September 2027
  const windowEndsAt = recurrenceWindowEndsAt("2026-09-12T14:00:00.000Z", terms);
  assert.equal(windowEndsAt, "2027-09-12T14:00:00.000Z");
  const orderCreatedAt = "2027-09-01T15:00:00.000Z";
  const notifiedDayLater = "2027-09-13T14:00:00.000Z";
  const at = (providerCompletedAt: string | null, over: { confirmedAt?: string; orderCreatedAt?: string; confirmationSeq?: number } = {}) =>
    acquisitionRate(terms, { confirmationSeq: over.confirmationSeq ?? 2, confirmedAt: over.confirmedAt ?? notifiedDayLater, orderCreatedAt: over.orderCreatedAt ?? orderCreatedAt, providerCompletedAt, windowEndsAt });
  // 08:59:59 in Bogota, confirmed and notified a day later: inside
  assert.deepEqual(at("2027-09-12T13:59:59.000Z"), { kind: "REPEAT", rateBps: 400 });
  assert.deepEqual(at("2027-09-12T13:59:59.999Z"), { kind: "REPEAT", rateBps: 400 });
  // exactly 09:00: outside, however early the quote and the order were
  assert.deepEqual(at("2027-09-12T14:00:00.000Z"), { kind: "NONE", reason: "WINDOW_ENDED" });
  assert.deepEqual(at("2027-09-12T14:00:00.000Z", { orderCreatedAt: "2027-06-01T15:00:00.000Z", confirmedAt: "2027-09-12T14:00:00.000Z" }), { kind: "NONE", reason: "WINDOW_ENDED" });
  // the confirmation or notification instant never substitutes for the provider completion, in either direction
  assert.deepEqual(at("2027-09-12T13:59:59.000Z", { confirmedAt: "2027-09-20T15:00:00.000Z" }), { kind: "REPEAT", rateBps: 400 });
  // example 10: a completion earlier than the first project's own confirmation is still a subsequent project inside the window
  assert.deepEqual(at("2026-09-12T13:00:00.000Z", { orderCreatedAt: "2026-09-12T12:00:00.000Z", confirmedAt: "2026-09-12T14:00:01.000Z" }), { kind: "REPEAT", rateBps: 400 });
  // sequence 1 is the first rate: the provider instant decides only the subsequent cutoff
  assert.deepEqual(at("2027-09-12T14:00:00.000Z", { confirmationSeq: 1 }), { kind: "FIRST", rateBps: 1000 });
  // an implausible or missing provider instant holds the cutoff decision, never guessed from another instant (example 10)
  const held = { kind: "HELD", rateBps: 400, reason: "PROVIDER_TIME_UNVERIFIED" };
  assert.deepEqual(at("2027-09-12T13:59:59.000Z", { confirmedAt: "2027-09-12T13:59:58.000Z" }), held, "completed after its own confirmation");
  assert.deepEqual(at("2027-09-12T13:59:59.000Z", { orderCreatedAt: "2027-09-12T13:59:59.001Z" }), held, "completed before its order existed");
  assert.deepEqual(at(null), held, "no authenticated provider completion");
  assert.throws(() => at("2027-09-12T13:59:59.000Z", { confirmationSeq: 0 }), RangeError);
});

test("R2-139 (example 21): with weekends and 2026-10-12 excluded, the fifth banking day after September 2026 is 2026-10-07 and the tenth 2026-10-15; the same calendar without that holiday gives 2026-10-07 and 2026-10-14", () => {
  const terms = registryCommissionPolicy();
  assert.deepEqual([terms.statementBankingDay, terms.payBankingDay], [5, 10]);
  const fixture = { nonbankingDates: ["2026-10-12"] };
  assert.equal(bankingDayAfterMonthEnd("2026-09", 5, fixture), "2026-10-07");
  assert.equal(bankingDayAfterMonthEnd("2026-09", 10, fixture), "2026-10-15");
  const plain = { nonbankingDates: [] };
  assert.equal(bankingDayAfterMonthEnd("2026-09", 5, plain), "2026-10-07");
  assert.equal(bankingDayAfterMonthEnd("2026-09", 10, plain), "2026-10-14");
  // the first banking day after month-end is the next month's first weekday (Thursday 1 October 2026), never the month's last day
  assert.equal(bankingDayAfterMonthEnd("2026-09", 1, fixture), "2026-10-01");
  // a month ending on a weekend and a listed first of the year: January 2027 starts on Friday 1 January, listed, so the 1st is Monday the 4th
  assert.equal(bankingDayAfterMonthEnd("2026-12", 1, { nonbankingDates: ["2027-01-01"] }), "2027-01-04");
  assert.equal(bankingDayAfterMonthEnd("2026-12", 1, plain), "2027-01-01");
  // a listed weekend day changes nothing: weekends are already excluded
  assert.equal(bankingDayAfterMonthEnd("2026-09", 10, { nonbankingDates: ["2026-10-03", "2026-10-12"] }), "2026-10-15");
  // the period: one calendar month in America/Bogota, [start, end), with its close and pay dates from the explicit calendar
  assert.deepEqual(commissionPeriodOf("2026-09", terms, fixture), {
    month: "2026-09",
    startsAt: "2026-09-01T05:00:00.000Z",
    endsAt: "2026-10-01T05:00:00.000Z",
    closeDueOn: "2026-10-07",
    payDueOn: "2026-10-15",
  });
  assert.deepEqual(commissionPeriodOf("2026-12", terms, plain).endsAt, "2027-01-01T05:00:00.000Z");
  // malformed inputs are programming errors, never a guessed date
  for (const bad of [() => bankingDayAfterMonthEnd("2026-09", 0, plain), () => bankingDayAfterMonthEnd("2026-13", 5, plain), () => bankingDayAfterMonthEnd("2026-9", 5, plain), () => bankingDayAfterMonthEnd("2026-09", 5, { nonbankingDates: ["12/10/2026"] })]) {
    assert.throws(bad, RangeError);
  }
});
