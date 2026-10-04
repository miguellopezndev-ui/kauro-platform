// The digest behind a legal document's version label (D-LEGAL-1), held equal to node:crypto. The renderer cannot import a Node built-in
// (the architecture gate refuses one in this package's sources, D-SEC-2), so it carries a synchronous SHA-256; this test is what makes
// that safe: the published vectors, every message length around the padding boundaries, multi-byte text, and a long message.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { sha256Hex } from "../src/legal/sha256.ts";

const reference = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

test("D-LEGAL-1 digest: the FIPS 180-4 and NIST example vectors", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  assert.equal(sha256Hex("a".repeat(1_000_000)), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
});

test("D-LEGAL-1 digest: equal to node:crypto for every length from 0 to 300 bytes, across the one-block and two-block padding boundaries", () => {
  for (let length = 0; length <= 300; length += 1) {
    const text = String.fromCharCode(...Array.from({ length }, (_, index) => 32 + ((index * 7 + length) % 95)));
    assert.equal(sha256Hex(text), reference(text), `length ${length}`);
  }
  for (const length of [55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129]) assert.equal(sha256Hex("x".repeat(length)), reference("x".repeat(length)), `boundary ${length}`);
});

test("D-LEGAL-1 digest: multi-byte text is hashed as UTF-8, and control characters and lone newlines are just bytes", () => {
  for (const text of ["Términos de servicio – Kauro", "Ünïcödé ✓ 日本語 🙂", "line\nbreak\r\nand\ttab\u0000", "  padded  "]) assert.equal(sha256Hex(text), reference(text), text);
  const many = Array.from({ length: 40 }, (_, index) => `Section ${index}: the operator’s terms apply.\n`).join("");
  assert.equal(sha256Hex(many), reference(many));
});

test("D-LEGAL-1 digest: the same text always gives the same digest and a one-character change gives another", () => {
  assert.equal(sha256Hex("terms"), sha256Hex("terms"));
  assert.notEqual(sha256Hex("terms"), sha256Hex("Terms"));
  assert.match(sha256Hex("terms"), /^[0-9a-f]{64}$/);
});
