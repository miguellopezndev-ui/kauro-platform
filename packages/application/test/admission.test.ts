// Request admission in the order of manual 10 "Request envelope": content type, byte size, JSON syntax and duplicate keys,
// closed schema, then the envelope (idempotency key, path ids, agency selector). Each step names its reason; nothing here
// touches a database or echoes a value.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ContractSchemaBundle, RawRequest } from "../src/index.js";
import { ARCHIVE_CLIENT, CREATE_AGENCY, CREATE_CLIENT, CREATE_PROJECT, admitStructure, createSchemaValidator, envelopeOf, fixedClock, sequentialIds } from "../src/index.js";
import { subject } from "./support.js";

const bundle = JSON.parse(readFileSync(new URL(import.meta.resolve("@kauro/contracts/schemas.json")), "utf8")) as ContractSchemaBundle;
const validator = createSchemaValidator(bundle);
const clock = fixedClock();
const ids = sequentialIds(clock);
const KEY = "0123456789abcdef-key";
const CLIENT = "018f0000-0000-7000-8000-000000000010";
const AGENCY = "018f0000-0000-7000-8000-000000000020";

function raw(overrides: Partial<RawRequest> & { headers?: Record<string, string | undefined> } = {}, body: unknown = { mode: "CLEAN", purpose: "Import" }): RawRequest {
  const text = JSON.stringify(body);
  return {
    headers: { "content-type": "application/json", "idempotency-key": KEY, "x-kauro-agency": AGENCY, ...(overrides.headers ?? {}) },
    params: overrides.params ?? { clientId: CLIENT },
    bodyText: overrides.bodyText !== undefined ? overrides.bodyText : text,
    bodyBytes: overrides.bodyBytes ?? Buffer.byteLength(text),
  };
}

function reasonOf(r: ReturnType<typeof admitStructure>): string {
  assert.equal(r.kind, "PROBLEM");
  return r.kind === "PROBLEM" ? `${r.problem.status} ${r.problem.code} ${r.problem.reason ?? "-"}` : "";
}

test("the order of manual 10: content type, size, syntax, duplicate keys, schema, idempotency key, path id, agency selector", () => {
  assert.equal(reasonOf(admitStructure(CREATE_PROJECT, raw({ headers: { "content-type": "text/plain", "idempotency-key": undefined } }), validator, ids, clock)), "400 INVALID_REQUEST CONTENT_TYPE_UNSUPPORTED");
  assert.equal(reasonOf(admitStructure(CREATE_PROJECT, raw({ bodyBytes: 1_048_577, bodyText: "{" }), validator, ids, clock)), "400 INVALID_REQUEST BODY_TOO_LARGE");
  assert.equal(reasonOf(admitStructure(CREATE_PROJECT, raw({ bodyText: "{" }), validator, ids, clock)), "400 INVALID_REQUEST JSON_SYNTAX");
  assert.equal(reasonOf(admitStructure(CREATE_PROJECT, raw({ bodyText: null, bodyBytes: 0 }), validator, ids, clock)), "400 INVALID_REQUEST JSON_SYNTAX");
  assert.equal(reasonOf(admitStructure(CREATE_PROJECT, raw({ bodyText: '{"mode":"CLEAN","mode":"HUBSPOT","purpose":"x"}' }), validator, ids, clock)), "400 INVALID_REQUEST JSON_DUPLICATE_KEY");
  const unknown = admitStructure(CREATE_PROJECT, raw({ headers: { "idempotency-key": undefined } }, { mode: "CLEAN", purpose: "x", verified: true, agencyOwner: true }), validator, ids, clock);
  assert.equal(reasonOf(unknown), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  if (unknown.kind === "PROBLEM") assert.deepEqual(unknown.problem.errors, [{ field: "verified", code: "UNKNOWN_FIELD" }, { field: "agencyOwner", code: "UNKNOWN_FIELD" }]);
  assert.equal(reasonOf(admitStructure(CREATE_PROJECT, raw({ headers: { "idempotency-key": undefined } }), validator, ids, clock)), "400 INVALID_REQUEST IDEMPOTENCY_KEY_MISSING");
  assert.equal(reasonOf(admitStructure(CREATE_PROJECT, raw({ headers: { "idempotency-key": "short" } }), validator, ids, clock)), "400 INVALID_REQUEST IDEMPOTENCY_KEY_INVALID");
  const badPath = admitStructure(CREATE_PROJECT, raw({ params: { clientId: "not-a-uuid" } }), validator, ids, clock);
  assert.equal(reasonOf(badPath), "400 INVALID_REQUEST PATH_ID_INVALID");
  if (badPath.kind === "PROBLEM") assert.deepEqual(badPath.problem.errors, [{ field: "clientId", code: "FORMAT" }]);
  assert.equal(reasonOf(admitStructure(CREATE_PROJECT, raw({ headers: { "x-kauro-agency": undefined } }), validator, ids, clock)), "400 INVALID_REQUEST AGENCY_SELECTOR_INVALID");
  assert.equal(reasonOf(admitStructure(CREATE_PROJECT, raw({ headers: { "x-kauro-agency": "acme" } }), validator, ids, clock)), "400 INVALID_REQUEST AGENCY_SELECTOR_INVALID");
});

test("an admitted request carries the validated body, the path ids and the selector of its scope; the envelope binds the subject", () => {
  const header = admitStructure(CREATE_PROJECT, raw({ headers: { "x-correlation-id": "client-corr-1" } }), validator, ids, clock);
  assert.equal(header.kind, "ADMITTED");
  if (header.kind === "ADMITTED") {
    assert.equal(header.admission.agencyId, AGENCY);
    assert.deepEqual(header.admission.path, { clientId: CLIENT });
    assert.deepEqual(header.admission.body, { mode: "CLEAN", purpose: "Import" });
    assert.equal(header.admission.correlationId, "client-corr-1");
    assert.equal(header.admission.idempotencyKey, KEY);
    const s = subject("someone");
    const env = envelopeOf("CMD011", "LOCAL", header.admission, s);
    assert.equal(env.userId, s.identity.userId);
    assert.equal(env.command, "CMD011");
    assert.equal(env.receivedAt, clock.now());
  }
  const path = admitStructure(CREATE_CLIENT, raw({ params: { agencyId: AGENCY }, headers: { "x-kauro-agency": undefined } }, { displayName: "C", processingAuthorityRef: CLIENT }), validator, ids, clock);
  assert.equal(path.kind, "ADMITTED");
  if (path.kind === "ADMITTED") assert.equal(path.admission.agencyId, AGENCY, "the path agencyId is the selector; no header is needed");
  const none = admitStructure(CREATE_AGENCY, raw({ params: {}, headers: { "x-kauro-agency": undefined } }, { displayName: "A" }), validator, ids, clock);
  assert.equal(none.kind, "ADMITTED");
  if (none.kind === "ADMITTED") assert.equal(none.admission.agencyId, null);
});

test("a malformed client correlation id is refused, a missing one is generated and echoed, a charset parameter is accepted only as utf-8", () => {
  assert.equal(reasonOf(admitStructure(ARCHIVE_CLIENT, raw({ headers: { "x-correlation-id": "bad value with spaces" } }, { expectedVersion: 1 }), validator, ids, clock)), "400 INVALID_REQUEST CORRELATION_ID_INVALID");
  const generated = admitStructure(ARCHIVE_CLIENT, raw({}, { expectedVersion: 1 }), validator, ids, clock);
  assert.equal(generated.kind, "ADMITTED");
  if (generated.kind === "ADMITTED") assert.match(generated.admission.correlationId, /^[0-9a-f-]{36}$/);
  assert.equal(admitStructure(ARCHIVE_CLIENT, raw({ headers: { "content-type": "application/json; charset=utf-8" } }, { expectedVersion: 1 }), validator, ids, clock).kind, "ADMITTED");
  assert.equal(reasonOf(admitStructure(ARCHIVE_CLIENT, raw({ headers: { "content-type": "application/json; charset=latin1" } }, { expectedVersion: 1 }), validator, ids, clock)), "400 INVALID_REQUEST CONTENT_TYPE_UNSUPPORTED");
});
