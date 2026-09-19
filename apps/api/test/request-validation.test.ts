// The HTTP boundary (10 "Request envelope", "Version and validation", "Responses and safe errors"): R2-059 unknown privileged
// members reject before any state change; R2-058 no coercion; content type, size, syntax, duplicate keys, headers and path
// ids each answer a safe problem; every problem validates against the closed Problem schema; nothing echoes a value.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REQUEST_LIMITS } from "@kauro/application";
import { api, asProblem, call, validator } from "./support.js";

function snapshot(a: ReturnType<typeof api>) {
  const s = a.store();
  return { projects: s.projects.size, journal: s.journal.size, events: s.events.length, security: s.securityEvents.length };
}

test("R2-059: POST /clients/{id}/projects with verified=true and agencyOwner=true is 400 INVALID_REQUEST UNKNOWN_FIELD before any transaction; a valid neighbour body creates the project", async () => {
  const a = api();
  const before = snapshot(a);
  const res = await call(a, { url: `/api/v1/clients/${a.clientId}/projects`, body: { mode: "CLEAN", purpose: "Import", verified: true, agencyOwner: true } });
  assert.equal(res.status, 400);
  assert.equal(res.contentType, "application/problem+json; charset=utf-8");
  const p = asProblem(res.json());
  assert.equal(p.code, "INVALID_REQUEST");
  assert.equal(p.reason, "SCHEMA_VIOLATION");
  assert.deepEqual(p.errors, [{ field: "verified", code: "UNKNOWN_FIELD" }, { field: "agencyOwner", code: "UNKNOWN_FIELD" }]);
  assert.deepEqual(snapshot(a), before, "zero projects, zero journal rows, zero events");
  const ok = await call(a, { url: `/api/v1/clients/${a.clientId}/projects`, body: { mode: "CLEAN", purpose: "Import" } });
  assert.equal(ok.status, 201);
  const body = ok.json() as { kind: string; version: number; replayed: boolean; data: { state: string; readinessBlockers: string[] } };
  assert.equal(body.kind, "COMPLETED");
  assert.equal(body.version, 1);
  assert.equal(body.replayed, false);
  assert.equal(body.data.state, "OPEN");
  assert.ok(body.data.readinessBlockers.includes("NO_SEALED_REVISION"));
  assert.equal(a.store().projects.size, before.projects + 1);
});

test("R2-058: a string where an integer is expected is 400 with a TYPE field error, never coerced; a missing member is never defaulted; the validator runs with no coercion, no defaults, no removal", async () => {
  const a = api();
  const res = await call(a, { url: `/api/v1/clients/${a.clientId}/archive`, body: { expectedVersion: "1" } });
  assert.equal(res.status, 400);
  const p = asProblem(res.json());
  assert.deepEqual(p.errors, [{ field: "expectedVersion", code: "TYPE" }]);
  const missing = await call(a, { url: `/api/v1/clients/${a.clientId}/archive`, body: {} });
  assert.deepEqual(asProblem(missing.json()).errors, [{ field: "expectedVersion", code: "REQUIRED" }]);
  assert.equal(a.store().endClients.get(a.clientId)?.state, "ACTIVE");
  assert.equal(a.store().journal.size, 0);
  // the validator instance the server runs (the fixture hands the same object to createApiServer): a boolean member of a
  // contract refuses the string "false"
  const proof = { provider: "HUBSPOT", instanceId: "i", objectApiName: "Contact", fieldApiName: "email", caseSensitive: "false", nullBehavior: "EXCLUDE", completeScope: true, contractHash: "a".repeat(64), evidenceHash: "b".repeat(64), observedAt: "2026-09-19T12:00:00Z", operation: "MATCH" };
  const coerced = validator.validate("UniquenessProof", proof);
  assert.equal(coerced.kind, "INVALID");
  if (coerced.kind === "INVALID") assert.deepEqual(coerced.fields, [{ field: "caseSensitive", code: "TYPE" }]);
  assert.equal(validator.validate("UniquenessProof", { ...proof, caseSensitive: false }).kind, "VALID");
});

test("content type, size, syntax, duplicate keys, idempotency key, agency selector and path id each answer their reason, in that order", async () => {
  const a = api();
  const url = `/api/v1/clients/${a.clientId}/projects`;
  const reason = async (c: Parameters<typeof call>[1]) => {
    const res = await call(a, c);
    const p = asProblem(res.json());
    return `${res.status} ${p.code} ${p.reason ?? "-"}`;
  };
  assert.equal(await reason({ url, contentType: "text/plain", rawBody: "mode=CLEAN" }), "400 INVALID_REQUEST CONTENT_TYPE_UNSUPPORTED");
  assert.equal(await reason({ url, contentType: null, rawBody: '{"mode":"CLEAN","purpose":"x"}' }), "400 INVALID_REQUEST CONTENT_TYPE_UNSUPPORTED");
  assert.equal(await reason({ url, rawBody: JSON.stringify({ mode: "CLEAN", purpose: "x".repeat(REQUEST_LIMITS.jsonBytes) }) }), "400 INVALID_REQUEST BODY_TOO_LARGE");
  assert.equal(await reason({ url, rawBody: '{"mode":"CLEAN",' }), "400 INVALID_REQUEST JSON_SYNTAX");
  assert.equal(await reason({ url, rawBody: '{"mode":"CLEAN","mode":"HUBSPOT","purpose":"x"}' }), "400 INVALID_REQUEST JSON_DUPLICATE_KEY");
  assert.equal(await reason({ url, rawBody: "[".repeat(REQUEST_LIMITS.maxDepth + 1) + "]".repeat(REQUEST_LIMITS.maxDepth + 1) }), "400 INVALID_REQUEST JSON_DEPTH_EXCEEDED");
  assert.equal(await reason({ url, body: { mode: "CLEAN", purpose: "x" }, key: null }), "400 INVALID_REQUEST IDEMPOTENCY_KEY_MISSING");
  assert.equal(await reason({ url, body: { mode: "CLEAN", purpose: "x" }, key: "too short" }), "400 INVALID_REQUEST IDEMPOTENCY_KEY_INVALID");
  assert.equal(await reason({ url, body: { mode: "CLEAN", purpose: "x" }, agency: null }), "400 INVALID_REQUEST AGENCY_SELECTOR_INVALID");
  assert.equal(await reason({ url: "/api/v1/clients/not-an-id/projects", body: { mode: "CLEAN", purpose: "x" } }), "400 INVALID_REQUEST PATH_ID_INVALID");
  assert.equal(a.store().journal.size, 0);
});

test("the correlation id is echoed when supplied, generated otherwise, and present on every problem; unknown routes and methods are NOT_FOUND problems", async () => {
  const a = api();
  const given = await call(a, { url: "/api/v1/agencies", body: { displayName: "Acme Two" }, headers: { "x-correlation-id": "client-abc.123" }, agency: null });
  assert.equal(given.headers["x-correlation-id"], "client-abc.123");
  const generated = await call(a, { url: "/api/v1/agencies", body: {}, agency: null });
  assert.match(String(generated.headers["x-correlation-id"]), /^[0-9a-f-]{36}$/);
  assert.equal(asProblem(generated.json()).correlationId, generated.headers["x-correlation-id"]);
  const unknown = await call(a, { url: "/api/v1/nothing", body: {} });
  assert.equal(unknown.status, 404);
  assert.equal(asProblem(unknown.json()).code, "NOT_FOUND");
  const wrongMethod = await call(a, { method: "GET", url: "/api/v1/agencies", agency: null, key: null, contentType: null });
  assert.equal(wrongMethod.status, 404);
  assert.equal(asProblem(wrongMethod.json()).code, "NOT_FOUND");
});
