/**
 * AttemptScratchStore — the real, attempt-owned scratch of one processing attempt (design docs/design/B08-audit-approval-jobs.md
 * D8-STG-2, D8-STG-4; 04 "Resources"; 09 "Derived data and worker scratch"; S035; mandate B08-WORKER-HOST).
 *
 * It is `ScratchStore` of `@kauro/application` (`ports/core-ports.ts`), which is field for field the host-injected contract of
 * kauro-migration-core 2.0.3 (`src/scratch/scratch-store.ts`, contract version "1.0.0"), so the thin adapter of `b05/cores` hands
 * it to the core unchanged; its accounting (per family, per pass, framing measured as a difference, ordinals not clocks) follows
 * the core's own filesystem backend. What the attempt adds:
 *
 * - One private directory `<root>/kauro-attempt-scratch-<attemptId>`, named only from a canonical UUID; a segment id is a key of
 *   the store's own table and never a path; a schema names a file only as a short plain identifier. A link planted where the
 *   directory belongs is refused (OUTSIDE_CAPABILITY), and removal walks the tree itself and unlinks a link without following it.
 * - A byte quota checked before a byte reaches the device, so the counter never passes it (SCRATCH_EXHAUSTED; a full device is
 *   SCRATCH_EXHAUSTED too); a write that makes no progress or leaves the device holding fewer bytes than were written is
 *   SHORT_WRITE; a sealed segment whose file is missing, replaced, shorter or whose SHA-256 or row count no longer matches is
 *   CORRUPT_INTERMEDIATE. The three are distinct, and the first one is terminal: the store refuses everything after it, aborts
 *   every open segment (never a completed one) and still reports its usage and disposes.
 * - Spools: the FencedArtifactWriter's binary spools live in the same directory under the same quota (family
 *   `kauro-artifact-spool`), are hashed as written and verified as re-read before their last chunk leaves (D8-STG-4).
 * - `dispose` removes exactly the directory (success, failure, cancellation alike); `abandon` closes handles and leaves it, as a
 *   dying process would, for STAGING_JANITOR's `removeAttemptScratch` (D8-JAN-1).
 *
 * The device is the real file system; `device` exists to inject a fault at the write syscall (a short or failing write) and must
 * write, for real, exactly the bytes it reports.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Id, Sha256Hex } from "@kauro/contracts";
import { isUuid } from "@kauro/domain";
import type {
  ScratchFamilyDeclaration,
  ScratchFamilyUsage,
  ScratchSegmentManifest,
  ScratchSegmentSpec,
  ScratchSegmentWriter,
  ScratchSortRecord,
  ScratchStore,
  ScratchUsage,
} from "@kauro/application";
import { AttemptEnvelopeFailure, type AttemptFailureCause } from "./failure.js";

/** kauro-migration-core 2.0.3's scratch contract version, which this store implements. */
export const SCRATCH_STORE_CONTRACT_VERSION = "1.0.0";
export const ATTEMPT_SCRATCH_DIRECTORY_PREFIX = "kauro-attempt-scratch-";
/** The family the writer's spools are accounted under. */
export const ARTIFACT_SPOOL_FAMILY = "kauro-artifact-spool";

const SCHEMA = /^[A-Za-z0-9_.-]{1,64}$/;
const WRITE_BUFFER_BYTES = 1 << 16;
const READ_BUFFER_BYTES = 1 << 16;
const LF = 0x0a;
const RECORD_SEPARATOR = "\n";
const RECORD_SEPARATOR_BYTES = Buffer.byteLength(RECORD_SEPARATOR, "utf8");

/** The write syscall (default: node:fs writeSync). An injected device must write exactly the bytes it reports. */
export interface ScratchDevice {
  write(fd: number, buffer: Uint8Array, offset: number, length: number): number;
}

const REAL_DEVICE: ScratchDevice = { write: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length) };

export interface AttemptScratchOptions {
  /** An absolute directory the host owns and allots to attempts' scratch. */
  readonly root: string;
  readonly attemptId: Id;
  /** The attempt's scratch budget (ExecutionLimits.scratchBudgetBytes). */
  readonly quotaBytes: number;
  readonly device?: ScratchDevice;
}

/** A binary spool of the artifact writer: written once, sealed, streamed back in chunks verified before the last one. */
export interface ScratchSpool {
  readonly spoolId: string;
  write(chunk: Uint8Array): void;
  seal(): { readonly sha256: Sha256Hex; readonly byteLength: number };
  /** Chunks of `chunkBytes` (the last may be shorter); the bytes are verified against the seal before the final chunk yields. */
  chunks(chunkBytes: number): Generator<{ readonly bytes: Uint8Array; readonly final: boolean }>;
  discard(): void;
}

/** The directory of an attempt's scratch under `root` (pure: no file system access). */
export function attemptScratchDirectoryOf(root: string, attemptId: Id): string {
  if (!isUuid(attemptId)) throw new TypeError("an attempt id is a canonical UUID");
  return join(root, `${ATTEMPT_SCRATCH_DIRECTORY_PREFIX}${attemptId}`);
}

/** STAGING_JANITOR's cleanup of one attempt's scratch: exactly that directory, a link unlinked and never followed. */
export function removeAttemptScratch(root: string, attemptId: Id): "REMOVED" | "ABSENT" {
  if (!isAbsolute(root)) throw new TypeError("the scratch root is an absolute path");
  const directory = attemptScratchDirectoryOf(existsSync(root) ? realpathSync.native(root) : root, attemptId);
  if (lstatOrNull(directory) === null) return "ABSENT";
  removeTree(directory);
  if (lstatOrNull(directory) !== null) throw new Error(`attempt scratch ${attemptId} still exists after removal; it holds customer data`);
  return "REMOVED";
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null ? (error as { readonly code?: unknown }).code : undefined;
}

/** Removes a tree without following any link: a link or junction is unlinked itself; its target is never entered. */
function removeTree(path: string): void {
  const stat = lstatOrNull(path);
  if (stat === null) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    try {
      unlinkSync(path);
    } catch (error) {
      if (codeOf(error) !== "EPERM" && codeOf(error) !== "EISDIR") throw error;
      rmdirSync(path);
    }
    return;
  }
  for (const name of readdirSync(path)) removeTree(join(path, name));
  rmdirSync(path);
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface LiveSegment {
  readonly manifest: ScratchSegmentManifest;
  readonly path: string;
}

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

interface WriteAttribution {
  readonly pass: number | null;
  readonly lines: number;
  readonly payloadBytes: number;
}

export class AttemptScratchStore implements ScratchStore {
  readonly contractVersion = SCRATCH_STORE_CONTRACT_VERSION;
  readonly attemptId: Id;
  readonly directory: string;
  readonly quotaBytes: number;
  readonly #device: ScratchDevice;
  readonly #segments = new Map<string, LiveSegment>();
  readonly #families = new Map<string, FamilyCounters>();
  readonly #fds = new Set<number>();
  /** The abort of every open segment writer and every spool not yet discarded. */
  readonly #open = new Set<() => void>();
  #bytes = 0;
  #peakBytes = 0;
  #bytesWritten = 0;
  #counter = 0;
  #ordinal = 0;
  #failure: AttemptEnvelopeFailure | null = null;
  #closed = false;

  constructor(options: AttemptScratchOptions) {
    if (typeof options.root !== "string" || !isAbsolute(options.root)) throw new TypeError("the scratch root is an absolute path");
    if (!isUuid(options.attemptId)) throw new TypeError("an attempt id is a canonical UUID");
    if (!Number.isSafeInteger(options.quotaBytes) || options.quotaBytes < 1) throw new TypeError("the scratch quota is a positive whole number of bytes");
    this.attemptId = options.attemptId;
    this.quotaBytes = options.quotaBytes;
    this.#device = options.device ?? REAL_DEVICE;
    mkdirSync(options.root, { recursive: true });
    this.directory = attemptScratchDirectoryOf(realpathSync.native(options.root), options.attemptId);
    const existing = lstatOrNull(this.directory);
    if (existing !== null) {
      if (existing.isSymbolicLink()) throw new AttemptEnvelopeFailure("OUTSIDE_CAPABILITY", "DIRECTORY_IS_A_LINK", `the scratch of ${this.attemptId} is a link`);
      if (!existing.isDirectory()) throw new AttemptEnvelopeFailure("OUTSIDE_CAPABILITY", "DIRECTORY_REPLACED", `the scratch of ${this.attemptId} is not a directory`);
      // leftovers of this same attempt (its identity run again) are its own, and never reused as if they were sealed now
      removeTree(this.directory);
    }
    mkdirSync(this.directory);
    if (realpathSync.native(this.directory) !== this.directory) {
      throw new AttemptEnvelopeFailure("OUTSIDE_CAPABILITY", "DIRECTORY_IS_A_LINK", `the scratch of ${this.attemptId} resolves elsewhere`);
    }
  }

  /** The terminal failure, once one happened. */
  failure(): AttemptEnvelopeFailure | null {
    return this.#failure;
  }

  // --- ScratchStore -------------------------------------------------------------------------------------------------------------

  createSegment(spec: ScratchSegmentSpec): ScratchSegmentWriter {
    this.#usable();
    if (typeof spec.schema !== "string" || !SCHEMA.test(spec.schema)) throw new TypeError("a segment schema is a short plain identifier");
    if (spec.pass !== undefined && (!Number.isSafeInteger(spec.pass) || spec.pass < 0)) throw new TypeError("a segment pass is a whole non-negative number");
    const schema = spec.schema;
    const pass = spec.pass ?? null;
    const sorted = spec.sorted === true;
    this.#counter += 1;
    const segmentId = `${schema}-${String(this.#counter).padStart(6, "0")}`;
    const partPath = join(this.directory, `${segmentId}.part`);
    const finalPath = join(this.directory, `${segmentId}.seg`);
    this.#familyOf(schema);
    const fd = this.#openFile(partPath, "wx");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(WRITE_BUFFER_BYTES);
    let pending = 0;
    let byteLength = 0;
    let rowCount = 0;
    let firstKey: string | null = null;
    let lastKey: string | null = null;
    let closed = false;

    const abort = (): void => {
      if (closed) return;
      closed = true;
      this.#open.delete(abort);
      this.#closeFile(fd);
      rmIfPresent(partPath);
      if (!this.#closed) this.#account(-byteLength, schema, null);
    };
    this.#open.add(abort);
    const guarded = <T>(effect: () => T): T => {
      try {
        return effect();
      } catch (error) {
        abort();
        throw error;
      }
    };
    const flush = (): void => {
      if (pending === 0) return;
      this.#deviceWrite(fd, buffer.subarray(0, pending));
      pending = 0;
    };

    return {
      segmentId,
      append: (line: string, key?: string): void => {
        this.#usable();
        if (closed) throw new TypeError(`segment ${segmentId} is closed`);
        if (typeof line !== "string" || line.includes(RECORD_SEPARATOR)) throw new TypeError("a scratch line is a string without a line feed");
        if (sorted) {
          if (key === undefined) throw new TypeError(`sorted segment ${segmentId} needs a key on every line`);
          if (lastKey !== null && compareCodeUnits(key, lastKey) < 0) throw new TypeError(`sorted segment ${segmentId} was appended to out of order`);
        }
        const chunk = Buffer.from(`${line}${RECORD_SEPARATOR}`, "utf8");
        guarded(() => {
          this.#reserve(chunk.length);
          hash.update(chunk);
          byteLength += chunk.length;
          rowCount += 1;
          this.#account(chunk.length, schema, { pass, lines: 1, payloadBytes: Buffer.byteLength(line, "utf8") });
          if (chunk.length >= WRITE_BUFFER_BYTES) {
            flush();
            this.#deviceWrite(fd, chunk);
          } else {
            if (pending + chunk.length > buffer.length) flush();
            chunk.copy(buffer, pending);
            pending += chunk.length;
          }
        });
        if (key !== undefined) {
          if (firstKey === null) firstKey = key;
          lastKey = key;
        }
      },
      seal: (): ScratchSegmentManifest => {
        this.#usable();
        if (closed) throw new TypeError(`segment ${segmentId} is closed`);
        return guarded(() => {
          flush();
          fsyncSync(fd);
          const onDevice = fstatSync(fd).size;
          if (onDevice !== byteLength) this.#fail("SHORT_WRITE", "LENGTH_ON_DEVICE", `segment ${segmentId} holds ${onDevice} of ${byteLength} bytes`);
          this.#closeFile(fd);
          renameSync(partPath, finalPath);
          closed = true;
          this.#open.delete(abort);
          const manifest: ScratchSegmentManifest = { segmentId, schema, schemaVersion: spec.schemaVersion, sha256: hash.digest("hex"), byteLength, rowCount, firstKey, lastKey, sorted };
          this.#segments.set(segmentId, { manifest, path: finalPath });
          this.#familyOf(schema).segmentsSealed += 1;
          return manifest;
        });
      },
      abort,
    };
  }

  readLines(segmentId: string): IterableIterator<string> {
    this.#usable();
    return this.#lines(this.#require(segmentId));
  }

  manifest(segmentId: string): ScratchSegmentManifest {
    this.#usable();
    return this.#require(segmentId).manifest;
  }

  list(): readonly ScratchSegmentManifest[] {
    this.#usable();
    return [...this.#segments.values()].map((s) => s.manifest).sort((a, b) => compareCodeUnits(a.segmentId, b.segmentId));
  }

  delete(segmentId: string): void {
    this.#usable();
    const segment = this.#require(segmentId);
    this.#segments.delete(segmentId);
    this.#account(-segment.manifest.byteLength, segment.manifest.schema, null);
    this.#familyOf(segment.manifest.schema).released += 1;
    try {
      unlinkSync(segment.path);
    } catch (error) {
      this.#fail("CORRUPT_INTERMEDIATE", codeOf(error) === "ENOENT" ? "MISSING" : "NOT_REMOVED", `segment ${segmentId} could not be removed`);
    }
  }

  declareFamily(family: string, declaration: ScratchFamilyDeclaration): void {
    this.#usable();
    this.#familyOf(family).declaration = { purpose: declaration.purpose, producer: declaration.producer, consumer: declaration.consumer };
  }

  recordSort(family: string, sort: ScratchSortRecord): void {
    this.#usable();
    this.#familyOf(family).sorts.push({ ...sort, initialRunBytes: [...sort.initialRunBytes], initialRunRecords: [...sort.initialRunRecords], format: { ...sort.format } });
  }

  usage(): ScratchUsage {
    const liveByFamily = new Map<string, number>();
    for (const segment of this.#segments.values()) liveByFamily.set(segment.manifest.schema, (liveByFamily.get(segment.manifest.schema) ?? 0) + 1);
    const byFamily: ScratchFamilyUsage[] = [...this.#families.entries()]
      .sort((a, b) => compareCodeUnits(a[0], b[0]))
      .map(([family, c]) => ({
        family,
        bytesWritten: c.bytesWritten,
        peakBytes: c.peakBytes,
        liveBytes: c.liveBytes,
        segments: liveByFamily.get(family) ?? 0,
        released: c.released,
        declaration: c.declaration,
        segmentsSealed: c.segmentsSealed,
        linesWritten: c.linesWritten,
        framingBytes: c.framingBytes,
        bytesWrittenByPass: [...c.bytesWrittenByPass],
        bytesWrittenUnattributed: c.bytesWrittenUnattributed,
        openedAt: c.openedAt,
        closedAt: c.closedAt,
        sorts: c.sorts.map((s) => ({ ...s, initialRunBytes: [...s.initialRunBytes], initialRunRecords: [...s.initialRunRecords] })),
      }));
    return {
      bytes: this.#bytes,
      peakBytes: this.#peakBytes,
      quotaBytes: this.quotaBytes,
      segmentCount: this.#segments.size,
      bytesWritten: this.#bytesWritten,
      byFamily,
      framingBytesPerLine: RECORD_SEPARATOR_BYTES,
    };
  }

  /** Removes exactly the attempt's directory (on success, failure and cancellation alike); the peak survives, as evidence. */
  dispose(): void {
    if (!this.#closed) this.#release();
    this.#segments.clear();
    this.#families.clear();
    this.#bytes = 0;
    this.#bytesWritten = 0;
    removeTree(this.directory);
    if (lstatOrNull(this.directory) !== null) throw new Error(`attempt scratch ${this.attemptId} still exists after disposal; it holds customer data`);
  }

  /** What a dying process leaves: every handle closed, the directory kept for the janitor (removeAttemptScratch). */
  abandon(): void {
    this.#closed = true;
    for (const fd of [...this.#fds]) this.#closeFile(fd);
  }

  // --- the writer's spools ------------------------------------------------------------------------------------------------------

  openSpool(): ScratchSpool {
    this.#usable();
    this.#counter += 1;
    const spoolId = `spool-${String(this.#counter).padStart(6, "0")}`;
    const path = join(this.directory, `${spoolId}.spool`);
    const family = this.#familyOf(ARTIFACT_SPOOL_FAMILY);
    if (family.declaration.purpose === null) {
      family.declaration = { purpose: "artifact bytes held until a resumable session of their exact length is written", producer: "FencedArtifactWriter", consumer: "FencedArtifactWriter" };
    }
    const fd = this.#openFile(path, "wx");
    const hash = createHash("sha256");
    let byteLength = 0;
    let sealed: { readonly sha256: Sha256Hex; readonly byteLength: number } | null = null;
    let discarded = false;

    const discard = (): void => {
      if (discarded) return;
      discarded = true;
      this.#open.delete(discard);
      this.#closeFile(fd);
      rmIfPresent(path);
      if (!this.#closed) this.#account(-byteLength, ARTIFACT_SPOOL_FAMILY, null);
    };
    this.#open.add(discard);
    const guarded = <T>(effect: () => T): T => {
      try {
        return effect();
      } catch (error) {
        discard();
        throw error;
      }
    };
    const store = this;

    return {
      spoolId,
      write: (chunk: Uint8Array): void => {
        this.#usable();
        if (sealed !== null || discarded) throw new TypeError(`spool ${spoolId} is closed`);
        guarded(() => {
          this.#reserve(chunk.length);
          hash.update(chunk);
          byteLength += chunk.length;
          this.#account(chunk.length, ARTIFACT_SPOOL_FAMILY, { pass: null, lines: 0, payloadBytes: chunk.length });
          this.#deviceWrite(fd, chunk);
        });
      },
      seal: () => {
        this.#usable();
        if (sealed !== null || discarded) throw new TypeError(`spool ${spoolId} is closed`);
        return guarded(() => {
          fsyncSync(fd);
          const onDevice = fstatSync(fd).size;
          if (onDevice !== byteLength) this.#fail("SHORT_WRITE", "LENGTH_ON_DEVICE", `spool ${spoolId} holds ${onDevice} of ${byteLength} bytes`);
          this.#closeFile(fd);
          sealed = { sha256: hash.digest("hex"), byteLength };
          return sealed;
        });
      },
      chunks(chunkBytes: number): Generator<{ readonly bytes: Uint8Array; readonly final: boolean }> {
        store.#usable();
        if (sealed === null || discarded) throw new TypeError(`spool ${spoolId} is not sealed`);
        if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new TypeError("a chunk is a positive whole number of bytes");
        return store.#spoolChunks(path, sealed, chunkBytes, spoolId);
      },
      discard,
    };
  }

  // --- internals ------------------------------------------------------------------------------------------------------------------

  *#spoolChunks(path: string, sealed: { readonly sha256: Sha256Hex; readonly byteLength: number }, chunkBytes: number, spoolId: string): Generator<{ readonly bytes: Uint8Array; readonly final: boolean }> {
    const fd = this.#openVerified(path, sealed.byteLength, `spool ${spoolId}`);
    const hash = createHash("sha256");
    let offset = 0;
    try {
      while (offset < sealed.byteLength) {
        const want = Math.min(chunkBytes, sealed.byteLength - offset);
        const bytes = Buffer.allocUnsafe(want);
        let got = 0;
        while (got < want) {
          const n = readSync(fd, bytes, got, want - got, offset + got);
          if (n === 0) this.#fail("CORRUPT_INTERMEDIATE", "LENGTH", `spool ${spoolId} ended at ${offset + got} of ${sealed.byteLength} bytes`);
          got += n;
        }
        hash.update(bytes);
        offset += want;
        const final = offset === sealed.byteLength;
        if (final) {
          const extra = Buffer.allocUnsafe(1);
          if (readSync(fd, extra, 0, 1, offset) !== 0) this.#fail("CORRUPT_INTERMEDIATE", "LENGTH", `spool ${spoolId} grew past its seal`);
          if (hash.digest("hex") !== sealed.sha256) this.#fail("CORRUPT_INTERMEDIATE", "DIGEST", `spool ${spoolId} no longer matches its seal`);
        }
        yield { bytes, final };
      }
    } finally {
      this.#closeFile(fd);
    }
  }

  *#lines(segment: LiveSegment): Generator<string> {
    const { manifest } = segment;
    const fd = this.#openVerified(segment.path, manifest.byteLength, `segment ${manifest.segmentId}`);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let carry: Buffer = Buffer.alloc(0);
    let seen = 0;
    let lines = 0;
    try {
      for (;;) {
        const read = readSync(fd, buffer, 0, buffer.length, null);
        if (read === 0) break;
        seen += read;
        if (seen > manifest.byteLength) this.#fail("CORRUPT_INTERMEDIATE", "LENGTH", `segment ${manifest.segmentId} grew past its seal`);
        const chunk = buffer.subarray(0, read);
        hash.update(chunk);
        const combined = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
        let start = 0;
        for (;;) {
          const index = combined.indexOf(LF, start);
          if (index === -1) break;
          lines += 1;
          yield combined.subarray(start, index).toString("utf8");
          start = index + 1;
        }
        carry = Buffer.from(combined.subarray(start));
      }
      if (seen !== manifest.byteLength || carry.length > 0) this.#fail("CORRUPT_INTERMEDIATE", "LENGTH", `segment ${manifest.segmentId} is not the length it was sealed with`);
      if (hash.digest("hex") !== manifest.sha256) this.#fail("CORRUPT_INTERMEDIATE", "DIGEST", `segment ${manifest.segmentId} no longer matches its checksum`);
      if (lines !== manifest.rowCount) this.#fail("CORRUPT_INTERMEDIATE", "ROWS", `segment ${manifest.segmentId} holds ${lines} of ${manifest.rowCount} rows`);
    } finally {
      this.#closeFile(fd);
    }
  }

  /** Opens a sealed file for reading only when it is still a regular file of exactly its sealed length. */
  #openVerified(path: string, byteLength: number, what: string): number {
    const stat = lstatOrNull(path);
    if (stat === null) this.#fail("CORRUPT_INTERMEDIATE", "MISSING", `${what} is gone`);
    if (!stat.isFile()) this.#fail("CORRUPT_INTERMEDIATE", "NOT_A_FILE", `${what} was replaced by something that is not a file`);
    const fd = this.#openFile(path, "r");
    if (fstatSync(fd).size !== byteLength) {
      this.#closeFile(fd);
      this.#fail("CORRUPT_INTERMEDIATE", "LENGTH", `${what} is not the length it was sealed with`);
    }
    return fd;
  }

  #require(segmentId: string): LiveSegment {
    const found = typeof segmentId === "string" ? this.#segments.get(segmentId) : undefined;
    if (found === undefined) this.#fail("CORRUPT_INTERMEDIATE", "SEGMENT_NOT_PRESENT", "a segment the run expects is not present");
    return found;
  }

  #usable(): void {
    if (this.#failure !== null) throw this.#failure;
    if (this.#closed) throw new TypeError(`the scratch of ${this.attemptId} is disposed`);
  }

  /** The first failure is terminal: every open segment and spool is aborted and every later call throws it. */
  #fail(cause: AttemptFailureCause, problem: string, detail: string): never {
    if (this.#failure === null) {
      this.#failure = new AttemptEnvelopeFailure(cause, problem, `attempt scratch ${this.attemptId}: ${detail}`);
      for (const abort of [...this.#open]) abort();
    }
    throw this.#failure;
  }

  #reserve(bytes: number): void {
    if (this.#bytes + bytes > this.quotaBytes) {
      this.#fail("SCRATCH_EXHAUSTED", "QUOTA", `${this.#bytes + bytes} bytes would pass the quota of ${this.quotaBytes}`);
    }
  }

  #deviceWrite(fd: number, chunk: Uint8Array): void {
    let written = 0;
    while (written < chunk.length) {
      let n: number;
      try {
        n = this.#device.write(fd, chunk, written, chunk.length - written);
      } catch (error) {
        const code = codeOf(error);
        if (code === "ENOSPC" || code === "EDQUOT") this.#fail("SCRATCH_EXHAUSTED", "DEVICE_FULL", "the scratch device is full");
        this.#fail("SHORT_WRITE", "DEVICE_ERROR", `the scratch device failed a write (${String(code)})`);
      }
      if (!Number.isSafeInteger(n) || n <= 0 || n > chunk.length - written) this.#fail("SHORT_WRITE", "NO_PROGRESS", `a write made no progress at ${written} of ${chunk.length} bytes`);
      written += n;
    }
  }

  #account(delta: number, schema: string, write: WriteAttribution | null): void {
    const family = this.#familyOf(schema);
    this.#bytes += delta;
    family.liveBytes += delta;
    if (delta > 0) {
      this.#bytesWritten += delta;
      family.bytesWritten += delta;
      if (write === null || write.pass === null) {
        family.bytesWrittenUnattributed += delta;
      } else {
        while (family.bytesWrittenByPass.length <= write.pass) family.bytesWrittenByPass.push(0);
        family.bytesWrittenByPass[write.pass] = (family.bytesWrittenByPass[write.pass] ?? 0) + delta;
      }
      if (write !== null) {
        family.linesWritten += write.lines;
        family.framingBytes += delta - write.payloadBytes;
      }
    }
    if (this.#bytes > this.#peakBytes) this.#peakBytes = this.#bytes;
    if (family.liveBytes > family.peakBytes) family.peakBytes = family.liveBytes;
    if (family.liveBytes === 0 && family.peakBytes > 0) {
      if (family.closedAt === null) family.closedAt = (this.#ordinal += 1);
    } else if (family.liveBytes > 0) {
      family.closedAt = null;
    }
  }

  #familyOf(schema: string): FamilyCounters {
    let found = this.#families.get(schema);
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
        openedAt: (this.#ordinal += 1),
        closedAt: null,
        sorts: [],
      };
      this.#families.set(schema, found);
    }
    return found;
  }

  #openFile(path: string, flags: "wx" | "r"): number {
    const fd = openSync(path, flags);
    this.#fds.add(fd);
    return fd;
  }

  #closeFile(fd: number): void {
    if (!this.#fds.delete(fd)) return;
    closeSync(fd);
  }

  #release(): void {
    for (const abort of [...this.#open]) abort();
    this.#closed = true;
    for (const fd of [...this.#fds]) this.#closeFile(fd);
  }
}

function rmIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
  }
}
