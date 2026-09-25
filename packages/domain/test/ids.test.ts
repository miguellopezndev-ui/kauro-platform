// Identity scheme (07 "Database representation"): server-generated UUIDv7 aggregate ids, deterministic UUIDv5 identity
// references. Independent oracle: the RFC 9562 layout (version nibble, variant bits, 48-bit big-endian timestamp).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createIdGenerator, encodeUuidV7, identityUserId, isUuidV5, isUuidV7, toUtcInstant, uuidV7Timestamp } from "../src/index.js";

test("encodeUuidV7 lays out timestamp, version and variant exactly", () => {
  const id = encodeUuidV7(0x018f_1234_abcd, new Uint8Array([0xff, 0x11, 0xff, 1, 2, 3, 4, 5, 6, 7]));
  assert.equal(id, "018f1234-abcd-7f11-bf01-020304050607");
  assert.ok(isUuidV7(id));
  assert.equal(uuidV7Timestamp(id), 0x018f_1234_abcd);
  assert.throws(() => encodeUuidV7(-1, new Uint8Array(10)), RangeError);
  assert.throws(() => encodeUuidV7(2 ** 48, new Uint8Array(10)), RangeError);
  assert.throws(() => encodeUuidV7(1, new Uint8Array(9)), RangeError);
});

test("the generator is monotonic inside one millisecond and never repeats", () => {
  let ms = 1_700_000_000_000;
  const clock = { now: () => toUtcInstant(ms), nowMs: () => ms };
  const gen = createIdGenerator(clock, (n) => new Uint8Array(randomBytes(n)));
  const ids: string[] = [];
  for (let i = 0; i < 5000; i++) ids.push(gen.next());
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i]! > ids[i - 1]!, `not monotonic at ${i}`);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.ok(isUuidV7(id));
  ms += 1;
  const later = gen.next();
  assert.ok(later > ids[ids.length - 1]!);
  assert.ok(uuidV7Timestamp(later) >= ms);
});

test("identityUserId is a deterministic UUIDv5 that differs per provider and subject", () => {
  const a = identityUserId("identity-platform", "subject-1");
  const b = identityUserId("identity-platform", "subject-1");
  const c = identityUserId("identity-platform", "subject-2");
  const d = identityUserId("other-idp", "subject-1");
  assert.equal(a, b);
  assert.ok(isUuidV5(a));
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.throws(() => identityUserId("Bad Provider", "x"), TypeError);
  assert.throws(() => identityUserId("idp", ""), TypeError);
});
