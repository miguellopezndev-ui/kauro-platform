import { MigrationError } from '../domain/errors.js';
import type { SourceEncoding } from '../domain/locators.js';

export interface DecodedText {
  readonly text: string;
  readonly encoding: SourceEncoding;
  /** How the encoding was established, recorded in the file locator. */
  readonly evidence: string;
  readonly hadByteOrderMark: boolean;
}

/**
 * The 27 positions where windows-1252 differs from ISO-8859-1. Implemented here
 * rather than through `TextDecoder` so that decoding does not depend on whether
 * the Node build ships full ICU.
 */
const CP1252_HIGH: Readonly<Record<number, string>> = {
  0x80: '€',
  0x82: '‚',
  0x83: 'ƒ',
  0x84: '„',
  0x85: '…',
  0x86: '†',
  0x87: '‡',
  0x88: 'ˆ',
  0x89: '‰',
  0x8a: 'Š',
  0x8b: '‹',
  0x8c: 'Œ',
  0x8e: 'Ž',
  0x91: '‘',
  0x92: '’',
  0x93: '“',
  0x94: '”',
  0x95: '•',
  0x96: '–',
  0x97: '—',
  0x98: '˜',
  0x99: '™',
  0x9a: 'š',
  0x9b: '›',
  0x9c: 'œ',
  0x9e: 'ž',
  0x9f: 'Ÿ',
};

/** Positions windows-1252 leaves undefined. Encountering one means the declared encoding is wrong. */
const CP1252_UNDEFINED = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);

export function decodeSource(
  bytes: Uint8Array,
  declared: SourceEncoding | null,
  filePath: string,
): DecodedText {
  const detected = detectEncoding(bytes, declared, filePath);
  return {
    text: decodeWith(bytes.subarray(detected.markLength), detected.encoding, filePath),
    encoding: detected.encoding,
    evidence: detected.evidence,
    hadByteOrderMark: detected.hadByteOrderMark,
  };
}
interface ByteOrderMark {
  readonly encoding: SourceEncoding;
  readonly length: number;
}

/**
 * Which encoding a file is in, and what says so.
 *
 * Decided from the head of the file: a byte-order mark if there is one, the
 * configuration if it declares one, and validated UTF-8 otherwise. The
 * whole-file decoder and the block reader both ask this, so a file cannot be
 * one encoding when it is read whole and another when it is read in pieces.
 */
export interface DetectedEncoding {
  readonly encoding: SourceEncoding;
  readonly evidence: string;
  readonly hadByteOrderMark: boolean;
  /** Bytes of byte-order mark to skip before the text begins. */
  readonly markLength: number;
}

export function detectEncoding(
  head: Uint8Array,
  declared: SourceEncoding | null,
  filePath: string,
): DetectedEncoding {
  const bom = detectByteOrderMark(head);
  if (bom !== null) {
    if (declared !== null && declared !== bom.encoding) {
      throw new MigrationError(
        'ENCODING_UNKNOWN',
        `${filePath} starts with a ${bom.encoding} byte-order mark but the configuration declares ${declared}`,
        'Remove the encoding override, or correct it to match the file.',
        { filePath, declared, detected: bom.encoding },
      );
    }
    return {
      encoding: bom.encoding,
      evidence: `BOM_${bom.encoding}`,
      hadByteOrderMark: true,
      markLength: bom.length,
    };
  }
  if (declared !== null) {
    return { encoding: declared, evidence: 'CONFIG_DECLARED', hadByteOrderMark: false, markLength: 0 };
  }
  return { encoding: 'UTF8', evidence: 'UTF8_VALIDATED', hadByteOrderMark: false, markLength: 0 };
}

export function detectByteOrderMark(bytes: Uint8Array): ByteOrderMark | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'UTF8', length: 3 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'UTF16LE', length: 2 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: 'UTF16BE', length: 2 };
  }
  return null;
}

function decodeWith(bytes: Uint8Array, encoding: SourceEncoding, filePath: string): string {
  switch (encoding) {
    case 'UTF8':
      return decodeStrictUtf8(bytes, filePath);
    case 'UTF16LE':
      return decodeStrictUtf16(bytes, filePath, false);
    case 'UTF16BE':
      return decodeStrictUtf16(bytes, filePath, true);
    case 'LATIN1':
      return Buffer.from(bytes).toString('latin1');
    case 'WINDOWS_1252':
      return decodeWindows1252(bytes, filePath);
  }
}

/**
 * UTF-16 decoding is fail-closed in the same way UTF-8 is.
 *
 * `Buffer.toString('utf16le')` substitutes U+FFFD for an unpaired surrogate and
 * silently drops a trailing odd byte. Either would put a value in a destination
 * CRM that the customer never had, so both are checked before decoding.
 */
function decodeStrictUtf16(bytes: Uint8Array, filePath: string, bigEndian: boolean): string {
  if (bytes.length % 2 !== 0) {
    throw new MigrationError(
      'ENCODING_UNKNOWN',
      `${filePath} is declared UTF-16 but has an odd number of bytes, so its last character is incomplete`,
      'The file is truncated or is not UTF-16. Re-export it.',
      { filePath, byteLength: bytes.length },
    );
  }

  const units = new Uint16Array(bytes.length / 2);
  for (let index = 0; index < bytes.length; index += 2) {
    const low = bytes[bigEndian ? index + 1 : index] as number;
    const high = bytes[bigEndian ? index : index + 1] as number;
    units[index / 2] = low | (high << 8);
  }

  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index] as number;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = units[index + 1];
      if (next === undefined || next < 0xdc00 || next > 0xdfff) {
        throw new MigrationError(
          'ENCODING_UNKNOWN',
          `${filePath} contains an unpaired UTF-16 surrogate at byte offset ${String(index * 2)}`,
          'The file is damaged or is not UTF-16. Re-export it as UTF-8.',
          { filePath, byteOffset: index * 2, codeUnit: unit },
        );
      }
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new MigrationError(
        'ENCODING_UNKNOWN',
        `${filePath} contains a trailing UTF-16 surrogate with no leading half at byte offset ${String(index * 2)}`,
        'The file is damaged or is not UTF-16. Re-export it as UTF-8.',
        { filePath, byteOffset: index * 2, codeUnit: unit },
      );
    }
  }

  return String.fromCharCode(...units.subarray(0, 0)) + decodeUnits(units);
}

/** Built in chunks so a large file does not exhaust the argument limit of `fromCharCode`. */
function decodeUnits(units: Uint16Array): string {
  const CHUNK = 8192;
  let out = '';
  for (let index = 0; index < units.length; index += CHUNK) {
    out += String.fromCharCode(...units.subarray(index, Math.min(index + CHUNK, units.length)));
  }
  return out;
}

function decodeWindows1252(bytes: Uint8Array, filePath: string): string {
  const out: string[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] as number;
    if (CP1252_UNDEFINED.has(byte)) {
      throw new MigrationError(
        'ENCODING_UNKNOWN',
        `${filePath} contains byte 0x${byte.toString(16)} at offset ${String(index)}, which windows-1252 does not define`,
        'The file is not windows-1252. Re-export it as UTF-8, or declare the correct encoding.',
        { filePath, byteOffset: index, byte },
      );
    }
    out.push(CP1252_HIGH[byte] ?? String.fromCharCode(byte));
  }
  return out.join('');
}

/**
 * Strict UTF-8 decode. Invalid sequences fail the run with the byte offset
 * rather than becoming replacement characters, because mojibake that reaches a
 * destination CRM is indistinguishable from data the customer actually had.
 */
function decodeStrictUtf8(bytes: Uint8Array, filePath: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    const offset = findFirstInvalidUtf8Offset(bytes);
    throw new MigrationError(
      'ENCODING_UNKNOWN',
      `${filePath} is not valid UTF-8; the first invalid byte is at offset ${String(offset)}`,
      'Re-export the file as UTF-8, or declare the real encoding with the file\'s "encoding" setting (WINDOWS_1252 and LATIN1 are supported).',
      { filePath, byteOffset: offset, byte: bytes[offset] ?? null },
    );
  }
}

/**
 * Walks the sequences directly rather than bisecting on "shortest failing
 * prefix", which is not a monotone predicate: a prefix cut in the middle of a
 * valid multi-byte character also fails, so bisection reports the wrong byte.
 */
function findFirstInvalidUtf8Offset(bytes: Uint8Array): number {
  let index = 0;
  while (index < bytes.length) {
    const lead = bytes[index] as number;
    let length: number;
    let lowest: number;

    if (lead < 0x80) {
      index += 1;
      continue;
    } else if (lead >= 0xc2 && lead <= 0xdf) {
      length = 2;
      lowest = 0x80;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      length = 3;
      lowest = 0x800;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      length = 4;
      lowest = 0x10000;
    } else {
      return index;
    }

    if (index + length > bytes.length) return index;

    let codePoint = lead & (0xff >> (length + 1));
    for (let offset = 1; offset < length; offset += 1) {
      const continuation = bytes[index + offset] as number;
      if ((continuation & 0xc0) !== 0x80) return index;
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }

    // Overlong encodings, surrogates and out-of-range code points are all invalid.
    if (codePoint < lowest || (codePoint >= 0xd800 && codePoint <= 0xdfff) || codePoint > 0x10ffff) {
      return index;
    }
    index += length;
  }
  return Math.max(0, bytes.length - 1);
}
