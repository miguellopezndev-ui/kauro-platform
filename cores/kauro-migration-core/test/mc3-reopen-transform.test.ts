import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  MAX_SERIAL_1900,
  MAX_SERIAL_1904,
  isRealDate,
  serialToDate,
  transformDate,
  transformDateTime,
  transformNumber,
} from '../src/transform/transformations.js';
import {
  civilFromDays,
  daysFromCivil,
  renderIsoUtcInstant,
  toUtcInstant,
} from '../src/transform/civil-calendar.js';
import type { StepOutcome } from '../src/transform/transformations.js';

// Audit KAURO_AUDITORIA_MC_IC_20260911_V1 §4, findings MC-05 and MC-06.
// Every "refuses" case below was CHANGED_SAFE (or a wrong value) on the frozen
// main a2a549031de85d95be8645dd9c5156dfff2050a0.

function assertPreservedInvalid(outcome: StepOutcome, input: string, reasonCode: string): void {
  assert.equal(outcome.kind, 'INVALID', `${JSON.stringify(input)} must be INVALID, got ${outcome.kind} -> ${String(outcome.value)}`);
  assert.equal(outcome.value, input, 'an INVALID outcome preserves the source value byte for byte');
  assert.equal(outcome.reasonCode, reasonCode);
}

function assertParsed(outcome: StepOutcome, expected: string): void {
  assert.equal(outcome.kind, 'CHANGED_SAFE', `expected CHANGED_SAFE -> ${expected}, got ${outcome.kind} -> ${String(outcome.value)}`);
  assert.equal(outcome.value, expected);
  assert.equal(outcome.reasonCode, 'TRANSFORM_NUMBER_PARSED');
}

describe('MC-05: the numeric grammar is validated before any separator is removed', () => {
  const US: readonly [string, string] = ['.', ','];
  const EU: readonly [string, string] = [',', '.'];
  const SPACE: readonly [string, string] = [',', ' '];
  const APOSTROPHE: readonly [string, string] = ['.', "'"];

  it('refuses the three audit inputs instead of reinterpreting them', () => {
    // Frozen main: '1,2,3' -> 123, '12,34.56' -> 1234.56, '123.45,67' -> 123.4567, all CHANGED_SAFE.
    assertPreservedInvalid(transformNumber('1,2,3', ...US), '1,2,3', 'TRANSFORM_NUMBER_INVALID');
    assertPreservedInvalid(transformNumber('12,34.56', ...US), '12,34.56', 'TRANSFORM_NUMBER_INVALID');
    assertPreservedInvalid(transformNumber('123.45,67', ...US), '123.45,67', 'TRANSFORM_NUMBER_INVALID');
  });

  it('still reads the audit control and other well-formed groupings', () => {
    assertParsed(transformNumber('1,234.56', ...US), '1234.56');
    assertParsed(transformNumber('1,234,567.891', ...US), '1234567.891');
    assertParsed(transformNumber('1,234', ...US), '1234');
    assertParsed(transformNumber('123,456', ...US), '123456');
    assertParsed(transformNumber('-1,234.56', ...US), '-1234.56');
    assert.equal(transformNumber('1234.5', ...US).kind, 'UNCHANGED');
    assert.equal(transformNumber('1234.56', ...US).kind, 'UNCHANGED');
    assert.equal(transformNumber('-7', ...US).kind, 'UNCHANGED');
    assert.equal(transformNumber('0', ...US).kind, 'UNCHANGED');
  });

  it('refuses grouping after the decimal separator', () => {
    for (const input of ['1,234.56,7', '1.234,567', '1.2,3', '1,234.5,6']) {
      assertPreservedInvalid(transformNumber(input, ...US), input, 'TRANSFORM_NUMBER_INVALID');
    }
  });

  it('refuses incomplete, empty, repeated and oversized groups', () => {
    for (const input of ['1,23', '1,2345', '1234,567', ',234', '1,,234', '1,234,', '1,234,56', '1,', ',']) {
      assertPreservedInvalid(transformNumber(input, ...US), input, 'TRANSFORM_NUMBER_INVALID');
    }
  });

  it('refuses more than one decimal separator and a decimal with nothing on either side', () => {
    for (const input of ['1.2.3', '1..2', '1.', '.5', '-.5', '-', '']) {
      assertPreservedInvalid(transformNumber(input, ...US), input, 'TRANSFORM_NUMBER_INVALID');
    }
  });

  it('does not treat leading or trailing whitespace as part of a number', () => {
    for (const input of [' 1,234.56', '1,234.56 ', ' 1234', '1234\t', '1 234']) {
      assertPreservedInvalid(transformNumber(input, ...US), input, 'TRANSFORM_NUMBER_INVALID');
    }
  });

  it('applies the same grammar to the European convention', () => {
    assertParsed(transformNumber('1.234,56', ...EU), '1234.56');
    assertParsed(transformNumber('1.234.567,8', ...EU), '1234567.8');
    assertParsed(transformNumber('1234,5', ...EU), '1234.5');
    assertParsed(transformNumber('-0,5', ...EU), '-0.5');
    for (const input of ['1.2.3', '12.34,56', '123,45.67', '1,234.56', '1.5', '1.23', '1,234,56']) {
      assertPreservedInvalid(transformNumber(input, ...EU), input, 'TRANSFORM_NUMBER_INVALID');
    }
  });

  it('reads space and apostrophe grouping, which the config schema allows, under the same rule', () => {
    assertParsed(transformNumber('1 234 567,89', ...SPACE), '1234567.89');
    assertParsed(transformNumber('12 345', ...SPACE), '12345');
    for (const input of ['1 2 3', '1 23', '12 34,56', '1 234,5 6', ' 1 234', '1 234 ']) {
      assertPreservedInvalid(transformNumber(input, ...SPACE), input, 'TRANSFORM_NUMBER_INVALID');
    }
    assertParsed(transformNumber("1'234'567.89", ...APOSTROPHE), '1234567.89');
    for (const input of ["1'2'3", "1'23", "12'34.56", "1'234.5'6", "'234"]) {
      assertPreservedInvalid(transformNumber(input, ...APOSTROPHE), input, 'TRANSFORM_NUMBER_INVALID');
    }
  });

  it('does not accept any grouping when the source declares NONE or no grouping', () => {
    assert.equal(transformNumber('1234.56', '.', 'NONE').kind, 'UNCHANGED');
    assertParsed(transformNumber('1234,56', ',', 'NONE'), '1234.56');
    assertParsed(transformNumber('1234,56', ',', null), '1234.56');
    for (const [input, decimal, grouping] of [
      ['1,234.56', '.', 'NONE'],
      ['1.234,56', ',', 'NONE'],
      ['1.234,56', ',', null],
      ['1.5', ',', null],
    ] as const) {
      assertPreservedInvalid(transformNumber(input, decimal, grouping), input, 'TRANSFORM_NUMBER_INVALID');
    }
  });

  it('refuses to read anything when both declared separators are the same character', () => {
    // Frozen main: '1.5' with decimal "." and grouping "." became 15.
    assertPreservedInvalid(transformNumber('1.5', '.', '.'), '1.5', 'TRANSFORM_NUMBER_INVALID');
    assertPreservedInvalid(transformNumber('1,5', ',', ','), '1,5', 'TRANSFORM_NUMBER_INVALID');
  });

  it('keeps the no-separators-declared behaviour unchanged', () => {
    assert.equal(transformNumber('1234.56', null, null).kind, 'UNCHANGED');
    const grouped = transformNumber('1,2,3', null, null);
    assert.equal(grouped.kind, 'AMBIGUOUS');
    assert.equal(grouped.value, '1,2,3');
  });

  it('never returns a candidate that is not a plain decimal number', () => {
    const plain = /^-?[0-9]+(\.[0-9]+)?$/u;
    const inputs = ['1,234.56', '1,2,3', '12,34.56', '123.45,67', '1,234', '1,', '-1,234,567.0', '1,234.5,6', '1234'];
    for (const [decimal, grouping] of [US, EU, SPACE, APOSTROPHE, ['.', 'NONE'], [',', null]] as const) {
      for (const input of inputs) {
        const out = transformNumber(input, decimal, grouping);
        if (out.kind === 'CHANGED_SAFE' || out.kind === 'UNCHANGED') {
          assert.match(String(out.value), plain, `${input} under (${decimal}, ${String(grouping)}) produced ${String(out.value)}`);
        } else {
          assert.equal(out.kind, 'INVALID');
          assert.equal(out.value, input);
        }
      }
    }
  });
});

const ISO_DATE_CONTEXT = { declaredFormat: null, spreadsheetDateSystem: null, numberFormat: null } as const;

describe('MC-06: dates keep their literal year and refuse unrepresentable serials', () => {
  it('delivers the audit timestamp 0099-01-02T03:04:05Z with its own century', () => {
    // Frozen main: 0099-01-02T03:04:05Z -> 1999-01-02T03:04:05Z with verify=true.
    const outcome = transformDateTime('0099-01-02T03:04:05Z', null);
    assert.equal(outcome.kind, 'UNCHANGED');
    assert.equal(outcome.value, '0099-01-02T03:04:05Z');
    assert.notEqual(outcome.value, '1999-01-02T03:04:05Z');
  });

  it('keeps the year 2000 control and the offset arithmetic', () => {
    assert.equal(transformDateTime('2000-01-02T03:04:05Z', null).value, '2000-01-02T03:04:05Z');
    assert.equal(transformDateTime('2026-03-04T10:30:00+02:00', null).value, '2026-03-04T08:30:00Z');
    assert.equal(transformDateTime('2026-03-04T10:30:00', '-05:00').value, '2026-03-04T15:30:00Z');
    assert.equal(transformDateTime('2026-03-04T10:30:00.250+02:00', null).value, '2026-03-04T08:30:00.250Z');
    assert.equal(transformDateTime('2026-03-04T10:30:00.5Z', null).value, '2026-03-04T10:30:00.500Z');
    assert.equal(transformDateTime('2026-12-31T23:30:00-01:00', null).value, '2027-01-01T00:30:00Z');
    assert.equal(transformDateTime('2024-03-01T00:30:00+01:00', null).value, '2024-02-29T23:30:00Z');
  });

  it('shifts two-digit and edge years without moving them into the twentieth century', () => {
    assert.equal(transformDateTime('0001-01-01T00:00:00Z', null).value, '0001-01-01T00:00:00Z');
    assert.equal(transformDateTime('0099-12-31T23:30:00-01:00', null).value, '0100-01-01T00:30:00Z');
    assert.equal(transformDateTime('0050-06-15T12:00:00', '+02:00').value, '0050-06-15T10:00:00Z');
    assert.equal(transformDateTime('9999-12-31T23:59:59Z', null).value, '9999-12-31T23:59:59Z');
    assert.equal(transformDateTime('9999-12-31T23:59:59.999+00:30', null).value, '9999-12-31T23:29:59.999Z');
  });

  it('refuses an instant that leaves the supported years once shifted to UTC', () => {
    for (const [input, offset] of [
      ['0001-01-01T00:00:00+01:00', null],
      ['0001-01-01T00:30:00', '+01:00'],
      ['9999-12-31T23:30:00-01:00', null],
      ['0000-06-15T12:00:00Z', null],
    ] as const) {
      const outcome = transformDateTime(input, offset);
      assert.equal(outcome.kind, 'INVALID', `${input} / ${String(offset)} -> ${String(outcome.value)}`);
      assert.equal(outcome.value, input);
      assert.equal(outcome.reasonCode, 'TRANSFORM_DATE_INVALID_FOR_DECLARED_FORMAT');
    }
  });

  it('accepts ISO calendar dates across the supported range and refuses year 0000', () => {
    for (const input of ['0001-01-01', '0099-01-02', '2000-02-29', '9999-12-31']) {
      const outcome = transformDate(input, ISO_DATE_CONTEXT);
      assert.equal(outcome.kind, 'UNCHANGED', input);
      assert.equal(outcome.value, input);
    }
    const zero = transformDate('0000-01-01', ISO_DATE_CONTEXT);
    assert.equal(zero.kind, 'INVALID');
    assert.equal(zero.value, '0000-01-01');
    assert.equal(isRealDate({ year: 0, month: 1, day: 1 }), false);
    assert.equal(isRealDate({ year: 10_000, month: 1, day: 1 }), false);
    assert.equal(isRealDate({ year: 99, month: 2, day: 28 }), true);
    assert.equal(isRealDate({ year: 100, month: 2, day: 29 }), false);
  });

  it('renders a declared-format date with a two-digit year literally', () => {
    const outcome = transformDate('02/01/0099', { declaredFormat: 'DD/MM/YYYY', spreadsheetDateSystem: null, numberFormat: null });
    assert.equal(outcome.kind, 'CHANGED_SAFE');
    assert.equal(outcome.value, '0099-01-02');
  });

  it('refuses the audit serial 1000000000 and keeps the serial 45000 control', () => {
    // Frozen main: serial 1000000000 -> "0NaN-NaN-NaN" as CHANGED_SAFE.
    const context = { declaredFormat: null, spreadsheetDateSystem: 'DATE_1900', numberFormat: 'yyyy-mm-dd' } as const;
    const overflow = transformDate('1000000000', context);
    assert.equal(overflow.kind, 'INVALID');
    assert.equal(overflow.value, '1000000000');
    assert.equal(overflow.reasonCode, 'TRANSFORM_DATE_INVALID_FOR_DECLARED_FORMAT');
    assert.equal(serialToDate(1_000_000_000, 'DATE_1900'), null);
    assert.equal(serialToDate(1_000_000_000, 'DATE_1904'), null);

    const control = transformDate('45000', context);
    assert.equal(control.kind, 'CHANGED_SAFE');
    assert.equal(control.value, '2023-03-15');
    assert.equal(control.reasonCode, 'TRANSFORM_DATE_FROM_SPREADSHEET_SERIAL');
  });

  it('never emits NaN, an empty month or a year outside 0001–9999 from any serial', () => {
    const rendered = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/u;
    for (const system of ['DATE_1900', 'DATE_1904'] as const) {
      for (const serial of ['-1', '0', '59', '60', '61', '2958465', '2958466', '2957003', '2957004', '1e12', 'NaN', 'Infinity', '-Infinity', '4102444800', '1000000000']) {
        const outcome = transformDate(serial, { declaredFormat: null, spreadsheetDateSystem: system, numberFormat: 'd/m/yyyy' });
        if (outcome.kind === 'INVALID') {
          assert.equal(outcome.value, serial);
        } else {
          assert.match(String(outcome.value), rendered, `${system} serial ${serial} rendered ${String(outcome.value)}`);
        }
      }
    }
  });

  it('handles the 1900 system edges: 0, 60, 61, the last day of 9999 and one beyond', () => {
    assert.equal(serialToDate(0, 'DATE_1900'), null);
    assert.equal(serialToDate(-1, 'DATE_1900'), null);
    assert.deepEqual(serialToDate(1, 'DATE_1900'), { year: 1900, month: 1, day: 1 });
    assert.deepEqual(serialToDate(59, 'DATE_1900'), { year: 1900, month: 2, day: 28 });
    assert.equal(serialToDate(60, 'DATE_1900'), null);
    assert.deepEqual(serialToDate(61, 'DATE_1900'), { year: 1900, month: 3, day: 1 });
    assert.deepEqual(serialToDate(45000, 'DATE_1900'), { year: 2023, month: 3, day: 15 });
    assert.deepEqual(serialToDate(45000.75, 'DATE_1900'), { year: 2023, month: 3, day: 15 });
    assert.deepEqual(serialToDate(MAX_SERIAL_1900, 'DATE_1900'), { year: 9999, month: 12, day: 31 });
    assert.equal(MAX_SERIAL_1900, 2_958_465);
    assert.equal(serialToDate(MAX_SERIAL_1900 + 1, 'DATE_1900'), null);
    assert.equal(serialToDate(MAX_SERIAL_1900 + 0.5, 'DATE_1900')?.year, 9999);
    assert.equal(serialToDate(Number.NaN, 'DATE_1900'), null);
    assert.equal(serialToDate(Number.POSITIVE_INFINITY, 'DATE_1900'), null);
  });

  it('handles the 1904 system edges: 0, negatives, the last day of 9999 and one beyond', () => {
    assert.deepEqual(serialToDate(0, 'DATE_1904'), { year: 1904, month: 1, day: 1 });
    assert.equal(serialToDate(-1, 'DATE_1904'), null);
    assert.deepEqual(serialToDate(59, 'DATE_1904'), { year: 1904, month: 2, day: 29 });
    assert.deepEqual(serialToDate(60, 'DATE_1904'), { year: 1904, month: 3, day: 1 });
    assert.deepEqual(serialToDate(45000 - 1462, 'DATE_1904'), { year: 2023, month: 3, day: 15 });
    assert.deepEqual(serialToDate(MAX_SERIAL_1904, 'DATE_1904'), { year: 9999, month: 12, day: 31 });
    assert.equal(MAX_SERIAL_1904, 2_957_003);
    assert.equal(serialToDate(MAX_SERIAL_1904 + 1, 'DATE_1904'), null);
    assert.equal(serialToDate(Number.NaN, 'DATE_1904'), null);
  });
});

describe('the civil calendar helper agrees with Date where Date is trustworthy and stays exact where it is not', () => {
  it('round-trips every day from 1899-12-30 to 2200-12-31 against Date.UTC', () => {
    const start = Date.UTC(1899, 11, 30) / 86_400_000;
    const end = Date.UTC(2200, 11, 31) / 86_400_000;
    for (let days = start; days <= end; days += 1) {
      const date = new Date(days * 86_400_000);
      const expected = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
      assert.deepEqual(civilFromDays(days), expected);
      assert.equal(daysFromCivil(expected), days);
    }
  });

  it('is exact for two-digit years, where Date.UTC is not', () => {
    const days = daysFromCivil({ year: 99, month: 1, day: 2 });
    assert.deepEqual(civilFromDays(days), { year: 99, month: 1, day: 2 });
    assert.notEqual(Date.UTC(99, 0, 2) / 86_400_000, days);
    assert.deepEqual(civilFromDays(daysFromCivil({ year: 1, month: 1, day: 1 })), { year: 1, month: 1, day: 1 });
    assert.deepEqual(civilFromDays(daysFromCivil({ year: 9999, month: 12, day: 31 })), { year: 9999, month: 12, day: 31 });
  });

  it('returns null rather than a year it cannot spell', () => {
    assert.equal(civilFromDays(daysFromCivil({ year: 1, month: 1, day: 1 }) - 1), null);
    assert.equal(civilFromDays(daysFromCivil({ year: 9999, month: 12, day: 31 }) + 1), null);
    assert.equal(civilFromDays(Number.NaN), null);
    assert.equal(civilFromDays(1e300), null);
    assert.equal(toUtcInstant({ year: 1, month: 1, day: 1, hour: 0, minute: 0, second: 0, millisecond: 0 }, 60), null);
  });

  it('renders instants with a four-digit year and milliseconds only when present', () => {
    assert.equal(
      renderIsoUtcInstant({ year: 99, month: 1, day: 2, hour: 3, minute: 4, second: 5, millisecond: 0 }),
      '0099-01-02T03:04:05Z',
    );
    assert.equal(
      renderIsoUtcInstant({ year: 2026, month: 3, day: 4, hour: 8, minute: 30, second: 0, millisecond: 7 }),
      '2026-03-04T08:30:00.007Z',
    );
  });
});
