import { parsePhoneNumberFromString } from 'libphonenumber-js';
import type { CountryCode } from 'libphonenumber-js';
import type { ReasonCode } from '../domain/reason-codes.js';
import type { TransformEvidence, TransformKind } from '../domain/transform.js';
import type { CaseTransform, DateFormat, TimezonePolicy } from '../domain/config.js';
import type { SpreadsheetDateSystem } from '../domain/source-cell.js';
import { unreachable } from '../util/assert.js';
import {
  MAX_SUPPORTED_YEAR,
  MIN_SUPPORTED_YEAR,
  civilFromDays,
  daysFromCivil,
  isRealCalendarDate,
  renderIsoCalendarDate,
  renderIsoUtcInstant,
  toUtcInstant,
} from './civil-calendar.js';
import { assertTimezoneUsable, renderOffset, resolveLocalTime } from './timezone.js';

/**
 * One transformation step.
 *
 * A step proposes a value; it never delivers one. `applyFieldTransform` builds
 * the final `TransformResult` through `makeTransformResult`, which is the single
 * place that enforces the non-destruction invariants.
 */
export interface StepOutcome {
  readonly kind: TransformKind;
  readonly value: string | null;
  readonly reasonCode: ReasonCode;
  readonly evidence: readonly TransformEvidence[];
  readonly derived: Readonly<Record<string, string>>;
}

const NO_DERIVED: Readonly<Record<string, string>> = {};

function outcome(
  kind: TransformKind,
  value: string | null,
  reasonCode: ReasonCode,
  evidence: readonly TransformEvidence[] = [],
  derived: Readonly<Record<string, string>> = NO_DERIVED,
): StepOutcome {
  return { kind, value, reasonCode, evidence, derived };
}

function settle(input: string, candidate: string, reasonCode: ReasonCode, evidence: readonly TransformEvidence[]): StepOutcome {
  return candidate === input
    ? outcome('UNCHANGED', input, 'TRANSFORM_UNCHANGED', evidence)
    : outcome('CHANGED_SAFE', candidate, reasonCode, evidence);
}

// ------------------------------------------------------------------- TEXT

export const TRANSFORMATION_VERSION = '1.2.0';

export function transformText(input: string): StepOutcome {
  return outcome('UNCHANGED', input, 'TRANSFORM_UNCHANGED');
}

// ------------------------------------------------- configured normalization

const LETTER = /\p{L}/u;
const WHITESPACE = /\s/u;
/** A hyphen, an apostrophe and the typographic apostrophe. Nothing else starts a word. */
const TITLE_BOUNDARIES = new Set(['-', "'", '’']);

/**
 * The mechanical title rule.
 *
 * It lower-cases the value and then upper-cases the first letter after the
 * start of the value, Unicode whitespace, "-", "'" or "’". It walks code
 * points, not code units, so a name outside the Basic Multilingual Plane is
 * cased rather than cut in half.
 *
 * There is no dictionary here on purpose. McNamara, van der Waals and eBay are
 * not reconstructible by any universal rule, and pretending otherwise would
 * corrupt one customer's data to flatter another's. Those are written down as
 * `valueMap` entries, which the pipeline consults before this runs.
 */
export function titleSimple(input: string): string {
  let atBoundary = true;
  let result = '';
  for (const codePoint of input.toLowerCase()) {
    if (TITLE_BOUNDARIES.has(codePoint) || WHITESPACE.test(codePoint)) {
      result += codePoint;
      atBoundary = true;
      continue;
    }
    if (atBoundary && LETTER.test(codePoint)) {
      result += codePoint.toUpperCase();
      atBoundary = false;
      continue;
    }
    result += codePoint;
  }
  return result;
}

/** Locale-insensitive by construction: the ECMAScript case operations, never the locale-aware ones. */
export function applyCaseTransform(input: string, form: CaseTransform): string {
  switch (form) {
    case 'PRESERVE':
      return input;
    case 'LOWER':
      return input.toLowerCase();
    case 'UPPER':
      return input.toUpperCase();
    case 'TITLE_SIMPLE':
      return titleSimple(input);
    default:
      return unreachable(form, 'applyCaseTransform');
  }
}

export function transformIdentifier(input: string, storedAsNumber: boolean): StepOutcome {
  if (storedAsNumber) {
    return outcome('UNCHANGED', input, 'TRANSFORM_IDENTIFIER_NUMERIC_IN_SOURCE', [
      {
        kind: 'SOURCE_REPRESENTATION',
        detail: 'the spreadsheet stored this cell as a number, not as text',
      },
    ]);
  }
  return outcome('UNCHANGED', input, 'TRANSFORM_IDENTIFIER_PRESERVED');
}

// ------------------------------------------------------------------ EMAIL

/**
 * Conservative syntax check. It deliberately rejects less than RFC 5321 allows,
 * because an address this refuses is preserved unchanged rather than discarded.
 */
const EMAIL_PATTERN = /^[^\s@"',;:<>()[\]\\]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/u;

export function transformEmail(input: string, lowercaseDomain: boolean): StepOutcome {
  if (!EMAIL_PATTERN.test(input)) {
    return outcome('INVALID', input, 'TRANSFORM_EMAIL_INVALID_SYNTAX');
  }
  if (!lowercaseDomain) {
    return outcome('UNCHANGED', input, 'TRANSFORM_UNCHANGED');
  }
  const at = input.lastIndexOf('@');
  const local = input.slice(0, at);
  const domain = input.slice(at + 1);
  const candidate = `${local}@${domain.toLowerCase()}`;
  return settle(input, candidate, 'TRANSFORM_EMAIL_DOMAIN_LOWERCASED', [
    {
      kind: 'CASE_SENSITIVITY',
      detail: 'domains are case-insensitive; the local part was left exactly as written',
    },
  ]);
}

// ------------------------------------------------------------------ PHONE

export interface PhoneOptions {
  readonly countryEvidence: string | null;
  readonly countryEvidenceSource: string;
  readonly extensionDestinationField: string | null;
}

export function transformPhone(input: string, options: PhoneOptions): StepOutcome {
  const explicitInternational = input.trimStart().startsWith('+');

  if (!explicitInternational && options.countryEvidence === null) {
    return outcome('AMBIGUOUS', input, 'TRANSFORM_PHONE_NO_COUNTRY_EVIDENCE', [
      {
        kind: 'COUNTRY_EVIDENCE',
        detail: 'the number carries no international prefix and no country was declared for this data',
      },
    ]);
  }

  const parsed = explicitInternational
    ? parsePhoneNumberFromString(input)
    : parsePhoneNumberFromString(input, options.countryEvidence as CountryCode);

  if (parsed === undefined || !parsed.isValid()) {
    return outcome('INVALID', input, 'TRANSFORM_PHONE_INVALID', [
      {
        kind: 'COUNTRY_EVIDENCE',
        detail: explicitInternational
          ? 'read as an international number because it starts with "+"'
          : `read with country ${String(options.countryEvidence)} from ${options.countryEvidenceSource}`,
      },
    ]);
  }

  const evidence: TransformEvidence[] = [
    {
      kind: 'COUNTRY_EVIDENCE',
      detail: explicitInternational
        ? 'the international prefix in the source establishes the country'
        : `country ${String(options.countryEvidence)} from ${options.countryEvidenceSource}`,
    },
    { kind: 'RESOLVED_COUNTRY', detail: parsed.country ?? 'unknown' },
  ];

  const extension = parsed.ext ?? null;
  const e164 = parsed.format('E.164');

  if (extension !== null && extension.length > 0) {
    if (options.extensionDestinationField === null) {
      return outcome('UNSUPPORTED', input, 'TRANSFORM_PHONE_EXTENSION_NO_DESTINATION_FIELD', [
        ...evidence,
        { kind: 'EXTENSION', detail: `the number carries extension ${extension}` },
      ]);
    }
    return outcome(
      e164 === input ? 'UNCHANGED' : 'CHANGED_SAFE',
      e164,
      e164 === input ? 'TRANSFORM_UNCHANGED' : 'TRANSFORM_PHONE_EXTENSION_SEPARATED',
      [...evidence, { kind: 'EXTENSION', detail: `extension ${extension} written to ${options.extensionDestinationField}` }],
      { extension },
    );
  }

  return settle(input, e164, 'TRANSFORM_PHONE_E164', evidence);
}

// ------------------------------------------------------------------- DATE

interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const ISO_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/u;

const PATTERNED_FORMATS: Readonly<Record<string, { readonly regex: RegExp; readonly order: readonly ['y' | 'm' | 'd', 'y' | 'm' | 'd', 'y' | 'm' | 'd'] }>> = {
  'MM/DD/YYYY': { regex: /^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{4})$/u, order: ['m', 'd', 'y'] },
  'DD/MM/YYYY': { regex: /^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{4})$/u, order: ['d', 'm', 'y'] },
  'YYYY/MM/DD': { regex: /^([0-9]{4})\/([0-9]{1,2})\/([0-9]{1,2})$/u, order: ['y', 'm', 'd'] },
  'MM-DD-YYYY': { regex: /^([0-9]{1,2})-([0-9]{1,2})-([0-9]{4})$/u, order: ['m', 'd', 'y'] },
  'DD-MM-YYYY': { regex: /^([0-9]{1,2})-([0-9]{1,2})-([0-9]{4})$/u, order: ['d', 'm', 'y'] },
  'DD.MM.YYYY': { regex: /^([0-9]{1,2})\.([0-9]{1,2})\.([0-9]{4})$/u, order: ['d', 'm', 'y'] },
  'MM.DD.YYYY': { regex: /^([0-9]{1,2})\.([0-9]{1,2})\.([0-9]{4})$/u, order: ['m', 'd', 'y'] },
};

/**
 * A real day of the proleptic Gregorian calendar inside the supported year
 * range (0001–9999). Year 0000 is shaped like a year but is never delivered.
 */
export function isRealDate(parts: DateParts): boolean {
  return isRealCalendarDate(parts);
}

function renderIsoDate(parts: DateParts): string {
  return renderIsoCalendarDate(parts);
}

export interface DateContext {
  readonly declaredFormat: DateFormat | null;
  /** Set when the workbook itself marks the cell as a date. */
  readonly spreadsheetDateSystem: SpreadsheetDateSystem | null;
  readonly numberFormat: string | null;
}

export function transformDate(input: string, context: DateContext): StepOutcome {
  if (context.spreadsheetDateSystem !== null && context.numberFormat !== null) {
    return fromSerial(input, context.spreadsheetDateSystem, context.numberFormat);
  }

  if (context.declaredFormat === 'SPREADSHEET_SERIAL') {
    if (context.spreadsheetDateSystem === null) {
      return outcome('INVALID', input, 'TRANSFORM_DATE_INVALID_FOR_DECLARED_FORMAT', [
        { kind: 'DATE_FORMAT', detail: 'SPREADSHEET_SERIAL only applies to workbook cells' },
      ]);
    }
    return fromSerial(input, context.spreadsheetDateSystem, 'declared');
  }

  const iso = ISO_DATE.exec(input);
  if (context.declaredFormat === null || context.declaredFormat === 'ISO_8601') {
    if (iso === null) {
      return outcome('AMBIGUOUS', input, 'TRANSFORM_DATE_AMBIGUOUS_NO_FORMAT_EVIDENCE', [
        {
          kind: 'DATE_FORMAT',
          detail:
            context.declaredFormat === null
              ? 'no date format was declared for this column, so only ISO 8601 dates are accepted'
              : 'the column declares ISO 8601 and the value is not an ISO 8601 date',
        },
      ]);
    }
    const parts = {
      year: Number(iso[1]),
      month: Number(iso[2]),
      day: Number(iso[3]),
    };
    if (!isRealDate(parts)) {
      return outcome('INVALID', input, 'TRANSFORM_DATE_INVALID_FOR_DECLARED_FORMAT', [
        { kind: 'DATE_FORMAT', detail: 'the value is shaped like an ISO date but is not a real calendar date' },
      ]);
    }
    return outcome('UNCHANGED', input, 'TRANSFORM_DATE_ISO_ACCEPTED');
  }

  const pattern = PATTERNED_FORMATS[context.declaredFormat];
  if (pattern === undefined) {
    return outcome('INVALID', input, 'TRANSFORM_DATE_INVALID_FOR_DECLARED_FORMAT');
  }
  const match = pattern.regex.exec(input);
  if (match === null) {
    return outcome('INVALID', input, 'TRANSFORM_DATE_INVALID_FOR_DECLARED_FORMAT', [
      { kind: 'DATE_FORMAT', detail: `the column declares ${context.declaredFormat}` },
    ]);
  }
  const values: Record<'y' | 'm' | 'd', number> = { y: 0, m: 0, d: 0 };
  pattern.order.forEach((slot, index) => {
    values[slot] = Number(match[index + 1]);
  });
  const parts = { year: values.y, month: values.m, day: values.d };
  if (!isRealDate(parts)) {
    return outcome('INVALID', input, 'TRANSFORM_DATE_INVALID_FOR_DECLARED_FORMAT', [
      { kind: 'DATE_FORMAT', detail: `read as ${context.declaredFormat} but the result is not a real calendar date` },
    ]);
  }
  return settle(input, renderIsoDate(parts), 'TRANSFORM_DATE_PARSED_WITH_DECLARED_FORMAT', [
    { kind: 'DATE_FORMAT', detail: `read as ${context.declaredFormat}, as the configuration declares` },
  ]);
}

/** Day numbers (since 1970-01-01) of the spreadsheet epochs. */
const EPOCH_1900_BEFORE_LEAP_BUG = daysFromCivil({ year: 1899, month: 12, day: 31 });
const EPOCH_1900_AFTER_LEAP_BUG = daysFromCivil({ year: 1899, month: 12, day: 30 });
const EPOCH_1904 = daysFromCivil({ year: 1904, month: 1, day: 1 });

/** The largest serial of each system that still names a day of year 9999. */
export const MAX_SERIAL_1900 = 2_958_465;
export const MAX_SERIAL_1904 = 2_957_003;

/**
 * Spreadsheet serial dates.
 *
 * The 1900 system contains a deliberate off-by-one: serial 60 stands for
 * 29 February 1900, a day that never existed. It is rejected rather than
 * silently shifted onto a neighbouring day.
 *
 * The conversion is pure calendar arithmetic. A serial that is not finite, is
 * negative (or zero in the 1900 system, which has no day 0) or lands after
 * 9999-12-31 is refused: it is not a date either spreadsheet system can hold,
 * so no date is invented for it.
 */
export function serialToDate(serial: number, system: SpreadsheetDateSystem): DateParts | null {
  if (!Number.isFinite(serial)) return null;
  const whole = Math.floor(serial);
  if (system === 'DATE_1900') {
    if (whole === 60 || whole < 1 || whole > MAX_SERIAL_1900) return null;
    return civilFromDays((whole >= 61 ? EPOCH_1900_AFTER_LEAP_BUG : EPOCH_1900_BEFORE_LEAP_BUG) + whole);
  }
  if (whole < 0 || whole > MAX_SERIAL_1904) return null;
  return civilFromDays(EPOCH_1904 + whole);
}

function fromSerial(input: string, system: SpreadsheetDateSystem, numberFormat: string): StepOutcome {
  const serial = Number(input);
  if (!Number.isFinite(serial)) {
    return outcome('INVALID', input, 'TRANSFORM_DATE_INVALID_FOR_DECLARED_FORMAT', [
      { kind: 'DATE_FORMAT', detail: 'the cell is formatted as a date but does not hold a number' },
    ]);
  }
  const parts = serialToDate(serial, system);
  if (parts === null) {
    return outcome('INVALID', input, 'TRANSFORM_DATE_INVALID_FOR_DECLARED_FORMAT', [
      { kind: 'DATE_FORMAT', detail: `serial ${input} is not a real date in the ${system} system` },
    ]);
  }
  const evidence: TransformEvidence[] = [
    { kind: 'DATE_FORMAT', detail: `spreadsheet date serial, ${system}, number format "${numberFormat}"` },
  ];
  if (!Number.isInteger(serial)) {
    evidence.push({
      kind: 'TIME_COMPONENT',
      detail: 'the cell also carried a time of day; the destination field is a date, so only the calendar date is delivered',
    });
  }
  return settle(input, renderIsoDate(parts), 'TRANSFORM_DATE_FROM_SPREADSHEET_SERIAL', evidence);
}

// --------------------------------------------------------------- DATETIME

const ISO_DATETIME =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,3}))?)?(Z|[+-][0-9]{2}:[0-9]{2})?$/u;

export function transformDateTime(
  input: string,
  declaredOffset: string | null,
  timezone: TimezonePolicy | null = null,
): StepOutcome {
  const match = ISO_DATETIME.exec(input);
  if (match === null) {
    return outcome('AMBIGUOUS', input, 'TRANSFORM_DATE_AMBIGUOUS_NO_FORMAT_EVIDENCE', [
      { kind: 'DATETIME_FORMAT', detail: 'only ISO 8601 timestamps are accepted for date-and-time columns' },
    ]);
  }

  const offset = match[8] ?? declaredOffset;
  if (timezone !== null && match[8] === undefined) {
    return fromDeclaredZone(input, match, timezone);
  }
  if (offset === null || offset === undefined) {
    return outcome('AMBIGUOUS', input, 'TRANSFORM_DATETIME_NO_TIMEZONE_EVIDENCE', [
      {
        kind: 'TIMEZONE_EVIDENCE',
        detail: 'the timestamp carries no time zone and none was declared for this column',
      },
    ]);
  }

  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? '0');
  const millisecond = Number((match[7] ?? '0').padEnd(3, '0'));

  if (!isRealDate(parts) || hour > 23 || minute > 59 || second > 59) {
    return outcome('INVALID', input, 'TRANSFORM_DATE_INVALID_FOR_DECLARED_FORMAT', [
      { kind: 'DATETIME_FORMAT', detail: 'the timestamp is not a real instant' },
    ]);
  }

  const offsetMinutes = offset === 'Z' ? 0 : parseOffsetMinutes(offset);
  if (offsetMinutes === null) {
    return outcome('INVALID', input, 'TRANSFORM_DATE_INVALID_FOR_DECLARED_FORMAT', [
      { kind: 'TIMEZONE_EVIDENCE', detail: `"${offset}" is not a usable time zone offset` },
    ]);
  }

  // Never through `Date`: it reads a year between 0 and 99 as 1900–1999.
  const instant = toUtcInstant({ ...parts, hour, minute, second, millisecond }, offsetMinutes);
  if (instant === null) {
    return outcome('INVALID', input, 'TRANSFORM_DATE_INVALID_FOR_DECLARED_FORMAT', [
      {
        kind: 'DATETIME_FORMAT',
        detail: `once shifted to UTC the instant leaves the supported years ${String(MIN_SUPPORTED_YEAR).padStart(4, '0')}–${MAX_SUPPORTED_YEAR}`,
      },
    ]);
  }
  const candidate = renderIsoUtcInstant(instant);
  return settle(input, candidate, 'TRANSFORM_DATETIME_PARSED', [
    {
      kind: 'TIMEZONE_EVIDENCE',
      detail:
        match[8] === undefined
          ? `the column declares the offset ${offset}`
          : 'the offset came from the source value',
    },
  ]);
}

/**
 * A local time read in a declared zone.
 *
 * Three outcomes besides the ordinary one, and none of them moves the time:
 *
 *   - a reading the zone's clock never showed (the clocks went forward over it)
 *     is unresolved and preserved;
 *   - a reading the clock showed twice (the clocks went back) is unresolved
 *     unless the plan chose the EARLIER or the LATER occurrence;
 *   - anything else has one offset, and that is the one applied.
 *
 * An offset the value itself carries never reaches this: it outranks the zone.
 */
function fromDeclaredZone(input: string, match: RegExpExecArray, timezone: TimezonePolicy): StepOutcome {
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? '0');
  const millisecond = Number((match[7] ?? '0').padEnd(3, '0'));
  if (!isRealDate(parts) || hour > 23 || minute > 59 || second > 59) {
    return outcome('INVALID', input, 'TRANSFORM_DATE_INVALID_FOR_DECLARED_FORMAT', [
      { kind: 'DATETIME_FORMAT', detail: 'the timestamp is not a real instant' },
    ]);
  }
  assertTimezoneUsable(timezone, 'the DATETIME field');

  const declared = `the column declares the zone ${timezone.zone} (tzdata ${timezone.tzdata})`;
  const localSeconds = daysFromCivil(parts) * 86_400 + hour * 3600 + minute * 60 + second;
  const resolution = resolveLocalTime(localSeconds, timezone.zone);

  if (resolution.kind === 'GAP') {
    return outcome('AMBIGUOUS', input, 'TRANSFORM_LOCAL_TIME_NONEXISTENT', [
      {
        kind: 'TIMEZONE_EVIDENCE',
        detail: `${declared}, and the clocks there never showed this time: it falls in the hour skipped when they went forward. It is preserved as written, not moved to a neighbouring hour`,
      },
    ]);
  }

  let offsetSeconds: number;
  let reading = '';
  if (resolution.kind === 'UNIQUE') {
    offsetSeconds = resolution.offsetSeconds;
  } else {
    const both = `${renderOffset(resolution.earlierOffsetSeconds)} and ${renderOffset(resolution.laterOffsetSeconds)}`;
    if (timezone.overlap === 'REFUSE') {
      return outcome('AMBIGUOUS', input, 'TRANSFORM_LOCAL_TIME_AMBIGUOUS', [
        {
          kind: 'TIMEZONE_EVIDENCE',
          detail: `${declared}, and the clocks there showed this time twice (at ${both}) when they went back. The plan declares overlap REFUSE, so the value is preserved as written; declare EARLIER or LATER to choose`,
        },
      ]);
    }
    offsetSeconds = timezone.overlap === 'EARLIER' ? resolution.earlierOffsetSeconds : resolution.laterOffsetSeconds;
    reading = `; the clocks showed this time twice (at ${both}) and the plan declares ${timezone.overlap}`;
  }

  // Never through `Date`: it reads a year between 0 and 99 as 1900–1999.
  const instant = toUtcInstant({ ...parts, hour, minute, second, millisecond }, offsetSeconds / 60);
  if (instant === null) {
    return outcome('INVALID', input, 'TRANSFORM_DATE_INVALID_FOR_DECLARED_FORMAT', [
      {
        kind: 'DATETIME_FORMAT',
        detail: `once shifted to UTC the instant leaves the supported years ${String(MIN_SUPPORTED_YEAR).padStart(4, '0')}–${MAX_SUPPORTED_YEAR}`,
      },
    ]);
  }
  return settle(input, renderIsoUtcInstant(instant), 'TRANSFORM_DATETIME_PARSED', [
    { kind: 'TIMEZONE_EVIDENCE', detail: `${declared}; offset ${renderOffset(offsetSeconds)} applies${reading}` },
  ]);
}

function parseOffsetMinutes(offset: string): number | null {
  const match = /^([+-])([0-9]{2}):([0-9]{2})$/u.exec(offset);
  if (match === null) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) return null;
  return (match[1] === '-' ? -1 : 1) * (hours * 60 + minutes);
}

// ----------------------------------------------------------------- NUMBER

const PLAIN_NUMBER = /^-?[0-9]+(\.[0-9]+)?$/u;

export function transformNumber(
  input: string,
  decimalSeparator: string | null,
  thousandsSeparator: string | null,
): StepOutcome {
  if (decimalSeparator === null && thousandsSeparator === null) {
    if (PLAIN_NUMBER.test(input)) {
      return outcome('UNCHANGED', input, 'TRANSFORM_UNCHANGED');
    }
    return outcome('AMBIGUOUS', input, 'TRANSFORM_NUMBER_AMBIGUOUS_SEPARATORS', [
      {
        kind: 'NUMBER_FORMAT',
        detail: 'no decimal or thousands separator was declared, so only plain digits are accepted',
      },
    ]);
  }

  const decimal = decimalSeparator ?? '.';
  const grouping = thousandsSeparator === 'NONE' ? null : thousandsSeparator;
  const evidence: TransformEvidence[] = [
    {
      kind: 'NUMBER_FORMAT',
      detail: `read with decimal separator "${decimal}" and thousands separator "${String(thousandsSeparator)}"`,
    },
  ];

  if (grouping === decimal) {
    return outcome('INVALID', input, 'TRANSFORM_NUMBER_INVALID', [
      ...evidence,
      { kind: 'NUMBER_FORMAT', detail: 'the declared decimal and thousands separators are the same character, so no digit string can be read' },
    ]);
  }

  const match = numberGrammar(decimal, grouping).exec(input);
  if (match === null) {
    return outcome('INVALID', input, 'TRANSFORM_NUMBER_INVALID', [
      ...evidence,
      {
        kind: 'NUMBER_FORMAT',
        detail:
          grouping === null
            ? 'the authorised grammar is: optional "-", digits, optionally one decimal separator followed by digits'
            : 'the authorised grammar is: optional "-", digits either ungrouped or in groups of three after a first group of one to three, optionally one decimal separator followed by digits',
      },
    ]);
  }
  const integerPart = grouping === null ? (match[1] as string) : (match[1] as string).split(grouping).join('');
  const fractionPart = match[2];
  const candidate = `${match[0].startsWith('-') ? '-' : ''}${integerPart}${fractionPart === undefined ? '' : `.${fractionPart}`}`;
  return settle(input, candidate, 'TRANSFORM_NUMBER_PARSED', evidence);
}

/**
 * The authorised numeric grammar for one declared separator pair.
 *
 * Group 1 is the integer part exactly as written (grouping separators
 * included), group 2 the digits after the decimal separator. The integer part
 * is either ungrouped digits or a first group of one to three digits followed
 * by groups of exactly three; nothing else counts as grouping. There is at
 * most one decimal separator, it follows the integer part, and no grouping is
 * accepted after it. Leading and trailing whitespace is not part of a number.
 *
 * The grammar is built from the declared separators only. It does not try to
 * know how every locale groups digits: the schema offers ".", ",", " " and "'"
 * as grouping characters and "." or "," as the decimal, and that is all this
 * reads.
 */
function numberGrammar(decimal: string, grouping: string | null): RegExp {
  const d = escapeForRegExp(decimal);
  const integer = grouping === null ? '[0-9]+' : `(?:[0-9]+|[0-9]{1,3}(?:${escapeForRegExp(grouping)}[0-9]{3})+)`;
  return new RegExp(`^-?(${integer})(?:${d}([0-9]+))?$`, 'u');
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

// ---------------------------------------------------------------- BOOLEAN

export function transformBoolean(
  input: string,
  trueValues: readonly string[],
  falseValues: readonly string[],
): StepOutcome {
  const folded = input.toLowerCase();
  if (trueValues.some((value) => value.toLowerCase() === folded)) {
    return settle(input, 'true', 'TRANSFORM_BOOLEAN_PARSED', []);
  }
  if (falseValues.some((value) => value.toLowerCase() === folded)) {
    return settle(input, 'false', 'TRANSFORM_BOOLEAN_PARSED', []);
  }
  return outcome('INVALID', input, 'TRANSFORM_BOOLEAN_UNRECOGNIZED', [
    {
      kind: 'BOOLEAN_VOCABULARY',
      detail: `declared true spellings: ${trueValues.join(', ')}; false spellings: ${falseValues.join(', ')}`,
    },
  ]);
}

// ------------------------------------------------------------------- ENUM

export function transformEnum(input: string, allowedValues: readonly string[]): StepOutcome {
  if (allowedValues.includes(input)) {
    return outcome('UNCHANGED', input, 'TRANSFORM_ENUM_VALUE_ACCEPTED');
  }
  return outcome('INVALID', input, 'TRANSFORM_ENUM_VALUE_NOT_IN_DECLARED_SET', [
    { kind: 'ALLOWED_VALUES', detail: allowedValues.join(' | ') },
  ]);
}
