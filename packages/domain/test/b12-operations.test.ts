// B12's registry-less journaled operations (K2): one closed, duplicate-free list of PascalCase names that never collides with a catalogue id.
import assert from "node:assert/strict";
import { test } from "node:test";
import { B12_OPERATIONS, B12_OUTREACH_OPERATIONS, B12_PRODUCER_OPERATIONS, isB12Operation } from "../src/index.js";

test("B12 K2: the registry-less operations are an explicit duplicate-free list of names, none a catalogue id, with the ones the plan names", () => {
  assert.equal(new Set(B12_OPERATIONS).size, B12_OPERATIONS.length);
  assert.equal(B12_OPERATIONS.length, B12_OUTREACH_OPERATIONS.length + B12_PRODUCER_OPERATIONS.length);
  for (const name of B12_OPERATIONS) assert.match(name, /^[A-Z][A-Za-z]{5,59}$/, name);
  for (const name of ["PutOutreachContent", "PublishSalesResource", "RegisterSenderIdentity", "PrepareOutreachReview", "WithdrawOutreachChannelPolicy", "ChangePayoutDestination"]) assert.ok(isB12Operation(name), name);
  assert.equal(isB12Operation("CMD061"), false, "a catalogue id is not a registry-less operation");
  assert.equal(isB12Operation("putOutreachContent"), false);
  assert.equal(isB12Operation("constructor"), false, "an inherited object key is not an operation");
});
