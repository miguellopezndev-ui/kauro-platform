// CMD015 CancelUpload — POST /api/v1/uploads/{uploadId}/cancel — AGENCY_OPERATOR (registry cases CMD015-OK / -DENY / -RACE;
// docs/design/B07-upload-source-lifecycle.md §11 CMD015, D-ROLE-3, D-SRC-2, D-UP-2, D-UP-3, D-ANCH-2, D-INTAKE-1, D-LOCK-1, D-LOCK-2).
// The real route and composition root over PostgreSQL 17. The handler writes no provider-cancellation column: the database requests
// the provider cancellation with the tombstone of an issued session, and the control plane's STORAGE_LIFECYCLE (mandate
// B07-CONTROL) cancels it and records the provider's answer. The resumable session comes from the labelled storage and vault fakes
// of @kauro/application/testing (SIMULATED). Interleavings by hold points and pg_stat_activity; UPLOAD_INSPECTION's decision unit
// of work is held open as a control-plane transaction bound to the agency (source-support heldAdmission).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { CancelUploadView, ProtectedSessionView } from "@kauro/application";
import { asProblem, call, completed, freshKey, outcome, replayTextOf, waitForApiLockWait, world, type Reply, type World } from "./support.js";
import { LOCKS, activate, complete, csvContent, exactInstant, heldAdmission, reserve, reserved, sessionUrlOf, setSessionLimit, sourceRoutes, uploadAndAdmit, uploadThrough } from "./source-support.js";
import { reachedHold } from "./writers.js";

let w: World;
before(async () => {
  w = await world();
  await activate(w);
  await activate(w, w.B);
  await setSessionLimit(w, w.A, 16);
});
after(async () => {
  await w.stop();
});

function cancel(uploadId: string, expectedVersion: number, options: { readonly key?: string; readonly person?: typeof w.operator; readonly agency?: string } = {}): Promise<Reply> {
  return call(w, {
    url: sourceRoutes.cancelUpload(uploadId),
    token: (options.person ?? w.operator).token,
    ...(options.agency !== undefined ? { agency: options.agency } : {}),
    key: options.key ?? freshKey("cmd015"),
    body: { expectedVersion },
  });
}

async function ledgers(revisionId: string): Promise<{ readonly bytes: number; readonly files: number; readonly sessions: number }> {
  const quota = await w.row<{ reserved_bytes: string; file_count: number }>("revision_quota", "revision_id = $1", [revisionId]);
  const capacity = await w.row<{ active_sessions: number }>("upload_capacity", "agency_id = $1", [w.A.agencyId]);
  return { bytes: Number(quota?.reserved_bytes ?? 0), files: Number(quota?.file_count ?? 0), sessions: Number(capacity?.active_sessions ?? 0) };
}

async function uploadRow(uploadId: string) {
  const row = await w.row<{ state: string; version: string; terminal_reason: string | null; cancelled_by_membership_id: string | null; provider_cancellation_state: string }>("upload_sessions", "upload_id = $1", [uploadId]);
  assert.ok(row);
  return { state: row.state, version: Number(row.version), terminalReason: row.terminal_reason, cancelledBy: row.cancelled_by_membership_id, providerCancellation: row.provider_cancellation_state };
}

test("OK: the requester cancels an UPLOADING upload — CANCELLED, quota and slot released once, provider cancellation REQUESTED, the INTAKE_CANCELLED anchor; the revision stays UPLOADING", async () => {
  const { revisionId } = await w.project(w.A, w.clientA);
  const kept = await reserved(w, revisionId, 1, { bytes: 1_500_000 });
  const r = await reserved(w, revisionId, 2, { bytes: 2_500_000 });
  const uploadId = r.data.upload.uploadId;
  const before = await ledgers(revisionId);
  assert.deepEqual([before.bytes, before.files], [4_000_000, 2]);

  const key = freshKey("cmd015-ok");
  const body = completed<CancelUploadView>(await cancel(uploadId, 2, { key }), 200);
  assert.equal(body.replayed, false);
  assert.deepEqual([body.version, body.data.upload.state, body.data.upload.version, body.data.upload.terminalReason, body.data.upload.providerCancellationState, body.data.releasedBytes], [3, "CANCELLED", 3, "CANCELLED_BY_REQUESTER", "REQUESTED", 2_500_000]);
  assert.deepEqual(body.data.upload.permittedActions, []);
  // the revision stays UPLOADING: only the agency's selection closes the intake (D-INTAKE-1)
  assert.deepEqual(body.data.revision, { revisionId, version: 2, state: "UPLOADING" });
  assert.equal((await w.row<{ state: string; version: string }>("dataset_revisions", "revision_id = $1", [revisionId]))?.state, "UPLOADING");

  // the tombstone: CANCELLED by the requester's membership; the provider cancellation REQUESTED by the database in the same update
  // at the tombstone's instant (D-ROLE-3; the handler holds no grant on it); the INTAKE_CANCELLED anchor at that same instant
  assert.deepEqual(await uploadRow(uploadId), { state: "CANCELLED", version: 3, terminalReason: "CANCELLED_BY_REQUESTER", cancelledBy: w.memberships.operator, providerCancellation: "REQUESTED" });
  const cancelledAt = await exactInstant(w, "SELECT cancelled_at FROM kauro.upload_sessions WHERE upload_id = $1", [uploadId]);
  assert.equal(await exactInstant(w, "SELECT provider_cancellation_at FROM kauro.upload_sessions WHERE upload_id = $1", [uploadId]), cancelledAt);
  assert.equal(await exactInstant(w, "SELECT occurred_at FROM kauro.retention_anchors WHERE upload_id = $1 AND anchor_kind = 'INTAKE_CANCELLED'", [uploadId]), cancelledAt);
  assert.equal(await w.count("retention_anchors", "upload_id = $1 AND anchor_kind = 'INTAKE_CANCELLED'", [uploadId]), 1);
  // the quota: its bytes, its file and its slot released exactly once by the ledger trigger
  assert.deepEqual(await ledgers(revisionId), { bytes: 1_500_000, files: 1, sessions: before.sessions - 1 });
  // one event, to STORAGE_LIFECYCLE (the provider session, the quarantine objects) and AUTHORITY_JOURNAL (the tombstone)
  const event = (await w.events("upload_session", uploadId)).at(-1);
  assert.deepEqual(event?.payload, { uploadId, agencyId: w.A.agencyId, revisionId, cancelledByMembershipId: w.memberships.operator, reasonCode: "CANCELLED_BY_REQUESTER", providerCancellationState: "REQUESTED", releasedBytes: 2_500_000 });
  assert.deepEqual([event?.version, event?.type], [3, "upload_session.cancelled.v1"]);
  assert.deepEqual(await w.outbox(event?.eventId as string), ["AUTHORITY_JOURNAL", "STORAGE_LIFECYCLE"]);
  const journal = await w.journal(key);
  assert.deepEqual(journal && [journal.state, journal.status, journal.resourceKind, journal.resourceId], ["COMMITTED", 200, "upload_session", uploadId]);
  // the bearer session is no longer delivered to anyone, its requester included
  const session = await call(w, { method: "GET", url: sourceRoutes.uploadSession(uploadId), token: w.operator.token, key: null, contentType: null });
  assert.deepEqual(session.json<{ data: ProtectedSessionView }>().data, { delivery: "UNAVAILABLE", unavailableReason: "SESSION_NOT_ACTIVE" });
  // released once: the freed bytes are counted once more by nobody — a second cancellation is refused and changes no ledger
  assert.equal(outcome(w, await cancel(uploadId, 3)), "409 PRECONDITION_FAILED UPLOAD_TERMINAL");
  assert.deepEqual(await ledgers(revisionId), { bytes: 1_500_000, files: 1, sessions: before.sessions - 1 });

  // a reservation whose session was never issued: its cancellation requests nothing of the provider (NOT_REQUESTED)
  w.storage.failNext("createResumableSession", { code: "UNAVAILABLE" });
  const pendingKey = freshKey("cmd015-ok-pending");
  assert.equal(outcome(w, await reserve(w, revisionId, 2, { key: pendingKey })), "503 CAPACITY_UNAVAILABLE SESSION_ISSUE_FAILED");
  const pendingId = (await w.journal(pendingKey))?.resourceId as string;
  const unissued = completed<CancelUploadView>(await cancel(pendingId, 1), 200);
  assert.deepEqual([unissued.data.upload.state, unissued.data.upload.providerCancellationState], ["CANCELLED", "NOT_REQUESTED"]);
  assert.equal(kept.data.upload.state, "UPLOADING");
});

test("DENY: another member → 403 UPLOAD_NOT_OWNED; ADMITTED → 409 UPLOAD_ADMITTED; already cancelled → 409 UPLOAD_TERMINAL; foreign → 404", async () => {
  const { revisionId } = await w.project(w.A, w.clientA);
  const theirs = await reserved(w, revisionId, 1);
  const admitted = await uploadAndAdmit(w, revisionId, 2);
  const admittedVersion = (await uploadRow(admitted.uploadId)).version;
  const done = await reserved(w, revisionId, 2);
  completed<CancelUploadView>(await cancel(done.data.upload.uploadId, 2), 200);
  // an upload of agency B (ACTIVE): its owner's own reservation
  const foreignProject = await w.project(w.B, w.clientB);
  const foreign = await reserved(w, foreignProject.revisionId, 1, { person: w.stranger, agency: w.B.agencyId });

  const snapshots = async () => Promise.all([theirs.data.upload.uploadId, admitted.uploadId, done.data.upload.uploadId, foreign.data.upload.uploadId].map((id) => uploadRow(id)));
  const before = await snapshots();
  const eventsBefore = await w.count("domain_events", "event_type = 'upload_session.cancelled.v1'");
  const denialsBefore = (await w.securityEvents("CMD015")).length;

  // another member of the agency, with an operating role: the requester only (D-SRC-2), a durable DENY fact
  assert.equal(outcome(w, await cancel(theirs.data.upload.uploadId, 2, { person: w.admin })), "403 NOT_AUTHORIZED UPLOAD_NOT_OWNED");
  // ADMITTED: its file leaves by an exclusion or a new revision, not by cancellation
  const admittedReply = await cancel(admitted.uploadId, admittedVersion);
  assert.equal(outcome(w, admittedReply), "409 PRECONDITION_FAILED UPLOAD_ADMITTED");
  assert.deepEqual(asProblem(w, admittedReply).current, { version: admittedVersion, state: "ADMITTED" });
  // already tombstoned
  const terminal = await cancel(done.data.upload.uploadId, 3);
  assert.equal(outcome(w, terminal), "409 PRECONDITION_FAILED UPLOAD_TERMINAL");
  assert.deepEqual(asProblem(w, terminal).current, { version: 3, state: "CANCELLED" });
  // another agency's upload and an upload that does not exist answer alike
  assert.equal(outcome(w, await cancel(foreign.data.upload.uploadId, 2)), "404 NOT_FOUND -");
  assert.equal(outcome(w, await cancel("0190c7a2-0000-7000-8000-00000000c015", 1)), "404 NOT_FOUND -");

  // nothing changed: no upload moved, no cancellation event; the refused requester is a fact of the agency's stream
  assert.deepEqual(await snapshots(), before);
  assert.equal(await w.count("domain_events", "event_type = 'upload_session.cancelled.v1'"), eventsBefore);
  assert.deepEqual((await w.securityEvents("CMD015")).slice(denialsBefore).map((f) => [f.outcome, f.reason, f.actorId, f.agencyId]), [["DENY", "UPLOAD_NOT_OWNED", w.admin.userId, w.A.agencyId]]);
});

test("RACE: two cancels on one version → one 200, one 409 STALE_VERSION; identical retry replays; the same key with another version → 409; a cancellation committed while UPLOAD_INSPECTION holds the revision row waits and then finds the upload settled", async () => {
  const { revisionId } = await w.project(w.A, w.clientA);
  const r = await reserved(w, revisionId, 1);
  const uploadId = r.data.upload.uploadId;
  const before = await ledgers(revisionId);

  // two cancellations of version 2: the first held before its journal commit (revision row and upload locked, CANCELLED written),
  // the second observed waiting on the revision row; the first commits, the second reads version 3: STALE_VERSION
  const keyA = freshKey("cmd015-race-a");
  const hold = w.holds.arm("journal.commit");
  const a = cancel(uploadId, 2, { key: keyA });
  let b: Promise<Reply> | undefined;
  try {
    await reachedHold(hold, a);
    b = cancel(uploadId, 2, { key: freshKey("cmd015-race-b") });
    await waitForApiLockWait(w, LOCKS.revision);
  } finally {
    hold.release();
  }
  const [first, second] = await Promise.all([a, b as Promise<Reply>]);
  assert.equal(completed<CancelUploadView>(first, 200).data.upload.state, "CANCELLED");
  assert.equal(outcome(w, second), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, second).current, { version: 3, state: "CANCELLED" });
  assert.equal(await w.count("domain_events", "aggregate_id = $1 AND event_type = 'upload_session.cancelled.v1'", [uploadId]), 1, "one cancellation event");
  const after = await ledgers(revisionId);
  assert.deepEqual([after.bytes, after.files, after.sessions], [before.bytes - 1_000_000, before.files - 1, before.sessions - 1], "released once");

  // identical retry: the journaled 200, byte for byte; the same key with another version: a typed conflict, no effect
  const replay = await cancel(uploadId, 2, { key: keyA });
  assert.equal(replay.status, 200);
  assert.equal(replay.text, replayTextOf(first));
  assert.equal(outcome(w, await cancel(uploadId, 3, { key: keyA })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.deepEqual(await ledgers(revisionId), after);

  // UPLOAD_INSPECTION holds the revision row: its decision unit of work (the receipt, the file, ADMITTED) is written and held
  // uncommitted by the control plane; the requester's cancellation is observed waiting on the revision row — never the upload row
  // first (D-LOCK-2, no deadlock) — and, once the admission commits, it finds the upload settled: the version it named is gone and
  // the current one is ADMITTED (409 STALE_VERSION with current), nothing cancelled
  const content = csvContent(3, "cmd015-race-inspection");
  const v = await reserved(w, revisionId, 2, { bytes: content.byteLength });
  const finalized = uploadThrough(w, sessionUrlOf(v), content);
  assert.equal((await complete(w, v.data.upload.uploadId, finalized.completionRef)).status, 202);
  const verifyingVersion = (await uploadRow(v.data.upload.uploadId)).version;
  const { writer, admitted } = await heldAdmission(w, w.A, v.data.upload.uploadId, finalized);
  let waiting: Promise<Reply> | undefined;
  try {
    // the claim and the observation committed (version + 1); the decision is the held transaction's
    waiting = cancel(v.data.upload.uploadId, verifyingVersion + 1);
    await waitForApiLockWait(w, LOCKS.revision);
    await writer.commit();
  } finally {
    await writer.close();
  }
  const settled = await (waiting as Promise<Reply>);
  assert.equal(outcome(w, settled), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, settled).current, { version: verifyingVersion + 2, state: "ADMITTED" });
  // a cancellation of the version it now reads is refused for what the upload is: admitted
  assert.equal(outcome(w, await cancel(v.data.upload.uploadId, verifyingVersion + 2)), "409 PRECONDITION_FAILED UPLOAD_ADMITTED");
  const row = await uploadRow(v.data.upload.uploadId);
  assert.deepEqual([row.state, row.terminalReason], ["ADMITTED", null]);
  assert.equal((await w.row<{ state: string }>("source_files", "file_id = $1", [admitted.fileId]))?.state, "ADMITTED");
  assert.equal(await w.count("domain_events", "aggregate_id = $1 AND event_type = 'upload_session.cancelled.v1'", [v.data.upload.uploadId]), 0);
});
