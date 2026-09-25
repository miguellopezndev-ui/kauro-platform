// The HTTP boundary over the real database (10 "Request envelope": the server validates content type, byte size, JSON syntax,
// duplicate keys, schema, authenticated subject and authorization before application execution, and database queries occur
// after structural validation; 10 "Version and validation": closed objects, no coercion, no defaults, no silent removal — a
// string "false" is not a boolean, an unknown field is not removed, a missing approval field is not defaulted; 10 "Responses
// and safe errors"; design §7 and 12b I-VAL-1, I-ERR-1). Registry cases R2-058 (boolean coercion) and R2-059 (unknown
// privileged request member), the admission order of manual 10, the correlation id, the route inventory and the opaque
// INTERNAL_ERROR — every assertion of the former in-memory api tests, now against PostgreSQL 17 with the superuser oracle
// (row counts of every effect table) and the unit-of-work counter (a request refused at the boundary opens no transaction).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { KnownSchemaId, ProjectView } from "@kauro/application";
import { B06_COMMANDS, REQUEST_LIMITS, requestSchemaId } from "@kauro/application";
import type { ProjectId } from "@kauro/domain";
import { classifyInternalError, fastifyPath } from "../src/index.js";
import { approvalBodyOf, asProblem, call, completed, effectCounts, freshKey, ids, outcome, routes, sha, world, type Call, type World } from "./support.js";

let w: World;
let projectId: ProjectId;
before(async () => {
  w = await world();
  projectId = (await w.project(w.A, w.clientA)).projectId;
});
after(async () => {
  await w.stop();
});

/** Runs `refused` and asserts it changed nothing: no row in any effect table and no unit of work opened. */
async function refusedAtTheBoundary<T>(what: string, refused: () => Promise<T>): Promise<T> {
  const counts = await effectCounts(w);
  const runs = w.stats.runs;
  const out = await refused();
  assert.equal(w.stats.runs, runs, `${what}: no unit of work opened (no database query ran)`);
  assert.deepEqual(await effectCounts(w), counts, `${what}: no committed state`);
  return out;
}

/**
 * Runs a structurally admitted request that carries no authenticated subject: exactly one unit of work opens — the ANONYMOUS
 * one that records the refusal as a durable fact (review record B06-review/A-pipeline-authorization.md, R26) — and the only
 * row it adds is that fact.
 */
async function refusedUnauthenticated<T>(what: string, refused: () => Promise<T>): Promise<T> {
  const counts = await effectCounts(w);
  const runs = w.stats.runs;
  const out = await refused();
  assert.equal(w.stats.runs, runs + 1, `${what}: one unit of work, the one recording the anonymous refusal`);
  assert.deepEqual(await effectCounts(w), { ...counts, security_events: counts.security_events + 1 }, `${what}: only the anonymous refusal fact`);
  return out;
}

test("R2-059: POST /clients/{id}/projects with verified=true and agencyOwner=true is 400 INVALID_REQUEST UNKNOWN_FIELD before any transaction; a valid neighbour body creates the project", async () => {
  const url = routes.createProject(w.clientA);
  const res = await refusedAtTheBoundary("verified + agencyOwner", () => call(w, { url, token: w.operator.token, body: { mode: "CLEAN", purpose: "Import", verified: true, agencyOwner: true } }));
  assert.equal(res.status, 400);
  assert.equal(res.contentType, "application/problem+json; charset=utf-8");
  const p = asProblem(w, res);
  assert.equal(p.code, "INVALID_REQUEST");
  assert.equal(p.reason, "SCHEMA_VIOLATION");
  assert.deepEqual(p.errors, [{ field: "verified", code: "UNKNOWN_FIELD" }, { field: "agencyOwner", code: "UNKNOWN_FIELD" }]);
  assert.ok(!res.text.includes("true"), "the problem names the fields, never their values");
  // every server-owned member is unknown on the wire (design §7): state, tenant, version, verification
  for (const member of ["state", "agencyId", "version", "verified", "agencyOwner"] as const) {
    const one = await refusedAtTheBoundary(member, () => call(w, { url, token: w.operator.token, body: { mode: "CLEAN", purpose: "Import", [member]: member === "version" ? 1 : member === "state" ? "OPEN" : member === "agencyId" ? w.B.agencyId : true } }));
    assert.equal(outcome(w, one), "400 INVALID_REQUEST SCHEMA_VIOLATION", member);
    assert.deepEqual(asProblem(w, one).errors, [{ field: member, code: "UNKNOWN_FIELD" }]);
  }
  // the valid neighbour body creates the project: a typed COMPLETED reply
  const projectsBefore = await w.count("projects");
  const ok = await call(w, { url, token: w.operator.token, body: { mode: "CLEAN", purpose: "Import" } });
  assert.equal(ok.status, 201);
  assert.equal(ok.contentType, "application/json; charset=utf-8");
  const body = completed<ProjectView>(ok, 201);
  assert.equal(body.kind, "COMPLETED");
  assert.equal(body.version, 1);
  assert.equal(body.replayed, false);
  assert.equal(body.data.state, "OPEN");
  assert.ok(body.data.readinessBlockers.includes("NO_SEALED_REVISION"));
  assert.equal(await w.count("projects"), projectsBefore + 1);
});

test("R2-058: a string \"false\" where a boolean is expected is INVALID_REQUEST (type), never coerced; a missing approval member is never defaulted", async () => {
  // the B06 bodies carry no boolean member (design §7); the rule is the validator's, so it is shown on the instance the server
  // runs with contracts that do carry booleans, and on the wire with the scalar members the seven bodies have
  const proof = { provider: "HUBSPOT", instanceId: "portal-7781", objectApiName: "contacts", fieldApiName: "email", caseSensitive: "false", nullBehavior: "EXCLUDE", completeScope: true, contractHash: sha("contract"), evidenceHash: sha("evidence"), observedAt: "2026-09-19T12:00:00Z", operation: "MATCH" };
  const coerced = w.validator.validate("UniquenessProof", proof);
  assert.deepEqual(coerced, { kind: "INVALID", fields: [{ field: "caseSensitive", code: "TYPE" }] });
  assert.deepEqual(w.validator.validate("UniquenessProof", { ...proof, caseSensitive: "true", completeScope: "false" }), {
    kind: "INVALID",
    fields: [
      { field: "caseSensitive", code: "TYPE" },
      { field: "completeScope", code: "TYPE" },
    ],
  });
  assert.deepEqual(w.validator.validate("UniquenessProof", { ...proof, caseSensitive: 0 }), { kind: "INVALID", fields: [{ field: "caseSensitive", code: "TYPE" }] });
  // no coercion, no defaults, no removal: a valid value comes back as the same object, unchanged — nothing converted, added
  // or dropped; a missing boolean is REQUIRED, never defaulted; an unknown member is reported, never silently removed
  const valid = { ...proof, caseSensitive: false };
  const snapshot = JSON.stringify(valid);
  const accepted = w.validator.validate("UniquenessProof", valid);
  assert.equal(accepted.kind === "VALID" ? accepted.value : null, valid);
  assert.equal(JSON.stringify(valid), snapshot);
  const { caseSensitive: _dropped, ...missing } = valid;
  assert.deepEqual(w.validator.validate("UniquenessProof", missing), { kind: "INVALID", fields: [{ field: "caseSensitive", code: "REQUIRED" }] });
  assert.deepEqual(w.validator.validate("UniquenessProof", { ...valid, approved: true }), { kind: "INVALID", fields: [{ field: "approved", code: "UNKNOWN_FIELD" }] });
  assert.throws(() => w.validator.validate("UniquenessProofLoose" as KnownSchemaId, valid), (e: unknown) => e instanceof Error && (e as { code?: string }).code === "INTEGRITY_FAILURE", "no permissive variant exists");

  // on the wire: a string where the integer version is expected is a TYPE error, never coerced; a missing member is REQUIRED
  const archive = routes.archiveClient(w.clientA);
  for (const [expectedVersion, code] of [["1", "TYPE"], [true, "TYPE"], [1.5, "TYPE"], [0, "RANGE"]] as const) {
    const res = await refusedAtTheBoundary(`expectedVersion ${JSON.stringify(expectedVersion)}`, () => call(w, { url: archive, token: w.admin.token, body: { expectedVersion } }));
    assert.equal(res.status, 400);
    assert.deepEqual(asProblem(w, res).errors, [{ field: "expectedVersion", code }]);
  }
  const missingVersion = await refusedAtTheBoundary("expectedVersion missing", () => call(w, { url: archive, token: w.admin.token, body: {} }));
  assert.deepEqual(asProblem(w, missingVersion).errors, [{ field: "expectedVersion", code: "REQUIRED" }]);
  assert.deepEqual(await w.row<{ state: string; version: string }>("end_clients", "client_id = $1", [w.clientA]).then((r) => r && [r.state, r.version]), ["ACTIVE", "1"]);

  // approval meaning: a missing approval member is refused, never defaulted; a boolean or a string in the place of a hash or
  // a version is refused, never coerced; an invented "approved" flag is unknown — and none of them approves anything
  const plan = await w.approvable(w.A, projectId, "r2-058");
  const good = approvalBodyOf(plan, await w.stepUp(w.approver));
  const url = routes.approvePlan(plan.planId);
  const variants: ReadonlyArray<readonly [string, Record<string, unknown>, ReadonlyArray<{ field: string; code: string }>]> = [
    ["disclosuresHash missing", (({ disclosuresHash: _omit, ...rest }) => rest)(good), [{ field: "disclosuresHash", code: "REQUIRED" }]],
    ["assuranceProofRef missing", (({ assuranceProofRef: _omit, ...rest }) => rest)(good), [{ field: "assuranceProofRef", code: "REQUIRED" }]],
    ["expectedVersion as a string", { ...good, expectedVersion: "4" }, [{ field: "expectedVersion", code: "TYPE" }]],
    ["planHash as a boolean", { ...good, planHash: false }, [{ field: "planHash", code: "TYPE" }]],
    ["an invented approved flag", { ...good, approved: "false" }, [{ field: "approved", code: "UNKNOWN_FIELD" }]],
  ];
  for (const [what, body, errors] of variants) {
    const res = await refusedAtTheBoundary(what, () => call(w, { url, token: w.approver.token, body }));
    assert.equal(outcome(w, res), "400 INVALID_REQUEST SCHEMA_VIOLATION", what);
    assert.deepEqual(asProblem(w, res).errors, errors, what);
  }
  assert.equal(await w.count("approvals", "plan_id = $1", [plan.planId]), 0);
  assert.deepEqual(await w.row<{ state: string; version: string }>("plans", "plan_id = $1", [plan.planId]).then((r) => r && [r.state, r.version]), ["VALIDATED", "4"]);
  // the complete, correctly typed body is the only one that approves
  const approved = completed<{ plan: { state: string } }>(await call(w, { url, token: w.approver.token, body: good }), 201);
  assert.equal(approved.data.plan.state, "APPROVED");
});

test("manual-10 admission order: content type, size, syntax and duplicate keys, schema, idempotency key, path id, agency selector, then the authenticated subject — each answers its reason, the first failure wins, and no unit of work opens (an unauthenticated refusal opens only the one that records it)", async () => {
  const url = routes.createProject(w.clientA);
  const valid = { mode: "CLEAN", purpose: "x" };
  const reason = async (what: string, c: Call): Promise<string> => {
    const res = await refusedAtTheBoundary(what, () => call(w, c));
    return outcome(w, res);
  };
  const unauthenticated = async (what: string, c: Call): Promise<string> => outcome(w, await refusedUnauthenticated(what, () => call(w, c)));
  // each check on its own
  assert.equal(await reason("text/plain", { url, contentType: "text/plain", rawBody: "mode=CLEAN" }), "400 INVALID_REQUEST CONTENT_TYPE_UNSUPPORTED");
  assert.equal(await reason("no content type", { url, contentType: null, rawBody: '{"mode":"CLEAN","purpose":"x"}' }), "400 INVALID_REQUEST CONTENT_TYPE_UNSUPPORTED");
  assert.equal(await reason("json with a foreign charset", { url, contentType: "application/json; charset=latin1", rawBody: '{"mode":"CLEAN","purpose":"x"}' }), "400 INVALID_REQUEST CONTENT_TYPE_UNSUPPORTED");
  assert.equal(await reason("over 1 MiB", { url, rawBody: JSON.stringify({ mode: "CLEAN", purpose: "x".repeat(REQUEST_LIMITS.jsonBytes) }) }), "400 INVALID_REQUEST BODY_TOO_LARGE");
  assert.equal(await reason("truncated JSON", { url, rawBody: '{"mode":"CLEAN",' }), "400 INVALID_REQUEST JSON_SYNTAX");
  assert.equal(await reason("empty body", { url, rawBody: "" }), "400 INVALID_REQUEST JSON_SYNTAX");
  assert.equal(await reason("duplicate key", { url, rawBody: '{"mode":"CLEAN","mode":"HUBSPOT","purpose":"x"}' }), "400 INVALID_REQUEST JSON_DUPLICATE_KEY");
  assert.equal(await reason("prototype member", { url, rawBody: '{"mode":"CLEAN","purpose":"x","__proto__":{"verified":true}}' }), "400 INVALID_REQUEST JSON_SYNTAX");
  assert.equal(await reason("depth 17", { url, rawBody: "[".repeat(REQUEST_LIMITS.maxDepth + 1) + "]".repeat(REQUEST_LIMITS.maxDepth + 1) }), "400 INVALID_REQUEST JSON_DEPTH_EXCEEDED");
  assert.equal(await reason("string over 40 000", { url, rawBody: JSON.stringify({ mode: "CLEAN", purpose: "x".repeat(REQUEST_LIMITS.maxStringLength + 1) }) }), "400 INVALID_REQUEST JSON_STRING_TOO_LONG");
  assert.equal(await reason("schema", { url, body: { mode: "CLEAN" } }), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  assert.equal(await reason("no idempotency key", { url, body: valid, key: null }), "400 INVALID_REQUEST IDEMPOTENCY_KEY_MISSING");
  assert.equal(await reason("short idempotency key", { url, body: valid, key: "too short" }), "400 INVALID_REQUEST IDEMPOTENCY_KEY_INVALID");
  assert.equal(await reason("path id", { url: "/api/v1/clients/not-an-id/projects", body: valid }), "400 INVALID_REQUEST PATH_ID_INVALID");
  assert.equal(await reason("no agency selector", { url, body: valid, agency: null }), "400 INVALID_REQUEST AGENCY_SELECTOR_INVALID");
  assert.equal(await reason("malformed agency selector", { url, body: valid, agency: "agency-a" }), "400 INVALID_REQUEST AGENCY_SELECTOR_INVALID");
  assert.equal(await unauthenticated("no bearer token", { url, body: valid, token: null }), "401 AUTHENTICATION_REQUIRED -");
  assert.equal(await unauthenticated("unknown bearer token", { url, body: valid, token: "unknown-token-0123456789" }), "401 AUTHENTICATION_REQUIRED -");

  // several failures at once: the earliest check answers (content type > size > syntax > duplicate key > schema > key > path >
  // agency selector > authentication > authorization)
  const oversized = "x".repeat(REQUEST_LIMITS.jsonBytes + 1);
  assert.equal(await reason("wrong type + oversized + no key + no token", { url, contentType: "text/plain", rawBody: oversized, key: null, token: null }), "400 INVALID_REQUEST CONTENT_TYPE_UNSUPPORTED");
  assert.equal(await reason("oversized + not JSON + no key", { url, rawBody: oversized, key: null }), "400 INVALID_REQUEST BODY_TOO_LARGE");
  assert.equal(await reason("not JSON + no key + no token", { url, rawBody: "{", key: null, token: null }), "400 INVALID_REQUEST JSON_SYNTAX");
  assert.equal(await reason("duplicate key + schema", { url, rawBody: '{"mode":"CLEAN","mode":"CLEAN","verified":true}' }), "400 INVALID_REQUEST JSON_DUPLICATE_KEY");
  assert.equal(await reason("schema + no key + bad path + no token", { url: "/api/v1/clients/not-an-id/projects", body: { mode: "CLEAN", verified: true }, key: null, token: null }), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  assert.equal(await reason("no key + bad path + no agency", { url: "/api/v1/clients/not-an-id/projects", body: valid, key: null, agency: null }), "400 INVALID_REQUEST IDEMPOTENCY_KEY_MISSING");
  assert.equal(await reason("bad path + no agency + no token", { url: "/api/v1/clients/not-an-id/projects", body: valid, agency: null, token: null }), "400 INVALID_REQUEST PATH_ID_INVALID");
  assert.equal(await reason("no agency + no token", { url, body: valid, agency: null, token: null }), "400 INVALID_REQUEST AGENCY_SELECTOR_INVALID");
  // authentication happens after structural validation: a malformed body without a token is 400, a valid one is 401
  // (REAUTHENTICATE); and before authorization: a non-member's malformed body is 400 at the boundary, his valid body is 404
  assert.equal(await reason("malformed body, no token", { url: routes.createAgency(), agency: null, body: { displayName: 42 }, token: null }), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  const anonymous = await refusedUnauthenticated("valid body, no token", () => call(w, { url: routes.createAgency(), agency: null, body: { displayName: "Acme Two" }, token: null }));
  assert.equal(outcome(w, anonymous), "401 AUTHENTICATION_REQUIRED -");
  assert.deepEqual(asProblem(w, anonymous).nextActions, [{ action: "REAUTHENTICATE" }]);
  assert.equal(await reason("non-member, malformed body", { url, token: w.stranger.token, body: { mode: "CLEAN" } }), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  assert.equal(outcome(w, await call(w, { url, token: w.stranger.token, body: valid })), "404 NOT_FOUND NOT_A_MEMBER", "authorization answers only once the request is structurally admitted and authenticated");
});

test("the correlation id is echoed when supplied, generated otherwise, and present on every problem; unknown routes and methods are NOT_FOUND problems", async () => {
  // supplied and well-formed — an `id` (I-INT-4) — echoed on the answer (here the owner's second DRAFT agency is not admitted)
  const supplied = ids.next();
  const given = await call(w, { url: routes.createAgency(), body: { displayName: "Acme Two" }, headers: { "x-correlation-id": supplied }, agency: null });
  assert.equal(outcome(w, given), "429 ADMISSION_LIMITED DRAFT_AGENCY_EXISTS");
  assert.equal(given.headers["x-correlation-id"], supplied);
  assert.equal(asProblem(w, given).correlationId, supplied);
  // absent: the server generates one, sends it and names it in the problem
  const generated = await call(w, { url: routes.createAgency(), body: {}, agency: null });
  assert.equal(generated.status, 400);
  assert.match(String(generated.headers["x-correlation-id"]), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(asProblem(w, generated).correlationId, generated.headers["x-correlation-id"]);
  // not an id: never refused and never echoed (R28; 10 "Every request receives an opaque correlation ID") — the request goes on
  // under a server-minted UUIDv7, since an opaque token of another shape could not be recorded (the journal, the events and
  // the security events store a uuid) and a header value is no place for log injection
  for (const token of ["client-abc.123", "abc def\\u0000<script>", supplied.toUpperCase()]) {
    const proceeded = await call(w, { url: routes.createAgency(), body: { displayName: "Acme Two" }, headers: { "x-correlation-id": token }, agency: null });
    assert.equal(outcome(w, proceeded), "429 ADMISSION_LIMITED DRAFT_AGENCY_EXISTS", token);
    assert.match(String(proceeded.headers["x-correlation-id"]), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(asProblem(w, proceeded).correlationId, proceeded.headers["x-correlation-id"]);
    assert.ok(!proceeded.text.includes("script") && !proceeded.text.includes("client-abc") && !proceeded.text.includes(supplied.toUpperCase()), token);
  }
  // a success carries it too, and so do the durable records of the operation: the journal entry and the event
  const traced = ids.next();
  const created = await call(w, { url: routes.createClient(w.A.agencyId), agency: null, headers: { "x-correlation-id": traced }, body: { displayName: "Correlated", processingAuthorityRef: w.authorityA } });
  assert.equal(created.status, 201);
  assert.equal(created.headers["x-correlation-id"], traced);
  const clientId = completed<{ clientId: string }>(created, 201).data.clientId;
  assert.equal(await w.count("command_journal", "correlation_id = $1 AND resource_id = $2", [traced, clientId]), 1);
  assert.equal(await w.count("domain_events", "correlation_id = $1 AND aggregate_id = $2", [traced, clientId]), 1);
  // unknown routes and unregistered methods are NOT_FOUND problems with a correlation id
  const unknown = await call(w, { url: "/api/v1/nothing", body: {} });
  assert.equal(outcome(w, unknown), "404 NOT_FOUND -");
  assert.equal(asProblem(w, unknown).correlationId, unknown.headers["x-correlation-id"]);
  const wrongMethod = await call(w, { method: "GET", url: "/api/v1/agencies", agency: null, key: null, contentType: null });
  assert.equal(outcome(w, wrongMethod), "404 NOT_FOUND -");
  assert.equal(asProblem(w, wrongMethod).correlationId, wrongMethod.headers["x-correlation-id"]);
});

test("exactly the seven catalogue routes are registered, as POST, under /api/v1", async () => {
  for (const spec of Object.values(B06_COMMANDS)) {
    assert.ok(w.app.hasRoute({ method: "POST", url: fastifyPath(spec.path) }), spec.path);
    assert.ok(!w.app.hasRoute({ method: "GET", url: fastifyPath(spec.path) }), `no GET on ${spec.path}`);
    assert.ok(spec.path.startsWith("/api/v1/"), spec.path);
  }
  assert.equal(fastifyPath("/api/v1/agencies/{agencyId}/clients"), "/api/v1/agencies/:agencyId/clients");
  assert.equal(w.app.printRoutes().split("\n").filter((l) => l.includes("(POST)")).length, 7);
  // each route validates its body against its own closed request schema
  for (const id of Object.keys(B06_COMMANDS) as Array<keyof typeof B06_COMMANDS>) assert.ok(w.validator.knownSchemaIds.includes(requestSchemaId(id)), id);
});

test("an unexpected exception is 500 INTERNAL_ERROR with only the correlation id, RETRY_SAME_KEY and the safe classification handed to the sink; no stack, SQL or message reaches the wire", async () => {
  const key = freshKey("internal");
  const body = { displayName: "Boom client", processingAuthorityRef: w.authorityA };
  const correlationId = ids.next();
  const sunk = w.internalErrors.length;
  const counts = await effectCounts(w);
  // the failure strikes inside the unit of work, after the client row and its event were written and before the journal
  // entry completes; its message carries what must never reach a client
  w.holds.arm("journal.commit", { fail: new TypeError("secret internal detail: SELECT * FROM kauro.agencies") });
  const res = await call(w, { url: routes.createClient(w.A.agencyId), agency: null, key, body, headers: { "x-correlation-id": correlationId } });
  assert.equal(res.status, 500);
  assert.equal(res.headers["x-correlation-id"], correlationId);
  const p = asProblem(w, res);
  assert.equal(p.code, "INTERNAL_ERROR");
  assert.equal(p.correlationId, correlationId);
  assert.equal(p.retryable, true);
  assert.deepEqual(p.nextActions, [{ action: "RETRY_SAME_KEY" }]);
  for (const leak of ["SELECT", "secret", "kauro.", "TypeError", "stack", "at "]) assert.ok(!res.text.includes(leak), `no ${leak} on the wire`);
  // the sink received the failure once, under the request's correlation id; its safe classification names classes only
  assert.equal(w.internalErrors.length, sunk + 1);
  const recorded = w.internalErrors.at(-1);
  assert.equal(recorded?.correlationId, correlationId);
  assert.equal(classifyInternalError(recorded?.error), "DomainFailure cause=TypeError");
  // nothing committed (the unit of work rolled back); the retry with the same key is the first execution of that key
  assert.deepEqual(await effectCounts(w), counts);
  assert.equal(await w.journal(key), null);
  const retried = completed<{ displayName: string }>(await call(w, { url: routes.createClient(w.A.agencyId), agency: null, key, body }), 201);
  assert.equal(retried.replayed, false);
  assert.equal(retried.data.displayName, "Boom client");
});
