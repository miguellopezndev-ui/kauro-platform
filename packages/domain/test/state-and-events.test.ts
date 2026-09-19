// State-machine guards and the event vocabulary against the registry (reference/TRANSITIONS_AND_EVENT_EFFECTS.md: an
// unlisted edge is rejected; 07 "Outbox": payloads are allowlisted references and safe counts, never labels).
import assert from "node:assert/strict";
import { test } from "node:test";
import { STATE_MACHINES } from "@kauro/contracts";
import {
  DomainFailure,
  EVENT_PAYLOAD_ALLOWLIST,
  EVENT_SUBSCRIPTIONS,
  EVENT_TYPES,
  assertAllowlistedPayload,
  commandRequestDigest,
  consumersOf,
  findTransition,
  isTerminal,
  isUtcInstant,
  payloadDigest,
  statesOf,
  transition,
} from "../src/index.js";

test("listed edges resolve, unlisted edges are PRECONDITION_FAILED/UNLISTED_TRANSITION, terminal states have no exits", () => {
  assert.equal(transition("Agency", "DRAFT", "agreements_and_profile_accepted"), "ACTIVE");
  assert.equal(transition("Plan", "VALIDATED", "agency_approval"), "APPROVED");
  assert.equal(transition("Plan", "APPROVED", "withdraw_approval"), "WITHDRAWN");
  assert.equal(transition("Membership", "ACTIVE", "authorized_revocation"), "REVOKED");
  let caught: unknown;
  try {
    transition("Plan", "SUPERSEDED", "agency_approval");
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof DomainFailure);
  assert.equal(caught.code, "PRECONDITION_FAILED");
  assert.equal(caught.details.reason, "UNLISTED_TRANSITION");
  assert.equal(findTransition("Agency", "CLOSED", "owner_requests_closure"), null);
  // The registry lists cleanup edges between terminal states (DatasetRevision SUPERSEDED -> DELETED); a terminal state never
  // leads back to a non-terminal one.
  for (const m of STATE_MACHINES) {
    for (const t of m.terminal) {
      assert.ok(isTerminal(m.contract as "Agency", t));
      for (const x of m.transitions.filter((x) => x.from === t)) assert.ok(m.terminal.includes(x.to), `${m.contract}.${t} -> ${x.to} leaves a terminal state`);
    }
  }
  assert.deepEqual([...statesOf("Agency")].sort(), ["ACTIVE", "CLOSED", "CLOSING", "DRAFT", "RESTRICTED"]);
});

test("every subscription names a registered event type and every event type has an allowlist", () => {
  for (const s of EVENT_SUBSCRIPTIONS) assert.ok((EVENT_TYPES as ReadonlyArray<string>).includes(s.eventType), s.eventType);
  for (const t of EVENT_TYPES) assert.ok(EVENT_PAYLOAD_ALLOWLIST[t].length > 0, t);
  assert.deepEqual(consumersOf("approval.withdrawn.v1"), ["NOTIFICATIONS", "EXECUTION_CONTROL"]);
  assert.deepEqual(consumersOf("end_client.created.v1"), []);
});

test("payload allowlist refuses labels, unknown keys, nested objects and negative counts", () => {
  const agencyId = "01920000-0000-7000-8000-0000000000aa";
  assertAllowlistedPayload("agency.created.v1", { agencyId, createdByUserId: "6f1b0d2e-3c4a-5b5c-9d6e-7f8091a2b3c4", state: "DRAFT" });
  assert.throws(() => assertAllowlistedPayload("agency.created.v1", { agencyId, displayName: "Acme" }), /not allowlisted/);
  assert.throws(() => assertAllowlistedPayload("agency.created.v1", { agencyId, state: "a label with spaces" }), /not a safe reference/);
  assert.throws(() => assertAllowlistedPayload("end_client.archived.v1", { openProjects: -1 }), /not a safe reference/);
  assert.throws(() => assertAllowlistedPayload("approval.withdrawn.v1", { completedExternalActions: ["not-an-id"] }), /only ids or hashes/);
  assert.throws(() => assertAllowlistedPayload("agency.created.v1", { agencyId: { nested: true } as never }), /not a safe reference/);
  const digest = payloadDigest({ agencyId, state: "DRAFT" });
  assert.equal(digest, payloadDigest({ state: "DRAFT", agencyId }), "key order must not change the digest");
  assert.match(digest, /^[0-9a-f]{64}$/);
});

test("command request digest covers operation, aggregate and body under a domain-separated wrapper", () => {
  const a = commandRequestDigest({ operation: "CMD009", aggregate: { agencyId: "x" }, body: { displayName: "A", processingAuthorityRef: "p" } });
  const b = commandRequestDigest({ operation: "CMD009", aggregate: { agencyId: "x" }, body: { processingAuthorityRef: "p", displayName: "A" } });
  const c = commandRequestDigest({ operation: "CMD009", aggregate: { agencyId: "x" }, body: { displayName: "B", processingAuthorityRef: "p" } });
  const d = commandRequestDigest({ operation: "CMD009", aggregate: { agencyId: "y" }, body: { displayName: "A", processingAuthorityRef: "p" } });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.ok(isUtcInstant("2026-09-19T21:00:00.000Z"));
  assert.ok(!isUtcInstant("2026-02-30T00:00:00.000Z"));
  assert.ok(!isUtcInstant("2026-09-19T21:00:00Z"));
});
