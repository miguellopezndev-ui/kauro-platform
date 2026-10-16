import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  importPartPath,
  importPartsListed,
  numberedPartPath,
  planImportParts,
  renderedRowBytes,
} from '../../src/artifacts/import-partition.js';
import { escapeField } from '../../src/artifacts/csv-writer.js';
import { isMigrationError } from '../../src/domain/errors.js';

/**
 * Cutting an import file the destination will not accept whole.
 *
 * The arithmetic is the whole of the correctness here: a boundary computed one
 * byte differently gives a different set of files for the same records, and the
 * crosswalk that says where each record landed is computed from the same plan.
 * So the measurement is pinned against the writer's own escaping rather than
 * against a second opinion about what a CSV row costs.
 */
describe('import file partitioning', () => {
  describe('what a row will occupy', () => {
    it('measures the bytes the writer will write, quoting included', () => {
      // The writer joins escaped fields with a comma and ends the line with \n.
      const row = ['a', 'b,c', 'd"e'];
      const written = `${row.map(escapeField).join(',')}\n`;
      assert.equal(renderedRowBytes(row), Buffer.byteLength(written, 'utf8'));
    });

    it('counts bytes rather than characters', () => {
      // Three characters, six bytes in UTF-8, plus the line ending. A plan that
      // counted UTF-16 code units would cut a file of non-Latin text in the
      // wrong place and produce a part above the limit.
      assert.equal(renderedRowBytes(['日本語']), 3 * 3 + 1);
    });

    it('treats an absent cell as empty', () => {
      assert.equal(renderedRowBytes([null, null]), '\n,'.length);
    });
  });

  describe('where the cut falls', () => {
    const headers = ['a'];
    const headerBytes = renderedRowBytes(headers); // "a\n" = 2
    const row = (value: string): readonly string[] => [value];

    it('leaves a file that fits as one part', () => {
      const counts = planImportParts(headers, [row('x'), row('y')], 1000, () => 'r');
      assert.deepEqual(counts, [2]);
    });

    it('gives an empty table one part, so the object still gets its file', () => {
      assert.deepEqual(planImportParts(headers, [], 1000, () => 'r'), [1 - 1]);
    });

    it('cuts where the next row would take the part past the limit', () => {
      // Each row is "xx\n" = 3 bytes; the header is 2. A 8-byte limit holds the
      // header and two rows (8) and not a third (11).
      const rows = [row('xx'), row('xx'), row('xx'), row('xx'), row('xx')];
      assert.equal(headerBytes + 3 * 2, 8);
      assert.deepEqual(planImportParts(headers, rows, 8, () => 'r'), [2, 2, 1]);
    });

    it('fills a part exactly to the limit rather than stopping short', () => {
      const rows = [row('xx'), row('xx')];
      assert.deepEqual(planImportParts(headers, rows, 8, () => 'r'), [2]);
      // One byte less and the second row no longer fits.
      assert.deepEqual(planImportParts(headers, rows, 7, () => 'r'), [1, 1]);
    });

    it('refuses a single row that no cut could make deliverable', () => {
      assert.throws(
        () => planImportParts(headers, [row('x'.repeat(100))], 20, (index) => `record R${String(index)}`),
        (error: unknown) =>
          isMigrationError(error) &&
          error.code === 'INPUT_LIMIT_EXCEEDED' &&
          error.message.includes('one row with its header already exceeds') &&
          // Named, so the operator knows which record to shorten.
          error.message.includes('record R'),
      );
    });

    it('is the same plan for the same rows, every time', () => {
      const rows = Array.from({ length: 50 }, (_, index) => row(`value-${String(index)}`));
      const once = planImportParts(headers, rows, 40, () => 'r');
      const again = planImportParts(headers, rows, 40, () => 'r');
      assert.deepEqual(once, again);
      assert.equal(
        once.reduce((sum, count) => sum + count, 0),
        50,
        'every record is in exactly one part',
      );
    });
  });

  describe('what a part is called', () => {
    it('leaves a whole file under its own name', () => {
      assert.equal(importPartPath('01_IMPORT/clean-only/contacts.csv', 1, 1), '01_IMPORT/clean-only/contacts.csv');
    });

    it('numbers the parts so they sort in import order', () => {
      const paths = [1, 2, 10].map((part) => importPartPath('01_IMPORT/clean-only/contacts.csv', part, 10));
      assert.deepEqual(paths, [
        '01_IMPORT/clean-only/contacts-001.csv',
        '01_IMPORT/clean-only/contacts-002.csv',
        '01_IMPORT/clean-only/contacts-010.csv',
      ]);
      assert.deepEqual([...paths].sort(), paths, 'sorting paths gives the order they must be imported in');
    });
  });

  describe('what a reader is allowed to conclude from a listing', () => {
    const base = '01_IMPORT/clean-only/contacts.csv';

    it('accepts the base name alone', () => {
      const seen = importPartsListed(base, new Set([base]));
      assert.equal(seen.problem, null);
      assert.deepEqual(seen.paths, [base]);
    });

    it('accepts numbered parts from one', () => {
      const listed = new Set([numberedPartPath(base, 1), numberedPartPath(base, 2), numberedPartPath(base, 3)]);
      const seen = importPartsListed(base, listed);
      assert.equal(seen.problem, null);
      assert.deepEqual(seen.paths, [...listed]);
    });

    it('refuses a whole file sitting beside parts of itself', () => {
      const seen = importPartsListed(base, new Set([base, numberedPartPath(base, 1), numberedPartPath(base, 2)]));
      assert.match(seen.problem ?? '', /never both/u);
    });

    it('refuses a gap in the numbering', () => {
      // Part two removed. Each remaining file verifies on its own, and the
      // records that were in part two are simply gone -- which is exactly the
      // shape of loss this rule exists to catch.
      const seen = importPartsListed(
        base,
        new Set([numberedPartPath(base, 1), numberedPartPath(base, 3)]),
      );
      assert.match(seen.problem ?? '', /not continuous from 001/u);
    });

    it('refuses a single numbered part, which a whole file would never be written as', () => {
      const seen = importPartsListed(base, new Set([numberedPartPath(base, 1)]));
      assert.match(seen.problem ?? '', /written under its own name/u);
    });

    it('reports a missing file as missing', () => {
      const seen = importPartsListed(base, new Set<string>());
      assert.match(seen.problem ?? '', /is missing from the package/u);
    });
  });
});
