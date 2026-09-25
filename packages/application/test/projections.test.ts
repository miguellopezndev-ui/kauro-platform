// DTO projections select fields explicitly (10 "safe projections") and readiness blockers derive from durable facts in a
// fixed order (CMD011 effect "visible readiness blockers"; 10 "A UI readiness flag is informative, not authority").
import assert from "node:assert/strict";
import { test } from "node:test";
import { agencyView, membershipView, readinessBlockersOf } from "../src/index.js";
import { world } from "./support.js";

test("readiness blockers: every missing fact is named once, in a fixed order; an approved plan on a sealed revision of an active agency has none", () => {
  const draftAgency = { state: "DRAFT" as const };
  const offered = { state: "AVAILABLE_LIMITED" as const };
  assert.deepEqual(readinessBlockersOf({ agency: draftAgency, capability: offered, currentRevision: { state: "DRAFT" }, targetContract: null, plan: null }), ["AGENCY_NOT_ACTIVE", "NO_SEALED_REVISION", "TARGET_CONTRACT_MISSING", "PLAN_MISSING"]);
  assert.deepEqual(readinessBlockersOf({ agency: { state: "ACTIVE" }, capability: { state: "SUSPENDED" }, currentRevision: { state: "SEALED" }, targetContract: {}, plan: { state: "VALIDATED" } }), ["CAPABILITY_RESTRICTED", "TARGET_CONTRACT_UNCONFIRMED", "PLAN_NOT_APPROVED"]);
  assert.deepEqual(readinessBlockersOf({ agency: { state: "ACTIVE" }, capability: null, currentRevision: { state: "SEALED" }, targetContract: { confirmedAt: "2026-09-19T12:00:00.000Z", supersededAt: "2026-09-19T13:00:00.000Z" }, plan: { state: "VALIDATION_REQUIRED" } }), ["CAPABILITY_RESTRICTED", "TARGET_CONTRACT_UNCONFIRMED", "PLAN_NOT_VALIDATED"]);
  assert.deepEqual(readinessBlockersOf({ agency: { state: "ACTIVE" }, capability: { state: "AVAILABLE" }, currentRevision: { state: "SEALED" }, targetContract: { confirmedAt: "2026-09-19T12:00:00.000Z" }, plan: { state: "APPROVED" } }), []);
});

test("views never carry internal columns: no createdByUserId on an agency view, no revokedAt or updatedAt on a membership view; permitted actions derive from the role", () => {
  const w = world();
  const agency = agencyView(w.store().agencies.get(w.agencyId)!, "VIEWER");
  assert.deepEqual(Object.keys(agency).sort(), ["agencyId", "createdAt", "displayName", "permittedActions", "state", "version"]);
  assert.deepEqual(agency.permittedActions, ["VIEW"]);
  const m = membershipView(w.store().memberships.get(w.ownerMembershipId)!);
  assert.deepEqual(Object.keys(m).sort(), ["acceptedAt", "agencyId", "assurancePolicy", "membershipId", "role", "state", "userId", "version"]);
});
