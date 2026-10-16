import { createHash } from 'node:crypto';
import { compareCodeUnits } from '../util/json.js';
import { CoreInvariantError } from '../util/assert.js';
import type { ScratchSortFormat, ScratchStore } from './scratch-store.js';
import { scratchFailure } from './scratch-store.js';

/**
 * Deterministic external sort.
 *
 * The engine sorts more rows than it may hold, so the sort spills. What matters
 * is not that it fits, but that spilling changes nothing observable: the same
 * input has to produce the same output whatever the run size, the fan-in, the
 * number of temporary segments, the platform, or the order the host happened to
 * schedule anything in. A package whose bytes depend on how much memory the
 * machine had is not reproducible, and reproducibility is most of what the
 * verification is worth.
 *
 * That is achieved by making the order **total** rather than merely correct. A
 * comparator with ties leaves the result to whatever the sort did with equal
 * elements, which is exactly the thing that changes when the run size changes.
 * Every record therefore carries its input position, and the position breaks
 * every tie. The sort is stable as a consequence rather than as a promise, and
 * the sorted sequence is unique, so no two schedules can produce different
 * output.
 */

/** Reserved as the boundary between a key and its tie-break, so a key may not contain it. */
const KEY_TERMINATOR = '\u0000';
/**
 * Reserved as the boundary between a sort key and the record it orders.
 *
 * A merge re-reads the key from the line it is written on, so a key holding
 * this character would be read back truncated at the first one — and a
 * truncated key still sorts, which is what makes it dangerous. The comparison
 * would be against a prefix, the order would be wrong, and nothing downstream
 * re-checks an order it has been told is correct. Source values reach keys, and
 * a quoted CSV field may hold a tab, so this is reachable from input rather
 * than only from a mistake here.
 */
const RECORD_SEPARATOR = '\t';
const SEQUENCE_WIDTH = 16;
/** What a sequence shorter than the width is padded with, named so the width can be encoded. */
const SEQUENCE_PAD = '0';

/**
 * What this format costs, per record, on top of the record itself.
 *
 * Reported to the store so that a model recomputing the sort's traffic takes the
 * format from the format. The alternative — a model carrying its own copy of
 * these three numbers — agrees with the sort exactly until somebody changes the
 * sequence width, which is the moment it has to stop agreeing.
 *
 * `sequenceBytes` used to be `SEQUENCE_WIDTH` itself, with a comment saying that
 * a decimal digit is one byte in UTF-8 so the character count and the byte count
 * are the same number. That was true and it was still the wrong thing to write:
 * the two neighbouring fields both call `Buffer.byteLength`, and a field that
 * asserts what its neighbours derive is the field that will be wrong the day the
 * padding character stops being a digit. Encoding a full-width sequence and
 * measuring it costs one call at module load and cannot drift.
 */
export const SORT_FRAMING: ScratchSortFormat = {
  keyTerminatorBytes: Buffer.byteLength(KEY_TERMINATOR, 'utf8'),
  sequenceBytes: Buffer.byteLength(SEQUENCE_PAD.repeat(SEQUENCE_WIDTH), 'utf8'),
  keySeparatorBytes: Buffer.byteLength(RECORD_SEPARATOR, 'utf8'),
};

export interface ExternalSortOptions<T> {
  readonly store: ScratchStore;
  /** Names the spilled segments. Engine vocabulary, never customer data. */
  readonly schema: string;
  readonly schemaVersion: string;
  /** Records held in memory before a run is spilled. */
  readonly runSize: number;
  /** Segments merged in one pass. */
  readonly fanIn: number;
  readonly key: (item: T) => string;
  readonly encode: (item: T) => string;
  readonly decode: (line: string) => T;
}

export interface ExternalSortResult {
  /** The sorted segment, or null when there was nothing to sort. */
  readonly segmentId: string | null;
  readonly rowCount: number;
  /** Spilled runs before merging, which is what makes a capacity measurement legible. */
  readonly initialRuns: number;
  readonly mergePasses: number;
}

/**
 * The characters a sort key may not hold, and why each one matters.
 *
 * Stated as data rather than as three copies of the same `if`, so the next
 * character the format comes to own is added in one place and cannot be added
 * to the writer and forgotten in the checker.
 */
const FORBIDDEN_IN_KEY: ReadonlyArray<{ readonly character: string; readonly name: string; readonly remedy: string }> = [
  {
    character: KEY_TERMINATOR,
    name: 'a NUL',
    remedy: 'NUL separates a key from its tie-break. Encode the key with orderText so it cannot contain one.',
  },
  {
    character: RECORD_SEPARATOR,
    name: 'a tab',
    remedy:
      'A tab separates the sort key from the record it orders, and a merge reads the key back from that line. A key holding one ' +
      'would be compared as a prefix of itself, which sorts without complaining. Encode the key with orderText so it cannot contain one.',
  },
  {
    character: '\n',
    name: 'a line feed',
    remedy:
      'A line feed separates records in a segment, so a key holding one would be written as two records and read back as neither. ' +
      'Encode the key with orderText so it cannot contain one.',
  },
];

/**
 * A rejected key, described rather than quoted.
 *
 * A sort key is built from source values, so quoting one puts a customer's name
 * or address into an exception that will be logged and very likely mailed to
 * someone. The position says which part of a composite key is at fault, the
 * length distinguishes a stray character from a whole cell in the wrong place,
 * and the digest lets two reports of the same failure be recognised as one
 * without either of them carrying the value.
 */
function describeKey(key: string, at: number, name: string): Record<string, string | number | boolean | null> {
  return {
    forbidden: name,
    atCodeUnit: at,
    keyLength: key.length,
    keyDigest: createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16),
    note: 'the key is described and not quoted: a sort key is built from source values',
  };
}

/**
 * The order a record sorts under.
 *
 * `key`, then input position. The terminator is below every other code unit, so
 * a key that is a prefix of another still sorts before it, and comparing the
 * composed strings by code unit is the same order as comparing the pair.
 */
export function sortKeyFor(key: string, sequence: number): string {
  // Every character the segment format owns, checked here rather than at the
  // spill.
  //
  // NUL and tab were checked and the line terminators were not, so a key built
  // from a cell holding a line break — an address, a note, anything a person
  // typed a return into — reached the store, which refused the write with "a
  // scratch line may not contain a line feed" and a detail naming the segment.
  // Nothing in that said which family, which part of the key, or that the fault
  // was in the key rather than in the record. The founding CLEAN_ONLY profile
  // failed exactly this way, and the message sent whoever read it into the
  // store.
  //
  // The details describe the key and never quote it. The old messages put the
  // offending key straight into the error, and a key is built from customer
  // values: a name, an address, a note. An exception is logged, attached to a
  // report and read by whoever is on the other end of a failed migration, and
  // none of those is a place a customer's data belongs. The position, the
  // length and a digest identify a key well enough to find the code that built
  // it.
  for (const forbidden of FORBIDDEN_IN_KEY) {
    const at = key.indexOf(forbidden.character);
    if (at === -1) continue;
    scratchFailure(`a sort key may not contain ${forbidden.name}`, forbidden.remedy, describeKey(key, at, forbidden.name));
  }
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new CoreInvariantError('SORT_SEQUENCE_IS_A_POSITION', 'a sort sequence must be a whole position', {
      sequence,
    });
  }
  const padded = String(sequence).padStart(SEQUENCE_WIDTH, SEQUENCE_PAD);
  if (padded.length > SEQUENCE_WIDTH) {
    throw new CoreInvariantError(
      'SORT_SEQUENCE_WITHIN_WIDTH',
      'more records were sorted than the tie-break width allows',
      { sequence },
    );
  }
  return `${key}${KEY_TERMINATOR}${padded}`;
}

function assertPositive(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CoreInvariantError('SORT_BOUNDS_ARE_POSITIVE', `${name} must be a positive whole number`, {
      [name]: value,
    });
  }
}

/**
 * A sort that is fed rather than one that pulls.
 *
 * The engine produces facts inside loops it does not control the shape of — one
 * per source row, one per changed cell, one per relationship candidate — so a
 * sort that demands an iterable would force the producer to collect first, which
 * is the one thing all of this exists to avoid. Push each fact as it is made,
 * and the sorter holds one run and nothing else.
 */
export interface ExternalSorter {
  push(item: unknown): void;
  /** Sorts what remains, merges the runs, and names the segment holding the answer. */
  finish(): ExternalSortResult;
}

export function createExternalSorter<T>(options: ExternalSortOptions<T>): ExternalSorter {
  assertPositive('runSize', options.runSize);
  assertPositive('fanIn', options.fanIn);
  if (options.fanIn < 2) {
    throw new CoreInvariantError('SORT_FAN_IN_MERGES', 'a merge needs at least two inputs', {
      fanIn: options.fanIn,
    });
  }

  const runs: string[] = [];
  let sequence = 0;
  let rowCount = 0;
  let buffer: { sortKey: string; line: string }[] = [];
  let finished = false;

  /**
   * What the sort was given, before it added anything to it.
   *
   * Counted here because this is the only place a record enters the sort, so
   * there is nowhere for a second count to drift from. It is a real cost — two
   * `Buffer.byteLength` calls per record — and it is paid on purpose: without a
   * payload figure taken before framing, the only way to say what a spill cost
   * is to divide by the source file, and that ratio changes with the run count
   * while the algorithm does not.
   */
  let payloadBytes = 0;
  let keyBytes = 0;
  const initialRunBytes: number[] = [];
  const initialRunRecords: number[] = [];

  const spill = (): void => {
    if (buffer.length === 0) return;
    buffer.sort((a, b) => compareCodeUnits(a.sortKey, b.sortKey));
    const writer = options.store.createSegment({
      schema: options.schema,
      schemaVersion: options.schemaVersion,
      sorted: true,
      // Pass 0: written before any merging. The store splits its running total
      // on this, so a model can ask what run generation cost separately from
      // what each merge pass cost — which is the split a ratio against source
      // bytes destroys.
      pass: 0,
    });
    try {
      for (const entry of buffer) writer.append(`${entry.sortKey}${RECORD_SEPARATOR}${entry.line}`, entry.sortKey);
      const manifest = writer.seal();
      runs.push(manifest.segmentId);
      initialRunBytes.push(manifest.byteLength);
      initialRunRecords.push(manifest.rowCount);
    } catch (error) {
      writer.abort();
      throw error;
    }
    // Released here rather than at the end: at a million rows this is the
    // largest thing the sort holds, and holding it one moment longer than the
    // spill needs it is the whole defect this design exists to avoid.
    buffer = [];
  };

  /**
   * Hands the store the parameters of the sort that just ran.
   *
   * The store measured the bytes; this says what the algorithm was, so that
   * something outside can recompute what those bytes had to be. The two are kept
   * apart deliberately — a check that derived the expectation from the
   * measurement would pass whatever the measurement said.
   */
  const declare = (
    initialRuns: number,
    mergePasses: number,
    resultSegmentId: string | null,
    resultBytes: number,
    resultRows: number,
    resultDigest: string | null,
  ): void => {
    options.store.recordSort(options.schema, {
      records: rowCount,
      payloadBytes,
      keyBytes,
      runSize: options.runSize,
      fanIn: options.fanIn,
      initialRuns,
      mergePasses,
      initialRunBytes,
      initialRunRecords,
      format: SORT_FRAMING,
      resultSegmentId,
      resultBytes,
      resultRows,
      resultDigest,
    });
  };

  return {
    push(item: unknown): void {
      if (finished) {
        throw new CoreInvariantError('SORT_IS_FINISHED', 'a finished sort cannot be pushed to', {
          schema: options.schema,
        });
      }
      const value = item as T;
      const line = options.encode(value);
      if (line.includes(RECORD_SEPARATOR)) {
        scratchFailure(
          'a sorted record may not contain a tab',
          'A tab separates the sort key from the record. Encode the record so it cannot contain one.',
          { schema: options.schema },
        );
      }
      const rawKey = options.key(value);
      buffer.push({ sortKey: sortKeyFor(rawKey, sequence), line });
      payloadBytes += Buffer.byteLength(line, 'utf8');
      keyBytes += Buffer.byteLength(rawKey, 'utf8');
      sequence += 1;
      rowCount += 1;
      if (buffer.length >= options.runSize) spill();
    },

    finish(): ExternalSortResult {
      if (finished) {
        throw new CoreInvariantError('SORT_FINISHES_ONCE', 'a sort cannot be finished twice', {
          schema: options.schema,
        });
      }
      finished = true;
      spill();

      const initialRuns = runs.length;
      if (initialRuns === 0) {
        // Reported even though it sorted nothing. A family that was opened and
        // never written is a fact about the run, and one that is simply absent
        // from the report cannot be told apart from a family whose traffic
        // nothing accounted for.
        declare(0, 0, null, 0, 0, null);
        return { segmentId: null, rowCount: 0, initialRuns: 0, mergePasses: 0 };
      }

      let current = runs;
      let mergePasses = 0;
      while (current.length > 1) {
        mergePasses += 1;
        const next: string[] = [];
        for (let index = 0; index < current.length; index += options.fanIn) {
          const group = current.slice(index, index + options.fanIn);
          next.push(group.length === 1 ? (group[0] as string) : mergeGroup(options, group, mergePasses));
        }
        // Only the inputs this pass consumed, and only once they are no longer
        // referenced: scratch that is not deleted as soon as it is spent is
        // scratch the quota has to carry for no reason.
        for (const segmentId of current) {
          if (!next.includes(segmentId)) options.store.delete(segmentId);
        }
        current = next;
      }

      const segmentId = current[0] as string;
      const answer = options.store.manifest(segmentId);
      declare(initialRuns, mergePasses, segmentId, answer.byteLength, answer.rowCount, answer.sha256);
      return { segmentId, rowCount, initialRuns, mergePasses };
    },
  };
}

/**
 * Sorts everything the iterable yields and leaves the result in one segment.
 *
 * The input is consumed once and released as it goes: nothing beyond one run is
 * held, which is the whole point of doing it this way rather than collecting an
 * array and calling `sort`.
 */
export function externalSort<T>(items: Iterable<T>, options: ExternalSortOptions<T>): ExternalSortResult {
  const sorter = createExternalSorter(options);
  for (const item of items) sorter.push(item);
  return sorter.finish();
}

/** Streams a segment produced by `externalSort`, in order, decoding each record. */
export function* readSorted<T>(
  store: ScratchStore,
  segmentId: string | null,
  decode: (line: string) => T,
): IterableIterator<T> {
  if (segmentId === null) return;
  for (const line of store.readLines(segmentId)) {
    yield decode(payloadOf(line));
  }
}

function payloadOf(line: string): string {
  const index = line.indexOf(RECORD_SEPARATOR);
  if (index === -1) {
    scratchFailure(
      'a sorted record is missing its key separator',
      'The segment was not written by this sort, or it has been altered.',
      {},
    );
  }
  return line.slice(index + 1);
}

function sortKeyOf(line: string): string {
  const index = line.indexOf(RECORD_SEPARATOR);
  if (index === -1) {
    scratchFailure(
      'a sorted record is missing its key separator',
      'The segment was not written by this sort, or it has been altered.',
      {},
    );
  }
  return line.slice(0, index);
}

/**
 * One merge pass over a bounded number of inputs.
 *
 * A heap keyed on the composed sort key, so the merge holds one record per input
 * and nothing else. Because the order is total, the winner is never a choice.
 */
function mergeGroup<T>(options: ExternalSortOptions<T>, segmentIds: readonly string[], pass: number): string {
  const readers = segmentIds.map((segmentId) => options.store.readLines(segmentId)[Symbol.iterator]());
  const heap: { sortKey: string; line: string; source: number }[] = [];

  const push = (entry: { sortKey: string; line: string; source: number }): void => {
    heap.push(entry);
    let child = heap.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (compareCodeUnits((heap[child] as typeof entry).sortKey, (heap[parent] as typeof entry).sortKey) >= 0) break;
      const swap = heap[child] as typeof entry;
      heap[child] = heap[parent] as typeof entry;
      heap[parent] = swap;
      child = parent;
    }
  };

  const pop = (): { sortKey: string; line: string; source: number } | undefined => {
    const top = heap[0];
    if (top === undefined) return undefined;
    const last = heap.pop() as typeof top;
    if (heap.length > 0) {
      heap[0] = last;
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        const right = left + 1;
        let smallest = parent;
        if (left < heap.length && compareCodeUnits((heap[left] as typeof top).sortKey, (heap[smallest] as typeof top).sortKey) < 0) {
          smallest = left;
        }
        if (right < heap.length && compareCodeUnits((heap[right] as typeof top).sortKey, (heap[smallest] as typeof top).sortKey) < 0) {
          smallest = right;
        }
        if (smallest === parent) break;
        const swap = heap[parent] as typeof top;
        heap[parent] = heap[smallest] as typeof top;
        heap[smallest] = swap;
        parent = smallest;
      }
    }
    return top;
  };

  const advance = (source: number): void => {
    const reader = readers[source];
    if (reader === undefined) return;
    const next = reader.next();
    if (next.done === true) return;
    push({ sortKey: sortKeyOf(next.value), line: next.value, source });
  };

  for (let source = 0; source < readers.length; source += 1) advance(source);

  const writer = options.store.createSegment({
    schema: options.schema,
    schemaVersion: options.schemaVersion,
    sorted: true,
    pass,
  });
  try {
    for (;;) {
      const winner = pop();
      if (winner === undefined) break;
      writer.append(winner.line, winner.sortKey);
      advance(winner.source);
    }
    return writer.seal().segmentId;
  } catch (error) {
    writer.abort();
    throw error;
  }
}
