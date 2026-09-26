// The B09 command specs, request schemas, response schemas and outcome catalogues against the vendored catalogue
// (registry/commands.json through @kauro/contracts COMMANDS, brand-mapped) and the generated registry bundle: method, path, role,
// gate and the exact field list; the closed request schemas compile under the strict validator's keyword vocabulary and refuse
// unknown members, numbers where money strings belong and server-owned members; the response schemas derive every registry
// member under the B06 rules (D-RESP-1), stay closed and admit the DTOs the design specifies; every outcome names a registered
// code and reason.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { COMMANDS } from "@kauro/contracts";
import { CHECKOUT_BLOCKERS, DISPATCH_DEADLINE_SECONDS, FAILURE_CODES, FAILURE_REASONS, RECONCILIATION_CASE_KINDS, SERVICE_ROLE_TABLE, serviceHoldsRole } from "@kauro/domain";
import {
  CHECKOUT_BLOCKER_TOKENS,
  COMMERCE_COMMAND_OUTCOMES,
  COMMERCE_COMMANDS,
  COMMERCE_READ_OUTCOMES,
  COMMERCE_READ_ROUTES,
  COMMERCE_REQUEST_SCHEMAS,
  DISPATCH_TIMEOUT_SECONDS,
  DISPATCH_WATCHDOG_MARGIN_SECONDS,
  RECONCILIATION_CASE_KIND_TOKENS,
  REQUEST_SCHEMA_PREFIX,
  buildCommerceResponseSchemas,
  commerceCommandResponseSchemaId,
  commerceReadResponseSchemaId,
  compileSchemaBundle,
  type RegistryBundle,
} from "../src/index.js";

const IN_SCOPE = ["CMD028", "CMD029", "CMD030", "CMD031", "CMD032", "CMD033", "CMD034"] as const;
const require = createRequire(import.meta.url);
const bundle = JSON.parse(readFileSync(require.resolve("@kauro/contracts/schemas.json"), "utf8")) as RegistryBundle;

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

test("principal, runtime role, scope and idempotency store follow the catalogue roles (member, corporate owner, service, provider)", () => {
  const byRole = {
    AGENCY_BILLING: ["AGENCY_MEMBER", "kauro_app", "AGENCY_HEADER", "TENANT"],
    KAURO_OWNER: ["CORPORATE_OPERATOR", "kauro_app", "STORED_OPERATION", "OPERATOR_IDENTITY"],
    PAYMENT_SERVICE: ["PAYMENT_SERVICE", "kauro_payment", "STORED_OPERATION", "TENANT"],
    AUTHENTICATED_PROVIDER: ["PROVIDER", "kauro_payment", "PROVIDER_INGRESS", "NONE"],
  } as const;
  for (const id of IN_SCOPE) {
    const spec = COMMERCE_COMMANDS[id];
    const [principal, runtimeRole, scope, journal] = byRole[spec.role];
    assert.equal(spec.principal, principal, id);
    assert.equal(spec.runtimeRole, runtimeRole, id);
    assert.equal(spec.scope, scope, id);
    assert.equal(spec.journalScope, journal, id);
    assert.equal(spec.idempotencyStore, spec.role === "AUTHENTICATED_PROVIDER" ? "PROVIDER_INBOX" : "COMMAND_JOURNAL", id);
    assert.equal(spec.scopeKind !== null, spec.scope === "STORED_OPERATION", id);
    assert.equal(spec.stepUp, id === "CMD032" ? "UNLESS_STANDING_POLICY" : "NEVER", id);
  }
  assert.deepEqual([COMMERCE_COMMANDS.CMD028.externalEffect, COMMERCE_COMMANDS.CMD029.externalEffect, COMMERCE_COMMANDS.CMD033.externalEffect], ["PROVIDER_CREATE_ORDER", "PROVIDER_CAPTURE", "PROVIDER_REFUND"]);
  assert.deepEqual([...COMMERCE_COMMANDS.CMD028.authorityHashFields], ["termsHash"]);
  // a service account has only its technical role (08): the table is code-owned and one role per identity
  assert.equal(serviceHoldsRole("payment-service", "PAYMENT_SERVICE"), true);
  assert.equal(serviceHoldsRole("payment-service", "AUTHENTICATED_PROVIDER"), false);
  assert.equal(serviceHoldsRole("provider-ingress", "PAYMENT_SERVICE"), false);
  assert.equal(serviceHoldsRole("constructor", "PAYMENT_SERVICE"), false, "an inherited object key is not a service identity");
  assert.equal(Object.keys(SERVICE_ROLE_TABLE).length, 3);
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
      if (f.type === "label") assert.equal(p["maxLength"], 200, "a label is 1..200 characters (B06 D-LABEL-1), never narrowed to a token (B06 D-API-1)");
    }
  }
});

test("the request schemas compile under the strict validator and refuse unknown members, coerced numbers and server-owned members", () => {
  const roots: Record<string, unknown> = {};
  for (const id of IN_SCOPE) roots[id] = COMMERCE_REQUEST_SCHEMAS[id];
  const compiled = compileSchemaBundle({ defs: {}, roots });
  const ok = (id: string, body: unknown) => assert.deepEqual(compiled.validate(id, body), [], `${id} ${JSON.stringify(body)}`);
  const codes = (id: string, body: unknown) => compiled.validate(id, body).map((e) => `${e.field}:${e.code}`);
  ok("CMD028", { termsHash: "a".repeat(64) });
  ok("CMD029", { providerApprovalRef: "5O190127TN364715T" });
  ok("CMD031", { reasonCode: "The customer cancelled before processing started", evidenceRef: "01920000-0000-7000-8000-0000000e0001" });
  ok("CMD032", { expectedVersion: 1, serviceCents: "97125", taxCents: "0", authorizationRef: "01920000-0000-7000-8000-0000000e0002" });
  // a label refuses control characters (B06 D-LABEL-1)
  assert.ok(codes("CMD031", { reasonCode: "line\u0007break", evidenceRef: "01920000-0000-7000-8000-0000000e0001" }).some((c) => c.startsWith("reasonCode:")));
  // money as a JSON number, a negative, a fraction, beyond 2^53: refused, never coerced (R2-058)
  assert.ok(codes("CMD032", { expectedVersion: 1, serviceCents: 97125, taxCents: "0", authorizationRef: "01920000-0000-7000-8000-0000000e0002" }).includes("serviceCents:TYPE"));
  for (const bad of ["-1", "971.25", "00", "12345678901234567"]) {
    assert.ok(codes("CMD032", { expectedVersion: 1, serviceCents: bad, taxCents: "0", authorizationRef: "01920000-0000-7000-8000-0000000e0002" }).some((c) => c.startsWith("serviceCents:")), bad);
  }
  // server-owned members are unknown here: a browser cannot claim a capture, a payment state or an amount of its own (S057)
  assert.ok(codes("CMD029", { providerApprovalRef: "5O190127TN364715T", captured: true, amountCents: "97125" }).includes("captured:UNKNOWN_FIELD"));
  assert.ok(codes("CMD028", { termsHash: "a".repeat(64), totalCents: "1" }).includes("totalCents:UNKNOWN_FIELD"));
  assert.ok(codes("CMD029", { providerApprovalRef: "<script>" }).some((c) => c.startsWith("providerApprovalRef:")));
});

// sample DTOs the design specifies (docs/design/B09-payments-fiscal.md §10.3), used as the schemas' positive controls
const ID = (n: number) => `01920000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const H = (c: string) => c.repeat(64);
const quote = {
  quoteId: ID(1), agencyId: ID(2), projectId: ID(3), revisionHash: H("a"), planHash: H("b"), billableUnits: 50000, mode: "HUBSPOT",
  pricePolicyVersion: "R2-INITIAL", discountPolicyVersion: "R2-INITIAL", baseServiceCents: "129500", discountCents: "32375", serviceCents: "97125",
  taxCents: "0", totalCents: "97125", currency: "USD", expiresAt: "2026-10-09T12:00:00.000Z", sourceAvailableUntil: "2026-10-01T12:00:00.000Z",
  termsHash: H("c"), version: 2, state: "ISSUED", discount: { bps: 2500, basis: "FOUNDING" }, taxTreatment: "EXEMPT_EXPORT",
  issuedAt: "2026-09-25T12:00:00.000Z", checkoutReady: false, checkoutBlockers: ["SOURCE_EXPIRED"], permittedActions: [],
};
const order = {
  orderId: ID(10), quoteId: ID(1), provider: "paypal", environment: "SANDBOX", expectedAmountCents: "97125", currency: "USD", state: "CREATED",
  version: 3, projectId: ID(3), paymentStatus: "PENDING", nextActions: ["APPROVE_AT_PROVIDER"], providerOrderId: "5O190127TN364715T",
  checkout: { approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T", providerOrderId: "5O190127TN364715T" },
  createdAt: "2026-09-25T12:00:00.000Z", updatedAt: "2026-09-25T12:00:01.000Z",
};
const capture = {
  captureId: ID(20), orderId: ID(10), environment: "SANDBOX", amountCents: "97125", currency: "USD", status: "COMPLETED",
  observedAt: "2026-09-25T12:01:00.000Z", allocated: { serviceCents: "97125", taxCents: "0", excessCents: "0" }, version: 1,
};
const authorization = {
  authorizationId: ID(30), agencyId: ID(2), projectId: ID(3), approvalHash: H("d"), quoteId: ID(1), captureId: ID(20), revisionHash: H("a"),
  planHash: H("b"), capabilityVersion: "R2-LAUNCH", createdAt: "2026-09-25T12:01:00.000Z", version: 1, state: "ACTIVE", mode: "HUBSPOT",
  billableUnits: 50000, honoredAfterPriceExpiry: false,
};
const refund = {
  refundId: ID(40), captureId: ID(20), serviceCents: "97125", taxCents: "0", reasonCode: "The customer cancelled before processing started",
  state: "REQUESTED", amountsBasis: "PROPOSED", version: 1, projectId: ID(3), orderId: ID(10), origin: "CUSTOMER_REQUEST",
  deliveryPhase: "PRE_EXECUTION", excessCents: "0", reviewRequired: true, requestedAt: "2026-09-26T09:00:00.000Z",
};

test("the B09 response schemas derive every registry member under the B06 rules, stay closed and admit the specified DTOs", () => {
  const { defs, roots } = buildCommerceResponseSchemas(bundle);
  const compiled = compileSchemaBundle({ defs: { ...bundle.$defs, ...defs }, roots });
  const ok = (id: string, body: unknown) => assert.deepEqual(compiled.validate(id, body), [], `${id} ${JSON.stringify(body).slice(0, 200)}`);
  const refused = (id: string, body: unknown) => assert.notDeepEqual(compiled.validate(id, body), [], `${id} must refuse ${JSON.stringify(body).slice(0, 200)}`);
  const completed = (data: unknown, version = 1) => ({ kind: "COMPLETED", version, replayed: false, data });
  ok(commerceCommandResponseSchemaId("CMD028"), completed({ order, quote: { ...quote, state: "ACCEPTED_FOR_CHECKOUT", version: 3 } }, 1));
  ok(commerceCommandResponseSchemaId("CMD029"), completed({ order: { ...order, state: "CAPTURED" }, capture, commercialAuthorization: authorization, authorizationBlockers: [] }, 5));
  ok(commerceCommandResponseSchemaId("CMD029"), completed({ order: { ...order, state: "CAPTURED" }, capture, authorizationBlockers: ["SOURCE_EXPIRED"] }, 5));
  ok(commerceCommandResponseSchemaId("CMD030"), completed({ received: true, inboxState: "APPLIED", duplicate: false, conflict: false }));
  ok(commerceCommandResponseSchemaId("CMD031"), completed({ refund }));
  const effects = { creditNoteRequired: true, serviceBasisAfterCents: "0", revokesAuthorization: true, remaining: { serviceCents: "0", taxCents: "0", excessCents: "0" }, effectsHash: H("e") };
  ok(commerceCommandResponseSchemaId("CMD032"), completed({ refund: { ...refund, state: "APPROVED", amountsBasis: "APPROVED", reviewRequired: false, version: 2 }, effects, authorizationKind: "OWNER_STEP_UP" }, 2));
  ok(commerceCommandResponseSchemaId("CMD033"), completed({ refund: { ...refund, state: "COMPLETED", amountsBasis: "APPROVED", reviewRequired: false, version: 4, completedAt: "2026-09-26T10:00:00.000Z" }, attemptState: "CONFIRMED" }, 4));
  ok(commerceCommandResponseSchemaId("CMD034"), completed({ order: { ...order, state: "CAPTURED" }, captures: [capture], commercialAuthorization: authorization, effects: [{ about: "CAPTURE", effect: "ADVANCED" }], openCases: [] }, 5));
  ok(commerceReadResponseSchemaId("GetQuote"), { kind: "READ", data: quote });
  ok(commerceReadResponseSchemaId("GetPaymentOrder"), { kind: "READ", data: { order, captures: [], taxDocuments: [] } });
  ok(commerceReadResponseSchemaId("GetRefund"), { kind: "READ", data: refund });
  ok(commerceReadResponseSchemaId("GetRefundReview"), { kind: "READ", data: { refund, capture, refundable: { serviceCents: "97125", taxCents: "0", excessCents: "0" }, termsHash: H("c"), applicablePolicies: [], proposedEffects: effects } });
  // closed: a member the views do not declare is refused (a provider id, the merchant, an evidence hash, the idempotency binding)
  refused(commerceReadResponseSchemaId("GetPaymentOrder"), { kind: "READ", data: { order: { ...order, merchantRef: ID(99) }, captures: [], taxDocuments: [] } });
  refused(commerceReadResponseSchemaId("GetPaymentOrder"), { kind: "READ", data: { order: { ...order, idempotencyHash: H("f") }, captures: [], taxDocuments: [] } });
  refused(commerceReadResponseSchemaId("GetPaymentOrder"), { kind: "READ", data: { order, captures: [{ ...capture, providerCaptureId: "3C679366HH908993F" }], taxDocuments: [] } });
  refused(commerceReadResponseSchemaId("GetRefund"), { kind: "READ", data: { ...refund, providerRefundId: "1JU08902781691411" } });
  // money is a MoneyMinorUnits string inside the exact envelope, never a number or a decimal
  refused(commerceReadResponseSchemaId("GetQuote"), { kind: "READ", data: { ...quote, totalCents: 97125 } });
  refused(commerceReadResponseSchemaId("GetQuote"), { kind: "READ", data: { ...quote, totalCents: "971.25" } });
  // a label that no request could have admitted is never answered either (control characters)
  refused(commerceReadResponseSchemaId("GetRefund"), { kind: "READ", data: { ...refund, reasonCode: "a\u0000b" } });
});

test("every B09 outcome names a registered failure code and reason, and every command and read has its catalogue", () => {
  const codes = new Set<string>(FAILURE_CODES);
  const reasons = new Set<string>(FAILURE_REASONS);
  for (const id of IN_SCOPE) assert.ok(COMMERCE_COMMAND_OUTCOMES[id].length > 0, id);
  for (const op of Object.keys(COMMERCE_READ_ROUTES) as Array<keyof typeof COMMERCE_READ_ROUTES>) assert.ok(COMMERCE_READ_OUTCOMES[op].length > 0, op);
  for (const list of [...Object.values(COMMERCE_COMMAND_OUTCOMES), ...Object.values(COMMERCE_READ_OUTCOMES)]) {
    const seen = new Set<string>();
    for (const o of list) {
      assert.ok(codes.has(o.code), o.code);
      if (o.reason !== null) assert.ok(reasons.has(o.reason), o.reason);
      const key = `${o.code}/${o.reason ?? "-"}`;
      assert.ok(!seen.has(key), `${key} listed twice in one catalogue`);
      seen.add(key);
    }
  }
  // the S057 boundary: a capture command never answers success on a browser echo it cannot match
  assert.ok(COMMERCE_COMMAND_OUTCOMES.CMD029.some((o) => o.reason === "PROVIDER_REFERENCE_MISMATCH"));
  // CMD032: a standing policy is referenced, never invented; otherwise a fresh step-up of the approver
  assert.ok(COMMERCE_COMMAND_OUTCOMES.CMD032.some((o) => o.code === "ASSURANCE_REQUIRED" && o.reason === "POLICY_NOT_APPLICABLE"));
});

test("B09-F1/B09-F5/B09-F6: a provider effect is settled by the payment service; checkout and capture answer CAPACITY_UNAVAILABLE without deliverable capacity; an approval whose tax does not follow its service is refused", () => {
  // the settle step (T3) of every provider-effect command runs under kauro_payment, whatever principal asked for the effect
  for (const id of IN_SCOPE) {
    const spec = COMMERCE_COMMANDS[id];
    assert.equal(spec.settleRuntimeRole, spec.externalEffect === "NONE" ? null : "kauro_payment", id);
  }
  for (const id of ["CMD028", "CMD029"] as const) {
    assert.ok(COMMERCE_COMMAND_OUTCOMES[id].some((o) => o.code === "CAPACITY_UNAVAILABLE" && o.reason === "DELIVERY_CAPACITY_UNAVAILABLE" && o.layer === "COMMAND"), id);
  }
  assert.ok(COMMERCE_COMMAND_OUTCOMES.CMD032.some((o) => o.code === "PRECONDITION_FAILED" && o.reason === "REFUND_TAX_INCONSISTENT"));
});

test("B09-N2: the closed views admit every token the domain can put in them — checkout and authorization blockers (DELIVERY_CAPACITY_UNAVAILABLE included) and open case kinds (DISPUTE_OPEN included) are the domain's own vocabularies; B09-N7: the claim deadline's bound is the protocol's timeout plus the watchdog margin", () => {
  assert.deepEqual([...CHECKOUT_BLOCKER_TOKENS], [...CHECKOUT_BLOCKERS]);
  assert.deepEqual([...RECONCILIATION_CASE_KIND_TOKENS], [...RECONCILIATION_CASE_KINDS]);
  assert.ok(CHECKOUT_BLOCKERS.includes("DELIVERY_CAPACITY_UNAVAILABLE") && RECONCILIATION_CASE_KINDS.includes("DISPUTE_OPEN"));
  const { defs, roots } = buildCommerceResponseSchemas(bundle);
  const compiled = compileSchemaBundle({ defs: { ...bundle.$defs, ...defs }, roots });
  const ok = (id: string, body: unknown) => assert.deepEqual(compiled.validate(id, body), [], `${id} ${JSON.stringify(body).slice(0, 240)}`);
  const completed = (data: unknown, version = 1) => ({ kind: "COMPLETED", version, replayed: false, data });
  // every blocker the domain emits, all at once and in check order, answers through the send guard (maxItems is the vocabulary's size)
  ok(commerceReadResponseSchemaId("GetQuote"), { kind: "READ", data: { ...quote, checkoutBlockers: [...CHECKOUT_BLOCKERS] } });
  ok(commerceReadResponseSchemaId("GetQuote"), { kind: "READ", data: { ...quote, checkoutBlockers: ["DELIVERY_CAPACITY_UNAVAILABLE"] } });
  ok(commerceCommandResponseSchemaId("CMD029"), completed({ order: { ...order, state: "CAPTURED" }, capture, authorizationBlockers: ["DELIVERY_CAPACITY_UNAVAILABLE"] }, 5));
  for (const kind of RECONCILIATION_CASE_KINDS) {
    ok(commerceCommandResponseSchemaId("CMD034"), completed({ order: { ...order, state: "CAPTURED" }, captures: [capture], commercialAuthorization: authorization, effects: [{ about: "CAPTURE", effect: "NO_CHANGE" }], openCases: [{ caseId: ID(50), kind }] }, 5));
  }
  assert.notDeepEqual(compiled.validate(commerceReadResponseSchemaId("GetQuote"), { kind: "READ", data: { ...quote, checkoutBlockers: ["NOT_A_BLOCKER"] } }), []);
  assert.equal(DISPATCH_TIMEOUT_SECONDS + DISPATCH_WATCHDOG_MARGIN_SECONDS, DISPATCH_DEADLINE_SECONDS);
});
