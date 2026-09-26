/**
 * Exact distinct counting in bounded memory (03 "Count the correct population": a referenced-entity projection counts distinct
 * confirmed source keys; 04 "Full-data profile and exact indexes": exact uniqueness uses external sorting, partitioned hash joins
 * or equivalent bounded algorithms; hashes used as grouping accelerators require collision-safe equality checks; large groups
 * are spilled).
 *
 * Keys are held in a set until the in-memory budget is reached; then every key goes to one of 32 partition files of the attempt
 * scratch chosen by a hash of the key (the hash only routes; equality is exact string equality), and the count is the sum of each
 * partition's exact distinct count. A partition larger than the budget is partitioned again with another hash seed, up to four
 * levels; beyond that it is counted in memory (only an adversarial collision of four seeds could get there).
 *
 * Loaded inside the isolated child.
 */
import { closeSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

const PARTITIONS = 32;
const BUFFER = 128 * 1024;
const MAX_LEVEL = 4;

function hash(key: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

class PartitionWriter {
  private readonly fds: number[] = [];
  private readonly buffers: Buffer[][] = [];
  private readonly sizes: number[] = [];
  private readonly offsets: number[] = [];
  readonly counts: number[] = [];
  constructor(
    readonly paths: ReadonlyArray<string>,
    private readonly seed: number,
  ) {
    for (const p of paths) {
      this.fds.push(openSync(p, "w"));
      this.buffers.push([]);
      this.sizes.push(0);
      this.offsets.push(0);
      this.counts.push(0);
    }
  }
  add(key: string): void {
    const p = hash(key, this.seed) % PARTITIONS;
    const bytes = Buffer.from(key, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length, 0);
    (this.buffers[p] as Buffer[]).push(len, bytes);
    this.sizes[p] = (this.sizes[p] as number) + 4 + bytes.length;
    this.counts[p] = (this.counts[p] as number) + 1;
    if ((this.sizes[p] as number) >= BUFFER) this.flush(p);
  }
  private flush(p: number): void {
    const all = Buffer.concat(this.buffers[p] as Buffer[]);
    if (all.length > 0) writeSync(this.fds[p] as number, all, 0, all.length, this.offsets[p] as number);
    this.offsets[p] = (this.offsets[p] as number) + all.length;
    this.buffers[p] = [];
    this.sizes[p] = 0;
  }
  close(): void {
    for (let p = 0; p < this.fds.length; p++) {
      this.flush(p);
      closeSync(this.fds[p] as number);
    }
  }
}

function* readKeys(path: string): Generator<string> {
  const fd = openSync(path, "r");
  try {
    let position = 0;
    let carry = Buffer.alloc(0);
    const chunk = Buffer.alloc(BUFFER);
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, position);
      if (n === 0) break;
      position += n;
      let buf = carry.length === 0 ? chunk.subarray(0, n) : Buffer.concat([carry, chunk.subarray(0, n)]);
      let p = 0;
      while (p + 4 <= buf.length) {
        const len = buf.readUInt32LE(p);
        if (p + 4 + len > buf.length) break;
        yield buf.toString("utf8", p + 4, p + 4 + len);
        p += 4 + len;
      }
      carry = Buffer.from(buf.subarray(p));
      buf = Buffer.alloc(0);
    }
  } finally {
    closeSync(fd);
  }
}

export class DistinctCounter {
  private memory: Set<string> | undefined = new Set();
  private writer: PartitionWriter | undefined;
  /** Keys that went to disk (evidence that the bounded path ran). */
  spilledKeys = 0;

  constructor(
    private readonly workDir: string,
    private readonly name: string,
    private readonly budget: number,
  ) {}

  add(key: string): void {
    if (this.memory !== undefined) {
      this.memory.add(key);
      if (this.memory.size <= this.budget) return;
      this.writer = new PartitionWriter(
        Array.from({ length: PARTITIONS }, (_, i) => join(this.workDir, `distinct-${this.name}-0-${i}.bin`)),
        0,
      );
      for (const k of this.memory) this.writer.add(k);
      this.spilledKeys += this.memory.size;
      this.memory = undefined;
      return;
    }
    (this.writer as PartitionWriter).add(key);
    this.spilledKeys += 1;
  }

  /** The exact number of distinct keys added; removes the partition files. */
  count(): number {
    if (this.memory !== undefined) return this.memory.size;
    const writer = this.writer as PartitionWriter;
    writer.close();
    let total = 0;
    for (let i = 0; i < writer.paths.length; i++) total += this.countPartition(writer.paths[i] as string, writer.counts[i] as number, 1);
    return total;
  }

  private countPartition(path: string, keys: number, level: number): number {
    try {
      if (keys <= this.budget || level >= MAX_LEVEL) {
        const set = new Set<string>();
        for (const k of readKeys(path)) set.add(k);
        return set.size;
      }
      const sub = new PartitionWriter(
        Array.from({ length: PARTITIONS }, (_, i) => `${path}.${level}-${i}`),
        level,
      );
      for (const k of readKeys(path)) sub.add(k);
      sub.close();
      let total = 0;
      for (let i = 0; i < sub.paths.length; i++) total += this.countPartition(sub.paths[i] as string, sub.counts[i] as number, level + 1);
      return total;
    } finally {
      rmSync(path, { force: true });
    }
  }
}
