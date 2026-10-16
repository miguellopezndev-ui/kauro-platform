import { CoreInvariantError } from '../util/assert.js';
import { compareCodeUnits, parseJson } from '../util/json.js';
import type { JsonValue } from '../util/json.js';
import type { ScratchStore } from '../scratch/scratch-store.js';
import { createExternalSorter, readSorted } from '../scratch/external-sort.js';

/**
 * A family of facts the run produced, in canonical order, held where it can be
 * read but not where it has to be carried.
 *
 * Every artifact in a package is a rendering of one of these. At a million rows
 * the row-scoped ones are the largest thing a migration makes, and they were
 * plain arrays: built by pushing, sorted by copying, and then held for the whole
 * life of the result while the package was written from them and verified. The
 * run ended up carrying several representations of the same dataset at once,
 * which is the shape the canonical document rejects.
 *
 * A family is now written as it is produced, sorted externally, and read back a
 * record at a time. What a consumer can do with it is deliberately small — count
 * it, or walk it in order — because those are the only two things a package
 * needs, and anything else would be an invitation to hold it again.
 */
export interface SpooledFamily<T> extends Iterable<T> {
  /** How many facts the family holds, counted where they were produced. */
  readonly count: number;
}

/**
 * A family that owns the segment it reads from, and can give it back.
 *
 * Every family the engine writes is spent at some point -- read for the last
 * time by the last stage that needs it -- and until now none of them said so.
 * The instrumentation made that visible: `released` was zero for every family
 * in the run, so peak scratch equalled every byte ever written, and a run held
 * the drafts, the identity groups and the candidate edges alive through
 * verification because nothing had told the store they were finished.
 *
 * Releasing is not the same as writing less. It does not move the amplification
 * ratio, which counts bytes written; it moves the high-water mark, which is what
 * the quota is checked against. Both matter and they are different numbers.
 *
 * A released family is gone. Reading one afterwards is a scratch failure naming
 * the missing segment, which is the right outcome: a release is a claim that
 * nothing reads this again, and a claim that turns out to be false should stop
 * the run rather than be worked around.
 */
export interface ReleasableFamily<T> extends SpooledFamily<T> {
  /**
   * Discards the segment behind this family. Safe to call twice; the second
   * call has nothing to do.
   */
  release(): void;
}

/**
 * A family small enough to keep.
 *
 * Not every family grows with the row count. Merges, duplicate clusters,
 * destination conflicts and instance-verification items are bounded by something
 * else, and spilling them would cost a segment to save nothing. This is also what
 * a test uses when it wants to state a family literally.
 */
export function materialisedFamily<T>(items: readonly T[]): SpooledFamily<T> {
  return {
    count: items.length,
    [Symbol.iterator]: (): IterableIterator<T> => items[Symbol.iterator]() as IterableIterator<T>,
  };
}

export interface FamilyOrder<T> {
  /** Names the segments. Engine vocabulary, never customer data. */
  readonly schema: string;
  /**
   * The canonical order, as one string per fact.
   *
   * A string rather than a comparator because the sort is external: the order
   * has to survive being written to a segment and read back, and a function
   * cannot be. Build it with the helpers below so that numbers sort as numbers.
   */
  readonly key: (item: T) => string;
  /**
   * How a fact is written down and read back, where JSON is not enough.
   *
   * Most facts are plain data and `JSON.stringify` is exactly right. A fact
   * that holds a `Map` is not: JSON writes it as `{}` and the fact comes back
   * empty, which is a silent loss rather than a failure. A family whose facts
   * are shaped like that says how to write them instead of hoping.
   */
  readonly encode?: (item: T) => string;
  readonly decode?: (line: string) => T;
  /**
   * What this family is for, who writes it, and who reads it last.
   *
   * Optional, and that is a compromise rather than a design. Twenty-odd families
   * are opened across the engine and the verifier, and a required field would
   * mean editing every one of those call sites at once; a family that has not
   * declared itself reports null and the scratch model says "undeclared" rather
   * than inventing an answer.
   *
   * `consumer` is the one that pays for itself immediately: it names the stage
   * after which the family may be released, and every family whose consumer
   * nobody could name is a family nothing releases. That is exactly how a run
   * came to hold every byte it had ever written until it exited.
   */
  readonly purpose?: string;
  readonly producer?: string;
  readonly consumer?: string;
}

export interface SpoolLimits {
  /** Facts held in memory before a run is spilled. */
  readonly runSize: number;
  /** Segments merged in one pass. */
  readonly fanIn: number;
}

export const DEFAULT_SPOOL_LIMITS: SpoolLimits = { runSize: 50_000, fanIn: 8 };

export interface FamilyWriter<T> {
  add(item: T): void;
  /** Finishes the sort and hands back a family that can be read in order. */
  seal(): ReleasableFamily<T>;
}

/**
 * Opens a family for writing.
 *
 * The facts arrive in whatever order the engine produces them and leave in the
 * canonical one. Nothing beyond one run is held at any point, which is why the
 * producer may be an ordinary loop over source rows rather than a generator
 * arranged to please a sort.
 */
export function openFamily<T>(
  store: ScratchStore,
  order: FamilyOrder<T>,
  limits: SpoolLimits = DEFAULT_SPOOL_LIMITS,
): FamilyWriter<T> {
  const encode = order.encode ?? ((item: T): string => JSON.stringify(item as unknown as JsonValue));
  const decode = order.decode ?? ((line: string): T => parseJson(line) as unknown as T);

  // Declared at open rather than at seal, so a family that is opened and then
  // abandoned still appears in the report saying what it was going to be. A
  // family missing from the report is indistinguishable from one nobody
  // accounted for, and those are very different defects.
  store.declareFamily(order.schema, {
    purpose: order.purpose ?? null,
    producer: order.producer ?? null,
    consumer: order.consumer ?? null,
  });

  const sorter = createExternalSorter<T>({
    store,
    schema: order.schema,
    schemaVersion: FAMILY_SCHEMA_VERSION,
    runSize: limits.runSize,
    fanIn: limits.fanIn,
    key: order.key,
    encode,
    decode,
  });

  let sealed = false;
  return {
    add(item: T): void {
      sorter.push(item);
    },
    seal(): ReleasableFamily<T> {
      if (sealed) {
        throw new CoreInvariantError('FAMILY_SEALS_ONCE', `family ${order.schema} was sealed twice`);
      }
      sealed = true;
      const result = sorter.finish();
      const segmentId = result.segmentId;
      let released = false;
      return {
        count: result.rowCount,
        [Symbol.iterator]: (): IterableIterator<T> => readSorted<T>(store, segmentId, decode),
        release(): void {
          // The segment id is kept, not forgotten. Reading a released family
          // then fails in the store with "segment is not present", naming it,
          // rather than yielding nothing: a release is a claim that nothing
          // reads this again, and a wrong claim that produced an empty artifact
          // would be the worst possible way to find out.
          if (released || segmentId === null) return;
          released = true;
          store.delete(segmentId);
        },
      };
    },
  };
}

export const FAMILY_SCHEMA_VERSION = '1.0.0';

// ---------------------------------------------------------------- order keys

/**
 * Separates the parts of a composite order key.
 *
 * Below every character a path, a sheet name or a field name can hold, so
 * comparing composed keys by code unit is the same order as comparing the parts
 * in turn — including where one part is a prefix of another, which is where a
 * printable separator would put "ab" before "a".
 */
const PART = '\u0001';

/**
 * A number, written so that it sorts as a number.
 *
 * Row numbers and column indexes are compared as text once they are inside a
 * sort key, and "10" sorts before "9". Fixed width fixes that, and the width is
 * checked rather than assumed: silently truncating a row number would reorder
 * an artifact.
 */
export function orderNumber(value: number, width = 12): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CoreInvariantError('ORDER_NUMBER_IS_A_POSITION', 'an ordering number must be a whole position', {
      value,
    });
  }
  const text = String(value);
  if (text.length > width) {
    throw new CoreInvariantError('ORDER_NUMBER_WITHIN_WIDTH', 'an ordering number is wider than its field', {
      value,
      width,
    });
  }
  return text.padStart(width, '0');
}

/**
 * A key part that may hold anything a source cell held.
 *
 * An ordering key is written into a segment, and the segment format owns some
 * characters: a newline separates records, a tab separates the key from the
 * record, a NUL terminates the key, and  separates the parts of a
 * composite key. A key built from a customer value can contain any of them --
 * a name with a line break in it is a real thing to find in a spreadsheet --
 * and the store refuses the segment rather than writing something it cannot
 * read back.
 *
 * So a part taken from the data is escaped. The escaping is injective, which
 * is what grouping needs: two values are adjacent in the sorted family exactly
 * when they are equal. It orders escaped values rather than raw ones, which is
 * why nothing that uses it depends on the order -- each of them groups, and
 * sorts its own output afterwards.
 */
export function orderText(value: string): string {
  let out = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    out += code < 0x20 || character === PERCENT ? `${PERCENT}${code.toString(16).padStart(2, '0')}` : character;
  }
  return out;
}

const PERCENT = '%';

export function orderKey(...parts: readonly string[]): string {
  for (const part of parts) {
    if (part.includes(PART)) {
      throw new CoreInvariantError('ORDER_KEY_PART_IS_CLEAN', 'an ordering key part holds the part separator', {
        part,
      });
    }
  }
  return parts.join(PART);
}

export interface RowOrderAddress {
  readonly filePath: string;
  readonly sheetId: string;
  readonly rowNumberSource: number;
}

/**
 * The parts of a row's position, for composing with more.
 *
 * Returned as parts rather than as a finished key because a key made of keys is
 * not a key: `orderKey` refuses a part holding the separator, and nesting one
 * composed key inside another hands it exactly that. A change is ordered by its
 * row *and then* its field, so it composes the parts, not the result.
 */
export function rowOrderParts(address: RowOrderAddress): string[] {
  // The path is NOT escaped here, and that is deliberate.
  //
  // It was, for one revision, on the reasoning that a POSIX filename may hold a
  // tab or a line feed and would then abort the run in the sort. The reasoning
  // was right and the change was wrong: `orderText` is injective but not
  // order-preserving — it maps a control character to `%XX`, and `%` sorts
  // above space — while every consumer that *checks* this order compares the
  // path raw. `lineage.ordering` in src/verify/verify-package.ts builds its
  // comparison from the raw `file_path` column, and `artifacts.declaredOrder`
  // does the same for six more artifacts. So a bundle with a vertical tab in a
  // filename stopped aborting loudly in the sort and started producing a
  // package that failed its own verification on seven checks, which is strictly
  // worse: the abort named the family, and the verification failure names the
  // artifact.
  //
  // Escaping an address is a change to how the engine and the verifier both
  // spell one, and it has to be made in both at once or not at all. Until then
  // a hostile filename is refused by `sortKeyFor`, by name, at the first family
  // that sorts on it.
  return [address.filePath, address.sheetId, orderNumber(address.rowNumberSource)];
}

/** The order every row-addressed artifact is written in: file, then sheet, then row. */
export function rowOrderKey(address: RowOrderAddress): string {
  return orderKey(...rowOrderParts(address));
}

/** Exposed so a test can check the composed order against the comparator it replaces. */
export function compareOrderKeys(a: string, b: string): number {
  return compareCodeUnits(a, b);
}


/**
 * A family seen through a projection, without being read to build it.
 *
 * A package artifact is a family with its fields rearranged into cells, and
 * mapping eagerly would build the whole artifact in memory next to the family it
 * came from — which is the copy all of this exists to avoid. The count carries
 * over unchanged, because a projection does not add or drop facts.
 */
export function mapFamily<T, U>(family: SpooledFamily<T>, project: (item: T) => U): SpooledFamily<U> {
  return {
    count: family.count,
    *[Symbol.iterator](): IterableIterator<U> {
      for (const item of family) yield project(item);
    },
  };
}

/**
 * The part of a family a projection keeps.
 *
 * How many that is cannot be known without reading it, so this is an iterable
 * rather than a family: the writer counts what it actually wrote, which is a
 * better number than a predicted one anyway.
 */
export function* selectFrom<T, U>(
  source: Iterable<T>,
  select: (item: T) => U | null,
): IterableIterator<U> {
  for (const item of source) {
    const projected = select(item);
    if (projected !== null) yield projected;
  }
}
