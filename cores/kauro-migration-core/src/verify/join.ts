import type { ScratchStore, SegmentWriter } from '../scratch/scratch-store.js';
import type { SpooledFamily } from '../run/spool.js';
import { openFamily, orderKey } from '../run/spool.js';

/**
 * Smaller runs than the engine uses for its own families.
 *
 * A verification has several of these open at once, and each one holds a run
 * in memory until it spills. The engine spills one family at a time from a
 * loop it controls; a verifier interleaves them, so the run that matters is
 * the sum of them all.
 */
export const VERIFY_SPOOL_LIMITS = { runSize: 5_000, fanIn: 8 };

/**
 * Joining two artifacts without holding either of them.
 *
 * Most of what the verifier checks is a join: a row of one artifact against the
 * rows of another that share a key. The obvious way to do that is an index —
 * read one artifact into a `Map` and walk the other — and it is what this
 * verifier did. It is also why verifying a 900,000-row package needed about a
 * gigabyte: fifteen such indexes existed at once, each holding one entry per
 * row, several holding whole rows.
 *
 * So the join is done the way the engine already does its own: project each
 * side down to the few fields the check needs, spill the projections through the
 * host's scratch store in a total order, and walk the two in step. What is held
 * at any moment is one key's worth of rows from each side — which for a join on
 * a row locator or a migration key is a handful — rather than a package's
 * worth.
 *
 * The cost is real: a join reads and writes scratch instead of memory, and a
 * verification does more I/O than it used to. That is the trade the canonical
 * document asks for, and it is the only one that holds at a million rows.
 */
export interface Keyed<T> {
  readonly k: string;
  readonly v: T;
}

/**
 * A group of rows sharing one key.
 *
 * Both sides are arrays because a key may legitimately repeat — a row with two
 * changed fields, a record with several members — and because a key repeating
 * where it should not is itself something a check wants to see. They are the
 * only thing held, and they are released when the next key arrives.
 */
export interface Group<L, R> {
  readonly key: string;
  readonly left: readonly L[];
  readonly right: readonly R[];
  /**
   * True when `left` and `right` are the whole of the key's rows on each side.
   *
   * Always true unless the join was given a bound and the key was hotter than
   * it: then the key arrives as several groups, and a group holds at most the
   * bound on each side. A side that fits is repeated, whole, in every group of
   * the key. A consumer that answers a question about a key's whole bucket does
   * not use a bounded join for it; one that answers a question about each row,
   * against a small other side, loses nothing by it.
   */
  readonly complete: boolean;
}

/**
 * Spills one projection of one artifact, in key order.
 *
 * The key is what the join is on; ties are broken by the order the rows were
 * read, so the sequence is total and a spilled projection reads back the same
 * way whatever the block size was.
 */
export function spillKeyed<T>(
  scratch: ScratchStore,
  schema: string,
  rows: Iterable<Keyed<T>>,
): SpooledFamily<Keyed<T>> {
  const spill = openKeyedSpill<T>(scratch, schema);
  for (const row of rows) spill.add(row);
  return spill.seal();
}

/**
 * The same spill, for a producer that pushes rather than one that can be pulled.
 *
 * Several of the artifacts are read through a push-based scan, so the
 * projection has to be written as each row arrives. Collecting the rows into an
 * array first and spilling them afterwards would be the index all over again.
 */
export interface KeyedSpill<T> {
  add(entry: Keyed<T>): void;
  seal(): SpooledFamily<Keyed<T>>;
}

/**
 * @param limits which declared spool configuration this spill runs under.
 *
 * It defaulted silently to the verifier's, and `build-edges.ts` -- which is the
 * engine, not a verifier -- imported this helper and inherited it. The engine
 * spills one family at a time from a loop it controls, so the reason for the
 * smaller run does not apply to it: its edge families sorted at a fifth of the
 * declared run size and paid a whole extra merge pass for it. Measured on the
 * founding HubSpot profile, `edge-owners-contact_to_company` wrote 1,058,733,456
 * bytes where the declared configuration needs 794,050,092.
 *
 * So the configuration is a parameter with the verifier's as its default, and
 * the engine passes its own.
 */
export function openKeyedSpill<T>(
  scratch: ScratchStore,
  schema: string,
  limits: { readonly runSize: number; readonly fanIn: number } = VERIFY_SPOOL_LIMITS,
): KeyedSpill<T> {
  let position = 0;
  const writer = openFamily<Keyed<T>>(
    scratch,
    {
      schema,
      key: (entry) => {
        position += 1;
        return orderKey(entry.k, String(position).padStart(12, '0'));
      },
    },
    limits,
  );
  return {
    add(entry): void {
      writer.add(entry);
    },
    seal(): SpooledFamily<Keyed<T>> {
      return writer.seal();
    },
  };
}

/**
 * How `coGroup` bounds the work a hot key can cause.
 *
 * Without options it is the join every verifier check was written against: one
 * group per key, holding the key's rows from each side whole. That is right for a
 * key that is unique by construction, and it is proportional to the hottest
 * bucket for one that is not.
 *
 * With a `bound` no group holds more than that many rows from either side, and
 * the join reads no more than the bound and one row ahead of what it yields:
 *
 *   - a key hot on one side only is streamed in pieces of at most `bound`
 *     rows, and the other side, which fits, comes with every piece;
 *   - a key hot on both sides needs the right side read again for each piece of
 *     the left, so its bucket is written to `scratch` and read back by a cursor
 *     that rewinds. Every pairing of a left piece with a right piece is yielded
 *     once.
 *
 * A row held in scratch is written as JSON, as every spilled family is.
 */
export interface CoGroupOptions {
  /** The most rows a group holds from either side. Default: no bound. */
  readonly bound?: number;
  /** Where a bucket hot on both sides is written. Required only if one occurs. */
  readonly scratch?: ScratchStore;
}

/**
 * Walks two key-ordered families in step.
 *
 * Every key present on either side is yielded, in key order, with whichever
 * rows each side holds for it. A key on one side only yields an empty array for
 * the other, because "present here and missing there" is the most common thing
 * a verifier needs to say. A key is yielded exactly once unless a bound was
 * given and the key is hotter than it (see `CoGroupOptions`).
 */
export function* coGroup<L, R>(
  left: Iterable<Keyed<L>>,
  right: Iterable<Keyed<R>>,
  options: CoGroupOptions = {},
): IterableIterator<Group<L, R>> {
  const leftIterator = left[Symbol.iterator]();
  const rightIterator = right[Symbol.iterator]();
  const leftCursor = peekable(leftIterator);
  const rightCursor = peekable(rightIterator);

  // Both sides are closed however this ends.
  //
  // A generator that is abandoned rather than finished never runs its own
  // `finally`, so an artifact being read through one keeps its file handle
  // open until the process exits. On Windows that is not a leak that waits
  // for the end: an open handle inside a directory makes the directory
  // unrenamable, and the writer publishes a package by renaming it. A check
  // that stopped early therefore stopped the run from delivering.
  try {
    yield* walk(leftCursor, rightCursor, options);
  } finally {
    leftIterator.return?.(undefined);
    rightIterator.return?.(undefined);
  }
}

function takeKey<T>(cursor: Peekable<Keyed<T>>, key: string, limit: number): T[] {
  const rows: T[] = [];
  while (rows.length < limit && cursor.peek()?.k === key) rows.push((cursor.next() as Keyed<T>).v);
  return rows;
}

function* walk<L, R>(
  leftCursor: Peekable<Keyed<L>>,
  rightCursor: Peekable<Keyed<R>>,
  options: CoGroupOptions,
): IterableIterator<Group<L, R>> {
  const bound = options.bound ?? Number.POSITIVE_INFINITY;
  if (!(bound >= 1)) throw new Error(`coGroup was given a bound of ${String(options.bound)}`);

  for (;;) {
    const leftKey = leftCursor.peek()?.k ?? null;
    const rightKey = rightCursor.peek()?.k ?? null;
    if (leftKey === null && rightKey === null) return;

    const key =
      leftKey === null
        ? (rightKey as string)
        : rightKey === null
          ? leftKey
          : leftKey <= rightKey
            ? leftKey
            : rightKey;

    const leftRows = takeKey(leftCursor, key, bound);
    const rightRows = takeKey(rightCursor, key, bound);
    const leftMore = leftCursor.peek()?.k === key;
    const rightMore = rightCursor.peek()?.k === key;

    if (!leftMore && !rightMore) {
      yield { key, left: leftRows, right: rightRows, complete: true };
    } else if (!rightMore) {
      // Hot on the left only: the right side fits, and comes with every piece.
      yield { key, left: leftRows, right: rightRows, complete: false };
      for (let piece = takeKey(leftCursor, key, bound); piece.length > 0; piece = takeKey(leftCursor, key, bound)) {
        yield { key, left: piece, right: rightRows, complete: false };
      }
    } else if (!leftMore) {
      yield { key, left: leftRows, right: rightRows, complete: false };
      for (let piece = takeKey(rightCursor, key, bound); piece.length > 0; piece = takeKey(rightCursor, key, bound)) {
        yield { key, left: leftRows, right: piece, complete: false };
      }
    } else {
      yield* crossPieces(key, leftRows, rightRows, leftCursor, rightCursor, bound, options.scratch);
    }
  }
}

/**
 * A key hot on both sides: the right bucket is written once, and read back from
 * the start for each piece of the left.
 */
function* crossPieces<L, R>(
  key: string,
  firstLeft: L[],
  firstRight: R[],
  leftCursor: Peekable<Keyed<L>>,
  rightCursor: Peekable<Keyed<R>>,
  bound: number,
  scratch: ScratchStore | undefined,
): IterableIterator<Group<L, R>> {
  if (scratch === undefined) {
    throw new Error(
      `coGroup met a key hot on both sides (more than ${String(bound)} rows each) and was given no scratch store to hold one of them`,
    );
  }
  const writer: SegmentWriter = scratch.createSegment({ schema: 'cogroup-bucket', schemaVersion: '1.0.0' });
  let segmentId: string | null = null;
  try {
    for (const row of firstRight) writer.append(JSON.stringify(row));
    while (rightCursor.peek()?.k === key) writer.append(JSON.stringify((rightCursor.next() as Keyed<R>).v));
    segmentId = writer.seal().segmentId;
    const sealed = segmentId;

    const rightPieces = function* (): IterableIterator<R[]> {
      let piece: R[] = [];
      for (const line of scratch.readLines(sealed)) {
        piece.push(JSON.parse(line) as R);
        if (piece.length === bound) {
          yield piece;
          piece = [];
        }
      }
      if (piece.length > 0) yield piece;
    };

    for (let left = firstLeft; left.length > 0; left = takeKey(leftCursor, key, bound)) {
      for (const right of rightPieces()) yield { key, left, right, complete: false };
    }
  } finally {
    if (segmentId === null) writer.abort();
    else scratch.delete(segmentId);
  }
}

interface Peekable<T> {
  peek(): T | null;
  next(): T | null;
}

function peekable<T>(iterator: Iterator<T>): Peekable<T> {
  let held: T | null = null;
  let done = false;
  const pull = (): void => {
    if (held !== null || done) return;
    const step = iterator.next();
    if (step.done === true) {
      done = true;
      held = null;
      return;
    }
    held = step.value;
  };
  return {
    peek(): T | null {
      pull();
      return held;
    },
    next(): T | null {
      pull();
      const value = held;
      held = null;
      return value;
    },
  };
}

/**
 * A membership test that does not hold the members.
 *
 * Some checks want only "is this key present in that artifact", one key at a
 * time, in no particular order. Spilling the artifact's keys and asking the
 * question with a cursor would mean rewinding, so this is deliberately not
 * offered: a check that needs random access is rewritten as a co-group over
 * both sides instead. The type exists to make that refusal explicit rather
 * than leaving the next reader to invent a `Set`.
 */
export type NoRandomAccess = never;
