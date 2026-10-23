// Order 22 claims and alerts (CP-01.04, .06, .07, .14; candidate CMD068, CMD071, CMD072, Alert, SellerAlertView): the seven neutral
// codes, owner rules never retroactive, one review per refusal, what each party reads, one alert per subject; and the drift guard that
// ties every candidate value to the owner's CP-01 delta.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { o22 } from "../src/index.js";

const EV = "0194f7a0-0000-7000-8000-000000000001";
const FACTS = "2026-03-01T15:00:00.000Z";
const RULES: o22.OwnerRule[] = [
  { ruleId: "OR-DIRECT", ruleVersion: 1, inForceFrom: "2026-01-01T00:00:00.000Z", inForceUntil: "2026-02-15T00:00:00.000Z" },
  { ruleId: "OR-DIRECT", ruleVersion: 2, inForceFrom: "2026-02-15T00:00:00.000Z", inForceUntil: null },
  { ruleId: "OR-LATE", ruleVersion: 1, inForceFrom: "2026-03-02T00:00:00.000Z", inForceUntil: null },
];
const refuse = (request: Partial<o22.RefusalRequest>, claimState: o22.ClaimState = "SUBMITTED") =>
  o22.validateRefusal({ claimState, factsAt: FACTS, ownerRules: RULES, request: { reasonCode: "CUSTOMER_OR_DIRECT_CONTACT", listVersion: "CLAIM-REFUSAL-1", evidenceRef: EV, ...request } });
const reasonOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof o22.O22Failure) return e.reason;
    throw e;
  }
  return "NO_FAILURE";
};

test("the seven codes, each with evidence, and the seller reads only the code's neutral message", () => {
  assert.deepEqual(o22.CLAIM_REFUSAL_REASONS.map((r) => r.code), ["CUSTOMER_OR_DIRECT_CONTACT", "OTHER_SELLER_LIVE_CLAIM", "OWNER_RULE", "INSUFFICIENT_OWN_WORK_EVIDENCE", "OUTSIDE_SELLER_AGREEMENT", "DUPLICATE_OWN_CLAIM", "OTHER"]);
  for (const r of o22.CLAIM_REFUSAL_REASONS) {
    const v = refuse({ reasonCode: r.code, ...(r.code === "OTHER" ? { note: "internal: the agency was a direct inbound lead" } : {}), ...(r.code === "OWNER_RULE" ? { ownerRuleRef: "OR-DIRECT@2" } : {}) }, "DISPUTED");
    assert.equal(v.sellerMessage, r.sellerMessage);
    assert.equal(v.legalStatus, "PENDING_COUNSEL");
    assert.ok(!v.sellerMessage.includes("internal"), "the message never derives from the note");
  }
});

test("adversarial refusals are refused with the candidate's reason and no partial record", () => {
  assert.equal(reasonOf(() => refuse({ evidenceRef: null })), "REFUSAL_EVIDENCE_REQUIRED");
  assert.equal(reasonOf(() => refuse({ evidenceRef: "" })), "REFUSAL_EVIDENCE_REQUIRED");
  assert.equal(reasonOf(() => refuse({ reasonCode: "OTHER" })), "NOTE_REQUIRED");
  assert.equal(reasonOf(() => refuse({ reasonCode: "OTHER", note: "   \n " })), "NOTE_REQUIRED");
  assert.equal(reasonOf(() => refuse({ reasonCode: "other" })), "REFUSAL_REASON_UNKNOWN");
  assert.equal(reasonOf(() => refuse({ reasonCode: "TIMESTAMP_ONLY" })), "REFUSAL_REASON_UNKNOWN");
  assert.equal(reasonOf(() => refuse({ listVersion: "CLAIM-REFUSAL-0" })), "REFUSAL_LIST_VERSION_STALE");
  assert.equal(reasonOf(() => refuse({ reasonCode: "OWNER_RULE" })), "OWNER_RULE_REFERENCE_REQUIRED");
  assert.equal(reasonOf(() => refuse({ reasonCode: "OWNER_RULE", ownerRuleRef: "OR-DIRECT" })), "OWNER_RULE_REFERENCE_REQUIRED");
  assert.equal(reasonOf(() => refuse({ reasonCode: "OWNER_RULE", ownerRuleRef: "OR-LATE@1" })), "OWNER_RULE_NOT_IN_FORCE", "a rule in force after the facts is retroactive");
  assert.equal(reasonOf(() => refuse({ reasonCode: "OWNER_RULE", ownerRuleRef: "OR-DIRECT@1" })), "OWNER_RULE_NOT_IN_FORCE", "a superseded version is not the one in force");
  assert.equal(reasonOf(() => refuse({ reasonCode: "OWNER_RULE", ownerRuleRef: "OR-NOPE@1" })), "OWNER_RULE_NOT_IN_FORCE");
  assert.equal(reasonOf(() => refuse({ ownerRuleRef: "OR-DIRECT@2" })), "OWNER_RULE_NOT_ALLOWED");
  for (const state of ["ACCEPTED", "REJECTED", "EXPIRED", "CONVERTED"] as const) assert.equal(reasonOf(() => refuse({}, state)), "CLAIM_NOT_REFUSABLE", state);
  assert.deepEqual(refuse({ reasonCode: "OWNER_RULE", ownerRuleRef: "OR-DIRECT@2" }).ownerRule, { ruleId: "OR-DIRECT", ruleVersion: 2 });
});

test("one review per refusal; UPHOLD keeps a listed code; CHANGE withdraws the refusal and never accepts the claim", () => {
  assert.equal(o22.reviewAvailable({ claimState: "REJECTED", liveRefusalId: "R1", reviewedRefusalIds: new Set() }), true);
  assert.equal(o22.reviewAvailable({ claimState: "REJECTED", liveRefusalId: "R1", reviewedRefusalIds: new Set(["R1"]) }), false);
  assert.equal(o22.reviewAvailable({ claimState: "ACCEPTED", liveRefusalId: null, reviewedRefusalIds: new Set() }), false);
  assert.equal(reasonOf(() => o22.assertReviewRequestable({ claimState: "ACCEPTED", liveRefusalId: null, reviewedRefusalIds: new Set() })), "CLAIM_NOT_REVIEWABLE");
  assert.equal(reasonOf(() => o22.assertReviewRequestable({ claimState: "REJECTED", liveRefusalId: null, reviewedRefusalIds: new Set() })), "CLAIM_NOT_REVIEWABLE", "a claim rejected by an allocation has no refusal to review");
  assert.equal(reasonOf(() => o22.assertReviewRequestable({ claimState: "REJECTED", liveRefusalId: "R1", reviewedRefusalIds: new Set(["R1"]) })), "REVIEW_ALREADY_REQUESTED");
  assert.deepEqual(o22.decideReview("REQUESTED", { decision: "UPHOLD", reasonCode: "OTHER_SELLER_LIVE_CLAIM" }, "OTHER_SELLER_LIVE_CLAIM"), { review: "UPHELD", claim: "REJECTED", entry: "REVIEW_UPHELD" });
  assert.deepEqual(o22.decideReview("REQUESTED", { decision: "CHANGE", reasonCode: "NEW_EVIDENCE_ACCEPTED" }, "OTHER"), { review: "CHANGED", claim: "REJECTED", entry: "REVIEW_CHANGED" });
  assert.equal(reasonOf(() => o22.decideReview("REQUESTED", { decision: "UPHOLD", reasonCode: "MADE_UP" }, "OTHER")), "REFUSAL_REASON_UNKNOWN");
  // review F-2: an UPHOLD keeps the refusal's own code; it never re-bases it on OWNER_RULE (no rule named) or OTHER (no note)
  assert.equal(reasonOf(() => o22.decideReview("REQUESTED", { decision: "UPHOLD", reasonCode: "OWNER_RULE" }, "CUSTOMER_OR_DIRECT_CONTACT")), "REFUSAL_REASON_UNKNOWN");
  assert.equal(reasonOf(() => o22.decideReview("REQUESTED", { decision: "UPHOLD", reasonCode: "OTHER" }, "CUSTOMER_OR_DIRECT_CONTACT")), "REFUSAL_REASON_UNKNOWN");
  assert.equal(reasonOf(() => o22.decideReview("UPHELD", { decision: "CHANGE", reasonCode: "X_Y_Z" }, "OTHER")), "REVIEW_NOT_OPEN");
  assert.equal(reasonOf(() => o22.decideReview("CHANGED", { decision: "UPHOLD", reasonCode: "OTHER" }, "OTHER")), "REVIEW_NOT_OPEN");
});

test("the seller's history entry carries no reason, evidence or note", () => {
  const owner: o22.ClaimDecisionEntry = { claimId: "C", sequence: 3, kind: "REFUSED", at: FACTS, actorKind: "KAURO_OWNER", reasonCode: "OTHER", evidenceRef: EV, note: "secret", sellerMessage: "Not available to claim" };
  const seller = o22.sellerEntryOf(owner);
  assert.deepEqual(Object.keys(seller).sort(), ["at", "claimId", "kind", "sellerMessage", "sequence"]);
  assert.ok(!JSON.stringify(seller).includes("secret") && !JSON.stringify(seller).includes(EV));
});

const DAY = 86_400_000;
const at = (base: string, days: number): string => new Date(Date.parse(base) + days * DAY).toISOString();
const NOW = "2026-06-15T15:00:00.000Z";

test("claim ends alert 14 and 3 days before and once passed; each threshold its own key", () => {
  const END = at(NOW, 20);
  const claim: o22.AlertSubject = { subjectKind: "CLAIM", subjectId: "CL", sellerId: "S", endsAt: END };
  const when = (daysBeforeEnd: number) => o22.alertsAt([claim], at(END, -daysBeforeEnd));
  assert.equal(when(15).length, 0);
  const a14 = when(14)[0] as o22.Alert;
  assert.equal(a14.kind, "DEADLINE_SOON");
  assert.equal(a14.since, at(END, -14));
  const a10 = when(10)[0] as o22.Alert;
  assert.equal(a10.alertKey, a14.alertKey, "the same threshold de-duplicates");
  const a3 = when(3)[0] as o22.Alert;
  assert.notEqual(a3.alertKey, a14.alertKey, "the 3-day alert is a new send");
  assert.equal(a3.since, at(END, -3));
  const passed = when(0)[0] as o22.Alert;
  assert.equal(passed.kind, "DEADLINE_PASSED");
  assert.equal(passed.conditionCode, "CLAIM_END");
});

test("one alert per subject under its most urgent kind; the others on its second line", () => {
  const project: o22.AlertSubject = {
    subjectKind: "PROJECT",
    subjectId: "PJ",
    agencyId: "AG",
    blockedSince: at(NOW, -1),
    deadlines: [
      { conditionCode: "QUOTE_EXPIRY", dueAt: at(NOW, -2) },
      { conditionCode: "FILE_DELETION", dueAt: at(NOW, 1) },
      { conditionCode: "PAYMENT_DUE", dueAt: at(NOW, 9) },
    ],
    acts: [],
    openedAt: at(NOW, -40),
  };
  const alerts = o22.alertsAt([project], NOW);
  assert.equal(alerts.length, 1);
  const a = alerts[0] as o22.Alert;
  assert.equal(a.kind, "BLOCKED");
  assert.deepEqual(a.otherConditions.map((c) => `${c.kind}:${c.conditionCode}`), ["DEADLINE_PASSED:QUOTE_EXPIRY", "DEADLINE_SOON:FILE_DELETION", "INACTIVE:NO_MATERIAL_PROGRESS"]);
  assert.equal(a.agencyId, "AG");
  assert.equal(a.policyVersion, o22.ALERTS_POLICY_VERSION);
  assert.throws(() => o22.alertsAt([project, project], NOW), /twice/);
});

test("inactivity counts only material acts; reads, sign-ins, reminders, failed retries and replays never reset it", () => {
  const acts: o22.ProjectAct[] = [
    { kind: "QUOTE_ISSUED", at: at(NOW, -20), changedState: true },
    { kind: "READ", at: at(NOW, -1), changedState: true },
    { kind: "SIGN_IN", at: at(NOW, -1), changedState: true },
    { kind: "REMINDER_OR_NOTIFICATION", at: at(NOW, -2), changedState: true },
    { kind: "FAILED_ATTEMPT_OR_RETRY", at: at(NOW, -1), changedState: false },
    { kind: "APPROVAL_GIVEN", at: at(NOW, -3), changedState: false },
  ];
  assert.equal(o22.lastMaterialProgressAt(acts), at(NOW, -20));
  const a = o22.alertsAt([{ subjectKind: "PROJECT", subjectId: "PJ", agencyId: "AG", blockedSince: null, deadlines: [], acts, openedAt: at(NOW, -60) }], NOW)[0] as o22.Alert;
  assert.equal(a.kind, "INACTIVE");
  assert.equal(a.lastMaterialProgressAt, at(NOW, -20));
  assert.equal(a.since, at(NOW, -6));
  const fresh = o22.alertsAt([{ subjectKind: "PROJECT", subjectId: "PJ", agencyId: "AG", blockedSince: null, deadlines: [], acts: [...acts, { kind: "DELIVERY_MADE", at: at(NOW, -1), changedState: true }], openedAt: at(NOW, -60) }], NOW);
  assert.equal(fresh.length, 0, "a delivery is material progress");
});

test("a seller's alerts are its own claim alerts only, without agency or any other subject", () => {
  const alerts = o22.alertsAt(
    [
      { subjectKind: "CLAIM", subjectId: "MINE", sellerId: "S", endsAt: at(NOW, 2) },
      { subjectKind: "CLAIM", subjectId: "THEIRS", sellerId: "T", endsAt: at(NOW, 2) },
      { subjectKind: "PILOT_REVIEW", subjectId: "PILOT", endsAt: at(NOW, 5) },
      { subjectKind: "PROJECT", subjectId: "PJ", agencyId: "AG", blockedSince: NOW, deadlines: [], acts: [], openedAt: NOW },
    ],
    NOW,
  );
  assert.equal(alerts.length, 4);
  const mine = o22.sellerAlertsOf(alerts, "S");
  assert.deepEqual(mine.map((a) => a.claimId), ["MINE"]);
  assert.deepEqual(Object.keys(mine[0] as object).sort(), ["alertKey", "claimId", "conditionCode", "dueAt", "kind", "policyVersion", "since", "subjectKind"]);
});

test("drift guard: every candidate value equals the owner's CP-01 delta", () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const delta = JSON.parse(readFileSync(`${root}docs/authority/proposals/CP-01.registry-delta.json`, "utf8")) as { items: Array<{ id: string; status: string; patch: Record<string, Array<{ op: string; path: string; value: unknown }>> }> };
  const value = (id: string, path: string): unknown => delta.items.find((i) => i.id === id)?.patch["policy.json"]?.find((o) => o.path === path)?.value;
  assert.equal(value("CP-01.04", "/commission/claimRefusalListVersion"), o22.CLAIM_REFUSAL_LIST_VERSION);
  assert.deepEqual(value("CP-01.04", "/commission/claimRefusalReasons"), JSON.parse(JSON.stringify(o22.CLAIM_REFUSAL_REASONS)));
  assert.deepEqual(value("CP-01.04", "/commission/claimRefusalRules"), JSON.parse(JSON.stringify(o22.CLAIM_REFUSAL_RULES)));
  assert.equal(value("CP-01.05", "/commission/retainerDefaultCentsPerMonth"), Number(o22.RETAINER_DEFAULT_CENTS_PER_MONTH));
  assert.deepEqual(value("CP-01.06", "/alerts"), JSON.parse(JSON.stringify({ ...o22.ALERTS_POLICY })));
  const cp07 = value("CP-01.07", "/alerts/relevantProgress") as { counts: string[]; neverCounts: string[] };
  assert.deepEqual(cp07.counts, [...o22.RELEVANT_PROGRESS_COUNTS]);
  assert.deepEqual(cp07.neverCounts, [...o22.RELEVANT_PROGRESS_NEVER_COUNTS]);
  assert.equal(value("CP-01.13", "/commission/collectionPeriod"), o22.COLLECTION_PERIOD_RULE);
  assert.equal(value("CP-01.13", "/commission/refundPeriod"), o22.REFUND_PERIOD_RULE);
  assert.equal(value("CP-01.13", "/commission/refundRewritesEarlierPeriods"), o22.REFUND_REWRITES_EARLIER_PERIODS);
  assert.equal(value("CP-01.13", "/commission/captureCountedOnce"), o22.CAPTURE_COUNTED_ONCE);
  assert.deepEqual(value("CP-01.13", "/commission/amountStates"), [...o22.AMOUNT_STATES]);
  assert.deepEqual((value("CP-01.14", "/legalStatus") as Record<string, unknown>)["commission.claimRules"], JSON.parse(JSON.stringify(o22.CLAIM_RULES_LEGAL_STATUS)));
  for (const id of ["CP-01.04", "CP-01.05", "CP-01.06", "CP-01.13", "CP-01.14"]) assert.equal(delta.items.find((i) => i.id === id)?.status, "APPROVED_AWAITING_REISSUE", `${id} is approved, not adopted`);
});

test("activation is OFF unless explicitly on", () => {
  assert.equal(o22.o22Activation({}), false);
  assert.equal(o22.o22Activation({ KAURO_O22_CANDIDATE: "true" }), false);
  assert.equal(o22.o22Activation({ KAURO_O22_CANDIDATE: "ON" }), false);
  assert.equal(o22.o22Activation({ KAURO_O22_CANDIDATE: "on" }), true);
});
