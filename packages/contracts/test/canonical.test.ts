// S047: canonical JSON with Unicode, large integer strings and ordered arrays — interoperable digests preserve string and array
// meaning; no arbitrary normalization. Plus the profile's rejections (duplicate keys, invalid Unicode, non-finite, unsafe ints).
import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalize, canonicalBytes, parseCanonical, compareCodePoints, CanonicalError } from "../src/canonical.js";
import { DOMAINS, structuredDigest, structuredPreimage, rawDigest, digestEquals, R2_DOMAIN_ALIASES } from "../src/digest.js";

test("keys are sorted by code point, arrays keep their order, nested values are canonical", () => {
  const value = { b: [3, 1, 2], a: { z: null, "é": "x", Z: true }, "ä": [{ y: 1, x: 2 }] };
  assert.equal(canonicalize(value), '{"a":{"Z":true,"z":null,"é":"x"},"b":[3,1,2],"ä":[{"x":2,"y":1}]}');
});

test("Unicode is preserved as-is: no NFC/NFD normalization, no case folding, no trimming", () => {
  const nfd = "é"; // e + combining acute
  const nfc = "é"; // precomposed
  assert.notEqual(canonicalize({ v: nfd }), canonicalize({ v: nfc }));
  assert.equal(canonicalize({ v: " Ámbito  " }), '{"v":" Ámbito  "}');
  assert.equal(canonicalize({ v: "\u{1F600} Ñandú" }), '{"v":"\u{1F600} Ñandú"}');
  assert.deepEqual(Array.from(canonicalBytes("Ñ")), [0x22, 0xc3, 0x91, 0x22]);
});

test("large integers travel as decimal strings and keep their exact digits; unsafe JSON numbers are rejected", () => {
  const big = "123456789012345678901234567890";
  assert.equal(canonicalize({ n: big }), `{"n":"${big}"}`);
  assert.throws(() => canonicalize({ n: 2 ** 53 + 2 }), CanonicalError);
  assert.throws(() => canonicalize({ n: 12345678901234567890n as unknown as number }), CanonicalError);
  assert.throws(() => parseCanonical('{"n":12345678901234567890}'), CanonicalError);
  assert.deepEqual(parseCanonical('{"n":"12345678901234567890"}'), { n: "12345678901234567890" });
  assert.equal(canonicalize({ n: 9007199254740991 }), '{"n":9007199254740991}');
});

test("the profile rejects non-finite numbers, undefined, duplicate keys and lone surrogates", () => {
  assert.throws(() => canonicalize({ x: Number.NaN }), CanonicalError);
  assert.throws(() => canonicalize({ x: Number.POSITIVE_INFINITY }), CanonicalError);
  assert.throws(() => canonicalize({ x: undefined }), CanonicalError);
  assert.throws(() => canonicalize({ x: "\ud800" }), CanonicalError);
  assert.throws(() => canonicalize({ x: "a\udc00b" }), CanonicalError);
  assert.throws(() => parseCanonical('{"a":1,"a":2}'), /duplicate object key "a"/);
  assert.throws(() => parseCanonical('{"o":{"k":1,"k":1}}'), CanonicalError);
  assert.equal(canonicalize({ x: -0 }), '{"x":0}');
  assert.equal(canonicalize({ x: 1.5 }), '{"x":1.5}');
  assert.equal(canonicalize({ x: 'with "quote" and \\ and \n' }), '{"x":"with \\"quote\\" and \\\\ and \\n"}');
});

test("code-point ordering differs from UTF-16 unit ordering for astral characters", () => {
  // U+FF5E (one UTF-16 unit) vs U+1F600 (surrogate pair): by code point U+1F600 sorts after; by UTF-16 units it would sort first
  assert.equal(compareCodePoints("～", "\u{1F600}"), -1);
  assert.equal(canonicalize({ "\u{1F600}": 1, "～": 2 }), '{"～":2,"\u{1F600}":1}');
});

test("array order is meaning: reordering changes the digest; the same content in another key order does not", () => {
  const a = structuredDigest(DOMAINS.PLAN_BODY, 1, { mappings: ["x", "y"], k: 1 });
  const b = structuredDigest(DOMAINS.PLAN_BODY, 1, { k: 1, mappings: ["x", "y"] });
  const c = structuredDigest(DOMAINS.PLAN_BODY, 1, { mappings: ["y", "x"], k: 1 });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("digests are domain-separated and versioned; the preimage is the closed wrapper", () => {
  const payload = { revisionHash: "a".repeat(64) };
  const d1 = structuredDigest(DOMAINS.PLAN_BODY, 1, payload);
  const d2 = structuredDigest(DOMAINS.TARGET_BODY, 1, payload);
  const d3 = structuredDigest(DOMAINS.PLAN_BODY, 2, payload);
  assert.notEqual(d1, d2);
  assert.notEqual(d1, d3);
  assert.equal(
    Buffer.from(structuredPreimage(DOMAINS.PLAN_BODY, 1, payload)).toString("utf8"),
    '{"domain":"KAURO_PLAN_BODY_V1","payload":{"revisionHash":"' + "a".repeat(64) + '"},"version":1}',
  );
  assert.throws(() => structuredPreimage(DOMAINS.RAW_BYTES, 1, payload), TypeError);
  assert.equal(rawDigest(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.ok(digestEquals(d1, d1));
  assert.ok(!digestEquals(d1, d2));
  assert.ok(!digestEquals("nope", d1));
  assert.equal(R2_DOMAIN_ALIASES["KAVO_DELIVERY_MANIFEST_V1"], DOMAINS.DELIVERY_MANIFEST);
});

test("interoperability anchor: a structured digest equals the raw digest of its exact preimage bytes", () => {
  const payload = { items: ["a", "b"], currency: "USD", amount: "129500" };
  const expectedPreimage = '{"domain":"KAURO_QUOTE_TERMS_V1","payload":{"amount":"129500","currency":"USD","items":["a","b"]},"version":1}';
  assert.equal(Buffer.from(structuredPreimage(DOMAINS.QUOTE_TERMS, 1, payload)).toString("utf8"), expectedPreimage);
  assert.equal(structuredDigest(DOMAINS.QUOTE_TERMS, 1, payload), rawDigest(new TextEncoder().encode(expectedPreimage)));
});
