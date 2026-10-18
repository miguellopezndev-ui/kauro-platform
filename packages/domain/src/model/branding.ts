/**
 * The agency's branding (registry CMD008 UpdateBranding; order 7, docs/design/B13-branding.md): the printable brand name and the logo's
 * safe media pipeline.
 *
 * The brand name a version records is printed on reports (@kauro/reports model safeText, the S069 fence) and stored under the database's
 * own fence (migration 0095 agency_branding_versions_printable). `brandNameProblem` is the conjunction of both, so a name CMD008 records
 * is always one a report prints, and a refusal names its cause before any write.
 *
 * The logo's safe media pipeline (registry CMD008 precondition "The logo passed the safe media pipeline"; failure "Unsafe
 * SVG/script, invalid media or a foreign artifact reject; no remote image fetch from arbitrary URLs"; case S069; order 7,
 * docs/design/B13-branding.md).
 *
 * `admitLogo(bytes)` takes the bytes an OWNER or ADMIN uploaded — never a URL: nothing here, nor in its callers, fetches anything — and
 * answers either one problem or a new PNG the platform made itself:
 *
 * 1. the bytes are bounded before anything parses them (LOGO_MAX_BYTES, the report model's own bound);
 * 2. they must be a PNG: the signature, then every chunk's length, type and CRC-32, IHDR first (1..LOGO_MAX_PIXELS a side, a valid bit
 *    depth and colour type, deflate, standard filtering), the palette and transparency chunks the colour type admits, consecutive IDAT,
 *    IEND last with nothing after it; an unknown critical chunk, an animation (acTL, fcTL, fdAT) or anything else is refused. SVG, HTML,
 *    script, JPEG, GIF, WebP, a renamed file of any kind fail at the signature: no other format is ever parsed;
 * 3. the image data is inflated as one complete zlib stream (its Adler-32 checked, nothing after it) with its output bounded by the exact
 *    size IHDR implies (an image bomb stops at that bound, before any allocation beyond it), then every scanline is unfiltered — interlaced (Adam7) or not — and every palette index checked;
 * 4. the pixels are written again as a new PNG: 8-bit RGBA (RGB when every pixel is opaque), IHDR, IDAT and IEND only. Nothing of the
 *    upload survives but its pixels: text, EXIF, ICC profiles, timestamps, private chunks and trailing bytes are all dropped;
 * 5. the new PNG is bounded again (LOGO_MAX_BYTES) and named by its SHA-256 — the value a branding version and a report name.
 *
 * The report renderer (@kauro/reports checkedLogo) checks the stored bytes again against the hash, the signature, the size and the
 * pixels before it embeds them: the pipeline is the admission, the renderer's check is the last fence.
 *
 * JPEG is part of the report model's vocabulary, but the platform has no JPEG decoder (and takes no new dependency for one): a JPEG is
 * refused LOGO_FORMAT_UNSUPPORTED rather than stored unverified.
 */
import { createHash } from "node:crypto";
import { crc32, deflateSync, inflateSync } from "node:zlib";

/** The report model's bound on a logo's bytes (@kauro/reports LOGO_MAX_BYTES): the upload and the platform's PNG are both held to it. */
export const LOGO_MAX_BYTES = 512 * 1024;
/** The report model's bound on a logo's side, in pixels (@kauro/reports LOGO_MAX_PIXELS). */
export const LOGO_MAX_PIXELS = 2048;
/** The one media type the pipeline produces. */
export const LOGO_MEDIA_TYPE = "image/png";

export const LOGO_PROBLEMS = ["LOGO_TOO_LARGE", "LOGO_FORMAT_UNSUPPORTED", "LOGO_MALFORMED", "LOGO_DIMENSIONS_OUT_OF_RANGE"] as const;
export type LogoProblem = (typeof LOGO_PROBLEMS)[number];

export interface AdmittedLogo {
  /** The PNG the platform wrote from the upload's pixels. */
  readonly bytes: Uint8Array;
  /** SHA-256 of `bytes`, lowercase hex. */
  readonly sha256: string;
  readonly mediaType: typeof LOGO_MEDIA_TYPE;
  readonly width: number;
  readonly height: number;
}

export type LogoAdmission = { readonly ok: true; readonly logo: AdmittedLogo } | { readonly ok: false; readonly problem: LogoProblem; readonly detail: string };

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
/** Bit depths each colour type admits (PNG 11.2.2). */
const BIT_DEPTHS: Readonly<Record<number, readonly number[]>> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/** Chunks that make an animation: the platform stores one still image, never a sequence it would print only the first frame of. */
const ANIMATION_CHUNKS = new Set(["acTL", "fcTL", "fdAT"]);
/** Adam7: x0, y0, dx, dy of each pass. */
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

class Refusal extends Error {
  constructor(
    readonly problem: LogoProblem,
    readonly detail: string,
  ) {
    super(detail);
  }
}
const refuse = (problem: LogoProblem, detail: string): never => {
  throw new Refusal(problem, detail);
};

interface Header {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly interlaced: boolean;
}

const u32 = (b: Uint8Array, at: number): number => ((b[at] as number) * 0x1000000 + (((b[at + 1] as number) << 16) | ((b[at + 2] as number) << 8) | (b[at + 3] as number))) >>> 0;
const isLetter = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

function headerOf(data: Uint8Array): Header {
  if (data.length !== 13) refuse("LOGO_MALFORMED", "IHDR is not 13 bytes");
  const width = u32(data, 0);
  const height = u32(data, 4);
  const [bitDepth, colorType, compression, filter, interlace] = [data[8], data[9], data[10], data[11], data[12]] as number[];
  if (width < 1 || height < 1 || width > LOGO_MAX_PIXELS || height > LOGO_MAX_PIXELS) refuse("LOGO_DIMENSIONS_OUT_OF_RANGE", `the image is ${width}x${height}; a logo is 1..${LOGO_MAX_PIXELS} pixels a side`);
  const depths = BIT_DEPTHS[colorType as number];
  if (depths === undefined || !depths.includes(bitDepth as number)) refuse("LOGO_MALFORMED", `colour type ${colorType} with bit depth ${bitDepth} is not a PNG image`);
  if (compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)) refuse("LOGO_MALFORMED", "IHDR names an unknown compression, filter or interlace method");
  return { width, height, bitDepth: bitDepth as number, colorType: colorType as number, interlaced: interlace === 1 };
}

/** Bytes of one scanline of `width` pixels, without its filter byte. */
const lineBytes = (h: Header, width: number): number => Math.ceil((width * CHANNELS[h.colorType]! * h.bitDepth) / 8);

/** The passes of the image as [width, height] (one pass when not interlaced; empty passes are absent from the data). */
function passesOf(h: Header): ReadonlyArray<readonly [number, number, number]> {
  if (!h.interlaced) return [[0, h.width, h.height]];
  return ADAM7.map(([x0, y0, dx, dy], i) => [i, Math.ceil(Math.max(0, h.width - x0) / dx), Math.ceil(Math.max(0, h.height - y0) / dy)] as const);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Reverses the filter of each scanline of one pass in place; answers the unfiltered lines (each `stride` bytes). */
function unfilter(raw: Uint8Array, at: number, stride: number, lines: number, bpp: number): Uint8Array {
  const out = new Uint8Array(stride * lines);
  for (let y = 0; y < lines; y++) {
    const type = raw[at] as number;
    at += 1;
    const line = y * stride;
    const prior = line - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[at + x] as number;
      const a = x >= bpp ? (out[line + x - bpp] as number) : 0;
      const b = y > 0 ? (out[prior + x] as number) : 0;
      const c = y > 0 && x >= bpp ? (out[prior + x - bpp] as number) : 0;
      let r: number;
      switch (type) {
        case 0:
          r = v;
          break;
        case 1:
          r = v + a;
          break;
        case 2:
          r = v + b;
          break;
        case 3:
          r = v + ((a + b) >>> 1);
          break;
        case 4:
          r = v + paeth(a, b, c);
          break;
        default:
          return refuse("LOGO_MALFORMED", `scanline ${y} names filter type ${type}`);
      }
      out[line + x] = r & 0xff;
    }
    at += stride;
  }
  return out;
}

/** The sample `i` of an unfiltered line, scaled to 8 bits (16-bit samples keep their high byte; low bit depths are scaled to 0..255). */
function sample(line: Uint8Array, offset: number, i: number, depth: number, scale: boolean): number {
  if (depth === 8) return line[offset + i] as number;
  if (depth === 16) return line[offset + 2 * i] as number;
  const perByte = 8 / depth;
  const byte = line[offset + Math.floor(i / perByte)] as number;
  const shift = 8 - depth * ((i % perByte) + 1);
  const value = (byte >> shift) & ((1 << depth) - 1);
  return scale ? Math.round((value * 255) / ((1 << depth) - 1)) : value;
}

/** The raw 16-bit (or narrower) sample, for comparing with a tRNS key. */
function rawSample(line: Uint8Array, offset: number, i: number, depth: number): number {
  if (depth === 16) return ((line[offset + 2 * i] as number) << 8) | (line[offset + 2 * i + 1] as number);
  if (depth === 8) return line[offset + i] as number;
  return sample(line, offset, i, depth, false);
}

/** Decodes every pixel to 8-bit RGBA. */
function decode(h: Header, data: Uint8Array, palette: Uint8Array | null, transparency: Uint8Array | null): Uint8Array {
  const channels = CHANNELS[h.colorType]!;
  const bpp = Math.max(1, Math.ceil((channels * h.bitDepth) / 8));
  const passes = passesOf(h).filter(([, w, hh]) => w > 0 && hh > 0);
  const expected = passes.reduce((n, [, w, hh]) => n + (lineBytes(h, w) + 1) * hh, 0);
  let raw: Buffer;
  let consumed: number;
  try {
    // the bound is the exact size IHDR implies: an image bomb stops here, before allocating anything beyond it. The stream must end
    // (Z_FINISH, the default: an unfinished DEFLATE stream or a missing Adler-32 trailer throws) and be the whole of the image data.
    const inflated = inflateSync(data, { maxOutputLength: expected, info: true }) as unknown as { readonly buffer: Buffer; readonly engine: { readonly bytesWritten: number } };
    raw = inflated.buffer;
    consumed = inflated.engine.bytesWritten;
  } catch (e) {
    return refuse("LOGO_MALFORMED", `the image data is not one complete zlib stream of the ${expected} bytes its header implies (${e instanceof Error && "code" in e ? String(e.code) : "zlib"})`);
  }
  if (raw.length !== expected) refuse("LOGO_MALFORMED", `the image data inflates to ${raw.length} bytes, not the ${expected} its header implies`);
  if (consumed !== data.length) refuse("LOGO_MALFORMED", `${data.length - consumed} bytes of image data follow the end of its zlib stream`);
  const rgba = new Uint8Array(h.width * h.height * 4);
  const entries = palette === null ? 0 : palette.length / 3;
  let at = 0;
  for (const [pass, pw, ph] of passes) {
    const stride = lineBytes(h, pw);
    const lines = unfilter(raw, at, stride, ph, bpp);
    at += (stride + 1) * ph;
    const [x0, y0, dx, dy] = h.interlaced ? ADAM7[pass]! : [0, 0, 1, 1];
    for (let py = 0; py < ph; py++) {
      const offset = py * stride;
      const y = y0 + py * dy;
      for (let px = 0; px < pw; px++) {
        const x = x0 + px * dx;
        const o = (y * h.width + x) * 4;
        let r: number;
        let g: number;
        let b: number;
        let a = 255;
        switch (h.colorType) {
          case 0: {
            r = g = b = sample(lines, offset, px, h.bitDepth, true);
            if (transparency !== null && rawSample(lines, offset, px, h.bitDepth) === ((transparency[0]! << 8) | transparency[1]!)) a = 0;
            break;
          }
          case 2: {
            r = sample(lines, offset, px * 3, h.bitDepth, true);
            g = sample(lines, offset, px * 3 + 1, h.bitDepth, true);
            b = sample(lines, offset, px * 3 + 2, h.bitDepth, true);
            if (
              transparency !== null &&
              rawSample(lines, offset, px * 3, h.bitDepth) === ((transparency[0]! << 8) | transparency[1]!) &&
              rawSample(lines, offset, px * 3 + 1, h.bitDepth) === ((transparency[2]! << 8) | transparency[3]!) &&
              rawSample(lines, offset, px * 3 + 2, h.bitDepth) === ((transparency[4]! << 8) | transparency[5]!)
            )
              a = 0;
            break;
          }
          case 3: {
            const index = sample(lines, offset, px, h.bitDepth, false);
            if (index >= entries) return refuse("LOGO_MALFORMED", `pixel (${x}, ${y}) names palette entry ${index} of ${entries}`);
            r = palette![index * 3]!;
            g = palette![index * 3 + 1]!;
            b = palette![index * 3 + 2]!;
            if (transparency !== null && index < transparency.length) a = transparency[index]!;
            break;
          }
          case 4: {
            r = g = b = sample(lines, offset, px * 2, h.bitDepth, true);
            a = sample(lines, offset, px * 2 + 1, h.bitDepth, true);
            break;
          }
          default: {
            r = sample(lines, offset, px * 4, h.bitDepth, true);
            g = sample(lines, offset, px * 4 + 1, h.bitDepth, true);
            b = sample(lines, offset, px * 4 + 2, h.bitDepth, true);
            a = sample(lines, offset, px * 4 + 3, h.bitDepth, true);
          }
        }
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = a;
      }
    }
  }
  return rgba;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Writes 8-bit RGBA pixels as a PNG of IHDR, IDAT and IEND (RGB when every pixel is opaque), each scanline's filter chosen by the minimum-sum heuristic. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { opaque = false; break; }
  const channels = opaque ? 3 : 4;
  const stride = width * channels;
  const lines = new Uint8Array(stride * height);
  for (let p = 0, q = 0; p < rgba.length; p += 4) {
    lines[q++] = rgba[p] as number;
    lines[q++] = rgba[p + 1] as number;
    lines[q++] = rgba[p + 2] as number;
    if (!opaque) lines[q++] = rgba[p + 3] as number;
  }
  const filtered = new Uint8Array((stride + 1) * height);
  const candidate = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const line = y * stride;
    let best = -1;
    let bestSum = Infinity;
    const at = y * (stride + 1);
    for (let type = 0; type <= 4; type++) {
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const v = lines[line + x] as number;
        const a = x >= channels ? (lines[line + x - channels] as number) : 0;
        const b = y > 0 ? (lines[line - stride + x] as number) : 0;
        const c = y > 0 && x >= channels ? (lines[line - stride + x - channels] as number) : 0;
        const f = (type === 0 ? v : type === 1 ? v - a : type === 2 ? v - b : type === 3 ? v - ((a + b) >>> 1) : v - paeth(a, b, c)) & 0xff;
        candidate[x] = f;
        sum += f < 128 ? f : 256 - f;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = type;
        filtered[at] = type;
        filtered.set(candidate, at + 1);
      }
    }
    if (best < 0) throw new Error("unreachable: no filter chosen");
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  return new Uint8Array(Buffer.concat([Buffer.from(PNG_SIGNATURE), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(filtered, { level: 9 })), chunk("IEND", new Uint8Array(0))]));
}

/** Reads the upload as a PNG, decodes every pixel and answers them (see the header, steps 2 and 3). */
function readPng(bytes: Uint8Array): { readonly header: Header; readonly rgba: Uint8Array } {
  if (bytes.length < PNG_SIGNATURE.length || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 256)).trimStart().toLowerCase();
    const what =
      bytes[0] === 0xff && bytes[1] === 0xd8
        ? "a JPEG (the platform has no JPEG decoder; upload a PNG)"
        : head.startsWith("<") || head.includes("<svg") || head.includes("<script")
          ? "markup (SVG, HTML or XML), never admitted"
          : "not a PNG";
    return refuse("LOGO_FORMAT_UNSUPPORTED", `the file is ${what}`);
  }
  let at = PNG_SIGNATURE.length;
  let header: Header | null = null;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let idatEnded = false;
  let ended = false;
  while (!ended) {
    if (at + 12 > bytes.length) refuse("LOGO_MALFORMED", "the file ends inside a chunk header");
    const length = u32(bytes, at);
    const typeBytes = bytes.subarray(at + 4, at + 8);
    if (!typeBytes.every(isLetter)) refuse("LOGO_MALFORMED", "a chunk type is not four letters");
    const type = String.fromCharCode(...typeBytes);
    if (length > bytes.length - at - 12) refuse("LOGO_MALFORMED", `chunk ${type} runs past the end of the file`);
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== u32(bytes, at + 8 + length)) refuse("LOGO_MALFORMED", `chunk ${type} fails its CRC-32`);
    at += 12 + length;
    if (header === null && type !== "IHDR") refuse("LOGO_MALFORMED", "the first chunk is not IHDR");
    if (idat.length > 0 && type !== "IDAT") idatEnded = true;
    switch (type) {
      case "IHDR":
        if (header !== null) refuse("LOGO_MALFORMED", "a second IHDR");
        header = headerOf(data);
        break;
      case "PLTE":
        if (palette !== null || idat.length > 0) refuse("LOGO_MALFORMED", "PLTE repeated or after the image data");
        if (header!.colorType === 0 || header!.colorType === 4) refuse("LOGO_MALFORMED", "a palette in a greyscale image");
        if (length === 0 || length % 3 !== 0 || length / 3 > Math.min(256, header!.colorType === 3 ? 1 << header!.bitDepth : 256)) refuse("LOGO_MALFORMED", "PLTE is not a palette of the image's depth");
        palette = data;
        break;
      case "tRNS":
        if (transparency !== null || idat.length > 0) refuse("LOGO_MALFORMED", "tRNS repeated or after the image data");
        if (header!.colorType === 4 || header!.colorType === 6) refuse("LOGO_MALFORMED", "tRNS in an image with an alpha channel");
        if (header!.colorType === 3 && (palette === null || length > palette.length / 3)) refuse("LOGO_MALFORMED", "tRNS before or longer than the palette");
        if ((header!.colorType === 0 && length !== 2) || (header!.colorType === 2 && length !== 6)) refuse("LOGO_MALFORMED", "tRNS is not the image's transparency key");
        transparency = data;
        break;
      case "IDAT":
        if (idatEnded) refuse("LOGO_MALFORMED", "the image data is not consecutive");
        if (header!.colorType === 3 && palette === null) refuse("LOGO_MALFORMED", "an indexed image without a palette");
        idat.push(data);
        break;
      case "IEND":
        if (length !== 0) refuse("LOGO_MALFORMED", "IEND carries data");
        ended = true;
        break;
      default:
        if (ANIMATION_CHUNKS.has(type)) refuse("LOGO_FORMAT_UNSUPPORTED", "the file is an animated PNG; a logo is one still image");
        // an unknown critical chunk (upper-case first letter) changes how the image reads: refused; an ancillary one is dropped
        if (((typeBytes[0] as number) & 0x20) === 0) refuse("LOGO_MALFORMED", `unknown critical chunk ${type}`);
    }
  }
  if (at !== bytes.length) refuse("LOGO_MALFORMED", "bytes follow IEND");
  if (header === null || idat.length === 0) refuse("LOGO_MALFORMED", "the file has no image data");
  return { header: header!, rgba: decode(header!, Buffer.concat(idat), palette, transparency) };
}

/** The safe media pipeline (see the header): one problem, or the platform's own PNG of the upload's pixels. */
export function admitLogo(bytes: Uint8Array): LogoAdmission {
  try {
    if (bytes.byteLength === 0) refuse("LOGO_FORMAT_UNSUPPORTED", "the file is empty");
    if (bytes.byteLength > LOGO_MAX_BYTES) refuse("LOGO_TOO_LARGE", `the file is larger than ${LOGO_MAX_BYTES} bytes`);
    const { header, rgba } = readPng(bytes);
    const png = encodePng(header.width, header.height, rgba);
    if (png.byteLength > LOGO_MAX_BYTES) refuse("LOGO_TOO_LARGE", `the image, written again as a PNG, is larger than ${LOGO_MAX_BYTES} bytes`);
    return { ok: true, logo: Object.freeze({ bytes: png, sha256: createHash("sha256").update(png).digest("hex"), mediaType: LOGO_MEDIA_TYPE, width: header.width, height: header.height }) };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, problem: e.problem, detail: e.detail };
    throw e;
  }
}

/** The report model's bound on a brand name (@kauro/reports safeText(displayName, 120)) and the database's (length <= 120 code points). */
export const BRAND_NAME_MAX_LENGTH = 120;
/** Controls, format characters (soft hyphen, zero-width, bidirectional, word joiners, BOM), line and paragraph separators, markup. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>"'&`]/u;

/** Why a brand name could not be printed on a report, or null when it can (see the header). */
export function brandNameProblem(name: string): "EMPTY" | "PADDED" | "TOO_LONG" | "NOT_NFC" | "UNSAFE_CHARACTER" | null {
  if (name.trim().length === 0) return "EMPTY";
  if (name !== name.trim()) return "PADDED";
  if (name.length > BRAND_NAME_MAX_LENGTH) return "TOO_LONG";
  if (name !== name.normalize("NFC")) return "NOT_NFC";
  if (UNPRINTABLE.test(name)) return "UNSAFE_CHARACTER";
  return null;
}

/** The pixels of a PNG this pipeline wrote, as 8-bit RGBA (for tests and the report's checks: the stored logo decodes to what was admitted). */
export function decodeAdmittedPng(bytes: Uint8Array): { readonly width: number; readonly height: number; readonly rgba: Uint8Array } {
  const { header, rgba } = readPng(bytes);
  return { width: header.width, height: header.height, rgba };
}
