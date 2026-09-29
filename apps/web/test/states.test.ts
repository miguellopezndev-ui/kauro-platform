// D-STATE-1: the exhaustive problem-code state table. The oracle is the design's own decision text (B11 design D-STATE-1) and the api
// contract: manual 10 names 17 stable codes and the api adds PRECONDITION_FAILED, ADMISSION_LIMITED and INTERNAL_ERROR. One test per code
// states the state, the one next step, and what the state keeps or shows; prose is never read.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SCHEMAS, type Problem } from "../src/api/generated.ts";
import type { ApiAnswer } from "../src/client/answer.ts";
import type { RunOutcome } from "../src/client/operation-runner.ts";
import { loading, PROBLEM_STATES, REASON_STATES, SHARED_STATES, type SharedState, stateOfAnswer, stateOfProblem, stateOfRun } from "../src/client/states.ts";

const CORRELATION = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f99";

/** The 17 stable codes of manual 10 "Responses and safe errors", in the manual's order. */
const MANUAL_10_CODES = [
  "INVALID_REQUEST",
  "AUTHENTICATION_REQUIRED",
  "ASSURANCE_REQUIRED",
  "NOT_AUTHORIZED",
  "NOT_FOUND",
  "STALE_VERSION",
  "IDEMPOTENCY_CONFLICT",
  "CAPABILITY_UNAVAILABLE",
  "SOURCE_EXPIRED",
  "TARGET_STALE",
  "PLAN_NOT_VALIDATED",
  "PAYMENT_PENDING",
  "PAYMENT_UNCERTAIN",
  "BUDGET_EXHAUSTED",
  "CAPACITY_UNAVAILABLE",
  "INTEGRITY_FAILURE",
  "OPERATION_CANCELLED",
] as const;
const API_ONLY_CODES = ["PRECONDITION_FAILED", "ADMISSION_LIMITED", "INTERNAL_ERROR"] as const;

/** The HTTP status the api answers each code with (10 "Responses and safe errors"; B06 problems.ts). */
const STATUS: Readonly<Record<Problem["code"], number>> = {
  INVALID_REQUEST: 400,
  AUTHENTICATION_REQUIRED: 401,
  ASSURANCE_REQUIRED: 403,
  NOT_AUTHORIZED: 403,
  NOT_FOUND: 404,
  STALE_VERSION: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PRECONDITION_FAILED: 409,
  PAYMENT_PENDING: 409,
  PAYMENT_UNCERTAIN: 409,
  OPERATION_CANCELLED: 409,
  CAPABILITY_UNAVAILABLE: 422,
  SOURCE_EXPIRED: 422,
  TARGET_STALE: 422,
  PLAN_NOT_VALIDATED: 422,
  INTEGRITY_FAILURE: 422,
  BUDGET_EXHAUSTED: 429,
  ADMISSION_LIMITED: 429,
  CAPACITY_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

function problem(code: Problem["code"], extra: Partial<Problem> = {}): Problem {
  return { type: `urn:kauro:problem:${code}`, title: `title of ${code}`, status: STATUS[code], code, correlationId: CORRELATION, retryable: false, nextActions: [], ...extra };
}

interface Expectation {
  readonly state: SharedState;
  readonly next: string;
  readonly keepsLocalEdits?: boolean;
  readonly showsSupportReference?: boolean;
  readonly discouragesRepeat?: boolean;
}

/** Written from the design's D-STATE-1 sentence, code by code; it does not import the table under test. */
const EXPECTED: Readonly<Record<Problem["code"], Expectation>> = {
  INVALID_REQUEST: { state: "UNSAVED", next: "FIX_FIELDS", keepsLocalEdits: true },
  AUTHENTICATION_REQUIRED: { state: "DENIED", next: "SIGN_IN" },
  ASSURANCE_REQUIRED: { state: "DENIED", next: "STEP_UP", keepsLocalEdits: true },
  NOT_AUTHORIZED: { state: "DENIED", next: "NONE" },
  NOT_FOUND: { state: "DENIED", next: "NONE" },
  STALE_VERSION: { state: "STALE", next: "COMPARE_VERSIONS" },
  IDEMPOTENCY_CONFLICT: { state: "STALE", next: "RELOAD" },
  CAPABILITY_UNAVAILABLE: { state: "RESTRICTED", next: "CHOOSE_ANOTHER_MODE" },
  SOURCE_EXPIRED: { state: "EXPIRED", next: "REQUEST_NEW_REVIEW" },
  TARGET_STALE: { state: "STALE", next: "COMPARE_VERSIONS" },
  PLAN_NOT_VALIDATED: { state: "UNSAVED", next: "REQUEST_NEW_REVIEW", keepsLocalEdits: true },
  PAYMENT_PENDING: { state: "PENDING", next: "REQUERY", discouragesRepeat: true },
  PAYMENT_UNCERTAIN: { state: "UNCERTAIN", next: "CONTACT_SUPPORT", showsSupportReference: true, discouragesRepeat: true },
  BUDGET_EXHAUSTED: { state: "RESTRICTED", next: "CONTACT_SUPPORT" },
  CAPACITY_UNAVAILABLE: { state: "RESTRICTED", next: "RETRY_LATER" },
  INTEGRITY_FAILURE: { state: "INTEGRITY_FAILURE", next: "CONTACT_SUPPORT", showsSupportReference: true },
  OPERATION_CANCELLED: { state: "CANCELLED", next: "RELOAD" },
  PRECONDITION_FAILED: { state: "STALE", next: "RELOAD" },
  ADMISSION_LIMITED: { state: "RESTRICTED", next: "RETRY_LATER" },
  INTERNAL_ERROR: { state: "PENDING", next: "REQUERY", showsSupportReference: true },
};

test("D-STATE-1: the table covers exactly the api's closed code set, which is manual 10's seventeen stable codes and three the api adds", () => {
  const schemaCodes = (SCHEMAS.Problem.properties?.["code"] as { enum: readonly string[] }).enum;
  assert.deepEqual([...schemaCodes].sort(), [...MANUAL_10_CODES, ...API_ONLY_CODES].sort());
  assert.deepEqual(Object.keys(PROBLEM_STATES).sort(), [...schemaCodes].sort(), "no code without a decision, no decision without a code");
  assert.deepEqual(Object.keys(STATUS).sort(), [...schemaCodes].sort());
  for (const [code, entry] of Object.entries(PROBLEM_STATES)) assert.ok((SHARED_STATES as readonly string[]).includes(entry.state), `${code} maps to one of the 14 shared states`);
});

for (const code of [...MANUAL_10_CODES, ...API_ONLY_CODES]) {
  test(`D-STATE-1: ${code} is ${EXPECTED[code].state}, offers ${EXPECTED[code].next}, and never reads prose`, () => {
    const expected = EXPECTED[code];
    const decision = stateOfProblem(problem(code));
    assert.equal(decision.state, expected.state);
    assert.equal(decision.next, expected.next);
    assert.equal(decision.keepsLocalEdits, expected.keepsLocalEdits === true);
    assert.equal(decision.showsSupportReference, expected.showsSupportReference === true);
    assert.equal(decision.discouragesRepeat, expected.discouragesRepeat === true);
    assert.equal(decision.supportReference, expected.showsSupportReference === true ? CORRELATION : null, "the correlation id is the support reference exactly where the state shows one");
    assert.equal(decision.cause, `PROBLEM:${code}`);
    // prose never decides: every other code's title, a hostile title and a made-up type leave the decision as it is
    for (const other of [...MANUAL_10_CODES, ...API_ONLY_CODES]) assert.deepEqual(stateOfProblem(problem(code, { title: `title of ${other}`, type: `urn:kauro:problem:${other}` })), decision);
    assert.deepEqual(stateOfProblem(problem(code, { title: "Please sign in again, your session expired" })), decision);
    // and the same code with a reason the table does not name is the same decision (only three reasons of one code are named)
    if (code !== "PRECONDITION_FAILED") assert.deepEqual(stateOfProblem(problem(code, { reason: "SCHEMA_VIOLATION" })), decision);
  });
}

test("D-STATE-1: NOT_FOUND and NOT_AUTHORIZED are one not-available answer that discloses nothing about existence, whatever the reason", () => {
  const reasons: readonly (Problem["reason"] | undefined)[] = [undefined, "NOT_A_MEMBER", "ROLE_INSUFFICIENT", "CROSS_AGENCY", "UNKNOWN_REFERENCE", "PATH_ID_INVALID"];
  const visible = (p: Problem) => {
    const { cause: _cause, ...rest } = stateOfProblem(p);
    return rest;
  };
  const reference = visible(problem("NOT_FOUND"));
  for (const code of ["NOT_FOUND", "NOT_AUTHORIZED"] as const) {
    for (const reason of reasons) assert.deepEqual(visible(problem(code, reason === undefined ? {} : { reason })), reference, `${code} ${reason ?? "-"}`);
  }
  assert.deepEqual(reference, { state: "DENIED", next: "NONE", keepsLocalEdits: false, showsSupportReference: false, discouragesRepeat: false, supportReference: null, retryAfterSeconds: null, fieldErrors: [], current: null });
});

test("D-STATE-1: STALE_VERSION and TARGET_STALE carry the server's current facts for the comparison; INVALID_REQUEST carries its safe field errors; nothing else does", () => {
  const current = { version: 7, state: "APPROVED", successorId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f01", mismatch: ["planHash"] };
  const errors = [{ field: "displayName", code: "REQUIRED" }, { field: "processingAuthorityRef", code: "FORMAT" }] as const;
  const stale = stateOfProblem(problem("STALE_VERSION", { current }));
  assert.deepEqual(stale.current, current);
  assert.equal(stateOfProblem(problem("TARGET_STALE", { current })).current?.version, 7);
  assert.equal(stateOfProblem(problem("STALE_VERSION")).current, null, "a stale answer without facts offers a reload and compares nothing");
  assert.deepEqual(stateOfProblem(problem("INVALID_REQUEST", { errors })).fieldErrors, errors);
  assert.deepEqual(stateOfProblem(problem("INVALID_REQUEST")).fieldErrors, []);
  assert.deepEqual(stateOfProblem(problem("NOT_FOUND", { errors, current })).fieldErrors, [], "an unrelated code never surfaces field errors");
  assert.equal(stateOfProblem(problem("NOT_FOUND", { errors, current })).current, null);
  assert.equal(stateOfProblem(problem("CAPACITY_UNAVAILABLE", { retryAfterSeconds: 30, retryable: true })).retryAfterSeconds, 30);
  assert.equal(stateOfProblem(problem("ADMISSION_LIMITED", { retryAfterSeconds: 120 })).retryAfterSeconds, 120);
});

test("D-STATE-1: three closed reasons of PRECONDITION_FAILED change its state and no other reason of any code does", () => {
  const reasonOf = (reason: NonNullable<Problem["reason"]>) => stateOfProblem(problem("PRECONDITION_FAILED", { reason }));
  assert.deepEqual([reasonOf("OPERATION_PENDING").state, reasonOf("OPERATION_PENDING").next, reasonOf("OPERATION_PENDING").cause], ["PENDING", "REQUERY", "PROBLEM:PRECONDITION_FAILED/OPERATION_PENDING"], "another request under the same key is still in flight: query it, never duplicate it");
  assert.deepEqual([reasonOf("AGENCY_NOT_OPEN").state, reasonOf("AGENCY_NOT_OPEN").next], ["RESTRICTED", "CONTACT_SUPPORT"]);
  assert.deepEqual([reasonOf("NO_SEMANTIC_CHANGE").state, reasonOf("NO_SEMANTIC_CHANGE").next, reasonOf("NO_SEMANTIC_CHANGE").keepsLocalEdits], ["UNSAVED", "FIX_FIELDS", true]);
  for (const reason of ["PLAN_SUPERSEDED", "PLAN_WITHDRAWN", "CLIENT_ARCHIVED", "UNLISTED_TRANSITION", "CONSEQUENCES_UNRECONCILED", "PLAN_NOT_APPROVED"] as const) {
    assert.deepEqual([reasonOf(reason).state, reasonOf(reason).next], ["STALE", "RELOAD"], reason);
  }
  assert.deepEqual(Object.keys(REASON_STATES), ["PRECONDITION_FAILED"], "only that code has reason overrides");
  assert.deepEqual(Object.keys(REASON_STATES["PRECONDITION_FAILED"] ?? {}).sort(), ["AGENCY_NOT_OPEN", "NO_SEMANTIC_CHANGE", "OPERATION_PENDING"]);
  // the same three reasons under another code mean nothing there
  assert.equal(stateOfProblem(problem("STALE_VERSION", { reason: "OPERATION_PENDING" })).state, "STALE");
});

test("D-STATE-1: a reply that never arrived is Checking (Pending, re-query), never failed; a reply that broke the contract is an Integrity failure with its support reference", () => {
  for (const reason of ["NETWORK", "TIMEOUT", "ABORTED", "UNREADABLE"] as const) {
    const decision = stateOfAnswer({ kind: "NO_ANSWER", reason, status: reason === "UNREADABLE" ? 502 : null });
    assert.deepEqual([decision.state, decision.next, decision.cause], ["PENDING", "REQUERY", `NO_ANSWER:${reason}`]);
  }
  for (const failure of ["REPLY_FAILED_CONTRACT", "PROBLEM_FAILED_CONTRACT", "UNEXPECTED_STATUS", "UNEXPECTED_MEDIA_TYPE"] as const) {
    const decision = stateOfAnswer({ kind: "INTEGRITY", status: 200, correlationId: CORRELATION, failure });
    assert.deepEqual([decision.state, decision.next, decision.showsSupportReference, decision.supportReference], ["INTEGRITY_FAILURE", "CONTACT_SUPPORT", true, CORRELATION]);
    assert.equal(stateOfAnswer({ kind: "INTEGRITY", status: 200, correlationId: null, failure }).supportReference, null);
  }
});

test("D-STATE-1: a valid read is Ready, Empty or Deleted by the screen's own classifiers; Loading shows the fetch and clears the old view", () => {
  const reply = (body: { readonly items: readonly number[]; readonly deleted?: boolean }): ApiAnswer<typeof body> => ({ kind: "REPLY", status: 200, correlationId: CORRELATION, body });
  const classifiers = { isEmpty: (b: { items: readonly number[] }) => b.items.length === 0, isDeleted: (b: { deleted?: boolean }) => b.deleted === true };
  assert.equal(stateOfAnswer(reply({ items: [1] }), classifiers).state, "READY");
  assert.equal(stateOfAnswer(reply({ items: [] }), classifiers).state, "EMPTY");
  assert.equal(stateOfAnswer(reply({ items: [], deleted: true }), classifiers).state, "DELETED", "deleted wins over empty");
  assert.equal(stateOfAnswer(reply({ items: [] })).state, "READY", "no classifier, no claim");
  assert.equal(stateOfAnswer({ kind: "PROBLEM", status: 404, correlationId: CORRELATION, problem: problem("NOT_FOUND") }).state, "DENIED");
  const busy = loading();
  assert.deepEqual([busy.state, busy.next, busy.supportReference, busy.current, busy.fieldErrors], ["LOADING", "NONE", null, null, []]);
});

test("D-STATE-1: Success comes only from a COMPLETED envelope or a re-read that found the result; accepted work is Pending; a run that lost its answer is Checking", () => {
  const accepted = { kind: "ACCEPTED", operationId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5f55", state: "QUEUED", statusPath: "/api/v1/operations/x", pollAfterSeconds: 5 } as const;
  const outcomes: readonly (readonly [RunOutcome<unknown>, SharedState, string, number | null])[] = [
    [{ kind: "COMPLETED", key: "k", data: {}, version: 1, replayed: false, attempts: 1 }, "SUCCESS", "RUN:COMPLETED", null],
    [{ kind: "COMPLETED", key: "k", data: {}, version: 1, replayed: true, attempts: 1 }, "SUCCESS", "RUN:COMPLETED_REPLAYED", null],
    [{ kind: "RECOVERED", key: "k", data: {}, attempts: 3 }, "SUCCESS", "RUN:RECOVERED", null],
    [{ kind: "ACCEPTED", key: "k", accepted, attempts: 1 }, "PENDING", "RUN:ACCEPTED", 5],
    [{ kind: "CHECKING", key: "k", attempts: 3, lastRead: "NOT_YET" }, "PENDING", "RUN:CHECKING/NOT_YET", null],
    [{ kind: "CHECKING", key: "k", attempts: 3, lastRead: "NO_ANSWER" }, "PENDING", "RUN:CHECKING/NO_ANSWER", null],
    [{ kind: "CHECKING", key: "k", attempts: 3, lastRead: "NOT_ATTEMPTED" }, "PENDING", "RUN:CHECKING/NOT_ATTEMPTED", null],
    [{ kind: "INTEGRITY", key: "k", failure: "REPLY_FAILED_CONTRACT", correlationId: CORRELATION, attempts: 1 }, "INTEGRITY_FAILURE", "RUN:INTEGRITY/REPLY_FAILED_CONTRACT", null],
    [{ kind: "PROBLEM", key: "k", problem: problem("PAYMENT_UNCERTAIN"), status: 409, correlationId: CORRELATION, attempts: 1 }, "UNCERTAIN", "PROBLEM:PAYMENT_UNCERTAIN", null],
  ];
  for (const [outcome, state, cause, retryAfter] of outcomes) {
    const decision = stateOfRun(outcome);
    assert.deepEqual([decision.state, decision.cause, decision.retryAfterSeconds], [state, cause, retryAfter], cause);
  }
  assert.equal(stateOfRun(outcomes[7]![0]).supportReference, CORRELATION);
  // no run outcome other than the first three is ever Success: an unexpected 500 does not mean the command did not commit, and does not mean it did
  for (const [outcome] of outcomes.slice(3)) assert.notEqual(stateOfRun(outcome).state, "SUCCESS");
});

test("D-STATE-1: the 14 shared states of the reference are the ones this table can produce, and every one of them is reachable", () => {
  assert.deepEqual([...SHARED_STATES], ["LOADING", "EMPTY", "READY", "UNSAVED", "STALE", "DENIED", "RESTRICTED", "PENDING", "UNCERTAIN", "EXPIRED", "CANCELLED", "INTEGRITY_FAILURE", "DELETED", "SUCCESS"]);
  const reached = new Set<SharedState>();
  reached.add(loading().state);
  reached.add(stateOfAnswer({ kind: "REPLY", status: 200, correlationId: CORRELATION, body: 1 }, { isEmpty: () => true }).state);
  reached.add(stateOfAnswer({ kind: "REPLY", status: 200, correlationId: CORRELATION, body: 1 }, { isDeleted: () => true }).state);
  reached.add(stateOfAnswer({ kind: "REPLY", status: 200, correlationId: CORRELATION, body: 1 }).state);
  for (const code of Object.keys(PROBLEM_STATES) as (keyof typeof PROBLEM_STATES)[]) reached.add(stateOfProblem(problem(code)).state);
  reached.add(stateOfRun({ kind: "COMPLETED", key: "k", data: 1, version: 1, replayed: false, attempts: 1 }).state);
  assert.deepEqual([...reached].sort(), [...SHARED_STATES].sort());
});
