import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { compareCodeUnits } from '../util/json.js';
import { sha256Hex } from '../util/hash.js';
import type {
  ScratchFamilyDeclaration,
  ScratchFamilyUsage,
  ScratchSortRecord,
  ScratchStore,
  ScratchUsage,
  SegmentManifest,
  SegmentSpec,
  SegmentWriter,
} from './scratch-store.js';
import {
  SCRATCH_STORE_CONTRACT_VERSION,
  SEGMENT_RECORD_SEPARATOR,
  SEGMENT_RECORD_SEPARATOR_BYTES,
  scratchFailure,
  scratchQuotaExceeded,
} from './scratch-store.js';

/**
 * A scratch store backed by a real directory.
 *
 * This is the backend for the CLI, for tests and for qualification. It is not
 * the production backend and does not pretend to be: the production host injects
 * one whose storage is external to the container, because a writable container
 * filesystem is commonly memory-backed and spilling into it spends the budget
 * the spill exists to protect.
 *
 * What it does hold, and what the conformance suite checks of any backend:
 * every path stays inside the root it was given, a segment becomes visible only
 * when it is complete, and disposal removes what the run wrote.
 */

const WRITE_BUFFER_BYTES = 1 << 16;
const READ_BUFFER_BYTES = 1 << 16;
const LF = 0x0a;

export interface FilesystemScratchOptions {
  /** Directory the host owns and permits this run to write inside. */
  readonly root: string;
  /**
   * Names the run's subdirectory. Derived from the run rather than from a clock
   * or a counter, so a rerun of the same work reuses the same name and nothing a
   * segment holds depends on when it was written.
   */
  readonly runId: string;
  readonly quotaBytes: number;
}

interface LiveSegment {
  readonly manifest: SegmentManifest;
  readonly path: string;
}

/** The mutable form of ScratchFamilyUsage, kept per schema while the run is alive. */
interface FamilyCounters {
  bytesWritten: number;
  peakBytes: number;
  liveBytes: number;
  released: number;
  segmentsSealed: number;
  linesWritten: number;
  framingBytes: number;
  bytesWrittenByPass: number[];
  bytesWrittenUnattributed: number;
  declaration: ScratchFamilyDeclaration;
  openedAt: number;
  closedAt: number | null;
  sorts: ScratchSortRecord[];
}

/**
 * What one call to `account` is attributing, when it is attributing a write.
 *
 * Null for a release, because giving bytes back is not a write and must not
 * raise a written total. `pass` is null when nothing declared which write of an
 * external sort produced the segment, which the store records as unattributed
 * rather than guessing.
 *
 * `payloadBytes` is what the caller's own line weighed, measured before the
 * store added anything to it. It is here so that framing can be the difference
 * between what went on the device and what the caller asked for, rather than the
 * line count multiplied by the separator width.
 *
 * That distinction is the whole reason this field exists, and it was found by
 * being refuted: framing used to be `lines * SEGMENT_RECORD_SEPARATOR_BYTES`,
 * counted on the line below `linesWritten += lines`, and the scratch model then
 * checked `framingBytes === linesWritten * framingBytesPerLine`. Two counters
 * moved from one number on adjacent lines cannot disagree, so the check could
 * only ever fail on a record somebody had edited by hand. Measured as a
 * difference it can disagree: a second separator, a separator that stops being
 * one byte, or a caller appending a line that already ends in one all show up
 * here and nowhere else.
 */
interface WriteAttribution {
  readonly pass: number | null;
  readonly lines: number;
  /** The encoded length of the caller's line, before the store's separator. */
  readonly payloadBytes: number;
}

export function createFilesystemScratchStore(options: FilesystemScratchOptions): ScratchStore {
  if (!isAbsolute(options.root)) {
    scratchFailure(
      'the scratch root must be an absolute path',
      'Pass the directory the host has allocated for this run, resolved to an absolute path.',
      { root: options.root },
    );
  }
  if (!Number.isSafeInteger(options.quotaBytes) || options.quotaBytes <= 0) {
    scratchFailure(
      'the scratch quota must be a positive whole number of bytes',
      'Take the quota from the resource profile. Scratch capacity is a byte count, never a rounded display value.',
      { quotaBytes: options.quotaBytes },
    );
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(options.runId)) {
    scratchFailure(
      'the run id names a directory, so it must be a short plain identifier',
      'Derive the run id from the run itself. It is never taken from customer data, because customer data must not decide a path.',
      { runId: options.runId },
    );
  }

  mkdirSync(options.root, { recursive: true });
  // The real root, resolved through any symlink the host put in the way, is what
  // containment is judged against. Comparing against the string handed in would
  // let a link inside it point anywhere.
  const root = realpathSync(options.root);
  const runRoot = join(root, `kauro-scratch-${options.runId}`);
  mkdirSync(runRoot, { recursive: true });

  const segments = new Map<string, LiveSegment>();
  const openWriters = new Set<string>();
  let bytes = 0;
  let peakBytes = 0;
  let bytesWritten = 0;
  const families = new Map<string, FamilyCounters>();
  let disposed = false;
  let counter = 0;

  /**
   * A store event ordinal, and deliberately not a clock.
   *
   * A family's start and end of life have to be recorded, and the obvious way is
   * a timestamp. A timestamp would make two runs of identical work produce
   * different evidence, and evidence that differs between identical runs cannot
   * be compared across run sizes — which is the one thing the scratch model is
   * for. So life is recorded in the order things happened, which is the same in
   * every run of the same work.
   *
   * It advances on exactly the two events it records — a family first seen, and
   * a family that once held bytes stopping holding any — so the value is the
   * position of that event among all of them rather than a count of something
   * else that happens to be monotone.
   */
  let ordinal = 0;
  const nextOrdinal = (): number => {
    ordinal += 1;
    return ordinal;
  };

  const familyOf = (schema: string): FamilyCounters => {
    let found = families.get(schema);
    if (found === undefined) {
      found = {
        bytesWritten: 0,
        peakBytes: 0,
        liveBytes: 0,
        released: 0,
        segmentsSealed: 0,
        linesWritten: 0,
        framingBytes: 0,
        bytesWrittenByPass: [],
        bytesWrittenUnattributed: 0,
        declaration: { purpose: null, producer: null, consumer: null },
        openedAt: nextOrdinal(),
        closedAt: null,
        sorts: [],
      };
      families.set(schema, found);
    }
    return found;
  };

  const contain = (path: string): string => {
    const resolved = resolve(path);
    if (resolved !== runRoot && !resolved.startsWith(runRoot + sep)) {
      scratchFailure(
        'a scratch path resolved outside the root the host allocated',
        'This is an engine defect. No path the store builds may leave its root, whatever it is derived from.',
        { path: resolved, root: runRoot },
      );
    }
    return resolved;
  };

  const requireOpen = (): void => {
    if (disposed) {
      scratchFailure(
        'the scratch store has been disposed and cannot be used again',
        'A disposed store is gone by design. Create a new one for a new run.',
        {},
      );
    }
  };

  /**
   * The one place a byte enters or leaves the accounting, for the run as a whole
   * and for the family it belongs to at the same time.
   *
   * Every counter moves here, on purpose. The obvious alternative — leave this
   * function counting the total and add the per-family arithmetic at each of the
   * three sites that move bytes — was rejected because a family total that is
   * maintained somewhere other than the running total will eventually disagree
   * with it, and a disagreement in a number nobody can independently check is
   * worse than not having the number. Deletion in particular used to subtract
   * from `bytes` directly rather than come through here, which is exactly the
   * shape of the bug: one path adjusting one counter.
   *
   * A positive delta is a write and raises `bytesWritten`; a negative one is a
   * release and does not lower it, because the bytes were written and the device
   * did the work whatever happened to them afterwards.
   *
   * The per-pass split, the line count and the framing arrived here for the same
   * reason the per-family split did. A model of the external sort has to compare
   * what run generation wrote against what each merge pass wrote, and a split
   * maintained anywhere but on this line would eventually stop adding up to the
   * total it is a split of. It is the same defect as the old deletion path
   * adjusting `bytes` on its own, one level down.
   */
  const account = (delta: number, schema: string, write: WriteAttribution | null): void => {
    const family = familyOf(schema);
    bytes += delta;
    family.liveBytes += delta;
    if (delta > 0) {
      bytesWritten += delta;
      family.bytesWritten += delta;
      if (write === null) {
        family.bytesWrittenUnattributed += delta;
      } else {
        if (write.pass === null) {
          family.bytesWrittenUnattributed += delta;
        } else {
          while (family.bytesWrittenByPass.length <= write.pass) family.bytesWrittenByPass.push(0);
          family.bytesWrittenByPass[write.pass] = (family.bytesWrittenByPass[write.pass] ?? 0) + delta;
        }
        family.linesWritten += write.lines;
        // Measured, not restated. `delta` is what went on the device and
        // `write.payloadBytes` is what the caller handed over, so the difference
        // is exactly the envelope the store put round it. Deriving it from
        // `write.lines` instead would make the model's framing check an identity
        // between two numbers moved from one value on adjacent lines — see
        // WriteAttribution above for why that was refuted.
        family.framingBytes += delta - write.payloadBytes;
      }
    }
    if (bytes > peakBytes) peakBytes = bytes;
    if (family.liveBytes > family.peakBytes) family.peakBytes = family.liveBytes;
    // End of life, recorded when the family stops holding anything it once held.
    // Reopened rather than kept if it takes another byte: a family that is
    // written again was not finished, and saying it was would be a false claim
    // about the one thing this field is for.
    if (family.liveBytes === 0 && family.peakBytes > 0) {
      if (family.closedAt === null) family.closedAt = nextOrdinal();
    } else if (family.liveBytes > 0) {
      family.closedAt = null;
    }
    if (bytes > options.quotaBytes) {
      scratchQuotaExceeded(
        `scratch would hold ${String(bytes)} bytes, and the quota for this run is ${String(options.quotaBytes)} bytes`,
        { bytes, quotaBytes: options.quotaBytes },
      );
    }
  };

  const createSegment = (spec: SegmentSpec): SegmentWriter => {
    requireOpen();
    if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(spec.schema)) {
      scratchFailure(
        'a segment schema names a file, so it must be a short plain identifier',
        'Name the schema after what the lines mean, in the engine vocabulary. It is never derived from customer data.',
        { schema: spec.schema },
      );
    }
    if (spec.pass !== undefined && (!Number.isSafeInteger(spec.pass) || spec.pass < 0)) {
      scratchFailure(
        'a segment pass is which write of an external sort produced it, so it must be a whole non-negative number',
        'Pass 0 for run generation and p for the p-th merge pass, or leave it off entirely for a segment no external sort wrote.',
        { schema: spec.schema, pass: String(spec.pass) },
      );
    }
    const pass = spec.pass ?? null;
    counter += 1;
    // Deterministic, and unique inside the run without consulting a clock: the
    // same work in the same order produces the same names, which is what makes a
    // rerun byte-comparable.
    const segmentId = `${spec.schema}-${String(counter).padStart(6, '0')}`;
    if (segments.has(segmentId) || openWriters.has(segmentId)) {
      scratchFailure('a scratch segment id was reused', 'This is an engine defect.', { segmentId });
    }

    const finalPath = contain(join(runRoot, `${segmentId}.seg`));
    const stagingPath = contain(join(runRoot, `${segmentId}.part`));
    const handle = openSync(stagingPath, 'wx');
    openWriters.add(segmentId);

    const hash = createHash('sha256');
    let buffer = Buffer.allocUnsafe(WRITE_BUFFER_BYTES);
    let pending = 0;
    let byteLength = 0;
    let rowCount = 0;
    let firstKey: string | null = null;
    let lastKey: string | null = null;
    let closed = false;

    const flush = (): void => {
      if (pending === 0) return;
      const slice = buffer.subarray(0, pending);
      let written = 0;
      while (written < slice.length) {
        // A short write is a real condition on a full or failing device, and
        // treating one as complete is how a spill loses its tail silently.
        const n = writeSync(handle, slice, written, slice.length - written);
        if (n <= 0) {
          scratchFailure(
            'a scratch write made no progress',
            'The scratch device is full or failing. The run was stopped rather than continued against an incomplete spill.',
            { segmentId },
          );
        }
        written += n;
      }
      pending = 0;
    };

    // `lines` is passed rather than assumed to be one. It is one at the only
    // call site, and writing that down here is what stops a second call site
    // being added later that moves bytes without moving the line count.
    //
    // `payloadBytes` travels with it for the same reason and one more: it is the
    // caller's line measured on its own, so the accounting can subtract it from
    // what actually went on the device and get the framing rather than assume
    // it.
    const push = (chunk: Buffer, lines: number, payloadBytes: number): void => {
      hash.update(chunk);
      byteLength += chunk.length;
      account(chunk.length, spec.schema, { pass, lines, payloadBytes });
      if (chunk.length >= WRITE_BUFFER_BYTES) {
        flush();
        let written = 0;
        while (written < chunk.length) {
          const n = writeSync(handle, chunk, written, chunk.length - written);
          if (n <= 0) {
            scratchFailure('a scratch write made no progress', 'The scratch device is full or failing.', { segmentId });
          }
          written += n;
        }
        return;
      }
      if (pending + chunk.length > buffer.length) flush();
      chunk.copy(buffer, pending);
      pending += chunk.length;
    };

    const abort = (): void => {
      if (closed) return;
      closed = true;
      openWriters.delete(segmentId);
      // An aborted segment gives its live bytes back but is not a release: it
      // was never sealed, so it never was one of this family's segments. What it
      // wrote stays in bytesWritten, because it was written.
      account(-byteLength, spec.schema, null);
      try {
        closeSync(handle);
      } catch {
        // Already closed; removing the staging file is what matters.
      }
      rmSync(stagingPath, { force: true });
    };

    return {
      segmentId,
      append(line: string, key?: string): void {
        if (closed) {
          scratchFailure('a sealed scratch segment cannot be appended to', 'This is an engine defect.', { segmentId });
        }
        if (line.includes('\n')) {
          scratchFailure(
            'a scratch line may not contain a line feed',
            'The store owns the record separator. Encode the value so it cannot introduce one.',
            { segmentId },
          );
        }
        if (spec.sorted === true) {
          if (key === undefined) {
            scratchFailure(
              'a sorted scratch segment needs a key on every line',
              'This is an engine defect: a segment declared sorted has to say what it is sorted by.',
              { segmentId },
            );
          }
          if (lastKey !== null && compareCodeUnits(key, lastKey) < 0) {
            scratchFailure(
              'a sorted scratch segment was appended to out of order',
              'This is an engine defect. A merge that believes an unsorted segment is sorted produces plausible output in the wrong order.',
              { segmentId, key, previousKey: lastKey },
            );
          }
        }
        if (key !== undefined) {
          if (firstKey === null) firstKey = key;
          lastKey = key;
        }
        // Two encodings of the same string, and the second one is paid for
        // deliberately. `Buffer.byteLength` allocates nothing; it walks the
        // string and returns a count. What it buys is a framing figure that was
        // measured rather than multiplied out of the line count, which is the
        // only version of that figure a model can check against anything.
        push(Buffer.from(`${line}${SEGMENT_RECORD_SEPARATOR}`, 'utf8'), 1, Buffer.byteLength(line, 'utf8'));
        rowCount += 1;
      },
      seal(): SegmentManifest {
        if (closed) {
          scratchFailure('a scratch segment cannot be sealed twice', 'This is an engine defect.', { segmentId });
        }
        flush();
        closeSync(handle);
        closed = true;
        openWriters.delete(segmentId);
        // Visible only once complete: a reader can never observe a partial
        // segment, because the name it looks for does not exist until the last
        // byte is on the device.
        renameSync(stagingPath, finalPath);
        const manifest: SegmentManifest = {
          segmentId,
          schema: spec.schema,
          schemaVersion: spec.schemaVersion,
          sha256: hash.digest('hex'),
          byteLength,
          rowCount,
          firstKey,
          lastKey,
          sorted: spec.sorted === true,
        };
        segments.set(segmentId, { manifest, path: finalPath });
        // The live count is not kept here, and that is the fix for a check that
        // could not fail.
        //
        // There used to be a `counters.segments += 1` on this line and a
        // `counters.segmentsSealed += 1` on the next, with a comment claiming
        // the second was "kept independently ... so it can disagree". It could
        // not: `delete` moved `segments` down and `released` up on two adjacent
        // lines as well, so `segments + released === segmentsSealed` was one
        // number written three ways. The scratch model checked exactly that, and
        // an adversarial pass proved the check unreachable.
        //
        // What survives here is the cumulative counter alone. The live count is
        // now read off `segments`, the map that actually decides what a reader
        // can open — see `usage()`. That makes the model's lifecycle check a
        // comparison between the store's segment table and two counters kept
        // apart from it: a segment dropped from the table without being counted
        // as released, or sealed into the table without being counted as sealed,
        // now shows up. Both are things a future edit can do; neither was
        // reachable before.
        familyOf(spec.schema).segmentsSealed += 1;
        buffer = Buffer.alloc(0);
        return manifest;
      },
      abort,
    };
  };

  const requireSegment = (segmentId: string): LiveSegment => {
    requireOpen();
    const found = segments.get(segmentId);
    if (found === undefined) {
      scratchFailure(
        `scratch segment ${segmentId} is not present`,
        'A segment the run wrote has gone missing. The run was stopped rather than continued against an incomplete spill.',
        { segmentId },
      );
    }
    return found;
  };

  return {
    contractVersion: SCRATCH_STORE_CONTRACT_VERSION,
    createSegment,

    *readLines(segmentId: string): IterableIterator<string> {
      const segment = requireSegment(segmentId);
      // A symlink that appeared where a segment was written is not a segment.
      const stat = lstatSync(segment.path);
      if (!stat.isFile()) {
        scratchFailure(
          `scratch segment ${segmentId} is not a regular file`,
          'Something replaced a sealed segment. The run was stopped rather than continued against it.',
          { segmentId },
        );
      }

      const handle = openSync(segment.path, 'r');
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
      let carry = Buffer.alloc(0);
      let seen = 0;
      let lines = 0;
      try {
        for (;;) {
          const read = readSync(handle, buffer, 0, buffer.length, null);
          if (read === 0) break;
          const chunk = buffer.subarray(0, read);
          hash.update(chunk);
          seen += read;
          let start = 0;
          let combined = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
          carry = Buffer.alloc(0);
          for (;;) {
            const index = combined.indexOf(LF, start);
            if (index === -1) {
              carry = Buffer.from(combined.subarray(start));
              break;
            }
            lines += 1;
            yield combined.subarray(start, index).toString('utf8');
            start = index + 1;
          }
          combined = Buffer.alloc(0);
        }
        if (carry.length > 0) {
          scratchFailure(
            `scratch segment ${segmentId} ends without a record separator`,
            'The segment is truncated. The run was stopped rather than continued against a partial spill.',
            { segmentId },
          );
        }
        // Proved on the way out, not asserted: the bytes read back are the bytes
        // written, and there are as many records as the manifest says.
        const digest = hash.digest('hex');
        if (digest !== segment.manifest.sha256 || seen !== segment.manifest.byteLength) {
          scratchFailure(
            `scratch segment ${segmentId} does not match the manifest it was sealed with`,
            'The spilled bytes changed after they were written. The run was stopped rather than trusted.',
            { segmentId, expected: segment.manifest.sha256, actual: digest },
          );
        }
        if (lines !== segment.manifest.rowCount) {
          scratchFailure(
            `scratch segment ${segmentId} holds ${String(lines)} records and was sealed with ${String(segment.manifest.rowCount)}`,
            'The spilled records changed after they were written. The run was stopped rather than trusted.',
            { segmentId, expected: segment.manifest.rowCount, actual: lines },
          );
        }
      } finally {
        closeSync(handle);
      }
    },

    manifest(segmentId: string): SegmentManifest {
      return requireSegment(segmentId).manifest;
    },

    list(): readonly SegmentManifest[] {
      requireOpen();
      return [...segments.values()]
        .map((segment) => segment.manifest)
        .sort((a, b) => compareCodeUnits(a.segmentId, b.segmentId));
    },

    delete(segmentId: string): void {
      const segment = requireSegment(segmentId);
      segments.delete(segmentId);
      account(-segment.manifest.byteLength, segment.manifest.schema, null);
      // Only the cumulative side. What the family still holds is the segment
      // table above, which this call has already changed.
      familyOf(segment.manifest.schema).released += 1;
      try {
        unlinkSync(segment.path);
      } catch (error) {
        scratchFailure(
          `scratch segment ${segmentId} could not be removed`,
          'Scratch holds customer data and a failure to remove it is reportable, not something to pass over.',
          { segmentId, detail: String(error) },
        );
      }
    },

    declareFamily(family: string, declaration: ScratchFamilyDeclaration): void {
      requireOpen();
      // Creating the counters here rather than waiting for the first byte is
      // deliberate: a family that was opened and wrote nothing is a fact about
      // the run, and one that never appears in the report cannot be told apart
      // from one that was never opened at all.
      familyOf(family).declaration = {
        purpose: declaration.purpose,
        producer: declaration.producer,
        consumer: declaration.consumer,
      };
    },

    recordSort(family: string, sort: ScratchSortRecord): void {
      requireOpen();
      // Copied rather than referenced. The sorter holds the arrays it built and
      // is entitled to keep using them; a usage record that changed underneath
      // its reader would be the same class of defect as a live view of the
      // counters, which `usage` already refuses to hand out.
      familyOf(family).sorts.push({
        records: sort.records,
        payloadBytes: sort.payloadBytes,
        keyBytes: sort.keyBytes,
        runSize: sort.runSize,
        fanIn: sort.fanIn,
        initialRuns: sort.initialRuns,
        mergePasses: sort.mergePasses,
        initialRunBytes: [...sort.initialRunBytes],
        initialRunRecords: [...sort.initialRunRecords],
        format: {
          keyTerminatorBytes: sort.format.keyTerminatorBytes,
          sequenceBytes: sort.format.sequenceBytes,
          keySeparatorBytes: sort.format.keySeparatorBytes,
        },
        resultSegmentId: sort.resultSegmentId,
        resultBytes: sort.resultBytes,
        resultRows: sort.resultRows,
        resultDigest: sort.resultDigest,
      });
    },

    usage(): ScratchUsage {
      // Ordered by family name in code-unit order, the same comparison the rest
      // of the engine orders strings by, so that two runs of the same work
      // produce the same report whatever order the families happened to be
      // written in. A snapshot rather than a view: the counters keep moving and
      // a caller holding a usage record is entitled to a number that does not.
      // The live segment count, read off the segment table rather than off a
      // counter that moved next to `released`. Iterating the table costs one
      // pass over the segments that are still present — tens, not millions,
      // because the sort deletes each run as it is spent — and it is what makes
      // `segments + released === segmentsSealed` a statement about two different
      // records of the same events instead of an identity.
      const liveByFamily = new Map<string, number>();
      for (const segment of segments.values()) {
        const schema = segment.manifest.schema;
        liveByFamily.set(schema, (liveByFamily.get(schema) ?? 0) + 1);
      }
      const byFamily: ScratchFamilyUsage[] = [...families.entries()]
        .sort((a, b) => compareCodeUnits(a[0], b[0]))
        .map(([family, counters]) => ({
          family,
          bytesWritten: counters.bytesWritten,
          peakBytes: counters.peakBytes,
          liveBytes: counters.liveBytes,
          segments: liveByFamily.get(family) ?? 0,
          released: counters.released,
          declaration: counters.declaration,
          segmentsSealed: counters.segmentsSealed,
          linesWritten: counters.linesWritten,
          framingBytes: counters.framingBytes,
          bytesWrittenByPass: [...counters.bytesWrittenByPass],
          bytesWrittenUnattributed: counters.bytesWrittenUnattributed,
          openedAt: counters.openedAt,
          closedAt: counters.closedAt,
          sorts: counters.sorts.map((sort) => ({
            ...sort,
            initialRunBytes: [...sort.initialRunBytes],
            initialRunRecords: [...sort.initialRunRecords],
          })),
        }));
      return {
        bytes,
        peakBytes,
        quotaBytes: options.quotaBytes,
        segmentCount: segments.size,
        bytesWritten,
        byFamily,
        framingBytesPerLine: SEGMENT_RECORD_SEPARATOR_BYTES,
      };
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      segments.clear();
      bytes = 0;
      // The new counters are cleared the way `bytes` is, and `peakBytes` is left
      // alone the way it always was. A disposed store holds nothing and wrote
      // nothing that still exists, so the live and cumulative figures go to
      // zero and the breakdown goes empty. The high-water mark is the one thing
      // that survives disposal, because it is what evidence reports about a run
      // that has already finished and cleaned up after itself.
      //
      // The declarations and the sort records go with the breakdown, and that is
      // the reason a caller wanting the scratch model has to read `usage()`
      // before disposing: the model is a statement about work that happened, and
      // a disposed store is one that is no longer willing to describe it.
      // tools/capacity.mjs reads usage while the store is still open, on purpose.
      bytesWritten = 0;
      families.clear();
      try {
        rmSync(runRoot, { recursive: true, force: true });
      } catch (error) {
        // Reported rather than swallowed: scratch holds customer data, and a
        // host that cannot delete it has to hear about it.
        throw new Error(
          `scratch could not be removed at ${runRoot}: ${String(error)}. It holds customer data and must be deleted.`,
        );
      }
      if (existsSync(runRoot)) {
        throw new Error(`scratch still exists at ${runRoot} after disposal. It holds customer data and must be deleted.`);
      }
    },
  };
}

/** The run-scoped directory name a store would use, so a host can plan for it. */
export function scratchDirectoryName(runId: string): string {
  return `kauro-scratch-${runId}`;
}

/** Stable identity for a scratch layout, used where evidence records what was configured. */
export function scratchLayoutDigest(root: string, runId: string): string {
  return sha256Hex(`${SCRATCH_STORE_CONTRACT_VERSION}\n${root}\n${runId}`);
}

