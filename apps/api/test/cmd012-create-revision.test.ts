// CMD012 CreateRevision — POST /api/v1/projects/{projectId}/revisions — AGENCY_OPERATOR (registry cases CMD012-OK / -DENY / -RACE;
// docs/design/B07-upload-source-lifecycle.md §11 CMD012, D-REV-1, D-REV-2, D-ROLE-3, D-ANCH-2, D-PERS-7, D-LOCK-1). The real route
// and composition root over PostgreSQL 17: the sealed predecessor is sealed through the product's own routes (ReserveUpload,
// CompleteUpload, the selection intake, SelectInputTables, SealRevision) with the control plane's writes between them
// (source-support.ts); the provider session comes from the labelled storage and vault fakes of @kauro/application/testing
// (SIMULATED). Interleavings by hold points and pg_stat_activity, never time.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { CreateRevisionView } from "@kauro/application";
import {
  SimulatedCrash,
  approvalBodyOf,
  approveThroughRoute,
  asProblem,
  call,
  completed,
  freshKey,
  outcome,
  replayTextOf,
  rootCause,
  routes,
  waitForApiLockWait,
  world,
  type World,
} from "./support.js";
import { LOCKS, activate, complete, createRevision, exactInstant, projectPointer, reserved, sealedThroughRoutes, sessionUrlOf, setSessionLimit, uploadAndAdmit, uploadThrough, csvContent } from "./source-support.js";
import { reachedHold } from "./writers.js";

let w: World;
before(async () => {
  w = await world();
  await activate(w);
  // room for the sessions every test of the file leaves in flight (an operations change of the limit, D-UP-3)
  await setSessionLimit(w, w.A, 16);
});
after(async () => {
  await w.stop();
});

/** The rows a CreateRevision could write, counted across every tenant (superuser oracle). */
async function sourceEffects(): Promise<Record<string, number>> {
  const r = await w.h.oracle.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM kauro.dataset_revisions)::text AS revisions, (SELECT count(*) FROM kauro.domain_events)::text AS events,
            (SELECT count(*) FROM kauro.outbox_records)::text AS outbox, (SELECT count(*) FROM kauro.command_journal WHERE operation = 'CMD012')::text AS journal,
            (SELECT count(*) FROM kauro.upload_sessions WHERE state = 'CANCELLED')::text AS cancelled, (SELECT coalesce(sum(version), 0) FROM kauro.projects)::text AS project_versions`,
  );
  const row = r.rows[0];
  assert.ok(row);
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
}

test("OK: an OPERATOR replaces the project's SEALED revision — the predecessor SUPERSEDED with its manifest, files and record intact, a DRAFT successor naming it, the project pointer moved, the impact map naming the plans and approvals bound to the old manifest", async () => {
  const sealed = await sealedThroughRoutes(w);
  const { projectId, revisionId: predecessorId, manifestHash } = sealed;
  // authority bound to the old manifest: an approved plan with its live approval, and a plan still in validation
  const target = await w.targetContract(w.A, projectId);
  const approvedPlan = await w.plan(w.A, projectId, { revisionHash: manifestHash as never, targetContractHash: target.targetContractHash, seed: "cmd012-ok-approved" });
  const approval = await approveThroughRoute(w, approvedPlan);
  const pendingPlan = await w.plan(w.A, projectId, { revisionHash: manifestHash as never, targetContractHash: target.targetContractHash, seed: "cmd012-ok-pending", state: "VALIDATION_REQUIRED" });
  // the predecessor's sealed facts before the replacement (superuser oracle)
  const facts = async () => ({
    manifest: await w.row("sealed_manifests", "revision_id = $1", [predecessorId]),
    files: (await w.h.oracle.query("SELECT * FROM kauro.sealed_revision_files WHERE revision_id = $1 ORDER BY ordinal", [predecessorId])).rows,
    record: await w.row("retention_records", "revision_id = $1", [predecessorId]),
    anchors: (await w.h.oracle.query("SELECT * FROM kauro.retention_anchors WHERE revision_id = $1 ORDER BY occurred_at, anchor_id", [predecessorId])).rows,
    file: await w.row("source_files", "file_id = $1", [sealed.file.fileId]),
  });
  const before = await facts();
  assert.equal((before.record as { state: string } | null)?.state, "ACTIVE");
  assert.deepEqual(await projectPointer(w, projectId), { version: 1, currentRevisionId: predecessorId });

  const key = freshKey("cmd012-ok-sealed");
  const reply = await createRevision(w, projectId, 1, predecessorId, { key });
  const body = completed<CreateRevisionView>(reply, 201);
  assert.equal(body.replayed, false);
  const successorId = body.data.revision.revisionId;
  // the DRAFT successor naming its predecessor, version 1, the envelope's version its own
  assert.deepEqual([body.version, body.data.revision.version, body.data.revision.state, body.data.revision.supersedesRevisionId, body.data.revision.projectId], [1, 1, "DRAFT", predecessorId, projectId]);
  assert.deepEqual(body.data.revision.permittedActions, ["CreateRevision", "ReserveUpload", "SelectInputTables"]);
  assert.equal(body.data.revision.seal, undefined, "the successor has no manifest: nothing can be bound to it yet");
  // the predecessor SUPERSEDED (new_revision_explicitly_supersedes) naming the successor; the project pointer moved
  assert.deepEqual(body.data.predecessor, { revisionId: predecessorId, version: sealed.sealedVersion + 1, state: "SUPERSEDED" });
  assert.deepEqual(body.data.project, { projectId, version: 2, currentRevisionId: successorId });
  assert.deepEqual(await projectPointer(w, projectId), { version: 2, currentRevisionId: successorId });
  const predecessor = await w.row<{ state: string; version: string; superseded_by_revision_id: string; manifest_hash: string }>("dataset_revisions", "revision_id = $1", [predecessorId]);
  assert.deepEqual(predecessor && [predecessor.state, Number(predecessor.version), predecessor.superseded_by_revision_id, predecessor.manifest_hash], ["SUPERSEDED", sealed.sealedVersion + 1, successorId, manifestHash]);
  const successor = await w.row<{ state: string; version: string; supersedes_revision_id: string; manifest_hash: string | null; created_by_membership_id: string }>("dataset_revisions", "revision_id = $1", [successorId]);
  assert.deepEqual(successor && [successor.state, Number(successor.version), successor.supersedes_revision_id, successor.manifest_hash, successor.created_by_membership_id], ["DRAFT", 1, predecessorId, null, w.memberships.operator]);
  // the supersession instant is the server's (D-CLOCK-1)
  const supersededAt = await exactInstant(w, "SELECT superseded_at FROM kauro.dataset_revisions WHERE revision_id = $1", [predecessorId]);
  assert.ok(supersededAt > (await exactInstant(w, "SELECT sealed_at FROM kauro.dataset_revisions WHERE revision_id = $1", [predecessorId])));

  // the sealed manifest, the file set, the UNPAID record and the anchors of the predecessor are exactly as they were (history)
  assert.deepEqual(await facts(), before);

  // the impact map: the plans bound to the old manifest and their live approval, identified — never transferred
  assert.deepEqual(body.data.invalidated, { planIds: [approvedPlan.planId, pendingPlan.planId], approvalIds: [approval.data.approval.approvalId], commercialAuthorizationIds: [] });
  assert.equal(await w.count("plans", "revision_hash = $1", [manifestHash]), 2, "the plans still name the old manifest");
  assert.equal(await w.count("approvals", "revision_hash = $1 AND withdrawn_at IS NULL", [manifestHash]), 1);

  // one event per new version, in the agency's stream, fanned out to its consumers
  const superseded = (await w.events("dataset_revision", predecessorId)).at(-1);
  assert.equal(superseded?.type, "dataset_revision.superseded.v1");
  assert.deepEqual(superseded?.payload, {
    revisionId: predecessorId,
    agencyId: w.A.agencyId,
    projectId,
    successorRevisionId: successorId,
    manifestHash,
    affectedPlanIds: [approvedPlan.planId, pendingPlan.planId],
    affectedApprovalIds: [approval.data.approval.approvalId],
    affectedCommercialAuthorizationIds: [],
  });
  assert.deepEqual(await w.outbox(superseded?.eventId as string), ["AUTHORITY_JOURNAL", "EXECUTION_CONTROL"]);
  assert.deepEqual((await w.events("dataset_revision", successorId)).map((e) => [e.version, e.type, e.payload["supersedesRevisionId"]]), [[1, "dataset_revision.created.v1", predecessorId]]);
  assert.deepEqual((await w.events("project", projectId)).map((e) => [e.version, e.type]).at(-1), [2, "project.current_revision_changed.v1"]);
  assert.deepEqual((await w.events("project", projectId)).at(-1)?.payload, { projectId, agencyId: w.A.agencyId, currentRevisionId: successorId, previousRevisionId: predecessorId, changedByMembershipId: w.memberships.operator });
  // the journal row of the operation
  const journal = await w.journal(key);
  assert.deepEqual(journal && [journal.state, journal.status, journal.resourceKind, journal.resourceId], ["COMMITTED", 201, "dataset_revision", successorId]);
});

test("OK: replacing a mutable revision cancels it with its uploads in flight, their INTAKE_CANCELLED anchors, and releases their quota", async () => {
  const { projectId, revisionId: predecessorId } = await w.project(w.A, w.clientA);
  // one admitted file (not in flight), one upload UPLOADING and one VERIFYING (its completion reported): the revision UPLOADING
  const admitted = await uploadAndAdmit(w, predecessorId, 1);
  const uploading = await reserved(w, predecessorId, 2, { bytes: 3_000_000 });
  const verifyingContent = csvContent(4, "verifying");
  const verifying = await reserved(w, predecessorId, 2, { bytes: verifyingContent.byteLength });
  const finalized = uploadThrough(w, sessionUrlOf(verifying), verifyingContent);
  assert.equal((await complete(w, verifying.data.upload.uploadId, finalized.completionRef)).status, 202);
  const inFlight = [uploading.data.upload.uploadId, verifying.data.upload.uploadId];
  const slotsBefore = Number((await w.row<{ active_sessions: string }>("upload_capacity", "agency_id = $1", [w.A.agencyId]))?.active_sessions);
  const quotaBefore = await w.row<{ reserved_bytes: string; file_count: number }>("revision_quota", "revision_id = $1", [predecessorId]);
  assert.deepEqual(quotaBefore && [Number(quotaBefore.reserved_bytes), quotaBefore.file_count], [admitted.bytes + 3_000_000 + verifyingContent.byteLength, 3]);

  const body = completed<CreateRevisionView>(await createRevision(w, projectId, 1, predecessorId), 201);
  const successorId = body.data.revision.revisionId;
  assert.deepEqual(body.data.predecessor, { revisionId: predecessorId, version: 3, state: "CANCELLED" });
  assert.deepEqual([...body.data.cancelledUploadIds].sort(), [...inFlight].sort());
  assert.deepEqual(body.data.invalidated, { planIds: [], approvalIds: [], commercialAuthorizationIds: [] });
  assert.deepEqual([body.data.revision.state, body.data.revision.supersedesRevisionId], ["DRAFT", predecessorId]);
  // the predecessor CANCELLED (cancel_revision) naming its successor (D-PERS-7), at the server's instant
  const predecessor = await w.row<{ state: string; terminal_reason: string; superseded_by_revision_id: string }>("dataset_revisions", "revision_id = $1", [predecessorId]);
  assert.deepEqual(predecessor && [predecessor.state, predecessor.terminal_reason, predecessor.superseded_by_revision_id], ["CANCELLED", "REPLACED_BY_NEW_REVISION", successorId]);
  const cancelledEvent = (await w.events("dataset_revision", predecessorId)).at(-1);
  assert.equal(cancelledEvent?.type, "dataset_revision.cancelled.v1");
  assert.deepEqual([cancelledEvent?.payload["previousState"], cancelledEvent?.payload["reasonCode"], cancelledEvent?.payload["successorRevisionId"]], ["UPLOADING", "REPLACED_BY_NEW_REVISION", successorId]);
  // every upload in flight tombstoned: CANCELLED REVISION_REPLACED by the acting membership, the provider cancellation REQUESTED by
  // the database with the tombstone of an issued session (D-ROLE-3), its INTAKE_CANCELLED anchor at the tombstone's instant
  for (const uploadId of inFlight) {
    const u = await w.row<{ state: string; terminal_reason: string; cancelled_by_membership_id: string; provider_cancellation_state: string }>("upload_sessions", "upload_id = $1", [uploadId]);
    assert.deepEqual(u && [u.state, u.terminal_reason, u.cancelled_by_membership_id, u.provider_cancellation_state], ["CANCELLED", "REVISION_REPLACED", w.memberships.operator, "REQUESTED"]);
    const cancelledAt = await exactInstant(w, "SELECT cancelled_at FROM kauro.upload_sessions WHERE upload_id = $1", [uploadId]);
    assert.equal(await exactInstant(w, "SELECT provider_cancellation_at FROM kauro.upload_sessions WHERE upload_id = $1", [uploadId]), cancelledAt);
    assert.equal(await w.count("retention_anchors", "upload_id = $1 AND anchor_kind = 'INTAKE_CANCELLED'", [uploadId]), 1);
    assert.equal(await exactInstant(w, "SELECT occurred_at FROM kauro.retention_anchors WHERE upload_id = $1 AND anchor_kind = 'INTAKE_CANCELLED'", [uploadId]), cancelledAt);
    const event = (await w.events("upload_session", uploadId)).at(-1);
    assert.deepEqual([event?.type, event?.payload["reasonCode"], event?.payload["providerCancellationState"]], ["upload_session.cancelled.v1", "REVISION_REPLACED", "REQUESTED"]);
    assert.deepEqual(await w.outbox(event?.eventId as string), ["AUTHORITY_JOURNAL", "STORAGE_LIFECYCLE"]);
  }
  // the admitted upload was not in flight: it stays ADMITTED with its file
  assert.equal((await w.row<{ state: string }>("upload_sessions", "upload_id = $1", [admitted.uploadId]))?.state, "ADMITTED");
  // the quota: the ledger holds only what the admitted upload holds; the agency's two slots released, exactly once
  const quotaAfter = await w.row<{ reserved_bytes: string; file_count: number }>("revision_quota", "revision_id = $1", [predecessorId]);
  assert.deepEqual(quotaAfter && [Number(quotaAfter.reserved_bytes), quotaAfter.file_count], [admitted.bytes, 1]);
  assert.equal(Number((await w.row<{ active_sessions: string }>("upload_capacity", "agency_id = $1", [w.A.agencyId]))?.active_sessions), slotsBefore - 2);
  assert.deepEqual(await projectPointer(w, projectId), { version: 2, currentRevisionId: successorId });
});

test("DENY: VIEWER → 403 ROLE_INSUFFICIENT; foreign project → 404; stale project version → 409 STALE_VERSION; a predecessor of another project → 400 UNKNOWN_REFERENCE; not the current revision → 409 PREDECESSOR_NOT_CURRENT; nothing committed", async () => {
  const { projectId, revisionId } = await w.project(w.A, w.clientA);
  const other = await w.project(w.A, w.clientA);
  const foreign = await w.project(w.B, w.clientB);
  // a project whose first revision was already replaced: that revision is no longer the current one
  const replaced = await w.project(w.A, w.clientA);
  const successor = completed<CreateRevisionView>(await createRevision(w, replaced.projectId, 1, replaced.revisionId), 201).data.revision.revisionId;

  const effectsBefore = await sourceEffects();
  const denialsBefore = (await w.securityEvents("CMD012")).length;
  assert.equal(outcome(w, await createRevision(w, projectId, 1, revisionId, { person: w.viewer })), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.equal(outcome(w, await createRevision(w, foreign.projectId, 1, foreign.revisionId)), "404 NOT_FOUND -");
  const stale = await createRevision(w, projectId, 7, revisionId);
  assert.equal(outcome(w, stale), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, stale).current, { version: 1, state: "OPEN" });
  const unknown = await createRevision(w, projectId, 1, other.revisionId);
  assert.equal(outcome(w, unknown), "400 INVALID_REQUEST UNKNOWN_REFERENCE");
  assert.deepEqual(asProblem(w, unknown).errors, [{ field: "supersedesRevisionId", code: "UNKNOWN_REFERENCE" }]);
  const notCurrent = await createRevision(w, replaced.projectId, 2, replaced.revisionId);
  assert.equal(outcome(w, notCurrent), "409 PRECONDITION_FAILED PREDECESSOR_NOT_CURRENT");
  assert.deepEqual(asProblem(w, notCurrent).current, { version: 2, state: "CANCELLED", successorId: successor });

  // nothing committed: no revision, event, outbox row, journal row, cancellation or project version; the refusals of access are
  // durable DENY facts of the agency's stream (D-FACT-1)
  assert.deepEqual(await sourceEffects(), effectsBefore);
  const denials = (await w.securityEvents("CMD012")).slice(denialsBefore);
  assert.deepEqual(denials.map((d) => [d.outcome, d.reason, d.actorId]), [["DENY", "ROLE_INSUFFICIENT", w.viewer.userId]]);
  for (const p of [projectId, other.projectId]) assert.equal((await projectPointer(w, p)).version, 1);
});

test("DENY: after the replacement, ApprovePlan of a plan bound to the superseded source is 422 SOURCE_EXPIRED and no plan, receipt or approval names the new revision", async () => {
  const sealed = await sealedThroughRoutes(w);
  const target = await w.targetContract(w.A, sealed.projectId);
  const plan = await w.plan(w.A, sealed.projectId, { revisionHash: sealed.manifestHash as never, targetContractHash: target.targetContractHash, seed: "cmd012-deny-approval" });
  const body = completed<CreateRevisionView>(await createRevision(w, sealed.projectId, 1, sealed.revisionId), 201);
  const successorId = body.data.revision.revisionId;
  assert.deepEqual(body.data.invalidated.planIds, [plan.planId]);

  // CMD025 refuses an approval over a source that is not SEALED: the old authority does not carry onto the changed bytes
  const proof = await w.stepUp(w.approver);
  const approvalsBefore = await w.count("approvals");
  const refused = await call(w, { url: routes.approvePlan(plan.planId), token: w.approver.token, key: freshKey("cmd012-deny-approve"), body: approvalBodyOf(plan, proof) });
  assert.equal(outcome(w, refused), "422 SOURCE_EXPIRED -");
  assert.equal(await w.count("approvals"), approvalsBefore);
  assert.equal((await w.row<{ state: string }>("plans", "plan_id = $1", [plan.planId]))?.state, "VALIDATED");

  // the new revision has no manifest, so nothing can name it: every plan, receipt and approval of the project names the old
  // manifest (FK plans_source_fk), and the successor is still an empty DRAFT
  const successor = await w.row<{ state: string; manifest_hash: string | null }>("dataset_revisions", "revision_id = $1", [successorId]);
  assert.deepEqual(successor && [successor.state, successor.manifest_hash], ["DRAFT", null]);
  assert.equal(await w.count("plans", "project_id = $1 AND revision_hash IS DISTINCT FROM $2", [sealed.projectId, sealed.manifestHash]), 0);
  assert.equal(await w.count("validation_receipts", "plan_id IN (SELECT plan_id FROM kauro.plans WHERE project_id = $1) AND revision_hash IS DISTINCT FROM $2", [sealed.projectId, sealed.manifestHash]), 0);
  assert.equal(await w.count("approvals", "plan_id IN (SELECT plan_id FROM kauro.plans WHERE project_id = $1)", [sealed.projectId]), 0);
  assert.equal(await w.count("upload_sessions", "revision_id = $1", [successorId]), 0);
});

test("RACE: two CreateRevision calls on one project version → one 201, one 409 STALE_VERSION; identical retry replays; the same key with another predecessor → 409 IDEMPOTENCY_CONFLICT; a crash between the inserts commits nothing", async () => {
  const sealed = await sealedThroughRoutes(w);
  const { projectId, revisionId: predecessorId } = sealed;
  // A holds just before its journal commit — its successor, supersession and pointer written, the project row locked — while B,
  // on the same project version, is observed waiting on the project row; A commits, B reads the moved project: STALE_VERSION
  const keyA = freshKey("cmd012-race-a");
  const hold = w.holds.arm("journal.commit");
  const a = createRevision(w, projectId, 1, predecessorId, { key: keyA });
  let b: Promise<Awaited<typeof a>> | undefined;
  try {
    await reachedHold(hold, a);
    b = createRevision(w, projectId, 1, predecessorId, { key: freshKey("cmd012-race-b") });
    await waitForApiLockWait(w, LOCKS.project);
  } finally {
    hold.release();
  }
  const [first, second] = await Promise.all([a, b as Promise<Awaited<typeof a>>]);
  const winner = completed<CreateRevisionView>(first, 201);
  assert.equal(outcome(w, second), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, second).current, { version: 2, state: "OPEN" });
  assert.equal(await w.count("dataset_revisions", "supersedes_revision_id = $1", [predecessorId]), 1, "one successor per predecessor");
  assert.equal(await w.count("dataset_revisions", "project_id = $1 AND state IN ('DRAFT', 'UPLOADING', 'INSPECTING', 'READY_TO_SEAL')", [projectId]), 1, "one mutable revision per project");

  // identical retry: the journaled answer, byte for byte, and no second successor
  const replay = await createRevision(w, projectId, 1, predecessorId, { key: keyA });
  assert.equal(replay.status, 201);
  assert.equal(replay.text, replayTextOf(first));
  // the same key with another predecessor: a typed conflict with no effect
  const conflict = await createRevision(w, projectId, 1, winner.data.revision.revisionId, { key: keyA });
  assert.equal(outcome(w, conflict), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal(await w.count("dataset_revisions", "project_id = $1", [projectId]), 2);
  assert.equal(await w.count("command_journal", "idempotency_key = $1", [keyA]), 1);

  // a crash after every insert (successor, supersession, pointer, events) and before COMMIT: nothing of it exists — one transaction,
  // the successor keys deferred to COMMIT; the same key is then the first execution of the operation
  const fresh = await sealedThroughRoutes(w);
  const crashKey = freshKey("cmd012-crash");
  const revisionsBefore = await w.count("dataset_revisions", "project_id = $1", [fresh.projectId]);
  const eventsBefore = await w.count("domain_events");
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await createRevision(w, fresh.projectId, 1, fresh.revisionId, { key: crashKey });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.equal(rootCause(w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true);
  assert.equal(await w.count("dataset_revisions", "project_id = $1", [fresh.projectId]), revisionsBefore);
  assert.equal(await w.count("domain_events"), eventsBefore);
  assert.deepEqual(await projectPointer(w, fresh.projectId), { version: 1, currentRevisionId: fresh.revisionId });
  const untouched = await w.row<{ state: string; version: string; superseded_by_revision_id: string | null }>("dataset_revisions", "revision_id = $1", [fresh.revisionId]);
  assert.deepEqual(untouched && [untouched.state, Number(untouched.version), untouched.superseded_by_revision_id], ["SEALED", fresh.sealedVersion, null]);
  assert.equal(await w.journal(crashKey), null);
  const retried = completed<CreateRevisionView>(await createRevision(w, fresh.projectId, 1, fresh.revisionId, { key: crashKey }), 201);
  assert.equal(retried.replayed, false);
  assert.equal(await w.count("dataset_revisions", "supersedes_revision_id = $1", [fresh.revisionId]), 1);
});
