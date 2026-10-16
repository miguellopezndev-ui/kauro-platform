import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  DEFAULT_SPOOL_LIMITS,
  materialisedFamily,
  mapFamily,
  openFamily,
  orderKey,
  orderNumber,
  rowOrderKey,
  rowOrderParts,
  selectFrom,
} from '../../src/run/spool.js';
import type { SpooledFamily } from '../../src/run/spool.js';
import { isMigrationError } from '../../src/domain/errors.js';
import { CoreInvariantError } from '../../src/util/assert.js';
import { compareCodeUnits } from '../../src/util/json.js';
import { caseScratch } from '../support/harness.js';

/**
 * The families a run writes its truth into.
 *
 * Two properties matter and neither is about the code being reached. A family
 * comes out in the canonical order whatever order it was written in, and it can
 * be walked more than once — the package is rendered from these, and the
 * reconciliation is computed from them, so a family that could only be read once
 * would force somebody to collect it and put the whole dataset back in memory.
 *
 * The ordering cases are the ones that would otherwise be found by a customer:
 * a row number compared as text puts row 10 before row 2, and a key made of
 * keys puts "ab" before "a".
 */

interface Row {
  readonly address: { readonly filePath: string; readonly sheetId: string; readonly rowNumberSource: number };
  readonly field: string;
}

function row(filePath: string, sheetId: string, rowNumberSource: number, field = 'f'): Row {
  return { address: { filePath, sheetId, rowNumberSource }, field };
}

function write(name: string, order: Parameters<typeof openFamily<Row>>[1], rows: readonly Row[]): SpooledFamily<Row> {
  const store = caseScratch(name);
  const writer = openFamily<Row>(store, order, { runSize: 3, fanIn: 2 });
  for (const item of rows) writer.add(item);
  return writer.seal();
}

const BY_ROW = { schema: 'testrows', key: (item: Row) => rowOrderKey(item.address) };

describe('a family comes out in the order the artifact declares', () => {
  it('orders row numbers as numbers, not as text', () => {
    // The defect this exists for: ordered as text, row 10 sorts before row 2,
    // and no sheet with fewer than ten rows in it can show that.
    const rows = [row('a.csv', 'S0', 9), row('a.csv', 'S0', 10), row('a.csv', 'S0', 2)];
    const family = write('order-numbers', BY_ROW, rows);
    assert.deepEqual(
      [...family].map((item) => item.address.rowNumberSource),
      [2, 9, 10],
    );
  });

  it('orders by file, then sheet, then row', () => {
    const rows = [
      row('b.csv', 'S0', 2),
      row('a.csv', 'S1', 2),
      row('a.csv', 'S0', 3),
      row('a.csv', 'S0', 2),
    ];
    const family = write('order-parts', BY_ROW, rows);
    assert.deepEqual(
      [...family].map((item) => `${item.address.filePath}|${item.address.sheetId}|${String(item.address.rowNumberSource)}`),
      ['a.csv|S0|2', 'a.csv|S0|3', 'a.csv|S1|2', 'b.csv|S0|2'],
    );
  });

  it('orders a row and then something else about it', () => {
    // A change is ordered by its row and then its field. Composing the parts is
    // the only way to say that: a key built from a finished key holds the
    // separator, which is exactly what the separator may not appear inside.
    const rows = [row('a.csv', 'S0', 2, 'z'), row('a.csv', 'S0', 2, 'a'), row('a.csv', 'S0', 1, 'z')];
    const family = write('order-composite', {
      schema: 'testcomposite',
      key: (item) => orderKey(...rowOrderParts(item.address), item.field),
    }, rows);
    assert.deepEqual(
      [...family].map((item) => `${String(item.address.rowNumberSource)}${item.field}`),
      ['1z', '2a', '2z'],
    );
  });

  it('refuses a key built from a key', () => {
    // Left to itself this produces an order that is wrong in a way nothing
    // downstream re-checks, so it raises instead.
    assert.throws(
      () => orderKey(rowOrderKey({ filePath: 'a.csv', sheetId: 'S0', rowNumberSource: 1 }), 'field'),
      (error: unknown) => error instanceof CoreInvariantError,
    );
  });

  it('refuses a row number wider than its field', () => {
    assert.throws(() => orderNumber(1, 0), (error: unknown) => error instanceof CoreInvariantError);
    assert.throws(() => orderNumber(-1), (error: unknown) => error instanceof CoreInvariantError);
    assert.throws(() => orderNumber(1.5), (error: unknown) => error instanceof CoreInvariantError);
  });

  it('produces the same order however much it had to spill', () => {
    const rows = Array.from({ length: 200 }, (_, index) => row('a.csv', 'S0', ((index * 37) % 199) + 1));
    const expected = [...rows]
      .map((item, index) => ({ item, index }))
      .sort((a, b) =>
        compareCodeUnits(rowOrderKey(a.item.address), rowOrderKey(b.item.address)) || a.index - b.index,
      )
      .map((entry) => entry.item.address.rowNumberSource);

    for (const runSize of [1, 7, 199, 200, 100_000]) {
      const store = caseScratch(`spill-${String(runSize)}`);
      const writer = openFamily<Row>(store, BY_ROW, { runSize, fanIn: 2 });
      for (const item of rows) writer.add(item);
      const family = writer.seal();
      assert.deepEqual(
        [...family].map((item) => item.address.rowNumberSource),
        expected,
        `run size ${String(runSize)} produced a different order`,
      );
    }
  });
});

describe('a family can be read as many times as the package needs', () => {
  it('yields the same records on every walk, and knows how many there are', () => {
    // The reconciliation walks a family, the soundness check walks it, and the
    // renderer walks it again. A family that emptied itself on first read would
    // force each of them to collect it first.
    const rows = Array.from({ length: 50 }, (_, index) => row('a.csv', 'S0', index + 1));
    const family = write('reread', BY_ROW, rows);

    assert.equal(family.count, 50);
    const first = [...family];
    const second = [...family];
    const third = [...family];
    assert.equal(first.length, 50);
    assert.deepEqual(first, second);
    assert.deepEqual(second, third);
  });

  it('holds nothing when nothing was written', () => {
    const family = write('empty', BY_ROW, []);
    assert.equal(family.count, 0);
    assert.deepEqual([...family], []);
    assert.deepEqual([...family], []);
  });

  it('will not be sealed twice', () => {
    const store = caseScratch('seal-once');
    const writer = openFamily<Row>(store, BY_ROW, DEFAULT_SPOOL_LIMITS);
    writer.add(row('a.csv', 'S0', 1));
    writer.seal();
    assert.throws(() => writer.seal(), (error: unknown) => error instanceof CoreInvariantError);
  });

  it('refuses a key it cannot separate from the record it orders', () => {
    // The separator lives between the key and the record, so a key holding one
    // would be read back truncated and the record would be read back with the
    // rest of the key on the front of it.
    //
    // Exercised on a family that keys on raw text. A row address no longer
    // reaches the sort unescaped — see the next case — so composing one out of
    // a hostile path stopped being a way to reach this guard, and a guard that
    // nothing can reach is a guard nobody notices losing.
    const store = caseScratch('tab-key');
    const writer = openFamily<Row>(store, { schema: 'testraw', key: (item: Row) => item.field }, DEFAULT_SPOOL_LIMITS);
    assert.throws(
      () => writer.add(row('a.csv', 'S0', 1, `holds\ttab`)),
      (error: unknown) => isMigrationError(error) && error.code === 'SCRATCH_FAILED',
    );
  });

  it('describes a rejected key without quoting it', () => {
    // A sort key is built from source values. The rejection carries where the
    // offending character is, how long the key was and a digest of it, and none
    // of the key itself: this exception is logged and read by whoever is on the
    // other end of a failed migration.
    const store = caseScratch('tab-key-details');
    const writer = openFamily<Row>(store, { schema: 'testraw', key: (item: Row) => item.field }, DEFAULT_SPOOL_LIMITS);
    try {
      writer.add(row('a.csv', 'S0', 1, `Ada\tLovelace`));
      assert.fail('a key holding a tab was accepted');
    } catch (error) {
      assert.ok(isMigrationError(error));
      const rendered = JSON.stringify({ message: error.message, details: error.details });
      assert.ok(!rendered.includes('Lovelace'), 'the rejection quoted the key');
      assert.equal((error.details as Record<string, unknown>)['atCodeUnit'], 3);
    }
  });

  it('refuses a file path holding the separator, by name, at the first family that sorts on it', () => {
    // A path with a tab or a line break in it is impossible on Windows and legal
    // on every POSIX system this builds on, so the question is what a run should
    // do with one.
    //
    // For one revision `rowOrderParts` escaped the path so that such a bundle
    // migrated. That was wrong, and the way it was wrong is worth keeping
    // written down: `orderText` is injective but not order-preserving, and every
    // consumer that *checks* this order — `lineage.ordering` and
    // `artifacts.declaredOrder` over six more artifacts — compares the path raw.
    // The bundle stopped aborting in the sort and started producing a package
    // that failed its own verification on seven checks. A loud refusal naming
    // the family is better than a package nobody can verify.
    const store = caseScratch('tab-path');
    const writer = openFamily<Row>(store, BY_ROW, DEFAULT_SPOOL_LIMITS);
    assert.throws(
      () => writer.add(row(`holds\ttab.csv`, 'S0', 1)),
      (error: unknown) => isMigrationError(error) && error.code === 'SCRATCH_FAILED',
    );
  });

  it('carries a value holding the separator, because the encoding escapes it', () => {
    // The refusal above is narrow on purpose. A tab inside a customer's cell is
    // ordinary data: it is escaped by the record encoding and never reaches the
    // line as a separator, so refusing it would be refusing a value for the
    // engine's convenience.
    const store = caseScratch('tab-value');
    const writer = openFamily<Row>(store, BY_ROW, DEFAULT_SPOOL_LIMITS);
    writer.add(row('a.csv', 'S0', 1, `holds\ttab`));
    writer.add(row('a.csv', 'S0', 2, 'plain'));
    const family = writer.seal();
    assert.deepEqual(
      [...family].map((item) => item.field),
      [`holds\ttab`, 'plain'],
    );
  });
});

describe('a family is projected without being collected', () => {
  it('maps lazily and keeps the count', () => {
    const rows = Array.from({ length: 10 }, (_, index) => row('a.csv', 'S0', index + 1));
    const family = write('project', BY_ROW, rows);

    let projected = 0;
    const cells = mapFamily(family, (item) => {
      projected += 1;
      return String(item.address.rowNumberSource);
    });

    assert.equal(cells.count, 10, 'a projection adds and drops nothing');
    assert.equal(projected, 0, 'and does no work until somebody walks it');
    assert.deepEqual([...cells], ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    assert.equal(projected, 10);
  });

  it('selects lazily, and how many is not known until it has been walked', () => {
    const rows = Array.from({ length: 10 }, (_, index) => row('a.csv', 'S0', index + 1));
    const family = write('select', BY_ROW, rows);
    const even = [...selectFrom(family, (item) => (item.address.rowNumberSource % 2 === 0 ? item : null))];
    assert.deepEqual(
      even.map((item) => item.address.rowNumberSource),
      [2, 4, 6, 8, 10],
    );
  });

  it('lets a bounded family be stated literally', () => {
    // Not everything grows with the row count. A family bounded by something
    // else keeps its array, and says so.
    const family = materialisedFamily([row('a.csv', 'S0', 1), row('a.csv', 'S0', 2)]);
    assert.equal(family.count, 2);
    assert.equal([...family].length, 2);
    assert.equal([...family].length, 2, 'and it can be walked again too');
  });
});
