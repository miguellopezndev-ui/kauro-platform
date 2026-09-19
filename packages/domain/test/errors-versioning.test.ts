// Typed error contract (10 "Responses and safe errors"; 07 "Command outcomes and error taxonomy"; D-ERR-1..3) and optimistic
// concurrency (10 "Concurrency and preconditions"; D-VER-1). Oracle: the manual's stable code list and status semantics.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTHORITY_FAILURE_CODES,
  DomainFailure,
  FAILURE_CODES,
  FAILURE_HTTP_STATUS,
  FAILURE_REASONS,
  FAILURE_TITLES,
  IdempotencyConflictFailure,
  InvalidRequestFailure,
  NotAuthorizedFailure,
  NotFoundFailure,
  PreconditionFailure,
  RETRYABLE_FAILURE_CODES,
  StaleVersionFailure,
  type TenantContext,
  assertExpectedVersion,
  assertInScope,
  assertLabel,
  assertReasonCode,
  assertSameScope,
  assertVersionField,
  describeFailure,
  isLabel,
  isReasonCode,
  isVersion,
  nextVersion,
  tenantScopeOf,
} from "../src/index.js";
import { activeAgency, client, id, membership, refused, users } from "./fixtures.js";

test("every failure code has an HTTP status, a fixed title and a retryability; the manual codes are all present", () => {
  const MANUAL_10 = ["INVALID_REQUEST", "AUTHENTICATION_REQUIRED", "ASSURANCE_REQUIRED", "NOT_AUTHORIZED", "NOT_FOUND", "STALE_VERSION", "IDEMPOTENCY_CONFLICT", "CAPABILITY_UNAVAILABLE", "SOURCE_EXPIRED", "TARGET_STALE", "PLAN_NOT_VALIDATED", "PAYMENT_PENDING", "PAYMENT_UNCERTAIN", "BUDGET_EXHAUSTED", "CAPACITY_UNAVAILABLE", "INTEGRITY_FAILURE", "OPERATION_CANCELLED"];
  for (const c of MANUAL_10) assert.ok(AUTHORITY_FAILURE_CODES.has(c as "NOT_FOUND"), c);
  assert.deepEqual(FAILURE_CODES.filter((c) => !AUTHORITY_FAILURE_CODES.has(c)), ["PRECONDITION_FAILED", "ADMISSION_LIMITED", "INTERNAL_ERROR"]);
  for (const c of FAILURE_CODES) {
    const status = FAILURE_HTTP_STATUS[c];
    assert.ok(Number.isInteger(status) && status >= 400 && status <= 599, c);
    assert.ok(FAILURE_TITLES[c].length > 0, c);
    const f = new DomainFailure(c, "x");
    assert.equal(f.status, status);
    assert.equal(f.title, FAILURE_TITLES[c]);
    assert.equal(f.retryable, RETRYABLE_FAILURE_CODES.has(c), c);
  }
  // 07: authentication, authorization, stale version, invalid input, unsupported capability, budget, saturation, provider
  // uncertainty and integrity failure are distinct classes with distinct statuses where the API contract separates them
  assert.equal(FAILURE_HTTP_STATUS.AUTHENTICATION_REQUIRED, 401);
  assert.equal(FAILURE_HTTP_STATUS.NOT_AUTHORIZED, 403);
  assert.equal(FAILURE_HTTP_STATUS.ASSURANCE_REQUIRED, 403);
  assert.equal(FAILURE_HTTP_STATUS.NOT_FOUND, 404);
  assert.equal(FAILURE_HTTP_STATUS.INVALID_REQUEST, 400);
  for (const c of ["STALE_VERSION", "IDEMPOTENCY_CONFLICT", "PRECONDITION_FAILED", "PAYMENT_PENDING", "PAYMENT_UNCERTAIN", "OPERATION_CANCELLED"] as const) assert.equal(FAILURE_HTTP_STATUS[c], 409, c);
  for (const c of ["CAPABILITY_UNAVAILABLE", "SOURCE_EXPIRED", "TARGET_STALE", "PLAN_NOT_VALIDATED", "INTEGRITY_FAILURE"] as const) assert.equal(FAILURE_HTTP_STATUS[c], 422, c);
  for (const c of ["BUDGET_EXHAUSTED", "ADMISSION_LIMITED"] as const) assert.equal(FAILURE_HTTP_STATUS[c], 429, c);
  assert.equal(FAILURE_HTTP_STATUS.CAPACITY_UNAVAILABLE, 503);
  assert.equal(FAILURE_HTTP_STATUS.INTERNAL_ERROR, 500);
  assert.deepEqual([...RETRYABLE_FAILURE_CODES].sort(), ["CAPACITY_UNAVAILABLE", "INTERNAL_ERROR", "PAYMENT_PENDING"]);
  // reasons are closed uppercase tokens
  assert.equal(new Set(FAILURE_REASONS).size, FAILURE_REASONS.length);
  for (const r of FAILURE_REASONS) assert.match(r, /^[A-Z][A-Z0-9_]{2,63}$/);
  for (const t of Object.values(FAILURE_TITLES)) assert.ok(!/[{}$<>]/.test(t), "titles are fixed prose");
});

test("describeFailure projects exactly the wire-safe fields: code, status, title, retryable, reason, fields, current, retryAfter", () => {
  const stale = new StaleVersionFailure(7, "SUPERSEDED", { successorId: "01920000-0000-7000-8000-000000000002", mismatch: ["planHash"] });
  assert.deepEqual(describeFailure(stale), { code: "STALE_VERSION", status: 409, title: FAILURE_TITLES.STALE_VERSION, retryable: false, current: { version: 7, state: "SUPERSEDED", successorId: "01920000-0000-7000-8000-000000000002", mismatch: ["planHash"] } });
  assert.deepEqual(describeFailure(new IdempotencyConflictFailure()), { code: "IDEMPOTENCY_CONFLICT", status: 409, title: FAILURE_TITLES.IDEMPOTENCY_CONFLICT, retryable: false, reason: "REQUEST_DIGEST_DIFFERS" });
  assert.deepEqual(describeFailure(new InvalidRequestFailure([{ field: "verified", code: "UNKNOWN_FIELD" }])), { code: "INVALID_REQUEST", status: 400, title: FAILURE_TITLES.INVALID_REQUEST, retryable: false, fields: [{ field: "verified", code: "UNKNOWN_FIELD" }] });
  assert.deepEqual(describeFailure(new PreconditionFailure("AGENCY_NOT_OPEN", "agency x is CLOSING", { currentState: "CLOSING", currentVersion: 3 })), { code: "PRECONDITION_FAILED", status: 409, title: FAILURE_TITLES.PRECONDITION_FAILED, retryable: false, reason: "AGENCY_NOT_OPEN", current: { version: 3, state: "CLOSING" } });
  assert.deepEqual(describeFailure(new NotFoundFailure("client")), { code: "NOT_FOUND", status: 404, title: FAILURE_TITLES.NOT_FOUND, retryable: false });
  assert.deepEqual(describeFailure(new NotAuthorizedFailure("ROLE_INSUFFICIENT", "m (VIEWER) cannot")), { code: "NOT_AUTHORIZED", status: 403, title: FAILURE_TITLES.NOT_AUTHORIZED, retryable: false, reason: "ROLE_INSUFFICIENT" });
  assert.deepEqual(describeFailure(new DomainFailure("ADMISSION_LIMITED", "rate", { reason: "CREATION_RATE_LIMITED", retryAfterSeconds: 30 })), { code: "ADMISSION_LIMITED", status: 429, title: FAILURE_TITLES.ADMISSION_LIMITED, retryable: false, reason: "CREATION_RATE_LIMITED", retryAfterSeconds: 30 });
  // the message never reaches the projection; a partial current (state without version) is not projected
  const withMessage = describeFailure(new DomainFailure("INTEGRITY_FAILURE", "SELECT * FROM secrets", { currentState: "X" }));
  assert.ok(!JSON.stringify(withMessage).includes("SELECT") && !("current" in withMessage));
  assert.equal(new DomainFailure("NOT_FOUND", "x").name, "DomainFailure");
  assert.equal(new StaleVersionFailure(1, "A").name, "StaleVersionFailure");
});

test("failure messages of the aggregates never carry a request value: labels, purposes and tokens stay out of every message", () => {
  const ag = activeAgency();
  const owner = membership(ag.agencyId, "OWNER", users.owner);
  const secret = "Top Secret Client Ltd";
  const f = refused(() => assertLabel("displayName", secret + "\u0000"), "INVALID_REQUEST");
  assert.ok(!f.message.includes(secret));
  const g = refused(() => assertReasonCode("reasonCode", secret), "INVALID_REQUEST");
  assert.ok(!g.message.includes(secret));
  const c = client(ag.agencyId, owner.membershipId, { displayName: secret, state: "ARCHIVED", version: 2 });
  const h = refused(() => assertInScope({ agencyId: id() as typeof ag.agencyId }, "client", c), "NOT_FOUND");
  assert.ok(!h.message.includes(secret) && !h.message.includes(c.clientId), "a foreign client is not even named");
});

test("field vocabulary: labels are 1..200 characters without control characters; reason codes are uppercase tokens", () => {
  assert.ok(isLabel("Acme") && isLabel("a") && isLabel("é".repeat(200)) && isLabel("with spaces and punctuation!"));
  assert.ok(!isLabel("") && !isLabel("x".repeat(201)) && !isLabel("a\tb") && !isLabel("a\u0085b") && !isLabel(12));
  assert.ok(isReasonCode("LEFT_COMPANY") && isReasonCode("X_Y") && isReasonCode("ABC"));
  assert.ok(!isReasonCode("ab") && !isReasonCode("left_company") && !isReasonCode("1ABC") && !isReasonCode("A".repeat(65)) && !isReasonCode("AB"));
  assert.equal(assertLabel("f", "ok"), "ok");
  assert.deepEqual(refused(() => assertLabel("f", null), "INVALID_REQUEST").details.fields, [{ field: "f", code: "TYPE" }]);
});

test("optimistic concurrency (D-VER-1): expectedVersion must match; the next version is exactly + 1; stale carries current and successor", () => {
  const record = { version: 3, state: "VALIDATED" };
  assert.equal(assertExpectedVersion(record, 3), record);
  assert.equal(nextVersion(record), 4);
  const stale = refused(() => assertExpectedVersion(record, 2), "STALE_VERSION");
  assert.deepEqual([stale.details.currentVersion, stale.details.currentState], [3, "VALIDATED"]);
  const superseded = refused(() => assertExpectedVersion({ version: 4, state: "SUPERSEDED" }, 3, { successorId: "s" }), "STALE_VERSION");
  assert.equal(superseded.details.successorId, "s");
  refused(() => assertExpectedVersion(record, 4), "STALE_VERSION");
  for (const bad of [0, -3, 2.5, Number.POSITIVE_INFINITY, Number.NaN]) {
    const f = refused(() => assertExpectedVersion(record, bad), "INVALID_REQUEST");
    assert.deepEqual(f.details.fields, [{ field: "expectedVersion", code: "RANGE" }]);
  }
  assert.ok(isVersion(1) && isVersion(Number.MAX_SAFE_INTEGER) && !isVersion(0) && !isVersion("1") && !isVersion(1.1));
  assert.equal(assertVersionField("expectedVersion", 9), 9);
  assert.deepEqual(refused(() => assertVersionField("expectedVersion", "9"), "INVALID_REQUEST").details.fields, [{ field: "expectedVersion", code: "TYPE" }]);
  assert.throws(() => nextVersion({ version: 0, state: "X" }), RangeError);
});

test("tenant scope: a record of another agency or none is NOT_FOUND; a cross-tenant child link is never followed", () => {
  const ag = activeAgency();
  const context: TenantContext = { kind: "TENANT", agencyId: ag.agencyId, userId: users.owner, correlationId: id() as TenantContext["correlationId"] };
  const scope = tenantScopeOf(context);
  assert.deepEqual(scope, { agencyId: ag.agencyId });
  const owner = membership(ag.agencyId, "OWNER", users.owner);
  const mine = client(ag.agencyId, owner.membershipId);
  assert.equal(assertInScope(scope, "client", mine), mine);
  refused(() => assertInScope(scope, "client", null), "NOT_FOUND");
  const foreign = client(id() as typeof ag.agencyId, owner.membershipId);
  const f = refused(() => assertInScope(scope, "client", foreign), "NOT_FOUND");
  assert.equal(f.reason, undefined, "no reason distinguishes foreign from nonexistent");
  assertSameScope("client", ag, mine);
  refused(() => assertSameScope("client", ag, foreign), "NOT_FOUND", "CROSS_AGENCY");
});
