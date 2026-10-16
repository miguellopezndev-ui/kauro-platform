import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { SourceEncoding } from '../domain/locators.js';
import { decodeSource, detectEncoding } from './encoding.js';
import { MigrationError } from '../domain/errors.js';

/**
 * A source file read in blocks, decoded and validated as the blocks arrive.
 *
 * The run used to read every input file whole, decode every one of them whole,
 * and keep both for the length of the migration -- alongside a `SourceRow[]`
 * per sheet. A 38 MB CSV therefore needed hundreds of megabytes before a single
 * value had been looked at, and the peak grew with the bundle rather than with
 * the work.
 *
 * The decode stays fail-closed, which is the part that matters. A block-based
 * decoder that resolved a partial character at a block boundary would produce a
 * replacement character whose position depended on the block size -- a
 * corruption nothing downstream could detect. So each encoding carries at most
 * the few bytes it needs to finish a character, and every refusal the
 * whole-file decoder makes is made here at the byte that causes it.
 *
 * The blocks are re-readable: iterating again reads the file again. That is what
 * lets a sheet be walked more than once -- relationships need the owning rows
 * and then the target rows -- without any pass holding the rows of another.
 */
export interface SourceText {
  readonly encoding: SourceEncoding;
  readonly evidence: string;
  readonly hadByteOrderMark: boolean;
  readonly byteLength: number;
  readonly sha256: string;
  /** Reads the file again, from the first byte after any byte-order mark. */
  blocks(): IterableIterator<string>;
}

/** Bytes per read. Fixed, so the cost of reading a file does not depend on its size. */
const BLOCK_BYTES = 1 << 16;

/** Enough to recognise every byte-order mark this engine accepts. */
const SNIFF_BYTES = 4;

export function openSourceText(
  path: string,
  declared: SourceEncoding | null,
  filePath: string,
  blockBytes: number = BLOCK_BYTES,
): SourceText {
  const byteLength = statSync(path).size;

  // The head of the file, for the byte-order mark and nothing else. The decoder
  // that follows is handed the same declaration the whole-file decoder would
  // have been, so the encoding and the evidence are decided the same way.
  const head = readHead(path, SNIFF_BYTES);
  const detected = detectEncoding(head, declared, filePath);

  const sha256 = digestOf(path);

  return {
    encoding: detected.encoding,
    evidence: detected.evidence,
    hadByteOrderMark: detected.hadByteOrderMark,
    byteLength,
    sha256,
    blocks(): IterableIterator<string> {
      return readBlocks(path, filePath, detected.encoding, detected.markLength, blockBytes);
    },
  };
}

/**
 * The digest, over the bytes as they are on disk.
 *
 * Streamed, because the digest is the identity of the file and computing it used
 * to mean holding the file. Every byte is hashed, including any byte-order mark:
 * the digest names the file, not the text.
 */
export function digestOf(path: string): string {
  const hash = createHash('sha256');
  const handle = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(BLOCK_BYTES);
  try {
    for (;;) {
      const read = readSync(handle, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(handle);
  }
  return hash.digest('hex');
}

function readHead(path: string, count: number): Uint8Array {
  const handle = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(count);
  try {
    const read = readSync(handle, buffer, 0, count, 0);
    return Uint8Array.prototype.slice.call(buffer, 0, read);
  } finally {
    closeSync(handle);
  }
}


/**
 * The file's text, block by block, refusing what the whole-file decoder refuses.
 *
 * Each encoding needs its own carry, and the carry is the whole of the
 * difference between a block-based decode and a whole-file one:
 *
 *   UTF-8 carries an incomplete sequence, which `TextDecoder` does for us in
 *   stream mode, and refuses an invalid one at the byte that causes it.
 *
 *   UTF-16 carries an odd byte, and carries a leading surrogate so the pair it
 *   belongs to can be checked against the unit that follows it in the next
 *   block. An unpaired surrogate is refused wherever the blocks fall.
 *
 *   windows-1252 and latin-1 are one byte per character, so nothing is carried.
 */
function* readBlocks(
  path: string,
  filePath: string,
  encoding: SourceEncoding,
  skip: number,
  blockBytes: number,
): IterableIterator<string> {
  const handle = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(Math.max(1, blockBytes));
  try {
    if (encoding === 'UTF8') {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let position = skip;
      for (;;) {
        const read = readSync(handle, buffer, 0, buffer.length, position);
        if (read === 0) break;
        position += read;
        yield decodeUtf8Block(decoder, buffer.subarray(0, read), filePath, false);
      }
      const tail = decodeUtf8Block(decoder, new Uint8Array(0), filePath, true);
      if (tail.length > 0) yield tail;
      return;
    }

    let carry = new Uint8Array(0);
    let offset = skip;
    let position = skip;
    for (;;) {
      const read = readSync(handle, buffer, 0, buffer.length, position);
      if (read === 0) break;
      position += read;
      const combined = concat(carry, buffer.subarray(0, read));
      const usable = usableLength(combined, encoding);
      const text = decodeExact(combined.subarray(0, usable), encoding, filePath, offset);
      carry = combined.slice(usable);
      offset += usable;
      if (text.length > 0) yield text;
    }
    if (carry.length > 0) {
      // Whatever is left has to be a whole character, or the file ends part way
      // through one. The whole-file decoders say so in those words, and so does
      // this: the same refusal, at the same offset.
      const text = decodeExact(carry, encoding, filePath, offset);
      if (text.length > 0) yield text;
    }
  } finally {
    closeSync(handle);
  }
}

function decodeUtf8Block(
  decoder: InstanceType<typeof TextDecoder>,
  bytes: Uint8Array,
  filePath: string,
  last: boolean,
): string {
  try {
    return decoder.decode(bytes, { stream: !last });
  } catch {
    throw new MigrationError(
      'ENCODING_UNKNOWN',
      `${filePath} is not valid UTF-8`,
      'Re-export the file as UTF-8, or declare the encoding it really uses.',
      { filePath },
    );
  }
}

/**
 * How much of the accumulated bytes can be decoded now.
 *
 * For UTF-16 that is an even number of bytes, and one code unit fewer when the
 * last unit is a leading surrogate whose partner has not arrived. Everything
 * else is decodable a byte at a time.
 */
function usableLength(bytes: Uint8Array, encoding: SourceEncoding): number {
  if (encoding !== 'UTF16LE' && encoding !== 'UTF16BE') return bytes.length;
  const even = bytes.length - (bytes.length % 2);
  if (even < 2) return 0;
  const at = even - 2;
  const low = bytes[encoding === 'UTF16BE' ? at + 1 : at] as number;
  const high = bytes[encoding === 'UTF16BE' ? at : at + 1] as number;
  const unit = low | (high << 8);
  return unit >= 0xd800 && unit <= 0xdbff ? even - 2 : even;
}

function decodeExact(
  bytes: Uint8Array,
  encoding: SourceEncoding,
  filePath: string,
  byteOffset: number,
): string {
  if (bytes.length === 0) return '';
  // The whole-file decoder, on one block. Its refusals are the contract, and
  // reimplementing them per encoding would be a second definition of what a
  // source file is.
  try {
    return decodeSource(bytes, encoding, filePath).text;
  } catch (error) {
    if (error instanceof MigrationError && byteOffset > 0) {
      throw new MigrationError(
        error.code,
        `${error.message} (at or after byte ${String(byteOffset)})`,
        error.remedy,
        { ...error.details, blockByteOffset: byteOffset },
      );
    }
    throw error;
  }
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return Uint8Array.prototype.slice.call(right);
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}
