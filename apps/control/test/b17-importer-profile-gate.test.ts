// B17 L2 PROFILE (plan docs/design/B15-B17-B18-local-plan.md, cell M3 "PLAN_VALIDATION importer-profile gate" and meeting row 13 "system draft x B").
// R2-018..022 (R2 05:27, 05 secondary email, 05:43, 05:75, 05:91, 05:93): PLAN_VALIDATION refuses, before the core is called, a plan whose
// importer profile cannot carry it, and stores the reason in plan_validations.refusal_reason (ADV-10). The catalogue is keyed by
// (importerProfileId uuid, importerVersion) (ADV-19); the run's target body digest must equal the intent's targetContractHash. Every DENY
// runs through PlanValidation.validatePlan (the delivery of plan.validating.v1) on a real PostgreSQL 17 and reads the stored reason,
// beside an OK sibling per profile and a vacuous CLEAN one (template r12, r20). Meeting row 13: the system draft of an audit meets
// CMD019's supersession at the target's transition lock (both orders): TARGET_STALE, no plan. SIMULATED: the Migration core is the
// labelled contract fake; the superuser is the oracle only (the supersession is CMD019's shape through it).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PlanBody } from "@kauro/domain";
import { openAuditWorld, type AuditWorld } from "./support/audit-world.js";
import { IMPORTER_PROFILE_IDS, IMPORTER_VERSION, sha, startExecutionWorld, type AuditSubject, type ExecutionWorld, type TargetShape } from "./support/execution-world.js";

let w: ExecutionWorld;
let a: AuditWorld;

before(async () => {
  w = await startExecutionWorld("b17-importer-profile");
  a = await openAuditWorld(w);
});

after(async () => {
  await w.stop();
});

// --- the fixtures: a target inventory and plan bodies of one predicate each ----------------------------------------------------------

const field = (apiName: string, dataType: string, extra: Record<string, unknown> = {}) => ({
  apiName,
  dataType,
  createable: true,
  updateable: true,
  requiredOnCreate: false,
  allowedValues: [],
  clearMechanism: "EXPLICIT_API_OPERATION",
  unique: false,
  nillable: true,
  ...extra,
});

const HUBSPOT_OBJECTS = [
  {
    apiName: "contacts",
    operations: ["CREATE", "UPDATE"],
    fields: [field("email", "TEXT"), field("hs_object_id", "TEXT"), field("hs_additional_emails", "TEXT"), field("interests", "MULTI_ENUM"), field("company_id", "REFERENCE", { referenceObject: "companies" }), field("notes", "TEXT")],
    identifierFields: ["email"],
    relationships: [],
  },
] as unknown as NonNullable<TargetShape["objects"]>;

const SALESFORCE_OBJECTS = [
  { apiName: "Contact", operations: ["CREATE", "UPDATE"], fields: [field("Id", "TEXT"), field("Name", "TEXT"), field("Age", "INTEGER")], identifierFields: ["Id"], relationships: [] },
] as unknown as NonNullable<TargetShape["objects"]>;

const hubspot = (): TargetShape => ({ objects: HUBSPOT_OBJECTS });

type Write = readonly [object: string, field: string, kind?: string];

/** A plan body of the subject writing exactly `writes`, with `relationships` (resolution per relation type). */
function bodyOf(writes: ReadonlyArray<Write>, relationships: ReadonlyArray<readonly [relationType: string, resolution: string]> = []): (base: PlanBody) => PlanBody {
  return (base) => {
    const id = (kind: string, i: number): string => `0192b000-0000-7000-8000-${String(i).padStart(4, "0")}${sha(`${kind}${i}${writes.length}`).slice(0, 8)}`;
    const template = base.mappings[0];
    assert.ok(template);
    return {
      ...base,
      mappings: writes.map(([targetObject, targetField, kind], i) => ({
        ...template,
        mappingId: id("m", i),
        targetObject,
        targetField,
        intent: { kind: kind ?? "SET", reasonCode: "MAPPED" },
      })),
      relationships: relationships.map(([relationType, resolution], i) => ({
        relationshipId: id("r", i),
        relationType,
        sourceObject: "contacts",
        targetObject: "companies",
        edgeSetHash: sha(`edges${i}`),
        resolution,
        identityEvidenceHash: sha(`identity${i}`),
        approvalHash: sha(`approval${i}`),
      })),
    } as unknown as PlanBody;
  };
}

interface Settled {
  readonly state: string;
  readonly version: string;
  readonly validations: ReadonlyArray<readonly [number, string, string | null, string | null]>;
  readonly reason: string | null;
  readonly receipts: number;
}

/** Plan validation of one plan of `s` through PlanValidation.validatePlan (the delivery of its plan.validating.v1), then what was stored. */
async function validated(s: AuditSubject, seed: string, shape: (base: PlanBody) => PlanBody): Promise<{ readonly planId: string; readonly settled: Settled; readonly coreCalls: number }> {
  const p = await a.plan(s, seed, shape);
  await a.requestValidation(s, p.planId, 2);
  const before = w.core.calls("validate").length;
  assert.deepEqual(await w.redeliver(w.x.consumers.planValidation, await w.eventOf(p.planId, "plan.validating.v1")), { kind: "DONE" }, seed);
  return { planId: p.planId, settled: await settledOf(p.planId), coreCalls: w.core.calls("validate").length - before };
}

async function settledOf(planId: string): Promise<Settled> {
  const plan = await a.plan_(planId);
  const reason = await w.h.oracle.query<{ refusal_reason: string | null }>("SELECT refusal_reason FROM kauro.plan_validations WHERE plan_id = $1 ORDER BY fence DESC LIMIT 1", [planId]);
  return { state: plan.state, version: plan.version, validations: await a.validations(planId), reason: reason.rows[0]?.refusal_reason ?? null, receipts: (await a.receipts(planId)).length };
}

/** The refusal the gate must give: the intent settled ERROR with the reason, the plan back to VALIDATION_REQUIRED, no receipt, the core never called. */
function assertRefused(label: string, got: Awaited<ReturnType<typeof validated>>, reason: string): void {
  assert.deepEqual([got.settled.state, got.settled.version], ["VALIDATION_REQUIRED", "4"], `${label}: the plan needs validation again`);
  assert.deepEqual(got.settled.validations, [[1, "COMMAND", "ERROR", null]], `${label}: the intent settled ERROR`);
  assert.equal(got.settled.reason, reason, `${label}: the stored refusal reason`);
  assert.equal(got.settled.receipts, 0, `${label}: no receipt`);
  assert.equal(got.coreCalls, 0, `${label}: the gate answers before the core is called`);
}

function assertValidated(label: string, got: Awaited<ReturnType<typeof validated>>): void {
  assert.equal(got.settled.state, "VALIDATED", `${label}: the plan is VALIDATED`);
  assert.deepEqual(got.settled.validations.map(([fence, origin, result]) => [fence, origin, result]), [[1, "COMMAND", "VALID"]], label);
  assert.equal(got.settled.reason, null, `${label}: a VALID intent carries no refusal reason`);
  assert.equal(got.coreCalls, 1, `${label}: the core validated it`);
}

// --- M3: the OK siblings, one per profile, and the vacuous CLEAN one -----------------------------------------------------------------

test("R2-018..022: OK a plan the importer profile can carry is VALIDATED, on each offered profile, and a CLEAN target has no importer gate", async () => {
  const hs = await w.subject(w.A, "ok-hubspot", { target: hubspot() });
  assertValidated("HUBSPOT_IMPORT_UI", await validated(hs, "ok-hubspot", bodyOf([["contacts", "email"], ["contacts", "notes", "KEEP"]])));

  const sf = await w.subject(w.A, "ok-sf", { mode: "SALESFORCE", target: { objects: SALESFORCE_OBJECTS } });
  assertValidated("SALESFORCE_DATA_LOADER", await validated(sf, "ok-sf", bodyOf([["Contact", "Name"], ["Contact", "Age"]])));

  // SF_BULK_API2's literal null marker collides only with TEXT and CLEAR: an INTEGER write passes
  const bulk = await w.subject(w.A, "ok-bulk", { mode: "SALESFORCE", target: { importerProfileId: IMPORTER_PROFILE_IDS.SF_BULK_API2, objects: SALESFORCE_OBJECTS } });
  assertValidated("SF_BULK_API2", await validated(bulk, "ok-bulk", bodyOf([["Contact", "Age"]])));

  // CLEAN: the gate is vacuous (an importer profile this catalogue has never heard of, and the plan that would be refused elsewhere)
  const clean = await w.subject(w.A, "ok-clean", { target: { mode: "CLEAN", importerProfileId: "0192a000-0000-7000-8000-000000000099", objects: HUBSPOT_OBJECTS } });
  assertValidated("CLEAN", await validated(clean, "ok-clean", bodyOf([["contacts", "hs_object_id"], ["contacts", "hs_additional_emails"]])));
});

// --- M3: the DENYs, one predicate each, through PlanValidation.validatePlan ------------------------------------------------------------

test("ADV-19: DENY an unknown importer profile id or version (IMPORTER_PROFILE_UNKNOWN), and a profile of another mode", async () => {
  const unknownId = await w.subject(w.A, "unknown-id", { target: { importerProfileId: "0192a000-0000-7000-8000-0000000000ff", objects: HUBSPOT_OBJECTS } });
  assertRefused("unknown id", await validated(unknownId, "unknown-id", bodyOf([["contacts", "email"]])), "IMPORTER_PROFILE_UNKNOWN");
  const unknownVersion = await w.subject(w.A, "unknown-version", { target: { importerVersion: "R9-FUTURE", objects: HUBSPOT_OBJECTS } });
  assertRefused("unknown version", await validated(unknownVersion, "unknown-version", bodyOf([["contacts", "email"]])), "IMPORTER_PROFILE_UNKNOWN");
  const otherMode = await w.subject(w.A, "other-mode", { target: { importerProfileId: IMPORTER_PROFILE_IDS.SALESFORCE_DATA_LOADER, objects: HUBSPOT_OBJECTS } });
  assertRefused("a Salesforce profile on a HubSpot target", await validated(otherMode, "other-mode", bodyOf([["contacts", "email"]])), "IMPORTER_PROFILE_UNKNOWN");
});

test("ADV-19: DENY a target body whose digest is not the intent targetContractHash (TARGET_DIGEST_MISMATCH)", async () => {
  const s = await w.subject(w.A, "digest", { target: hubspot() });
  // the stored target body drifts from the hash its plan binds (the oracle alone can rewrite it; the trigger set is switched off for it)
  await w.h.oracle.query(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE kauro.target_contracts SET importer_version = 'R2-DRIFTED' WHERE contract_id = '${s.contractId}'; COMMIT;`);
  assertRefused("drifted body", await validated(s, "digest", bodyOf([["contacts", "email"]])), "TARGET_DIGEST_MISMATCH");
});

test("R2-018: DENY a native Record ID identity without an instance-bound native-ID validation receipt (IMPORTER_PROFILE_NATIVE_ID_UNVALIDATED)", async () => {
  const s = await w.subject(w.A, "r018", { target: hubspot() });
  assertRefused("a write to the record id field", await validated(s, "r018-field", bodyOf([["contacts", "hs_object_id"]])), "IMPORTER_PROFILE_NATIVE_ID_UNVALIDATED");
  assertRefused("a TARGET_NATIVE_ID relationship", await validated(s, "r018-edge", bodyOf([["contacts", "email"]], [["contacts_to_companies", "TARGET_NATIVE_ID"]])), "IMPORTER_PROFILE_NATIVE_ID_UNVALIDATED");
});

test("R2-019: DENY Record ID plus a secondary email on one object (IMPORTER_PROFILE_SECONDARY_EMAIL_WITH_RECORD_ID)", async () => {
  const s = await w.subject(w.A, "r019", { target: hubspot() });
  assertRefused("record id with hs_additional_emails", await validated(s, "r019", bodyOf([["contacts", "hs_object_id"], ["contacts", "hs_additional_emails"]])), "IMPORTER_PROFILE_SECONDARY_EMAIL_WITH_RECORD_ID");
  // the secondary email alone is not the combination
  assertValidated("a secondary email without record id", await validated(s, "r019-alone", bodyOf([["contacts", "hs_additional_emails"]])));
});

test("R2-020: DENY a replacing intent on a MULTI_ENUM or association field under an add-only importer profile (IMPORTER_PROFILE_REPLACEMENT_UNQUALIFIED)", async () => {
  const s = await w.subject(w.A, "r020", { target: hubspot() });
  assertRefused("SET on a MULTI_ENUM", await validated(s, "r020-set", bodyOf([["contacts", "interests", "SET"]])), "IMPORTER_PROFILE_REPLACEMENT_UNQUALIFIED");
  assertRefused("CLEAR on an association", await validated(s, "r020-clear", bodyOf([["contacts", "company_id", "CLEAR"]])), "IMPORTER_PROFILE_REPLACEMENT_UNQUALIFIED");
  // KEEP replaces nothing
  assertValidated("KEEP on a MULTI_ENUM", await validated(s, "r020-keep", bodyOf([["contacts", "interests", "KEEP"]])));
});

test("R2-021: DENY a grandparent dotted reference at plan validation (IMPORTER_PROFILE_RELATIONSHIP_DEPTH)", async () => {
  const s = await w.subject(w.A, "r021", { target: hubspot() });
  assertRefused("a two-hop target field", await validated(s, "r021-field", bodyOf([["contacts", "company.owner.email"]])), "IMPORTER_PROFILE_RELATIONSHIP_DEPTH");
  assertRefused("a two-hop relationship", await validated(s, "r021-edge", bodyOf([["contacts", "email"]], [["contacts:company:owner", "SOURCE_KEY"]])), "IMPORTER_PROFILE_RELATIONSHIP_DEPTH");
  // one hop is the limit, not beyond it
  assertValidated("a one-hop target field", await validated(s, "r021-one", bodyOf([["contacts", "company.name"]])));
});

test("R2-022: DENY a TEXT write or CLEAR under a profile whose null marker is a literal token (IMPORTER_PROFILE_NULL_MARKER_COLLISION)", async () => {
  const s = await w.subject(w.A, "r022", { mode: "SALESFORCE", target: { importerProfileId: IMPORTER_PROFILE_IDS.SF_BULK_API2, objects: SALESFORCE_OBJECTS } });
  assertRefused("a TEXT SET", await validated(s, "r022-text", bodyOf([["Contact", "Name", "SET"]])), "IMPORTER_PROFILE_NULL_MARKER_COLLISION");
  assertRefused("a CLEAR", await validated(s, "r022-clear", bodyOf([["Contact", "Age", "CLEAR"]])), "IMPORTER_PROFILE_NULL_MARKER_COLLISION");
});

test("R2-018..022: RETRY the same intent re-delivered settles once with the same reason", async () => {
  const s = await w.subject(w.A, "retry", { target: hubspot() });
  const got = await validated(s, "retry", bodyOf([["contacts", "hs_object_id"], ["contacts", "hs_additional_emails"]]));
  assertRefused("first delivery", got, "IMPORTER_PROFILE_SECONDARY_EMAIL_WITH_RECORD_ID");
  const calls = w.core.calls("validate").length;
  assert.deepEqual(await w.redeliver(w.x.consumers.planValidation, await w.eventOf(got.planId, "plan.validating.v1")), { kind: "DONE" });
  assert.deepEqual(await settledOf(got.planId), got.settled, "the redelivery changes nothing");
  assert.equal(w.core.calls("validate").length, calls);
});

test("ADV-10: the audit's VALIDATE step stores the gate's reason too: a system draft on an unknown importer profile fails the audit IMPORTER_PROFILE_UNKNOWN", async () => {
  const s = await w.subject(w.A, "audit-unknown", { target: { importerProfileId: "0192a000-0000-7000-8000-0000000000fe", importerVersion: IMPORTER_VERSION, objects: HUBSPOT_OBJECTS } });
  w.intelligence.scriptInterpretOutcomes("COMPILED");
  const { audit } = await a.start(s);
  assert.equal((await w.drain(w.x.consumers.auditOrchestration)).deadLettered, 0);
  const failed = await a.audit(audit.auditId);
  assert.deepEqual([failed.state, failed.terminal_reason], ["FAILED", "IMPORTER_PROFILE_UNKNOWN"]);
  const [draft] = await a.plansOf(s);
  assert.ok(draft);
  assert.deepEqual(await a.validations(draft.plan_id), [[1, "AUDIT", "ERROR", null]]);
  assert.equal((await settledOf(draft.plan_id)).reason, "IMPORTER_PROFILE_UNKNOWN");
});

// --- meeting row 13: the system draft x CMD019 --------------------------------------------------------------------------------------

/** CMD019's shape for the subject's contract, on its own connection (the oracle role). */
const superseder = (s: AuditSubject) => ({ agency: s.agency, contractId: s.contractId });

async function noPlans(s: AuditSubject): Promise<number> {
  return (await a.plansOf(s)).length;
}

test("R2-026: RACE the system draft against CMD019, both orders: the draft born before the supersession stays, one after it is refused TARGET_STALE with no plan", async () => {
  // order 1, the supersession committed first: the audit's INTERPRET step compiles, the draft is refused
  const first = await w.subject(w.A, "m13-super-first");
  w.intelligence.scriptInterpretOutcomes("COMPILED");
  const started = await a.start(first);
  await w.supersedeTarget(superseder(first));
  assert.equal((await w.drain(w.x.consumers.auditOrchestration)).deadLettered, 0);
  const refused = await a.audit(started.audit.auditId);
  assert.deepEqual([refused.state, refused.terminal_reason, refused.draft_plan_id], ["FAILED", "TARGET_STALE", null], "the audit fails TARGET_STALE");
  assert.equal(await noPlans(first), 0, "no plan was born on the superseded contract");
  assert.deepEqual((await a.steps(started.audit.auditId)).map(([kind, , outcome]) => [kind, outcome]), [["PROFILE", "COMPLETED"], ["INTERPRET", "FAILED"]], "the INTERPRET step records the refusal, not COMPILED");

  // order 2, the draft first: the supersession finds the plan born, and the plan stays on its contract (ApprovePlan fences it later, M8)
  const second = await w.subject(w.A, "m13-draft-first");
  w.intelligence.scriptInterpretOutcomes("COMPILED");
  const early = await a.start(second);
  assert.equal((await w.drain(w.x.consumers.auditOrchestration)).deadLettered, 0);
  assert.equal((await a.audit(early.audit.auditId)).state, "DRAFT_READY");
  await w.supersedeTarget(superseder(second));
  assert.equal(await noPlans(second), 1, "the draft born before the supersession stays");

  // the held half: the supersession holds the target's transition lock uncommitted while the draft's record unit waits for it
  const held = await w.subject(w.A, "m13-held");
  w.intelligence.scriptInterpretOutcomes("COMPILED");
  const waiting = await a.start(held);
  const b = await w.h.pg.connect("postgres");
  try {
    await w.supersedeTarget(superseder(held), b);
    const drained = w.drain(w.x.consumers.auditOrchestration);
    await w.lockWait("await_transition");
    assert.equal(await noPlans(held), 0, "the draft waits at the target's transition lock; nothing is born");
    await b.query("COMMIT");
    assert.equal((await drained).deadLettered, 0);
  } finally {
    await b.query("ROLLBACK").catch(() => undefined);
    await b.end();
  }
  const stale = await a.audit(waiting.audit.auditId);
  assert.deepEqual([stale.state, stale.terminal_reason], ["FAILED", "TARGET_STALE"], "the draft that waited is refused");
  assert.equal(await noPlans(held), 0);
});
