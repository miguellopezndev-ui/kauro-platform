// Number, money and deadline formatting for the primitives (B11 D-COPY-1: numbers en-US, money from minor units, deadlines
// exact to the minute with a zone). Every function is pure and deterministic: no locale is read from the host, and money is
// arithmetic on BigInt digits, never on a floating-point number.

/** A whole, non-negative count as the application holds it: a JavaScript number, a BigInt or a canonical decimal string. */
export type CountValue = number | bigint | string;

const CANONICAL_UNSIGNED = /^(?:0|[1-9]\d*)$/;
const CANONICAL_SIGNED = /^-?(?:0|[1-9]\d*)$/;

/** Inserts an en-US thousands separator into a string of decimal digits. */
export function groupThousands(digits: string): string {
  if (!/^\d+$/.test(digits)) throw new RangeError(`not a string of digits: ${JSON.stringify(digits)}`);
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The exact value of a count, refusing anything that is not a whole non-negative number. */
export function countToBigInt(value: CountValue, what = "count"): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new RangeError(`${what} is negative`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${what} is not a whole non-negative number: ${String(value)}`);
    return BigInt(value);
  }
  if (!CANONICAL_UNSIGNED.test(value)) throw new RangeError(`${what} is not a canonical decimal integer: ${JSON.stringify(value)}`);
  return BigInt(value);
}

/** 1200 becomes "1,200". */
export function formatCount(value: CountValue, what = "count"): string {
  return groupThousands(countToBigInt(value, what).toString());
}

/** How many minor-unit digits each supported currency has (ISO 4217). A currency not listed here is refused, never guessed. */
export const MINOR_UNIT_EXPONENT: Readonly<Record<string, number>> = Object.freeze({
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  CHF: 2,
  JPY: 0,
});

/** A minor-unit amount such as "129500" in USD is "USD 1,295.00"; a negative amount is "USD -12.50". */
export function formatMoney(minor: string, currency: string): string {
  const exponent = MINOR_UNIT_EXPONENT[currency];
  if (exponent === undefined) throw new RangeError(`unsupported currency: ${JSON.stringify(currency)}`);
  if (!CANONICAL_SIGNED.test(minor) || minor === "-0") throw new RangeError(`not a canonical minor-unit amount: ${JSON.stringify(minor)}`);
  const negative = minor.startsWith("-");
  const digits = (negative ? BigInt(minor.slice(1)) : BigInt(minor)).toString().padStart(exponent + 1, "0");
  const whole = groupThousands(digits.slice(0, digits.length - exponent));
  const fraction = exponent === 0 ? "" : `.${digits.slice(digits.length - exponent)}`;
  return `${currency} ${negative ? "-" : ""}${whole}${fraction}`;
}

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** True when the date and the time of day written in an instant exist: February has no 30th and the day has no 24:00. */
function fieldsExist(match: RegExpExecArray): boolean {
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map((i) => Number(match[i] ?? "0")) as [number, number, number, number, number, number];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth && hour <= 23 && minute <= 59 && second <= 59;
}

export interface FormattedDeadline {
  /** The instant in UTC, for the `datetime` attribute of <time>. */
  readonly iso: string;
  /** "Mar 14, 2027, 5:00 PM EST": the minute, in the named zone. */
  readonly text: string;
}

/** An RFC 3339 instant shown to the minute in an IANA time zone, with the zone's name. */
export function formatDeadline(at: string, timeZone: string): FormattedDeadline {
  const match = INSTANT.exec(at);
  if (match === null) throw new RangeError(`not an RFC 3339 instant with an offset: ${JSON.stringify(at)}`);
  if (!fieldsExist(match)) throw new RangeError(`not a real date and time: ${JSON.stringify(at)}`);
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) throw new RangeError(`not a real instant: ${JSON.stringify(at)}`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((p) => p.type === type);
    if (found === undefined) throw new RangeError(`the ${type} of ${at} is unavailable in ${timeZone}`);
    return found.value;
  };
  const text = `${part("month")} ${part("day")}, ${part("year")}, ${part("hour")}:${part("minute")} ${part("dayPeriod")} ${part("timeZoneName")}`;
  return { iso: new Date(ms).toISOString(), text };
}
