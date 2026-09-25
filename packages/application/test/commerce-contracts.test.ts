// The B09 command specs and request schemas against the vendored catalogue (registry/commands.json through @kauro/contracts
// COMMANDS, brand-mapped): method, path, role, gate and the exact field list; the closed schemas compile under the strict
// validator's keyword vocabulary and refuse unknown members, numbers where money strings belong and server-owned members.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS } from "@kauro/contracts";
import { COMMERCE_COMMANDS, COMMERCE_REQUEST_SCHEMAS, REQUEST_SCHEMA_PREFIX, SERVICE_ROLES, compileSchemaBundle } from "../src/index.js";

const IN_SCOPE = ["CMD028", "CMD029", "CMD030", "CMD031", "CMD032", "CMD033", "CMD034"] as const;

test("every B09 spec matches its catalogue entry: name, method, path, role, gate, idempotency and fields in order", () => {
  for (const id of IN_SCOPE) {
    const catalogue = COMMANDS.find((c) => c.id === id);
    assert.ok(catalogue, id);
    const spec = COMMERCE_COMMANDS[id];
    assert.equal(spec.id, catalogue.id);
    assert.equal(spec.name, catalogue.name);
    assert.equal(spec.method, catalogue.method);
    assert.equal(spec.path, catalogue.path);
    assert.equal(spec.role, catalogue.role, `${id} role (the generator emits the Kauro identifiers, amendment A2)`);
    assert.deepEqual([...spec.fields], catalogue.fields.map((f) => f.name), `${id} fields`);
    assert.equal(catalogue.gate, "G-PAYMENT");
    assert.equal(catalogue.idempotency, "REQUIRED");
    assert.deepEqual([...(catalogue.testIds ?? [])], [`${id}-OK`, `${id}-DENY`, `${id}-RACE`]);
    assert.ok(spec.path.includes(`{${spec.aggregateParam}}`), id);
    assert.equal(spec.expectedVersionRequired, catalogue.fields.some((f) => f.name === "expectedVersion"), id);
  }
});

test("principal, scope and idempotency store follow the catalogue roles (member, corporate owner, service, provider)", () => {
  const byRole = { AGENCY_BILLING: ["AGENCY_MEMBER", "AGENCY_HEADER", "TENANT"], KAURO_OWNER: ["CORPORATE_OPERATOR", "STORED_OPERATION", "OPERATOR_IDENTITY"], PAYMENT_SERVICE: ["PAYMENT_SERVICE", "STORED_OPERATION", "TENANT"], AUTHENTICATED_PROVIDER: ["PROVIDER", "PROVIDER_INGRESS", "NONE"] } as const;
  for (const id of IN_SCOPE) {
    const spec = COMMERCE_COMMANDS[id];
    const [principal, scope, journal] = byRole[spec.role];
    assert.equal(spec.principal, principal, id);
    assert.equal(spec.scope, scope, id);
    assert.equal(spec.journalScope, journal, id);
    assert.equal(spec.idempotencyStore, spec.role === "AUTHENTICATED_PROVIDER" ? "PROVIDER_INBOX" : "COMMAND_JOURNAL", id);
    assert.equal(spec.scopeKind !== null, spec.scope === "STORED_OPERATION", id);
  }
  assert.deepEqual([COMMERCE_COMMANDS.CMD028.externalEffect, COMMERCE_COMMANDS.CMD029.externalEffect, COMMERCE_COMMANDS.CMD033.externalEffect], ["PROVIDER_CREATE_ORDER", "PROVIDER_CAPTURE", "PROVIDER_REFUND"]);
  assert.deepEqual([...COMMERCE_COMMANDS.CMD028.authorityHashFields], ["termsHash"]);
  assert.deepEqual(SERVICE_ROLES["payment-service"], ["PAYMENT_SERVICE"]);
});

test("request schemas are closed 2020-12 objects whose properties are exactly the catalogue fields, typed by the field vocabulary", () => {
  const typeOf: Record<string, string> = { label: "string", id: "string", version: "integer", hash: "string", money: "string", text: "string" };
  for (const id of IN_SCOPE) {
    const catalogue = COMMANDS.find((c) => c.id === id)!;
    const s = COMMERCE_REQUEST_SCHEMAS[id];
    assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(s.$id, `${REQUEST_SCHEMA_PREFIX}${id}`);
    assert.equal(s.additionalProperties, false, `${id} must reject unknown fields (R2-059)`);
    assert.deepEqual(Object.keys(s.properties), catalogue.fields.map((f) => f.name), `${id} properties`);
    assert.deepEqual([...s.required], catalogue.fields.map((f) => f.name), `${id}: every catalogue field is required`);
    for (const f of catalogue.fields) {
      const p = s.properties[f.name]!;
      assert.equal(p["type"], typeOf[f.type], `${id}.${f.name} (${f.type})`);
      assert.ok(!("default" in p), `${id}.${f.name} must not default`);
      if (f.type === "money") assert.equal(p["pattern"], "^(0|[1-9][0-9]{0,15})$", "money is a MoneyMinorUnits decimal string, never a JSON number");
    }
  }
});

test("the schemas compile under the strict validator and refuse unknown members, coerced numbers and server-owned members", () => {
  const roots: Record<string, unknown> = {};
  for (const id of IN_SCOPE) roots[id] = COMMERCE_REQUEST_SCHEMAS[id];
  const compiled = compileSchemaBundle({ defs: {}, roots });
  const ok = (id: string, body: unknown) => assert.deepEqual(compiled.validate(id, body), [], `${id} ${JSON.stringify(body)}`);
  const codes = (id: string, body: unknown) => compiled.validate(id, body).map((e) => `${e.field}:${e.code}`);
  ok("CMD028", { termsHash: "a".repeat(64) });
  ok("CMD029", { providerApprovalRef: "5O190127TN364715T" });
  ok("CMD031", { reasonCode: "CUSTOMER_CANCELLATION_BEFORE_PROCESSING", evidenceRef: "01920000-0000-7000-8000-0000000e0001" });
  ok("CMD032", { expectedVersion: 1, serviceCents: "97125", taxCents: "0", authorizationRef: "01920000-0000-7000-8000-0000000e0002" });
  // money as a JSON number, a negative, a fraction: refused, never coerced (R2-058)
  assert.ok(codes("CMD032", { expectedVersion: 1, serviceCents: 97125, taxCents: "0", authorizationRef: "01920000-0000-7000-8000-0000000e0002" }).includes("serviceCents:TYPE"));
  assert.ok(codes("CMD032", { expectedVersion: 1, serviceCents: "-1", taxCents: "0", authorizationRef: "01920000-0000-7000-8000-0000000e0002" }).some((c) => c.startsWith("serviceCents:")));
  assert.ok(codes("CMD032", { expectedVersion: 1, serviceCents: "971.25", taxCents: "0", authorizationRef: "01920000-0000-7000-8000-0000000e0002" }).some((c) => c.startsWith("serviceCents:")));
  // server-owned members are unknown here: a browser cannot claim a capture, a payment state or an amount of its own (S057)
  assert.ok(codes("CMD029", { providerApprovalRef: "5O190127TN364715T", captured: true, amountCents: "97125" }).includes("captured:UNKNOWN_FIELD"));
  assert.ok(codes("CMD028", { termsHash: "a".repeat(64), totalCents: "1" }).includes("totalCents:UNKNOWN_FIELD"));
  assert.ok(codes("CMD029", { providerApprovalRef: "<script>" }).some((c) => c.startsWith("providerApprovalRef:")));
});
