/**
 * The declared CSV encodings (04 "CSV parser requirements": UTF-8, UTF-16LE, UTF-16BE, Windows-1252 and Latin-1, only when the
 * decoding decision is explicit or unambiguous under the inspection policy; invalid byte sequences never become replacement
 * characters silently; BOM, declared encoding and observed bytes are reconciled).
 *
 * Inspection reconciles: a byte-order mark decides (UTF-8, UTF-16LE, UTF-16BE); otherwise bytes that are valid UTF-8 are UTF-8;
 * otherwise the text is single-byte — Windows-1252 and Latin-1 agree unless a byte 0x80..0x9F occurs, and then the choice is
 * ambiguous and reported (ENCODING_AMBIGUOUS). A NUL byte in text that is not UTF-16 is refused (CSV_NUL_CHARACTER). The counting
 * pass decodes with exactly the encoding the agency chose, fatally: an undecodable byte fails the table.
 *
 * Loaded inside the isolated child.
 */
import { TextDecoder } from "node:util";
import { InspectionRefusal } from "../errors.js";

export type CsvEncoding = "UTF_8" | "UTF_16LE" | "UTF_16BE" | "WINDOWS_1252" | "LATIN_1";

export interface StreamingDecoder {
  decode(bytes: Uint8Array): string;
  end(): string;
}

class WhatwgDecoder implements StreamingDecoder {
  private readonly decoder: TextDecoder;
  constructor(label: string) {
    this.decoder = new TextDecoder(label, { fatal: true, ignoreBOM: false });
  }
  decode(bytes: Uint8Array): string {
    try {
      return this.decoder.decode(bytes, { stream: true });
    } catch {
      throw new InspectionRefusal("CORRUPT_STRUCTURE", "UNDECODABLE_BYTES");
    }
  }
  end(): string {
    try {
      return this.decoder.decode();
    } catch {
      throw new InspectionRefusal("CORRUPT_STRUCTURE", "UNDECODABLE_BYTES");
    }
  }
}

/** ISO-8859-1 exactly: every byte is the code point of the same value (WHATWG's "latin1" label means Windows-1252). */
class Latin1Decoder implements StreamingDecoder {
  decode(bytes: Uint8Array): string {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  }
  end(): string {
    return "";
  }
}

export function decoderFor(encoding: CsvEncoding): StreamingDecoder {
  switch (encoding) {
    case "UTF_8":
      return new WhatwgDecoder("utf-8");
    case "UTF_16LE":
      return new WhatwgDecoder("utf-16le");
    case "UTF_16BE":
      return new WhatwgDecoder("utf-16be");
    case "WINDOWS_1252":
      return new WhatwgDecoder("windows-1252");
    case "LATIN_1":
      return new Latin1Decoder();
  }
}

export interface EncodingEvidence {
  readonly encoding: CsvEncoding;
  readonly bom: boolean;
  /** Issue tokens: ENCODING_NOT_UTF8, ENCODING_AMBIGUOUS. */
  readonly issues: ReadonlyArray<string>;
}

/** Decides the encoding of a file from its bytes (one streaming pass); refuses a NUL byte in text that is not UTF-16. */
export class EncodingSniffer {
  private first: Buffer = Buffer.alloc(0);
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  private utf8Valid = true;
  private c1 = false;
  private nul = false;

  push(bytes: Buffer): void {
    if (this.first.length < 4) this.first = Buffer.concat([this.first, bytes.subarray(0, 4)]).subarray(0, 4);
    if (this.utf8Valid) {
      try {
        this.utf8.decode(bytes, { stream: true });
      } catch {
        this.utf8Valid = false;
      }
    }
    if (!this.nul && bytes.includes(0)) this.nul = true;
    if (!this.c1) {
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i] as number;
        if (b >= 0x80 && b <= 0x9f) {
          this.c1 = true;
          break;
        }
      }
    }
  }

  finish(): EncodingEvidence {
    const f = this.first;
    if (f.length >= 3 && f[0] === 0xef && f[1] === 0xbb && f[2] === 0xbf) return this.single({ encoding: "UTF_8", bom: true, issues: [] });
    if (f.length >= 2 && f[0] === 0xff && f[1] === 0xfe) return { encoding: "UTF_16LE", bom: true, issues: [] };
    if (f.length >= 2 && f[0] === 0xfe && f[1] === 0xff) return { encoding: "UTF_16BE", bom: true, issues: [] };
    if (this.utf8Valid) {
      try {
        this.utf8.decode();
        return this.single({ encoding: "UTF_8", bom: false, issues: [] });
      } catch {
        this.utf8Valid = false;
      }
    }
    return this.single({ encoding: "WINDOWS_1252", bom: false, issues: this.c1 ? ["ENCODING_NOT_UTF8", "ENCODING_AMBIGUOUS"] : ["ENCODING_NOT_UTF8"] });
  }

  private single(evidence: EncodingEvidence): EncodingEvidence {
    if (this.nul) throw new InspectionRefusal("CORRUPT_STRUCTURE", "CSV_NUL_CHARACTER");
    return evidence;
  }
}
