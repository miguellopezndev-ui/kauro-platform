/**
 * The outreach calendar of package B12 (plan docs/design/B12-outreach-plan.md A10, decision D-B12O-6a). R2 names no outreach
 * calendar; the nearest rules are 17 "Business-day calendar" ("exclude weekends and the actual applicable banking/public holidays
 * ... Do not substitute a fixed number of calendar days or an unverified weekday-only approximation") and 18 "Support coverage"
 * (Monday through Friday, America/Bogota, excluding the applicable local holidays). Outreach reaches US prospects from a
 * Colombian company, so both calendars apply (the conservative union): an instant is an outreach business instant iff
 *  - its civil date in America/Bogota is a weekday that is not a Colombian public holiday (COLOMBIA_HOLIDAYS, support/holidays.ts),
 *  - and its civil date in America/New_York is a weekday that is not an actual US federal public holiday: 5 U.S.C. 6103(a) and the
 *    observed day of 6103(b)(1) ("Instead of a holiday that occurs on a Saturday, the Friday immediately before is a legal public
 *    holiday") and E.O. 11582 s.3(a) (a Sunday holiday is observed the next Monday). Inauguration Day (6103(c), DC area only) is
 *    excluded.
 * The database judges the calendar (kauro.outreach_calendar_days, seeded by migration 0088 from exactly these lists; the seed test
 * compares them); this module is the one source of the lists and the read model's rendering. Outside the covered years every
 * answer is null (KC037 OUTREACH_CALENDAR_UNAVAILABLE), never a guess.
 */
import { COLOMBIA_HOLIDAYS, type DateKey } from "../../support/holidays.js";

export const OUTREACH_CALENDAR_VERSION = "OUTREACH-CAL-2026.10";
export const OUTREACH_CALENDAR_FIRST_YEAR = 2026;
export const OUTREACH_CALENDAR_LAST_YEAR = 2028;
export const OUTREACH_CALENDAR_SOURCE = Object.freeze({
  colombia: "Ley 51 de 1983, Ley 2578 de 2026 (COLOMBIA_HOLIDAYS CO-HOLIDAYS-2026.09), read 2026-09-29",
  unitedStates: "5 U.S.C. 6103(a), 6103(b)(1); Executive Order 11582 s.3(a); retrieved 2026-10-14",
});

const DAY_MS = 86_400_000;
const key = (ms: number): DateKey => new Date(ms).toISOString().slice(0, 10);

/** The n-th (1-based) given weekday (0 = Sunday) of a month, or the last one when n = -1. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  if (n === -1) {
    const last = Date.UTC(year, month, 0);
    return last - ((new Date(last).getUTCDay() - weekday + 7) % 7) * DAY_MS;
  }
  const first = Date.UTC(year, month - 1, 1);
  return first + (((weekday - new Date(first).getUTCDay() + 7) % 7) + (n - 1) * 7) * DAY_MS;
}

/** The observed day of a fixed-date federal holiday: Saturday -> the Friday before, Sunday -> the Monday after. */
function observed(ms: number): number {
  const d = new Date(ms).getUTCDay();
  return d === 6 ? ms - DAY_MS : d === 0 ? ms + DAY_MS : ms;
}

/** The actual US federal holidays observed in a calendar year (dates of that year only; 2027-12-31 observes 2028-01-01). */
export function usFederalHolidays(year: number): ReadonlyArray<DateKey> {
  const days = new Set<number>();
  for (const y of [year, year + 1]) {
    for (const [m, d] of [[1, 1], [6, 19], [7, 4], [11, 11], [12, 25]] as const) days.add(observed(Date.UTC(y, m - 1, d)));
  }
  days.add(nthWeekday(year, 1, 1, 3)); // Birthday of Martin Luther King, Jr.
  days.add(nthWeekday(year, 2, 1, 3)); // Washington's Birthday
  days.add(nthWeekday(year, 5, 1, -1)); // Memorial Day
  days.add(nthWeekday(year, 9, 1, 1)); // Labor Day
  days.add(nthWeekday(year, 10, 1, 2)); // Columbus Day
  days.add(nthWeekday(year, 11, 4, 4)); // Thanksgiving Day
  return [...days].map(key).filter((k) => k.startsWith(`${year}-`)).sort();
}

export type OutreachZone = "CO" | "US";

/** Every civil date of the covered years with its business flag per zone (the seed of kauro.outreach_calendar_days). */
export function outreachCalendarDays(): ReadonlyArray<{ readonly zone: OutreachZone; readonly day: DateKey; readonly business: boolean }> {
  const out: Array<{ zone: OutreachZone; day: DateKey; business: boolean }> = [];
  const co = new Set<DateKey>();
  const us = new Set<DateKey>();
  for (let y = OUTREACH_CALENDAR_FIRST_YEAR; y <= OUTREACH_CALENDAR_LAST_YEAR; y++) {
    for (const d of COLOMBIA_HOLIDAYS.holidaysOf(y)) co.add(d);
    for (const d of usFederalHolidays(y)) us.add(d);
  }
  for (let ms = Date.UTC(OUTREACH_CALENDAR_FIRST_YEAR, 0, 1); ms <= Date.UTC(OUTREACH_CALENDAR_LAST_YEAR, 11, 31); ms += DAY_MS) {
    const day = key(ms);
    const weekday = new Date(ms).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    out.push({ zone: "CO", day, business: !weekend && !co.has(day) });
    out.push({ zone: "US", day, business: !weekend && !us.has(day) });
  }
  return out;
}

/** The civil date of an instant in a zone. */
function civilDate(at: Date, zone: OutreachZone): DateKey {
  const tz = zone === "CO" ? "America/Bogota" : "America/New_York";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

let flags: ReadonlyMap<string, boolean> | null = null;
function flagOf(zone: OutreachZone, day: DateKey): boolean | null {
  if (flags === null) flags = new Map(outreachCalendarDays().map((r) => [`${r.zone}:${r.day}`, r.business]));
  return flags.get(`${zone}:${day}`) ?? null;
}

/** True when the instant is an outreach business instant; null outside the covered years (KC037). */
export function isOutreachBusinessInstant(at: Date): boolean | null {
  const co = flagOf("CO", civilDate(at, "CO"));
  const us = flagOf("US", civilDate(at, "US"));
  if (co === null || us === null) return null;
  return co && us;
}

/**
 * The instant n outreach business days after `at` at the same instant of day: the n-th k >= 1 such that at + k days is a business
 * instant (plan A11: a follow-up opens at first + 5 business days); null when the walk leaves the covered years.
 */
export function outreachBusinessDaysAfter(at: Date, n: number): Date | null {
  let found = 0;
  for (let k = 1; k <= 366; k++) {
    const t = new Date(at.getTime() + k * DAY_MS);
    const b = isOutreachBusinessInstant(t);
    if (b === null) return null;
    if (b && ++found === n) return t;
  }
  return null;
}
