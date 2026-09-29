// CMD014 CompleteUpload — POST /api/v1/uploads/{uploadId}/complete — AGENCY_OPERATOR (registry cases CMD014-OK / -DENY / -RACE and
// the late request of R2-051; docs/design/B07-upload-source-lifecycle.md §11 CMD014, D-RUN-1, D-SAPI-3, D-SAPI-5, D-SRC-2, D-ROLE-2,
// D-LOCK-1, D-CLOCK-1). The real route and composition root over PostgreSQL 17. The request records the browser's claim and answers
// 202: the provider observation, hashing, inspection and scan are the control plane's (UPLOAD_INSPECTION, mandate B07-CONTROL), so
// nothing here is admitted. The resumable session and its completion reference come from the labelled storage fake of
// @kauro/application/testing (SIMULATED). The upload whose deadline passed is written in the past by the product's own adapters on
// the labelled TEST CLOCK (source-support issuedUploadAt), never back-dated. Interleavings by hold points and pg_stat_activity.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AcceptedResponse, CancelUploadView, UploadView } from "@kauro/application";
import { completionRefOf } from "@kauro/application/testing";
import { textDigest } from "@kauro/domain";
import { asProblem, call, completed, freshKey, outcome, waitForApiLockWait, world, type Reply, type World } from "./support.js";
import { LOCKS, activate, complete, csvContent, exactInstant, issuedUploadAt, reserve, reserved, sessionUrlOf, setSessionLimit, sourceRoutes, uploadThrough } from "./source-support.js";
import { reachedHold } from "./writers.js";

let w: World;
before(async () => {
  w = await world();
  await activate(w);
  await setSessionLimit(w, w.A, 16);
});
after(async () => {
  await w.stop();
});

function accepted(reply: Reply): AcceptedResponse {
  assert.equal(reply.status, 202, reply.text);
  const body = reply.json<AcceptedResponse>();
  assert.equal(body.kind, "ACCEPTED");
  return body;
}

function cancel(uploadId: string, expectedVersion: number, key = freshKey("cancel")): Promise<Reply> {
  return call(w, { url: sourceRoutes.cancelUpload(uploadId), token: w.operator.token, key, body: { expectedVersion } });
}

/** The upload row's lifecycle facts (superuser oracle). */
async function uploadRow(uploadId: string) {
  const row = await w.row<{
    state: string;
    version: string;
    completion_claim_digest: string | null;
    claimed_generation: string | null;
    claimed_bytes: string | null;
    claimed_crc32c: string | null;
    claimed_md5: string | null;
    observed_generation: string | null;
    observed_bytes: string | null;
    inspection_fence: number;
    file_id: string | null;
  }>("upload_sessions", "upload_id = $1", [uploadId]);
  assert.ok(row);
  return row;
}

test("OK: the requester reports completion → 202 ACCEPTED (operationId = uploadId, VERIFYING, status path, poll after 5 s); nothing is admitted by the request", async () => {
  const { revisionId } = await w.project(w.A, w.clientA);
  const content = csvContent(5, "cmd014-ok");
  const r = await reserved(w, revisionId, 1, { bytes: content.byteLength });
  const uploadId = r.data.upload.uploadId;
  const finalized = uploadThrough(w, sessionUrlOf(r), content);
  const claim = w.storage.parseCompletionClaim(finalized.completionRef);
  assert.equal(claim.kind, "CLAIM");
  if (claim.kind !== "CLAIM") return;

  const key = freshKey("cmd014-ok");
  const reply = await complete(w, uploadId, finalized.completionRef, { key });
  assert.deepEqual(accepted(reply), { kind: "ACCEPTED", operationId: uploadId, state: "VERIFYING", statusPath: `/api/v1/uploads/${uploadId}`, pollAfterSeconds: 5 });
  // the journal stores the 202 and exactly its members; a replay answers them again (D-RUN-1)
  const journal = await w.journal(key);
  assert.deepEqual(journal, { state: "COMMITTED", status: 202, body: { operationId: uploadId, state: "VERIFYING", statusPath: `/api/v1/uploads/${uploadId}`, pollAfterSeconds: 5 }, resourceKind: "upload_session", resourceId: uploadId });

  // UPLOADING -> VERIFYING with the browser's claim recorded as a claim: its digest and the parsed members UPLOAD_INSPECTION
  // compares with the provider's own observation (generation, size, CRC32C, MD5) — the observation itself is not the request's
  const row = await uploadRow(uploadId);
  assert.deepEqual(
    [row.state, Number(row.version), row.completion_claim_digest, row.claimed_generation, Number(row.claimed_bytes), row.claimed_crc32c, row.claimed_md5],
    ["VERIFYING", 3, textDigest(finalized.completionRef), claim.claim.generation, claim.claim.bytes, claim.claim.crc32c ?? null, claim.claim.md5 ?? null],
  );
  assert.equal(claim.claim.generation, finalized.generation);
  const reportedAt = await exactInstant(w, "SELECT completion_reported_at FROM kauro.upload_sessions WHERE upload_id = $1", [uploadId]);
  assert.ok(reportedAt > (await exactInstant(w, "SELECT session_issued_at FROM kauro.upload_sessions WHERE upload_id = $1", [uploadId])), "reported at the server instant, after the session was issued");
  // one event, routed to UPLOAD_INSPECTION with the keys its consumer reads (uploadId, revisionId; aggregateId the upload)
  const event = (await w.events("upload_session", uploadId)).at(-1);
  assert.deepEqual([event?.version, event?.type], [3, "upload_session.completion_reported.v1"]);
  assert.deepEqual(event?.payload, { uploadId, agencyId: w.A.agencyId, revisionId, completionClaimDigest: textDigest(finalized.completionRef), reportedByMembershipId: w.memberships.operator });
  assert.deepEqual(await w.outbox(event?.eventId as string), ["UPLOAD_INSPECTION"]);

  // nothing is admitted by the request: no observation, no attempt, no receipt, no file, the quarantine object still only intended,
  // the revision still UPLOADING (only the agency's selection closes the intake, D-INTAKE-1)
  assert.deepEqual([row.observed_generation, row.observed_bytes, row.inspection_fence, row.file_id], [null, null, 0, null]);
  assert.equal(await w.count("inspection_receipts", "upload_id = $1", [uploadId]), 0);
  assert.equal(await w.count("source_files", "origin_upload_id = $1", [uploadId]), 0);
  assert.equal((await w.row<{ state: string }>("stored_objects", "upload_id = $1 AND zone = 'QUARANTINE'", [uploadId]))?.state, "INTENDED");
  assert.equal((await w.row<{ state: string }>("dataset_revisions", "revision_id = $1", [revisionId]))?.state, "UPLOADING");
  // the status path is GetUpload: safe progress VERIFYING, no bearer session, no longer completable by the requester
  const status = await call(w, { method: "GET", url: `/api/v1/uploads/${uploadId}`, token: w.operator.token, key: null, contentType: null });
  const view = status.json<{ data: UploadView }>().data;
  assert.deepEqual([status.status, view.state, view.version, view.permittedActions], [200, "VERIFYING", 3, ["CancelUpload"]]);
  assert.ok(!status.text.includes(sessionUrlOf(r)));
});

test("DENY: another member's upload → 403 UPLOAD_NOT_OWNED; RESERVED → 409 SESSION_NOT_ISSUED; CANCELLED → 409 UPLOAD_CANCELLED; past the deadline → 409 RESERVATION_EXPIRED; a malformed reference → 400 COMPLETION_REF_MALFORMED; a claimed size and hash never mark the file ready", async () => {
  const { revisionId } = await w.project(w.A, w.clientA);
  const content = csvContent(3, "cmd014-deny");
  const snapshot = async (uploadId: string) => {
    const r = await uploadRow(uploadId);
    return [r.state, r.version, r.completion_claim_digest];
  };
  const eventsBefore = await w.count("domain_events", "event_type = 'upload_session.completion_reported.v1'");

  // another member's upload: the requester only (D-SRC-2), a durable DENY fact
  const theirs = await reserved(w, revisionId, 1, { bytes: content.byteLength });
  const theirsFinal = uploadThrough(w, sessionUrlOf(theirs), content);
  const theirsBefore = await snapshot(theirs.data.upload.uploadId);
  const denialsBefore = (await w.securityEvents("CMD014")).length;
  assert.equal(outcome(w, await complete(w, theirs.data.upload.uploadId, theirsFinal.completionRef, { person: w.admin })), "403 NOT_AUTHORIZED UPLOAD_NOT_OWNED");
  assert.deepEqual((await w.securityEvents("CMD014")).slice(denialsBefore).map((f) => [f.outcome, f.reason, f.actorId]), [["DENY", "UPLOAD_NOT_OWNED", w.admin.userId]]);
  assert.deepEqual(await snapshot(theirs.data.upload.uploadId), theirsBefore);

  // RESERVED: the provider did not issue the session (a scripted outage before any effect); the reservation stays pending
  w.storage.failNext("createResumableSession", { code: "UNAVAILABLE" });
  const pendingKey = freshKey("cmd014-deny-pending");
  assert.equal(outcome(w, await reserve(w, revisionId, 2, { key: pendingKey })), "503 CAPACITY_UNAVAILABLE SESSION_ISSUE_FAILED");
  const pendingId = (await w.journal(pendingKey))?.resourceId as string;
  assert.equal((await uploadRow(pendingId)).state, "RESERVED");
  const notIssued = await complete(w, pendingId, completionRefOf({ generation: "1700000000000001", bytes: 10 }));
  assert.equal(outcome(w, notIssued), "409 PRECONDITION_FAILED SESSION_NOT_ISSUED");
  assert.deepEqual(asProblem(w, notIssued).current, { version: 1, state: "RESERVED" });

  // CANCELLED: the requester cancelled, then the browser's late completion arrives — never accepted
  const cancelled = await reserved(w, revisionId, 2, { bytes: content.byteLength });
  completed<CancelUploadView>(await cancel(cancelled.data.upload.uploadId, 2), 200);
  const late = uploadThrough(w, sessionUrlOf(cancelled), content);
  const lateReply = await complete(w, cancelled.data.upload.uploadId, late.completionRef);
  assert.equal(outcome(w, lateReply), "409 PRECONDITION_FAILED UPLOAD_CANCELLED");
  assert.deepEqual(asProblem(w, lateReply).current, { version: 3, state: "CANCELLED" });

  // past the deadline: an upload initiated twenty-five hours ago on the server clock, its session issued then, still UPLOADING
  // because no sweeper ran — the requester's completion now is refused on the server clock (R2-051: nothing accepted after it)
  const past = await issuedUploadAt(w, revisionId, new Date(Date.now() - 25 * 3_600_000), w.operator, w.memberships.operator);
  const pastBefore = await snapshot(past.uploadId);
  assert.equal(pastBefore[0], "UPLOADING");
  const expired = await complete(w, past.uploadId, completionRefOf({ generation: "1700000000000002", bytes: 1_000_000 }));
  assert.equal(outcome(w, expired), "409 PRECONDITION_FAILED RESERVATION_EXPIRED");
  assert.deepEqual(asProblem(w, expired).current, { version: 2, state: "UPLOADING" });
  assert.deepEqual(await snapshot(past.uploadId), pastBefore);

  // a reference that is not a completion of this provider (parsed by the storage port, pure)
  const own = await reserved(w, revisionId, 2, { bytes: content.byteLength });
  const malformed = await complete(w, own.data.upload.uploadId, "not-a-provider-completion");
  assert.equal(outcome(w, malformed), "400 INVALID_REQUEST COMPLETION_REF_MALFORMED");
  assert.deepEqual(asProblem(w, malformed).errors, [{ field: "providerCompletionRef", code: "FORMAT" }]);
  assert.equal((await uploadRow(own.data.upload.uploadId)).state, "UPLOADING");

  // a claimed size and hash never mark the file ready: a forged claim is recorded as a claim (VERIFYING), nothing is observed,
  // admitted or filed — and the request handlers' role cannot write the observation, the fence or ADMITTED at all (D-ROLE-2)
  const forged = completionRefOf({ generation: "1700000000009999", bytes: 1_999_999_999, crc32c: "AAAAAA==", md5: "AAAAAAAAAAAAAAAAAAAAAA==" });
  accepted(await complete(w, own.data.upload.uploadId, forged));
  const verifying = await uploadRow(own.data.upload.uploadId);
  assert.deepEqual([verifying.state, verifying.claimed_generation, Number(verifying.claimed_bytes), verifying.observed_generation, verifying.observed_bytes, verifying.file_id], ["VERIFYING", "1700000000009999", 1_999_999_999, null, null, null]);
  for (const sql of [
    "UPDATE kauro.upload_sessions SET observed_generation = claimed_generation, observed_bytes = claimed_bytes WHERE upload_id = $1",
    "UPDATE kauro.upload_sessions SET inspection_fence = inspection_fence + 1 WHERE upload_id = $1",
    "UPDATE kauro.upload_sessions SET state = 'ADMITTED', version = version + 1 WHERE upload_id = $1",
  ]) {
    await assert.rejects(w.asTenant(w.A, (c) => c.query(sql, [own.data.upload.uploadId])), (e: { code?: string }) => e.code === "42501", sql);
  }
  assert.equal(await w.count("source_files", "origin_upload_id = $1", [own.data.upload.uploadId]), 0);
  assert.equal(await w.count("inspection_receipts", "upload_id = $1", [own.data.upload.uploadId]), 0);
  // the only completion events are the forged claim's (recorded as a claim) — none for a refusal
  assert.equal(await w.count("domain_events", "event_type = 'upload_session.completion_reported.v1'"), eventsBefore + 1);
});

test("RACE: identical retry → the same 202; the same key with another reference → 409; a duplicate completion under another key → the same 202 (D-SAPI-5), another claim → 409 COMPLETION_CLAIM_CONFLICT; CompleteUpload racing CancelUpload serializes on the revision row", async () => {
  const { revisionId } = await w.project(w.A, w.clientA);
  const content = csvContent(4, "cmd014-race");
  const r = await reserved(w, revisionId, 1, { bytes: content.byteLength });
  const uploadId = r.data.upload.uploadId;
  const finalized = uploadThrough(w, sessionUrlOf(r), content);
  const key = freshKey("cmd014-race");
  const first = await complete(w, uploadId, finalized.completionRef, { key });
  accepted(first);
  const completions = () => w.count("domain_events", "aggregate_id = $1 AND event_type = 'upload_session.completion_reported.v1'", [uploadId]);

  // identical retry: the journaled 202, byte for byte
  const retry = await complete(w, uploadId, finalized.completionRef, { key });
  assert.equal(retry.status, 202);
  assert.equal(retry.text, first.text);
  // the same key with another reference: a typed conflict, no effect
  const other = completionRefOf({ generation: finalized.generation, bytes: finalized.bytes + 1 });
  assert.equal(outcome(w, await complete(w, uploadId, other, { key })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  // a duplicate completion of the same claim under another key: the same 202 and no new effect (idempotent by upload and claim)
  const duplicate = await complete(w, uploadId, finalized.completionRef, { key: freshKey("cmd014-race-duplicate") });
  assert.deepEqual(accepted(duplicate), first.json());
  // another claim for the upload under verification: refused, the recorded claim stands
  const conflicting = await complete(w, uploadId, other, { key: freshKey("cmd014-race-other") });
  assert.equal(outcome(w, conflicting), "409 PRECONDITION_FAILED COMPLETION_CLAIM_CONFLICT");
  assert.deepEqual(asProblem(w, conflicting).current, { version: 3, state: "VERIFYING" });
  assert.equal(await completions(), 1, "one completion_reported event");
  assert.equal((await uploadRow(uploadId)).completion_claim_digest, textDigest(finalized.completionRef));

  // CompleteUpload racing CancelUpload, both orders, serialized on the revision row (D-LOCK-1) — never on the upload row first
  // (a) the cancellation first: held before its journal commit (revision row and upload locked, CANCELLED written); the completion
  //     is observed waiting on the revision row; the cancellation commits; the completion reads the tombstone: UPLOAD_CANCELLED
  const a = await reserved(w, revisionId, 2, { bytes: content.byteLength });
  const aFinal = uploadThrough(w, sessionUrlOf(a), content);
  const holdA = w.holds.arm("journal.commit");
  const cancelA = cancel(a.data.upload.uploadId, 2);
  let completeA: Promise<Reply> | undefined;
  try {
    await reachedHold(holdA, cancelA);
    completeA = complete(w, a.data.upload.uploadId, aFinal.completionRef);
    await waitForApiLockWait(w, LOCKS.revision);
  } finally {
    holdA.release();
  }
  const [cancelledA, lateA] = await Promise.all([cancelA, completeA as Promise<Reply>]);
  assert.equal(completed<CancelUploadView>(cancelledA, 200).data.upload.state, "CANCELLED");
  assert.equal(outcome(w, lateA), "409 PRECONDITION_FAILED UPLOAD_CANCELLED");
  assert.equal(await w.count("domain_events", "aggregate_id = $1 AND event_type = 'upload_session.completion_reported.v1'", [a.data.upload.uploadId]), 0);

  // (b) the completion first: held before its journal commit (VERIFYING written); the cancellation of the version it read is
  //     observed waiting on the revision row; the completion commits; the cancellation reads the new version: STALE_VERSION
  const b = await reserved(w, revisionId, 2, { bytes: content.byteLength });
  const bFinal = uploadThrough(w, sessionUrlOf(b), content);
  const holdB = w.holds.arm("journal.commit");
  const completeB = complete(w, b.data.upload.uploadId, bFinal.completionRef);
  let cancelB: Promise<Reply> | undefined;
  try {
    await reachedHold(holdB, completeB);
    cancelB = cancel(b.data.upload.uploadId, 2);
    await waitForApiLockWait(w, LOCKS.revision);
  } finally {
    holdB.release();
  }
  const [completedB, staleB] = await Promise.all([completeB, cancelB as Promise<Reply>]);
  accepted(completedB);
  assert.equal(outcome(w, staleB), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, staleB).current, { version: 3, state: "VERIFYING" });
  assert.equal((await uploadRow(b.data.upload.uploadId)).state, "VERIFYING");
});
