// The domain vocabulary of a support case (B11 CMD044): the platform machine SupportCase (D-SUP-6), the opened event and the
// instant its payload admits (D-SUP-5), the content-refusal code (D-SUP-2) and the registry vocabularies the record uses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { STATE_MACHINES, type SupportCase } from "@kauro/contracts";
import {
  AGGREGATE_KINDS,
  DomainFailure,
  EVENT_PAYLOAD_ALLOWLIST,
  EVENT_TYPES,
  FAILURE_HTTP_STATUS,
  FAILURE_REASONS,
  PLATFORM_STATE_MACHINES,
  RETRYABLE_FAILURE_CODES,
  SUPPORT_CASE_STATES,
  SUPPORT_CATEGORIES,
  SUPPORT_SEVERITIES,
  UNLISTED_TRANSITION_POLICY,
  assertAllowlistedPayload,
  consumersOf,
  describeFailure,
  isTerminal,
  statesOf,
  transition,
} from "../src/index.js";
import { refused } from "./fixtures.js";

const CASE_ID = "01920000-0000-7000-8000-0000000000c1";
const PROJECT_ID = "01920000-0000-7000-8000-0000000000c2";

test("SupportCase is a platform machine: born OPEN, CLOSED terminal, no edge listed in this edition (D-SUP-6)", () => {
  assert.ok(!STATE_MACHINES.some((m) => m.contract === "SupportCase"), "the registry has no SupportCase machine; the platform declares it");
  const m = PLATFORM_STATE_MACHINES.find((x) => x.contract === "SupportCase");
  assert.ok(m);
  assert.equal(m.initial, "OPEN");
  assert.deepEqual(m.terminal, ["CLOSED"]);
  assert.deepEqual(m.transitions, []);
  assert.equal(m.unlistedTransition, UNLISTED_TRANSITION_POLICY);
  assert.ok(isTerminal("SupportCase", "CLOSED"));
  assert.ok(statesOf("SupportCase").includes("OPEN"));
  refused(() => transition("SupportCase", "OPEN", "triage"), "PRECONDITION_FAILED", "UNLISTED_TRANSITION");
});

test("the record vocabularies are exactly the registry SupportCase enums", () => {
  const category: ReadonlyArray<SupportCase["category"]> = SUPPORT_CATEGORIES;
  const severity: ReadonlyArray<SupportCase["severity"]> = SUPPORT_SEVERITIES;
  const state: ReadonlyArray<SupportCase["state"]> = SUPPORT_CASE_STATES;
  assert.deepEqual([...category].sort(), ["BILLING", "GENERAL", "IMPORT_GUIDANCE", "PRIVACY", "PRODUCT_DEFECT", "SECURITY"]);
  assert.deepEqual([...severity], ["S1", "S2", "S3", "S4"]);
  assert.deepEqual([...state].sort(), ["CLOSED", "OPEN", "RESOLVED", "TRIAGED", "WAITING_AGENCY", "WAITING_KAURO"]);
  assert.ok(state.includes(PLATFORM_STATE_MACHINES.find((x) => x.contract === "SupportCase")?.initial as SupportCase["state"]));
});

test("support_case.opened.v1 is registered with a closed payload that never carries the summary, and has no subscriber (D-SUP-5)", () => {
  assert.ok((EVENT_TYPES as ReadonlyArray<string>).includes("support_case.opened.v1"));
  assert.ok((AGGREGATE_KINDS as ReadonlyArray<string>).includes("support_case"));
  assert.deepEqual([...EVENT_PAYLOAD_ALLOWLIST["support_case.opened.v1"]], ["caseId", "projectId", "category", "severity", "nextReviewAt"]);
  assert.deepEqual(consumersOf("support_case.opened.v1"), []);
  assertAllowlistedPayload("support_case.opened.v1", { caseId: CASE_ID, projectId: PROJECT_ID, category: "SECURITY", severity: "S2", nextReviewAt: "2026-09-30T22:00:00.000Z" });
  assert.throws(() => assertAllowlistedPayload("support_case.opened.v1", { caseId: CASE_ID, summary: "text" as never }), /not allowlisted/);
  assert.throws(() => assertAllowlistedPayload("support_case.opened.v1", { caseId: CASE_ID, evidenceRefs: [] as never }), /not allowlisted/);
});

test("the payload gate admits canonical UTC instants and nothing that merely looks like a date", () => {
  const ok = (nextReviewAt: string) => assertAllowlistedPayload("support_case.opened.v1", { nextReviewAt });
  ok("2026-09-30T22:00:00.000Z");
  for (const bad of ["2026-09-30T22:00:00Z", "2026-09-30 22:00:00.000Z", "2026-02-30T22:00:00.000Z", "2026-09-30T22:00:00.000+00:00", "yesterday", "a note about 2026-09-30T22:00:00.000Z"]) {
    assert.throws(() => ok(bad), /not a safe reference/, bad);
  }
  // an instant is admitted only where a key of the allowlist carries it; a label stays refused everywhere else
  assert.throws(() => assertAllowlistedPayload("agency.created.v1", { state: "a label with spaces" }), /not a safe reference/);
});

test("CONTENT_REFUSED is a final 422 whose reasons name the detector class and never a value (D-SUP-2)", () => {
  assert.equal(FAILURE_HTTP_STATUS.CONTENT_REFUSED, 422);
  assert.ok(!RETRYABLE_FAILURE_CODES.has("CONTENT_REFUSED"));
  for (const reason of ["SECRET_LIKE_CONTENT", "RECORD_LIKE_CONTENT", "SUPPORT_CALENDAR_UNAVAILABLE"] as const) assert.ok(FAILURE_REASONS.includes(reason), reason);
  const view = describeFailure(new DomainFailure("CONTENT_REFUSED", "the summary looks like a secret", { reason: "SECRET_LIKE_CONTENT" }));
  assert.deepEqual(view, { code: "CONTENT_REFUSED", status: 422, title: view.title, retryable: false, reason: "SECRET_LIKE_CONTENT" });
});
