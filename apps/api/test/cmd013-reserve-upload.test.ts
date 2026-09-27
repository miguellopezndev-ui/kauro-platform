// CMD013 ReserveUpload — POST /api/v1/revisions/{revisionId}/uploads — AGENCY_OPERATOR (registry cases CMD013-OK / -DENY / -RACE and
// R2-052; docs/design/B07-upload-source-lifecycle.md §11 CMD013, the two-phase runtime D-RUN-2, D-SESSION-1/2/4, D-UP-2, D-UP-3,
// D-CLOCK-1). The real route and composition root over PostgreSQL 17; the provider session and its sealing come from the labelled
// storage and vault fakes of @kauro/application/testing (SIMULATED). Interleavings by hold points and pg_stat_activity, never time;
// the pending intent's grace (30 s) is crossed by moving the api's process clock, never by waiting.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ProtectedSessionView, ReserveUploadView } from "@kauro/application";
import { CONTRACT_FAKE_CHUNK_MULTIPLE_BYTES, CONTRACT_FAKE_SESSION_REF_PREFIX, CONTRACT_FAKE_VAULT_KEY_REF } from "@kauro/application/testing";
import { PENDING_RESUME_GRACE_SECONDS, textDigest, toUtcInstant } from "@kauro/domain";
import { SimulatedCrash, TEST_ORIGIN, call, completed, freshKey, outcome, replayTextOf, waitForApiLockWait, world, type World } from "./support.js";
import { LOCKS, activate, bound, currentOf, exactInstant, inventoryHashOfRoute, manifestOf, quarantineName, reserve, reserveBody, reserved, sessionUrlOf, setSessionLimit, sourceRoutes, uploadAndAdmit } from "./source-support.js";
import { reachedHold } from "./writers.js";

let w: World;
before(async () => {
  w = await world();
  await activate(w);
});
after(async () => {
  await w.stop();
});

async function activeSessions(): Promise<number> {
  const r = await w.h.oracle.query<{ n: string | null }>("SELECT active_sessions::text AS n FROM kauro.upload_capacity WHERE agency_id = $1", [w.A.agencyId]);
  return Number(r.rows[0]?.n ?? "0");
}

/** Room for `more` live sessions beyond the ones the file's earlier tests left open (an operations change of the limit, D-UP-3). */
async function roomFor(more: number): Promise<void> {
  await setSessionLimit(w, w.A, (await activeSessions()) + more);
}

function sessionsFor(objectName: string) {
  return w.storage.calls("createResumableSession").filter((c) => c.request["objectName"] === objectName);
}

test("OK: an OPERATOR reserves 1 MB on a DRAFT revision — RESERVED then UPLOADING with the protected session delivered to the requester only, the revision UPLOADING, the quota and slot held, the deadline exactly 24 h after the initiation anchor at the server instant, the session sealed and never journaled", async () => {
  await roomFor(1);
  const slotsBefore = await activeSessions();
  const { projectId, revisionId } = await w.project(w.A, w.clientA);
  const key = freshKey("cmd013-ok");
  const reply = await reserve(w, revisionId, 1, { key, bytes: 1_000_000 });
  const body = completed<ReserveUploadView>(reply, 201);
  assert.equal(body.replayed, false);
  const { upload, revision, quota } = body.data;
  const session = body.data.session as ProtectedSessionView;
  // RESERVED v1 (the intent) then UPLOADING v2 (the session issued under fence 1): one event per edge
  assert.deepEqual([body.version, upload.version, upload.state, upload.reservedBytes, upload.revisionId, upload.projectId, upload.requestedByMembershipId, upload.declaredFormat], [2, 2, "UPLOADING", 1_000_000, revisionId, projectId, w.memberships.operator, "CSV"]);
  assert.deepEqual(upload.permittedActions, ["CompleteUpload", "CancelUpload"]);
  assert.deepEqual((await w.events("upload_session", upload.uploadId)).map((e) => [e.version, e.type]), [[1, "upload_session.reserved.v1"], [2, "upload_session.session_issued.v1"]]);
  // the revision DRAFT -> UPLOADING (upload_reserved), the quota and the agency's slot held
  assert.deepEqual(revision, { revisionId, version: 2, state: "UPLOADING" });
  assert.deepEqual((await w.events("dataset_revision", revisionId)).map((e) => [e.version, e.type]), [[1, "dataset_revision.created.v1"], [2, "dataset_revision.uploading.v1"]]);
  assert.deepEqual([quota.reservedBytes, quota.fileCount, quota.revisionBytesLimit, quota.revisionFileLimit, quota.fileBytesLimit], [1_000_000, 1, 5_000_000_000, 50, 2_000_000_000]);
  assert.equal(quota.agencyActiveSessions, slotsBefore + 1);
  assert.equal(await activeSessions(), slotsBefore + 1);

  // the protected response: the session of exactly the quarantine name, bound to the origin, to its requester
  assert.equal(session.delivery, "PROTECTED_RESPONSE");
  assert.ok(session.uploadUrl?.startsWith(CONTRACT_FAKE_SESSION_REF_PREFIX));
  assert.deepEqual([session.method, session.chunkMultipleBytes], ["PUT", CONTRACT_FAKE_CHUNK_MULTIPLE_BYTES]);
  const objectName = quarantineName(w.A.agencyId, projectId, revisionId, upload.uploadId);
  const created = sessionsFor(objectName);
  assert.equal(created.length, 1, "one provider session");
  assert.deepEqual([created[0]?.request["declaredBytes"], created[0]?.request["contentType"], created[0]?.request["origin"], created[0]?.request["locationRef"]], [1_000_000, "text/csv", TEST_ORIGIN, "QUARANTINE_PRIMARY"]);
  assert.equal(w.storage.sessionView(session.uploadUrl as string)?.objectName, objectName);

  // the deadline: exactly 86,400 s after the initiation anchor, which is the upload's creation at the server instant (D-CLOCK-1)
  const createdAt = await exactInstant(w, "SELECT created_at FROM kauro.upload_sessions WHERE upload_id = $1", [upload.uploadId]);
  const anchoredAt = await exactInstant(w, "SELECT occurred_at FROM kauro.retention_anchors WHERE upload_id = $1 AND anchor_kind = 'UPLOAD_INITIATED'", [upload.uploadId]);
  const deadline = await exactInstant(w, "SELECT application_expires_at FROM kauro.upload_sessions WHERE upload_id = $1", [upload.uploadId]);
  assert.equal(anchoredAt, createdAt);
  assert.equal(deadline, await exactInstant(w, "SELECT $1::timestamptz + interval '86400 seconds'", [anchoredAt]));
  assert.equal(upload.applicationExpiresAt, toUtcInstant(Date.parse(deadline)));
  assert.equal(session.applicationExpiresAt, upload.applicationExpiresAt);

  // sealed by the vault, bound to agency, upload, requester and attempt; only its digest is on the upload row
  const secret = await w.row<{ key_ref: string; session_attempt: string | number; ciphertext: Buffer; requested_by_user_id: string }>("upload_session_secrets", "upload_id = $1", [upload.uploadId]);
  assert.ok(secret);
  assert.deepEqual([secret.key_ref, Number(secret.session_attempt), secret.requested_by_user_id], [CONTRACT_FAKE_VAULT_KEY_REF, 1, w.operator.userId]);
  assert.ok(!secret.ciphertext.toString("latin1").includes(session.uploadUrl as string), "the reference is sealed");
  const row = await w.row<{ provider_session_digest: string; session_attempt: string | number }>("upload_sessions", "upload_id = $1", [upload.uploadId]);
  assert.deepEqual(row && [row.provider_session_digest, Number(row.session_attempt)], [textDigest(session.uploadUrl as string), 1]);

  // never journaled: the journal holds the placeholder; no event, fact or journal row carries the reference
  const journal = await w.journal(key);
  assert.deepEqual(journal && [journal.state, journal.status, journal.resourceKind, journal.resourceId], ["COMMITTED", 201, "upload_session", upload.uploadId]);
  assert.deepEqual((journal?.body as ReserveUploadView).session, { delivery: "PROTECTED_RESPONSE", sessionRef: upload.uploadId, chunkMultipleBytes: CONTRACT_FAKE_CHUNK_MULTIPLE_BYTES });
  const leaks = await w.h.oracle.query<{ n: string }>(
    `SELECT ((SELECT count(*) FROM kauro.command_journal WHERE response_body::text LIKE '%' || $1 || '%') + (SELECT count(*) FROM kauro.domain_events WHERE payload::text LIKE '%' || $1 || '%')
            + (SELECT count(*) FROM kauro.security_events WHERE to_jsonb(security_events)::text LIKE '%' || $1 || '%'))::text AS n`,
    [session.uploadUrl],
  );
  assert.equal(leaks.rows[0]?.n, "0", "the bearer reference is nowhere durable but sealed");
  // the delivery is a durable ALLOW fact of the agency's stream (D-SESSION-4)
  assert.ok((await w.securityEvents("CMD013")).some((f) => f.outcome === "ALLOW" && f.reason === "SESSION_DELIVERED" && f.agencyId === w.A.agencyId && f.actorId === w.operator.userId));

  // to the requester only: the requester's session read re-delivers it; another member reads UNAVAILABLE; progress never carries it
  const own = await call(w, { method: "GET", url: sourceRoutes.uploadSession(upload.uploadId), token: w.operator.token, key: null, contentType: null });
  assert.equal(own.status, 200, own.text);
  assert.deepEqual(own.json<{ data: ProtectedSessionView }>().data, { delivery: "PROTECTED_RESPONSE", uploadUrl: session.uploadUrl, method: "PUT", applicationExpiresAt: upload.applicationExpiresAt });
  const other = await call(w, { method: "GET", url: sourceRoutes.uploadSession(upload.uploadId), token: w.owner.token, key: null, contentType: null });
  assert.deepEqual(other.json<{ data: ProtectedSessionView }>().data, { delivery: "UNAVAILABLE", unavailableReason: "NOT_REQUESTER" });
  const progress = await call(w, { method: "GET", url: sourceRoutes.upload(upload.uploadId), token: w.owner.token, key: null, contentType: null });
  assert.equal(progress.status, 200);
  assert.ok(!progress.text.includes(session.uploadUrl as string), "safe progress never carries the session");
});

test("DENY: VIEWER → 403; foreign revision → 404; INSPECTING revision → 409 REVISION_NOT_ACCEPTING_UPLOADS; 2e9 + 1 bytes → 409 FILE_TOO_LARGE; a third session → 429 UPLOAD_CONCURRENCY_LIMITED; DRAFT agency → 409 AGENCY_NOT_ACTIVE; another member's session read → UNAVAILABLE NOT_REQUESTER — no provider call made", async () => {
  await roomFor(3);
  const { revisionId } = await w.project(w.A, w.clientA);
  // an INSPECTING revision: one file admitted, its selection bound (UPLOADING -> INSPECTING)
  const inspecting = await w.project(w.A, w.clientA);
  const file = await uploadAndAdmit(w, inspecting.revisionId, 1);
  await bound(w, inspecting.revisionId, 2, manifestOf(inspecting.revisionId, await inventoryHashOfRoute(w, inspecting.revisionId), [{ file }]));
  const foreign = await w.project(w.B, w.clientB);
  // an upload of the operator, whose session another member will try to read
  const theirs = await reserved(w, revisionId, 1);

  const sessionsBefore = w.storage.calls("createResumableSession").length;
  const uploadsBefore = await w.count("upload_sessions");
  const opensBefore = w.vault.calls().filter((c) => c.operation === "open").length;

  assert.equal(outcome(w, await reserve(w, revisionId, 2, { person: w.viewer })), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.equal(outcome(w, await reserve(w, foreign.revisionId, 1)), "404 NOT_FOUND -");
  const notAccepting = await reserve(w, inspecting.revisionId, 3);
  assert.equal(outcome(w, notAccepting), "409 PRECONDITION_FAILED REVISION_NOT_ACCEPTING_UPLOADS");
  assert.deepEqual(currentOf(notAccepting), { version: 3, state: "INSPECTING" });
  assert.equal(outcome(w, await reserve(w, revisionId, 2, { bytes: 2_000_000_001 })), "409 PRECONDITION_FAILED FILE_TOO_LARGE");
  // the agency's concurrent sessions: the limit set to what is live plus one, the second new reservation is the one too many
  await setSessionLimit(w, w.A, (await activeSessions()) + 1);
  const second = await reserved(w, revisionId, 2);
  const sessionsAtLimit = w.storage.calls("createResumableSession").length;
  assert.equal(outcome(w, await reserve(w, revisionId, 2)), "429 ADMISSION_LIMITED UPLOAD_CONCURRENCY_LIMITED");
  assert.equal(w.storage.calls("createResumableSession").length, sessionsAtLimit, "no session for the refused reservation");
  // B is still DRAFT: its owner's reservation is refused before any intent
  assert.equal(outcome(w, await reserve(w, foreign.revisionId, 1, { person: w.stranger, agency: w.B.agencyId })), "409 PRECONDITION_FAILED AGENCY_NOT_ACTIVE");
  // another member of the agency reads the operator's session: UNAVAILABLE, a durable DENY fact, the vault never opens it
  const read = await call(w, { method: "GET", url: sourceRoutes.uploadSession(theirs.data.upload.uploadId), token: w.admin.token, key: null, contentType: null });
  assert.equal(read.status, 200);
  assert.deepEqual(read.json<{ data: ProtectedSessionView }>().data, { delivery: "UNAVAILABLE", unavailableReason: "NOT_REQUESTER" });
  assert.ok(!read.text.includes(sessionUrlOf(theirs)));
  assert.ok((await w.securityEvents("READ_UPLOAD_SESSION")).some((f) => f.outcome === "DENY" && f.reason === "NOT_REQUESTER" && f.actorId === w.admin.userId && f.agencyId === w.A.agencyId));

  // no provider call for any denial: the one session created is the admitted second reservation's
  assert.equal(w.storage.calls("createResumableSession").length, sessionsBefore + 1);
  assert.equal(await w.count("upload_sessions"), uploadsBefore + 1, "no refused reservation left an intent");
  assert.equal(w.vault.calls().filter((c) => c.operation === "open").length, opensBefore, "the vault opened nothing for another member");
  assert.equal(second.data.upload.state, "UPLOADING");
});

test("RACE: identical retry → the same reservation and the session re-delivered; the same key with another declaration → 409; a retry while the first is pending → 409 OPERATION_PENDING; a crash after the intent resumes under a new fence and issues one session; a crash after the provider call cancels the undelivered session", async () => {
  await roomFor(4);
  const { revisionId } = await w.project(w.A, w.clientA);

  // identical retry: the journaled reservation, the session re-delivered from the vault to its requester (a second ALLOW fact)
  const key = freshKey("cmd013-retry");
  const first = await reserve(w, revisionId, 1, { key });
  const firstBody = completed<ReserveUploadView>(first, 201);
  const factsBefore = (await w.securityEvents("CMD013")).filter((f) => f.reason === "SESSION_DELIVERED").length;
  const retry = await reserve(w, revisionId, 1, { key });
  assert.equal(retry.status, 201);
  assert.equal(retry.text, replayTextOf(first), "the same reservation and the same session, replayed");
  assert.equal((await w.securityEvents("CMD013")).filter((f) => f.reason === "SESSION_DELIVERED").length, factsBefore + 1);
  const conflict = await call(w, { url: sourceRoutes.reserveUpload(revisionId), token: w.operator.token, key, body: reserveBody(1, { bytes: 2_000_000 }) });
  assert.equal(outcome(w, conflict), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal(await w.count("upload_sessions", "revision_id = $1", [revisionId]), 1);

  // a retry while the first is pending: the first holds at the provider call (its intent committed, the entry RESERVED)
  const pendingKey = freshKey("cmd013-pending");
  const providerHold = w.storage.holdNext("createResumableSession");
  const held = reserve(w, revisionId, 2, { key: pendingKey });
  await providerHold.reached;
  assert.equal(outcome(w, await reserve(w, revisionId, 2, { key: pendingKey })), "409 PRECONDITION_FAILED OPERATION_PENDING");
  providerHold.release();
  const pendingDone = completed<ReserveUploadView>(await held, 201);
  assert.equal(pendingDone.data.upload.state, "UPLOADING");

  // a crash after the intent (unit of work 1 committed, no provider call yet): the retry within the grace is pending; after it,
  // the retry resumes the intent under a new fence and issues exactly one session
  const crashKey = freshKey("cmd013-crash-intent");
  const crash = w.holds.arm("after.commit", { fail: new SimulatedCrash("after the intent") });
  const crashed = await reserve(w, revisionId, 2, { key: crashKey });
  await crash.reached;
  assert.equal(crashed.status, 500);
  const intent = await w.journal(crashKey);
  assert.equal(intent?.state, "RESERVED");
  const intentUpload = intent?.resourceId as string;
  const intentObject = quarantineName(w.A.agencyId, (await w.row<{ project_id: string }>("upload_sessions", "upload_id = $1", [intentUpload]))?.project_id as string, revisionId, intentUpload);
  assert.equal(sessionsFor(intentObject).length, 0, "no session before the crash");
  assert.equal(outcome(w, await reserve(w, revisionId, 2, { key: crashKey })), "409 PRECONDITION_FAILED OPERATION_PENDING");
  w.processClock.advance((PENDING_RESUME_GRACE_SECONDS + 1) * 1000);
  const resumed = completed<ReserveUploadView>(await reserve(w, revisionId, 2, { key: crashKey }), 201);
  assert.equal(resumed.data.upload.uploadId, intentUpload, "the same reservation, resumed");
  assert.equal(resumed.data.upload.state, "UPLOADING");
  assert.equal(Number((await w.row<{ session_attempt: string }>("upload_sessions", "upload_id = $1", [intentUpload]))?.session_attempt), 2, "a new issuance fence");
  assert.equal(sessionsFor(intentObject).length, 1, "one session issued");
  assert.equal((await w.journal(crashKey))?.state, "COMMITTED");

  // a crash after the provider call (unit of work 2 rolled back): the undelivered session is cancelled; the resumed attempt issues
  // a new one, the only one delivered
  const lostKey = freshKey("cmd013-crash-provider");
  const lost = w.holds.arm("journal.commit", { fail: new SimulatedCrash("after the provider call") });
  const lostReply = await reserve(w, revisionId, 2, { key: lostKey });
  await lost.reached;
  assert.equal(lostReply.status, 500);
  const lostUpload = (await w.journal(lostKey))?.resourceId as string;
  const lostObject = quarantineName(w.A.agencyId, (await w.row<{ project_id: string }>("upload_sessions", "upload_id = $1", [lostUpload]))?.project_id as string, revisionId, lostUpload);
  const undelivered = sessionsFor(lostObject);
  assert.equal(undelivered.length, 1);
  const cancelled = w.storage.calls("cancelResumableSession");
  assert.ok(cancelled.some((c) => c.request["sessionDigest"] === (undelivered[0]?.outcome ?? "").replace(/^SESSION /, "")), "the undelivered session was cancelled");
  assert.equal((await w.row<{ state: string }>("upload_sessions", "upload_id = $1", [lostUpload]))?.state, "RESERVED", "nothing of unit of work 2 committed");
  w.processClock.advance((PENDING_RESUME_GRACE_SECONDS + 1) * 1000);
  const reissued = completed<ReserveUploadView>(await reserve(w, revisionId, 2, { key: lostKey }), 201);
  const delivered = (reissued.data.session as ProtectedSessionView).uploadUrl as string;
  assert.equal(sessionsFor(lostObject).length, 2);
  assert.equal(w.storage.sessionView(delivered)?.state, "OPEN");
  assert.equal(textDigest(delivered), (await w.row<{ provider_session_digest: string }>("upload_sessions", "upload_id = $1", [lostUpload]))?.provider_session_digest, "the delivered session is the one the upload records");
  assert.equal(firstBody.data.upload.state, "UPLOADING");
});

test("RACE (R2-052): two ReserveUpload calls that each fit the remaining quota — the second waits on the revision and is answered 409 REVISION_QUOTA_EXCEEDED; the ledger holds exactly the admitted combination", async () => {
  await roomFor(4);
  const { revisionId } = await w.project(w.A, w.clientA);
  // 4e9 of the 5e9 envelope reserved: two calls of 0.6e9 each fit the remaining 1e9 alone, not together
  await reserved(w, revisionId, 1, { bytes: 2_000_000_000 });
  await reserved(w, revisionId, 2, { bytes: 2_000_000_000 });
  const hold = w.holds.arm("source.intent");
  const a = reserve(w, revisionId, 2, { bytes: 600_000_000, displayName: "first.csv" });
  await reachedHold(hold, a);
  const b = reserve(w, revisionId, 2, { bytes: 600_000_000, displayName: "second.csv" });
  await waitForApiLockWait(w, LOCKS.revision);
  hold.release();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(completed<ReserveUploadView>(first, 201).data.upload.reservedBytes, 600_000_000);
  assert.equal(outcome(w, second), "409 PRECONDITION_FAILED REVISION_QUOTA_EXCEEDED");
  // the ledger: exactly the three admitted reservations
  const ledger = await w.h.oracle.query<{ reserved: string; files: string }>("SELECT coalesce(sum(reserved_bytes), 0)::text AS reserved, count(*)::text AS files FROM kauro.upload_sessions WHERE revision_id = $1 AND state IN ('RESERVED', 'UPLOADING', 'VERIFYING', 'ADMITTED')", [revisionId]);
  assert.deepEqual(ledger.rows[0], { reserved: "4600000000", files: "3" });
  const quota = await call(w, { method: "GET", url: sourceRoutes.inspection(revisionId), token: w.operator.token, key: null, contentType: null });
  assert.equal(quota.status, 200);
  assert.equal(await w.count("upload_sessions", "revision_id = $1 AND display_name = 'second.csv'", [revisionId]), 0, "the loser left no intent");
});
