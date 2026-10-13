// The strict schema validator (10 "Version and validation": closed objects, no coercion, no defaults; 10 "Schema format
// execution": calendar date-time assertions with 2026-02-30 as the rejection control; S093: only application-owned schemas
// compile; R2-058: a string "false" is not a boolean; R2-059: unknown members reject).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CONTRACT_NAMES } from "@kauro/contracts";
import { DomainFailure } from "@kauro/domain";
import type { CommerceReadOperationId, CommerceServedCommandId, CommercialReadOperationId, CommercialServedCommandId, ContractSchemaBundle } from "../src/index.js";
import { ACCEPTED_RESPONSE_SCHEMA_ID, AUDIT_REQUEST_SCHEMA_IDS, SESSION_ROUTES, operationalRequestSchemaId, COMMAND_RESPONSES, COMMERCE_COMMAND_RESPONSES, COMMERCE_READ_ROUTES, COMMERCE_REQUEST_SCHEMAS, COMMERCIAL_COMMAND_RESPONSES, COMMERCIAL_READ_ROUTES, COMMERCIAL_REQUEST_SCHEMAS, DECISION_ARTIFACT_SCHEMA_ID, EXECUTION_REQUEST_SCHEMA_IDS, INTAKE_OPERATION_IDS, OPERATIONAL_ROUTES, PROBLEM_SCHEMA, READ_OPERATION_IDS, REQUEST_SCHEMA_IDS, REQUEST_SCHEMA_PREFIX, SELECTION_MANIFEST_SCHEMA_ID, SERVED_COMMAND_IDS, SOURCE_REQUEST_SCHEMA_IDS, commerceCommandResponseSchemaId, commerceReadResponseSchemaId, commercialCommandResponseSchemaId, commercialReadResponseSchemaId, intakeResponseSchemaId, readResponseSchemaId, SchemaCompileError, commandResponseSchemaId, compileSchemaBundle, createSchemaValidator, isCalendarDateTime, operationalResponseSchemaId, problemOf } from "../src/index.js";

const bundle = JSON.parse(readFileSync(new URL(import.meta.resolve("@kauro/contracts/schemas.json")), "utf8")) as ContractSchemaBundle;
const validator = createSchemaValidator(bundle);

test("the validator compiles exactly the 73 contracts, the 16 request schemas and the selection manifest document, the 16 COMPLETED envelopes and ACCEPTED, the 3 declared replies of the probes, the 4 reply bodies and 2 request bodies of the session routes (B11 W2), the 2 reply bodies and 1 request body of the public routes (B11 W5b), the 7 reply bodies and 5 request bodies of the bank-route operations (PV1), the 7 reply bodies and 5 request bodies of the inbound side (PV1-INBOUND), the 16 read replies, the intake replies, the 7 payment request schemas with their 7 command replies and 4 read replies (B09), the B08 and B10 schemas, and Problem, and nothing else", () => {
  const operationalIds = OPERATIONAL_ROUTES.flatMap((route) => Object.entries(route.responses).filter(([, r]) => r.schema !== null).map(([status]) => operationalResponseSchemaId(route.operationId, status)));
  const probeIds = OPERATIONAL_ROUTES.filter((route) => !route.path.startsWith("/api/v1/")).flatMap((route) => Object.keys(route.responses));
  const sessionIds = SESSION_ROUTES.flatMap((route) => Object.entries(route.responses).filter(([, r]) => r.schema !== null).map(([status]) => status));
  assert.equal(probeIds.length, 3, "the probes declare three replies: /livez 200, /readyz 200 and 503");
  assert.equal(sessionIds.length, 4, "the session routes four reply bodies (their logout answers 204 without one)");
  assert.equal(operationalIds.length, 24, "and the public routes one reply body each (the publication 200, the inquiry 201), the seven PV1 bank-route replies (configure 201; verify, enable, disable, replace-details, get route, transfer-instructions 200), and the seven inbound replies (retire, confirm, attribute, get credit, match keys 200; enter credit, statement import 201), and the settlement observation reply (201)");
  const operationalRequestIds = OPERATIONAL_ROUTES.filter((route) => route.request !== undefined).map((route) => operationalRequestSchemaId(route.operationId));
  assert.deepEqual(operationalRequestIds, [operationalRequestSchemaId("openSession"), operationalRequestSchemaId("createStepUp"), operationalRequestSchemaId("createInquiry"), ...["configureBankRoute", "verifyBankRoute", "enableBankRoute", "disableBankRoute", "replaceBankRouteDetails"].map(operationalRequestSchemaId), ...["retireBankCheckout", "enterBankCredit", "confirmBankCredit", "attributeBankCredit", "importBankStatement", "recordBankSettlement"].map(operationalRequestSchemaId)], "the identity token of a sign-in and of a step-up, the fit inquiry, the five PV1 bank-route command bodies, the five inbound command bodies and the settlement observation body");
  const readIds = READ_OPERATION_IDS.map(readResponseSchemaId);
  assert.equal(readIds.length, 16, "the five manual-10 reads (N16), the two support reads (B11 W4), the seven source reads (B07 design §9.1), GetJob and GetAudit (B08 design §12)");
  const completedIds = SERVED_COMMAND_IDS.filter((command) => COMMAND_RESPONSES[command].view !== null).map(commandResponseSchemaId);
  assert.equal(completedIds.length, 20, "every served command but CMD014, CMD036, CMD020 and CMD024, answered ACCEPTED (B07 D-RUN-1, B08 D8-API-1); CMD044 of B11 W4 and B17's CMD018/CMD019 and CMD040/CMD041 among them");
  const intakeIds = INTAKE_OPERATION_IDS.map(intakeResponseSchemaId);
  assert.equal(intakeIds.length, 2, "the selection manifest intake (B07 D-SEL-2) and the decision artifact intake (B08 D8-CMA-7)");
  // package B09 (D-REQ-B7): the payment catalogue's closed request schemas and the envelopes of its replies and reads
  const commerceRequestIds = Object.keys(COMMERCE_REQUEST_SCHEMAS).map((command) => `${REQUEST_SCHEMA_PREFIX}${command}`);
  const commerceResponseIds = [...(Object.keys(COMMERCE_COMMAND_RESPONSES) as CommerceServedCommandId[]).map(commerceCommandResponseSchemaId), ...(Object.keys(COMMERCE_READ_ROUTES) as CommerceReadOperationId[]).map(commerceReadResponseSchemaId)];
  assert.deepEqual([commerceRequestIds.length, commerceResponseIds.length], [7, 11]);
  // package B10 (design §13): the twelve commercial commands' request schemas and replies and the statement read's reply
  const commercialRequestIds = Object.keys(COMMERCIAL_REQUEST_SCHEMAS).map((command) => `${REQUEST_SCHEMA_PREFIX}${command}`);
  const commercialResponseIds = [...(Object.keys(COMMERCIAL_COMMAND_RESPONSES) as CommercialServedCommandId[]).map(commercialCommandResponseSchemaId), ...(Object.keys(COMMERCIAL_READ_ROUTES) as CommercialReadOperationId[]).map(commercialReadResponseSchemaId)];
  assert.deepEqual([commercialRequestIds.length, commercialResponseIds.length], [16, 17]);
  const responseIds = [...completedIds, ACCEPTED_RESPONSE_SCHEMA_ID, ...operationalIds, ...readIds, ...intakeIds, ...commerceResponseIds, ...commercialResponseIds];
  const requestIds = [...REQUEST_SCHEMA_IDS, ...SOURCE_REQUEST_SCHEMA_IDS, ...EXECUTION_REQUEST_SCHEMA_IDS, ...AUDIT_REQUEST_SCHEMA_IDS, SELECTION_MANIFEST_SCHEMA_ID, DECISION_ARTIFACT_SCHEMA_ID, ...commerceRequestIds, ...commercialRequestIds, ...operationalRequestIds];
  assert.equal(requestIds.length, 63, "B17's CMD018/CMD019 and CMD040/CMD041 request schemas, seven B06, six B07 and six B08 request schemas, B11's CMD044, the selection manifest and decision artifact documents, seven B09, twelve B10 and two operations request schemas, the two session bodies, the inquiry, the five PV1 bank-route bodies, the five inbound bodies and the settlement observation body");
  assert.equal(validator.knownSchemaIds.length, CONTRACT_NAMES.length + requestIds.length + responseIds.length + 1);
  for (const id of operationalRequestIds) assert.ok(validator.knownSchemaIds.includes(id), id);
  for (const n of CONTRACT_NAMES) assert.ok(validator.knownSchemaIds.includes(n), n);
  for (const id of requestIds) assert.ok((validator.knownSchemaIds as ReadonlyArray<string>).includes(id), id);
  for (const id of responseIds) assert.ok((validator.knownSchemaIds as ReadonlyArray<string>).includes(id), id);
  assert.ok(validator.knownSchemaIds.includes("Problem"));
  assert.throws(() => validator.validate("customer-target-metadata" as never, {}), (e: unknown) => e instanceof DomainFailure && e.code === "INTEGRITY_FAILURE");
});

test("a schema with a keyword the validator cannot enforce, a foreign $ref, an unknown format or an open extension map is refused at compile time", () => {
  const refuse = (schema: unknown, fragment: string) =>
    assert.throws(() => compileSchemaBundle({ defs: {}, roots: { x: schema } }), (e: unknown) => e instanceof SchemaCompileError && e.message.includes(fragment), JSON.stringify(schema));
  refuse({ type: "object", patternProperties: { "^x": {} } }, "unsupported keyword patternProperties");
  refuse({ type: "object", default: {} }, "unsupported keyword default");
  refuse({ allOf: [] }, "unsupported keyword allOf");
  refuse({ $ref: "https://example.com/schema.json" }, "unsupported $ref");
  refuse({ $ref: "#/$defs/Missing" }, "unknown definition");
  refuse({ type: "string", format: "email" }, "no asserted implementation");
  refuse({ type: "object", additionalProperties: { type: "string" } }, "additionalProperties must be a boolean");
  refuse({ type: "object", properties: { a: { type: "object", $defs: {} } } }, "$defs is only accepted on a bundle root");
});

test("R2-059: unknown members reject with their names and no value; R2-058: a string is not a boolean, a string is not an integer, nothing is coerced or defaulted", () => {
  const r = validator.validate("urn:kauro:api:v1:request:CMD011", { mode: "CLEAN", purpose: "Import", verified: true, agencyOwner: true });
  assert.equal(r.kind, "INVALID");
  if (r.kind === "INVALID") assert.deepEqual(r.fields, [{ field: "verified", code: "UNKNOWN_FIELD" }, { field: "agencyOwner", code: "UNKNOWN_FIELD" }]);
  const proof = {
    provider: "HUBSPOT",
    instanceId: "i",
    objectApiName: "Contact",
    fieldApiName: "email",
    caseSensitive: "false",
    nullBehavior: "EXCLUDE",
    completeScope: true,
    contractHash: "a".repeat(64),
    evidenceHash: "b".repeat(64),
    observedAt: "2026-09-19T12:00:00.000Z",
    operation: "MATCH",
  };
  const p = validator.validate("UniquenessProof", proof);
  assert.equal(p.kind, "INVALID");
  if (p.kind === "INVALID") assert.deepEqual(p.fields, [{ field: "caseSensitive", code: "TYPE" }]);
  assert.equal(validator.validate("UniquenessProof", { ...proof, caseSensitive: false }).kind, "VALID");
  const v = validator.validate("urn:kauro:api:v1:request:CMD010", { expectedVersion: "2" });
  assert.equal(v.kind, "INVALID");
  if (v.kind === "INVALID") assert.deepEqual(v.fields, [{ field: "expectedVersion", code: "TYPE" }]);
  const missing = validator.validate("urn:kauro:api:v1:request:CMD025", { expectedVersion: 1, planHash: "a".repeat(64), validationReceiptHash: "b".repeat(64), assuranceProofRef: "018f0000-0000-7000-8000-000000000001" });
  assert.equal(missing.kind, "INVALID");
  if (missing.kind === "INVALID") assert.deepEqual(missing.fields, [{ field: "disclosuresHash", code: "REQUIRED" }]);
  const ok = validator.validate<{ expectedVersion: number }>("urn:kauro:api:v1:request:CMD010", { expectedVersion: 2 });
  assert.equal(ok.kind, "VALID");
  if (ok.kind === "VALID") assert.deepEqual(ok.value, { expectedVersion: 2 }, "the accepted value is the input, untouched");
  assert.equal(validator.validate("urn:kauro:api:v1:request:CMD010", { expectedVersion: 2.5 }).kind, "INVALID");
  assert.equal(validator.validate("urn:kauro:api:v1:request:CMD010", { expectedVersion: 0 }).kind, "INVALID");
});

test("date-time is a real Gregorian instant with at most three fractional digits in Z form; 2026-02-30 is the rejection control", () => {
  for (const good of ["2026-09-19T12:00:00Z", "2026-09-19T12:00:00.5Z", "2026-09-19T12:00:00.123Z", "2024-02-29T00:00:00Z", "2000-02-29T23:59:59.999Z"]) assert.ok(isCalendarDateTime(good), good);
  for (const bad of ["2026-02-30T12:00:00Z", "2026-02-29T12:00:00Z", "2100-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-04-31T00:00:00Z", "2026-09-19T24:00:00Z", "2026-09-19T23:60:00Z", "2026-09-19T23:59:60Z", "2026-09-19T12:00:00.1234Z", "2026-09-19T12:00:00+00:00", "2026-09-19T12:00:00", "2026-09-19 12:00:00Z", "2026-9-19T12:00:00Z"]) {
    assert.ok(!isCalendarDateTime(bad), bad);
  }
  const agency = { agencyId: "a", version: 1, displayName: "A", state: "DRAFT", createdAt: "2026-02-30T12:00:00Z" };
  const r = validator.validate("Agency", agency);
  assert.equal(r.kind, "INVALID");
  if (r.kind === "INVALID") assert.deepEqual(r.fields, [{ field: "createdAt", code: "FORMAT" }]);
  assert.equal(validator.validate("Agency", { ...agency, createdAt: "2026-02-28T12:00:00Z" }).kind, "VALID");
});

test("nested contracts: $ref chains validate data as data (TargetContract.objects is an array of TargetObject values), errors carry paths", () => {
  const r = validator.validate("TargetContract", {
    contractId: "c",
    mode: "HUBSPOT",
    instanceId: "i",
    importerProfileId: "p",
    importerVersion: "1",
    objects: [{ apiName: "Contact", $schema: "http://json-schema.org/schema#", properties: { evil: true } }],
    bodyHash: "a".repeat(64),
    observedAt: "2026-09-19T12:00:00Z",
    authorityEvidenceHash: "b".repeat(64),
    capabilityVersion: "1",
  });
  assert.equal(r.kind, "INVALID");
  if (r.kind === "INVALID") {
    const fields = r.fields.map((f) => `${f.field}:${f.code}`);
    assert.ok(fields.includes("objects/0/$schema:UNKNOWN_FIELD"), fields.join(","));
    assert.ok(fields.includes("objects/0/properties:UNKNOWN_FIELD"));
    assert.ok(fields.some((f) => f.startsWith("objects/0/") && f.endsWith(":REQUIRED")));
  }
});

test("every Problem the application produces validates against the closed Problem schema", () => {
  const samples = [
    problemOf(new DomainFailure("INVALID_REQUEST", "x", { reason: "SCHEMA_VIOLATION", fields: [{ field: "verified", code: "UNKNOWN_FIELD" }] }), "corr-1"),
    problemOf(new DomainFailure("STALE_VERSION", "x", { currentVersion: 3, currentState: "SUPERSEDED", successorId: "018f0000-0000-7000-8000-000000000001", mismatch: ["planHash"] }), "corr-2"),
    problemOf(new DomainFailure("ADMISSION_LIMITED", "x", { reason: "CREATION_RATE_LIMITED", retryAfterSeconds: 30 }), "corr-3"),
    problemOf(new DomainFailure("CAPACITY_UNAVAILABLE", "x", {}, true), "corr-4"),
  ];
  for (const p of samples) {
    const r = validator.validate("Problem", JSON.parse(JSON.stringify(p)));
    assert.equal(r.kind, "VALID", JSON.stringify(r));
  }
  assert.equal(validator.validate("Problem", { ...JSON.parse(JSON.stringify(samples[0])), stack: "Error at ..." }).kind, "INVALID");
  assert.equal(PROBLEM_SCHEMA.additionalProperties, false);
});
