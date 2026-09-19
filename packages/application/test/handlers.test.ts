// Orchestration of the seven B06 handlers over the in-memory ports (design §8): the write order, the preconditions in order,
// the events and outbox rows each command publishes, the journaled response, the replay / conflict / stale-version answers,
// and atomicity (a rejection leaves nothing, journal reservation included). The same commands against real PostgreSQL —
// locks, RLS, composite keys, the concurrent interleavings of the RACE cases — are the integration tests named in
// docs/design/B06-case-map.md.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgencyId, CapabilityId, MembershipId, PlanId } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import type { B06Collaborators, CommandResult, DisclosureSet, PatchCompilation } from "../src/index.js";
import { APPROVE_PLAN, ARCHIVE_CLIENT, CREATE_AGENCY, CREATE_CLIENT, CREATE_PROJECT, REVISE_PLAN, WITHDRAW_APPROVAL, approvalHashOf, createB06Handlers } from "../src/index.js";
import { approvalId, bodyHashOf, clock, envelope, planBodyOf, sha, subject, world, type World } from "./support.js";

const KEY = "0123456789abcdef-key";

function collaborators(w: World, overrides: Partial<B06Collaborators> = {}): B06Collaborators {
  const patched = planBodyOf(w.revisionHash, w.targetContractHash, "Email");
  return {
    abuseLimiter: { admit: async () => ({ kind: "ADMITTED" }) },
    activeWork: { inspectClient: async (uow, clientId) => ({ openProjects: await uow.endClients.countOpenProjects(clientId), activeJobs: 0, liveCommercialAuthorizations: 0 }) },
    artifacts: {
      resolveDecisionPatch: async (_uow, agencyId, ref) => (agencyId === w.agencyId && ref !== "00000000-0000-7000-8000-000000000000" ? { artifactRef: ref, patchHash: sha("patch"), document: { candidate: "Email" } } : null),
    },
    patchCompiler: { apply: async (): Promise<PatchCompilation> => ({ kind: "COMPILED", body: patched, bodyHash: bodyHashOf(patched) }) },
    disclosures: { compose: async (_uow, plan): Promise<DisclosureSet> => ({ disclosuresHash: sha(`disclosures:${plan.bodyHash}:CLEAR`), items: ["CLEAR:Contact.Phone:120"], includesClear: true }) },
    externalActions: { completedForPlan: async () => [] },
    ...overrides,
  };
}

function completed<V>(r: CommandResult<V>): Extract<CommandResult<V>, { kind: "COMPLETED" }> {
  assert.equal(r.kind, "COMPLETED", r.kind === "COMPLETED" || r.kind === "ACCEPTED" ? "" : JSON.stringify(r.problem));
  return r as Extract<CommandResult<V>, { kind: "COMPLETED" }>;
}

function problem<V>(r: CommandResult<V>) {
  assert.notEqual(r.kind, "COMPLETED");
  assert.notEqual(r.kind, "ACCEPTED");
  return (r as Extract<CommandResult<V>, { kind: "CONFLICT" | "REJECTED" | "UNAVAILABLE" }>).problem;
}

// --- CMD001 ------------------------------------------------------------------------------------------------------------

test("CMD001 OK: one DRAFT agency and one ACTIVE OWNER membership, two events, one outbox row, journal COMMITTED, 201", async () => {
  const w = world();
  const h = createB06Handlers(w.runtime, collaborators(w));
  const newcomer = subject("newcomer");
  const before = w.store().agencies.size;
  const r = completed(await h.CMD001.execute(envelope(CREATE_AGENCY, newcomer, { key: KEY, body: { displayName: "Fresh Agency" } })));
  assert.equal(r.status, 201);
  assert.equal(r.replayed, false);
  assert.equal(r.view.agency.state, "DRAFT");
  assert.equal(r.view.agency.version, 1);
  assert.equal(r.view.agency.termsVersion, undefined);
  assert.deepEqual(r.view.agency.permittedActions.includes("APPROVE_PLANS"), true);
  assert.equal(r.view.membership.role, "OWNER");
  assert.equal(r.view.membership.state, "ACTIVE");
  assert.equal(r.view.membership.userId, newcomer.identity.userId);
  const s = w.store();
  assert.equal(s.agencies.size, before + 1);
  assert.equal(s.identities.get(newcomer.identity.userId)?.subjectHash, newcomer.subjectHash);
  const types = s.events.slice(-2).map((e) => e.eventType);
  assert.deepEqual(types, ["agency.created.v1", "membership.created.v1"]);
  assert.equal(s.outbox.filter((o) => o.consumer === "NOTIFICATIONS").length, 1);
  const entry = [...s.journal.values()].find((j) => j.identity.operation === "CMD001");
  assert.equal(entry?.state, "COMMITTED");
  assert.equal(entry?.identity.agencyId, null);
  assert.equal(entry?.resourceKind, "agency");
  assert.equal(entry?.responseStatus, 201);
});

test("CMD001 DENY: an admission refusal or a second DRAFT for the same creator commits nothing", async () => {
  const w = world();
  const limited = createB06Handlers(w.runtime, collaborators(w, { abuseLimiter: { admit: async () => ({ kind: "LIMITED", reason: "CREATION_RATE_LIMITED", retryAfterSeconds: 30 }) } }));
  const p = problem(await limited.CMD001.execute(envelope(CREATE_AGENCY, subject("burst"), { key: KEY, body: { displayName: "X" } })));
  assert.equal(p.code, "ADMISSION_LIMITED");
  assert.equal(p.reason, "CREATION_RATE_LIMITED");
  assert.equal(p.retryAfterSeconds, 30);
  assert.equal(p.status, 429);
  // the owner of the world already holds a DRAFT agency: the structural limit refuses a second one
  const h = createB06Handlers(w.runtime, collaborators(w));
  const before = { agencies: w.store().agencies.size, journal: w.store().journal.size, events: w.store().events.length };
  const p2 = problem(await h.CMD001.execute(envelope(CREATE_AGENCY, w.owner, { key: KEY, body: { displayName: "Second draft" } })));
  assert.equal(p2.code, "ADMISSION_LIMITED");
  assert.equal(p2.reason, "DRAFT_AGENCY_EXISTS");
  assert.deepEqual({ agencies: w.store().agencies.size, journal: w.store().journal.size, events: w.store().events.length }, before, "a rejection leaves no row, no journal entry, no event");
});

test("CMD001 RACE: identical retry replays the same agency; the same key with another displayName is 409 IDEMPOTENCY_CONFLICT with no effect", async () => {
  const w = world();
  const h = createB06Handlers(w.runtime, collaborators(w));
  const s = subject("retrier");
  const first = completed(await h.CMD001.execute(envelope(CREATE_AGENCY, s, { key: KEY, body: { displayName: "Retry Co" } })));
  const again = completed(await h.CMD001.execute(envelope(CREATE_AGENCY, s, { key: KEY, body: { displayName: "Retry Co" } })));
  assert.equal(again.replayed, true);
  assert.deepEqual(again.view, first.view);
  assert.equal(again.status, 201);
  const conflict = problem(await h.CMD001.execute(envelope(CREATE_AGENCY, s, { key: KEY, body: { displayName: "Retry Co (edited)" } })));
  assert.equal(conflict.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(conflict.reason, "REQUEST_DIGEST_DIFFERS");
  assert.equal([...w.store().agencies.values()].filter((a) => a.createdByUserId === s.identity.userId).length, 1);
  // another identity with the same key is another logical operation (the identity includes the actor)
  const other = completed(await h.CMD001.execute(envelope(CREATE_AGENCY, subject("someone-else"), { key: KEY, body: { displayName: "Retry Co" } })));
  assert.notEqual(other.view.agency.agencyId, first.view.agency.agencyId);
});

// --- CMD009 ------------------------------------------------------------------------------------------------------------

test("CMD009 OK: an OPERATOR creates a client; two clients may share a label and keep distinct ids; one event each", async () => {
  const w = world();
  const h = createB06Handlers(w.runtime, collaborators(w));
  const path = { agencyId: w.agencyId };
  const a = completed(await h.CMD009.execute(envelope(CREATE_CLIENT, w.operator, { key: KEY + "1", path, body: { displayName: "Same Label", processingAuthorityRef: w.authorityId } })));
  const b = completed(await h.CMD009.execute(envelope(CREATE_CLIENT, w.operator, { key: KEY + "2", path, body: { displayName: "Same Label", processingAuthorityRef: w.authorityId } })));
  assert.equal(a.status, 201);
  assert.equal(a.view.state, "ACTIVE");
  assert.equal(a.view.version, 1);
  assert.equal(a.view.agencyId, w.agencyId);
  assert.notEqual(a.view.clientId, b.view.clientId);
  assert.equal(w.store().events.filter((e) => e.eventType === "end_client.created.v1").length, 2);
});

test("CMD009 DENY: a foreign processing authority is UNKNOWN_REFERENCE with a field error, a non-member is NOT_FOUND, a closed agency is AGENCY_NOT_OPEN; no row in any case", async () => {
  const w = world();
  const h = createB06Handlers(w.runtime, collaborators(w));
  const path = { agencyId: w.agencyId };
  const clients = w.store().endClients.size;
  const foreign = problem(await h.CMD009.execute(envelope(CREATE_CLIENT, w.operator, { key: KEY + "f", path, body: { displayName: "X", processingAuthorityRef: w.foreignAuthorityId } })));
  assert.equal(foreign.code, "INVALID_REQUEST");
  assert.deepEqual(foreign.errors, [{ field: "processingAuthorityRef", code: "UNKNOWN_REFERENCE" }]);
  const stranger = problem(await h.CMD009.execute(envelope(CREATE_CLIENT, w.stranger, { key: KEY + "s", path, body: { displayName: "X", processingAuthorityRef: w.authorityId } })));
  assert.equal(stranger.code, "NOT_FOUND");
  w.store().agencies.set(w.agencyId, { ...w.store().agencies.get(w.agencyId)!, state: "CLOSING" });
  const closing = problem(await h.CMD009.execute(envelope(CREATE_CLIENT, w.operator, { key: KEY + "c", path, body: { displayName: "X", processingAuthorityRef: w.authorityId } })));
  assert.equal(closing.code, "PRECONDITION_FAILED");
  assert.equal(closing.reason, "AGENCY_NOT_OPEN");
  assert.equal(w.store().endClients.size, clients);
  assert.equal([...w.store().journal.values()].filter((j) => j.identity.operation === "CMD009").length, 0, "rejections leave no journal row");
});

// --- CMD010 ------------------------------------------------------------------------------------------------------------

test("CMD010 OK: ARCHIVED at version 2 with the retained work reported; projects stay; CreateProject on it is then CLIENT_ARCHIVED", async () => {
  const w = world();
  const h = createB06Handlers(w.runtime, collaborators(w));
  const projects = w.store().projects.size;
  const r = completed(await h.CMD010.execute(envelope(ARCHIVE_CLIENT, w.owner, { key: KEY, agencyId: w.agencyId, path: { clientId: w.clientId }, body: { expectedVersion: 1 } })));
  assert.equal(r.status, 200);
  assert.equal(r.view.client.state, "ARCHIVED");
  assert.equal(r.view.client.version, 2);
  assert.ok(r.view.client.archivedAt);
  assert.deepEqual(r.view.retainedActiveWork, { openProjects: 1, activeJobs: 0, liveCommercialAuthorizations: 0 });
  assert.equal(w.store().projects.size, projects, "archiving deletes nothing");
  const ev = w.store().events.at(-1)!;
  assert.equal(ev.eventType, "end_client.archived.v1");
  assert.equal(ev.payload["openProjects"], 1);
  const p = problem(await h.CMD011.execute(envelope(CREATE_PROJECT, w.operator, { key: KEY + "p", agencyId: w.agencyId, path: { clientId: w.clientId }, body: { mode: "CLEAN", purpose: "Later" } })));
  assert.equal(p.code, "PRECONDITION_FAILED");
  assert.equal(p.reason, "CLIENT_ARCHIVED");
});

test("CMD010 DENY / RACE: a foreign client is NOT_FOUND; a stale expectedVersion is 409 with the current version and state; the second of two archives on one version loses; identical retry replays", async () => {
  const w = world();
  const h = createB06Handlers(w.runtime, collaborators(w));
  const foreign = problem(await h.CMD010.execute(envelope(ARCHIVE_CLIENT, w.owner, { key: KEY + "f", agencyId: w.agencyId, path: { clientId: w.foreignClientId }, body: { expectedVersion: 1 } })));
  assert.equal(foreign.code, "NOT_FOUND");
  const stale = problem(await h.CMD010.execute(envelope(ARCHIVE_CLIENT, w.owner, { key: KEY + "s", agencyId: w.agencyId, path: { clientId: w.clientId }, body: { expectedVersion: 7 } })));
  assert.equal(stale.code, "STALE_VERSION");
  assert.deepEqual(stale.current, { version: 1, state: "ACTIVE" });
  assert.deepEqual(stale.nextActions.map((a) => a.action), ["RELOAD", "COMPARE_VERSIONS"]);
  const first = completed(await h.CMD010.execute(envelope(ARCHIVE_CLIENT, w.owner, { key: KEY + "1", agencyId: w.agencyId, path: { clientId: w.clientId }, body: { expectedVersion: 1 } })));
  const second = problem(await h.CMD010.execute(envelope(ARCHIVE_CLIENT, w.owner, { key: KEY + "2", agencyId: w.agencyId, path: { clientId: w.clientId }, body: { expectedVersion: 1 } })));
  assert.equal(second.code, "STALE_VERSION");
  assert.deepEqual(second.current, { version: 2, state: "ARCHIVED" });
  const replay = completed(await h.CMD010.execute(envelope(ARCHIVE_CLIENT, w.owner, { key: KEY + "1", agencyId: w.agencyId, path: { clientId: w.clientId }, body: { expectedVersion: 1 } })));
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.view, first.view);
  assert.equal(w.store().events.filter((e) => e.eventType === "end_client.archived.v1").length, 1, "one transition, one event");
});

// --- CMD011 ------------------------------------------------------------------------------------------------------------

test("CMD011 OK: a CLEAN project with its DRAFT revision, capability snapshot and readiness blockers; two events", async () => {
  const w = world();
  const h = createB06Handlers(w.runtime, collaborators(w));
  const r = completed(await h.CMD011.execute(envelope(CREATE_PROJECT, w.operator, { key: KEY, agencyId: w.agencyId, path: { clientId: w.clientId }, body: { mode: "CLEAN", purpose: "Dedupe contacts" } })));
  assert.equal(r.status, 201);
  assert.equal(r.view.state, "OPEN");
  assert.equal(r.view.version, 1);
  assert.equal(r.view.capabilityVersion, "R2-INITIAL");
  assert.equal(r.view.currentRevision.state, "DRAFT");
  assert.deepEqual(r.view.readinessBlockers, ["AGENCY_NOT_ACTIVE", "NO_SEALED_REVISION", "TARGET_CONTRACT_MISSING", "PLAN_MISSING"]);
  assert.equal(r.view.targetInstanceRef, undefined);
  const s = w.store();
  assert.equal(s.projects.get(r.view.projectId)?.currentRevisionId, r.view.currentRevision.revisionId);
  assert.deepEqual(s.events.slice(-2).map((e) => e.eventType), ["project.created.v1", "dataset_revision.created.v1"]);
});

test("CMD011 DENY: a mode without an offered capability is 422 CAPABILITY_UNAVAILABLE before anything else exists; a CRM mode without targetInstanceRef is 400; nothing is written", async () => {
  const w = world();
  const h = createB06Handlers(w.runtime, collaborators(w));
  const projects = w.store().projects.size;
  const notOffered = problem(await h.CMD011.execute(envelope(CREATE_PROJECT, w.operator, { key: KEY + "h", agencyId: w.agencyId, path: { clientId: w.clientId }, body: { mode: "HUBSPOT", purpose: "Import", targetInstanceRef: "018f0000-0000-7000-8000-000000000001" } })));
  assert.equal(notOffered.code, "CAPABILITY_UNAVAILABLE");
  assert.equal(notOffered.reason, "MODE_NOT_OFFERED");
  assert.equal(notOffered.status, 422);
  assert.deepEqual(notOffered.nextActions.map((a) => a.action), ["CHOOSE_ANOTHER_MODE"]);
  // offer SALESFORCE, then require the target declaration
  const sf = "018f0000-0000-7000-8000-00000000cafe";
  w.store().capabilities.set(sf, { capabilityId: sf as CapabilityId, version: "R2-INITIAL", kind: "MODE", mode: "SALESFORCE", state: "AVAILABLE", profileHash: sha("sf"), qualificationEvidenceHashes: [sha("q")], reviewTrigger: "VENDOR_OR_ENVELOPE_CHANGE" });
  const noTarget = problem(await h.CMD011.execute(envelope(CREATE_PROJECT, w.operator, { key: KEY + "t", agencyId: w.agencyId, path: { clientId: w.clientId }, body: { mode: "SALESFORCE", purpose: "Import" } })));
  assert.equal(noTarget.code, "INVALID_REQUEST");
  assert.equal(noTarget.reason, "TARGET_INSTANCE_REQUIRED");
  assert.deepEqual(noTarget.errors, [{ field: "targetInstanceRef", code: "REQUIRED" }]);
  assert.equal(w.store().projects.size, projects);
  assert.equal(w.store().revisions.size, 1);
});

// --- CMD023 ------------------------------------------------------------------------------------------------------------

test("CMD023 OK: predecessor SUPERSEDED (v5) naming its successor; successor VALIDATION_REQUIRED (v2) with a new body hash and no receipt; impact map; three events; EXECUTION_CONTROL outbox", async () => {
  const w = world();
  const h = createB06Handlers(w.runtime, collaborators(w));
  const ref = "018f0000-0000-7000-8000-0000000000aa";
  const r = completed(await h.CMD023.execute(envelope(REVISE_PLAN, w.operator, { key: KEY, agencyId: w.agencyId, path: { planId: w.planId }, body: { expectedVersion: 4, decisionPatchArtifactRef: ref } })));
  assert.equal(r.status, 201);
  assert.equal(r.view.plan.state, "VALIDATION_REQUIRED");
  assert.equal(r.view.plan.version, 2);
  assert.equal(r.view.plan.supersedesPlanId, w.planId);
  assert.equal(r.view.plan.validationReceiptHash, undefined);
  assert.notEqual(r.view.plan.bodyHash, bodyHashOf(w.planBody));
  assert.deepEqual(r.view.supersededPlan, { planId: w.planId, version: 5, state: "SUPERSEDED" });
  assert.deepEqual(r.view.invalidated, { validationReceiptHash: w.receiptHash });
  const s = w.store();
  assert.equal(s.plans.get(w.planId)?.supersededByPlanId, r.view.plan.planId);
  assert.equal(s.plans.get(w.planId)?.validationReceiptHash, w.receiptHash, "history kept: the predecessor keeps its receipt");
  assert.deepEqual(s.events.slice(-3).map((e) => e.eventType), ["plan.superseded.v1", "plan.created.v1", "plan.validation_required.v1"]);
  assert.equal(s.events.at(-3)!.payload["invalidatedReceiptHash"], w.receiptHash);
  assert.equal(s.outbox.filter((o) => o.consumer === "EXECUTION_CONTROL").length, 1);
});

test("CMD023 DENY: unknown patch → 400 UNKNOWN_REFERENCE; compiler rejection → 400 with the patch reason; same body → NO_SEMANTIC_CHANGE; expectedVersion of a superseded plan → STALE_VERSION carrying successorId; no new row", async () => {
  const w = world();
  const h = createB06Handlers(w.runtime, collaborators(w));
  const unknown = problem(await h.CMD023.execute(envelope(REVISE_PLAN, w.operator, { key: KEY + "u", agencyId: w.agencyId, path: { planId: w.planId }, body: { expectedVersion: 4, decisionPatchArtifactRef: "00000000-0000-7000-8000-000000000000" } })));
  assert.equal(unknown.code, "INVALID_REQUEST");
  assert.deepEqual(unknown.errors, [{ field: "decisionPatchArtifactRef", code: "UNKNOWN_REFERENCE" }]);
  const rejecting = createB06Handlers(w.runtime, collaborators(w, { patchCompiler: { apply: async () => ({ kind: "REJECTED", reason: "UNKNOWN_CANDIDATE" }) } }));
  const rejected = problem(await rejecting.CMD023.execute(envelope(REVISE_PLAN, w.operator, { key: KEY + "r", agencyId: w.agencyId, path: { planId: w.planId }, body: { expectedVersion: 4, decisionPatchArtifactRef: "018f0000-0000-7000-8000-0000000000aa" } })));
  assert.equal(rejected.code, "INVALID_REQUEST");
  assert.equal(rejected.reason, "PATCH_UNKNOWN_CANDIDATE");
  const same = createB06Handlers(w.runtime, collaborators(w, { patchCompiler: { apply: async (current) => ({ kind: "COMPILED", body: current, bodyHash: bodyHashOf(current) }) } }));
  const unchanged = problem(await same.CMD023.execute(envelope(REVISE_PLAN, w.operator, { key: KEY + "n", agencyId: w.agencyId, path: { planId: w.planId }, body: { expectedVersion: 4, decisionPatchArtifactRef: "018f0000-0000-7000-8000-0000000000aa" } })));
  assert.equal(unchanged.code, "PRECONDITION_FAILED");
  assert.equal(unchanged.reason, "NO_SEMANTIC_CHANGE");
  assert.equal(w.store().plans.size, 1, "no successor row from any rejection");
  // supersede, then a stale UI edits the predecessor at its old version
  const ok = completed(await h.CMD023.execute(envelope(REVISE_PLAN, w.operator, { key: KEY + "ok", agencyId: w.agencyId, path: { planId: w.planId }, body: { expectedVersion: 4, decisionPatchArtifactRef: "018f0000-0000-7000-8000-0000000000aa" } })));
  const stale = problem(await h.CMD023.execute(envelope(REVISE_PLAN, w.operator, { key: KEY + "st", agencyId: w.agencyId, path: { planId: w.planId }, body: { expectedVersion: 4, decisionPatchArtifactRef: "018f0000-0000-7000-8000-0000000000aa" } })));
  assert.equal(stale.code, "STALE_VERSION");
  assert.deepEqual(stale.current, { version: 5, state: "SUPERSEDED", successorId: ok.view.plan.planId });
  // the right version of a superseded plan is still refused: the edge is not listed
  const listed = problem(await h.CMD023.execute(envelope(REVISE_PLAN, w.operator, { key: KEY + "ed", agencyId: w.agencyId, path: { planId: w.planId }, body: { expectedVersion: 5, decisionPatchArtifactRef: "018f0000-0000-7000-8000-0000000000aa" } })));
  assert.equal(listed.code, "PRECONDITION_FAILED");
  assert.equal(listed.reason, "PLAN_SUPERSEDED");
  assert.equal(listed.current?.successorId, ok.view.plan.planId);
});

// --- CMD025 ------------------------------------------------------------------------------------------------------------

function approveBody(w: World, overrides: Partial<{ expectedVersion: number; planHash: string; validationReceiptHash: string; disclosuresHash: string; assuranceProofRef: string }> = {}) {
  const planHash = bodyHashOf(w.planBody);
  return {
    expectedVersion: 4,
    planHash,
    validationReceiptHash: w.receiptHash,
    disclosuresHash: sha(`disclosures:${planHash}:CLEAR`),
    assuranceProofRef: w.proofId,
    ...overrides,
  };
}

test("CMD025 OK: an immutable approval bound to the exact plan/source/target/receipt/disclosures with a recomputable KAURO_PLAN_APPROVAL_V1 hash; plan APPROVED v5; two events; NOTIFICATIONS outbox", async () => {
  const w = world();
  const h = createB06Handlers(w.runtime, collaborators(w));
  const r = completed(await h.CMD025.execute(envelope(APPROVE_PLAN, w.approver, { key: KEY, agencyId: w.agencyId, path: { planId: w.planId }, body: approveBody(w) })));
  assert.equal(r.status, 201);
  assert.equal(r.view.plan.state, "APPROVED");
  assert.equal(r.view.plan.version, 5);
  assert.equal(r.view.plan.approvalId, r.view.approval.approvalId);
  assert.equal(r.view.approval.version, 1);
  assert.equal(r.view.approval.actorMembershipId, w.approverMembershipId);
  const stored = w.store().approvals.get(r.view.approval.approvalId)!;
  assert.equal(stored.actorMembershipVersion, 1);
  assert.equal(stored.assuranceProofRef, w.proofId);
  assert.equal(
    stored.approvalHash,
    approvalHashOf({
      approvalId: stored.approvalId,
      actorId: w.approver.identity.userId,
      agencyId: w.agencyId,
      planHash: bodyHashOf(w.planBody),
      revisionHash: w.revisionHash,
      targetContractHash: w.targetContractHash,
      validationReceiptHash: w.receiptHash,
      disclosuresHash: sha(`disclosures:${bodyHashOf(w.planBody)}:CLEAR`),
      createdAt: stored.createdAt,
    }),
  );
  assert.deepEqual(w.store().events.slice(-2).map((e) => e.eventType), ["approval.created.v1", "plan.approved.v1"]);
  assert.equal(w.store().outbox.filter((o) => o.consumer === "NOTIFICATIONS").length, 1);
});

test("CMD025 DENY: stale receipt → 422 PLAN_NOT_VALIDATED; disclosures without the CLEAR set → 409 STALE_VERSION mismatch [disclosuresHash]; wrong planHash → mismatch [planHash]; expired source → 422 SOURCE_EXPIRED; superseded target → 422 TARGET_STALE; nothing committed", async () => {
  const w = world();
  const h = createB06Handlers(w.runtime, collaborators(w));
  const path = { planId: w.planId };
  const staleReceipt = problem(await h.CMD025.execute(envelope(APPROVE_PLAN, w.approver, { key: KEY + "1", agencyId: w.agencyId, path, body: approveBody(w, { validationReceiptHash: sha("old-receipt") }) })));
  assert.equal(staleReceipt.code, "PLAN_NOT_VALIDATED");
  assert.equal(staleReceipt.reason, "RECEIPT_NOT_CURRENT");
  const noClear = problem(await h.CMD025.execute(envelope(APPROVE_PLAN, w.approver, { key: KEY + "2", agencyId: w.agencyId, path, body: approveBody(w, { disclosuresHash: sha("disclosures-without-clear") }) })));
  assert.equal(noClear.code, "STALE_VERSION");
  assert.equal(noClear.reason, "DISCLOSURES_INCOMPLETE");
  assert.deepEqual(noClear.current, { version: 4, state: "VALIDATED", mismatch: ["disclosuresHash"] });
  const wrongHash = problem(await h.CMD025.execute(envelope(APPROVE_PLAN, w.approver, { key: KEY + "3", agencyId: w.agencyId, path, body: approveBody(w, { planHash: sha("another-body") }) })));
  assert.equal(wrongHash.code, "STALE_VERSION");
  assert.deepEqual(wrongHash.current?.mismatch, ["planHash"]);
  const blocking = createB06Handlers(w.runtime, collaborators(w));
  w.store().receipts.forEach((rc, k) => w.store().receipts.set(k, { ...rc, blockingIssueCodes: ["PHONE_FORMAT"] }));
  const blocked = problem(await blocking.CMD025.execute(envelope(APPROVE_PLAN, w.approver, { key: KEY + "4", agencyId: w.agencyId, path, body: approveBody(w) })));
  assert.equal(blocked.reason, "RECEIPT_BLOCKING");
  w.store().receipts.forEach((rc, k) => w.store().receipts.set(k, { ...rc, blockingIssueCodes: [] }));
  w.store().revisions.set(w.revisionId, { ...w.store().revisions.get(w.revisionId)!, state: "EXPIRED" });
  const expired = problem(await h.CMD025.execute(envelope(APPROVE_PLAN, w.approver, { key: KEY + "5", agencyId: w.agencyId, path, body: approveBody(w) })));
  assert.equal(expired.code, "SOURCE_EXPIRED");
  assert.deepEqual(expired.nextActions.map((a) => a.action), ["REQUEST_NEW_REVIEW"]);
  w.store().revisions.set(w.revisionId, { ...w.store().revisions.get(w.revisionId)!, state: "SEALED" });
  w.store().targetContracts.forEach((tc, k) => w.store().targetContracts.set(k, { ...tc, supersededAt: clock.now() }));
  const target = problem(await h.CMD025.execute(envelope(APPROVE_PLAN, w.approver, { key: KEY + "6", agencyId: w.agencyId, path, body: approveBody(w) })));
  assert.equal(target.code, "TARGET_STALE");
  assert.equal(w.store().approvals.size, 0);
  assert.equal(w.store().plans.get(w.planId)?.state, "VALIDATED");
  assert.equal(w.store().plans.get(w.planId)?.version, 4);
});

test("CMD025 RACE: two approvers on one version → one 201, one 409 STALE_VERSION; identical retry replays; conflicting same key → 409 IDEMPOTENCY_CONFLICT; one live approval", async () => {
  const w = world();
  const h = createB06Handlers(w.runtime, collaborators(w));
  const path = { planId: w.planId };
  const first = completed(await h.CMD025.execute(envelope(APPROVE_PLAN, w.approver, { key: KEY + "a", agencyId: w.agencyId, path, body: approveBody(w) })));
  const loser = problem(await h.CMD025.execute(envelope(APPROVE_PLAN, w.owner, { key: KEY + "b", agencyId: w.agencyId, path, body: approveBody(w) })));
  assert.equal(loser.code, "STALE_VERSION");
  assert.deepEqual(loser.current, { version: 5, state: "APPROVED" });
  const replay = completed(await h.CMD025.execute(envelope(APPROVE_PLAN, w.approver, { key: KEY + "a", agencyId: w.agencyId, path, body: approveBody(w) })));
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.view, first.view);
  const conflict = problem(await h.CMD025.execute(envelope(APPROVE_PLAN, w.approver, { key: KEY + "a", agencyId: w.agencyId, path, body: approveBody(w, { disclosuresHash: sha("x") }) })));
  assert.equal(conflict.code, "IDEMPOTENCY_CONFLICT");
  assert.equal([...w.store().approvals.values()].filter((a) => a.planId === w.planId && a.withdrawnAt === undefined).length, 1);
  assert.equal(w.store().events.filter((e) => e.eventType === "plan.approved.v1").length, 1);
});

// --- CMD026 ------------------------------------------------------------------------------------------------------------

async function approved(w: World) {
  const h = createB06Handlers(w.runtime, collaborators(w));
  completed(await h.CMD025.execute(envelope(APPROVE_PLAN, w.approver, { key: KEY + "approve", agencyId: w.agencyId, path: { planId: w.planId }, body: approveBody(w) })));
  return h;
}

test("CMD026 OK: the approving actor withdraws; approval carries withdrawnAt/reason at version 2; plan WITHDRAWN v6; receipts and the approval row stay; outbox NOTIFICATIONS + EXECUTION_CONTROL; completed external actions listed separately", async () => {
  const w = world();
  const stageId = "018f0000-0000-7000-8000-00000000beef";
  const h = createB06Handlers(w.runtime, collaborators(w, { externalActions: { completedForPlan: async () => [{ kind: "IMPORT_STAGE_VERIFIED", referenceId: stageId }] } }));
  completed(await h.CMD025.execute(envelope(APPROVE_PLAN, w.approver, { key: KEY + "approve", agencyId: w.agencyId, path: { planId: w.planId }, body: approveBody(w) })));
  const outboxBefore = w.store().outbox.length;
  const r = completed(await h.CMD026.execute(envelope(WITHDRAW_APPROVAL, w.approver, { key: KEY, agencyId: w.agencyId, path: { planId: w.planId }, body: { expectedVersion: 5, reasonCode: "SCOPE_CHANGED" } })));
  assert.equal(r.status, 200);
  assert.equal(r.view.plan.state, "WITHDRAWN");
  assert.equal(r.view.plan.version, 6);
  assert.equal(r.view.approval.version, 2);
  assert.ok(r.view.approval.withdrawnAt);
  assert.equal(r.view.approval.withdrawReasonCode, "SCOPE_CHANGED");
  assert.deepEqual(r.view.completedExternalActions, [{ kind: "IMPORT_STAGE_VERIFIED", referenceId: stageId }]);
  assert.ok(!("rollback" in r.view), "the response never claims a rollback");
  const s = w.store();
  assert.equal(s.approvals.size, 1);
  assert.equal(s.receipts.size, 1);
  assert.deepEqual(s.events.slice(-2).map((e) => e.eventType), ["approval.withdrawn.v1", "plan.withdrawn.v1"]);
  assert.deepEqual(s.events.at(-2)!.payload["completedExternalActions"], [stageId]);
  assert.deepEqual(s.outbox.slice(outboxBefore).map((o) => o.consumer).sort(), ["EXECUTION_CONTROL", "EXECUTION_CONTROL", "NOTIFICATIONS"]);
});

test("CMD026 DENY / RACE: another APPROVER is NOT_APPROVAL_CONTROLLER (and a denial security event); an OWNER may withdraw; a plan not APPROVED is PRECONDITION_FAILED; the second withdrawal loses; a withdrawal cannot be undone", async () => {
  const w = world();
  const h = await approved(w);
  const path = { planId: w.planId };
  const other = subject("second-approver");
  w.store().identities.set(other.identity.userId, { ...other.identity, provider: other.provider, subjectHash: other.subjectHash });
  const otherMembershipId = "018f0000-0000-7000-8000-00000000d00d" as MembershipId;
  w.store().memberships.set(otherMembershipId, { membershipId: otherMembershipId, agencyId: w.agencyId, userId: other.identity.userId, role: "APPROVER", state: "ACTIVE", version: 1, assurancePolicy: "MFA_REQUIRED", acceptedAt: clock.now(), createdAt: clock.now(), updatedAt: clock.now() });
  const notController = problem(await h.CMD026.execute(envelope(WITHDRAW_APPROVAL, other, { key: KEY + "o", agencyId: w.agencyId, path, body: { expectedVersion: 5, reasonCode: "SCOPE_CHANGED" } })));
  assert.equal(notController.code, "NOT_AUTHORIZED");
  assert.equal(notController.reason, "NOT_APPROVAL_CONTROLLER");
  const denial = w.store().securityEvents.at(-1)!;
  assert.equal(denial.action, "CMD026");
  assert.equal(denial.outcome, "DENY");
  assert.equal(denial.reasonCode, "NOT_APPROVAL_CONTROLLER");
  assert.equal(denial.agencyId, w.agencyId);
  assert.equal(w.store().plans.get(w.planId)?.state, "APPROVED");
  const byOwner = completed(await h.CMD026.execute(envelope(WITHDRAW_APPROVAL, w.owner, { key: KEY + "w", agencyId: w.agencyId, path, body: { expectedVersion: 5, reasonCode: "OWNER_DECISION" } })));
  assert.equal(byOwner.view.plan.state, "WITHDRAWN");
  const second = problem(await h.CMD026.execute(envelope(WITHDRAW_APPROVAL, w.approver, { key: KEY + "2", agencyId: w.agencyId, path, body: { expectedVersion: 5, reasonCode: "SCOPE_CHANGED" } })));
  assert.equal(second.code, "STALE_VERSION");
  assert.deepEqual(second.current, { version: 6, state: "WITHDRAWN" });
  const notApproved = problem(await h.CMD026.execute(envelope(WITHDRAW_APPROVAL, w.approver, { key: KEY + "3", agencyId: w.agencyId, path, body: { expectedVersion: 6, reasonCode: "SCOPE_CHANGED" } })));
  assert.equal(notApproved.code, "PRECONDITION_FAILED");
  assert.equal(notApproved.reason, "PLAN_NOT_APPROVED");
  assert.equal(w.store().approvals.get(approvalId(w.store(), w.planId)!)?.withdrawReasonCode, "OWNER_DECISION", "the first withdrawal stands");
});

// --- atomicity ---------------------------------------------------------------------------------------------------------

test("a crash after the inserts and before COMMIT leaves nothing: no agency, no membership, no event, no outbox row, no journal row", async () => {
  const w = world();
  const boom = new Error("connection reset before commit");
  const h = createB06Handlers(w.runtime, collaborators(w, { abuseLimiter: { admit: async () => ({ kind: "ADMITTED" }) } }));
  // the in-memory unit of work commits when the body returns; a throw from inside discards the working copy — simulate the
  // crash through the event publisher of a wrapped unit of work
  const crashing = createB06Handlers(
    {
      ...w.runtime,
      unitOfWork: {
        run: (context, work) =>
          w.runtime.unitOfWork.run(context, async (uow) => {
            await work(uow); // every write of the command has happened
            throw boom; // ... and the connection dies before COMMIT
          }),
      },
    },
    collaborators(w),
  );
  const before = structuredClone({ agencies: w.store().agencies.size, memberships: w.store().memberships.size, events: w.store().events.length, outbox: w.store().outbox.length, journal: w.store().journal.size });
  await assert.rejects(crashing.CMD001.execute(envelope(CREATE_AGENCY, subject("crash"), { key: KEY, body: { displayName: "Crash Co" } })), (e) => e === boom);
  assert.deepEqual({ agencies: w.store().agencies.size, memberships: w.store().memberships.size, events: w.store().events.length, outbox: w.store().outbox.length, journal: w.store().journal.size }, before);
  // the same key afterwards proceeds as a first request (the reservation was rolled back with everything else)
  const r = completed(await h.CMD001.execute(envelope(CREATE_AGENCY, subject("crash"), { key: KEY, body: { displayName: "Crash Co" } })));
  assert.equal(r.replayed, false);
});

test("a DomainFailure raised by a port after the journal reservation rolls the reservation back and is answered as a problem; an unexpected exception propagates as is", async () => {
  const w = world();
  const failing = createB06Handlers(w.runtime, collaborators(w, { activeWork: { inspectClient: async () => { throw new DomainFailure("CAPACITY_UNAVAILABLE", "lock timeout", {}, true); } } }));
  const r = await failing.CMD010.execute(envelope(ARCHIVE_CLIENT, w.owner, { key: KEY, agencyId: w.agencyId, path: { clientId: w.clientId }, body: { expectedVersion: 1 } }));
  assert.equal(r.kind, "UNAVAILABLE");
  assert.equal(problem(r).retryable, true);
  assert.deepEqual(problem(r).nextActions.map((a) => a.action), ["RETRY_SAME_KEY"]);
  assert.equal(w.store().journal.size, 0);
  const throwing = createB06Handlers(w.runtime, collaborators(w, { activeWork: { inspectClient: async () => { throw new TypeError("not a failure"); } } }));
  await assert.rejects(throwing.CMD010.execute(envelope(ARCHIVE_CLIENT, w.owner, { key: KEY, agencyId: w.agencyId, path: { clientId: w.clientId }, body: { expectedVersion: 1 } })), TypeError);
  assert.equal(w.store().endClients.get(w.clientId)?.state, "ACTIVE");
});

test("a tenant command without an agency selector is refused before any unit of work opens", async () => {
  const w = world();
  const h = createB06Handlers(w.runtime, collaborators(w));
  const r = problem(await h.CMD010.execute({ ...envelope(ARCHIVE_CLIENT, w.owner, { key: KEY, agencyId: w.agencyId, path: { clientId: w.clientId }, body: { expectedVersion: 1 } }), agencyId: null }));
  assert.equal(r.code, "INVALID_REQUEST");
  assert.equal(r.reason, "TENANT_CONTEXT_MISSING");
  const asAgency = w.otherAgencyId as AgencyId;
  // selecting another agency where the caller has no membership: NOT_FOUND, and the client of the caller's own agency is invisible there
  const foreign = problem(await h.CMD010.execute(envelope(ARCHIVE_CLIENT, w.owner, { key: KEY, agencyId: asAgency, path: { clientId: w.clientId }, body: { expectedVersion: 1 } })));
  assert.equal(foreign.code, "NOT_FOUND");
  assert.equal(w.store().plans.get(w.planId as PlanId)?.state, "VALIDATED");
});
