// Audit authority in the domain (package B08, mandate B08-PERSISTENCE-AUDIT; docs/design/B08-audit-approval-jobs.md §3, §8.1, §11):
// the policy values of D8-AUD-1 and D8-GRANT-1 against the vendored registry, the grant arithmetic and the audit deadlines, the
// content identity of a decision artifact, and the event vocabulary of the Audit and CostGrant machines. Supporting tests of the
// mandate (its case rows are the persistence suites').
import assert from "node:assert/strict";
import { test } from "node:test";
import { STATE_MACHINES, canonicalBytes, rawDigest, registryJson } from "@kauro/contracts";
import {
  AGGREGATE_KINDS,
  AUDIT_AGGREGATE_KINDS,
  AUDIT_AUTHORITY_EVENT_TYPES,
  AUDIT_CONSUMERS,
  AUDIT_CONTROL_EVENT_TYPES,
  AUDIT_EVENT_SUBSCRIPTIONS,
  AUDIT_FAILURE_REASONS,
  AUDIT_POLICY,
  AUDIT_STATES,
  AUDIT_STEP_OUTCOMES,
  CONSUMERS,
  COST_GRANT_STATES,
  EVENT_PAYLOAD_ALLOWLIST,
  EVENT_TYPES,
  FAILURE_REASONS,
  auditAbsoluteDeadlineOf,
  auditEventTypeOf,
  costGrantEventTypeOf,
  decisionArtifactHashOf,
  grantAvailableCents,
  grantFunds,
  interpretationDeadlineOf,
  modelTaskCheckpointOf,
  modelTaskJournalEventHashOf,
  poolFundsAudit,
  type CostGrantRecord,
} from "../src/index.js";

test("the audit policy values are the registry's: a free audit grant of 150 cents, the 20 min interpretation deadline, the 24 h absolute deadline and one live audit per agency", () => {
  const policy = registryJson<{ intelligence: Record<string, number>; capacity: Record<string, number>; money: Record<string, unknown> }>("policy.json");
  assert.equal(AUDIT_POLICY.freeAuditCeilingCents, policy.intelligence["freeAuditCeilingCents"]);
  assert.equal(AUDIT_POLICY.interpretationSeconds, policy.intelligence["interpretationSeconds"]);
  assert.equal(AUDIT_POLICY.auditAbsoluteSeconds, policy.intelligence["auditAbsoluteSeconds"]);
  assert.equal(AUDIT_POLICY.agencyAudits, policy.capacity["agencyAudits"]);
  assert.equal(AUDIT_POLICY.currency, policy.money["currency"]);
  // the records' state vocabularies are the registry contracts' own
  const contracts = registryJson<Array<{ name: string; fields: Array<{ name: string; type: string }> }>>("contracts.json");
  const enumOf = (contract: string, field: string) => contracts.find((c) => c.name === contract)?.fields.find((f) => f.name === field)?.type.slice("enum:".length).split(",");
  assert.deepEqual([...AUDIT_STATES], enumOf("Audit", "state"));
  assert.deepEqual([...COST_GRANT_STATES], enumOf("CostGrant", "state"));
});

test("grant arithmetic: the available cents are the ceiling less the reservations and the spend; a reservation fits only an AUTHORIZED grant before its expiry with room, and a pool funds a free audit grant only within the policy's ceiling", () => {
  const grant: Pick<CostGrantRecord, "ceilingCents" | "reservedCents" | "reconciledSpendCents" | "state" | "expiresAt" | "kind"> = {
    kind: "PLATFORM_MONTHLY",
    ceilingCents: 400n,
    reservedCents: 150n,
    reconciledSpendCents: 100n,
    state: "AUTHORIZED",
    expiresAt: "2026-10-01T00:00:00.000Z",
  };
  const before = "2026-09-30T23:59:59.999Z";
  assert.equal(grantAvailableCents(grant), 150n);
  assert.equal(grantFunds(grant, 150n, before), true, "the last cents fit exactly");
  assert.equal(grantFunds(grant, 151n, before), false, "one cent more does not");
  assert.equal(grantFunds(grant, 0n, before), false, "a reservation is positive");
  assert.equal(grantFunds(grant, 1n, "2026-10-01T00:00:00.000Z"), false, "never at or after the expiry");
  assert.equal(grantFunds({ ...grant, state: "EXHAUSTED" }, 1n, before), false);
  assert.equal(poolFundsAudit(grant, 150n, before), true);
  assert.equal(poolFundsAudit(grant, BigInt(AUDIT_POLICY.freeAuditCeilingCents + 1), before), false, "a free audit grant stays within the policy");
  assert.equal(poolFundsAudit({ ...grant, kind: "AUDIT" }, 150n, before), false, "an AUDIT grant carves nothing");
});

test("the audit deadlines: the absolute deadline 24 h after the start, the interpretation deadline 20 min after the first INTERPRETING and never past the absolute one", () => {
  const started = "2026-09-29T10:00:00.000Z";
  const absolute = auditAbsoluteDeadlineOf(started);
  assert.equal(absolute, "2026-09-30T10:00:00.000Z");
  assert.equal(interpretationDeadlineOf("2026-09-29T10:05:00.000Z", absolute), "2026-09-29T10:25:00.000Z");
  assert.equal(interpretationDeadlineOf("2026-09-30T09:50:00.000Z", absolute), absolute, "capped by the absolute deadline");
});

test("a decision artifact's content identity is the same for the same document of the same kind and differs across kinds and documents; journal events are hashed apart from them", () => {
  const document = { candidateDecisions: [{ candidateRef: "c-1", effect: "MAP" }] };
  assert.equal(decisionArtifactHashOf("DECISION_PATCH", document), decisionArtifactHashOf("DECISION_PATCH", { candidateDecisions: [{ effect: "MAP", candidateRef: "c-1" }] }), "canonical, key order free");
  assert.notEqual(decisionArtifactHashOf("DECISION_PATCH", document), decisionArtifactHashOf("CANDIDATE_DECISIONS", document));
  assert.notEqual(decisionArtifactHashOf("DECISION_PATCH", document), decisionArtifactHashOf("DECISION_PATCH", { candidateDecisions: [] }));
  assert.notEqual(modelTaskJournalEventHashOf(document), decisionArtifactHashOf("DECISION_PATCH", document), "another domain");
  assert.match(modelTaskJournalEventHashOf({ kind: "reservation", costCents: 25 }), /^[0-9a-f]{64}$/);
});

test("the audit events: one registered `<kind>.<state>.v1` for every Audit and CostGrant state, allowlisted payloads, the two kinds and consumers registered, every control-plane type an audit event, the reasons in the failure taxonomy", () => {
  const audit = STATE_MACHINES.find((m) => m.contract === "Audit");
  const grant = STATE_MACHINES.find((m) => m.contract === "CostGrant");
  assert.ok(audit && grant);
  for (const s of new Set([audit.initial, ...audit.transitions.map((t) => t.to)])) assert.ok((EVENT_TYPES as ReadonlyArray<string>).includes(auditEventTypeOf(s)), s);
  for (const s of new Set([grant.initial, ...grant.transitions.map((t) => t.to)])) assert.ok((EVENT_TYPES as ReadonlyArray<string>).includes(costGrantEventTypeOf(s)), s);
  assert.throws(() => auditEventTypeOf("PAUSED"), TypeError);
  for (const t of AUDIT_AUTHORITY_EVENT_TYPES) {
    const keys = EVENT_PAYLOAD_ALLOWLIST[t];
    assert.ok(keys.length > 0, t);
    for (const k of keys) assert.ok(!/name|label|display|prompt|response|document|value|text/i.test(k), `${t}.${k} could carry customer text`);
  }
  for (const k of AUDIT_AGGREGATE_KINDS) assert.ok((AGGREGATE_KINDS as ReadonlyArray<string>).includes(k), k);
  for (const c of AUDIT_CONSUMERS) {
    assert.ok((CONSUMERS as ReadonlyArray<string>).includes(c), c);
    assert.ok(AUDIT_EVENT_SUBSCRIPTIONS.some((s) => s.consumer === c), `${c} is a registered destination`);
  }
  for (const t of AUDIT_CONTROL_EVENT_TYPES) assert.ok((AUDIT_AUTHORITY_EVENT_TYPES as ReadonlyArray<string>).includes(t), t);
  // the request handlers' own types are not the control plane's
  for (const t of ["audit.queued.v1", "audit.cancelled.v1", "cost_grant.prepared.v1", "cost_grant.authorized.v1"]) assert.ok(!(AUDIT_CONTROL_EVENT_TYPES as ReadonlyArray<string>).includes(t), t);
  for (const r of AUDIT_FAILURE_REASONS) assert.ok((FAILURE_REASONS as ReadonlyArray<string>).includes(r), r);
  // every step outcome names the edge it records (design §8.1)
  assert.deepEqual(AUDIT_STEP_OUTCOMES.INTERPRET, ["COMPILED", "NEEDS_DECISION", "UNSUPPORTED", "FAILED"]);
  assert.deepEqual(AUDIT_STEP_OUTCOMES.VALIDATE, ["VALID", "NEEDS_DECISION", "FAILED"]);
});

test("B06-R1 seam (b08/land): a model task's MODEL_TASK checkpoint is KAURO_MODEL_TASK_CHECKPOINT_V1 over the task, its audit, its grant and its planned request — every member binds, and it is hashed apart from the task's key and its journal events", () => {
  const planned = {
    modelTaskId: "01980000-0000-7000-8000-000000000001",
    agencyId: "01910000-0000-7000-8000-000000000001",
    auditId: "01990000-0000-7000-8000-000000000001",
    grantId: "019a0000-0000-7000-8000-000000000001",
    taskKey: "1".repeat(64),
    candidateManifestHash: "2".repeat(64),
    policyHash: "3".repeat(64),
    minimizedRequestHash: "4".repeat(64),
    providerProfileId: "019b0000-0000-7000-8000-000000000001",
    maximumCostCents: 40n,
  };
  const checkpoint = modelTaskCheckpointOf(planned);
  // the canonical wrapper of the platform domain; the cents as their exact decimal (no float), the restart rule in the payload: a
  // new dispatch owner resumes the planned request (a stored response is compiled before any new dispatch, D8-AUD-3)
  assert.equal(
    checkpoint,
    rawDigest(canonicalBytes({ domain: "KAURO_MODEL_TASK_CHECKPOINT_V1", version: 1, payload: { ...planned, maximumCostCents: "40", resumesFrom: "PLANNED_REQUEST" } })),
  );
  for (const [member, other] of [
    ["modelTaskId", "01980000-0000-7000-8000-000000000002"],
    ["agencyId", "01910000-0000-7000-8000-000000000002"],
    ["auditId", "01990000-0000-7000-8000-000000000002"],
    ["grantId", "019a0000-0000-7000-8000-000000000002"],
    ["taskKey", "5".repeat(64)],
    ["candidateManifestHash", "6".repeat(64)],
    ["policyHash", "7".repeat(64)],
    ["minimizedRequestHash", "8".repeat(64)],
    ["providerProfileId", "019b0000-0000-7000-8000-000000000002"],
    ["maximumCostCents", 41n],
  ] as const) {
    assert.notEqual(modelTaskCheckpointOf({ ...planned, [member]: other }), checkpoint, `${member} binds the checkpoint`);
  }
  assert.notEqual(checkpoint, planned.taskKey);
  assert.notEqual(checkpoint, modelTaskJournalEventHashOf({ ...planned, maximumCostCents: "40", resumesFrom: "PLANNED_REQUEST" }), "another domain");
});
