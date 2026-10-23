/**
 * The US FedACH banking-day calendar the pending-payment hold counts on (CP-01.11 evidence.calendar, retrieved 2026-10-22): banking days
 * are Monday to Friday except Federal Reserve holidays; a holiday on a Saturday leaves the preceding Friday open; a holiday on a Sunday
 * closes the following Monday. It applies to the US ACH route only, never to another route.
 *
 * Decision O27A-CAL-1 (the implementing order fixes zone and cut-off, CP-01.11 pending point 6): days are calendar days of
 * America/New_York (the FedACH operating zone); a day ends at 00:00 New York time of the next day. The holidays are derived from the
 * statutory rules of 5 U.S.C. 6103 and are produced as an explicit `BankingDays` version (`FEDACH-RULE-1`), the same shape a recorded
 * calendar version has, so a recorded version can replace it without changing the count. Pure: no clock.
 */
import type { BankingDays } from "../commercial/calendar.js";

export const FEDACH_ZONE = "America/New_York";
export const FEDACH_CALENDAR_VERSION = "FEDACH-RULE-1";

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The n-th (1-based) weekday (0 Sunday .. 6 Saturday) of a month; n = -1 is the last one. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return lastDay - ((last - weekday + 7) % 7);
}

/** The eleven Federal Reserve holidays of a year, on their calendar dates (before the weekend rule). */
export function federalReserveHolidays(year: number): ReadonlyArray<{ readonly name: string; readonly date: string }> {
  if (!Number.isSafeInteger(year) || year < 2021 || year > 2199) throw new RangeError("a FedACH year is 2021..2199 (Juneteenth exists from 2021)");
  return [
    { name: "NEW_YEARS_DAY", date: iso(year, 1, 1) },
    { name: "BIRTHDAY_OF_MARTIN_LUTHER_KING_JR", date: iso(year, 1, nthWeekday(year, 1, 1, 3)) },
    { name: "WASHINGTONS_BIRTHDAY", date: iso(year, 2, nthWeekday(year, 2, 1, 3)) },
    { name: "MEMORIAL_DAY", date: iso(year, 5, nthWeekday(year, 5, 1, -1)) },
    { name: "JUNETEENTH", date: iso(year, 6, 19) },
    { name: "INDEPENDENCE_DAY", date: iso(year, 7, 4) },
    { name: "LABOR_DAY", date: iso(year, 9, nthWeekday(year, 9, 1, 1)) },
    { name: "COLUMBUS_DAY", date: iso(year, 10, nthWeekday(year, 10, 1, 2)) },
    { name: "VETERANS_DAY", date: iso(year, 11, 11) },
    { name: "THANKSGIVING_DAY", date: iso(year, 11, nthWeekday(year, 11, 4, 4)) },
    { name: "CHRISTMAS_DAY", date: iso(year, 12, 25) },
  ];
}

/**
 * The non-banking weekdays of a year: each holiday on a weekday, and the Monday after a holiday on a Sunday. A Saturday holiday closes
 * nothing (the Reserve Banks open the preceding Friday; the federal-employee rule that moves it to Friday does not apply).
 */
export function fedAchClosedWeekdays(year: number): ReadonlyArray<string> {
  const out: string[] = [];
  for (const h of federalReserveHolidays(year)) {
    const [y, m, d] = h.date.split("-").map(Number) as [number, number, number];
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (weekday === 0) {
      const monday = new Date(Date.UTC(y, m - 1, d + 1));
      out.push(iso(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate()));
    } else if (weekday !== 6) out.push(h.date);
  }
  return out.sort();
}

/** The FEDACH-RULE-1 calendar for [fromYear, toYear]: covers exactly those years. */
export function fedAchCalendar(fromYear: number, toYear: number): BankingDays {
  if (toYear < fromYear) throw new RangeError("a calendar covers a range of years");
  const dates: string[] = [];
  for (let y = fromYear; y <= toYear; y += 1) dates.push(...fedAchClosedWeekdays(y));
  return Object.freeze({ nonbankingDates: Object.freeze(dates), coversFrom: iso(fromYear, 1, 1), coversTo: iso(toYear, 12, 31) });
}

/** True when a calendar date (YYYY-MM-DD) is a banking day of the calendar; null when the calendar does not cover it. */
export function isBankingDay(date: string, calendar: BankingDays): boolean | null {
  if (date < calendar.coversFrom || date > calendar.coversTo) return null;
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !calendar.nonbankingDates.includes(date);
}

/** The `count`-th banking day strictly after `date`; null when the calendar does not cover the count (never guessed). */
export function nthBankingDayAfter(date: string, count: number, calendar: BankingDays): string | null {
  if (!Number.isSafeInteger(count) || count < 1 || count > 60) throw new RangeError("a banking-day count is 1..60");
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  let counted = 0;
  for (let offset = 1; offset <= 120; offset += 1) {
    const day = new Date(Date.UTC(y, m - 1, d + offset));
    const next = iso(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
    const banking = isBankingDay(next, calendar);
    if (banking === null) return null;
    if (banking) {
      counted += 1;
      if (counted === count) return next;
    }
  }
  return null;
}

// --- zone arithmetic (the same round-trip method as commercial/calendar.ts) ------------------------------------------------------------

const FORMAT = new Intl.DateTimeFormat("en-US", { timeZone: FEDACH_ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

function wallOf(epochMs: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const p: Record<string, number> = {};
  for (const part of FORMAT.formatToParts(new Date(epochMs))) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { y: p["year"] as number, mo: p["month"] as number, d: p["day"] as number, h: p["hour"] as number, mi: p["minute"] as number, s: p["second"] as number };
}

/** The New York calendar date of an instant. */
export function fedAchDateOf(epochMs: number): string {
  const w = wallOf(epochMs);
  return iso(w.y, w.mo, w.d);
}

/** The instant 00:00 New York time of a calendar date starts at (midnight always exists in America/New_York). */
export function fedAchDayStartsAt(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const local = Date.UTC(y, m - 1, d);
  const offsetAt = (ms: number): number => {
    const w = wallOf(ms);
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
  };
  let epoch = local - offsetAt(local);
  epoch = local - offsetAt(epoch);
  if (fedAchDateOf(epoch) !== date || wallOf(epoch).h !== 0) throw new RangeError("midnight does not exist in the zone");
  return epoch;
}

/** The instant the calendar day after `date` starts at: the exclusive end of `date` (decision O27A-CAL-1). */
export function fedAchDayEndsAt(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return fedAchDayStartsAt(iso(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()));
}
