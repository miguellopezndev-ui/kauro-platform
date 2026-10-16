/**
 * Parameter evidence, D3-CAP-04: the values a transformation parameter may
 * take for one column, from facts alone — the shapes Migration Core's
 * profile counted over the whole file and the locale the project declares.
 * The resolver offers these values to the model on the candidate
 * (`allowedParamValues`); the compiler computes them again from the frozen
 * profile and the declaration, never from the envelope, and refuses any
 * other value as PARAM_NOT_EVIDENCED. A separator stands on the shapes; a
 * date format and a phone region stand only on what the project declares —
 * nothing here guesses a locale from a header, a value or a geography.
 */
import { countryCode } from '../classifier/data-classifier.js';
import { DATE_FORMAT_DOMAIN } from '../contracts/proposal.js';

/** The project's declared locale as this core reads it: each member kept only when it is inside its closed domain. */
export interface DeclaredLocale {
  readonly defaultRegion: string | null;
  readonly dateFormat: string | null;
}

export const NO_LOCALE: DeclaredLocale = Object.freeze({ defaultRegion: null, dateFormat: null });

const LOCALE_MEMBERS = ['defaultRegion', 'dateFormat'] as const;

/**
 * The host's declaration, checked: an object with at most a defaultRegion
 * that is an ISO 3166-1 alpha-2 country and a dateFormat of the closed
 * domain. Anything else is a problem of the host's contract — the run
 * refuses it before anything is spent — and is never evidence. The problems
 * are closed codes; no text of the declaration is echoed.
 */
export function declaredLocale(evidence: unknown): { readonly locale: DeclaredLocale; readonly problems: readonly string[] } {
  if (evidence === undefined) return { locale: NO_LOCALE, problems: [] };
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) return { locale: NO_LOCALE, problems: ['LOCALE_EVIDENCE_MALFORMED'] };
  const members = evidence as Readonly<Record<string, unknown>>;
  const refused: string[] = [];
  if (Object.keys(members).some((key) => !(LOCALE_MEMBERS as readonly string[]).includes(key))) refused.push('LOCALE_EVIDENCE_UNKNOWN_MEMBER');
  const region = members['defaultRegion'];
  const format = members['dateFormat'];
  const defaultRegion = typeof region === 'string' && countryCode(region) ? region : null;
  const dateFormat = typeof format === 'string' && (DATE_FORMAT_DOMAIN as readonly string[]).includes(format) ? format : null;
  if (region !== undefined && defaultRegion === null) refused.push('LOCALE_EVIDENCE_REFUSED:defaultRegion');
  if (format !== undefined && dateFormat === null) refused.push('LOCALE_EVIDENCE_REFUSED:dateFormat');
  return { locale: { defaultRegion, dateFormat }, problems: refused.length === 0 ? [] : ['LOCALE_EVIDENCE_MALFORMED', ...refused] };
}

/**
 * The primitives whose parameter must be evidenced: the parameter, the
 * semantic types of a destination that needs it, and the full-data shapes
 * with which Migration Core cannot read a column as that type unless the
 * parameter is declared (a decimal comma or grouped number, an ambiguous
 * slash date, a local phone number).
 */
export const PARAMETERISED_PRIMITIVES: Readonly<Record<string, { readonly param: string; readonly semanticTypes: readonly string[]; readonly shapes: readonly string[] }>> = Object.freeze({
  NORMALISE_NUMBER: Object.freeze({ param: 'decimalSeparator', semanticTypes: Object.freeze(['NUMBER']), shapes: Object.freeze(['decimalComma', 'groupedNumber']) }),
  PARSE_DATE_ISO: Object.freeze({ param: 'dateFormat', semanticTypes: Object.freeze(['DATE', 'DATETIME']), shapes: Object.freeze(['slashDateAmbiguous']) }),
  PARSE_PHONE_E164: Object.freeze({ param: 'defaultRegion', semanticTypes: Object.freeze(['PHONE']), shapes: Object.freeze(['phoneLocalDigits']) }),
});

/** The date formats a full-data shape is written in: a slash date is day or month first, an ISO date is ISO. */
const FORMATS_OF_SHAPE: Readonly<Record<string, readonly string[]>> = Object.freeze({ slashDateAmbiguous: Object.freeze(['DD/MM/YYYY', 'MM/DD/YYYY']), isoDate: Object.freeze(['ISO_8601']) });

/**
 * The values the evidence admits for a primitive's parameter on a column
 * with these full-data shapes: the decimal separator the shapes show, and
 * only when they show one and not the other; the declared date format when
 * the column's shapes are written in it; the declared region. Empty when
 * nothing evidences one: then no value is admissible.
 */
export function evidencedValues(primitive: string, shapes: readonly string[], locale: DeclaredLocale): readonly string[] {
  switch (primitive) {
    case 'NORMALISE_NUMBER': {
      const comma = shapes.includes('decimalComma');
      const point = shapes.includes('decimalPoint');
      return comma && !point ? [','] : point && !comma ? ['.'] : [];
    }
    case 'PARSE_DATE_ISO': {
      const admitted = new Set(shapes.flatMap((shape) => FORMATS_OF_SHAPE[shape] ?? []));
      return locale.dateFormat !== null && admitted.has(locale.dateFormat) ? [locale.dateFormat] : [];
    }
    case 'PARSE_PHONE_E164':
      return locale.defaultRegion === null ? [] : [locale.defaultRegion];
    default:
      return [];
  }
}

/** The allowedParamValues a candidate offering these primitives carries; undefined when it offers none with a parameter. */
export function allowedParamValuesOf(primitives: readonly string[], shapes: readonly string[], locale: DeclaredLocale): Readonly<Record<string, readonly string[]>> | undefined {
  const entries = primitives.flatMap((primitive) => {
    const spec = PARAMETERISED_PRIMITIVES[primitive];
    return spec === undefined ? [] : [[spec.param, [...evidencedValues(primitive, shapes, locale)]] as const];
  });
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** Whether a parameter value is inside its closed domain — the egress decision re-reads every offered value by this. */
export function paramValueInDomain(param: string, value: string): boolean {
  if (param === 'decimalSeparator') return value === ',' || value === '.';
  if (param === 'dateFormat') return (DATE_FORMAT_DOMAIN as readonly string[]).includes(value);
  if (param === 'defaultRegion') return countryCode(value);
  return false;
}
