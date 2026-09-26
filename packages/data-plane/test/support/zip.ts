// A ZIP writer for the test corpus: honest archives, and hostile ones whose metadata lies on purpose (declared sizes and CRCs,
// names, flags, attributes). Everything is built in the test from bytes; nothing is downloaded.
import { crc32, deflateRawSync } from "node:zlib";

export interface ZipItem {
  readonly name: string;
  /** The content; compressed with deflate unless `method` is 0 or `compressed` is given. */
  readonly data?: Uint8Array | string;
  readonly method?: 0 | 8;
  /** Raw data bytes to store as they are (a pre-built deflate stream). */
  readonly compressed?: Uint8Array;
  /** What the headers claim the expanded length is (a lie when it differs). */
  readonly declaredSize?: number;
  /** What the headers claim the CRC-32 is. */
  readonly declaredCrc?: number;
  readonly flags?: number;
  readonly versionMadeBy?: number;
  readonly externalAttributes?: number;
}

function bytesOf(data: Uint8Array | string | undefined): Buffer {
  if (data === undefined) return Buffer.alloc(0);
  return typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
}

export function buildZip(items: ReadonlyArray<ZipItem>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const raw = bytesOf(item.data);
    const method = item.method ?? 8;
    const data = item.compressed !== undefined ? Buffer.from(item.compressed) : method === 8 ? deflateRawSync(raw) : raw;
    const crc = item.declaredCrc ?? crc32(raw);
    const size = item.declaredSize ?? raw.length;
    const name = Buffer.from(item.name, "utf8");
    const flags = (item.flags ?? 0) | (/[^\x20-\x7e]/.test(item.name) ? 0x0800 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(item.versionMadeBy ?? 20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(flags, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc >>> 0, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE((item.externalAttributes ?? 0) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    central.push(entry, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function localHeader(name: Buffer, data: Buffer, crc: number): Buffer {
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(crc >>> 0, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  return local;
}

function centralEntry(name: Buffer, data: Buffer, crc: number, offset: number): Buffer {
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt32LE(crc >>> 0, 16);
  entry.writeUInt32LE(data.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(name.length, 28);
  entry.writeUInt32LE(offset, 42);
  return Buffer.concat([entry, name]);
}

/**
 * Overlapping entries (the construction of a "better zip bomb"): entry B's local header and data lie inside entry A's stored
 * data, so the same bytes are expanded twice. Every header is internally consistent; only the layout is hostile.
 */
export function buildOverlappingZip(): Buffer {
  const nameA = Buffer.from("xl/media/a.bin");
  const nameB = Buffer.from("xl/media/b.bin");
  const dataB = Buffer.from("shared kernel bytes");
  const crcB = crc32(dataB);
  const embedded = Buffer.concat([localHeader(nameB, dataB, crcB), nameB, dataB]);
  const crcA = crc32(embedded);
  const offsetB = 30 + nameA.length;
  const body = Buffer.concat([localHeader(nameA, embedded, crcA), nameA, embedded]);
  const cd = Buffer.concat([centralEntry(nameA, embedded, crcA, 0), centralEntry(nameB, dataB, crcB, offsetB)]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(2, 8);
  end.writeUInt16LE(2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cd, end]);
}
