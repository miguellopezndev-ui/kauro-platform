// Package B08 end to end (mandate B08-INTEGRATION; docs/design/B08-audit-approval-jobs.md §2..§7, §11, §12; case CMD036-OK): the
// authority chain of §2 walked once through both halves of the product over one real PostgreSQL 17 cluster and one set of labelled
// contract fakes. Every request is the application's own handler as apps/api's composition root binds it — StartAudit (CMD020) and
// GetAudit, B06's ApprovePlan (CMD025) over the edition's plan services and the real disclosure composer, ExecuteProject (CMD036) and
// GetJob — admitted as the transport admits it and each answer checked against its route's contract (support/b08-product.ts); every
// continuation is this package's control plane: B07's dispatcher delivering the audit's and the job's events to AUDIT_ORCHESTRATION and
// JOB_EXECUTION, the sweepers ATTEMPT_MONITOR, STAGING_JANITOR and GRANT_RECONCILIATION, then one whole runCycle. The entitlement is
// B09's own (paidPurchase over the plan CMD025 approved; D8-PAY-1). The receipts are written by the validator's own verified pool.
//
// CONTRACT FAKES, evidence class SIMULATED (D8-FAKE-1; never EXECUTED_PROVIDER), each from its single owner and none created here: the
// Migration core and the Intelligence core of B08-CORE-PORTS (profile, candidates, interpretation, plan compiler, validation, execution
// envelope, verifier), the worker host of B08-WORKER-HOST (running the core inside @kauro/data-plane's REAL attempt envelope), and
// B07's object storage. What each half writes is what the other half reads: the audit's event, the system draft and its receipt, the
// approval, the authorization, the job's events, the staged manifest, the read-backs and the delivery copies. The superuser connection
// is the oracle only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import type { ApprovePlanView, AuditView, DecisionArtifactIntakeView, JobView, PlanView, ProjectView, ReserveUploadView, SealRevisionView, SelectInputTablesView, SelectionManifestIntakeView } from "@kauro/application";
import { CONTRACT_FAKE_MIGRATION_CORE_PACKAGE_HASH } from "@kauro/application/testing/cores";
import { DOMAINS, structuredDigest, type Sha256Hex } from "@kauro/contracts";
import { inventoryHashOf, selectionHashOf, type PlanBody, type ProjectId, type RevisionId, type UserId } from "@kauro/domain";
import { fixtureSelection, type AgencyFixture } from "@kauro/persistence/testing";
import { openAuditWorld, type AuditWorld } from "./support/audit-world.js";
import { acceptedOf, b08Product, completedOf, type Actor, type B08Product } from "./support/b08-product.js";
import { ids, startExecutionWorld, type ExecutionWorld } from "./support/execution-world.js";
import { buildCsv } from "./support/workbook.js";

let w: ExecutionWorld;
let a: AuditWorld;
let app: B08Product;

before(async () => {
  w = await startExecutionWorld("b08-e2e");
  a = await openAuditWorld(w);
  app = b08Product(w);
  // the location read-back comes first: a deletion is never recorded at a location never read back (B07 D-OBJ-2)
  await w.plane.sweepers.locationPolicy.sweep(w.plane.units, 10);
});

after(async () => {
  await w.stop();
});

/** The disclosure set an approver is shown, recomputed from the records alone (the composer's rule, D8-CMA-6), independently of it. */
function disclosuresHashOf(planHash: string, receiptHash: string, body: PlanBody, physicalSourceRows: number): string {
  const items = body.mappings.map((m) => `${m.intent.kind}:${m.targetObject}.${m.targetField}:${physicalSourceRows}`);
  // canonical JSON of a flat object of strings: its members in code-point order
  return createHash("sha256").update(JSON.stringify({ items, planHash, receiptHash })).digest("hex");
}

async function eventTypes(aggregateId: string): Promise<ReadonlyArray<string>> {
  return (await w.events(aggregateId)).map((e) => e.event_type);
}

/** The plan body the agency's candidate decisions amount to: one SET mapping over the subject's source and target. */
function decidedBody(s: Subject, seed: string): PlanBody {
  const hexOf = (part: string): string => createHash("sha256").update(`${seed}-${part}`).digest("hex");
  const v7 = (part: string): string => {
    const hex = hexOf(part);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(12, 15)}-8${hex.slice(15, 18)}-${hex.slice(18, 30)}`;
  };
  return {
    revisionHash: s.revisionHash as Sha256Hex,
    targetContractHash: s.targetContractHash as Sha256Hex,
    policyHash: hexOf("policy") as Sha256Hex,
    mappings: [
      {
        mappingId: v7("mapping"),
        sourceTableId: v7("table"),
        sourceFieldId: v7("field"),
        targetObject: "Contact",
        targetField: "Email",
        intent: { kind: "SET", reasonCode: "MAPPED" },
        evidence: { evidenceId: v7("evidence"), candidateId: v7("candidate"), provenance: "AGENCY", factHashes: [], ruleVersion: "R1", comparisonHash: hexOf("comparison"), fragmentHash: hexOf("fragment") },
      },
    ],
    identities: [],
    transforms: [],
    relationships: [],
  } as unknown as PlanBody;
}

async function revisionVersion(revisionId: string): Promise<number> {
  return Number((await w.h.oracle.query<{ version: string }>("SELECT version::text AS version FROM kauro.dataset_revisions WHERE revision_id = $1", [revisionId])).rows[0]?.version);
}

/** The consumers this control plane runs (the NOTIFICATIONS records are a later package's). */
const CONTROL_CONSUMERS = ["UPLOAD_INSPECTION", "SELECTION_EVALUATION", "STORAGE_LIFECYCLE", "AUTHORITY_JOURNAL", "JOB_EXECUTION", "EXECUTION_CONTROL", "AUDIT_ORCHESTRATION", "PLAN_VALIDATION"];

/** The agency's outbox records of this control plane's consumers that are not DELIVERED, as consumer and event type. */
async function openRecords(agencyId: string): Promise<ReadonlyArray<readonly [string, string, string]>> {
  const r = await w.h.oracle.query<{ consumer: string; event_type: string; state: string }>(
    `SELECT o.consumer, e.event_type, o.state FROM kauro.outbox_records o JOIN kauro.domain_events e ON e.event_id = o.event_id
      WHERE e.agency_id = $1 AND o.consumer = ANY($2::text[]) AND o.state <> 'DELIVERED' ORDER BY e.sequence`,
    [agencyId, CONTROL_CONSUMERS],
  );
  return r.rows.map((x) => [x.consumer, x.event_type, x.state] as const);
}

/** The source lifecycle's consumers, every due record dispatched: none retried, none dead-lettered. */
async function drainSources(): Promise<Record<string, number>> {
  const delivered: Record<string, number> = {};
  const { uploadInspection, selectionEvaluation, storageLifecycle, authorityJournal } = w.plane.consumers;
  for (const consumer of [uploadInspection, selectionEvaluation, storageLifecycle, authorityJournal]) {
    const counts = await w.drain(consumer);
    assert.deepEqual([counts.retried, counts.deadLettered], [0, 0], `${consumer.consumer}: nothing retried or dead-lettered`);
    delivered[consumer.consumer] = counts.delivered;
  }
  return delivered;
}

/** A fresh ACTIVE agency of the world with an OPERATOR and an APPROVER beside its owner, and room for uploads. */
async function team(label: string): Promise<{ readonly ag: AgencyFixture; readonly operator: Actor; readonly approver: Actor }> {
  const ag = await w.agency(label);
  const operatorId = await w.h.person(`b08-${label}-operator`);
  await w.h.addMember(ag, operatorId, "OPERATOR");
  const approverId = await w.h.person(`b08-${label}-approver`);
  await w.h.addMember(ag, approverId, "APPROVER");
  await w.allowUploads(ag, 4);
  return { ag, operator: { agencyId: ag.agencyId, userId: operatorId }, approver: { agencyId: ag.agencyId, userId: approverId } };
}

/** What an audit is of, made through the product. */
interface Subject {
  readonly projectId: string;
  readonly revisionId: string;
  readonly revisionHash: string;
  readonly contractId: string;
  readonly targetContractHash: string;
}

/**
 * A sealed revision of a fresh project: CMD011, then B07's lifecycle through its handlers and this control plane — ReserveUpload, the
 * browser's upload through its session, CompleteUpload, UPLOAD_INSPECTION, the manifest intake, SelectInputTables,
 * SELECTION_EVALUATION and SealRevision — the bytes in the one storage the job's attempt and the inventory read; then a confirmed,
 * current target contract of the project (no catalogue command observes one in this edition: the request handlers' write).
 */
async function sealedSubject(ag: AgencyFixture, operator: Actor, label: string): Promise<Subject> {
  const project = completedOf<ProjectView>(await app.command(operator, "CMD011", { clientId: w.clientOf(ag) }, { mode: "HUBSPOT", purpose: `B08 end to end ${label}`, targetInstanceRef: ids.next() }), 201);
  const projectId = project.projectId;
  const revisionId = project.currentRevision.revisionId;
  const content = buildCsv(["Email", "Name"], [[`ana-${label}@example.test`, "Ana"], [`bo-${label}@example.test`, "Bo"], [`cy-${label}@example.test`, "Cy"]]);
  const reserved = completedOf<ReserveUploadView>(
    await app.command(operator, "CMD013", { revisionId }, { expectedVersion: await revisionVersion(revisionId), declaredBytes: content.length, declaredFormat: "CSV", displayName: "contacts export.csv" }),
    201,
  );
  const sessionUrl = (reserved.session as { readonly uploadUrl?: string }).uploadUrl;
  assert.ok(typeof sessionUrl === "string", "the session reaches its requester");
  const written = w.storage.uploadThroughSession(sessionUrl, content);
  assert.equal(written.outcome, "FINALIZED", JSON.stringify(written));
  if (written.outcome !== "FINALIZED") throw new Error("unreachable");
  acceptedOf(await app.command(operator, "CMD014", { uploadId: reserved.upload.uploadId }, { providerCompletionRef: written.completionRef }));
  assert.deepEqual(await drainSources(), { UPLOAD_INSPECTION: 1, SELECTION_EVALUATION: 0, STORAGE_LIFECYCLE: 0, AUTHORITY_JOURNAL: 0 });
  const file = await w.h.oracle.query<{ file_id: string; table_id: string; structure_hash: string }>(
    "SELECT f.file_id, t.table_id, t.structure_hash FROM kauro.source_files f JOIN kauro.source_tables t ON t.file_id = f.file_id WHERE f.origin_upload_id = $1 AND f.state = 'ADMITTED'",
    [reserved.upload.uploadId],
  );
  const admitted = file.rows[0];
  assert.ok(admitted !== undefined, "UPLOAD_INSPECTION admitted the upload");
  const inventoryHash = inventoryHashOf(await w.h.app.runSource(w.h.tenant(ag.agencyId, ag.ownerUserId), (uow) => uow.sources.revisions.inventory(revisionId as RevisionId)));
  const selection = fixtureSelection(revisionId, { fileId: admitted.file_id, tableId: admitted.table_id, structureHash: admitted.structure_hash, origin: "THIS_REVISION" }, inventoryHash);
  const manifest = await app.submitManifest<SelectionManifestIntakeView>(operator, revisionId, selection);
  completedOf<SelectInputTablesView>(await app.command(operator, "CMD016", { revisionId }, { expectedVersion: await revisionVersion(revisionId), selectionManifestRef: manifest.view.selectionManifestId }), 200);
  assert.deepEqual(await drainSources(), { UPLOAD_INSPECTION: 0, SELECTION_EVALUATION: 1, STORAGE_LIFECYCLE: 0, AUTHORITY_JOURNAL: 0 });
  const sealed = completedOf<SealRevisionView>(await app.command(operator, "CMD017", { revisionId }, { expectedVersion: await revisionVersion(revisionId), selectionHash: selectionHashOf(selection) }), 200);
  assert.equal(sealed.revision.state, "SEALED");
  const target = await w.confirmTarget(ag, projectId as ProjectId, label);
  return { projectId, revisionId, revisionHash: sealed.manifestHash, contractId: target.contractId, targetContractHash: target.targetContractHash };
}

test("b08 end to end: a sealed revision is audited to DRAFT_READY, approved, paid, executed, admitted, run, verified and published — the package is AVAILABLE, the job READY and the authorization DELIVERED exactly once, every answer within its route's contract", { timeout: 300_000 }, async () => {
  const { ag, operator, approver } = await team("e2e");
  const s = await sealedSubject(ag, operator, "e2e");

  // --- CMD020 StartAudit through its handler: 202, the audit QUEUED with its grant carved from the funded pool --------------------
  w.intelligence.scriptInterpretOutcomes("COMPILED");
  const started = acceptedOf(await app.command(operator, "CMD020", { revisionId: s.revisionId }, { targetContractId: s.contractId, auditPolicyVersion: "R2-INITIAL" }));
  const auditId = started.operationId;
  assert.deepEqual([started.state, started.statusPath], ["QUEUED", `/api/v1/audits/${auditId}`]);
  const queued = await app.read<AuditView>(operator, "GetAudit", { auditId });
  assert.deepEqual([queued.state, queued.revisionId, queued.targetContractId, queued.grantState], ["QUEUED", s.revisionId, s.contractId, "AUTHORIZED"]);

  // --- AUDIT_ORCHESTRATION over B07's dispatcher: PROFILE, INTERPRET, VALIDATE under the audit's fence, to DRAFT_READY ----------
  const orchestrated = await w.drain(w.x.consumers.auditOrchestration);
  assert.deepEqual([orchestrated.delivered, orchestrated.retried, orchestrated.deadLettered], [4, 0, 0], "queued, profiling, interpreting and validating, each delivered once");
  // the system draft's plan.validating.v1 also reaches PLAN_VALIDATION, which leaves an audit's own intent to AUDIT_ORCHESTRATION
  const draftValidation = await w.drain(w.x.consumers.planValidation);
  assert.deepEqual([draftValidation.delivered, draftValidation.retried, draftValidation.deadLettered], [1, 0, 0]);
  const drafted = await app.read<AuditView>(operator, "GetAudit", { auditId });
  assert.equal(drafted.state, "DRAFT_READY", JSON.stringify(drafted));
  assert.ok(drafted.draftPlanId !== undefined, "the status path names the system draft");
  const planId = drafted.draftPlanId;
  assert.deepEqual(await a.steps(auditId), [
    ["PROFILE", 1, "COMPLETED", "SIMULATED"],
    ["INTERPRET", 2, "COMPILED", "SIMULATED"],
    ["VALIDATE", 3, "VALID", "SIMULATED"],
  ]);
  const draft = await a.plan_(planId);
  assert.deepEqual([draft.state, draft.version, draft.created_by_membership_id], ["VALIDATED", "4", (await a.audit(auditId)).requested_by_membership_id], "the requester's system draft, VALIDATED");
  const [receipt, ...otherReceipts] = await a.receipts(planId);
  assert.ok(receipt !== undefined && otherReceipts.length === 0, "one receipt, written by the validator's pool");
  assert.deepEqual([receipt.result, receipt.receipt_hash, receipt.plan_hash, receipt.revision_hash, receipt.target_contract_hash], ["VALID", draft.validation_receipt_hash, draft.body_hash, s.revisionHash, s.targetContractHash]);
  // the audit's grant is reconciled once the audit ended: its known spend joins the pool and its scope closes
  const reconciled = await w.x.sweepers.grantReconciliation.sweep(w.units, 50);
  assert.deepEqual(reconciled.failed, []);
  assert.equal((await a.grant((await a.audit(auditId)).grant_id)).state, "CLOSED", "the audit's grant closed with nothing uncertain");

  // --- CMD025 ApprovePlan through B06's handler: the approver's fresh step-up, the disclosures composed from the records -----------
  const stored = await w.h.oracle.query<{ body: PlanBody; physical: string }>(
    "SELECT p.body, (r.counts ->> 'physicalSourceRows') AS physical FROM kauro.plans p JOIN kauro.validation_receipts r ON r.plan_id = p.plan_id AND r.receipt_hash = p.validation_receipt_hash WHERE p.plan_id = $1",
    [planId],
  );
  const row = stored.rows[0];
  assert.ok(row !== undefined);
  const proof = await w.h.recordStepUp(approver.userId as UserId);
  const approved = completedOf<ApprovePlanView>(
    await app.command(approver, "CMD025", { planId }, {
      expectedVersion: 4,
      planHash: draft.body_hash,
      validationReceiptHash: receipt.receipt_hash,
      disclosuresHash: disclosuresHashOf(draft.body_hash, receipt.receipt_hash, row.body, Number(row.physical)),
      assuranceProofRef: proof,
    }),
    201,
  );
  assert.deepEqual([approved.plan.state, approved.approval.planHash, approved.approval.validationReceiptHash], ["APPROVED", draft.body_hash, receipt.receipt_hash]);

  // --- B09: the quote, the order and the completed capture over the approved plan: an ACTIVE CommercialAuthorization ---------------
  const paid = await w.purchase(ag, planId as never);
  // the entitlement's issued.v1 reaches EXECUTION_CONTROL (B09's routing): not a lost fact, so nothing is cancelled
  const issued = await w.drain(w.x.consumers.executionControl);
  assert.deepEqual([issued.delivered, issued.retried, issued.deadLettered], [1, 0, 0]);
  assert.equal((await w.authorization(paid.authorizationId)).state, "ACTIVE");

  // --- CMD036 ExecuteProject through its handler: 202, one QUEUED job bound to the authorization's subject --------------------------
  const executed = acceptedOf(await app.command(operator, "CMD036", { projectId: s.projectId }, { commercialAuthorizationId: paid.authorizationId }));
  const jobId = executed.operationId;
  assert.deepEqual([executed.state, executed.statusPath], ["QUEUED", `/api/v1/jobs/${jobId}`]);
  const polled = await app.read<JobView>(operator, "GetJob", { jobId });
  assert.deepEqual([polled.state, polled.authorizationId, polled.attempt, polled.publishedPackageId], ["QUEUED", paid.authorizationId, 0, undefined]);

  // --- JOB_EXECUTION: the fair admission consumes the entitlement, then the launch by the attempt's deterministic identity -----------
  const admittedRun = await w.drain(w.x.consumers.jobExecution);
  assert.deepEqual([admittedRun.retried, admittedRun.deadLettered], [0, 0]);
  const launchedAttempt = await w.attempt(jobId);
  assert.deepEqual([launchedAttempt.ordinal, launchedAttempt.state, launchedAttempt.launch_state, launchedAttempt.identity], [1, "STARTING", "LAUNCHED", `kauro-attempt-${launchedAttempt.attempt_id}`]);
  const consumed = await w.authorization(paid.authorizationId);
  assert.deepEqual([consumed.state, consumed.job_ref], ["CONSUMED", jobId], "admission consumed the entitlement, naming the job");

  // --- the worker runs inside the real attempt envelope; ATTEMPT_MONITOR observes its start and its end, and submits its manifest ---
  await w.host.settled(launchedAttempt.identity);
  const monitored = await w.x.sweepers.attemptMonitor.sweep(w.units, 20);
  assert.deepEqual(monitored.failed, []);
  assert.equal((await w.job(jobId)).state, "VERIFYING", "the manifest was read by the control plane and submitted under the fence");

  // --- JOB_EXECUTION: read-back of every generation and the verifier (VERIFIED_PRIVATE), the delivery copies, the publication ------
  const published = await w.drain(w.x.consumers.jobExecution);
  assert.deepEqual([published.retried, published.deadLettered], [0, 0]);
  const job = await w.job(jobId);
  const [pkg, ...otherPackages] = await w.packages(jobId);
  assert.ok(pkg !== undefined && otherPackages.length === 0, "one package version");
  assert.deepEqual([job.state, job.holds, job.published_package_id, job.terminal_reason], ["READY", "NONE", pkg.package_version_id, null]);
  assert.deepEqual([pkg.state, pkg.attempt_id, pkg.revocation_reason], ["AVAILABLE", launchedAttempt.attempt_id, null]);
  assert.ok(pkg.verification_id !== null && pkg.delivery_manifest_hash !== null, "published with its VALID verification and its delivery manifest");
  assert.equal((await w.attempt(jobId)).state, "COMMITTED");
  const delivered = await w.authorization(paid.authorizationId);
  assert.deepEqual([delivered.state, delivered.job_ref], ["DELIVERED", jobId]);
  assert.ok(delivered.delivered_at !== null);
  assert.deepEqual(
    (await eventTypes(paid.authorizationId)).filter((t) => t.startsWith("commercial_authorization.") && t !== "commercial_authorization.issued.v1"),
    ["commercial_authorization.consumed.v1", "commercial_authorization.delivered.v1"],
    "consumed once and delivered once",
  );
  assert.deepEqual(await eventTypes(jobId), ["processing_job.queued.v1", "processing_job.admitted.v1", "processing_job.running.v1", "processing_job.verifying.v1", "processing_job.ready.v1"]);
  assert.deepEqual(await eventTypes(pkg.package_version_id), ["package_version.staged.v1", "package_version.verified_private.v1", "package_version.available.v1"]);
  assert.deepEqual(await w.capacity(ag.agencyId), { active: 0, waiting: 0, live: 0 }, "every slot released once");
  // the status path the 202 named answers READY with the package, within GetJob's contract
  const ready = await app.read<JobView>(operator, "GetJob", { jobId });
  assert.deepEqual([ready.state, ready.attempt, ready.publishedPackageId], ["READY", 1, pkg.package_version_id]);
  // a redelivery of the publication's trigger finds the job READY: nothing is published or delivered twice
  assert.deepEqual(await w.redeliver(w.x.consumers.jobExecution, await w.eventOf(pkg.package_version_id, "package_version.verified_private.v1")), { kind: "DONE" });

  // --- STAGING_JANITOR: the committed attempt's staging is no longer needed (its delivery copies are the package) -------------------
  const janitor = await w.x.sweepers.stagingJanitor.sweep(w.units, 20);
  assert.deepEqual([janitor.acted, janitor.failed], [1, []]);
  assert.deepEqual(await w.objectsUnder("STAGING", launchedAttempt.staging_prefix), [], "nothing is left under the attempt's prefix");
  assert.ok((await w.objectsUnder("DELIVERY", `delivery/${ag.agencyId}/`)).length > 0, "the delivery copies stay");

  // every record both halves produced for a consumer of this control plane was delivered by the pipelines above
  assert.deepEqual(await openRecords(ag.agencyId), [], "nothing is left for the control plane's consumers");

  // --- one whole control-plane cycle over everything both halves wrote: nothing to repair ------------------------------------------
  const versions = { job: job.version, pkg: pkg.version, authorization: delivered.version, audit: (await a.audit(auditId)).version };
  const cycle = await w.plane.runCycle(w.now());
  for (const [name, sweep] of Object.entries(cycle.sweeps)) assert.deepEqual([sweep?.acted, sweep?.failed], [0, []], `${name}: nothing to repair`);
  for (const [consumer, counts] of Object.entries(cycle.dispatched)) assert.deepEqual([counts.delivered, counts.retried, counts.deadLettered], [0, 0, 0], `${consumer}: nothing left to deliver`);
  assert.deepEqual(
    { job: (await w.job(jobId)).version, pkg: (await w.packages(jobId))[0]?.version, authorization: (await w.authorization(paid.authorizationId)).version, audit: (await a.audit(auditId)).version },
    versions,
    "no aggregate of the run moved",
  );
  assert.deepEqual((await eventTypes(paid.authorizationId)).filter((t) => t === "commercial_authorization.delivered.v1"), ["commercial_authorization.delivered.v1"], "delivered exactly once");
});

test("b08 end to end: the agency's own decisions and a cancellation compose with the control plane — an audit that needs a decision takes the agency's candidate decisions through the intake, CreatePlan and ValidatePlan through their handlers, PLAN_VALIDATION validates exactly that intent through the validator's pool; CancelAudit through its handler stops a queued audit before AUDIT_ORCHESTRATION claims a step, and both grants close", { timeout: 300_000 }, async () => {
  const { ag, operator } = await team("decide");
  const s = await sealedSubject(ag, operator, "decide");

  // --- CMD020, then AUDIT_ORCHESTRATION: the interpretation leaves a decision only the agency can make ------------------------------
  w.intelligence.scriptInterpretOutcomes("NEEDS_DECISION");
  const auditId = acceptedOf(await app.command(operator, "CMD020", { revisionId: s.revisionId }, { targetContractId: s.contractId, auditPolicyVersion: "R2-INITIAL" })).operationId;
  const orchestrated = await w.drain(w.x.consumers.auditOrchestration);
  assert.deepEqual([orchestrated.delivered, orchestrated.retried, orchestrated.deadLettered], [3, 0, 0], "queued, profiling and interpreting");
  const decide = await app.read<AuditView>(operator, "GetAudit", { auditId });
  assert.deepEqual([decide.state, decide.pendingDecisions, decide.draftPlanId], ["NEEDS_DECISION", ["AGENCY_DECISION_REQUIRED"], undefined]);

  // --- the decision-artifact intake (content-idempotent), CMD022 CreatePlan over it through the Intelligence core's compiler ----------
  const body = decidedBody(s, "decide");
  const document = { kind: "CANDIDATE_DECISIONS", document: { body } };
  const stored = await app.submitDecisionArtifact<DecisionArtifactIntakeView>(operator, auditId, document);
  assert.deepEqual([stored.created, stored.view.auditId, stored.view.kind], [true, auditId, "CANDIDATE_DECISIONS"]);
  assert.equal((await app.submitDecisionArtifact<DecisionArtifactIntakeView>(operator, auditId, document)).created, false, "the same document again is 200");
  const created = completedOf<PlanView>(await app.command(operator, "CMD022", { auditId }, { candidateDecisionArtifactRef: stored.view.artifactRef }), 201);
  const planHash = structuredDigest(DOMAINS.PLAN_BODY, 1, body);
  assert.deepEqual([created.state, created.version, created.bodyHash, created.revisionHash, created.targetContractHash], ["VALIDATION_REQUIRED", 2, planHash, s.revisionHash, s.targetContractHash]);

  // --- CMD024 ValidatePlan through its handler records the intent; PLAN_VALIDATION validates it through the validator's own pool --------
  const validating = acceptedOf(await app.command(operator, "CMD024", { planId: created.planId }, { expectedVersion: 2, planHash }));
  assert.deepEqual([validating.operationId, validating.state, validating.statusPath], [created.planId, "VALIDATING", `/api/v1/plans/${created.planId}`]);
  const validated = await w.drain(w.x.consumers.planValidation);
  assert.deepEqual([validated.delivered, validated.retried, validated.deadLettered], [1, 0, 0]);
  const plan = await a.plan_(created.planId);
  const [receipt, ...otherReceipts] = await a.receipts(created.planId);
  assert.ok(receipt !== undefined && otherReceipts.length === 0, "one receipt, written by the validator's pool");
  assert.deepEqual([plan.state, plan.version, plan.validation_receipt_hash], ["VALIDATED", "4", receipt.receipt_hash]);
  assert.deepEqual(
    [receipt.result, receipt.plan_hash, receipt.revision_hash, receipt.target_contract_hash, receipt.core_package_hash],
    ["VALID", planHash, s.revisionHash, s.targetContractHash, CONTRACT_FAKE_MIGRATION_CORE_PACKAGE_HASH],
    "the receipt of exactly the intent's body, source, target and installed core",
  );
  assert.deepEqual(await a.validations(created.planId), [[1, "COMMAND", "VALID", receipt.receipt_hash]], "the command's one intent, settled VALID");
  assert.equal((await app.read<AuditView>(operator, "GetAudit", { auditId })).state, "NEEDS_DECISION", "CreatePlan writes no audit: one audit may back several plans");

  // --- CMD021 CancelAudit through its handler on a queued audit; AUDIT_ORCHESTRATION's deliveries find it CANCELLED --------------------
  const next = await sealedSubject(ag, operator, "decide-cancel");
  const queuedId = acceptedOf(await app.command(operator, "CMD020", { revisionId: next.revisionId }, { targetContractId: next.contractId, auditPolicyVersion: "R2-INITIAL" })).operationId;
  const cancelled = completedOf<AuditView>(await app.command(operator, "CMD021", { auditId: queuedId }, { expectedVersion: 1 }), 200);
  assert.deepEqual([cancelled.state, cancelled.cancelVersion, cancelled.terminalReason], ["CANCELLED", 1, "AGENCY_CANCELLED"]);
  const stopped = await w.drain(w.x.consumers.auditOrchestration);
  assert.deepEqual([stopped.delivered, stopped.retried, stopped.deadLettered], [2, 0, 0], "queued and cancelled, each DONE");
  assert.deepEqual(await a.steps(queuedId), [], "no step was claimed");
  assert.equal((await app.read<AuditView>(operator, "GetAudit", { auditId: queuedId })).state, "CANCELLED");

  // --- GRANT_RECONCILIATION closes both ended audits' grants; then one whole cycle finds nothing to repair --------------------------
  const reconciled = await w.x.sweepers.grantReconciliation.sweep(w.units, 50);
  assert.deepEqual(reconciled.failed, []);
  for (const id of [auditId, queuedId]) assert.equal((await a.grant((await a.audit(id)).grant_id)).state, "CLOSED", `the grant of ${id}`);
  assert.deepEqual(await openRecords(ag.agencyId), [], "nothing is left for the control plane's consumers");
  const cycle = await w.plane.runCycle(w.now());
  for (const [name, sweep] of Object.entries(cycle.sweeps)) assert.deepEqual([sweep?.acted, sweep?.failed], [0, []], `${name}: nothing to repair`);
  for (const [consumer, counts] of Object.entries(cycle.dispatched)) assert.deepEqual([counts.delivered, counts.retried, counts.deadLettered], [0, 0, 0], `${consumer}: nothing left to deliver`);
  assert.deepEqual([(await a.plan_(created.planId)).version, (await a.audit(auditId)).version, (await a.audit(queuedId)).version], ["4", "4", "2"], "nothing moved");
});
