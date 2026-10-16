/**
 * Proleptic Gregorian calendar arithmetic without `Date`.
 *
 * `Date.UTC` and the `Date` constructor treat a year between 0 and 99 as
 * 1900–1999. A transformation that goes through them therefore moves the year
 * 0099 to 1999 and never notices. Nothing here consults `Date`; the year is
 * carried literally from the source to the rendered value, and a value that
 * falls outside the supported range is reported instead of being emitted.
 *
 * The day-number algorithms are the well-known era-based ones (Hinnant). They
 * are exact for every integer day number that fits a double, so overflow is
 * handled by the explicit range check, not by arithmetic luck.
 */

export interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Smallest year the core delivers. ISO 8601 renders four digits; year 0 has no place in a CRM. */
export const MIN_SUPPORTED_YEAR = 1;
/** Largest year four ISO digits can carry. */
export const MAX_SUPPORTED_YEAR = 9999;

export const MILLISECONDS_PER_DAY = 86_400_000;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function isSupportedYear(year: number): boolean {
  return Number.isInteger(year) && year >= MIN_SUPPORTED_YEAR && year <= MAX_SUPPORTED_YEAR;
}

/** True when the parts name a real day of the proleptic Gregorian calendar inside the supported year range. */
export function isRealCalendarDate(parts: CalendarDate): boolean {
  if (!isSupportedYear(parts.year)) return false;
  if (!Number.isInteger(parts.month) || !Number.isInteger(parts.day)) return false;
  if (parts.month < 1 || parts.month > 12 || parts.day < 1) return false;
  const lengths = [31, isLeapYear(parts.year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return parts.day <= (lengths[parts.month - 1] as number);
}

/** Days since 1970-01-01 for a calendar date. The caller guarantees a real date. */
export function daysFromCivil(parts: CalendarDate): number {
  const y = parts.month <= 2 ? parts.year - 1 : parts.year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (parts.month + (parts.month > 2 ? -3 : 9)) + 2) / 5) + parts.day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/**
 * Calendar date for a day number counted from 1970-01-01.
 *
 * Returns null unless the day number is a finite integer whose date lies inside
 * the supported year range, so a caller can never render a year it cannot spell.
 */
export function civilFromDays(days: number): CalendarDate | null {
  if (!Number.isSafeInteger(days)) return null;
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  if (!isSupportedYear(year)) return null;
  return { year, month, day };
}

export function renderIsoCalendarDate(parts: CalendarDate): string {
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
}

export interface CalendarInstant extends CalendarDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

/**
 * Shifts a wall-clock reading by an offset and returns the UTC instant, or null
 * when the result leaves the supported year range. The caller guarantees a real
 * date and a real time of day.
 */
export function toUtcInstant(local: CalendarInstant, offsetMinutes: number): CalendarInstant | null {
  const localMilliseconds =
    ((local.hour * 60 + local.minute) * 60 + local.second) * 1000 + local.millisecond;
  const total = daysFromCivil(local) * MILLISECONDS_PER_DAY + localMilliseconds - Math.round(offsetMinutes * 60_000);
  const days = Math.floor(total / MILLISECONDS_PER_DAY);
  const remainder = total - days * MILLISECONDS_PER_DAY;
  const date = civilFromDays(days);
  if (date === null) return null;
  const millisecond = remainder % 1000;
  const wholeSeconds = (remainder - millisecond) / 1000;
  return {
    ...date,
    hour: Math.floor(wholeSeconds / 3600),
    minute: Math.floor((wholeSeconds % 3600) / 60),
    second: wholeSeconds % 60,
    millisecond,
  };
}

/** `YYYY-MM-DDTHH:MM:SSZ`, with `.mmm` only when the instant carries milliseconds. */
export function renderIsoUtcInstant(instant: CalendarInstant): string {
  const fraction = instant.millisecond === 0 ? '' : `.${pad(instant.millisecond, 3)}`;
  return `${renderIsoCalendarDate(instant)}T${pad(instant.hour, 2)}:${pad(instant.minute, 2)}:${pad(instant.second, 2)}${fraction}Z`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}
