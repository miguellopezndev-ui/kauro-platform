// Lane L-REFUND (DV1-11, ACH-ROUTE r12 §7.22c): the normalization destination-norm-v1 and the canonical encoding M of the destination
// fingerprint, against an oracle written here from the design text alone: enc(s) = 4-byte unsigned big-endian length of the UTF-8 bytes of s,
// then the bytes; M = enc("kauro.destination-fingerprint") ‖ enc(normVersion) ‖ enc(keyId) ‖ enc(decimal keyVersion) ‖ enc(routing) ‖
// enc(account) ‖ enc(holder); DF = HMAC-SHA256(key, M). The domain exports the two pure functions the lane implements:
//   normalizeDestination({ routingNumber, accountNumber, holderName }) -> { kind: "OK", routing, account, holder } | { kind: "INVALID" }
//   canonicalDestinationMessage({ normVersion, keyId, keyVersion }, { routing, account, holder }) -> Uint8Array
// (the keyed HMAC stays in the application's DestinationFingerprinter; the vectors use a fixed test key here).
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import * as domain from "../src/index.js";

type Normalized = { readonly kind: "OK"; readonly routing: string; readonly account: string; readonly holder: string } | { readonly kind: "INVALID" };
type Input = { readonly routingNumber: string; readonly accountNumber: string; readonly holderName: string };
const exported = domain as unknown as Record<string, unknown>;

function enc(s: string): Buffer {
  const bytes = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}
const UNDER = { normVersion: "destination-norm-v1", keyId: "test-key", keyVersion: 1 } as const;
const oracleM = (n: { routing: string; account: string; holder: string }): Buffer =>
  Buffer.concat([enc("kauro.destination-fingerprint"), enc(UNDER.normVersion), enc(UNDER.keyId), enc(String(UNDER.keyVersion)), enc(n.routing), enc(n.account), enc(n.holder)]);
const TEST_KEY = Buffer.from("kauro-test-destination-key-v1-0123456789abcdef", "utf8");
const hmac = (m: Uint8Array): string => createHmac("sha256", TEST_KEY).update(m).digest("hex");

test("OK destination-norm-v1 vectors: fixed inputs give fixed canonical bytes M and fixed fingerprints under a test key, including holders of 140 and 141 code points and the concatenation-collision pair", () => {
  assert.equal(typeof exported["normalizeDestination"], "function", "the domain exports normalizeDestination (destination-norm-v1)");
  assert.equal(typeof exported["canonicalDestinationMessage"], "function", "the domain exports canonicalDestinationMessage (DV1-11 canonical encoding)");
  assert.equal(exported["DESTINATION_NORM_VERSION"], "destination-norm-v1");
  const normalize = exported["normalizeDestination"] as (d: Input) => Normalized;
  const message = exported["canonicalDestinationMessage"] as (under: typeof UNDER, n: { routing: string; account: string; holder: string }) => Uint8Array;

  const vectors: ReadonlyArray<{ readonly input: Input; readonly expected: { routing: string; account: string; holder: string } | "INVALID" }> = [
    { input: { routingNumber: "021000021", accountNumber: "12341234", holderName: "Alice Smith" }, expected: { routing: "021000021", account: "12341234", holder: "alice smith" } },
    { input: { routingNumber: "021-000 021", accountNumber: "1234-1234", holderName: "  ALICE\t SMITH " }, expected: { routing: "021000021", account: "12341234", holder: "alice smith" } },
    { input: { routingNumber: "021000021", accountNumber: "0012341234", holderName: "Renée" }, expected: { routing: "021000021", account: "0012341234", holder: "renée" } },
    { input: { routingNumber: "021000021", accountNumber: "1", holderName: "Renée" }, expected: { routing: "021000021", account: "1", holder: "renée" } },
    { input: { routingNumber: "021000021", accountNumber: "12345678901234567", holderName: "Z".repeat(140) }, expected: { routing: "021000021", account: "12345678901234567", holder: "z".repeat(140) } },
    { input: { routingNumber: "021000021", accountNumber: "12341234", holderName: "Z".repeat(141) }, expected: "INVALID" },
    { input: { routingNumber: "021000022", accountNumber: "12341234", holderName: "A" }, expected: "INVALID" },
    { input: { routingNumber: "021000021", accountNumber: "123456789012345678", holderName: "A" }, expected: "INVALID" },
    { input: { routingNumber: "０２１００００２１", accountNumber: "1", holderName: "A" }, expected: "INVALID" },
    { input: { routingNumber: "021000021", accountNumber: "1", holderName: "A-B" }, expected: { routing: "021000021", account: "1", holder: "a-b" } },
  ];
  for (const v of vectors) {
    const n = normalize(v.input);
    if (v.expected === "INVALID") {
      assert.equal(n.kind, "INVALID", `${JSON.stringify(v.input)} is DESTINATION_INVALID`);
      continue;
    }
    assert.deepEqual(n, { kind: "OK", ...v.expected }, `${JSON.stringify(v.input)} normalizes`);
    const m = message(UNDER, v.expected);
    assert.equal(Buffer.from(m).toString("hex"), oracleM(v.expected).toString("hex"), `canonical bytes M of ${JSON.stringify(v.expected)}`);
  }
  // the concatenation-collision pair: one plain concatenation, two distinct M and two distinct fingerprints
  const a = { routing: "021000021", account: "12341234", holder: "1234m" };
  const b = { routing: "021000021", account: "123412341234", holder: "m" };
  assert.equal(a.routing + a.account + a.holder, b.routing + b.account + b.holder, "the pair collides under plain concatenation");
  assert.notEqual(Buffer.from(message(UNDER, a)).toString("hex"), Buffer.from(message(UNDER, b)).toString("hex"), "M is injective");
  assert.notEqual(hmac(message(UNDER, a)), hmac(message(UNDER, b)), "distinct fingerprints");
  // the fixed fingerprint of the first vector under the test key, computed from the oracle M
  assert.equal(hmac(message(UNDER, { routing: "021000021", account: "12341234", holder: "alice smith" })), hmac(oracleM({ routing: "021000021", account: "12341234", holder: "alice smith" })));
  // another key version never gives the same M
  assert.notEqual(Buffer.from(message({ ...UNDER, keyVersion: 2 } as never, a)).toString("hex"), Buffer.from(message(UNDER, a)).toString("hex"), "the key version is bound into M");
});
