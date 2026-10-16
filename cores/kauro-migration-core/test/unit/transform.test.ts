import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { applyFieldTransform } from '../../src/transform/apply.js';
import { makeTransformResult } from '../../src/domain/transform.js';
import { CoreInvariantError } from '../../src/util/assert.js';
import {
  serialToDate,
  transformBoolean,
  transformDate,
  transformDateTime,
  transformEmail,
  transformEnum,
  transformNumber,
  transformPhone,
} from '../../src/transform/transformations.js';
import { CONFIG_SCHEMA_VERSION, DEFAULT_FIELD_OPTIONS, DEFAULT_LOCALE_EVIDENCE, DEFAULT_POLICIES } from '../../src/domain/config.js';
import { isMigrationError } from '../../src/domain/errors.js';
import { loadConfig } from '../../src/mapping/load-config.js';
import type { FieldMappingConfig, FieldOptions } from '../../src/domain/config.js';
import type { SemanticType } from '../../src/domain/canonical.js';
import type { SourceCell } from '../../src/domain/source-cell.js';

function field(semanticType: SemanticType, options: Partial<FieldOptions> = {}): FieldMappingConfig {
  return {
    column: { header: 'X', occurrence: null, index: null },
    destinationField: 'contact.description',
    semanticType,
    semanticsClass: null,
    required: false,
    onAmbiguous: 'PRESERVE',
    onInvalid: 'PRESERVE',
    options: { ...DEFAULT_FIELD_OPTIONS, ...options },
  };
}

function cell(raw: string | null, overrides: Partial<SourceCell> = {}): SourceCell {
  return { columnIndex: 0, raw, kind: 'CSV_TEXT', formula: null, numberFormat: null, dateSystem: null, ...overrides };
}

function apply(
  raw: string | null,
  semanticType: SemanticType,
  options: Partial<FieldOptions> = {},
  extra: { countryEvidence?: string | null; cell?: Partial<SourceCell>; policies?: typeof DEFAULT_POLICIES } = {},
) {
  return applyFieldTransform({
    cell: cell(raw, extra.cell ?? {}),
    field: field(semanticType, options),
    locale: DEFAULT_LOCALE_EVIDENCE,
    policies: extra.policies ?? DEFAULT_POLICIES,
    countryEvidence: extra.countryEvidence ?? null,
    countryEvidenceSource: 'test',
  });
}

describe('the transformation chokepoint', () => {
  it('refuses to build an outcome that empties a populated value', () => {
    assert.throws(
      () =>
        makeTransformResult({
          kind: 'CHANGED_SAFE',
          original: 'something',
          final: '',
          reasonCode: 'TRANSFORM_UNCHANGED',
          transformationId: 'test',
          transformationVersion: '1',
        }),
      (error: unknown) =>
        error instanceof CoreInvariantError && error.invariant === 'NO_SILENT_CELL_DESTRUCTION',
    );
  });

  it('refuses an ambiguous outcome that changed the value', () => {
    assert.throws(
      () =>
        makeTransformResult({
          kind: 'AMBIGUOUS',
          original: 'a',
          final: 'b',
          reasonCode: 'TRANSFORM_UNCHANGED',
          transformationId: 'test',
          transformationVersion: '1',
        }),
      (error: unknown) =>
        error instanceof CoreInvariantError &&
        error.invariant === 'TRANSFORM_NON_COMMITTAL_PRESERVES_ORIGINAL',
    );
  });

  it('refuses to clear without the destructive safety class', () => {
    assert.throws(
      () =>
        makeTransformResult({
          kind: 'CLEAR_EXPLICIT',
          original: 'a',
          final: null,
          reasonCode: 'TRANSFORM_CLEARED_BY_EXPLICIT_AUTHORIZATION',
          transformationId: 'test',
          transformationVersion: '1',
          safetyClass: 'NON_DESTRUCTIVE',
        }),
      (error: unknown) => error instanceof CoreInvariantError,
    );
  });
});

describe('whitespace', () => {
  // The old test asserted the opposite: that every field trims unless told not
  // to. Whitespace is a value (R2-002, decision D67), so the old expectation
  // was wrong and is replaced by the two tests below.
  it('[R2-002] keeps surrounding whitespace when the field has not approved trimming', () => {
    const text = apply('  padded  ', 'TEXT');
    assert.equal(text.final, '  padded  ');
    assert.equal(text.kind, 'UNCHANGED');
    assert.equal(text.reasonCode, 'TRANSFORM_UNCHANGED');
    assert.equal(DEFAULT_FIELD_OPTIONS.trim, false);

    // A typed pipeline does not trim on its own either. The value fails the
    // type's grammar, so section 4 preserves it byte for byte.
    const number = apply(' 42 ', 'NUMBER');
    assert.equal(number.final, ' 42 ');
    assert.equal(number.kind, 'AMBIGUOUS');
    const date = apply(' 2026-03-04 ', 'DATE');
    assert.equal(date.final, ' 2026-03-04 ');
    assert.equal(date.kind, 'AMBIGUOUS');
    const email = apply(' ada@example.com ', 'EMAIL');
    assert.equal(email.final, ' ada@example.com ');
    assert.equal(email.kind, 'INVALID');
    const bool = apply(' yes ', 'BOOLEAN');
    assert.equal(bool.final, ' yes ');
    assert.equal(bool.kind, 'INVALID');
    const enumerated = apply(' Lead ', 'ENUM', { allowedValues: ['Lead'] });
    assert.equal(enumerated.final, ' Lead ');
    assert.equal(enumerated.kind, 'INVALID');
    const identifier = apply(' 007 ', 'IDENTIFIER');
    assert.equal(identifier.final, ' 007 ');
    assert.equal(identifier.kind, 'UNCHANGED');
  });

  it('[R2-002] an approved trim changes only its own field and records TRANSFORM_WHITESPACE_TRIMMED', () => {
    const approved = apply('  padded  ', 'TEXT', { trim: true });
    assert.equal(approved.final, 'padded');
    assert.equal(approved.kind, 'CHANGED_SAFE');
    assert.equal(approved.reasonCode, 'TRANSFORM_WHITESPACE_TRIMMED');
    assert.ok(approved.evidence.some((item) => item.kind === 'WHITESPACE'));

    // The same cell under a field that approved nothing is untouched.
    const other = apply('  padded  ', 'TEXT');
    assert.equal(other.final, '  padded  ');

    // Approval is what makes a typed value readable, and it is recorded.
    const number = apply(' 42 ', 'NUMBER', { trim: true });
    assert.equal(number.final, '42');
    assert.equal(number.reasonCode, 'TRANSFORM_WHITESPACE_TRIMMED');
  });

  it('does not trim a cell that holds only whitespace, because that would empty it', () => {
    const result = apply('   ', 'TEXT');
    assert.equal(result.final, '   ');
    assert.equal(result.kind, 'UNCHANGED');
  });

  it('clears a value only when the configuration authorises exactly that value', () => {
    const result = apply('N/A', 'TEXT', { clearWhenMatches: ['n/a'], destructiveAuthorization: true });
    assert.equal(result.final, null);
    assert.equal(result.kind, 'CLEAR_EXPLICIT');
    assert.equal(result.safetyClass, 'DESTRUCTIVE_EXPLICITLY_AUTHORIZED');
    assert.equal(result.reasonCode, 'TRANSFORM_CLEARED_BY_EXPLICIT_AUTHORIZATION');
  });

  it('leaves an unlisted value alone even when clearing is authorised', () => {
    const result = apply('unknown', 'TEXT', { clearWhenMatches: ['n/a'], destructiveAuthorization: true });
    assert.equal(result.final, 'unknown');
  });
});

describe('email', () => {
  it('lowercases the domain and never the local part', () => {
    const outcome = transformEmail('Ada.Lovelace@Example.COM', true);
    assert.equal(outcome.value, 'Ada.Lovelace@example.com');
  });

  it('does not collapse a plus alias or remove dots', () => {
    const outcome = transformEmail('ada.love+crm@example.com', true);
    assert.equal(outcome.value, 'ada.love+crm@example.com');
    assert.equal(outcome.kind, 'UNCHANGED');
  });

  it('preserves a syntactically invalid address', () => {
    const outcome = transformEmail('not an address', true);
    assert.equal(outcome.kind, 'INVALID');
    assert.equal(outcome.value, 'not an address');
    assert.equal(outcome.reasonCode, 'TRANSFORM_EMAIL_INVALID_SYNTAX');
  });
});

describe('phone numbers', () => {
  const options = { countryEvidence: null, countryEvidenceSource: 'test', extensionDestinationField: null };

  it('uses the international prefix in preference to a configured country', () => {
    const outcome = transformPhone('+44 20 7946 0958', { ...options, countryEvidence: 'US' });
    assert.equal(outcome.value, '+442079460958');
    assert.equal(outcome.reasonCode, 'TRANSFORM_PHONE_E164');
  });

  it('uses the configured country for a national number', () => {
    const outcome = transformPhone('3001234567', { ...options, countryEvidence: 'CO' });
    assert.equal(outcome.value, '+573001234567');
  });

  it('preserves a national number when no country was established', () => {
    const outcome = transformPhone('3001234567', options);
    assert.equal(outcome.kind, 'AMBIGUOUS');
    assert.equal(outcome.value, '3001234567');
    assert.equal(outcome.reasonCode, 'TRANSFORM_PHONE_NO_COUNTRY_EVIDENCE');
  });

  it('preserves a number carrying an extension when there is nowhere to put it', () => {
    const outcome = transformPhone('212-555-0147 ext. 44', { ...options, countryEvidence: 'US' });
    assert.equal(outcome.kind, 'UNSUPPORTED');
    assert.equal(outcome.value, '212-555-0147 ext. 44');
    assert.equal(outcome.reasonCode, 'TRANSFORM_PHONE_EXTENSION_NO_DESTINATION_FIELD');
  });

  it('separates the extension when a destination field is configured', () => {
    const outcome = transformPhone('212-555-0147 ext. 44', {
      ...options,
      countryEvidence: 'US',
      extensionDestinationField: 'contact.phoneExtension',
    });
    assert.equal(outcome.value, '+12125550147');
    assert.equal(outcome.derived['extension'], '44');
  });

  it('preserves a number that is not valid for the established country', () => {
    const outcome = transformPhone('12345', { ...options, countryEvidence: 'US' });
    assert.equal(outcome.kind, 'INVALID');
    assert.equal(outcome.value, '12345');
  });
});

describe('dates', () => {
  it('accepts an ISO date with no declared format', () => {
    const outcome = transformDate('2026-03-04', { declaredFormat: null, spreadsheetDateSystem: null, numberFormat: null });
    assert.equal(outcome.kind, 'UNCHANGED');
    assert.equal(outcome.reasonCode, 'TRANSFORM_DATE_ISO_ACCEPTED');
  });

  it('refuses to interpret a slash date with no declared format', () => {
    const outcome = transformDate('03/04/2026', { declaredFormat: null, spreadsheetDateSystem: null, numberFormat: null });
    assert.equal(outcome.kind, 'AMBIGUOUS');
    assert.equal(outcome.value, '03/04/2026');
  });

  it('reads the same value differently under two declared formats, and says so', () => {
    const american = transformDate('03/04/2026', {
      declaredFormat: 'MM/DD/YYYY',
      spreadsheetDateSystem: null,
      numberFormat: null,
    });
    const european = transformDate('03/04/2026', {
      declaredFormat: 'DD/MM/YYYY',
      spreadsheetDateSystem: null,
      numberFormat: null,
    });
    assert.equal(american.value, '2026-03-04');
    assert.equal(european.value, '2026-04-03');
  });

  it('rejects a date-shaped value that is not a real calendar date', () => {
    const outcome = transformDate('2026-02-30', { declaredFormat: null, spreadsheetDateSystem: null, numberFormat: null });
    assert.equal(outcome.kind, 'INVALID');
    assert.equal(outcome.value, '2026-02-30');
  });

  it('converts spreadsheet serials in both date systems', () => {
    assert.deepEqual(serialToDate(44927, 'DATE_1900'), { year: 2023, month: 1, day: 1 });
    assert.deepEqual(serialToDate(45001, 'DATE_1900'), { year: 2023, month: 3, day: 16 });
    assert.deepEqual(serialToDate(1, 'DATE_1900'), { year: 1900, month: 1, day: 1 });
    assert.deepEqual(serialToDate(0, 'DATE_1904'), { year: 1904, month: 1, day: 1 });
  });

  it('refuses serial 60, the day the 1900 system invents', () => {
    assert.equal(serialToDate(60, 'DATE_1900'), null);
  });
});

describe('timestamps', () => {
  it('preserves a timestamp with no zone and no declared offset', () => {
    const outcome = transformDateTime('2026-03-04T10:30:00', null);
    assert.equal(outcome.kind, 'AMBIGUOUS');
    assert.equal(outcome.reasonCode, 'TRANSFORM_DATETIME_NO_TIMEZONE_EVIDENCE');
  });

  it('normalises to UTC when the source carries an offset', () => {
    const outcome = transformDateTime('2026-03-04T10:30:00+02:00', null);
    assert.equal(outcome.value, '2026-03-04T08:30:00Z');
  });

  it('uses a declared offset when the source has none', () => {
    const outcome = transformDateTime('2026-03-04T10:30:00', '-05:00');
    assert.equal(outcome.value, '2026-03-04T15:30:00Z');
  });
});

/**
 * A declared zone, with the tzdata it was declared against.
 *
 * The expected instants below are worked out by hand from the rules the zones
 * follow in 2026, not read back from the engine: Europe/Madrid moves at 02:00
 * to 03:00 on the last Sunday of March (29 March 2026) and back from 03:00 to
 * 02:00 on the last Sunday of October (25 October 2026); America/New_York
 * moves on the second Sunday of March (8 March) and the first of November (1
 * November).
 */
function zoned(zone: string, overlap: 'REFUSE' | 'EARLIER' | 'LATER', tzdata = process.versions.tz): Partial<FieldOptions> {
  return { timezone: { zone, tzdata, overlap } } as unknown as Partial<FieldOptions>;
}

describe('a declared zone', () => {
  it("[S026] a local time in a declared zone's DST overlap is AMBIGUOUS unless the plan declares EARLIER or LATER", () => {
    // 02:30 on 25 October 2026 happens twice in Madrid: at +02:00 and at +01:00.
    const refused = apply('2026-10-25T02:30:00', 'DATETIME', zoned('Europe/Madrid', 'REFUSE'));
    assert.equal(refused.kind, 'AMBIGUOUS');
    assert.equal(refused.reasonCode, 'TRANSFORM_LOCAL_TIME_AMBIGUOUS');
    assert.equal(refused.final, '2026-10-25T02:30:00', 'the source value is preserved byte for byte');

    const earlier = apply('2026-10-25T02:30:00', 'DATETIME', zoned('Europe/Madrid', 'EARLIER'));
    assert.equal(earlier.final, '2026-10-25T00:30:00Z');
    assert.equal(earlier.kind, 'CHANGED_SAFE');
    const later = apply('2026-10-25T02:30:00', 'DATETIME', zoned('Europe/Madrid', 'LATER'));
    assert.equal(later.final, '2026-10-25T01:30:00Z');

    // The same rule in a zone west of Greenwich: 01:30 on 1 November 2026.
    assert.equal(apply('2026-11-01T01:30:00', 'DATETIME', zoned('America/New_York', 'REFUSE')).kind, 'AMBIGUOUS');
    assert.equal(apply('2026-11-01T01:30:00', 'DATETIME', zoned('America/New_York', 'EARLIER')).final, '2026-11-01T05:30:00Z');
    assert.equal(apply('2026-11-01T01:30:00', 'DATETIME', zoned('America/New_York', 'LATER')).final, '2026-11-01T06:30:00Z');

    // An ordinary time is not touched by the overlap policy, in either season.
    assert.equal(apply('2026-07-01T12:00:00', 'DATETIME', zoned('Europe/Madrid', 'REFUSE')).final, '2026-07-01T10:00:00Z');
    assert.equal(apply('2026-01-15T12:00:00', 'DATETIME', zoned('Europe/Madrid', 'REFUSE')).final, '2026-01-15T11:00:00Z');
    // Just outside the repeated hour, on both sides.
    assert.equal(apply('2026-10-25T01:59:59', 'DATETIME', zoned('Europe/Madrid', 'REFUSE')).final, '2026-10-24T23:59:59Z');
    assert.equal(apply('2026-10-25T03:00:00', 'DATETIME', zoned('Europe/Madrid', 'REFUSE')).final, '2026-10-25T02:00:00Z');

    // An offset the value carries outranks the declared zone.
    assert.equal(apply('2026-10-25T02:30:00+01:00', 'DATETIME', zoned('Europe/Madrid', 'REFUSE')).final, '2026-10-25T01:30:00Z');
  });

  it('[R2-008] a nonexistent local time in the declared zone is unresolved and preserved, never shifted', () => {
    // 02:30 on 29 March 2026 does not exist in Madrid: the clock goes 01:59:59 -> 03:00:00.
    for (const overlap of ['REFUSE', 'EARLIER', 'LATER'] as const) {
      const gap = apply('2026-03-29T02:30:00', 'DATETIME', zoned('Europe/Madrid', overlap));
      assert.equal(gap.kind, 'AMBIGUOUS', overlap);
      assert.equal(gap.reasonCode, 'TRANSFORM_LOCAL_TIME_NONEXISTENT', overlap);
      assert.equal(gap.final, '2026-03-29T02:30:00', 'preserved, not moved to 03:30 or 01:30');
    }
    const newYork = apply('2026-03-08T02:30:00', 'DATETIME', zoned('America/New_York', 'EARLIER'));
    assert.equal(newYork.reasonCode, 'TRANSFORM_LOCAL_TIME_NONEXISTENT');
    // The edges of the missing hour: 01:59:59 exists, 03:00:00 exists.
    assert.equal(apply('2026-03-29T01:59:59', 'DATETIME', zoned('Europe/Madrid', 'REFUSE')).final, '2026-03-29T00:59:59Z');
    assert.equal(apply('2026-03-29T03:00:00', 'DATETIME', zoned('Europe/Madrid', 'REFUSE')).final, '2026-03-29T01:00:00Z');
  });

  it("[R2-008] a plan whose tzdata version differs from the runtime's is refused", () => {
    assert.throws(
      () => apply('2026-07-01T12:00:00', 'DATETIME', zoned('Europe/Madrid', 'REFUSE', '1999a')),
      (error: unknown) => isMigrationError(error) && error.code === 'CONFIG_INVALID' && /tzdata/u.test(error.message),
    );
    const plan = (timezone: Record<string, unknown>): string =>
      JSON.stringify({
        configVersion: CONFIG_SCHEMA_VERSION,
        source: { system: 'crm', namespace: 'acme' },
        target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' },
        files: [{ id: 'contacts', path: 'contacts.csv', format: 'CSV' }],
        records: [
          {
            id: 'contacts',
            fileId: 'contacts',
            object: 'CONTACT',
            fields: [
              { column: { header: 'When' }, destinationField: 'contact.createdAt', semanticType: 'DATETIME', options: { timezone } },
            ],
          },
        ],
      });
    // The plan is refused when it is loaded, before any source is read.
    assert.throws(
      () => loadConfig(plan({ zone: 'Europe/Madrid', tzdata: '1999a', overlap: 'REFUSE' }), 'test.json'),
      (error: unknown) => isMigrationError(error) && error.code === 'CONFIG_INVALID' && /tzdata/u.test(error.message),
    );
    // A zone alone, with no tzdata, is not a plan the schema accepts.
    assert.throws(() => loadConfig(plan({ zone: 'Europe/Madrid', overlap: 'REFUSE' }), 'test.json'));
    // The runtime's own tzdata is accepted, and so is a plan that names it.
    const accepted = loadConfig(plan({ zone: 'Europe/Madrid', tzdata: process.versions.tz ?? '', overlap: 'REFUSE' }), 'test.json');
    const declared = accepted.config.records[0]?.fields[0]?.options as unknown as { timezone?: { zone: string } } | undefined;
    assert.equal(declared?.timezone?.zone, 'Europe/Madrid');
    assert.equal(apply('2026-07-01T12:00:00', 'DATETIME', zoned('Europe/Madrid', 'REFUSE')).final, '2026-07-01T10:00:00Z');
  });
});

describe('numbers', () => {
  it('accepts plain digits with no declared separators', () => {
    assert.equal(transformNumber('1234.56', null, null).kind, 'UNCHANGED');
  });

  it('refuses to guess a separator convention', () => {
    const outcome = transformNumber('1.234', null, null);
    assert.equal(outcome.kind, 'UNCHANGED');
    const grouped = transformNumber('1.234,56', null, null);
    assert.equal(grouped.kind, 'AMBIGUOUS');
    assert.equal(grouped.value, '1.234,56');
  });

  it('reads a European convention when it is declared', () => {
    const outcome = transformNumber('1.234,56', ',', '.');
    assert.equal(outcome.value, '1234.56');
    assert.equal(outcome.reasonCode, 'TRANSFORM_NUMBER_PARSED');
  });
});

describe('booleans and enumerations', () => {
  it('uses the declared vocabulary', () => {
    assert.equal(transformBoolean('YES', ['yes'], ['no']).value, 'true');
    assert.equal(transformBoolean('maybe', ['yes'], ['no']).kind, 'INVALID');
  });

  it('preserves an option outside the declared set', () => {
    const outcome = transformEnum('Platinum', ['Gold', 'Silver']);
    assert.equal(outcome.kind, 'INVALID');
    assert.equal(outcome.value, 'Platinum');
  });
});

describe('identifiers', () => {
  it('keeps leading zeros', () => {
    assert.equal(apply('01730', 'IDENTIFIER').final, '01730');
  });

  it('flags an identifier the spreadsheet had already stored as a number', () => {
    const result = apply('1730', 'IDENTIFIER', {}, { cell: { kind: 'XLSX_NUMBER' } });
    assert.equal(result.reasonCode, 'TRANSFORM_IDENTIFIER_NUMERIC_IN_SOURCE');
  });
});

describe('spreadsheet formulas', () => {
  it('does not deliver a cached formula result by default', () => {
    const result = apply('Ada Lovelace', 'TEXT', {}, { cell: { formula: 'CONCATENATE(A1,B1)' } });
    assert.equal(result.kind, 'UNSUPPORTED');
    assert.equal(result.final, 'Ada Lovelace');
    assert.equal(result.reasonCode, 'TRANSFORM_FORMULA_CACHED_VALUE_NOT_AUTHORIZED');
    assert.ok(result.evidence.some((item) => item.detail.includes('CONCATENATE')));
  });

  it('delivers it with provenance when the configuration authorises it', () => {
    const result = apply(
      'Ada Lovelace',
      'TEXT',
      {},
      {
        cell: { formula: 'CONCATENATE(A1,B1)' },
        policies: { ...DEFAULT_POLICIES, formulaCachedValues: 'ACCEPT_WITH_PROVENANCE' },
      },
    );
    assert.equal(result.final, 'Ada Lovelace');
    assert.equal(result.reasonCode, 'TRANSFORM_FORMULA_CACHED_VALUE_ACCEPTED');
  });

  it('[R2-013] under ACCEPT_WITH_PROVENANCE a formula with no cached value is UNSUPPORTED with TRANSFORM_FORMULA_CACHED_VALUE_ABSENT, never OMIT', () => {
    const policies = { ...DEFAULT_POLICIES, formulaCachedValues: 'ACCEPT_WITH_PROVENANCE' } as const;
    // The reviewer's reproduction: a TEXT mapping, an XLSX_NUMBER cell, formula '1+1', raw null.
    const reproduction = apply(null, 'TEXT', {}, { cell: { kind: 'XLSX_NUMBER', formula: '1+1' }, policies });
    assert.equal(reproduction.kind, 'UNSUPPORTED');
    assert.equal(reproduction.reasonCode, 'TRANSFORM_FORMULA_CACHED_VALUE_ABSENT');
    // Not the UNCHANGED outcome that B01-R4 saw: that one is delivered as an omission.
    // UNSUPPORTED is what isolates the row (see A15-formula-without-cache).
    assert.notEqual(reproduction.kind, 'UNCHANGED');
    assert.notEqual(reproduction.reasonCode, 'TRANSFORM_FORMULA_CACHED_VALUE_ACCEPTED');
    assert.ok(reproduction.evidence.some((item) => item.detail.includes('1+1')));
    // The reader's own statement of the same fact.
    const declared = apply(null, 'TEXT', {}, {
      cell: { kind: 'XLSX_NUMBER', formula: '1+1', cachedValue: 'ABSENT' },
      policies,
    });
    assert.equal(declared.kind, 'UNSUPPORTED');
    assert.equal(declared.reasonCode, 'TRANSFORM_FORMULA_CACHED_VALUE_ABSENT');
  });

  it('[R2-013] under ISOLATE_ROW the absent cache is named as absent, not as unauthorised', () => {
    const result = apply(null, 'TEXT', {}, {
      cell: { kind: 'XLSX_NUMBER', formula: '1+1', cachedValue: 'ABSENT' },
      policies: { ...DEFAULT_POLICIES, formulaCachedValues: 'ISOLATE_ROW' },
    });
    assert.equal(result.kind, 'UNSUPPORTED');
    assert.equal(result.reasonCode, 'TRANSFORM_FORMULA_CACHED_VALUE_ABSENT');
  });

  it('[R2-013] a cached empty string is delivered with provenance', () => {
    const result = apply('', 'TEXT', {}, {
      cell: { kind: 'XLSX_INLINE_STRING', formula: 'A1&""', cachedValue: 'PRESENT' },
      policies: { ...DEFAULT_POLICIES, formulaCachedValues: 'ACCEPT_WITH_PROVENANCE' },
    });
    assert.equal(result.kind, 'UNCHANGED');
    assert.equal(result.final, '');
    assert.equal(result.reasonCode, 'TRANSFORM_FORMULA_CACHED_VALUE_ACCEPTED');
    assert.ok(result.evidence.some((item) => item.kind === 'FORMULA_PROVENANCE'));
  });

  it('never treats a spreadsheet error value as data worth clearing', () => {
    const result = apply('#REF!', 'TEXT', {}, { cell: { kind: 'XLSX_ERROR' } });
    assert.equal(result.kind, 'INVALID');
    assert.equal(result.final, '#REF!');
  });
});

describe('the configured normalization primitives', () => {
  it('changes nothing at all by default', () => {
    // The old expectation was that the value came back trimmed: every field
    // trimmed unless told not to. Whitespace is a value (D67), so nothing
    // happens to it until the field approves.
    const result = apply(' MIGUEL LOPEZ ', 'TEXT');
    assert.equal(result.final, ' MIGUEL LOPEZ ');
    assert.equal(result.kind, 'UNCHANGED');
    assert.equal(result.reasonCode, 'TRANSFORM_UNCHANGED');
  });

  it('composes to NFC only when the plan asks for it', () => {
    const decomposed = 'Dise\u00f1adora S\u00e9nior'.normalize('NFD');
    const composed = 'Dise\u00f1adora S\u00e9nior'.normalize('NFC');
    assert.notEqual(decomposed, composed);

    assert.equal(apply(decomposed, 'TEXT').final, decomposed);

    const result = apply(decomposed, 'TEXT', { unicodeNormalization: 'NFC' });
    assert.equal(result.final, composed);
    assert.equal(result.kind, 'CHANGED_SAFE');
    assert.equal(result.reasonCode, 'TRANSFORM_CONFIGURED_NORMALIZATION_APPLIED');
    assert.ok(result.evidence.some((item) => item.kind === 'UNICODE_NORMALIZATION' && item.detail === 'NFC'));
  });

  it('composing twice is composing once', () => {
    const once = apply('Diseñadora', 'TEXT', { unicodeNormalization: 'NFC' }).final ?? '';
    assert.equal(apply(once, 'TEXT', { unicodeNormalization: 'NFC' }).final, once);
  });

  it('cases mechanically, exactly as the contract states', () => {
    const title = (input: string): string | null =>
      apply(input, 'TEXT', { caseTransform: 'TITLE_SIMPLE' }).final;
    assert.equal(title('MIGUEL LOPEZ'), 'Miguel Lopez');
    assert.equal(title('ANNA-MARIE'), 'Anna-Marie');
    assert.equal(title("O'NEILL"), "O'Neill");
    assert.equal(title('O’NEILL'), 'O’Neill');

    // Stated plainly rather than promised away: a mechanical rule cannot know
    // these, which is what valueMap is for.
    assert.equal(title('MCNAMARA'), 'Mcnamara');
    assert.equal(title('eBay'), 'Ebay');
  });

  it('lowercases and uppercases without consulting the operating system locale', () => {
    assert.equal(apply('İstanbul Ltd', 'TEXT', { caseTransform: 'LOWER' }).final, 'İstanbul Ltd'.toLowerCase());
    assert.equal(apply('Diseñadora', 'TEXT', { caseTransform: 'UPPER' }).final, 'DISEÑADORA');
  });

  it('walks code points rather than code units', () => {
    // A letter outside the Basic Multilingual Plane is two code units. Casing
    // it by unit would cut the surrogate pair in half.
    const result = apply('\u{1d49c}da lovelace', 'TEXT', { caseTransform: 'TITLE_SIMPLE' });
    assert.equal(result.final, '\u{1d49c}da Lovelace');
  });

  it('gives an exact mapping the last word, and skips the case rule for it', () => {
    const result = apply(' MCDONALD ', 'TEXT', {
      trim: true,
      caseTransform: 'TITLE_SIMPLE',
      valueMap: [{ from: 'MCDONALD', to: 'McDonald' }],
    });
    assert.equal(result.final, 'McDonald');
    assert.equal(result.reasonCode, 'TRANSFORM_CONFIGURED_NORMALIZATION_APPLIED');
    assert.ok(result.evidence.some((item) => item.kind === 'VALUE_MAP'));
    assert.ok(!result.evidence.some((item) => item.kind === 'CASE_TRANSFORM'));
  });

  it('still cases a value no mapping claimed', () => {
    const result = apply('RONALD', 'TEXT', {
      caseTransform: 'TITLE_SIMPLE',
      valueMap: [{ from: 'MCDONALD', to: 'McDonald' }],
    });
    assert.equal(result.final, 'Ronald');
    assert.ok(result.evidence.some((item) => item.kind === 'CASE_TRANSFORM' && item.detail === 'TITLE_SIMPLE'));
  });

  it('does not turn a mapped column into a closed vocabulary', () => {
    // A value that matches nothing is carried through, not rejected. Closing a
    // vocabulary is semanticType ENUM with allowedValues.
    const result = apply('reseller', 'TEXT', {
      valueMap: [{ from: 'cliente', to: 'Customer' }],
    });
    assert.equal(result.final, 'reseller');
    assert.equal(result.kind, 'UNCHANGED');
  });

  it('maps categories the plan declares', () => {
    const options = {
      valueMap: [
        { from: 'cliente', to: 'Customer' },
        { from: 'cliente viejo', to: 'Customer' },
        { from: 'prospecto', to: 'Lead' },
        { from: 'partner', to: 'Partner' },
      ],
    };
    assert.equal(apply('cliente', 'TEXT', options).final, 'Customer');
    assert.equal(apply('cliente viejo', 'TEXT', options).final, 'Customer');
    assert.equal(apply('prospecto', 'TEXT', options).final, 'Lead');
    assert.equal(apply('partner', 'TEXT', options).final, 'Partner');
  });

  it('compares a mapping in the same form the value reaches it in', () => {
    const decomposedFrom = 'S\u00e9nior'.normalize('NFD');
    const result = apply(` ${'S\u00e9nior'.normalize('NFC')} `, 'TEXT', {
      trim: true,
      unicodeNormalization: 'NFC',
      valueMap: [{ from: decomposedFrom, to: 'Senior Designer' }],
    });
    assert.equal(result.final, 'Senior Designer');
  });

  it('preserves the raw cell exactly when the semantic transform will not accept the result', () => {
    // The mapped value is what ENUM was asked to validate, and it is not in the
    // declared set. The delivered value is the untouched source cell, including
    // its whitespace; the work done on the way in stays in the evidence.
    const result = apply('  cliente  ', 'ENUM', {
      trim: true,
      allowedValues: ['Customer', 'Lead'],
      valueMap: [{ from: 'cliente', to: 'Prospect' }],
    });
    assert.equal(result.kind, 'INVALID');
    assert.equal(result.final, '  cliente  ');
    assert.equal(result.reasonCode, 'TRANSFORM_ENUM_VALUE_NOT_IN_DECLARED_SET');
    assert.ok(result.evidence.some((item) => item.kind === 'VALUE_MAP'));
  });

  it('lets a mapping put a value into the declared set', () => {
    const result = apply('  cliente  ', 'ENUM', {
      trim: true,
      allowedValues: ['Customer', 'Lead'],
      valueMap: [{ from: 'cliente', to: 'Customer' }],
    });
    assert.equal(result.kind, 'CHANGED_SAFE');
    assert.equal(result.final, 'Customer');
  });

  it('never empties a populated cell, whatever the plan configures', () => {
    // The only populated-to-empty path is clearWhenMatches with
    // destructiveAuthorization, so a whitespace-only cell survives the case
    // rule intact.
    const result = apply('   ', 'TEXT', { caseTransform: 'UPPER', unicodeNormalization: 'NFC' });
    assert.equal(result.final, '   ');
    assert.equal(result.kind, 'UNCHANGED');
  });
});
