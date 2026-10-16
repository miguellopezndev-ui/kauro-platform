import { strict as assert } from 'node:assert';
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createFilesystemScratchStore, scratchDirectoryName } from '../../src/scratch/filesystem-scratch-store.js';
import { SCRATCH_STORE_CONTRACT_VERSION, SEGMENT_RECORD_SEPARATOR_BYTES } from '../../src/scratch/scratch-store.js';
import type { ScratchStore, ScratchUsage } from '../../src/scratch/scratch-store.js';
import { externalSort, readSorted, sortKeyFor } from '../../src/scratch/external-sort.js';
import { DEFAULT_SPOOL_LIMITS, openFamily } from '../../src/run/spool.js';
import { SCRATCH_BUDGET_BYTES } from '../../src/domain/resource-profile.js';
import { isMigrationError } from '../../src/domain/errors.js';
import { compareCodeUnits } from '../../src/util/json.js';
import { repoRoot, scratchDir } from '../support/harness.js';

/**
 * Scratch, and the sort that lives on it.
 *
 * These two are the floor the rest of the bounded architecture stands on, so the
 * cases here are about the properties everything else will assume rather than
 * about the code being exercised at all:
 *
 *   spilling changes nothing observable   the same input sorts to the same bytes
 *                                         whatever the run size or the fan-in
 *   a segment is what it was sealed as    a changed, truncated or lengthened
 *                                         segment is refused, not read
 *   nothing leaves the root               and nothing outlives disposal
 *   the quota stops the run               before it fills the workspace
 *
 * A test that only shows the sort produces sorted output would pass against an
 * implementation whose output depended on how much memory the machine had, which
 * is exactly the defect that matters here.
 */

const QUOTA = 64 * 1024 * 1024;

function store(name: string, options: { quotaBytes?: number } = {}): { store: ScratchStore; root: string; runId: string } {
  const root = scratchDir('scratch', name);
  const runId = `test${name.replace(/[^A-Za-z0-9]/gu, '')}`;
  return {
    store: createFilesystemScratchStore({ root, runId, quotaBytes: options.quotaBytes ?? QUOTA }),
    root,
    runId,
  };
}

function segmentPath(root: string, runId: string, segmentId: string): string {
  return join(root, scratchDirectoryName(runId), `${segmentId}.seg`);
}

interface Record {
  readonly key: string;
  readonly payload: string;
}

function records(count: number, keyOf: (index: number) => string): Record[] {
  return Array.from({ length: count }, (_, index) => ({
    key: keyOf(index),
    payload: `payload-${String(index)}`,
  }));
}

function sortOptions(target: ScratchStore, runSize: number, fanIn: number) {
  return {
    store: target,
    schema: 'testrecord',
    schemaVersion: '1.0.0',
    runSize,
    fanIn,
    key: (item: Record) => item.key,
    encode: (item: Record) => JSON.stringify(item),
    decode: (line: string) => JSON.parse(line) as Record,
  };
}

/** The answer the external sort has to reproduce: a stable in-memory sort. */
function oracle(input: readonly Record[]): Record[] {
  return input
    .map((item, index) => ({ item, index }))
    .sort((a, b) => compareCodeUnits(a.item.key, b.item.key) || a.index - b.index)
    .map((entry) => entry.item);
}

describe('the external sort produces one answer, whatever it takes to get there', () => {
  const input = records(500, (index) => `k${String((index * 37) % 101).padStart(3, '0')}`);
  const expected = oracle(input);

  it('agrees with a materialised sort of the same records', () => {
    const scratch = store('oracle');
    try {
      const result = externalSort(input, sortOptions(scratch.store, 64, 4));
      const actual = [...readSorted(scratch.store, result.segmentId, (line) => JSON.parse(line) as Record)];
      assert.deepEqual(actual, expected);
      assert.equal(result.rowCount, input.length);
    } finally {
      scratch.store.dispose();
    }
  });

  it('produces identical output at every run size and fan-in', () => {
    // One byte at a time, primes, and either side of the buffer the writer uses.
    // If any of these disagree, the sort's output depends on how much memory the
    // machine had, and a package produced on one machine cannot be reproduced on
    // another.
    const shapes = [
      { runSize: 1, fanIn: 2 },
      { runSize: 2, fanIn: 2 },
      { runSize: 3, fanIn: 3 },
      { runSize: 7, fanIn: 2 },
      { runSize: 13, fanIn: 5 },
      { runSize: 64, fanIn: 2 },
      { runSize: 65, fanIn: 16 },
      { runSize: 499, fanIn: 2 },
      { runSize: 500, fanIn: 8 },
      { runSize: 100_000, fanIn: 2 },
    ];

    for (const shape of shapes) {
      const scratch = store(`shape-${String(shape.runSize)}-${String(shape.fanIn)}`);
      try {
        const result = externalSort(input, sortOptions(scratch.store, shape.runSize, shape.fanIn));
        const actual = [...readSorted(scratch.store, result.segmentId, (line) => JSON.parse(line) as Record)];
        assert.deepEqual(
          actual,
          expected,
          `run size ${String(shape.runSize)} with fan-in ${String(shape.fanIn)} produced a different order`,
        );
      } finally {
        scratch.store.dispose();
      }
    }
  });

  it('really does spill and really does merge more than once', () => {
    // Otherwise the invariance above would be measuring one code path against
    // itself.
    const scratch = store('multipass');
    try {
      const result = externalSort(input, sortOptions(scratch.store, 10, 2));
      assert.equal(result.initialRuns, 50, 'the input must have been spilled in runs');
      assert.ok(result.mergePasses >= 5, `expected several merge passes, got ${String(result.mergePasses)}`);
    } finally {
      scratch.store.dispose();
    }
  });

  it('keeps equal keys in the order they arrived', () => {
    // Every record has the same key, so the only thing that can order them is
    // the tie-break — and the tie-break has to survive being spilled.
    const flat = records(200, () => 'same');
    for (const runSize of [1, 3, 200]) {
      const scratch = store(`stable-${String(runSize)}`);
      try {
        const result = externalSort(flat, sortOptions(scratch.store, runSize, 2));
        const actual = [...readSorted(scratch.store, result.segmentId, (line) => JSON.parse(line) as Record)];
        assert.deepEqual(actual, flat, `run size ${String(runSize)} reordered equal keys`);
      } finally {
        scratch.store.dispose();
      }
    }
  });

  it('orders a key that is a prefix of another before it', () => {
    // The tie-break separator has to sort below every code unit, or "ab" lands
    // before "a" and the merge quietly disagrees with the oracle.
    const tricky = ['a', 'ab', 'a b', 'aa', 'b', 'A', 'á', 'a\r', 'a\t'.replace('\t', 'X'), ''].map((key, index) => ({
      key,
      payload: `p${String(index)}`,
    }));
    for (const runSize of [1, 2, 100]) {
      const scratch = store(`prefix-${String(runSize)}`);
      try {
        const result = externalSort(tricky, sortOptions(scratch.store, runSize, 2));
        const actual = [...readSorted(scratch.store, result.segmentId, (line) => JSON.parse(line) as Record)];
        assert.deepEqual(actual, oracle(tricky), `run size ${String(runSize)} disagreed with the oracle`);
      } finally {
        scratch.store.dispose();
      }
    }
  });

  it('refuses a key it cannot separate from its tie-break', () => {
    assert.throws(
      () => sortKeyFor(`a${String.fromCharCode(0)}b`, 0),
      (error: unknown) => isMigrationError(error) && error.code === 'SCRATCH_FAILED',
    );
  });

  it('sorts nothing into nothing rather than into an empty segment', () => {
    const scratch = store('empty');
    try {
      const result = externalSort([], sortOptions(scratch.store, 8, 2));
      assert.equal(result.segmentId, null);
      assert.equal(result.rowCount, 0);
      assert.deepEqual([...readSorted(scratch.store, result.segmentId, (line) => line)], []);
    } finally {
      scratch.store.dispose();
    }
  });

  it('leaves no more scratch behind than the one segment it produced', () => {
    const scratch = store('cleanup-runs');
    try {
      externalSort(input, sortOptions(scratch.store, 10, 2));
      assert.equal(scratch.store.list().length, 1, 'every spent run must be deleted as the merge consumes it');
    } finally {
      scratch.store.dispose();
    }
  });
});

describe('a sealed segment is exactly what it was sealed as', () => {
  it('refuses one whose bytes changed', () => {
    const scratch = store('tamper-bytes');
    try {
      const writer = scratch.store.createSegment({ schema: 'facts', schemaVersion: '1.0.0' });
      writer.append('alpha');
      writer.append('bravo');
      const manifest = writer.seal();

      const path = segmentPath(scratch.root, scratch.runId, manifest.segmentId);
      writeFileSync(path, 'alpha\nbravX\n');

      assert.throws(
        () => [...scratch.store.readLines(manifest.segmentId)],
        (error: unknown) =>
          isMigrationError(error) &&
          error.code === 'SCRATCH_FAILED' &&
          error.message.includes('does not match the manifest'),
      );
    } finally {
      scratch.store.dispose();
    }
  });

  it('refuses one that was truncated', () => {
    const scratch = store('tamper-truncate');
    try {
      const writer = scratch.store.createSegment({ schema: 'facts', schemaVersion: '1.0.0' });
      writer.append('alpha');
      writer.append('bravo');
      const manifest = writer.seal();

      truncateSync(segmentPath(scratch.root, scratch.runId, manifest.segmentId), 8);
      assert.throws(
        () => [...scratch.store.readLines(manifest.segmentId)],
        (error: unknown) => isMigrationError(error) && error.code === 'SCRATCH_FAILED',
      );
    } finally {
      scratch.store.dispose();
    }
  });

  it('refuses one that grew a record', () => {
    const scratch = store('tamper-append');
    try {
      const writer = scratch.store.createSegment({ schema: 'facts', schemaVersion: '1.0.0' });
      writer.append('alpha');
      const manifest = writer.seal();

      appendFileSync(segmentPath(scratch.root, scratch.runId, manifest.segmentId), 'bravo\n');
      assert.throws(
        () => [...scratch.store.readLines(manifest.segmentId)],
        (error: unknown) => isMigrationError(error) && error.code === 'SCRATCH_FAILED',
      );
    } finally {
      scratch.store.dispose();
    }
  });

  it('refuses one whose last record has no terminator', () => {
    const scratch = store('tamper-tail');
    try {
      const writer = scratch.store.createSegment({ schema: 'facts', schemaVersion: '1.0.0' });
      writer.append('alpha');
      const manifest = writer.seal();

      writeFileSync(segmentPath(scratch.root, scratch.runId, manifest.segmentId), 'alpha');
      assert.throws(
        () => [...scratch.store.readLines(manifest.segmentId)],
        (error: unknown) => isMigrationError(error) && error.code === 'SCRATCH_FAILED',
      );
    } finally {
      scratch.store.dispose();
    }
  });

  it('reports what it holds without being asked to trust the caller', () => {
    const scratch = store('manifest');
    try {
      const writer = scratch.store.createSegment({ schema: 'facts', schemaVersion: '2.1.0', sorted: true });
      writer.append('first', 'k01');
      writer.append('second', 'k02');
      writer.append('third', 'k03');
      const manifest = writer.seal();

      assert.equal(manifest.rowCount, 3);
      assert.equal(manifest.byteLength, Buffer.byteLength('first\nsecond\nthird\n', 'utf8'));
      assert.equal(manifest.firstKey, 'k01');
      assert.equal(manifest.lastKey, 'k03');
      assert.equal(manifest.sorted, true);
      assert.equal(manifest.schemaVersion, '2.1.0');
      assert.deepEqual([...scratch.store.readLines(manifest.segmentId)], ['first', 'second', 'third']);
    } finally {
      scratch.store.dispose();
    }
  });

  it('will not let a segment declared sorted be written out of order', () => {
    const scratch = store('order');
    try {
      const writer = scratch.store.createSegment({ schema: 'facts', schemaVersion: '1.0.0', sorted: true });
      writer.append('b', 'k02');
      assert.throws(
        () => {
          writer.append('a', 'k01');
        },
        (error: unknown) => isMigrationError(error) && error.code === 'SCRATCH_FAILED',
      );
      writer.abort();
    } finally {
      scratch.store.dispose();
    }
  });

  it('does not show a segment that was never sealed', () => {
    const scratch = store('unsealed');
    try {
      const writer = scratch.store.createSegment({ schema: 'facts', schemaVersion: '1.0.0' });
      writer.append('alpha');
      assert.deepEqual(scratch.store.list(), [], 'an open segment is not a segment yet');
      assert.throws(
        () => scratch.store.manifest(writer.segmentId),
        (error: unknown) => isMigrationError(error) && error.code === 'SCRATCH_FAILED',
      );
      writer.abort();
      assert.equal(existsSync(segmentPath(scratch.root, scratch.runId, writer.segmentId)), false);
    } finally {
      scratch.store.dispose();
    }
  });

  it('will not accept a record that would introduce a separator', () => {
    const scratch = store('separator');
    try {
      const writer = scratch.store.createSegment({ schema: 'facts', schemaVersion: '1.0.0' });
      assert.throws(
        () => {
          writer.append('two\nlines');
        },
        (error: unknown) => isMigrationError(error) && error.code === 'SCRATCH_FAILED',
      );
      writer.abort();
    } finally {
      scratch.store.dispose();
    }
  });
});

describe('scratch is bounded and contained', () => {
  it('stops the run before it fills the workspace', () => {
    const scratch = store('quota', { quotaBytes: 512 });
    try {
      const writer = scratch.store.createSegment({ schema: 'facts', schemaVersion: '1.0.0' });
      assert.throws(
        () => {
          for (let index = 0; index < 1000; index += 1) writer.append('x'.repeat(64));
        },
        (error: unknown) => isMigrationError(error) && error.code === 'SCRATCH_QUOTA_EXCEEDED',
      );
      writer.abort();
    } finally {
      scratch.store.dispose();
    }
  });

  it('reports the high-water mark, not the current size', () => {
    const scratch = store('peak');
    try {
      const writer = scratch.store.createSegment({ schema: 'facts', schemaVersion: '1.0.0' });
      for (let index = 0; index < 100; index += 1) writer.append('x'.repeat(100));
      const manifest = writer.seal();
      const atPeak = scratch.store.usage();
      assert.equal(atPeak.bytes, manifest.byteLength);
      assert.equal(atPeak.peakBytes, manifest.byteLength);

      scratch.store.delete(manifest.segmentId);
      const after = scratch.store.usage();
      assert.equal(after.bytes, 0, 'deleting a segment gives its bytes back');
      assert.equal(after.peakBytes, manifest.byteLength, 'but the peak is what the evidence reports');
      assert.equal(after.quotaBytes, QUOTA);
    } finally {
      scratch.store.dispose();
    }
  });

  it('refuses a run id that could name somewhere else', () => {
    const root = scratchDir('scratch', 'hostile');
    for (const runId of ['..', '../escape', 'a/b', 'a\\b', '', 'x'.repeat(65), '.']) {
      assert.throws(
        () => createFilesystemScratchStore({ root, runId, quotaBytes: QUOTA }),
        (error: unknown) => isMigrationError(error) && error.code === 'SCRATCH_FAILED',
        `run id ${JSON.stringify(runId)} must be refused`,
      );
    }
  });

  it('refuses a schema that could name somewhere else', () => {
    const scratch = store('hostile-schema');
    try {
      for (const schema of ['../escape', 'a/b', '', 'x'.repeat(65)]) {
        assert.throws(
          () => scratch.store.createSegment({ schema, schemaVersion: '1.0.0' }),
          (error: unknown) => isMigrationError(error) && error.code === 'SCRATCH_FAILED',
          `schema ${JSON.stringify(schema)} must be refused`,
        );
      }
    } finally {
      scratch.store.dispose();
    }
  });

  it('refuses a quota that is not a byte count', () => {
    const root = scratchDir('scratch', 'quota-shape');
    for (const quotaBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => createFilesystemScratchStore({ root, runId: 'ok', quotaBytes }),
        (error: unknown) => isMigrationError(error) && error.code === 'SCRATCH_FAILED',
        `quota ${String(quotaBytes)} must be refused`,
      );
    }
  });

  it('leaves nothing behind, and cannot be used afterwards', () => {
    const scratch = store('dispose');
    const writer = scratch.store.createSegment({ schema: 'facts', schemaVersion: '1.0.0' });
    writer.append('alpha');
    const manifest = writer.seal();
    const path = segmentPath(scratch.root, scratch.runId, manifest.segmentId);
    assert.equal(existsSync(path), true);

    scratch.store.dispose();

    assert.equal(existsSync(join(scratch.root, scratchDirectoryName(scratch.runId))), false);
    assert.throws(
      () => scratch.store.list(),
      (error: unknown) => isMigrationError(error) && error.code === 'SCRATCH_FAILED',
    );
    // Disposal is idempotent, because it is called on success and on failure.
    scratch.store.dispose();
  });

  it('states the contract version it implements', () => {
    const scratch = store('version');
    try {
      assert.equal(scratch.store.contractVersion, SCRATCH_STORE_CONTRACT_VERSION);
      assert.equal(SCRATCH_STORE_CONTRACT_VERSION, '1.0.0');
    } finally {
      scratch.store.dispose();
    }
  });

  it('names its segments from the work, not from the clock', () => {
    // Two stores given the same run id and the same work produce the same names
    // and the same bytes. A name drawn from a clock or a random source would
    // make a rerun unable to reproduce anything.
    const first = store('deterministic-a');
    const second = store('deterministic-b');
    try {
      const build = (target: ScratchStore): { ids: string[]; bytes: string[] } => {
        const ids: string[] = [];
        const bytes: string[] = [];
        for (const schema of ['alpha', 'bravo']) {
          const writer = target.createSegment({ schema, schemaVersion: '1.0.0' });
          writer.append(`${schema}-one`);
          writer.append(`${schema}-two`);
          ids.push(writer.seal().segmentId);
        }
        for (const id of ids) bytes.push([...target.readLines(id)].join('|'));
        return { ids, bytes };
      };
      const a = build(first.store);
      const b = build(second.store);
      assert.deepEqual(a.ids, b.ids);
      assert.deepEqual(a.bytes, b.bytes);
      assert.deepEqual(
        a.ids,
        ['alpha-000001', 'bravo-000002'],
        'segment names are derived from the schema and the order they were created in',
      );
    } finally {
      first.store.dispose();
      second.store.dispose();
    }
  });
});

describe('a spill survives being read back through the store it came from', () => {
  it('reproduces the exact bytes for a record holding awkward text', () => {
    const scratch = store('roundtrip');
    try {
      const awkward = [
        'plain',
        'with, comma',
        'with "quotes"',
        'carriage\rreturn',
        'unicode: ñ á 日本語 𝄞',
        'x'.repeat(200_000),
      ];
      const writer = scratch.store.createSegment({ schema: 'facts', schemaVersion: '1.0.0' });
      for (const line of awkward) writer.append(line);
      const manifest = writer.seal();

      assert.deepEqual([...scratch.store.readLines(manifest.segmentId)], awkward);
      assert.equal(
        readFileSync(segmentPath(scratch.root, scratch.runId, manifest.segmentId), 'utf8'),
        `${awkward.join('\n')}\n`,
      );
    } finally {
      scratch.store.dispose();
    }
  });
});


describe('a sort key cannot be confused with the line it is written on', () => {
  it('refuses a key holding the separator between the key and its record', () => {
    // Found by reading the merge rather than by a failing test. The merge splits
    // each spilled line at the first tab to recover the key it sorts by, so a
    // key holding one is split in the wrong place: the key comes back truncated
    // and the record comes back with the rest of the key glued to its front.
    // Removing this guard and running three records through a one-record run
    // size does not raise anything in the sort — it returns a mangled record,
    // and with a key whose tail happens to parse it would return a well-formed
    // record in the wrong order instead, which is worse.
    //
    // Source values reach keys, and a quoted CSV field may hold a tab, so this
    // was reachable from input and not only from a mistake in the engine.
    assert.throws(
      () => sortKeyFor('before\tafter', 0),
      (error: unknown) =>
        isMigrationError(error) && error.code === 'SCRATCH_FAILED' && error.message.includes('may not contain a tab'),
    );
  });

  it('refuses such a key through the sort, before anything is spilled', () => {
    const scratch = store('tab-key');
    try {
      assert.throws(
        () =>
          externalSort(
            [
              { key: 'plain', payload: 'a' },
              { key: 'holds\ttab', payload: 'b' },
            ],
            sortOptions(scratch.store, 8, 2),
          ),
        (error: unknown) => isMigrationError(error) && error.code === 'SCRATCH_FAILED',
      );
    } finally {
      scratch.store.dispose();
    }
  });

  it('still sorts every key that only looks awkward', () => {
    // The refusal has to be narrow. A key with a carriage return, an unusual
    // script, or a great deal of length is ordinary data and must still sort.
    const awkward = ['a\rb', 'a b', 'ab', 'á', '日本語', 'a'.repeat(500), ''].map((key, index) => ({
      key,
      payload: `p${String(index)}`,
    }));
    for (const runSize of [1, 3, 100]) {
      const scratch = store(`awkward-${String(runSize)}`);
      try {
        const result = externalSort(awkward, sortOptions(scratch.store, runSize, 2));
        const actual = [...readSorted(scratch.store, result.segmentId, (line) => JSON.parse(line) as Record)];
        assert.deepEqual(actual, oracle(awkward), `run size ${String(runSize)} disagreed with the oracle`);
      } finally {
        scratch.store.dispose();
      }
    }
  });
});

/**
 * Fixed-width rows, so that a byte total in the cases below is arithmetic a
 * reader can check rather than a number that was measured once and copied in.
 */
const ROW_CHARS = 40;
const ROW_BYTES = ROW_CHARS + 1;

/** Seals one segment of `rows` fixed-width lines and says what it cost. */
function spill(target: ScratchStore, schema: string, rows: number): { segmentId: string; byteLength: number } {
  const writer = target.createSegment({ schema, schemaVersion: '1.0.0' });
  for (let row = 0; row < rows; row += 1) writer.append(`${schema}-${String(row)}`.padEnd(ROW_CHARS, '.'));
  const manifest = writer.seal();
  assert.equal(manifest.byteLength, rows * ROW_BYTES, `${schema} did not write the fixed-width rows the case assumes`);
  return { segmentId: manifest.segmentId, byteLength: manifest.byteLength };
}

describe('scratch says how much it spilled and where it went', () => {
  it('counts every byte it ever wrote, not only the bytes it still holds', () => {
    // The sort deletes each spent run as the merge consumes it, so what is live
    // at any moment is a fraction of what the device was asked to take. A run
    // that reports only its high-water mark describes a spill it never had, and
    // that is how a source-to-scratch amplification of 414x came to be recorded
    // as roughly fifty.
    const scratch = store('written-total');
    try {
      let written = 0;
      for (let run = 0; run < 4; run += 1) {
        const segment = spill(scratch.store, 'facts', 50);
        written += segment.byteLength;
        scratch.store.delete(segment.segmentId);
      }

      const usage = scratch.store.usage();
      assert.equal(usage.bytesWritten, written, 'bytesWritten is the sum of the manifests that were sealed');
      assert.equal(usage.bytes, 0, 'and every one of those segments was released');
      assert.equal(usage.peakBytes, 50 * ROW_BYTES, 'only one run was ever alive at a time');
      assert.ok(
        usage.bytesWritten > usage.peakBytes,
        `a released spill must show more written (${String(usage.bytesWritten)}) than ever held (${String(usage.peakBytes)})`,
      );
    } finally {
      scratch.store.dispose();
    }
  });

  it('attributes the bytes to the family that wrote them', () => {
    // Three families of different sizes written in one run. A total cannot say
    // which of them the amplification lives in; this is the number that can.
    const scratch = store('by-family');
    try {
      spill(scratch.store, 'facts', 12);
      spill(scratch.store, 'edges', 30);
      spill(scratch.store, 'notes', 7);

      const usage = scratch.store.usage();
      // Written straight to the store rather than through the external sort, so
      // every byte is unattributed: nothing declared which pass of which
      // algorithm produced it. That is the honest report and it is what the
      // scratch model refuses — see the cases at the end of this file.
      assert.deepEqual(usage.byFamily, [
        {
          family: 'edges',
          bytesWritten: 30 * ROW_BYTES,
          peakBytes: 30 * ROW_BYTES,
          liveBytes: 30 * ROW_BYTES,
          segments: 1,
          released: 0,
          declaration: { purpose: null, producer: null, consumer: null },
          segmentsSealed: 1,
          linesWritten: 30,
          framingBytes: 30,
          bytesWrittenByPass: [],
          bytesWrittenUnattributed: 30 * ROW_BYTES,
          openedAt: 2,
          closedAt: null,
          sorts: [],
        },
        {
          family: 'facts',
          bytesWritten: 12 * ROW_BYTES,
          peakBytes: 12 * ROW_BYTES,
          liveBytes: 12 * ROW_BYTES,
          segments: 1,
          released: 0,
          declaration: { purpose: null, producer: null, consumer: null },
          segmentsSealed: 1,
          linesWritten: 12,
          framingBytes: 12,
          bytesWrittenByPass: [],
          bytesWrittenUnattributed: 12 * ROW_BYTES,
          openedAt: 1,
          closedAt: null,
          sorts: [],
        },
        {
          family: 'notes',
          bytesWritten: 7 * ROW_BYTES,
          peakBytes: 7 * ROW_BYTES,
          liveBytes: 7 * ROW_BYTES,
          segments: 1,
          released: 0,
          declaration: { purpose: null, producer: null, consumer: null },
          segmentsSealed: 1,
          linesWritten: 7,
          framingBytes: 7,
          bytesWrittenByPass: [],
          bytesWrittenUnattributed: 7 * ROW_BYTES,
          openedAt: 3,
          closedAt: null,
          sorts: [],
        },
      ]);
      // Against the exported constant rather than against the literal 1. The
      // store derives its own framing width from the separator it owns; a test
      // that wrote the number down would agree with the store right up until
      // somebody changed the separator, which is the moment it has to disagree.
      assert.equal(
        usage.framingBytesPerLine,
        SEGMENT_RECORD_SEPARATOR_BYTES,
        'the store owns one record separator per line and charges exactly its width',
      );
      assert.equal(
        usage.byFamily.reduce((total, entry) => total + entry.bytesWritten, 0),
        usage.bytesWritten,
        'the families account for the whole spill, and for nothing that was not spilled',
      );
      assert.equal(usage.bytes, usage.byFamily.reduce((total, entry) => total + entry.liveBytes, 0));
    } finally {
      scratch.store.dispose();
    }
  });

  it('moves a released segment out of live bytes without unwriting it', () => {
    const scratch = store('release-accounting');
    try {
      const kept = spill(scratch.store, 'facts', 20);
      const spent = spill(scratch.store, 'facts', 5);
      const before = scratch.store.usage();
      assert.equal(before.bytes, kept.byteLength + spent.byteLength);

      scratch.store.delete(spent.segmentId);
      const after = scratch.store.usage();

      assert.equal(after.bytesWritten, before.bytesWritten, 'releasing a segment does not unwrite the bytes it took');
      assert.equal(after.bytes, kept.byteLength, 'but they stop being held');
      assert.deepEqual(after.byFamily, [
        {
          family: 'facts',
          bytesWritten: kept.byteLength + spent.byteLength,
          peakBytes: kept.byteLength + spent.byteLength,
          liveBytes: kept.byteLength,
          segments: 1,
          released: 1,
          declaration: { purpose: null, producer: null, consumer: null },
          segmentsSealed: 2,
          linesWritten: 25,
          framingBytes: 25,
          bytesWrittenByPass: [],
          bytesWrittenUnattributed: kept.byteLength + spent.byteLength,
          openedAt: 1,
          // Still holding the segment that was kept, so the family has not
          // reached the end of its life and says so rather than guessing.
          closedAt: null,
          sorts: [],
        },
      ]);
    } finally {
      scratch.store.dispose();
    }
  });

  it('reports the families in one order however they were first written', () => {
    // Code-unit order, the same ordering the rest of the engine uses, and not
    // the locale's: 'Alpha' before '_edge' before 'delta' is what comparing code
    // units gives, and it is what two machines have to agree on for a run
    // measured on one to be comparable with the same run measured on the other.
    const names = ['zulu', 'Alpha', 'delta', '_edge'];
    const expected = ['Alpha', '_edge', 'delta', 'zulu'];
    const forwards = store('order-forwards');
    const backwards = store('order-backwards');
    try {
      for (const schema of names) spill(forwards.store, schema, 3);
      for (const schema of [...names].reverse()) spill(backwards.store, schema, 3);

      assert.deepEqual(
        forwards.store.usage().byFamily.map((entry) => entry.family),
        expected,
      );
      assert.deepEqual(
        backwards.store.usage().byFamily.map((entry) => entry.family),
        expected,
        'the order a family was first written in must not reach the report',
      );
    } finally {
      forwards.store.dispose();
      backwards.store.dispose();
    }
  });

  it('holds nothing and has written nothing that still exists, once it is disposed', () => {
    const scratch = store('usage-dispose');
    try {
      spill(scratch.store, 'facts', 10);
      spill(scratch.store, 'edges', 4);
      const before = scratch.store.usage();
      assert.equal(before.bytesWritten, 14 * ROW_BYTES);
      assert.equal(before.byFamily.length, 2);

      scratch.store.dispose();

      const after = scratch.store.usage();
      assert.equal(after.bytes, 0);
      assert.equal(after.bytesWritten, 0);
      assert.equal(after.segmentCount, 0);
      assert.deepEqual(after.byFamily, [], 'a disposed store has no families, because it has no bytes');
      // The high-water mark is the one figure disposal leaves alone, and always
      // has: it is what a finished run reports about what it needed, and a run
      // reports it after it has cleaned up after itself.
      assert.equal(after.peakBytes, before.peakBytes);
    } finally {
      scratch.store.dispose();
    }
  });
});

// --------------------------------------------------------------------------
// The model of the sort, and the ratio it replaces
// --------------------------------------------------------------------------

/**
 * The model lives in `tools/`, so it is loaded the way the gate loads it.
 *
 * A `.mjs` under `tools/` is not compiled into `dist/test`, so it is imported by
 * URL from the repository root rather than by a relative path that would be
 * correct in the source tree and wrong in the built one.
 */
interface ScratchFact {
  readonly name: string;
  readonly value: boolean;
  readonly detail: string;
}

interface ModelledFamily {
  readonly family: string;
  readonly verdict: string;
  readonly expectedBytes: number;
  readonly actualBytes: number;
  readonly arithmetic: readonly string[];
  readonly problems: readonly string[];
}

interface ScratchRunCheck {
  readonly facts: readonly ScratchFact[];
  readonly families: readonly ModelledFamily[];
  readonly problems: readonly string[];
  readonly expectedBytes: number;
  readonly actualBytes: number;
}

interface SpoolLimitsShape {
  readonly runSize: number;
  readonly fanIn: number;
}

interface ScratchModelModule {
  checkScratchRun(input: {
    usage: unknown;
    quotaBytes: number;
    spoolLimits: readonly SpoolLimitsShape[];
    devicePeakBytes: number;
  }): ScratchRunCheck;
  modelFamilyTraffic(
    family: unknown,
    options: { framingBytesPerLine: number; spoolLimits: readonly SpoolLimitsShape[] },
  ): ModelledFamily;
  mergePassesFor(initialRuns: number, fanIn: number): number;
}

const scratchModel = (await import(
  pathToFileURL(join(repoRoot(), 'tools', 'scratch-model.mjs')).href
)) as ScratchModelModule;

/** The mutable mirror of a usage record, so a case can inject a defect into a copy. */
interface MutableFamily {
  family: string;
  bytesWritten: number;
  peakBytes: number;
  liveBytes: number;
  segments: number;
  released: number;
  segmentsSealed: number;
  linesWritten: number;
  framingBytes: number;
  bytesWrittenByPass: number[];
  bytesWrittenUnattributed: number;
  openedAt: number | null;
  closedAt: number | null;
  declaration: { purpose: string | null; producer: string | null; consumer: string | null };
  sorts: unknown[];
}

interface MutableUsage {
  bytes: number;
  peakBytes: number;
  quotaBytes: number;
  segmentCount: number;
  bytesWritten: number;
  framingBytesPerLine: number;
  byFamily: MutableFamily[];
}

/**
 * What the device was holding, walked from outside the store.
 *
 * The store enforces its own quota against its own ledger, so the ledger cannot
 * be the evidence that the quota held — that fact would be made true by the run
 * having finished. A walk of the directory is a second measurement the store
 * neither maintains nor enforces anything about, and it is what the model's peak
 * fact is stated against. tools/capacity.mjs takes the same walk at every stage
 * boundary; here it is taken once, at the end, which is a real reading of the
 * device even though it is not the high-water mark of one.
 */
function walkScratchBytes(root: string, runId: string): number {
  const walk = (directory: string): number => {
    let total = 0;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      total += entry.isDirectory() ? walk(path) : statSync(path).size;
    }
    return total;
  };
  const directory = join(root, scratchDirectoryName(runId));
  return existsSync(directory) ? walk(directory) : 0;
}

/** A usage record and the independent reading of the device that goes with it. */
interface MeasuredRun {
  readonly usage: ScratchUsage;
  readonly devicePeakBytes: number;
}

/**
 * One real sort, measured, at a stated shape.
 *
 * The quota is the canonical scratch budget rather than this file's smaller test
 * quota, because one of the three facts is that the run was measured against the
 * budget and not against some other number the host happened to pass in.
 *
 * The shapes here are deliberately not the engine's declared spool limits — a
 * merge tree four deep at fifty thousand records to a run would take a very long
 * time to write and prove nothing extra — so each case declares the limits it
 * ran at, exactly as the release-candidate gate declares the engine's. What the
 * model refuses is a sort at limits nobody declared, and that has a case of its
 * own below.
 */
function sortedUsage(
  name: string,
  shape: { rows: number; runSize: number; fanIn: number; schema?: string },
): MeasuredRun {
  const scratch = store(name, { quotaBytes: SCRATCH_BUDGET_BYTES });
  try {
    const input = records(shape.rows, (index) => `k${String((index * 37) % 1009).padStart(4, '0')}`);
    externalSort(input, {
      ...sortOptions(scratch.store, shape.runSize, shape.fanIn),
      schema: shape.schema ?? 'testrecord',
    });
    return {
      usage: scratch.store.usage(),
      devicePeakBytes: walkScratchBytes(scratch.root, scratch.runId),
    };
  } finally {
    scratch.store.dispose();
  }
}

function copyOf(run: MeasuredRun): { usage: MutableUsage; devicePeakBytes: number } {
  return { usage: structuredClone(run.usage) as unknown as MutableUsage, devicePeakBytes: run.devicePeakBytes };
}

function firstFamily(usage: MutableUsage): MutableFamily {
  const family = usage.byFamily[0];
  if (family === undefined) throw new Error('the shape under test wrote no families');
  return family;
}

function factOf(result: ScratchRunCheck, name: string): ScratchFact {
  const found = result.facts.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`the model did not state ${name}`);
  return found;
}

function limitsOf(usage: MutableUsage | ScratchUsage): SpoolLimitsShape[] {
  const declared: SpoolLimitsShape[] = [];
  for (const family of usage.byFamily) {
    for (const sort of family.sorts as readonly { runSize: number; fanIn: number }[]) {
      if (!declared.some((entry) => entry.runSize === sort.runSize && entry.fanIn === sort.fanIn)) {
        declared.push({ runSize: sort.runSize, fanIn: sort.fanIn });
      }
    }
  }
  return declared.length === 0 ? [DEFAULT_SPOOL_LIMITS] : declared;
}

function modelled(
  run: MeasuredRun | { usage: MutableUsage; devicePeakBytes: number },
  spoolLimits?: readonly SpoolLimitsShape[],
): ScratchRunCheck {
  return scratchModel.checkScratchRun({
    usage: run.usage,
    quotaBytes: SCRATCH_BUDGET_BYTES,
    spoolLimits: spoolLimits ?? limitsOf(run.usage),
    devicePeakBytes: run.devicePeakBytes,
  });
}

/** Every fact true, with the failing detail attached when one is not. */
function assertAllTrue(result: ScratchRunCheck, context: string): void {
  for (const entry of result.facts) {
    assert.equal(entry.value, true, `${context}: ${entry.name} — ${entry.detail}`);
  }
}

describe('the scratch model recomputes the sort instead of dividing by the source', () => {
  /**
   * Shapes chosen so the merge tree differs in kind and not only in size: no
   * merge at all, a pass that carries an odd segment forward without rewriting
   * it, a shallow wide merge, and a deep one.
   */
  const shapes = [
    { id: 'one-run', rows: 500, runSize: 500, fanIn: 2, passes: 0 },
    { id: 'carried-tail', rows: 40, runSize: 8, fanIn: 2, passes: 3 },
    { id: 'wide', rows: 1000, runSize: 50, fanIn: 8, passes: 2 },
    { id: 'deep', rows: 4000, runSize: 25, fanIn: 4, passes: 4 },
  ];

  it('accounts for every byte at every run count, small and large', () => {
    for (const shape of shapes) {
      const run = sortedUsage(`model-${shape.id}`, shape);
      const usage = run.usage;
      const result = modelled(run);
      assertAllTrue(result, shape.id);
      assert.equal(
        result.expectedBytes,
        result.actualBytes,
        `${shape.id}: the model owes ${String(result.expectedBytes)} bytes and the store counted ${String(result.actualBytes)}`,
      );

      const family = usage.byFamily[0];
      if (family === undefined) throw new Error(`${shape.id} wrote no families`);
      const sort = family.sorts[0];
      if (sort === undefined) throw new Error(`${shape.id} recorded no sort`);
      assert.equal(sort.mergePasses, shape.passes, `${shape.id} merged a different number of times than the case states`);
      assert.equal(
        family.bytesWrittenByPass.length,
        shape.passes + 1,
        `${shape.id}: one slot for run generation and one per merge pass`,
      );
      assert.equal(family.bytesWrittenUnattributed, 0, `${shape.id}: no byte was written outside a declared pass`);
    }
  });

  it('holds while the ratio against the input does not', () => {
    // The point of the whole exercise, stated as a property. The same records
    // sorted at two run sizes produce very different cumulative traffic —
    // because the merge depth grows with the run count and the input does not —
    // and the model conforms to both. A ceiling on the ratio would have to be
    // loose enough to admit the deep shape, at which point it admits anything
    // the shallow one could ever do wrong.
    const shallow = sortedUsage('ratio-shallow', { rows: 1000, runSize: 1000, fanIn: 2 });
    const deep = sortedUsage('ratio-deep', { rows: 1000, runSize: 5, fanIn: 2 });

    const ratioOf = (run: MeasuredRun): number => {
      const family = run.usage.byFamily[0];
      if (family === undefined) throw new Error('the shape wrote no families');
      const sort = family.sorts[0];
      if (sort === undefined) throw new Error('the shape recorded no sort');
      return run.usage.bytesWritten / sort.payloadBytes;
    };

    const shallowRatio = ratioOf(shallow);
    const deepRatio = ratioOf(deep);
    assert.ok(
      deepRatio > shallowRatio * 4,
      `the same records must amplify very differently at different run sizes: ${shallowRatio.toFixed(2)}x against ${deepRatio.toFixed(2)}x`,
    );
    assertAllTrue(modelled(shallow), 'shallow');
    assertAllTrue(modelled(deep), 'deep');
  });

  it('counts merge passes by division, so an exact power of the fan-in cannot round the wrong way', () => {
    // `ceil(log(n) / log(f))` is off by one whenever the division lands a few
    // ulps above an exact power, and a complexity check that is occasionally off
    // by one pass looks exactly like the defect it exists to catch.
    for (const [initialRuns, fanIn, expected] of [
      [0, 2, 0],
      [1, 2, 0],
      [2, 2, 1],
      [8, 2, 3],
      [9, 2, 4],
      [64, 8, 2],
      [512, 8, 3],
      [513, 8, 4],
      [1000, 10, 3],
    ] as const) {
      assert.equal(
        scratchModel.mergePassesFor(initialRuns, fanIn),
        expected,
        `${String(initialRuns)} runs at fan-in ${String(fanIn)}`,
      );
    }
  });

  it('shows the arithmetic rather than announcing a verdict', () => {
    const run = sortedUsage('model-arithmetic', { rows: 40, runSize: 8, fanIn: 2 });
    const family = run.usage.byFamily[0];
    if (family === undefined) throw new Error('the shape wrote no families');
    const result = scratchModel.modelFamilyTraffic(family, {
      framingBytesPerLine: run.usage.framingBytesPerLine,
      spoolLimits: limitsOf(run.usage),
    });
    assert.equal(result.verdict, 'CONFORMS');
    assert.equal(result.expectedBytes, result.actualBytes);
    const shown = result.arithmetic.join('\n');
    assert.ok(shown.includes('run generation'), 'a reader must be able to check run generation');
    assert.ok(shown.includes('pass 1:'), 'and each merge pass');
    // The bound is now derived from the declared configuration and the record
    // count rather than from the passes this run happened to take, which is what
    // makes it a statement about ten times the rows rather than about this run.
    assert.ok(shown.includes('declared-limit bound'), 'and what the declared limits owe for this many records');
    assert.ok(
      !shown.includes('source'),
      'nothing in the arithmetic may be measured against the source, which is the defect being removed',
    );
  });

  it('refuses a sort configured to write more than the declared limits require', () => {
    // The case that refuted the first version of this model, executed rather
    // than argued. The same records, sorted correctly, at two configurations:
    // one the engine declares and one nobody does. Every internal consistency
    // check passes on both — the deep one agrees with itself perfectly — and
    // that is exactly why agreeing with itself is not a bound.
    const declared = { runSize: 200, fanIn: 8 };
    const wasteful = { runSize: 2, fanIn: 2 };
    const good = sortedUsage('limits-declared', { rows: 1000, ...declared });
    const bad = sortedUsage('limits-undeclared', { rows: 1000, ...wasteful });

    assertAllTrue(modelled(good, [declared]), 'the declared configuration');

    const goodBytes = good.usage.bytesWritten;
    const badBytes = bad.usage.bytesWritten;
    assert.ok(
      badBytes > goodBytes * 3,
      `the undeclared configuration must really cost more: ${String(goodBytes)} against ${String(badBytes)}`,
    );

    // Declared to itself, it conforms — which is the whole point. Nothing about
    // the traffic is wrong; the configuration is.
    assertAllTrue(modelled(bad, [wasteful]), 'the wasteful configuration, declared to itself');

    const conforms = factOf(modelled(bad, [declared]), 'scratch_write_model_conforms');
    assert.equal(conforms.value, false, 'a sort at limits nobody declared is not evidence about the engine');
    assert.ok(conforms.detail.includes('not one of the configurations the engine declares'), conforms.detail);
    assert.ok(conforms.detail.includes('as much'), conforms.detail);
  });

  it('says nothing at all when it is not told what the engine declares', () => {
    // Fail closed, and for the same reason the quota is passed in rather than
    // copied: a model that invented the limits it checks against would be
    // checking itself.
    const run = sortedUsage('limits-absent', { rows: 200, runSize: 25, fanIn: 4 });
    for (const limits of [[] as SpoolLimitsShape[], undefined as unknown as SpoolLimitsShape[]]) {
      const result = scratchModel.checkScratchRun({
        usage: run.usage,
        quotaBytes: SCRATCH_BUDGET_BYTES,
        spoolLimits: limits,
        devicePeakBytes: run.devicePeakBytes,
      });
      for (const fact of result.facts) {
        assert.equal(fact.value, false, `${fact.name} must be false without declared limits`);
        assert.ok(fact.detail.includes('DEFAULT_SPOOL_LIMITS'), fact.detail);
      }
    }
  });
});

describe('the scratch model fails on the things it exists to catch', () => {
  // One conforming measurement, deep enough to have several merge passes and
  // several released segments, mutated one defect at a time. The unmutated copy
  // is asserted first so a failure is attributable to the mutation rather than
  // to the fixture.
  const base = sortedUsage('kill-base', { rows: 4000, runSize: 25, fanIn: 4 });

  it('is satisfied by the measurement the mutations are made from', () => {
    assertAllTrue(modelled(base), 'unmutated');
  });

  it('kills a merge pass the algorithm never had to perform', () => {
    const run = copyOf(base);
    const family = firstFamily(run.usage);
    const extra = family.bytesWrittenByPass[1] ?? 0;
    assert.ok(extra > 0, 'the fixture must really have merged');
    family.bytesWrittenByPass.push(extra);
    family.bytesWritten += extra;
    run.usage.bytesWritten += extra;

    const conforms = factOf(modelled(run), 'scratch_write_model_conforms');
    assert.equal(conforms.value, false, 'an extra pass is traffic no algorithm owes');
    assert.ok(conforms.detail.includes('merge pass'), conforms.detail);
    assert.ok(conforms.detail.includes('never performs'), conforms.detail);
  });

  it('permits two families that are identical by design and kills a third', () => {
    // The defect this repository actually shipped: `records`,
    // `records-after-conflicts` and `records-validated` were three identical
    // spills of one dataset under one key, a quarter of everything the run
    // wrote, and each one of them conformed to the model perfectly on its own.
    //
    // Two is not that. `verify-ledger-<type>` and `verify-written-<type>` in
    // src/verify/verify-package.ts are the delivered relationships read from the
    // ledger and read from the import file, spilled under the same key and
    // walked in step; a package that verifies makes them byte-identical, and
    // building either from the other would make the comparison vacuous. A rule
    // that refused every pair would fail on every passing run, which is what the
    // first version of it did.
    const pair = copyOf(base);
    const original = firstFamily(pair.usage);
    const second = structuredClone(original);
    second.family = `${original.family}-corroborated`;
    pair.usage.byFamily.push(second);
    pair.usage.bytesWritten += second.bytesWritten;
    const permitted = factOf(modelled(pair), 'scratch_write_model_conforms');
    assert.equal(permitted.value, true, `a corroborating pair must be permitted: ${permitted.detail}`);
    assert.ok(permitted.detail.includes('materialised more than once'), permitted.detail);

    const third = structuredClone(original);
    third.family = `${original.family}-validated`;
    pair.usage.byFamily.push(third);
    pair.usage.bytesWritten += third.bytesWritten;
    const conforms = factOf(modelled(pair), 'scratch_write_model_conforms');
    assert.equal(conforms.value, false, 'a third byte-identical spill corroborates nothing');
    assert.ok(conforms.detail.includes('materialise the same'), conforms.detail);
    assert.ok(conforms.detail.includes(third.family), conforms.detail);
  });

  it('kills a spent segment the sort never released', () => {
    const run = copyOf(base);
    const family = firstFamily(run.usage);
    assert.ok(family.released > 0, 'the fixture must really have released spent runs');
    // The shape of the defect: a run the merge consumed is still on the device,
    // so the quota carries it for nothing. Nothing else moves — the sealed count
    // still closes against what is held plus what was released.
    family.segments += 1;
    family.released -= 1;

    const lifecycle = factOf(modelled(run), 'scratch_lifecycle_complete');
    assert.equal(lifecycle.value, false, 'a segment the merge consumed must not survive it');
    assert.ok(lifecycle.detail.includes('never released'), lifecycle.detail);
  });

  it('kills a total no pass of the algorithm owes', () => {
    // Against the model's replay, not against the sum of the families. The store
    // raises the run total and the family total from one `delta` on consecutive
    // lines of `account`, so a sum of the parts could only ever disagree with
    // the whole on a record somebody had edited; the replay is an independent
    // producer and disagrees with a wrong total whatever produced it.
    const run = copyOf(base);
    run.usage.bytesWritten += 1;

    const conforms = factOf(modelled(run), 'scratch_write_model_conforms');
    assert.equal(conforms.value, false, 'one byte no pass performed is one byte nothing explains');
    assert.ok(conforms.detail.includes('belong to no pass of any algorithm'), conforms.detail);
  });

  it('states the peak against the device rather than against the ledger that enforces it', () => {
    // The store throws SCRATCH_QUOTA_EXCEEDED the moment its own live total
    // passes the quota, so "the store's peak was under the quota" is true of
    // every run that finished. It was a fact made true by the harness having
    // run. What is checked now is the directory: a measurement the store neither
    // keeps nor enforces anything about, pinned between the bytes the store
    // still holds and the peak its ledger admits to.
    const missing = copyOf(base);
    const noWalk = scratchModel.checkScratchRun({
      usage: missing.usage,
      quotaBytes: SCRATCH_BUDGET_BYTES,
      spoolLimits: limitsOf(missing.usage),
      devicePeakBytes: Number.NaN,
    });
    const unmeasured = factOf(noWalk, 'scratch_peak_bounded');
    assert.equal(unmeasured.value, false, 'a peak nobody measured from outside the store is not evidence');
    assert.ok(unmeasured.detail.includes('independent measurement'), unmeasured.detail);

    const zeroed = { usage: copyOf(base).usage, devicePeakBytes: 0 };
    assert.ok(zeroed.usage.bytes > 0, 'the fixture must still be holding its answer');
    const floored = factOf(modelled(zeroed), 'scratch_peak_bounded');
    assert.equal(floored.value, false, 'a caller cannot satisfy the peak fact by reporting nothing');
    assert.ok(floored.detail.includes('while the store still holds'), floored.detail);

    const uncounted = { usage: copyOf(base).usage, devicePeakBytes: base.usage.peakBytes + 1 };
    const overrun = factOf(modelled(uncounted), 'scratch_peak_bounded');
    assert.equal(
      overrun.value,
      false,
      'bytes on the device the accounting never counted are how a quota is passed without noticing',
    );
    assert.ok(overrun.detail.includes('the accounting never counted'), overrun.detail);

    const crossed = { usage: copyOf(base).usage, devicePeakBytes: SCRATCH_BUDGET_BYTES + 1 };
    crossed.usage.peakBytes = SCRATCH_BUDGET_BYTES + 1;
    const bounded = factOf(modelled(crossed), 'scratch_peak_bounded');
    assert.equal(bounded.value, false, 'one byte over the quota is over the quota');
    assert.ok(bounded.detail.includes(String(SCRATCH_BUDGET_BYTES)), bounded.detail);

    // The other half, and the one a threshold would never have caught: a run
    // that stayed under a quota nobody set to the budget proves nothing about
    // the budget.
    const wrongQuota = copyOf(base);
    wrongQuota.usage.quotaBytes = SCRATCH_BUDGET_BYTES - 1;
    const misMeasured = factOf(modelled(wrongQuota), 'scratch_peak_bounded');
    assert.equal(misMeasured.value, false);
    assert.ok(misMeasured.detail.includes('not measured against the budget'), misMeasured.detail);
  });

  it('kills a byte no pass of any algorithm claimed', () => {
    // Written straight to the store, which is what the cases earlier in this
    // file do and what no production family does. The bytes are real and the
    // accounting closes; what is missing is any algorithm willing to say it had
    // to write them.
    const scratch = store('kill-unattributed', { quotaBytes: SCRATCH_BUDGET_BYTES });
    try {
      spill(scratch.store, 'freehand', 20);
      const run = {
        usage: scratch.store.usage(),
        devicePeakBytes: walkScratchBytes(scratch.root, scratch.runId),
      };
      const conforms = factOf(modelled(run, [DEFAULT_SPOOL_LIMITS]), 'scratch_write_model_conforms');
      assert.equal(conforms.value, false);
      assert.ok(conforms.detail.includes('no external sort claimed them'), conforms.detail);
    } finally {
      scratch.store.dispose();
    }
  });

  it('refuses evidence taken before the instrumentation existed rather than passing it', () => {
    // Fail closed. Older founding evidence carries a per-family breakdown with
    // no per-pass split, and a model that shrugged at it would let last month's
    // measurement stand in for this month's code.
    const run = copyOf(base);
    const family = firstFamily(run.usage);
    delete (family as { bytesWrittenByPass?: number[] }).bytesWrittenByPass;

    const conforms = factOf(modelled(run), 'scratch_write_model_conforms');
    assert.equal(conforms.value, false);
    assert.ok(conforms.detail.includes('per-pass accounting'), conforms.detail);
  });
});

describe('a family says what it is for, or says that nobody said', () => {
  it('carries the declaration through to the report, and reports a gap as a gap', () => {
    const scratch = store('declaration', { quotaBytes: SCRATCH_BUDGET_BYTES });
    try {
      const declared = openFamily<{ id: number }>(scratch.store, {
        schema: 'declared',
        key: (item) => String(item.id).padStart(6, '0'),
        purpose: 'the records the package renders',
        producer: 'run',
        consumer: 'verify',
      });
      for (let index = 0; index < 40; index += 1) declared.add({ id: index });
      const sealed = declared.seal();

      const undeclared = openFamily<{ id: number }>(scratch.store, {
        schema: 'undeclared',
        key: (item) => String(item.id).padStart(6, '0'),
      });
      for (let index = 0; index < 5; index += 1) undeclared.add({ id: index });
      undeclared.seal();

      const usage = scratch.store.usage();
      const byName = new Map(usage.byFamily.map((entry) => [entry.family, entry] as const));
      assert.deepEqual(byName.get('declared')?.declaration, {
        purpose: 'the records the package renders',
        producer: 'run',
        consumer: 'verify',
      });
      assert.deepEqual(
        byName.get('undeclared')?.declaration,
        { purpose: null, producer: null, consumer: null },
        'a family nobody declared reports null rather than a plausible guess',
      );
      // These two go through `openFamily`, so they sort at the engine's own
      // declared limits — which is what the model is told to expect here, rather
      // than the limits read back out of the record it is judging.
      assertAllTrue(
        modelled({ usage, devicePeakBytes: walkScratchBytes(scratch.root, scratch.runId) }, [DEFAULT_SPOOL_LIMITS]),
        'declared families',
      );

      // Releasing is what moves the high-water mark, and the report has to be
      // able to say the family reached the end of its life.
      assert.equal(byName.get('declared')?.closedAt, null, 'still held while something can read it');
      sealed.release();
      const after = scratch.store.usage().byFamily.find((entry) => entry.family === 'declared');
      assert.equal(after?.liveBytes, 0);
      assert.equal(after?.segments, 0);
      assert.ok((after?.closedAt ?? 0) > 0, 'a released family records where in the run it ended');
    } finally {
      scratch.store.dispose();
    }
  });

  it('records the life of a family in run order rather than in wall-clock time', () => {
    // Two stores given the same work must produce the same evidence, or a
    // measurement taken on one machine cannot be compared with the same
    // measurement taken on another — which is the whole basis for comparing a
    // two-thousand-row run with a million-row one.
    const first = store('life-a', { quotaBytes: SCRATCH_BUDGET_BYTES });
    const second = store('life-b', { quotaBytes: SCRATCH_BUDGET_BYTES });
    try {
      const build = (target: ScratchStore): unknown => {
        externalSort(
          records(200, (index) => `k${String(index % 97).padStart(3, '0')}`),
          sortOptions(target, 16, 3),
        );
        return target.usage().byFamily.map((entry) => ({
          family: entry.family,
          openedAt: entry.openedAt,
          closedAt: entry.closedAt,
          bytesWrittenByPass: entry.bytesWrittenByPass,
          segmentsSealed: entry.segmentsSealed,
          released: entry.released,
        }));
      };
      assert.deepEqual(build(first.store), build(second.store));
    } finally {
      first.store.dispose();
      second.store.dispose();
    }
  });
});
