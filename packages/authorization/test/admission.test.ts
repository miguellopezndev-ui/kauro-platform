// The admission limiter (08 "Abuse controls"; D-CMD-1 / Q2): sliding windows per identity and per client address with a
// retry-after, bounded memory, and independence between subjects.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { UserId } from "@kauro/domain";
import { fixedClock } from "@kauro/application";
import { DEFAULT_ADMISSION_LIMITS, createAdmissionLimiter } from "../src/index.js";

const alice = "alice" as UserId;
const bob = "bob" as UserId;

test("the identity window admits `limit` requests, refuses the next with a retry-after, and reopens after the window", async () => {
  const clock = fixedClock();
  const limiter = createAdmissionLimiter({ perIdentity: { limit: 2, windowSeconds: 60 }, perAddress: { limit: 100, windowSeconds: 60 }, maxTrackedSubjects: 10 });
  assert.deepEqual(await limiter.admit("CMD001", { userId: alice, agencyId: null }, clock.now()), { kind: "ADMITTED" });
  clock.advance(10_000);
  assert.deepEqual(await limiter.admit("CMD001", { userId: alice, agencyId: null }, clock.now()), { kind: "ADMITTED" });
  clock.advance(10_000);
  assert.deepEqual(await limiter.admit("CMD001", { userId: alice, agencyId: null }, clock.now()), { kind: "LIMITED", reason: "CREATION_RATE_LIMITED", retryAfterSeconds: 40 });
  assert.deepEqual(await limiter.admit("CMD001", { userId: bob, agencyId: null }, clock.now()), { kind: "ADMITTED" }, "another identity is another window");
  assert.deepEqual(await limiter.admit("CMD009", { userId: alice, agencyId: null }, clock.now()), { kind: "ADMITTED" }, "another operation is another window");
  clock.advance(40_000);
  assert.deepEqual(await limiter.admit("CMD001", { userId: alice, agencyId: null }, clock.now()), { kind: "ADMITTED" }, "the oldest stamp left the window");
});

test("the address window applies across identities when the transport supplies the hashed address", async () => {
  const clock = fixedClock();
  const limiter = createAdmissionLimiter({ perIdentity: { limit: 100, windowSeconds: 60 }, perAddress: { limit: 2, windowSeconds: 60 }, maxTrackedSubjects: 10 });
  const addr = "a".repeat(64);
  assert.equal((await limiter.admit("CMD001", { userId: alice, agencyId: null, clientAddressHash: addr }, clock.now())).kind, "ADMITTED");
  assert.equal((await limiter.admit("CMD001", { userId: bob, agencyId: null, clientAddressHash: addr }, clock.now())).kind, "ADMITTED");
  const third = await limiter.admit("CMD001", { userId: "carol" as UserId, agencyId: null, clientAddressHash: addr }, clock.now());
  assert.equal(third.kind, "LIMITED");
  assert.equal((await limiter.admit("CMD001", { userId: "carol" as UserId, agencyId: null, clientAddressHash: "b".repeat(64) }, clock.now())).kind, "ADMITTED");
});

test("memory stays bounded: subjects beyond maxTrackedSubjects are swept, oldest first; defaults and invalid limits", async () => {
  const clock = fixedClock();
  const limiter = createAdmissionLimiter({ perIdentity: { limit: 1, windowSeconds: 60 }, perAddress: { limit: 1, windowSeconds: 60 }, maxTrackedSubjects: 3 });
  for (const u of ["u1", "u2", "u3", "u4", "u5"]) assert.equal((await limiter.admit("CMD001", { userId: u as UserId, agencyId: null }, clock.now())).kind, "ADMITTED");
  // u1 was swept to keep the table bounded, so it is admitted again; u5 is still tracked
  assert.equal((await limiter.admit("CMD001", { userId: "u1" as UserId, agencyId: null }, clock.now())).kind, "ADMITTED");
  assert.equal((await limiter.admit("CMD001", { userId: "u5" as UserId, agencyId: null }, clock.now())).kind, "LIMITED");
  assert.equal(DEFAULT_ADMISSION_LIMITS.perIdentity.limit, 5);
  assert.throws(() => createAdmissionLimiter({ ...DEFAULT_ADMISSION_LIMITS, perIdentity: { limit: 0, windowSeconds: 10 } }), RangeError);
  await assert.rejects(limiter.admit("CMD001", { userId: alice, agencyId: null }, "not-a-time"), RangeError);
});
