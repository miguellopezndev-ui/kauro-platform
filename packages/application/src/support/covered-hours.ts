/**
 * The covered hours of support and the next review of a case (B11 D-SUP-4). The window is the registry policy `support.*`
 * (America/Bogota, MON-FRI, 09:00-17:00); the holidays come from a versioned calendar. The calculator is pure: it takes the
 * instant, the window and the calendar, so a test pins every boundary without a clock.
 *
 *  - S1 and S2: the end of the first covered clock hour that starts at or after the request. (10:20 on a covered day is 12:00;
 *    16:20 is 10:00 of the next covered day; the last covered hour is 16:00-17:00.)
 *  - S3 and S4: 17:00 Bogota of the first covered business day strictly after the request's local date.
 *
 * Colombia has kept UTC-5 all year since 1993, so the local time is the instant minus five hours; the tests compare this rule with
 * the platform's tz database. A window the calculator cannot honor (another zone, minutes, an empty week) is refused at start-up
 * rather than approximated, and a date outside the calendar's years fails closed with SUPPORT_CALENDAR_UNAVAILABLE.
 */
import type { UtcInstant } from "@kauro/contracts";
import { DomainFailure, type SupportSeverity } from "@kauro/domain";
import { COLOMBIA_HOLIDAYS, type DateKey, type HolidayCalendar } from "./holidays.js";

export const SUPPORT_TIMEZONE = "America/Bogota";
/** Local time is UTC minus five hours all year in America/Bogota. */
export const BOGOTA_OFFSET_MS = -5 * 3_600_000;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface SupportWindow {
  readonly timezone: typeof SUPPORT_TIMEZONE;
  readonly days: ReadonlyArray<Weekday>;
  /** Whole hours of the local day: covered hours are startHour..endHour (the last covered hour begins at endHour - 1). */
  readonly startHour: number;
  readonly endHour: number;
}

/** The policy `support` object is not one this calculator can honor. */
export class SupportPolicyError extends Error {
  constructor(message: string) {
    super(`support policy: ${message}`);
    this.name = "SupportPolicyError";
  }
}

function wholeHour(value: unknown, what: string): number {
  const m = typeof value === "string" ? /^(\d{2}):00$/.exec(value) : null;
  const hour = m ? Number(m[1]) : NaN;
  if (!Number.isInteger(hour) || hour < 0 || hour > 24) throw new SupportPolicyError(`${what} must be a whole hour HH:00`);
  return hour;
}

/** Reads the `support` object of the registry policy (`policy().support`) into a window; throws SupportPolicyError when it differs from what the code supports. */
export function supportWindowOf(support: unknown): SupportWindow {
  if (typeof support !== "object" || support === null) throw new SupportPolicyError("the policy has no support object");
  const s = support as Record<string, unknown>;
  if (s["timezone"] !== SUPPORT_TIMEZONE) throw new SupportPolicyError(`timezone must be ${SUPPORT_TIMEZONE}`);
  const days = s["days"];
  if (!Array.isArray(days) || days.length === 0 || days.some((d) => !(WEEKDAYS as ReadonlyArray<unknown>).includes(d)) || new Set(days).size !== days.length) {
    throw new SupportPolicyError("days must be a non-empty list of distinct weekday tokens");
  }
  const startHour = wholeHour(s["start"], "start");
  const endHour = wholeHour(s["end"], "end");
  if (startHour >= endHour) throw new SupportPolicyError("start must be before end");
  return Object.freeze({ timezone: SUPPORT_TIMEZONE, days: Object.freeze([...(days as Weekday[])]), startHour, endHour });
}

function keyOfDay(dayMs: number): DateKey {
  return new Date(dayMs).toISOString().slice(0, 10);
}

function toUtc(localMs: number): UtcInstant {
  return new Date(localMs - BOGOTA_OFFSET_MS).toISOString() as UtcInstant;
}

function calendarUnavailable(calendar: HolidayCalendar, date: DateKey): DomainFailure {
  return new DomainFailure(
    "CAPACITY_UNAVAILABLE",
    `the support holiday calendar ${calendar.version} covers ${calendar.firstYear} to ${calendar.lastYear}, not ${date}`,
    { reason: "SUPPORT_CALENDAR_UNAVAILABLE" },
  );
}

/** A covered day is a day of the window's week that is not a holiday. `dayMs` is local midnight expressed as if it were UTC. */
function isCoveredDay(dayMs: number, window: SupportWindow, calendar: HolidayCalendar): boolean {
  const date = keyOfDay(dayMs);
  if (!calendar.covers(date)) throw calendarUnavailable(calendar, date);
  const weekday = WEEKDAYS[new Date(dayMs).getUTCDay()];
  return weekday !== undefined && window.days.includes(weekday) && !calendar.isHoliday(date);
}

/** How far a search may walk: two years of days is far more than any run of closed days, so exhausting it is an internal fault. */
const SEARCH_DAYS = 800;

/** S1/S2: the end of the first covered clock hour that starts at or after the request. */
function endOfNextCoveredHour(localMs: number, window: SupportWindow, calendar: HolidayCalendar): number {
  let candidate = Math.ceil(localMs / HOUR_MS) * HOUR_MS;
  for (let step = 0; step < SEARCH_DAYS * 3; step++) {
    const day = Math.floor(candidate / DAY_MS) * DAY_MS;
    const hour = (candidate - day) / HOUR_MS;
    const covered = isCoveredDay(day, window, calendar);
    if (covered && hour >= window.startHour && hour < window.endHour) return candidate + HOUR_MS;
    candidate = covered && hour < window.startHour ? day + window.startHour * HOUR_MS : day + DAY_MS;
  }
  throw new DomainFailure("INTEGRITY_FAILURE", "no covered hour was found within the search bound");
}

/** S3/S4: the end of the covered day (the window's end hour) of the first covered business day strictly after the local date. */
function endOfNextCoveredDay(localMs: number, window: SupportWindow, calendar: HolidayCalendar): number {
  let day = Math.floor(localMs / DAY_MS) * DAY_MS + DAY_MS;
  for (let step = 0; step < SEARCH_DAYS; step++, day += DAY_MS) {
    if (isCoveredDay(day, window, calendar)) return day + window.endHour * HOUR_MS;
  }
  throw new DomainFailure("INTEGRITY_FAILURE", "no covered day was found within the search bound");
}

/** The instant a case opened at `now` is due its first review, as a canonical UTC instant. */
export function nextReviewAt(severity: SupportSeverity, now: UtcInstant | number, window: SupportWindow, calendar: HolidayCalendar = COLOMBIA_HOLIDAYS): UtcInstant {
  const localMs = (typeof now === "number" ? now : Date.parse(now)) + BOGOTA_OFFSET_MS;
  if (!Number.isFinite(localMs)) throw new DomainFailure("INVALID_REQUEST", "the request instant is not a date");
  return toUtc(severity === "S1" || severity === "S2" ? endOfNextCoveredHour(localMs, window, calendar) : endOfNextCoveredDay(localMs, window, calendar));
}
