import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { renderIdentityKey } from '../../src/domain/identity.js';
import type { SourceIdentityKey } from '../../src/domain/identity.js';
import { orderKey, orderText } from '../../src/run/spool.js';
import { sortKeyFor } from '../../src/scratch/external-sort.js';
import { makeColumnLocatorId, makeFileId, makeRowLocatorId, makeSheetId } from '../../src/domain/locators.js';
import { importKeyFor } from '../../src/artifacts/import-key.js';

/**
 * Every composite key the engine builds is injective over its components, and
 * this proves it constructively: for each key there is a decoder written here,
 * independently of the encoder, and the property is that decoding what the
 * engine encoded gives back exactly the components it was given — for any
 * components, including ones that contain the separators and escapes the
 * encoder uses.
 *
 * An encoder with a decoder is injective by construction. An encoder that
 * merely "looks unambiguous" is the concatenation defect waiting to recur: it
 * did once, when a record id spelled to look like an external-id key rendered
 * the same string and combined two people.
 *
 * What is deliberately not here: the migration key and the import key are
 * truncated digests (80 and 96 bits), so they are not injective and are not
 * claimed to be. Their property is collision resistance, stated in
 * docs/CONTRACT.md section 8, and the one thing a test can add is that distinct
 * inputs give distinct outputs across a large random sample — recorded below
 * without pretending it is a proof.
 */

/** The characters the key formats own, so the generator produces them far more often than chance would. */
const OWNED = ['|', '\\', '%', '\u0001', '\u0000', '\t', '\n', ' ', 'a', 'é', '\u{1F600}', '1'];

const anyText = fc.string({ unit: 'binary', maxLength: 24 });
const separatorHeavy = fc.string({ unit: fc.constantFrom(...OWNED), maxLength: 12 });
const text = fc.oneof(anyText, separatorHeavy);

// ------------------------------------------------------------ identity keys

/** Splits on unescaped `|` and unescapes `\|` and `\\`, which is the inverse of `escapeKeySegment` + join. */
function decodeIdentityKey(rendered: string): string[] {
  const segments: string[] = [];
  let current = '';
  for (let index = 0; index < rendered.length; index += 1) {
    const character = rendered[index] as string;
    if (character === '\\') {
      const next = rendered[index + 1];
      if (next !== '\\' && next !== '|') throw new Error(`stray escape at ${String(index)}`);
      current += next;
      index += 1;
    } else if (character === '|') {
      segments.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  segments.push(current);
  return segments;
}

const identityKey: fc.Arbitrary<SourceIdentityKey> = fc.record({
  sourceSystem: text,
  sourceNamespace: text,
  identitySpace: text,
  objectType: fc.constantFrom('CONTACT' as const, 'COMPANY' as const, 'DEAL' as const, 'LEAD' as const),
  keyKind: fc.constantFrom('SOURCE_RECORD_ID' as const, 'EXTERNAL_ID' as const),
  keyColumn: text,
  keyColumnAddress: text,
  sourceRecordId: text,
});

describe('the identity key is injective over its eight segments', () => {
  it('decodes back to exactly the segments it was rendered from', () => {
    fc.assert(
      fc.property(identityKey, (key) => {
        const decoded = decodeIdentityKey(renderIdentityKey(key));
        assert.deepEqual(decoded, [
          key.sourceSystem,
          key.sourceNamespace,
          key.identitySpace,
          key.objectType,
          key.keyKind,
          key.keyColumn,
          key.keyColumnAddress,
          key.sourceRecordId,
        ]);
      }),
      { numRuns: 2_000 },
    );
  });

  it('two keys render the same string exactly when they are the same key', () => {
    fc.assert(
      fc.property(identityKey, identityKey, (a, b) => {
        const same = JSON.stringify(a) === JSON.stringify(b);
        assert.equal(renderIdentityKey(a) === renderIdentityKey(b), same);
      }),
      { numRuns: 2_000 },
    );
  });

  it('a record id that spells an external-id key does not render as one', () => {
    // The concatenation defect, stated as a fixed case beside the property.
    const forged: SourceIdentityKey = {
      sourceSystem: 's',
      sourceNamespace: 'n',
      identitySpace: 'i',
      objectType: 'CONTACT',
      keyKind: 'SOURCE_RECORD_ID',
      keyColumn: '',
      keyColumnAddress: '',
      sourceRecordId: 'x|EXTERNAL_ID|Legacy|occurrence:1|42',
    };
    const real: SourceIdentityKey = {
      ...forged,
      keyKind: 'EXTERNAL_ID',
      keyColumn: 'Legacy',
      keyColumnAddress: 'occurrence:1',
      sourceRecordId: '42',
    };
    assert.notEqual(renderIdentityKey(forged), renderIdentityKey(real));
  });
});

// -------------------------------------------------------------- order keys

/** What `src/run/spool.ts` composes parts with. Below every character a source cell can hold. */
const PART = '\u0001';

function decodeOrderText(encoded: string): string {
  let out = '';
  for (let index = 0; index < encoded.length; index += 1) {
    const character = encoded[index] as string;
    if (character === '%') {
      const hex = encoded.slice(index + 1, index + 3);
      if (!/^[0-9a-f]{2}$/u.test(hex)) throw new Error(`stray percent at ${String(index)}`);
      out += String.fromCodePoint(Number.parseInt(hex, 16));
      index += 2;
    } else {
      out += character;
    }
  }
  return out;
}

describe('the spool order key is injective over escaped parts', () => {
  it('orderText escapes every character the segment format owns, and decodes back', () => {
    fc.assert(
      fc.property(text, (value) => {
        const encoded = orderText(value);
        for (const owned of ['\u0000', '\u0001', '\t', '\n', '\r']) {
          assert.ok(!encoded.includes(owned), `orderText left ${JSON.stringify(owned)} unescaped`);
        }
        assert.equal(decodeOrderText(encoded), value);
      }),
      { numRuns: 2_000 },
    );
  });

  it('orderKey over escaped parts splits back into the parts', () => {
    fc.assert(
      fc.property(fc.array(text, { minLength: 1, maxLength: 5 }), (parts) => {
        const composed = orderKey(...parts.map(orderText));
        assert.deepEqual(composed.split(PART).map(decodeOrderText), parts);
      }),
      { numRuns: 2_000 },
    );
  });

  it('orderKey refuses a part holding the separator rather than composing an ambiguous key', () => {
    assert.throws(() => orderKey(`a${PART}b`), /part separator/u);
  });
});

// ------------------------------------------------------------ sort keys

describe('the external sort key is injective over key and position', () => {
  it('decodes at the terminator into the key and its position', () => {
    fc.assert(
      fc.property(
        text.map((value) => value.replace(/[\u0000\n\t]/gu, '')),
        fc.integer({ min: 0, max: 9_999_999_999 }),
        (key, sequence) => {
          const composed = sortKeyFor(key, sequence);
          const at = composed.lastIndexOf('\u0000');
          assert.equal(composed.slice(0, at), key);
          assert.equal(Number(composed.slice(at + 1)), sequence);
          assert.equal(composed.slice(at + 1).length, 16);
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it('refuses a key that holds any character the segment format owns', () => {
    // A line feed was not among these, and the store caught it four frames
    // deeper with a message naming a segment id and nothing else. The founding
    // CLEAN_ONLY profile failed exactly that way, on a cell with a line break
    // in it, which is an ordinary thing to find in a spreadsheet.
    assert.throws(() => sortKeyFor('a\u0000b', 1), /NUL/u);
    assert.throws(() => sortKeyFor('a\tb', 1), /tab/u);
    assert.throws(() => sortKeyFor('a\nb', 1), /line feed/u);
  });

  it('describes a rejected key without quoting it', () => {
    // A sort key is built from source values, so an exception carrying one puts
    // a customer's name or address into a log and very likely into a mail. The
    // details identify the key by position, length and digest instead.
    const secret = 'Ada\nLovelace';
    try {
      sortKeyFor(secret, 1);
      assert.fail('a key holding a line feed was accepted');
    } catch (error) {
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      const rendered = JSON.stringify({ message: String((error as Error).message), details });
      assert.ok(!rendered.includes('Ada'), 'the rejection quoted the key');
      assert.ok(!rendered.includes('Lovelace'), 'the rejection quoted the key');
      assert.equal(details['atCodeUnit'], 3);
      assert.equal(details['keyLength'], secret.length);
      assert.equal(typeof details['keyDigest'], 'string');
    }
  });
});

// ------------------------------------------------------------- locators

const hex = fc.string({ unit: fc.constantFrom(...'0123456789abcdef'.split('')), minLength: 64, maxLength: 64 });

describe('locator ids parse back into their components', () => {
  it('row and column locators', () => {
    fc.assert(
      fc.property(hex, fc.nat({ max: 10_000 }), fc.nat({ max: 5_000_000 }), fc.nat({ max: 100_000 }), (sha, sheetIndex, row, column) => {
        const fileId = makeFileId(sha);
        const sheetId = makeSheetId(sheetIndex);
        const rowId = makeRowLocatorId(fileId, sheetId, row);
        const columnId = makeColumnLocatorId(fileId, sheetId, column);
        const rowMatch = /^(F-[0-9a-f]{12}):(S[0-9]+):R([0-9]+)$/u.exec(rowId);
        const columnMatch = /^(F-[0-9a-f]{12}):(S[0-9]+):C([0-9]+)$/u.exec(columnId);
        assert.ok(rowMatch !== null && columnMatch !== null);
        assert.deepEqual([rowMatch[1], rowMatch[2], Number(rowMatch[3])], [fileId, sheetId, row]);
        assert.deepEqual([columnMatch[1], columnMatch[2], Number(columnMatch[3])], [fileId, sheetId, column]);
      }),
      { numRuns: 1_000 },
    );
  });
});

// ------------------------------------------------- digests, not claimed injective

describe('truncated digests are collision resistant, which is a different claim', () => {
  it('distinct (run, migration key) pairs give distinct import keys across a sample', () => {
    const seen = new Map<string, string>();
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 60 }), (runId, migrationKey) => {
        const composed = `${runId}\u0000${migrationKey}`;
        const key = importKeyFor(runId, migrationKey);
        const previous = seen.get(key);
        if (previous !== undefined && previous !== composed) assert.fail(`collision between ${previous} and ${composed}`);
        seen.set(key, composed);
      }),
      { numRuns: 5_000 },
    );
  });
});
