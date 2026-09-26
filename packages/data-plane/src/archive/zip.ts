/**
 * A hardened ZIP reader for untrusted workbooks (04 "XLSX parser requirements": "The workbook is an untrusted ZIP/XML package.
 * Before extraction, reject traversal paths, absolute paths, duplicate normalized names, symlinks, path collisions and inconsistent
 * archive metadata. During extraction, enforce entry count, per-entry size, cumulative expanded bytes, compression ratio, XML depth
 * and time limits. ZIP64 is supported only within the accepted envelope; it does not waive limits"; 09 "Initial intake envelope":
 * 1 GiB per expanded part, 20 GiB of cumulative expansion; S024).
 *
 * Opening reads only the end record and the central directory and checks every entry against its local header, before a single
 * byte is decompressed: names (UTF-8 or printable ASCII only; no backslash, drive letter, leading slash, empty, `.` or `..`
 * segment, control character or name that Windows would alias; no ambiguous Unicode path field), no symlink, no encryption, only
 * stored or deflated data, one entry per normalized case-folded name, no file that is also a directory prefix, local headers equal
 * to the central directory, entries laid out contiguously from offset 0 to the central directory (no overlap — the overlapping
 * entries of a "better zip bomb" — no prefix, no hidden gap), and the declared sizes within the bounds (per part, total, ratio).
 *
 * Expansion re-enforces every bound on the bytes actually produced, whatever the metadata claimed: a part stops at the smaller of
 * its declared size and the part bound, the archive stops at the total bound, the ratio is measured on the compressed bytes the
 * engine consumed; the expanded length and CRC-32 must equal the central directory's. The counter (`ExpansionMeter`) counts only
 * the bytes delivered to the inspection, so it never exceeds a bound; what the engine produced beyond it (at most one 64 KiB output
 * chunk) is discarded unread.
 *
 * Loaded inside the isolated child: only node built-ins.
 */
import { closeSync, createReadStream, fstatSync, openSync, readSync } from "node:fs";
import { createInflateRaw, crc32 } from "node:zlib";
import { InspectionRefusal, type Finding } from "../errors.js";
import { sha256Text } from "../text.js";

export interface ArchiveLimits {
  readonly maxEntries: number;
  readonly partBytes: number;
  readonly totalBytes: number;
  readonly maxCompressionRatio: number;
  readonly ratioGraceBytes: number;
  readonly centralDirectoryBytes: number;
}

export interface ArchiveEntry {
  /** The entry name as stored (validated). */
  readonly name: string;
  /** NFC, case-folded name: the collision identity. */
  readonly key: string;
  readonly directory: boolean;
  readonly method: 0 | 8;
  readonly flags: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly dataOffset: number;
}

export interface OpenedArchive {
  readonly path: string;
  readonly size: number;
  readonly zip64: boolean;
  readonly entries: ReadonlyArray<ArchiveEntry>;
  readonly findings: ReadonlyArray<Finding>;
  /** Every name listed in the central directory (also when findings refuse the archive). */
  readonly names: ReadonlyArray<string>;
}

const SIG_EOCD = 0x06054b50;
const SIG_Z64_LOCATOR = 0x07064b50;
const SIG_Z64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const U32 = 0xffffffff;
const U16 = 0xffff;
const MAX_FINDINGS = 64;
const CHUNK = 64 * 1024;

/** The identity digest of an archive part (its normalized path); receipts and problems carry it, never the path. */
export function partDigestOf(name: string): string {
  return sha256Text(name.normalize("NFC"));
}

class Reader {
  constructor(
    readonly fd: number,
    readonly size: number,
  ) {}
  at(offset: number, length: number): Buffer {
    if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > this.size) throw new InspectionRefusal("CORRUPT_STRUCTURE", "ZIP_OUT_OF_BOUNDS");
    const buf = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const n = readSync(this.fd, buf, done, length - done, offset + done);
      if (n <= 0) throw new InspectionRefusal("CORRUPT_STRUCTURE", "ZIP_SHORT_READ");
      done += n;
    }
    return buf;
  }
}

function u64(buf: Buffer, offset: number): number {
  const v = buf.readBigUInt64LE(offset);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new InspectionRefusal("CORRUPT_STRUCTURE", "ZIP64_VALUE_OUT_OF_RANGE");
  return Number(v);
}

interface ExtraFields {
  readonly zip64?: Buffer;
  readonly unicodePath: boolean;
}

function extraFields(buf: Buffer): ExtraFields {
  let p = 0;
  let zip64: Buffer | undefined;
  let unicodePath = false;
  const seen = new Set<number>();
  while (p < buf.length) {
    if (p + 4 > buf.length) throw new InspectionRefusal("CORRUPT_STRUCTURE", "ZIP_EXTRA_FIELD_INVALID");
    const id = buf.readUInt16LE(p);
    const len = buf.readUInt16LE(p + 2);
    if (p + 4 + len > buf.length || seen.has(id)) throw new InspectionRefusal("CORRUPT_STRUCTURE", "ZIP_EXTRA_FIELD_INVALID");
    seen.add(id);
    if (id === 0x0001) zip64 = buf.subarray(p + 4, p + 4 + len);
    if (id === 0x7075) unicodePath = true;
    p += 4 + len;
  }
  return zip64 === undefined ? { unicodePath } : { zip64, unicodePath };
}

const ASCII_NAME = /^[\x20-\x7e]*$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Validates one entry name; returns the finding code of the first violation, or undefined. */
export function nameViolation(name: string): string | undefined {
  if (name.length === 0) return "ENTRY_NAME_EMPTY";
  if (CONTROL.test(name)) return "ENTRY_NAME_CONTROL";
  if (name.includes("\\")) return "PATH_BACKSLASH";
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return "ABSOLUTE_PATH";
  const segments = name.endsWith("/") ? name.slice(0, -1).split("/") : name.split("/");
  for (const s of segments) {
    if (s === "") return "PATH_EMPTY_SEGMENT";
    if (s === "." || s === "..") return "PATH_TRAVERSAL";
    // Windows strips trailing dots and spaces and reads a colon as a stream: such a segment aliases another name
    if (s.endsWith(".") || s.endsWith(" ") || s.includes(":")) return "PATH_SEGMENT_AMBIGUOUS";
  }
  return undefined;
}

/**
 * Opens an archive and checks everything that can be checked without decompressing. Findings are collected (at most 64); the
 * caller refuses the archive when there is any. A structural failure of the end record or the central directory ends the check
 * with that one finding.
 */
export function openArchive(path: string, limits: ArchiveLimits): OpenedArchive {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const reader = new Reader(fd, size);
    const findings: Finding[] = [];
    const names: string[] = [];
    const add = (f: Finding): void => {
      if (findings.length < MAX_FINDINGS) findings.push(f);
    };
    try {
      return readDirectory(path, reader, limits, findings, names, add);
    } catch (error) {
      if (!(error instanceof InspectionRefusal)) throw error;
      add({ refusal: error.refusal, code: error.code, ...(error.part === undefined ? {} : { part: error.part }) });
      return { path, size, zip64: false, entries: [], findings, names };
    }
  } finally {
    closeSync(fd);
  }
}

function readDirectory(path: string, reader: Reader, limits: ArchiveLimits, findings: Finding[], names: string[], add: (f: Finding) => void): OpenedArchive {
  const size = reader.size;
  if (size < 22) throw new InspectionRefusal("CORRUPT_STRUCTURE", "ZIP_END_RECORD_MISSING");
  const tailLength = Math.min(size, 22 + U16);
  const tail = reader.at(size - tailLength, tailLength);
  let eocd = -1;
  for (let i = tailLength - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD && i + 22 + tail.readUInt16LE(i + 20) === tailLength) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new InspectionRefusal("CORRUPT_STRUCTURE", "ZIP_END_RECORD_MISSING");
  const eocdOffset = size - tailLength + eocd;
  const disk = tail.readUInt16LE(eocd + 4);
  const cdDisk = tail.readUInt16LE(eocd + 6);
  let entriesOnDisk = tail.readUInt16LE(eocd + 8);
  let entries = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  let cdEnd = eocdOffset;
  let zip64 = false;
  if (disk !== 0 || cdDisk !== 0) throw new InspectionRefusal("CORRUPT_STRUCTURE", "ZIP_MULTI_DISK");
  if (entries === U16 || entriesOnDisk === U16 || cdSize === U32 || cdOffset === U32) {
    zip64 = true;
    if (eocdOffset < 20) throw new InspectionRefusal("CORRUPT_STRUCTURE", "ZIP64_LOCATOR_MISSING");
    const locator = reader.at(eocdOffset - 20, 20);
    if (locator.readUInt32LE(0) !== SIG_Z64_LOCATOR || locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) throw new InspectionRefusal("CORRUPT_STRUCTURE", "ZIP64_LOCATOR_MISSING");
    const recordOffset = u64(locator, 8);
    if (recordOffset + 56 > eocdOffset - 20) throw new InspectionRefusal("CORRUPT_STRUCTURE", "ZIP64_END_RECORD_INVALID");
    const record = reader.at(recordOffset, 56);
    if (record.readUInt32LE(0) !== SIG_Z64_EOCD || record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0) throw new InspectionRefusal("CORRUPT_STRUCTURE", "ZIP64_END_RECORD_INVALID");
    if (recordOffset + 12 + u64(record, 4) !== eocdOffset - 20) throw new InspectionRefusal("CORRUPT_STRUCTURE", "ZIP64_END_RECORD_INVALID");
    entriesOnDisk = u64(record, 24);
    entries = u64(record, 32);
    cdSize = u64(record, 40);
    cdOffset = u64(record, 48);
    cdEnd = recordOffset;
  }
  if (entriesOnDisk !== entries) throw new InspectionRefusal("CORRUPT_STRUCTURE", "ZIP_MULTI_DISK");
  if (entries > limits.maxEntries) throw new InspectionRefusal("RESOURCE_LIMIT", "ARCHIVE_ENTRY_LIMIT");
  if (cdSize > limits.centralDirectoryBytes) throw new InspectionRefusal("RESOURCE_LIMIT", "CENTRAL_DIRECTORY_LIMIT");
  if (cdOffset + cdSize !== cdEnd) throw new InspectionRefusal("CORRUPT_STRUCTURE", "ZIP_CENTRAL_DIRECTORY_INCONSISTENT");
  const cd = reader.at(cdOffset, cdSize);

  interface Parsed {
    readonly nameBytes: Buffer;
    readonly entry: ArchiveEntry;
  }
  const parsed: Parsed[] = [];
  let p = 0;
  for (let i = 0; i < entries; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new InspectionRefusal("CORRUPT_STRUCTURE", "ZIP_CENTRAL_DIRECTORY_INCONSISTENT");
    const versionMadeBy = cd.readUInt16LE(p + 4);
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    let compressedSize = cd.readUInt32LE(p + 20);
    let uncompressedSize = cd.readUInt32LE(p + 24);
    const nameLength = cd.readUInt16LE(p + 28);
    const extraLength = cd.readUInt16LE(p + 30);
    const commentLength = cd.readUInt16LE(p + 32);
    let diskStart = cd.readUInt16LE(p + 34);
    const externalAttributes = cd.readUInt32LE(p + 38);
    let localHeaderOffset = cd.readUInt32LE(p + 42);
    const end = p + 46 + nameLength + extraLength + commentLength;
    if (end > cd.length) throw new InspectionRefusal("CORRUPT_STRUCTURE", "ZIP_CENTRAL_DIRECTORY_INCONSISTENT");
    const nameBytes = cd.subarray(p + 46, p + 46 + nameLength);
    const extra = extraFields(cd.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength));
    p = end;
    if (extra.zip64 !== undefined) {
      let q = 0;
      const z = extra.zip64;
      const take = (): number => {
        if (q + 8 > z.length) throw new InspectionRefusal("CORRUPT_STRUCTURE", "ZIP_EXTRA_FIELD_INVALID");
        const v = u64(z, q);
        q += 8;
        return v;
      };
      if (uncompressedSize === U32) uncompressedSize = take();
      if (compressedSize === U32) compressedSize = take();
      if (localHeaderOffset === U32) localHeaderOffset = take();
      if (diskStart === U16) {
        if (q + 4 > z.length) throw new InspectionRefusal("CORRUPT_STRUCTURE", "ZIP_EXTRA_FIELD_INVALID");
        diskStart = z.readUInt32LE(q);
      }
    } else if (uncompressedSize === U32 || compressedSize === U32 || localHeaderOffset === U32) {
      throw new InspectionRefusal("CORRUPT_STRUCTURE", "ZIP_EXTRA_FIELD_INVALID");
    }
    let name: string;
    if ((flags & 0x800) !== 0) {
      try {
        name = utf8.decode(nameBytes);
      } catch {
        add({ refusal: "CORRUPT_STRUCTURE", code: "ENTRY_NAME_ENCODING" });
        continue;
      }
    } else {
      name = nameBytes.toString("latin1");
      if (!ASCII_NAME.test(name)) {
        add({ refusal: "CORRUPT_STRUCTURE", code: "ENTRY_NAME_ENCODING" });
        continue;
      }
    }
    names.push(name);
    const part = partDigestOf(name);
    const violation = nameViolation(name);
    if (violation !== undefined) add({ refusal: "CORRUPT_STRUCTURE", code: violation, part });
    if (extra.unicodePath) add({ refusal: "CORRUPT_STRUCTURE", code: "ENTRY_NAME_AMBIGUOUS", part });
    if (diskStart !== 0) add({ refusal: "CORRUPT_STRUCTURE", code: "ZIP_MULTI_DISK", part });
    if (versionMadeBy >>> 8 === 3 && ((externalAttributes >>> 16) & 0xf000) === 0xa000) add({ refusal: "CORRUPT_STRUCTURE", code: "SYMLINK_ENTRY", part });
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0 || (flags & 0x2000) !== 0 || method === 99) add({ refusal: "ACTIVE_CONTENT", code: "ENCRYPTED_ENTRY", part });
    else if (method !== 0 && method !== 8) add({ refusal: "CORRUPT_STRUCTURE", code: "UNSUPPORTED_COMPRESSION", part });
    const directory = name.endsWith("/");
    if (method === 0 && compressedSize !== uncompressedSize) add({ refusal: "CORRUPT_STRUCTURE", code: "ENTRY_SIZE_INCONSISTENT", part });
    if (directory && uncompressedSize !== 0) add({ refusal: "CORRUPT_STRUCTURE", code: "DIRECTORY_WITH_DATA", part });
    const key = (directory ? name.slice(0, -1) : name).normalize("NFC").toLowerCase();
    parsed.push({
      nameBytes: Buffer.from(nameBytes),
      entry: {
        name,
        key,
        directory,
        method: method === 8 ? 8 : 0,
        flags,
        crc32: crc,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        dataOffset: -1,
      },
    });
  }
  if (p !== cd.length) throw new InspectionRefusal("CORRUPT_STRUCTURE", "ZIP_CENTRAL_DIRECTORY_INCONSISTENT");

  // one entry per normalized name; no file doubles as a directory prefix
  const keys = new Map<string, boolean>();
  for (const { entry } of parsed) {
    if (keys.has(entry.key)) add({ refusal: "CORRUPT_STRUCTURE", code: "DUPLICATE_ENTRY", part: partDigestOf(entry.name) });
    else keys.set(entry.key, entry.directory);
  }
  for (const { entry } of parsed) {
    const segments = entry.key.split("/");
    for (let i = 1; i < segments.length; i++) {
      if (keys.get(segments.slice(0, i).join("/")) === false) {
        add({ refusal: "CORRUPT_STRUCTURE", code: "PATH_COLLISION", part: partDigestOf(entry.name) });
        break;
      }
    }
  }

  // local headers equal to the central directory; contiguous layout from 0 to the central directory
  const located: ArchiveEntry[] = [];
  const spans: Array<{ readonly start: number; readonly end: number; readonly part: string }> = [];
  for (const { nameBytes, entry } of parsed) {
    const part = partDigestOf(entry.name);
    if (entry.localHeaderOffset + 30 > cdOffset) {
      add({ refusal: "CORRUPT_STRUCTURE", code: "ENTRY_OUT_OF_BOUNDS", part });
      continue;
    }
    const header = reader.at(entry.localHeaderOffset, 30);
    const lNameLength = header.readUInt16LE(26);
    const lExtraLength = header.readUInt16LE(28);
    const lFlags = header.readUInt16LE(6);
    const dataOffset = entry.localHeaderOffset + 30 + lNameLength + lExtraLength;
    if (header.readUInt32LE(0) !== SIG_LOCAL || dataOffset > cdOffset) {
      add({ refusal: "CORRUPT_STRUCTURE", code: "LOCAL_HEADER_MISMATCH", part });
      continue;
    }
    const lName = reader.at(entry.localHeaderOffset + 30, lNameLength);
    const lExtra = extraFields(reader.at(entry.localHeaderOffset + 30 + lNameLength, lExtraLength));
    const methodMatches = header.readUInt16LE(8) === entry.method;
    const flagsMatch = (lFlags & 0x0809) === (entry.flags & 0x0809);
    let sizesMatch = true;
    if ((entry.flags & 0x0008) === 0) {
      let lComp = header.readUInt32LE(18);
      let lUncomp = header.readUInt32LE(22);
      if ((lComp === U32 || lUncomp === U32) && lExtra.zip64 !== undefined) {
        let q = 0;
        if (lUncomp === U32 && q + 8 <= lExtra.zip64.length) {
          lUncomp = u64(lExtra.zip64, q);
          q += 8;
        }
        if (lComp === U32 && q + 8 <= lExtra.zip64.length) lComp = u64(lExtra.zip64, q);
      }
      sizesMatch = header.readUInt32LE(14) === entry.crc32 && lComp === entry.compressedSize && lUncomp === entry.uncompressedSize;
    }
    if (!lName.equals(nameBytes) || !methodMatches || !flagsMatch || !sizesMatch || lExtra.unicodePath) {
      add({ refusal: "CORRUPT_STRUCTURE", code: "LOCAL_HEADER_MISMATCH", part });
      continue;
    }
    let spanEnd = dataOffset + entry.compressedSize;
    if (spanEnd > cdOffset) {
      add({ refusal: "CORRUPT_STRUCTURE", code: "ENTRY_OUT_OF_BOUNDS", part });
      continue;
    }
    if ((entry.flags & 0x0008) !== 0) {
      // data descriptor: optional signature, CRC-32 and both sizes (8-byte sizes for ZIP64)
      const width = zip64 || entry.compressedSize >= U32 || entry.uncompressedSize >= U32 ? 8 : 4;
      const signed = spanEnd + 4 <= cdOffset && reader.at(spanEnd, 4).readUInt32LE(0) === SIG_DESCRIPTOR;
      const length = (signed ? 4 : 0) + 4 + 2 * width;
      if (spanEnd + length > cdOffset) {
        add({ refusal: "CORRUPT_STRUCTURE", code: "DATA_DESCRIPTOR_MISMATCH", part });
        continue;
      }
      const d = reader.at(spanEnd + (signed ? 4 : 0), 4 + 2 * width);
      const dComp = width === 8 ? u64(d, 4) : d.readUInt32LE(4);
      const dUncomp = width === 8 ? u64(d, 12) : d.readUInt32LE(8);
      if (d.readUInt32LE(0) !== entry.crc32 || dComp !== entry.compressedSize || dUncomp !== entry.uncompressedSize) {
        add({ refusal: "CORRUPT_STRUCTURE", code: "DATA_DESCRIPTOR_MISMATCH", part });
        continue;
      }
      spanEnd += length;
    }
    spans.push({ start: entry.localHeaderOffset, end: spanEnd, part });
    located.push({ ...entry, dataOffset });
  }
  spans.sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) add({ refusal: "CORRUPT_STRUCTURE", code: "OVERLAPPING_ENTRIES", part: span.part });
    else if (span.start > cursor) add({ refusal: "CORRUPT_STRUCTURE", code: cursor === 0 ? "ZIP_PREFIX_DATA" : "ZIP_UNACCOUNTED_BYTES", part: span.part });
    cursor = Math.max(cursor, span.end);
  }
  if (spans.length === parsed.length && cursor !== cdOffset) add({ refusal: "CORRUPT_STRUCTURE", code: "ZIP_UNACCOUNTED_BYTES" });

  // the declared expansion within the bounds, before anything is decompressed
  let total = 0;
  for (const entry of located) {
    if (entry.directory) continue;
    const part = partDigestOf(entry.name);
    total += entry.uncompressedSize;
    if (entry.uncompressedSize > limits.partBytes) add({ refusal: "RESOURCE_LIMIT", code: "PART_EXPANSION_LIMIT", part });
  }
  if (total > limits.totalBytes) add({ refusal: "RESOURCE_LIMIT", code: "TOTAL_EXPANSION_LIMIT" });
  for (const entry of located) {
    if (entry.directory || entry.uncompressedSize <= limits.ratioGraceBytes) continue;
    if (entry.uncompressedSize > Math.max(entry.compressedSize, 1) * limits.maxCompressionRatio) add({ refusal: "RESOURCE_LIMIT", code: "COMPRESSION_RATIO_LIMIT", part: partDigestOf(entry.name) });
  }
  return { path, size, zip64, entries: located, findings, names };
}

/** Counts the bytes expansion delivered across one archive (the observer of "decompression stopped at the bound"). */
export class ExpansionMeter {
  decompressedBytes = 0;
  constructor(readonly limits: ArchiveLimits) {}
}

/**
 * Expands one entry, yielding its bytes in order, under every bound (see the module comment); verifies length and CRC-32 at the
 * end. Throws InspectionRefusal (CORRUPT_STRUCTURE or RESOURCE_LIMIT) naming the part's digest.
 */
export async function* expandEntry(archive: OpenedArchive, entry: ArchiveEntry, meter: ExpansionMeter): AsyncGenerator<Buffer, void, void> {
  const limits = meter.limits;
  const part = partDigestOf(entry.name);
  const cap = Math.min(entry.uncompressedSize, limits.partBytes);
  let produced = 0;
  let crc = 0;
  let consumed = (): number => entry.compressedSize;
  const account = (chunk: Buffer): Buffer => {
    if (produced + chunk.length > cap) {
      const take = cap - produced;
      meter.decompressedBytes = Math.min(meter.decompressedBytes + take, limits.totalBytes);
      produced = cap;
      if (cap === limits.partBytes && entry.uncompressedSize >= limits.partBytes) throw new InspectionRefusal("RESOURCE_LIMIT", "PART_EXPANSION_LIMIT", part);
      throw new InspectionRefusal("CORRUPT_STRUCTURE", "ENTRY_SIZE_MISMATCH", part);
    }
    if (meter.decompressedBytes + chunk.length > limits.totalBytes) {
      meter.decompressedBytes = limits.totalBytes;
      throw new InspectionRefusal("RESOURCE_LIMIT", "TOTAL_EXPANSION_LIMIT", part);
    }
    produced += chunk.length;
    meter.decompressedBytes += chunk.length;
    crc = crc32(chunk, crc);
    if (produced > limits.ratioGraceBytes && produced > Math.max(consumed(), 1) * limits.maxCompressionRatio) throw new InspectionRefusal("RESOURCE_LIMIT", "COMPRESSION_RATIO_LIMIT", part);
    return chunk;
  };
  if (entry.compressedSize === 0) {
    if (entry.uncompressedSize !== 0 || entry.method === 8) throw new InspectionRefusal("CORRUPT_STRUCTURE", "ENTRY_DEFLATE_INVALID", part);
  } else {
    const source = createReadStream(archive.path, { start: entry.dataOffset, end: entry.dataOffset + entry.compressedSize - 1, highWaterMark: CHUNK });
    if (entry.method === 0) {
      try {
        for await (const chunk of source as AsyncIterable<Buffer>) yield account(chunk);
      } finally {
        source.destroy();
      }
    } else {
      const inflater = createInflateRaw({ chunkSize: CHUNK });
      consumed = () => inflater.bytesWritten;
      source.on("error", (error) => inflater.destroy(error));
      source.pipe(inflater);
      try {
        for await (const chunk of inflater as AsyncIterable<Buffer>) yield account(chunk);
      } catch (error) {
        if (error instanceof InspectionRefusal) throw error;
        throw new InspectionRefusal("CORRUPT_STRUCTURE", "ENTRY_DEFLATE_INVALID", part);
      } finally {
        source.unpipe(inflater);
        source.destroy();
        inflater.destroy();
      }
    }
  }
  if (produced !== entry.uncompressedSize) throw new InspectionRefusal("CORRUPT_STRUCTURE", "ENTRY_SIZE_MISMATCH", part);
  if (crc >>> 0 !== entry.crc32 >>> 0) throw new InspectionRefusal("CORRUPT_STRUCTURE", "ENTRY_CRC_MISMATCH", part);
}

/** Expands an entry to the end, discarding its bytes (a binary part is counted, bounded and verified, never interpreted). */
export async function drainEntry(archive: OpenedArchive, entry: ArchiveEntry, meter: ExpansionMeter): Promise<void> {
  for await (const _chunk of expandEntry(archive, entry, meter)) {
    // counted and verified by expandEntry
  }
}
