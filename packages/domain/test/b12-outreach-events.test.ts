// B12's event vocabulary (lane K1b; plan docs/design/B12-outreach-plan.md rev 4 §1 CMD063: "One COMMIT: intent QUEUED + draft AUTHORIZED +
// event outreach.send_intended.v1 + outbox"): the closed registry lists, the allowlisted payload (ids, hashes and tokens only: no address,
// subject, body or message text), the one consumer, and the agency-less aggregate kind the database registry marks agency_scoped = false.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGGREGATE_KINDS,
  CONSUMERS,
  EVENT_PAYLOAD_ALLOWLIST,
  EVENT_SUBSCRIPTIONS,
  EVENT_TYPES,
  FAILURE_REASONS,
  OUTREACH_AGGREGATE_KINDS,
  OUTREACH_EVENT_PAYLOAD_ALLOWLIST,
  OUTREACH_EVENT_TYPES,
  OUTREACH_FAILURE_REASONS,
  UNSCOPED_AGGREGATE_KINDS,
  assertAllowlistedPayload,
  consumersOf,
} from "../src/index.js";

const ID = "0192a000-0000-7000-8000-0000000000a1";
const HASH = "a".repeat(64);
const PAYLOAD = { intentId: ID, draftId: ID, authorizationId: ID, senderId: ID, prospectId: ID, purpose: "INDIVIDUAL_PROSPECT_CONTACT", route: "GMAIL_API", payloadHash: HASH };

test("B12 K1b: outreach.send_intended.v1 is a registered event type of the agency-less aggregate kind outreach_send_intent, delivered to OUTREACH_SENDER alone", () => {
  assert.deepEqual([...OUTREACH_EVENT_TYPES], ["outreach.send_intended.v1"]);
  assert.deepEqual([...OUTREACH_AGGREGATE_KINDS], ["outreach_send_intent"]);
  assert.ok((EVENT_TYPES as ReadonlyArray<string>).includes("outreach.send_intended.v1"));
  assert.ok((AGGREGATE_KINDS as ReadonlyArray<string>).includes("outreach_send_intent"));
  assert.ok((CONSUMERS as ReadonlyArray<string>).includes("OUTREACH_SENDER"));
  assert.deepEqual(consumersOf("outreach.send_intended.v1"), ["OUTREACH_SENDER"]);
  assert.deepEqual(EVENT_SUBSCRIPTIONS.filter((s) => s.consumer === "OUTREACH_SENDER"), [{ eventType: "outreach.send_intended.v1", consumer: "OUTREACH_SENDER" }]);
  // the registry's agency_scoped = false kinds, mirrored (persistence proves the table agrees)
  assert.deepEqual([...UNSCOPED_AGGREGATE_KINDS], ["outreach_send_intent"]);
});

test("B12 K1b: the payload of outreach.send_intended.v1 is closed to ids, hashes and tokens: a recipient address, a subject or a body key is refused", () => {
  assert.deepEqual([...OUTREACH_EVENT_PAYLOAD_ALLOWLIST["outreach.send_intended.v1"]], ["intentId", "draftId", "authorizationId", "senderId", "prospectId", "purpose", "route", "payloadHash"]);
  assert.deepEqual(EVENT_PAYLOAD_ALLOWLIST["outreach.send_intended.v1"], OUTREACH_EVENT_PAYLOAD_ALLOWLIST["outreach.send_intended.v1"]);
  assertAllowlistedPayload("outreach.send_intended.v1", PAYLOAD);
  for (const key of ["address", "recipient", "subject", "body", "contactKey", "personUserId", "email"]) {
    assert.throws(() => assertAllowlistedPayload("outreach.send_intended.v1", { ...PAYLOAD, [key]: "x@example.com" }), /not allowlisted/, key);
  }
  assert.throws(() => assertAllowlistedPayload("outreach.send_intended.v1", { ...PAYLOAD, purpose: "hello there" }), /safe reference/);
});

test("B12 K1b: SENDER_REVOKED is a registered failure reason exactly once, at the tail of B12's list", () => {
  assert.equal((FAILURE_REASONS as ReadonlyArray<string>).filter((r) => r === "SENDER_REVOKED").length, 1);
  assert.equal(OUTREACH_FAILURE_REASONS[OUTREACH_FAILURE_REASONS.length - 1], "SENDER_REVOKED");
  assert.equal(FAILURE_REASONS[FAILURE_REASONS.length - 1], "SENDER_REVOKED");
});
