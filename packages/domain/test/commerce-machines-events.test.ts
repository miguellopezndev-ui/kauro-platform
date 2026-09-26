// The B09 state machines and event vocabulary: the registry machines PaymentAttempt and TaxDocument are used exactly as vendored;
// the platform machines are closed, deterministic and cover the contract state vocabularies; every event type is registered with
// an allowlist and the payload rule of B06 still holds (reference/TRANSITIONS_AND_EVENT_EFFECTS; 07 "Outbox").
import assert from "node:assert/strict";
import { test } from "node:test";
import { STATE_MACHINES, registryJson } from "@kauro/contracts";
import {
  AGGREGATE_KINDS,
  COMMERCE_AGGREGATE_KINDS,
  COMMERCE_EVENT_TYPES,
  COMMERCE_FAILURE_REASONS,
  COMMERCE_PLATFORM_MACHINES,
  EVENT_PAYLOAD_ALLOWLIST,
  EVENT_SUBSCRIPTIONS,
  EVENT_TYPES,
  FAILURE_REASONS,
  assertAllowlistedPayload,
  consumersOf,
  machine,
  statesOf,
  transition,
} from "../src/index.js";

interface RegistryContract {
  name: string;
  fields: Array<{ name: string; type: string }>;
}

function enumOf(contract: string, field: string): string[] {
  const f = registryJson<RegistryContract[]>("contracts.json").find((c) => c.name === contract)?.fields.find((x) => x.name === field);
  assert.ok(f && f.type.startsWith("enum:"), `${contract}.${field}`);
  return f.type.slice(5).split(",");
}

test("PaymentAttempt and TaxDocument are the registry machines, edge for edge", () => {
  for (const name of ["PaymentAttempt", "TaxDocument"] as const) {
    const vendored = STATE_MACHINES.find((m) => m.contract === name);
    assert.ok(vendored);
    assert.equal(machine(name), vendored);
    for (const t of vendored.transitions) assert.equal(transition(name, t.from, t.event), t.to, `${name} ${t.from} --${t.event}-->`);
  }
  assert.deepEqual([...statesOf("PaymentAttempt")].sort(), [...enumOf("PaymentAttempt", "state")].sort());
  assert.deepEqual([...statesOf("TaxDocument")].sort(), [...enumOf("TaxDocument", "state")].sort());
});

test("platform machines: unique events per state, terminal states closed, contract vocabularies covered", () => {
  for (const m of COMMERCE_PLATFORM_MACHINES) {
    const keys = new Set<string>();
    for (const t of m.transitions) {
      const k = `${t.from}|${t.event}`;
      assert.ok(!keys.has(k), `${m.contract}: ${k} listed twice`);
      keys.add(k);
      assert.equal(transition(m.contract as "Quote", t.from, t.event), t.to);
    }
    for (const term of m.terminal) {
      for (const t of m.transitions.filter((x) => x.from === term)) assert.ok(m.terminal.includes(t.to), `${m.contract}.${term} leaves a terminal state`);
    }
  }
  assert.deepEqual([...statesOf("PaymentOrder")].sort(), [...enumOf("PaymentOrder", "state")].sort());
  assert.deepEqual([...statesOf("Refund")].sort(), [...enumOf("Refund", "state")].sort());
  assert.deepEqual([...statesOf("CaptureFact")].sort(), [...enumOf("CaptureFact", "status")].sort());
  // 07 "Quote and checkout states": DRAFT, ISSUED, ACCEPTED_FOR_CHECKOUT, EXPIRED, SUPERSEDED, WITHDRAWN
  assert.deepEqual([...statesOf("Quote")].sort(), ["ACCEPTED_FOR_CHECKOUT", "DRAFT", "EXPIRED", "ISSUED", "SUPERSEDED", "WITHDRAWN"]);
  assert.deepEqual([...statesOf("CommercialAuthorization")].sort(), ["ACTIVE", "CONSUMED", "DELIVERED", "REVOKED"]);
  assert.throws(() => transition("PaymentOrder", "CAPTURED", "capture_observed"), /no listed transition/);
  assert.throws(() => transition("Refund", "COMPLETED", "proved_no_effect"), /no listed transition/);
});

test("every B09 event type is registered with a non-empty allowlist; every commerce aggregate kind publishes; subscriptions are valid", () => {
  for (const t of COMMERCE_EVENT_TYPES) {
    assert.ok((EVENT_TYPES as ReadonlyArray<string>).includes(t), t);
    assert.ok(EVENT_PAYLOAD_ALLOWLIST[t].length > 0, t);
  }
  for (const kind of COMMERCE_AGGREGATE_KINDS) {
    assert.ok((AGGREGATE_KINDS as ReadonlyArray<string>).includes(kind));
    assert.ok(COMMERCE_EVENT_TYPES.some((t) => t.startsWith(`${kind}.`)), `${kind} has events`);
  }
  for (const s of EVENT_SUBSCRIPTIONS) assert.ok((EVENT_TYPES as ReadonlyArray<string>).includes(s.eventType), s.eventType);
  // one reconciled financial event, separate idempotent effects (TRANSITIONS "Cross-aggregate finalization")
  assert.deepEqual(consumersOf("capture.completed.v1"), ["FINANCE", "FISCAL", "COMMISSIONS"]);
  assert.deepEqual(consumersOf("refund.completed.v1"), ["FINANCE", "FISCAL", "COMMISSIONS", "NOTIFICATIONS"]);
  assert.deepEqual(consumersOf("commercial_authorization.revoked.v1"), ["EXECUTION_CONTROL", "NOTIFICATIONS"]);
  assert.deepEqual(consumersOf("refund.approved.v1"), ["PAYMENT_SERVICE"]);
  assert.deepEqual(consumersOf("payment_attempt.dispatching.v1"), ["PAYMENT_SERVICE"]);
});

test("commerce payloads carry ids, hashes, tokens and minor-unit counts — never a provider id, a label or a decimal string", () => {
  const ids = { captureId: "01920000-0000-7000-8000-0000000d0001", agencyId: "01920000-0000-7000-8000-0000000d0002", orderId: "01920000-0000-7000-8000-0000000d0003" };
  assertAllowlistedPayload("capture.completed.v1", { ...ids, amountCents: 97125, currency: "USD", allocatedServiceCents: 97125, allocatedTaxCents: 0, excessCents: 0, previousStatus: "PENDING", evidenceHash: "f".repeat(64) });
  assert.throws(() => assertAllowlistedPayload("capture.completed.v1", { ...ids, providerCaptureId: "3C679366HH908993F" }), /not allowlisted/);
  assert.throws(() => assertAllowlistedPayload("capture.completed.v1", { ...ids, amountCents: "97125" }), /not a safe reference/);
  assert.throws(() => assertAllowlistedPayload("capture.completed.v1", { ...ids, amountCents: -1 }), /not a safe reference/);
  // the refund's reasonCode is a label (CMD031; B06 D-API-1): no refund event may carry it, whatever its words
  for (const t of COMMERCE_EVENT_TYPES) assert.equal(EVENT_PAYLOAD_ALLOWLIST[t].includes("reasonCode"), false, t);
  assert.throws(() => assertAllowlistedPayload("refund.requested.v1", { refundId: ids.captureId, reasonCode: "THE_CUSTOMER_IS_UNHAPPY" }), /not allowlisted/);
});

test("the B09 failure reasons are appended to the closed taxonomy exactly once", () => {
  for (const r of COMMERCE_FAILURE_REASONS) {
    assert.ok((FAILURE_REASONS as ReadonlyArray<string>).includes(r), r);
    assert.match(r, /^[A-Z][A-Z0-9_]{2,63}$/);
  }
  assert.equal(new Set(FAILURE_REASONS).size, FAILURE_REASONS.length);
});
