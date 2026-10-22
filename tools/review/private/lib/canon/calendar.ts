// Dates of the canonical world: pure helpers, no clock. The world's "now" is a constant (AS_OF), never Date.now(), so every surface and
// every run reads the same day. Business days are Monday to Friday on the Bogotá calendar, less the holidays the world lists.

export const AS_OF = "2026-10-22T14:00:00Z";
/** 09:00 in Bogotá (UTC-5, no daylight saving), Thursday. */
export const AS_OF_LOCAL = "2026-10-22T09:00:00-05:00";
export const TIMEZONE = "America/Bogota";
/**
 * Bogotá public holidays the world's dates touch. Nov 2 and Nov 16 were given in the brief; Oct 12 is added because the September
 * statement's pay date (Oct 15, the 10th business day) is only right with it, as prototypes/sales.ts already assumed.
 */
export const HOLIDAYS: readonly string[] = ["2026-10-12", "2026-11-02", "2026-11-16"];

const DAY = 86_400_000;
const HOUR = 3_600_000;
const BOGOTA_OFFSET = -5 * HOUR;

export const ms = (iso: string): number => {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) throw new RangeError(`not a date: ${iso}`);
  return value;
};
/** An instant in the world's format: seconds, "Z", no milliseconds. */
export const instant = (value: number): string => new Date(value).toISOString().replace(".000Z", "Z");
export const plusHours = (iso: string, hours: number): string => instant(ms(iso) + hours * HOUR);
export const plusDays = (iso: string, days: number): string => instant(ms(iso) + days * DAY);
export const earliest = (...dates: readonly string[]): string => dates.reduce((a, b) => (ms(a) <= ms(b) ? a : b));
export const latest = (...dates: readonly string[]): string => dates.reduce((a, b) => (ms(a) >= ms(b) ? a : b));

/** The Bogotá calendar day of an instant ("2026-10-22T02:00:00Z" is still Oct 21 in Bogotá). */
export const bogotaDay = (iso: string): string => new Date(ms(iso) + BOGOTA_OFFSET).toISOString().slice(0, 10);
/** A calendar day plus n days. */
export const dayPlus = (day: string, days: number): string => new Date(ms(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
/** Whole days from one calendar day to another. */
export const daysBetween = (from: string, to: string): number => Math.round((ms(`${to}T00:00:00Z`) - ms(`${from}T00:00:00Z`)) / DAY);

export function isBusinessDay(day: string, holidays: readonly string[] = HOLIDAYS): boolean {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.includes(day);
}

/** n business days after an instant, keeping its time of day (the hold's rule: five business days from the proof). */
export function plusBusinessDays(iso: string, days: number, holidays: readonly string[] = HOLIDAYS): string {
  let at = ms(iso);
  let left = days;
  while (left > 0) {
    at += DAY;
    if (isBusinessDay(bogotaDay(instant(at)), holidays)) left -= 1;
  }
  return instant(at);
}

/** The nth business day of a month ("2026-11", 5 is Nov 9, 2026: Nov 2 is a holiday). */
export function nthBusinessDay(month: string, n: number, holidays: readonly string[] = HOLIDAYS): string {
  let day = `${month}-01`;
  let count = isBusinessDay(day, holidays) ? 1 : 0;
  while (count < n) {
    day = dayPlus(day, 1);
    if (isBusinessDay(day, holidays)) count += 1;
  }
  if (!day.startsWith(month)) throw new RangeError(`${month} has fewer than ${n} business days`);
  return day;
}

/** The month after "2026-09": "2026-10". */
export function nextMonth(month: string): string {
  const [year, number] = month.split("-").map(Number) as [number, number];
  return number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, "0")}`;
}
