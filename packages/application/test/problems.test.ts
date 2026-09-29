// Safe problem contract (10 "Responses and safe errors"): every stable code of the manual is present with a status, title
// and next actions; a problem carries no message text from the failure, only code/reason/fields/current version.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTHORITY_FAILURE_CODES, DomainFailure, FAILURE_CODES, IdempotencyConflictFailure, StaleVersionFailure } from "@kauro/domain";
import { PROBLEM_STATUS, PROBLEM_TITLE, internalProblem, problemOf } from "../src/index.js";

const MANUAL_10_CODES = [
  "INVALID_REQUEST", "AUTHENTICATION_REQUIRED", "ASSURANCE_REQUIRED", "NOT_AUTHORIZED", "NOT_FOUND", "STALE_VERSION",
  "IDEMPOTENCY_CONFLICT", "CAPABILITY_UNAVAILABLE", "SOURCE_EXPIRED", "TARGET_STALE", "PLAN_NOT_VALIDATED", "PAYMENT_PENDING",
  "PAYMENT_UNCERTAIN", "BUDGET_EXHAUSTED", "CAPACITY_UNAVAILABLE", "INTEGRITY_FAILURE", "OPERATION_CANCELLED",
];

test("every code of manual 10 is a failure code with a status and a title; platform additions are exactly four", () => {
  for (const c of MANUAL_10_CODES) {
    assert.ok((FAILURE_CODES as ReadonlyArray<string>).includes(c), c);
    assert.ok(AUTHORITY_FAILURE_CODES.has(c as "NOT_FOUND"), c);
  }
  const additions = FAILURE_CODES.filter((c) => !AUTHORITY_FAILURE_CODES.has(c));
  assert.deepEqual(additions, ["PRECONDITION_FAILED", "ADMISSION_LIMITED", "CONTENT_REFUSED", "INTERNAL_ERROR"]);
  for (const c of FAILURE_CODES) {
    assert.ok(Number.isInteger(PROBLEM_STATUS[c]) && PROBLEM_STATUS[c] >= 400 && PROBLEM_STATUS[c] <= 599, c);
    assert.ok(PROBLEM_TITLE[c].length > 0, c);
  }
  assert.equal(PROBLEM_STATUS.STALE_VERSION, 409);
  assert.equal(PROBLEM_STATUS.IDEMPOTENCY_CONFLICT, 409);
  assert.equal(PROBLEM_STATUS.CAPABILITY_UNAVAILABLE, 422);
  assert.equal(PROBLEM_STATUS.NOT_FOUND, 404);
  // B11 W5b (D-PUB-4): a description the detector refuses is a final 422 that points to the secure upload
  assert.equal(PROBLEM_STATUS.CONTENT_REFUSED, 422);
});

test("problems carry code, reason, current version and next actions but never the internal message or SQL", () => {
  const stale = problemOf(new StaleVersionFailure(7, "SUPERSEDED", { successorId: "01920000-0000-7000-8000-000000000002", mismatch: ["planHash"] }), "corr-1");
  assert.equal(stale.status, 409);
  assert.equal(stale.code, "STALE_VERSION");
  assert.deepEqual(stale.current, { version: 7, state: "SUPERSEDED", successorId: "01920000-0000-7000-8000-000000000002", mismatch: ["planHash"] });
  assert.deepEqual(stale.nextActions.map((a) => a.action), ["RELOAD", "COMPARE_VERSIONS"]);
  assert.equal(stale.retryable, false);
  assert.ok(!JSON.stringify(stale).includes("stale version: current is"), "internal message leaked");

  const conflict = problemOf(new IdempotencyConflictFailure(), "corr-2");
  assert.equal(conflict.reason, "REQUEST_DIGEST_DIFFERS");
  assert.equal(conflict.correlationId, "corr-2");

  const invalid = problemOf(new DomainFailure("INVALID_REQUEST", "SELECT * FROM secrets failed", { fields: [{ field: "verified", code: "UNKNOWN_FIELD" }] }), "corr-3");
  assert.deepEqual(invalid.errors, [{ field: "verified", code: "UNKNOWN_FIELD" }]);
  assert.ok(!JSON.stringify(invalid).includes("SELECT"));

  const internal = internalProblem("corr-4");
  assert.equal(internal.status, 500);
  assert.equal(internal.retryable, true);
  assert.equal(internal.correlationId, "corr-4");
});
