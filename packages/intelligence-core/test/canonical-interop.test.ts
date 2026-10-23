/**
 * S047 canonical interoperability (B05 C01-C04). The digests in test/fixtures/canonical-interop.json were sealed by the independent
 * oracle tools/canonical-oracle.py (Python json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False), UTF-8 sha256)
 * before the platform code was compared with them.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { canonicalize } from "@kauro/contracts";
import {
  CanonicalAgreementError,
  IdentityBridgeError,
  assertCanonicalAgreement,
  bridgeIdentity,
  canonicalJson,
  citeCoreNativeIdentity,
  platformDigestCiting,
  platformDigestOfAgreed,
} from "../src/index.js";
import fixture from "./fixtures/canonical-interop.json" with { type: "json" };

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

test("C01 S047 OK: for values the platform hashes structurally, Unicode (NFC and NFD distinct, astral, escapes), large integer strings and ordered arrays give identical bytes under canonicalize and IC canonicalJson, equal to the presealed digests", () => {
  assert.ok(fixture.agree.length >= 9);
  for (const c of fixture.agree) {
    const value: unknown = JSON.parse(c.valueJson);
    assert.equal(canonicalize(value), c.canonical, `${c.id}: platform bytes`);
    assert.equal(canonicalJson(value), c.canonical, `${c.id}: IC bytes`);
    assert.equal(assertCanonicalAgreement(value), c.canonical, `${c.id}: agreement`);
    assert.equal(sha256(c.canonical), c.sha256, `${c.id}: presealed digest`);
    assert.equal(platformDigestOfAgreed(value), c.sha256, `${c.id}: platform digest`);
  }
  const nfc = fixture.agree.find((c) => c.id === "nfc-nfd-distinct-nfc");
  const nfd = fixture.agree.find((c) => c.id === "nfc-nfd-distinct-nfd");
  assert.notEqual(nfc?.sha256, nfd?.sha256, "NFC and NFD are distinct values and never normalized");
});

test("C02 S047 DENY: code-point vs UTF-16 key order, lone surrogate, unsafe integer or undefined member: refused by the platform or assertCanonicalAgreement; never two silent digests", () => {
  // keys U+FF5E (BMP) and U+10000 (astral): code-point order puts the BMP one first, UTF-16 unit order the astral one
  const order = { "\u{10000}": 1, "～": 2 };
  assert.notEqual(canonicalize(order), canonicalJson(order), "the two serializers really disagree here");
  assert.throws(() => assertCanonicalAgreement(order), (e: unknown) => e instanceof CanonicalAgreementError && e.reason === "BYTES_DIFFER");
  // IC accepts these; the platform refuses them, and so does the agreement
  const lone = { s: "\ud800" };
  assert.doesNotThrow(() => canonicalJson(lone));
  assert.throws(() => assertCanonicalAgreement(lone), (e: unknown) => e instanceof CanonicalAgreementError && e.reason === "PLATFORM_REFUSED");
  const unsafe = { n: 9007199254740993 };
  assert.doesNotThrow(() => canonicalJson(unsafe));
  assert.throws(() => assertCanonicalAgreement(unsafe), (e: unknown) => e instanceof CanonicalAgreementError && e.reason === "PLATFORM_REFUSED");
  const undef = { a: 1, b: undefined };
  assert.equal(canonicalJson(undef), '{"a":1}', "IC silently drops the member");
  assert.throws(() => assertCanonicalAgreement(undef), (e: unknown) => e instanceof CanonicalAgreementError && e.reason === "PLATFORM_REFUSED");
  assert.throws(() => platformDigestOfAgreed(undef), CanonicalAgreementError);
  assert.throws(() => assertCanonicalAgreement({ f: Number.NaN }), CanonicalAgreementError);
});

/** MC 3.1.0 core-native hashes of the Unicode / large-integer profile and candidate set, sealed by migration-core's own loaders (packages/migration-core/test/core-native-identity.test.ts recomputes them). */
const MC_PROFILE_HASH = "e0b5e8a44d3608b6c85deef74d9b7f2cb72ad7971a7ae452b13c65c633b78d4e";
const MC_CANDIDATE_SET_HASH = "bc848c6fd0d37f5830d2b6527390e99838666a8275238d75d65f3f2caff8a173";

test("C03 S047 OK: MC-native hashes of a Unicode/large-integer profile and candidate set are recomputed only by MC loaders, stored verbatim, and a platform digest of a record citing them carries them as strings", () => {
  assert.equal(citeCoreNativeIdentity(MC_PROFILE_HASH), MC_PROFILE_HASH);
  assert.equal(bridgeIdentity("CORE_NATIVE", "CORE_NATIVE", MC_CANDIDATE_SET_HASH), MC_CANDIDATE_SET_HASH);
  const record = { kind: "AUDIT_EVIDENCE", profileHash: MC_PROFILE_HASH, candidateSetHash: MC_CANDIDATE_SET_HASH, cents: "9007199254740993" };
  const digest = platformDigestCiting(record, ["profileHash", "candidateSetHash"]);
  assert.equal(digest, sha256(canonicalize(record)));
  assert.equal(digest, platformDigestOfAgreed(record));
  // the identities are carried as the strings they are: another string gives another digest, a non-string or non-hex one is refused
  assert.notEqual(platformDigestCiting({ ...record, profileHash: "f".repeat(64) }, ["profileHash", "candidateSetHash"]), digest);
  assert.throws(() => platformDigestCiting({ ...record, profileHash: { hash: MC_PROFILE_HASH } }, ["profileHash"]), IdentityBridgeError);
  assert.throws(() => platformDigestCiting({ ...record, profileHash: MC_PROFILE_HASH.toUpperCase() }, ["profileHash"]), IdentityBridgeError);
});

test("C04 S047 DENY: re-hashing a core-native identity with the platform profile, or a platform digest with canonicalJsonText, is refused by the identity bridge", () => {
  const profileHash = MC_PROFILE_HASH;
  for (const [from, to] of [
    ["CORE_NATIVE", "PLATFORM"],
    ["PLATFORM", "CORE_NATIVE"],
    ["RAW_BYTES", "CORE_NATIVE"],
    ["CORE_NATIVE", "RAW_BYTES"],
    ["PLATFORM", "RAW_BYTES"],
    ["RAW_BYTES", "PLATFORM"],
  ] as const) {
    assert.throws(() => bridgeIdentity(from, to, profileHash), (e: unknown) => e instanceof IdentityBridgeError && e.from === from && e.to === to, `${from} -> ${to}`);
  }
  assert.throws(() => bridgeIdentity("PLATFORM", "PLATFORM", "not-a-digest"), IdentityBridgeError);
  assert.throws(() => citeCoreNativeIdentity(12345), IdentityBridgeError);
  assert.throws(() => citeCoreNativeIdentity(undefined), IdentityBridgeError);
});
