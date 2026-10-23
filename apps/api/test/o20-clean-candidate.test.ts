// Order 20 — "Clean your data" (CLEAN) with no target contract, end to end, under the candidate activation (CP-01.01, CP-02.01; the O19A
// build contract docs/authority/proposals/reissue-candidate/build/). The api is assembled with `candidate: { cleanWithoutTarget: true }`, which
// a deployment switches on only in LOCAL until Order 19B adopts the candidate. The real routes of StartAudit, GetAudit, the decision-artifact
// intake, CreatePlan, ValidatePlan, ApprovePlan and CreateQuote, PostgreSQL 17 through the runtime login roles; the control plane's audit and
// validation steps are written through the product's adapters in control-plane units of work (audit-support.ts), the buyer type and the
// Intelligence core are their labelled contract fakes (SIMULATED). The acceptance tags are CP-02.01's: CLEAN-NO-TARGET, CLEAN-CHAIN,
// CLEAN-TARGET-REFUSED, CRM-TARGET-REQUIRED, MODE-SPOOF. The in-force behaviour (activation off) is o20-clean-in-force.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import type { ApprovePlanView, CreateQuoteView } from "@kauro/application";
import { ContractFakeBuyerTypeReader } from "@kauro/application/testing";
import { ContractFakeIntelligenceCore } from "@kauro/application/testing/cores";
import { CLEAN_ONLY_TARGET_HASH, type PlanBody, type ProjectId, type ValidationReceiptId } from "@kauro/domain";
import { controlOf, paidPurchase } from "@kauro/persistence/testing";
import { paymentsWorld, readData, type PaymentsWorld } from "./commerce-support.js";
import {
  AUDIT_POLICY_VERSION,
  ScriptedPlanCompiler,
  auditEvents,
  auditIdOf,
  auditRow,
  createPlan,
  footprint,
  fundPool,
  getAudit,
  needsDecision,
  planRow,
  startAudit,
  storedCandidates,
  validatePlan,
  validationsOf,
  type CreatedPlanView,
} from "./audit-support.js";
import { approveThroughRoute, call, clock, completed, freshKey, ids, outcome, planBodyOf, sha, type PlanFixture, type World } from "./support.js";

const core = new ContractFakeIntelligenceCore();
const compiler = new ScriptedPlanCompiler(core);
const buyer = new ContractFakeBuyerTypeReader({ clock });
let pw: PaymentsWorld;
let w: World;

before(async () => {
  pw = await paymentsWorld({ candidate: { cleanWithoutTarget: true }, cores: { planCompiler: compiler }, quotes: () => ({ buyerType: buyer }) });
  w = pw.w;
  buyer.set(w.A.agencyId, "AGENCY");
  await fundPool({ w, poolId: null });
});
after(async () => {
  await pw.stop();
});

/** The candidate build contract's AuditView (the O19A build OpenAPI): targetContractId is optional there and only there. */
const CANDIDATE_OPENAPI = JSON.parse(readFileSync(new URL("../../../../docs/authority/proposals/reissue-candidate/build/api/openapi.json", import.meta.url), "utf8")) as {
  readonly components: { readonly schemas: Readonly<Record<string, { readonly required?: ReadonlyArray<string>; readonly properties?: Readonly<Record<string, unknown>> }>> };
};
const SERVED_OPENAPI = JSON.parse(readFileSync(new URL("../../openapi.json", import.meta.url), "utf8")) as typeof CANDIDATE_OPENAPI;

/** A CLEAN project (the world's default mode) with a sealed, current revision: what a free check is of. */
async function cleanSubject(): Promise<{ readonly projectId: ProjectId; readonly revisionId: string; readonly revisionHash: string }> {
  const { projectId } = await w.project(w.A, w.clientA);
  const source = await w.revision(w.A, projectId, "SEALED", { recent: true });
  return { projectId, revisionId: source.revisionId, revisionHash: source.revisionHash };
}

/** The plan CreatePlan answered, taken to VALIDATED v4 the way the platform does: CMD024 through its route, then the validator's VALID receipt. */
async function validated(created: CreatedPlanView, body: PlanBody): Promise<PlanFixture> {
  const reply = await validatePlan(w, created.planId, { expectedVersion: created.version, planHash: created.bodyHash });
  assert.equal(reply.status, 202, reply.text);
  const [validation] = await validationsOf(w, created.planId);
  assert.ok(validation);
  const receiptHash = sha(`o20-receipt-${created.planId}`);
  const completedMs = Date.now();
  const counts = { physicalSourceRows: 120, logicalSourceRecords: 120, billableSourceUnits: 120, associationEdges: 0, emittedRepresentatives: 120, mergedNonSurvivors: 0, rejected: 0, withheld: 0, unresolved: 0, emittedArtifactRows: 120 };
  await w.h.recordValidationReceipt({
    receiptId: ids.next() as ValidationReceiptId,
    agencyId: w.A.agencyId,
    planId: created.planId as never,
    receiptHash,
    revisionHash: body.revisionHash,
    targetContractHash: body.targetContractHash,
    planHash: created.bodyHash as never,
    corePackageHash: sha("core"),
    profileEvidenceHash: sha("profile"),
    dispositionEvidenceHash: sha("disposition"),
    artifactEvidenceHash: sha("artifact"),
    startedAt: new Date(completedMs - 60_000).toISOString() as never,
    completedAt: new Date(completedMs).toISOString() as never,
    result: "VALID",
    counts,
    blockingIssueCodes: [],
  });
  await w.h.audit.run(controlOf(w.A.agencyId), (uow) => uow.audits.settleValidation(validation.validation_id as never, { result: "VALID", receiptHash }));
  const row = await planRow(w, created.planId);
  assert.equal(row.state, "VALIDATED");
  return { planId: created.planId as never, projectId: created.projectId as never, version: Number(row.version), state: "VALIDATED", body, bodyHash: created.bodyHash as never, revisionHash: body.revisionHash, targetContractHash: body.targetContractHash, receiptHash, affectedRows: 120 };
}

/** Ends the agency's live audit through the store (the agency runs one audit at a time). */
async function settleLiveAudit(auditId: string): Promise<void> {
  await needsDecision(w, { agencyId: w.A.agencyId, auditId });
}

test("CLEAN-NO-TARGET + CLEAN-CHAIN: a CLEAN project's free check, plan, approval and quote with no target contract; every step binds CLEAN_ONLY_TARGET_HASH", async () => {
  const subject = await cleanSubject();
  const targetsBefore = await w.count("target_contracts", "project_id = $1", [subject.projectId]);
  assert.equal(targetsBefore, 0, "the CLEAN project has no target contract at all");
  const stated = await w.h.oracle.query<{ hash: string }>("SELECT kauro.clean_only_target_hash() AS hash");
  assert.equal(stated.rows[0]?.hash, CLEAN_ONLY_TARGET_HASH, "migration 0097 states the domain's canonical CLEAN hash");

  // StartAudit with no targetContractId: 202 QUEUED; the audit names no target and binds the canonical CLEAN hash
  const started = await startAudit(w, subject.revisionId, {});
  const auditId = auditIdOf(started);
  const row = await auditRow(w, auditId);
  assert.equal(row.target_contract_id, null);
  assert.equal(row.target_contract_hash, CLEAN_ONLY_TARGET_HASH);
  assert.equal(row.state, "QUEUED");
  const [queued] = await auditEvents(w, auditId);
  assert.equal(queued?.type, "audit.queued.v1");
  assert.equal("targetContractId" in (queued?.payload ?? {}), false, "audit.queued.v1 of a CLEAN audit omits targetContractId");
  assert.equal(queued?.payload["targetContractHash"], CLEAN_ONLY_TARGET_HASH);

  // GetAudit: the view omits targetContractId, which the candidate AuditView makes optional (the served one still requires it)
  const view = readData<Record<string, unknown>>(await getAudit(w, auditId));
  assert.equal("targetContractId" in view, false);
  const candidateView = CANDIDATE_OPENAPI.components.schemas["AuditView"];
  assert.ok(candidateView?.required !== undefined && !candidateView.required.includes("targetContractId"));
  for (const member of candidateView.required ?? []) assert.ok(member in view, `the candidate AuditView requires ${member}`);
  for (const member of Object.keys(view)) assert.ok(member in (candidateView.properties ?? {}), `${member} is a member of the candidate AuditView`);
  assert.ok(SERVED_OPENAPI.components.schemas["AuditView"]?.required?.includes("targetContractId"), "the served OpenAPI is unchanged");

  // the control plane interprets it to NEEDS_DECISION; CreatePlan compiles the agency's decisions into a plan of the CLEAN hash
  await needsDecision(w, { agencyId: w.A.agencyId, auditId });
  assert.equal((await auditEvents(w, auditId)).every((e) => !("targetContractId" in e.payload)), true, "no audit.*.v1 of a CLEAN audit carries targetContractId");
  const body = planBodyOf(subject.revisionHash as never, CLEAN_ONLY_TARGET_HASH, "o20-chain");
  const stored = await storedCandidates(w, auditId, body);
  const created = completed<CreatedPlanView>(await createPlan(w, auditId, { candidateDecisionArtifactRef: stored.artifactRef }), 201).data;
  assert.equal(created.targetContractHash, CLEAN_ONLY_TARGET_HASH);
  assert.equal(created.state, "VALIDATION_REQUIRED");

  // ValidatePlan and the validator's receipt, then ApprovePlan: the approval binds the CLEAN hash, no TARGET_STALE anywhere
  const plan = await validated(created, body);
  const approval = await approveThroughRoute(w, plan);
  assert.equal(approval.data.approval.targetContractHash, CLEAN_ONLY_TARGET_HASH);
  assert.equal(approval.data.plan.state, "APPROVED");

  // CreateQuote: the quote is issued over the CLEAN plan; it has no target member and prices the sealed source's billable units
  const quote = completed<CreateQuoteView>(
    await call(w, { url: `/api/v1/projects/${subject.projectId}/quotes`, token: w.billing.token, agency: w.A.agencyId, key: freshKey("o20-quote"), body: { planId: plan.planId, billingProfileRef: pw.profileId } }),
    201,
  ).data;
  assert.equal(JSON.stringify(quote).includes("targetContract"), false, "the quote shows no target fingerprint");
  const quoteRow = await w.row<{ state: string; mode: string; target_contract_hash: string; billable_units: string }>("quotes", "plan_id = $1", [plan.planId]);
  assert.equal(quoteRow?.state, "ISSUED");
  assert.equal(quoteRow?.mode, "CLEAN");
  assert.equal(quoteRow?.target_contract_hash, CLEAN_ONLY_TARGET_HASH);
  assert.ok(Number(quoteRow?.billable_units) > 0);
  assert.equal(await w.count("target_contracts", "project_id = $1", [subject.projectId]), 0, "no target contract was ever created");


  // idempotency: the same StartAudit key and body replays the 202 without a second audit
  const replayKey = freshKey("o20-replay");
  const fresh = await cleanSubject();
  const first = await startAudit(w, fresh.revisionId, {}, { key: replayKey });
  const again = await startAudit(w, fresh.revisionId, {}, { key: replayKey });
  assert.equal(auditIdOf(again), auditIdOf(first));
  assert.equal(await w.count("audits", "revision_id = $1", [fresh.revisionId]), 1);
  // MODE-SPOOF: the same key under another body is an idempotency conflict
  assert.equal(outcome(w, await startAudit(w, fresh.revisionId, { auditPolicyVersion: "R2-OTHER" }, { key: replayKey })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  // one CLEAN audit per revision for good (audits_one_clean_per_revision), as one per (revision, target) is for a CRM audit
  await settleLiveAudit(auditIdOf(first));
  assert.equal(outcome(w, await startAudit(w, fresh.revisionId, {})), "409 PRECONDITION_FAILED AUDIT_EXISTS");
});

test("CLEAN-TARGET-REFUSED: a CLEAN project's StartAudit naming a target contract (current or not) is 400 INVALID_REQUEST TARGET_NOT_APPLICABLE; nothing is written", async () => {
  const subject = await cleanSubject();
  // even a confirmed, current contract of this very project is refused: CLEAN takes none
  const target = await w.targetContract(w.A, subject.projectId);
  const before = await footprint(w);
  const reply = await startAudit(w, subject.revisionId, { targetContractId: target.contractId });
  assert.equal(outcome(w, reply), "400 INVALID_REQUEST TARGET_NOT_APPLICABLE");
  assert.deepEqual(reply.json<{ errors?: unknown }>().errors, [{ field: "targetContractId", code: "UNKNOWN_FIELD" }]);
  assert.equal(outcome(w, await startAudit(w, subject.revisionId, { targetContractId: ids.next() })), "400 INVALID_REQUEST TARGET_NOT_APPLICABLE");
  assert.deepEqual(await footprint(w), before, "no audit, no grant reservation, no event, no journal");
  assert.equal(await w.count("audits", "revision_id = $1", [subject.revisionId]), 0);
});

test("CRM-TARGET-REQUIRED + MODE-SPOOF: a HUBSPOT project still needs its target — omitted 400 TARGET_CONTRACT_REQUIRED, superseded 422 TARGET_STALE; no request member chooses CLEAN", async () => {
  const { projectId } = await w.project(w.A, w.clientA, { mode: "HUBSPOT" });
  const source = await w.revision(w.A, projectId, "SEALED", { recent: true });
  const stale = await w.targetContract(w.A, projectId, { superseded: true, mode: "HUBSPOT" });
  const before = await footprint(w);
  const omitted = await startAudit(w, source.revisionId, {});
  assert.equal(outcome(w, omitted), "400 INVALID_REQUEST TARGET_CONTRACT_REQUIRED");
  assert.deepEqual(omitted.json<{ errors?: unknown }>().errors, [{ field: "targetContractId", code: "REQUIRED" }]);
  assert.equal(outcome(w, await startAudit(w, source.revisionId, { targetContractId: stale.contractId })), "422 TARGET_STALE -");
  // unknown members never choose the branch: the closed schema refuses them before the handler
  for (const spoof of [{ mode: "CLEAN" }, { targetContractHash: CLEAN_ONLY_TARGET_HASH }]) {
    const r = await call(w, { url: `/api/v1/revisions/${source.revisionId}/audits`, token: w.operator.token, key: freshKey("o20-spoof"), body: { auditPolicyVersion: AUDIT_POLICY_VERSION, ...spoof } });
    assert.equal(outcome(w, r), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  }
  assert.deepEqual(await footprint(w), before, "nothing written for any refusal");

  // a CRM plan never binds the CLEAN hash: the database refuses it outright (no CLEAN audit exists on a HUBSPOT project)
  await assert.rejects(
    w.plan(w.A, projectId, { revisionHash: source.revisionHash, targetContractHash: CLEAN_ONLY_TARGET_HASH, seed: "o20-crm-clean" }),
    /CLEAN hash outside a CLEAN project|plans_clean_binding|23514/,
  );
});

test("the database holds the CLEAN shape only: a target-less audit is refused on a CRM project and with any hash but the canonical one (KA081)", async () => {
  const { projectId } = await w.project(w.A, w.clientA, { mode: "HUBSPOT" });
  const source = await w.revision(w.A, projectId, "SEALED", { recent: true });
  // the database refuses a target-less audit outside a CLEAN project even if a handler tried (KA081 AUDIT_AUTHORITY)
  await assert.rejects(
    w.h.oracle.query(
      `INSERT INTO kauro.audits (audit_id, agency_id, project_id, revision_id, revision_hash, target_contract_id, target_contract_hash, audit_policy_version, requested_by_membership_id, grant_id)
       VALUES ($1, $2, $3, $4, $5, NULL, $6, 'R2-INITIAL', $7, $8)`,
      [ids.next(), w.A.agencyId, projectId, source.revisionId, source.revisionHash, CLEAN_ONLY_TARGET_HASH, w.memberships.operator, ids.next()],
    ),
    /names no target contract/,
  );
  // a target-less audit must bind exactly the canonical hash (audits_clean_binding)
  const clean = await cleanSubject();
  await assert.rejects(
    w.h.oracle.query(
      `INSERT INTO kauro.audits (audit_id, agency_id, project_id, revision_id, revision_hash, target_contract_id, target_contract_hash, audit_policy_version, requested_by_membership_id, grant_id)
       VALUES ($1, $2, $3, $4, $5, NULL, $6, 'R2-INITIAL', $7, $8)`,
      [ids.next(), w.A.agencyId, clean.projectId, clean.revisionId, clean.revisionHash, sha("not-the-clean-hash"), w.memberships.operator, ids.next()],
    ),
    /names no target contract/,
  );
});

test("the approval of a CLEAN plan answers the same view shape as a CRM approval (ApprovePlanView unchanged)", async () => {
  const plan = await w.approvable(w.A, (await w.project(w.A, w.clientA)).projectId, "o20-legacy-clean", "SET", { recent: true });
  // a CLEAN project's plan bound to a confirmed target (in-force data) keeps its target path under the activation
  const approved = await approveThroughRoute(w, plan);
  const keys = Object.keys(approved.data.approval).sort();
  assert.ok(keys.includes("targetContractHash"));
  assert.equal((approved.data as ApprovePlanView).plan.state, "APPROVED");
});

/** A CLEAN plan approved through the real routes: StartAudit with no target, NEEDS_DECISION, CreatePlan, ValidatePlan + receipt, ApprovePlan. */
async function approvedCleanPlan(seed: string): Promise<{ readonly projectId: ProjectId; readonly plan: PlanFixture }> {
  const subject = await cleanSubject();
  const auditId = auditIdOf(await startAudit(w, subject.revisionId, {}));
  await needsDecision(w, { agencyId: w.A.agencyId, auditId });
  const body = planBodyOf(subject.revisionHash as never, CLEAN_ONLY_TARGET_HASH, seed);
  const stored = await storedCandidates(w, auditId, body);
  const created = completed<CreatedPlanView>(await createPlan(w, auditId, { candidateDecisionArtifactRef: stored.artifactRef }), 201).data;
  const plan = await validated(created, body);
  await approveThroughRoute(w, plan);
  return { projectId: subject.projectId, plan };
}

test("second increment (migration 0098): a CLEAN purchase is paid and its entitlement issued on the canonical CLEAN binding, with no target row", async () => {
  const { projectId, plan } = await approvedCleanPlan("o20-purchase");
  const sale = await paidPurchase(w.h, { agency: w.A, planId: plan.planId, route: pw.route, issuerRef: pw.issuerRef, profileId: pw.profileId, treatment: "EXEMPT_EXPORT" });
  const entitlement = await w.row<{ state: string; mode: string; target_contract_hash: string }>("commercial_authorizations", "authorization_id = $1", [sale.authorizationId]);
  assert.equal(entitlement?.mode, "CLEAN");
  assert.equal(entitlement?.target_contract_hash, CLEAN_ONLY_TARGET_HASH);
  assert.equal(await w.count("target_contracts", "project_id = $1", [projectId]), 0, "no target contract was ever created");
});
