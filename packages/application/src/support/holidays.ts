/**
 * The Colombian public-holiday calendar behind the covered hours of support (B11 D-SUP-4, Q-B11-5). The list is derived from the
 * statutory rules, never typed year by year, so a wrong entry is a wrong rule the tests can name; the calendar states its version,
 * its years and its source, and answers nothing outside those years (the caller fails closed instead of guessing a date).
 *
 * Rules (dates are civil dates in America/Bogota; a holiday belongs to the date, not to an instant):
 *  - fixed: January 1, May 1, July 20, August 7, December 8, December 25;
 *  - moved to the next Monday (Ley 51 de 1983; a Monday stays): January 6, March 19, June 29, July 9 (Ley 2578 de 2026),
 *    August 15, October 12, November 1, November 11;
 *  - from Easter Sunday: Holy Thursday (-3) and Good Friday (-2); Ascension, Corpus Christi and Sacred Heart, already Mondays
 *    (Easter +43, +64, +71).
 */

/** A civil date as `YYYY-MM-DD`. */
export type DateKey = string;

export interface HolidaySource {
  readonly law: string;
  readonly sanctioned: string;
  readonly publisher: string;
  readonly url: string;
  readonly readOn: string;
  readonly note: string;
}

export interface HolidayCalendar {
  /** The versioned name of the calendar; a change of rule or of years is a new version. */
  readonly version: string;
  readonly firstYear: number;
  readonly lastYear: number;
  readonly source: HolidaySource;
  /** True when the calendar can answer for the year of this civil date. */
  covers(date: DateKey): boolean;
  /** The holidays of a year in date order; empty outside the calendar's years. */
  holidaysOf(year: number): ReadonlyArray<DateKey>;
  /** True when the date is a holiday; false outside the calendar's years (check `covers` first). */
  isHoliday(date: DateKey): boolean;
}

const DAY_MS = 86_400_000;

function key(ms: number): DateKey {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Easter Sunday of a Gregorian year (Meeus/Jones/Butcher), as milliseconds at 00:00 UTC of the civil date. */
export function easterSundayMs(year: number): number {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(year, month - 1, day);
}

/** The Monday on or after a date (a Monday stays where it is). */
function mondayOnOrAfter(ms: number): number {
  const weekday = new Date(ms).getUTCDay();
  return ms + ((8 - weekday) % 7) * DAY_MS;
}

const FIXED: ReadonlyArray<readonly [month: number, day: number]> = [
  [1, 1],
  [5, 1],
  [7, 20],
  [8, 7],
  [12, 8],
  [12, 25],
];
const MOVED_TO_MONDAY: ReadonlyArray<readonly [month: number, day: number]> = [
  [1, 6],
  [3, 19],
  [6, 29],
  [7, 9],
  [8, 15],
  [10, 12],
  [11, 1],
  [11, 11],
];
/** Days from Easter Sunday: Holy Thursday, Good Friday, Ascension, Corpus Christi, Sacred Heart. */
const FROM_EASTER: ReadonlyArray<number> = [-3, -2, 43, 64, 71];

/** The statutory holidays of a year, in date order and without duplicates. */
export function colombianHolidays(year: number): ReadonlyArray<DateKey> {
  const days = new Set<number>();
  for (const [month, day] of FIXED) days.add(Date.UTC(year, month - 1, day));
  for (const [month, day] of MOVED_TO_MONDAY) days.add(mondayOnOrAfter(Date.UTC(year, month - 1, day)));
  const easter = easterSundayMs(year);
  for (const offset of FROM_EASTER) days.add(easter + offset * DAY_MS);
  return [...days].sort((a, b) => a - b).map(key);
}

/** The record of where the calendar's rules and its newest entry come from (D-SUP-4). */
export const COLOMBIA_HOLIDAY_SOURCE: HolidaySource = Object.freeze({
  law: "Ley 51 de 1983 (holidays moved to Monday) and Ley 2578 de 2026 (July 9 becomes a national holiday, moved to Monday)",
  sanctioned: "2026-06-01",
  publisher: "Ministerio del Interior de Colombia",
  url: "https://www.mininterior.gov.co/noticias/gobierno-sanciona-ley-que-convierte-el-9-de-julio-en-nuevo-festivo-nacional/",
  readOn: "2026-09-29",
  note: "The 2026 rest day of July 9 is Monday 2026-07-13; the 2026 list of this calendar matches the published lists.",
});

export const COLOMBIA_CALENDAR_VERSION = "CO-HOLIDAYS-2026.09";
const FIRST_YEAR = 2026;
const LAST_YEAR = 2030;

function yearOf(date: DateKey): number | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? Number(date.slice(0, 4)) : null;
}

function buildCalendar(): HolidayCalendar {
  const byYear = new Map<number, ReadonlyArray<DateKey>>();
  for (let year = FIRST_YEAR; year <= LAST_YEAR; year++) byYear.set(year, Object.freeze(colombianHolidays(year)));
  const all = new Set<DateKey>([...byYear.values()].flat());
  return Object.freeze({
    version: COLOMBIA_CALENDAR_VERSION,
    firstYear: FIRST_YEAR,
    lastYear: LAST_YEAR,
    source: COLOMBIA_HOLIDAY_SOURCE,
    covers(date: DateKey): boolean {
      const year = yearOf(date);
      return year !== null && year >= FIRST_YEAR && year <= LAST_YEAR;
    },
    holidaysOf(year: number): ReadonlyArray<DateKey> {
      return byYear.get(year) ?? [];
    },
    isHoliday(date: DateKey): boolean {
      return all.has(date);
    },
  });
}

export const COLOMBIA_HOLIDAYS: HolidayCalendar = buildCalendar();
