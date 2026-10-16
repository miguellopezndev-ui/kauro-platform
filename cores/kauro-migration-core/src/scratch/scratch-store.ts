import { MigrationError } from '../domain/errors.js';

/**
 * Scratch: where a run puts the facts it has finished looking at.
 *
 * The engine's memory contract is to observe a unit of work, write down what it
 * needs in a compact durable form, release the row-scale object, and sort or
 * join the notes later. This is where the notes go, and it is deliberately not a
 * filesystem, a bucket or a database: it is the smallest interface that lets the
 * core be bounded without the core choosing where the bytes live.
 *
 * The host injects a backend. Migration Core never opens a socket, never reaches
 * for a cloud SDK and never assumes `/tmp` — on a memory-backed container
 * filesystem, spilling to `/tmp` consumes the very budget the spill exists to
 * protect, so a store that looks like a disk and is not one would make the
 * measurements lie.
 *
 * The properties a backend must hold, and which the conformance suite checks:
 *
 *   run-scoped        nothing outlives the run that created it
 *   single-writer     one open writer per segment, and no reader sees a partial
 *   immutable         a sealed segment never changes again
 *   sequential        append and stream; no random writes are promised
 *   self-describing   every segment carries schema, hash, length, count, range
 *   bounded           a quota that fails the run rather than the machine
 *   fail-closed       a short write, a hash mismatch or a lost segment is fatal
 *   no retention      disposal removes the bytes, and says so if it cannot
 *
 * Deterministic content is part of the contract: nothing a segment holds may
 * depend on the wall clock, the temporary name it was given or the order the
 * host happened to schedule work in.
 */

/**
 * The version stays at 1.0.0 across the addition of `bytesWritten` and
 * `byFamily` to `ScratchUsage`, and that is a decision rather than an oversight.
 *
 * What this version names is the behaviour a backend must hold and a caller may
 * rely on: the segment lifecycle, the manifest a sealed segment carries, and the
 * properties listed above. None of that moved. The new fields are additions to
 * what the store reports about itself on a record the caller only ever reads;
 * every field that was already there means exactly what it meant, and nothing
 * written against 1.0.0 stops compiling or stops being true.
 *
 * The honest cost, stated rather than glossed: a backend implemented outside
 * this tree would have to return the new fields, and by that reading this is a
 * minor version. It stays at 1.0.0 anyway for two reasons. There is one backend,
 * and it is in this tree — see filesystem-scratch-store.ts — so no out-of-tree
 * implementer exists to be broken. And tools/architecture-gate.mjs asserts this
 * constant equals '1.0.0' exactly, so a bump is a gate failure that says nothing
 * true about the change. When a second backend ships from somewhere else, the
 * gate and this constant move together, deliberately, not as a side effect of a
 * new counter.
 *
 * The same reasoning carries the per-pass accounting, `declareFamily` and
 * `recordSort` added below. Those two are new *methods*, which is a larger claim
 * on an implementer than a new field, and the argument for holding the version
 * is unchanged only because the population of implementers is unchanged: one, in
 * this tree. The behaviour a segment has does not move. What moves is how much
 * the store is willing to say about work it was already doing.
 */
export const SCRATCH_STORE_CONTRACT_VERSION = '1.0.0';

/**
 * The record separator the store owns, and what it costs.
 *
 * `append` writes the line and then this, so every line a family ever wrote
 * carries exactly this much framing that the caller did not ask for and cannot
 * see. It is stated once, here, because the scratch model recomputes a family's
 * traffic from the format and has to take the format from the format rather
 * than from a number somebody typed into the model.
 */
export const SEGMENT_RECORD_SEPARATOR = '\n';
/** Derived from the separator rather than asserted about it, so the two cannot drift apart. */
export const SEGMENT_RECORD_SEPARATOR_BYTES = Buffer.byteLength(SEGMENT_RECORD_SEPARATOR, 'utf8');

/**
 * What a sealed segment is, stated by the store rather than by its writer.
 *
 * The hash and the byte length are computed from the bytes as they were
 * written, and a backend is required to reproduce them on read-back. That is the
 * whole basis for trusting a spill: the run can prove that what it gets back is
 * what it put in, without keeping what it put in.
 */
export interface SegmentManifest {
  readonly segmentId: string;
  /** What the lines mean. Two segments of different schemas never merge. */
  readonly schema: string;
  readonly schemaVersion: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly rowCount: number;
  /** Declared when the segment is sorted, so a merge can be planned without reading it. */
  readonly firstKey: string | null;
  readonly lastKey: string | null;
  readonly sorted: boolean;
}

export interface SegmentSpec {
  readonly schema: string;
  readonly schemaVersion: string;
  /**
   * When true, appended keys must not decrease. The store enforces it rather
   * than trusting the caller, because a merge that believes an unsorted segment
   * is sorted produces plausible output in the wrong order.
   */
  readonly sorted?: boolean;
  /**
   * Which write of the family's external sort this segment belongs to: 0 for a
   * run generated before any merging, and p for the p-th merge pass.
   *
   * It exists so the store can split the running total by pass on the same code
   * path that moves the total, rather than have something outside try to
   * reconstruct afterwards which bytes were run generation and which were the
   * fourth merge. That reconstruction is exactly what the scratch model is for,
   * and a model checked against a number derived the same way it was would be
   * checking itself.
   *
   * Absent means no external sort wrote this segment. The store records those
   * bytes as unattributed rather than folding them into pass 0, because the
   * model cannot explain traffic no algorithm has claimed, and quietly
   * attributing it to run generation would make unexplained bytes look
   * explained. In this tree the only segments written outside the external sort
   * are written by tests.
   */
  readonly pass?: number;
}

export interface SegmentWriter {
  readonly segmentId: string;
  /**
   * Appends one line. The line may not contain a line feed: the store owns the
   * record separator, so a value that could introduce one is a defect in the
   * encoder rather than something to escape here.
   */
  append(line: string, key?: string): void;
  /** Makes the segment immutable and readable. Returns what the store will say about it. */
  seal(): SegmentManifest;
  /** Discards a segment that was never sealed. Safe to call twice. */
  abort(): void;
}

/**
 * What one family of segments cost the run.
 *
 * A family is a segment's schema name — the store already requires one, and
 * already refuses anything that is not a short plain identifier, so it is the
 * only grouping available that a caller cannot make up on the way past.
 *
 * The reason this exists is that a total does not explain itself. A measured
 * 1,000,000-row CLEAN_ONLY run over a 68,681,517-byte source left 28,424,950,857
 * bytes of scratch alive, an amplification of 414x, where MC-1's ledger had
 * recorded roughly fifty times. Neither figure could be argued with while the
 * only thing counted was the sum: nobody could say which family the 414x lived
 * in, and so nobody could say whether it was a defect, a different workload, or
 * the earlier number having been wrong. Per family, that question has an answer.
 */
export interface ScratchFamilyUsage {
  /** The segment schema these numbers are about. */
  readonly family: string;
  /** Every byte this family ever wrote, including bytes since released. */
  readonly bytesWritten: number;
  /** The high-water mark of this family's live bytes, on its own. */
  readonly peakBytes: number;
  /** Bytes this family holds right now, across its sealed and open segments. */
  readonly liveBytes: number;
  /** Sealed segments of this family that are still present. */
  readonly segments: number;
  /** Sealed segments of this family that have since been deleted. */
  readonly released: number;
  /** What the family is for, as its producer declared it. */
  readonly declaration: ScratchFamilyDeclaration;
  /**
   * Sealed segments over the family's whole life, whether or not they survive.
   *
   * `segments + released` is the same number today, and that is the point: it is
   * kept independently at the one place a segment is sealed, so a disagreement
   * between the two is a defect the model reports rather than an arithmetic
   * identity nobody can fail.
   */
  readonly segmentsSealed: number;
  /** Lines appended across every segment this family ever wrote. */
  readonly linesWritten: number;
  /**
   * The store's own framing: one record separator per line, and nothing else.
   *
   * Counted apart from payload because a family of very short records pays
   * proportionally far more for framing than a family of long ones, and a model
   * that cannot separate the two cannot say whether traffic is the records or
   * the envelope around them.
   */
  readonly framingBytes: number;
  /**
   * Bytes written per write of the external sort: index 0 is run generation,
   * index p is the p-th merge pass.
   *
   * Split here rather than totalled because the number of merge passes changes
   * with the number of runs, which is the whole reason a ratio against source
   * bytes cannot bound this. A pass is a thing the algorithm either had to do or
   * did not, and that is answerable; "sixty times the input" is not.
   */
  readonly bytesWrittenByPass: readonly number[];
  /** Bytes written by a segment that named no pass, and which therefore no model explains. */
  readonly bytesWrittenUnattributed: number;
  /**
   * When the family first took a byte and when it last held none, as store event
   * ordinals rather than as times.
   *
   * An ordinal, deliberately. A clock would make two runs of the same work
   * produce different evidence, and evidence that differs between identical runs
   * cannot be compared across run sizes — which is the property this whole
   * measurement exists to defend. `closedAt` is null while the family still
   * holds bytes.
   */
  readonly openedAt: number | null;
  readonly closedAt: number | null;
  /**
   * One entry per external sort that ran in this family, in the order they
   * finished.
   *
   * A list rather than a single record because a schema may be sorted more than
   * once in a run — a family opened once per source file, or a verifier
   * re-spilling a projection — and collapsing those into one would make the
   * pass arithmetic unrecomputable.
   */
  readonly sorts: readonly ScratchSortRecord[];
}

/**
 * What a family is for, in the words of whoever opened it.
 *
 * Every field is nullable and every field starts null. That is not a
 * placeholder: most of the engine's twenty-odd families are opened in files this
 * change does not own, so they report null until their producers declare them,
 * and the model says "undeclared" rather than inventing a purpose. A null here
 * is a gap in the record, and it reads as one.
 */
export interface ScratchFamilyDeclaration {
  /** What the family holds and why the run needs it written down. */
  readonly purpose: string | null;
  /** The stage that writes it. */
  readonly producer: string | null;
  /** The stage that reads it last, and after which it may be released. */
  readonly consumer: string | null;
}

/**
 * The framing the external sort adds around each record, in bytes.
 *
 * Reported by the sort from its own constants rather than restated by whatever
 * reads it. A model that carried its own copy of the sequence width would agree
 * with the sort right up until somebody changed the width, which is the moment
 * it needs to disagree.
 */
export interface ScratchSortFormat {
  /** The separator between a key and its tie-break. */
  readonly keyTerminatorBytes: number;
  /** The fixed-width input position that makes the order total. */
  readonly sequenceBytes: number;
  /** The separator between the composed sort key and the record it orders. */
  readonly keySeparatorBytes: number;
}

/**
 * One external sort, described by the algorithm that performed it.
 *
 * These are the quantities a model needs to recompute what the sort must have
 * written: how many records went in, how much they weighed before anything was
 * added to them, how big each spilled run turned out, and how wide the merge
 * was. Given those and the framing, the traffic is arithmetic — not an estimate,
 * and not a ratio against anything.
 *
 * Nothing here is measured against the source file, on purpose. A ratio of
 * scratch to source is scale-variant: the same algorithm on the same data gives
 * 52.6x at two thousand rows and 154x at a million, because the merge depth
 * grows with the run count while the source does not. A bound that changes with
 * the size of the input bounds nothing.
 */
export interface ScratchSortRecord {
  /** Records pushed into the sort. */
  readonly records: number;
  /** What `encode` produced, summed, before a key or a separator was added. */
  readonly payloadBytes: number;
  /** The ordering keys as the caller returned them, before the tie-break was composed on. */
  readonly keyBytes: number;
  /** Records held before a run is spilled, as configured. */
  readonly runSize: number;
  /** Segments merged in one pass, as configured. */
  readonly fanIn: number;
  readonly initialRuns: number;
  readonly mergePasses: number;
  /** The sealed size of each initial run, in the order they were spilled. */
  readonly initialRunBytes: readonly number[];
  /** The record count of each initial run, in the same order. */
  readonly initialRunRecords: readonly number[];
  readonly format: ScratchSortFormat;
  /** The segment holding the answer, or null when there was nothing to sort. */
  readonly resultSegmentId: string | null;
  readonly resultBytes: number;
  readonly resultRows: number;
  /**
   * The digest of the answer.
   *
   * Two families whose sorts produce the same digest over the same row count
   * have materialised the same bytes twice. That is how `records`,
   * `records-after-conflicts` and `records-validated` came to be three
   * byte-identical spills of one dataset costing a quarter of everything the run
   * wrote, and it was invisible in a total.
   */
  readonly resultDigest: string | null;
}

export interface ScratchUsage {
  /** Bytes currently held by live segments, sealed and open. */
  readonly bytes: number;
  /** The high-water mark over the life of the store, which is what evidence reports. */
  readonly peakBytes: number;
  readonly quotaBytes: number;
  readonly segmentCount: number;
  /**
   * Every byte the run ever spilled, whether or not it is still held.
   *
   * This is larger than `peakBytes` whenever segments are released, which is the
   * ordinary case rather than the exception: the external sort deletes each
   * spent run as the merge consumes it, so a sort that never exceeds one
   * gigabyte of live scratch may still have written twenty. Amplification
   * against the source is a statement about this number; what the machine had to
   * hold at once is a statement about `peakBytes`. Reporting only the second one
   * is how a run comes to describe its own cost as a fiftieth of what it was.
   */
  readonly bytesWritten: number;
  /**
   * The same accounting, split by segment family, ordered by family name.
   *
   * A list rather than an object keyed by name, because object keys that look
   * like integers are enumerated first whatever order they were inserted in, and
   * a schema is allowed to be digits. A list states its order instead of leaving
   * it to be inferred from the runtime's key rules.
   */
  readonly byFamily: readonly ScratchFamilyUsage[];
  /**
   * The store's framing cost per line, so a reader of this record does not have
   * to know how the store frames anything to check its arithmetic.
   */
  readonly framingBytesPerLine: number;
}

export interface ScratchStore {
  readonly contractVersion: string;
  createSegment(spec: SegmentSpec): SegmentWriter;
  /** Streams a sealed segment. The store verifies the bytes against the manifest as it reads. */
  readLines(segmentId: string): IterableIterator<string>;
  manifest(segmentId: string): SegmentManifest;
  list(): readonly SegmentManifest[];
  delete(segmentId: string): void;
  /**
   * Says what a family is for, before or while it is written.
   *
   * Separate from `createSegment` because the answer belongs to whoever opened
   * the family — the stage that knows what it is for and who reads it last — and
   * not to the sort, which is handed a schema name and no idea what it means.
   * Calling it twice for one family replaces the declaration; the last caller to
   * say what a family is for is the one whose answer survives.
   */
  declareFamily(family: string, declaration: ScratchFamilyDeclaration): void;
  /**
   * Records one completed external sort against the family it sorted.
   *
   * This is the algorithm reporting its own parameters, not a measurement: run
   * count, fan-in, pass count and the size of every run it spilled. The store
   * measures the bytes; this says what the bytes were supposed to be. The two
   * are kept apart so that the model comparing them is comparing two things,
   * rather than restating one.
   */
  recordSort(family: string, sort: ScratchSortRecord): void;
  usage(): ScratchUsage;
  /**
   * Removes everything this run wrote. Called on success, on failure and on
   * cancellation alike; a backend that cannot complete it must say so rather
   * than leave customer data behind quietly.
   */
  dispose(): void;
}

export function scratchFailure(message: string, remedy: string, details: Record<string, string | number | boolean | null> = {}): never {
  throw new MigrationError('SCRATCH_FAILED', message, remedy, details);
}

export function scratchQuotaExceeded(
  message: string,
  details: Record<string, string | number | boolean | null> = {},
): never {
  throw new MigrationError(
    'SCRATCH_QUOTA_EXCEEDED',
    message,
    'The run needs more scratch than the resource profile allows. Raise the quota deliberately with a new versioned resource profile, or split the input. The run was stopped rather than allowed to fill the workspace.',
    details,
  );
}
