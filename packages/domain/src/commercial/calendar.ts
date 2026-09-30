/**
 * Calendar arithmetic of the commission domain, with no new dependency (design D10-ATTR-2, D10-CAL-1, D10-CLOCK-1; policy
 * commission.calendarMonthRollover CLAMP_DAY_TO_LAST_DAY_OF_DESTINATION_MONTH, operationalTimezone America/Bogota):
 *
 *  - calendar months are added to the wall time of the operational zone, the day clamped to the destination month's last day and
 *    the wall time kept, exactly as PostgreSQL's `(t AT TIME ZONE z + interval 'n months') AT TIME ZONE z` does — never a fixed
 *    number of days (example 11: 29 February 2024 + 12 months is 28 February 2025 at the same wall time);
 *  - a zone's wall time is read through the platform's Intl time-zone data (Node ships full ICU), and a wall time is mapped back
 *    to its instant by the zone's offset at that instant, checked by a round trip;
 *  - banking days are counted over an explicit calendar input: weekends and the listed non-banking dates are excluded, nothing is
 *    guessed (example 21: the fixture is not a live holiday authority; production reads a verified calendar version, B15).
 */
import type { UtcInstant } from "@kauro/contracts";
import { isUtcInstant, toUtcInstant } from "../ports/clock.js";

/** A wall time in a zone: calendar fields, month 1..12. */
interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(zone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    FORMATTERS.set(zone, f);
  }
  return f;
}

/** True when the platform's time-zone data knows the zone. */
export function zoneIsKnown(zone: string): boolean {
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

/** Refuses anything but a canonical UTC instant (YYYY-MM-DDTHH:mm:ss.sssZ): a programming error, never a request error. */
export function assertCanonicalInstant(value: string, what = "instant"): number {
  if (!isUtcInstant(value)) throw new RangeError(`${what} is not a canonical UTC instant`);
  return Date.parse(value);
}

function wallTimeOf(epochMs: number, zone: string): WallTime {
  const parts: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(new Date(epochMs))) if (p.type !== "literal") parts[p.type] = Number(p.value);
  const millisecond = ((epochMs % 1000) + 1000) % 1000;
  return { year: parts["year"] as number, month: parts["month"] as number, day: parts["day"] as number, hour: parts["hour"] as number, minute: parts["minute"] as number, second: parts["second"] as number, millisecond };
}

function wallAsUtcMs(w: WallTime): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, w.millisecond);
}

/** The zone's offset from UTC at an instant, in milliseconds (wall time minus UTC). */
function offsetMsAt(epochMs: number, zone: string): number {
  return wallAsUtcMs(wallTimeOf(epochMs, zone)) - epochMs;
}

function sameWall(a: WallTime, b: WallTime): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === b.second && a.millisecond === b.millisecond;
}

/** The instant of a wall time in a zone; a wall time the zone skips (a forward transition) is refused, never shifted. */
function instantOfWall(w: WallTime, zone: string): number {
  const local = wallAsUtcMs(w);
  let epoch = local - offsetMsAt(local, zone);
  epoch = local - offsetMsAt(epoch, zone);
  if (!sameWall(wallTimeOf(epoch, zone), w)) throw new RangeError("the wall time does not exist in the zone");
  return epoch;
}

/** Days of a month (month 1..12) of the proleptic Gregorian calendar. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * `instant` plus `months` calendar months at the same wall time of `zone`, the day clamped to the destination month's last day
 * (CLAMP_DAY_TO_LAST_DAY_OF_DESTINATION_MONTH). Milliseconds are kept.
 */
export function addCalendarMonths(instant: UtcInstant, months: number, zone: string): UtcInstant {
  if (!Number.isSafeInteger(months)) throw new RangeError("months must be an integer");
  const wall = wallTimeOf(assertCanonicalInstant(instant), zone);
  const index = wall.year * 12 + (wall.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  const day = Math.min(wall.day, daysInMonth(year, month));
  return toUtcInstant(instantOfWall({ ...wall, year, month, day }, zone));
}

/** An instant plus an exact number of hours (D10-CLOCK-1: durations are exact hours, never calendar days). */
export function addHours(instant: UtcInstant, hours: number): UtcInstant {
  if (!Number.isSafeInteger(hours)) throw new RangeError("hours must be an integer");
  return toUtcInstant(assertCanonicalInstant(instant) + hours * 3_600_000);
}

// --- banking days and periods (D10-CAL-1) -------------------------------------------------------------------------------------------

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The explicit calendar a count runs over (a recorded BankingCalendar version's): the non-banking dates besides weekends and the
 * dates the version covers. A day outside [coversFrom, coversTo] is unknown to the version, so it is never counted as a banking day.
 */
export interface BankingDays {
  readonly nonbankingDates: ReadonlyArray<string>;
  readonly coversFrom: string;
  readonly coversTo: string;
}

/** How far a count looks after month-end, as kauro.banking_day_after does (62 days). */
const BANKING_DAY_HORIZON_DAYS = 62;

function parseMonth(month: string): { readonly year: number; readonly month: number } {
  const m = MONTH.exec(month);
  if (m === null) throw new RangeError("a month is YYYY-MM");
  return { year: Number(m[1]), month: Number(m[2]) };
}

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function assertCalendarDate(value: string): void {
  const m = DATE.exec(value);
  if (m === null) throw new RangeError("a calendar date is YYYY-MM-DD");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) throw new RangeError("not a calendar date");
}

/**
 * The `ordinal`-th banking day after the end of `month` (YYYY-MM): counting from the first day of the next month, skipping Saturdays,
 * Sundays and the listed non-banking dates (example 21: with 2026-10-12 listed, the 5th after September 2026 is 2026-10-07 and the
 * 10th 2026-10-15). A weekday of a calendar date is the same in every zone. Null when the calendar does not cover the count — its
 * coverage starts after the first day counted, or ends before the ordinal-th banking day — exactly where the database's
 * kauro.banking_day_after answers NULL (0031), so a period is never dated beyond what a recorded version knows.
 */
export function bankingDayAfterMonthEnd(month: string, ordinal: number, calendar: BankingDays): string | null {
  const { year, month: m } = parseMonth(month);
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 31) throw new RangeError("the ordinal is a banking day 1..31");
  for (const d of calendar.nonbankingDates) assertCalendarDate(d);
  assertCalendarDate(calendar.coversFrom);
  assertCalendarDate(calendar.coversTo);
  if (calendar.coversTo < calendar.coversFrom) throw new RangeError("a calendar covers a range of dates");
  const listed = new Set(calendar.nonbankingDates);
  const first = Date.UTC(year, m, 1);
  const start = new Date(first);
  if (isoDate(start.getUTCFullYear(), start.getUTCMonth() + 1, 1) < calendar.coversFrom) return null;
  let counted = 0;
  for (let offset = 0; offset < BANKING_DAY_HORIZON_DAYS; offset += 1) {
    const day = new Date(first + offset * 86_400_000);
    const weekday = day.getUTCDay();
    const date = isoDate(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
    if (date > calendar.coversTo) return null;
    if (weekday !== 0 && weekday !== 6 && !listed.has(date)) {
      counted += 1;
      if (counted === ordinal) return date;
    }
  }
  return null;
}

/** The instant a calendar month (YYYY-MM) starts at in `zone`: its first day at 00:00 local time. */
export function monthStartsAt(month: string, zone: string): UtcInstant {
  const { year, month: m } = parseMonth(month);
  return toUtcInstant(instantOfWall({ year, month: m, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }, zone));
}

/** The month (YYYY-MM) after `month`. */
export function nextMonth(month: string): string {
  const { year, month: m } = parseMonth(month);
  return m === 12 ? isoDate(year + 1, 1, 1).slice(0, 7) : isoDate(year, m + 1, 1).slice(0, 7);
}
