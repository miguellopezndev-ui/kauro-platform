/**
 * Shared strings of an untrusted workbook, never as one global array (04 "XLSX parser requirements": "Shared strings require a
 * bounded index or disk-backed lookup; a global array containing every string in a high-cardinality workbook is not acceptable").
 *
 * - `readNeededStrings` streams the part and keeps only the indexes a caller asked for (the inventory's header cells, a preview's
 *   window): memory is bounded by what was asked.
 * - `SharedStringStore` streams the part once into two files of the attempt scratch — the UTF-8 bytes of every string and an index
 *   of their offsets — and answers a lookup with two positioned reads through a small cache: memory is bounded whatever the
 *   workbook's cardinality (the counting pass needs arbitrary key cells).
 *
 * A string is the concatenation of its `<t>` runs, phonetic runs (`<rPh>`) excluded. Loaded inside the isolated child.
 */
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { InspectionRefusal } from "../errors.js";
import { partDigestOf, type ArchiveEntry, type ExpansionMeter } from "../archive/zip.js";
import { TextAccumulator, type XmlAttributes, type XmlLimits } from "../xml/scanner.js";
import { scanXmlPart, type PackageIndex } from "./package.js";

class StringEvents {
  count = 0;
  private inItem = false;
  private phonetic = 0;
  private capture = false;
  private readonly runs: string[] = [];
  private readonly accumulator: TextAccumulator;
  constructor(
    part: string,
    cellBytes: number,
    private readonly onString: (index: number, value: string) => void,
    private readonly wants: (index: number) => boolean,
  ) {
    this.accumulator = new TextAccumulator(cellBytes, part, "CELL_BYTES_LIMIT");
  }
  open(name: string, _attributes: XmlAttributes): void {
    if (name === "si") {
      this.inItem = true;
      this.runs.length = 0;
    } else if (name === "rPh") this.phonetic += 1;
    else if (name === "t" && this.inItem && this.phonetic === 0 && this.wants(this.count)) this.capture = true;
  }
  text(value: string): void {
    if (this.capture) this.accumulator.add(value);
  }
  close(name: string): void {
    if (name === "t" && this.capture) {
      this.runs.push(this.accumulator.take());
      this.capture = false;
    } else if (name === "rPh") this.phonetic -= 1;
    else if (name === "si") {
      if (this.wants(this.count)) this.onString(this.count, this.runs.join(""));
      this.count += 1;
      this.inItem = false;
    }
  }
}

/** Reads the strings at `needed` indexes; refuses an index the part does not hold (SHARED_STRING_MISSING). */
export async function readNeededStrings(index: PackageIndex, entry: ArchiveEntry | undefined, needed: ReadonlySet<number>, maxIndex: number, meter: ExpansionMeter, limits: XmlLimits, cellBytes: number): Promise<{ readonly strings: ReadonlyMap<number, string>; readonly count: number }> {
  const strings = new Map<number, string>();
  if (entry === undefined) {
    if (maxIndex >= 0) throw new InspectionRefusal("CORRUPT_STRUCTURE", "SHARED_STRING_MISSING");
    return { strings, count: 0 };
  }
  const events = new StringEvents(partDigestOf(entry.name), cellBytes, (i, v) => strings.set(i, v), (i) => needed.has(i));
  await scanXmlPart(index, entry, meter, limits, events);
  if (maxIndex >= events.count) throw new InspectionRefusal("CORRUPT_STRUCTURE", "SHARED_STRING_MISSING", partDigestOf(entry.name));
  return { strings, count: events.count };
}

const FLUSH = 1 << 20;
const CACHE = 4096;

/** The disk-backed lookup of every shared string (see the module comment). */
export class SharedStringStore {
  private dataFd = -1;
  private indexFd = -1;
  count = 0;
  private readonly cache = new Map<number, string>();

  private constructor(private readonly workDir: string) {}

  static async build(index: PackageIndex, entry: ArchiveEntry | undefined, workDir: string, meter: ExpansionMeter, limits: XmlLimits, cellBytes: number): Promise<SharedStringStore> {
    const store = new SharedStringStore(workDir);
    const dataPath = join(workDir, "shared-strings.dat");
    const indexPath = join(workDir, "shared-strings.idx");
    const dataFd = openSync(dataPath, "w+");
    const indexFd = openSync(indexPath, "w+");
    store.dataFd = dataFd;
    store.indexFd = indexFd;
    if (entry === undefined) return store;
    let data: Buffer[] = [];
    let dataBytes = 0;
    let offset = 0;
    let written = 0;
    let offsets = Buffer.alloc(8 * 1024);
    let used = 0;
    const flushData = (): void => {
      const all = Buffer.concat(data);
      if (all.length > 0) writeSync(dataFd, all, 0, all.length, written);
      written += all.length;
      data = [];
      dataBytes = 0;
    };
    let indexWritten = 0;
    const flushIndex = (): void => {
      if (used > 0) writeSync(indexFd, offsets, 0, used, indexWritten);
      indexWritten += used;
      used = 0;
    };
    const pushOffset = (value: number): void => {
      if (used + 8 > offsets.length) flushIndex();
      offsets.writeDoubleLE(value, used);
      used += 8;
    };
    pushOffset(0);
    const events = new StringEvents(
      partDigestOf(entry.name),
      cellBytes,
      (_i, v) => {
        const bytes = Buffer.from(v, "utf8");
        data.push(bytes);
        dataBytes += bytes.length;
        offset += bytes.length;
        pushOffset(offset);
        if (dataBytes >= FLUSH) flushData();
      },
      () => true,
    );
    await scanXmlPart(index, entry, meter, limits, events);
    flushData();
    flushIndex();
    offsets = Buffer.alloc(0);
    store.count = events.count;
    return store;
  }

  /** The string at `i`; SHARED_STRING_MISSING when the part holds no such index. */
  get(i: number): string {
    const hit = this.cache.get(i);
    if (hit !== undefined) return hit;
    if (!Number.isInteger(i) || i < 0 || i >= this.count) throw new InspectionRefusal("CORRUPT_STRUCTURE", "SHARED_STRING_MISSING");
    const pair = Buffer.alloc(16);
    readSync(this.indexFd, pair, 0, 16, i * 8);
    const start = pair.readDoubleLE(0);
    const end = pair.readDoubleLE(8);
    const bytes = Buffer.alloc(end - start);
    if (bytes.length > 0) readSync(this.dataFd, bytes, 0, bytes.length, start);
    const value = bytes.toString("utf8");
    if (this.cache.size >= CACHE) this.cache.delete(this.cache.keys().next().value as number);
    this.cache.set(i, value);
    return value;
  }

  close(): void {
    if (this.dataFd >= 0) closeSync(this.dataFd);
    if (this.indexFd >= 0) closeSync(this.indexFd);
    this.dataFd = -1;
    this.indexFd = -1;
    void this.workDir;
  }
}

/** Parses a shared-string index cell value; CORRUPT_STRUCTURE when it is not a non-negative integer. */
export function sharedStringIndex(value: string | undefined, part: string): number {
  if (value === undefined || !/^[0-9]{1,10}$/.test(value.trim())) throw new InspectionRefusal("CORRUPT_STRUCTURE", "SHARED_STRING_INDEX_INVALID", part);
  return Number(value.trim());
}
