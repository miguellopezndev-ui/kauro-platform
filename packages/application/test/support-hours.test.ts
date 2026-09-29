// The severity table, the sourced Colombian holiday calendar and the covered-hours calculator behind CMD044 (B11 D-SUP-4): pure
// functions, so every boundary of the window is pinned with a literal instant. America/Bogota is UTC-5, so 15:20Z is 10:20 there.
import assert from "node:assert/strict";
import { test } from "node:test";
import { policy, type UtcInstant } from "@kauro/contracts";
import { DomainFailure, SUPPORT_CATEGORIES, SUPPORT_SEVERITIES } from "@kauro/domain";
import {
  BOGOTA_OFFSET_MS,
  COLOMBIA_CALENDAR_VERSION,
  COLOMBIA_HOLIDAYS,
  COLOMBIA_HOLIDAY_SOURCE,
  SUPPORT_SEVERITY_BY_CATEGORY,
  SupportPolicyError,
  colombianHolidays,
  easterSundayMs,
  nextReviewAt,
  severityOf,
  supportWindowOf,
} from "../src/index.js";

const window = supportWindowOf(policy()["support"]);
const at = (iso: string): UtcInstant => iso as UtcInstant;
const review = (severity: "S1" | "S2" | "S3" | "S4", iso: string): string => nextReviewAt(severity, at(iso), window);

test("the category decides the severity: SECURITY and PRIVACY S2, PRODUCT_DEFECT and BILLING S3, IMPORT_GUIDANCE and GENERAL S4", () => {
  assert.deepEqual(
    SUPPORT_CATEGORIES.map((c) => [c, severityOf(c)]),
    [
      ["PRODUCT_DEFECT", "S3"],
      ["IMPORT_GUIDANCE", "S4"],
      ["BILLING", "S3"],
      ["PRIVACY", "S2"],
      ["SECURITY", "S2"],
      ["GENERAL", "S4"],
    ],
  );
  assert.deepEqual(Object.keys(SUPPORT_SEVERITY_BY_CATEGORY).sort(), [...SUPPORT_CATEGORIES].sort());
  for (const severity of Object.values(SUPPORT_SEVERITY_BY_CATEGORY)) assert.ok(SUPPORT_SEVERITIES.includes(severity));
  assert.ok(Object.isFrozen(SUPPORT_SEVERITY_BY_CATEGORY));
});

test("the window is read from the registry policy support.* and a policy the calculator cannot honor is refused", () => {
  assert.deepEqual({ ...window, days: [...window.days] }, { timezone: "America/Bogota", days: ["MON", "TUE", "WED", "THU", "FRI"], startHour: 9, endHour: 17 });
  const support = policy()["support"] as Record<string, unknown>;
  const refused = (override: Record<string, unknown>) => assert.throws(() => supportWindowOf({ ...support, ...override }), SupportPolicyError, JSON.stringify(override));
  refused({ timezone: "UTC" });
  refused({ timezone: "America/New_York" });
  refused({ days: [] });
  refused({ days: ["MON", "MON"] });
  refused({ days: ["MON", "FUNDAY"] });
  refused({ days: "MON" });
  refused({ start: "09:30" });
  refused({ start: "9:00" });
  refused({ end: 17 });
  refused({ start: "17:00", end: "09:00" });
  refused({ start: "09:00", end: "09:00" });
  refused({ end: "25:00" });
  assert.throws(() => supportWindowOf(undefined), SupportPolicyError);
  assert.throws(() => supportWindowOf(null), SupportPolicyError);
  assert.throws(() => supportWindowOf("Bogota"), SupportPolicyError);
});

test("Easter Sunday of the calendar's years", () => {
  const easter = (year: number) => new Date(easterSundayMs(year)).toISOString().slice(0, 10);
  assert.deepEqual([2026, 2027, 2028, 2029, 2030].map(easter), ["2026-04-05", "2027-03-28", "2028-04-16", "2029-04-01", "2030-04-21"]);
});

test("the 2026 holidays are the nineteen statutory days, July 9 moved to Monday July 13 by Ley 2578 de 2026", () => {
  assert.deepEqual(colombianHolidays(2026), [
    "2026-01-01", "2026-01-12", "2026-03-23", "2026-04-02", "2026-04-03", "2026-05-01", "2026-05-18", "2026-06-08", "2026-06-15", "2026-06-29",
    "2026-07-13", "2026-07-20", "2026-08-07", "2026-08-17", "2026-10-12", "2026-11-02", "2026-11-16", "2026-12-08", "2026-12-25",
  ]);
});

test("the 2027 holidays follow the same rules: a Tuesday date moves to the next Monday, a Sunday date to the day after", () => {
  assert.deepEqual(colombianHolidays(2027), [
    "2027-01-01", "2027-01-11", "2027-03-22", "2027-03-25", "2027-03-26", "2027-05-01", "2027-05-10", "2027-05-31", "2027-06-07", "2027-07-05",
    "2027-07-12", "2027-07-20", "2027-08-07", "2027-08-16", "2027-10-18", "2027-11-01", "2027-11-15", "2027-12-08", "2027-12-25",
  ]);
});

test("every year of the calendar lists distinct dates in order, and only fixed dates and Holy Week fall outside a Monday", () => {
  const fixed = new Set(["01-01", "05-01", "07-20", "08-07", "12-08", "12-25"]);
  for (let year = COLOMBIA_HOLIDAYS.firstYear; year <= COLOMBIA_HOLIDAYS.lastYear; year++) {
    const days = colombianHolidays(year);
    assert.deepEqual([...days], [...new Set(days)].sort(), `${year} is ordered and has no duplicate`);
    assert.deepEqual(COLOMBIA_HOLIDAYS.holidaysOf(year), days);
    const easter = easterSundayMs(year);
    const holyWeek = new Set([easter - 3 * 86_400_000, easter - 2 * 86_400_000].map((ms) => new Date(ms).toISOString().slice(0, 10)));
    for (const day of days) {
      const monday = new Date(`${day}T00:00:00.000Z`).getUTCDay() === 1;
      assert.ok(monday || fixed.has(day.slice(5)) || holyWeek.has(day), `${day} is a Monday, a fixed date or Holy Week`);
    }
    assert.ok(days.length >= 18 && days.length <= 19, `${year}: ${days.length} holidays`);
  }
});

test("the calendar names its version, its years and its source, and answers only inside its years", () => {
  assert.equal(COLOMBIA_HOLIDAYS.version, COLOMBIA_CALENDAR_VERSION);
  assert.equal(COLOMBIA_CALENDAR_VERSION, "CO-HOLIDAYS-2026.09");
  assert.deepEqual([COLOMBIA_HOLIDAYS.firstYear, COLOMBIA_HOLIDAYS.lastYear], [2026, 2030]);
  assert.equal(COLOMBIA_HOLIDAYS.source, COLOMBIA_HOLIDAY_SOURCE);
  assert.match(COLOMBIA_HOLIDAY_SOURCE.law, /Ley 2578 de 2026/);
  assert.equal(COLOMBIA_HOLIDAY_SOURCE.sanctioned, "2026-06-01");
  assert.match(COLOMBIA_HOLIDAY_SOURCE.url, /^https:\/\/www\.mininterior\.gov\.co\//);
  assert.match(COLOMBIA_HOLIDAY_SOURCE.readOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Object.isFrozen(COLOMBIA_HOLIDAY_SOURCE));
  assert.equal(COLOMBIA_HOLIDAYS.covers("2026-01-01"), true);
  assert.equal(COLOMBIA_HOLIDAYS.covers("2030-12-31"), true);
  assert.equal(COLOMBIA_HOLIDAYS.covers("2025-12-31"), false);
  assert.equal(COLOMBIA_HOLIDAYS.covers("2031-01-01"), false);
  assert.equal(COLOMBIA_HOLIDAYS.covers("not-a-date"), false);
  assert.deepEqual(COLOMBIA_HOLIDAYS.holidaysOf(2031), []);
  assert.equal(COLOMBIA_HOLIDAYS.isHoliday("2026-07-13"), true);
  assert.equal(COLOMBIA_HOLIDAYS.isHoliday("2026-07-09"), false, "July 9 itself is a Thursday, the rest day is the Monday after");
  assert.equal(COLOMBIA_HOLIDAYS.isHoliday("2026-09-29"), false);
});

test("UTC-5 all year is what the platform's tz database says for America/Bogota, in every year of the calendar", () => {
  assert.equal(BOGOTA_OFFSET_MS, -5 * 3_600_000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (const iso of ["2026-01-15T03:30:00.000Z", "2026-03-29T04:59:00.000Z", "2026-07-01T12:00:00.000Z", "2027-10-31T23:59:00.000Z", "2028-02-29T05:00:00.000Z", "2029-06-15T00:00:00.000Z", "2030-12-31T04:59:00.000Z"]) {
    const local = new Date(Date.parse(iso) + BOGOTA_OFFSET_MS).toISOString();
    const got = Object.fromEntries(parts.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
    assert.equal(`${got["year"]}-${got["month"]}-${got["day"]}T${got["hour"]}:${got["minute"]}`, local.slice(0, 16), iso);
  }
});

test("S2 (and S1): the end of the first covered clock hour that starts at or after the request", () => {
  // Tuesday 2026-09-29
  assert.equal(review("S2", "2026-09-29T15:20:00.000Z"), "2026-09-29T17:00:00.000Z", "10:20 waits for the 11:00 hour and is due at 12:00");
  assert.equal(review("S2", "2026-09-29T15:00:00.000Z"), "2026-09-29T16:00:00.000Z", "10:00 sharp starts the 10:00 hour: due at 11:00");
  assert.equal(review("S2", "2026-09-29T15:00:00.001Z"), "2026-09-29T17:00:00.000Z", "one millisecond past 10:00 waits for the 11:00 hour");
  assert.equal(review("S2", "2026-09-29T13:30:00.000Z"), "2026-09-29T15:00:00.000Z", "08:30 is before the window: the 09:00 hour, due at 10:00");
  assert.equal(review("S2", "2026-09-29T14:00:00.000Z"), "2026-09-29T15:00:00.000Z", "09:00 sharp: due at 10:00");
  assert.equal(review("S2", "2026-09-29T20:59:59.999Z"), "2026-09-29T22:00:00.000Z", "15:59:59.999 still reaches the last covered hour, 16:00-17:00");
  assert.equal(review("S2", "2026-09-29T21:00:00.000Z"), "2026-09-29T22:00:00.000Z", "16:00 sharp is the last covered hour, due at 17:00");
  assert.equal(review("S2", "2026-09-29T21:20:00.000Z"), "2026-09-30T15:00:00.000Z", "16:20 has no covered hour left today: tomorrow 09:00-10:00");
  assert.equal(review("S2", "2026-09-29T22:00:00.000Z"), "2026-09-30T15:00:00.000Z", "17:00 sharp: tomorrow");
  assert.equal(review("S2", "2026-09-30T04:30:00.000Z"), "2026-09-30T15:00:00.000Z", "23:30 of the local Tuesday is due Wednesday 10:00");
  assert.equal(review("S1", "2026-09-29T15:20:00.000Z"), "2026-09-29T17:00:00.000Z", "S1 is reviewed like S2: the policy offers no other hours");
  // weekends, holidays and Holy Week
  assert.equal(review("S2", "2026-10-09T21:30:00.000Z"), "2026-10-13T15:00:00.000Z", "Friday 16:30 skips the weekend and Monday 2026-10-12");
  assert.equal(review("S2", "2026-10-10T17:00:00.000Z"), "2026-10-13T15:00:00.000Z", "Saturday noon waits for Tuesday after the Monday holiday");
  assert.equal(review("S2", "2026-07-20T15:00:00.000Z"), "2026-07-21T15:00:00.000Z", "a holiday itself is not covered (Monday 2026-07-20)");
  assert.equal(review("S2", "2026-07-13T15:00:00.000Z"), "2026-07-14T15:00:00.000Z", "the moved July 9 rest day is not covered (Monday 2026-07-13)");
  assert.equal(review("S2", "2026-04-01T21:30:00.000Z"), "2026-04-06T15:00:00.000Z", "Wednesday of Holy Week 16:30: Thursday and Friday are holidays, so Monday 2026-04-06");
});

test("S3 and S4: 17:00 Bogota of the first covered business day strictly after the request's local date", () => {
  for (const severity of ["S3", "S4"] as const) {
    assert.equal(review(severity, "2026-09-29T15:20:00.000Z"), "2026-09-30T22:00:00.000Z", `${severity}: Tuesday 10:20 is due Wednesday 17:00`);
    assert.equal(review(severity, "2026-09-29T13:00:00.000Z"), "2026-09-30T22:00:00.000Z", `${severity}: before the window, still the next day`);
    assert.equal(review(severity, "2026-09-29T22:30:00.000Z"), "2026-09-30T22:00:00.000Z", `${severity}: after the window, still the next day`);
    assert.equal(review(severity, "2026-09-30T04:30:00.000Z"), "2026-09-30T22:00:00.000Z", `${severity}: 23:30 of the local Tuesday is due the local Wednesday`);
    assert.equal(review(severity, "2026-09-30T05:10:00.000Z"), "2026-10-01T22:00:00.000Z", `${severity}: 00:10 of the local Wednesday is due Thursday`);
    assert.equal(review(severity, "2026-10-09T15:20:00.000Z"), "2026-10-13T22:00:00.000Z", `${severity}: Friday skips the weekend and the Monday holiday`);
    assert.equal(review(severity, "2026-10-10T17:00:00.000Z"), "2026-10-13T22:00:00.000Z", `${severity}: Saturday with a Monday holiday is due Tuesday`);
    assert.equal(review(severity, "2026-09-26T17:00:00.000Z"), "2026-09-28T22:00:00.000Z", `${severity}: Saturday is due Monday`);
    assert.equal(review(severity, "2026-12-24T15:00:00.000Z"), "2026-12-28T22:00:00.000Z", `${severity}: Christmas Day 2026 is a Friday holiday`);
    assert.equal(review(severity, "2026-04-01T15:00:00.000Z"), "2026-04-06T22:00:00.000Z", `${severity}: Holy Thursday and Good Friday are skipped`);
  }
});

test("the calculator accepts a millisecond count as well as an instant", () => {
  assert.equal(nextReviewAt("S3", Date.parse("2026-09-29T15:20:00.000Z"), window), "2026-09-30T22:00:00.000Z");
});

test("outside the calendar's years the calculator fails closed with SUPPORT_CALENDAR_UNAVAILABLE (503, retryable), never a guessed date", () => {
  const unavailable = (run: () => unknown) =>
    assert.throws(run, (e: unknown) => e instanceof DomainFailure && e.code === "CAPACITY_UNAVAILABLE" && e.reason === "SUPPORT_CALENDAR_UNAVAILABLE" && e.status === 503 && e.retryable);
  unavailable(() => review("S3", "2030-12-31T15:00:00.000Z"));
  unavailable(() => review("S2", "2030-12-31T21:30:00.000Z"));
  unavailable(() => review("S2", "2031-01-05T15:00:00.000Z"));
  unavailable(() => review("S4", "2031-01-05T15:00:00.000Z"));
  unavailable(() => review("S2", "2025-06-03T15:00:00.000Z"));
  // the last covered business day of the calendar is answered
  assert.equal(review("S3", "2030-12-30T15:00:00.000Z"), "2030-12-31T22:00:00.000Z");
});

test("an instant that is not a date is refused", () => {
  assert.throws(() => nextReviewAt("S3", at("not a date"), window), (e: unknown) => e instanceof DomainFailure && e.code === "INVALID_REQUEST");
  assert.throws(() => nextReviewAt("S3", Number.NaN, window), (e: unknown) => e instanceof DomainFailure && e.code === "INVALID_REQUEST");
});

test("a window with other hours or days moves the review accordingly", () => {
  const short = supportWindowOf({ ...(policy()["support"] as Record<string, unknown>), start: "10:00", end: "12:00", days: ["TUE", "THU"] });
  // Tuesday 2026-09-29 11:30: the 11:00 hour has begun, the next covered hour is Thursday 10:00-11:00
  assert.equal(nextReviewAt("S2", at("2026-09-29T16:30:00.000Z"), short), "2026-10-01T16:00:00.000Z");
  // Tuesday 10:00 sharp: the 10:00 hour, due at 11:00
  assert.equal(nextReviewAt("S2", at("2026-09-29T15:00:00.000Z"), short), "2026-09-29T16:00:00.000Z");
  // S3 from Tuesday is Thursday, closing at 12:00
  assert.equal(nextReviewAt("S3", at("2026-09-29T15:20:00.000Z"), short), "2026-10-01T17:00:00.000Z");
});
