// The source reads (docs/design/B07-upload-source-lifecycle.md §9.1: GetRevision, GetInspection, ListUploads, GetUpload,
// GetSelectionManifest, GetUploadSession, PreviewTable; decisions D-SAPI-1, D-SAPI-6, D-SAPI-7, D-SESSION-2, D-SESSION-4; 10 "Upload
// and target routes": GET returns safe progress without exposing the session URI to unrelated readers, GET inspection lists files,
// detected worksheets and structured problems, a preview returns a bounded authorized sample with no shared caching). The real routes
// and composition root over PostgreSQL 17. The resumable sessions come from the labelled storage and vault fakes of
// @kauro/application/testing (SIMULATED); the preview reader is the platform's own bounded parser of @kauro/data-plane
// (IsolatedTablePreviewReader, always real, in its isolated child). The last test composes a second world as a deployment of this
// edition does: no provider adapter and no preview reader bound (D-SAPI-6).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { InspectionView, ProtectedSessionView, SelectionManifestView, SourceRevisionView, TablePreviewView, UploadPage, UploadView } from "@kauro/application";
import { IsolatedTablePreviewReader, inspectionLimits } from "@kauro/data-plane";
import { acceptedObjectName, type AgencyId } from "@kauro/domain";
import { admitSourceFile } from "@kauro/persistence/testing";
import { call, freshKey, outcome, world, type Person, type Reply, type World } from "./support.js";
import { activate, complete, fixtureSessions, csvContent, inventoryHashOfRoute, manifestOf, reserve, reserved, revokeAdmission, sessionUrlOf, setSessionLimit, sourceRoutes, storedManifest, uploadAndAdmit, uploadThrough } from "./source-support.js";

let w: World;
let scratch: string;
before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "kauro-preview-"));
  const preview = { reader: new IsolatedTablePreviewReader(), limits: inspectionLimits(), scratchDir: scratch };
  w = await world({ sources: () => ({ preview }) });
  await activate(w);
  await setSessionLimit(w, w.A, 16);
});
after(async () => {
  await w.stop();
  rmSync(scratch, { recursive: true, force: true });
});

function get(url: string, person: Person = w.operator, agency?: string): Promise<Reply> {
  return call(w, { method: "GET", url, token: person.token, key: null, contentType: null, ...(agency !== undefined ? { agency } : {}) });
}

function dataOf<T>(reply: Reply): T {
  assert.equal(reply.status, 200, reply.text);
  const body = reply.json<{ kind: string; data: T }>();
  assert.equal(body.kind, "READ");
  return body.data;
}

test("source reads: every member of the agency reads a revision, its inspection, its uploads (keyset pages whose cursor is bound to the caller and the revision), an upload and a stored selection manifest as safe views — no session URL, provider generation, object name or storage reference; another agency's resource and one that does not exist answer alike 404; a non-member is refused with a durable fact", async () => {
  const { projectId, revisionId } = await w.project(w.A, w.clientA);
  const file = await uploadAndAdmit(w, revisionId, 1);
  const inFlight = await reserved(w, revisionId, 2);
  const third = await reserved(w, revisionId, 2);
  const document = manifestOf(revisionId, await inventoryHashOfRoute(w, revisionId), [{ file }]);
  const manifest = await storedManifest(w, revisionId, document);
  const secrets = [sessionUrlOf(inFlight), sessionUrlOf(third), file.acceptedGeneration, file.acceptedObjectId, "quarantine/", "accepted/"];
  const leaks = (reply: Reply): ReadonlyArray<string> => secrets.filter((s) => reply.text.includes(s));

  for (const person of [w.owner, w.operator, w.approver, w.viewer, w.billing]) {
    const revision = await get(sourceRoutes.revision(revisionId), person);
    const r = dataOf<SourceRevisionView>(revision);
    assert.deepEqual([r.revisionId, r.projectId, r.state, r.version], [revisionId, projectId, "UPLOADING", 2]);
    assert.deepEqual(r.blockers, ["UPLOADS_IN_PROGRESS"]);
    // permitted actions are the reader's own (informative, never authority): an operating role may reserve and select, a viewer none
    assert.deepEqual(r.permittedActions, person === w.viewer || person === w.approver || person === w.billing ? [] : ["CreateRevision", "ReserveUpload", "SelectInputTables"]);
    const inspection = dataOf<InspectionView>(await get(sourceRoutes.inspection(revisionId), person));
    assert.equal(inspection.inventoryHash, await inventoryHashOfRoute(w, revisionId));
    assert.deepEqual(inspection.files.map((f) => [f.fileId, f.admitted, f.origin, f.scanState, f.tables.length]), [[file.fileId, true, "THIS_REVISION", "COVERED_CLEAN", 1]]);
    assert.deepEqual(inspection.files[0]?.tables[0]?.columns.map((c) => [c.ordinal, c.label, c.labelState]), [[0, "Email", "PRESENT"], [1, "Name", "PRESENT"]]);
    assert.equal(inspection.uploads.length, 3);
    const upload = dataOf<UploadView>(await get(sourceRoutes.upload(file.uploadId), person));
    assert.deepEqual([upload.state, upload.fileId, upload.inspection?.scanState, upload.inspection?.semanticStatus, upload.displayName], ["ADMITTED", file.fileId, "COVERED_CLEAN", "SEMANTIC_NOT_YET_PROFILED", "contacts export.csv"]);
    const stored = dataOf<SelectionManifestView>(await get(sourceRoutes.selectionManifest(revisionId, manifest.selectionManifestId), person));
    assert.deepEqual([stored.bodyHash, stored.document], [manifest.bodyHash, document]);
    for (const reply of [revision, await get(sourceRoutes.inspection(revisionId), person), await get(sourceRoutes.upload(inFlight.data.upload.uploadId), person)]) assert.deepEqual(leaks(reply), [], "a safe view");
  }
  // the requester's own upload offers its commands; another member's does not (D-SRC-2)
  assert.deepEqual(dataOf<UploadView>(await get(sourceRoutes.upload(inFlight.data.upload.uploadId), w.operator)).permittedActions, ["CompleteUpload", "CancelUpload"]);
  assert.deepEqual(dataOf<UploadView>(await get(sourceRoutes.upload(inFlight.data.upload.uploadId), w.admin)).permittedActions, []);

  // ListUploads: keyset pages; the cursor is bound to the caller and this revision's list, so another list's cursor is refused
  const page1 = dataOf<UploadPage>(await get(`${sourceRoutes.uploads(revisionId)}?limit=2`));
  assert.equal(page1.items.length, 2);
  assert.ok(page1.nextCursor);
  const page2 = dataOf<UploadPage>(await get(`${sourceRoutes.uploads(revisionId)}?limit=2&cursor=${encodeURIComponent(page1.nextCursor as string)}`));
  assert.equal(page2.items.length, 1);
  assert.equal(page2.nextCursor, undefined);
  assert.deepEqual([...page1.items, ...page2.items].map((u) => u.uploadId).sort(), [file.uploadId, inFlight.data.upload.uploadId, third.data.upload.uploadId].sort());
  const otherRevision = await w.project(w.A, w.clientA);
  assert.equal(outcome(w, await get(`${sourceRoutes.uploads(otherRevision.revisionId)}?limit=2&cursor=${encodeURIComponent(page1.nextCursor as string)}`)), "400 INVALID_REQUEST CURSOR_INVALID");
  assert.equal(outcome(w, await get(`${sourceRoutes.uploads(revisionId)}?limit=2&cursor=${encodeURIComponent(page1.nextCursor as string)}`, w.admin)), "400 INVALID_REQUEST CURSOR_INVALID");

  // another agency's revision and one that does not exist answer alike; a non-member is refused with its fact
  const foreign = await w.project(w.B, w.clientB);
  const unknown = "0190c7a2-0000-7000-8000-0000000000aa";
  for (const url of [sourceRoutes.revision(foreign.revisionId), sourceRoutes.revision(unknown), sourceRoutes.inspection(foreign.revisionId), sourceRoutes.uploads(unknown), sourceRoutes.upload(unknown), sourceRoutes.selectionManifest(revisionId, unknown)]) {
    assert.equal(outcome(w, await get(url)), "404 NOT_FOUND -", url);
  }
  const denialsBefore = (await w.securityEvents("GET_REVISION")).length;
  assert.equal(outcome(w, await get(sourceRoutes.revision(revisionId), w.stranger)), "404 NOT_FOUND NOT_A_MEMBER");
  assert.deepEqual((await w.securityEvents("GET_REVISION")).slice(denialsBefore).map((f) => [f.outcome, f.reason, f.actorId]), [["DENY", "NOT_A_MEMBER", w.stranger.userId]]);
});

test("GetUploadSession (D-SESSION-2, D-SESSION-4): the session reaches its requester only while the upload is UPLOADING and unexpired, each delivery an ALLOW fact; another operator reads UNAVAILABLE NOT_REQUESTER with a DENY fact and the vault never opens it; a VIEWER is refused 403; after the completion report or a cancellation it is SESSION_NOT_ACTIVE", async () => {
  const { revisionId } = await w.project(w.A, w.clientA);
  const content = csvContent(2, "session-read");
  const r = await reserved(w, revisionId, 1, { bytes: content.byteLength });
  const uploadId = r.data.upload.uploadId;
  const url = sessionUrlOf(r);
  const facts = async () => (await w.securityEvents("READ_UPLOAD_SESSION")).map((f) => [f.outcome, f.reason, f.actorId]);
  const factsBefore = (await facts()).length;
  const opens = () => w.vault.calls().filter((c) => c.operation === "open").length;

  // the requester: the protected session, opened by the vault after the unit of work, the delivery an ALLOW fact
  const opensBefore = opens();
  const own = dataOf<ProtectedSessionView>(await get(sourceRoutes.uploadSession(uploadId)));
  assert.deepEqual(own, { delivery: "PROTECTED_RESPONSE", uploadUrl: url, method: "PUT", applicationExpiresAt: r.data.upload.applicationExpiresAt });
  assert.equal(opens(), opensBefore + 1);
  // another operator of the agency: never the bearer credential; a DENY fact; the vault does not open anything for it
  const other = await get(sourceRoutes.uploadSession(uploadId), w.admin);
  assert.deepEqual(dataOf<ProtectedSessionView>(other), { delivery: "UNAVAILABLE", unavailableReason: "NOT_REQUESTER" });
  assert.ok(!other.text.includes(url));
  assert.equal(opens(), opensBefore + 1);
  // a VIEWER holds no operating role: refused before any read
  assert.equal(outcome(w, await get(sourceRoutes.uploadSession(uploadId), w.viewer)), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  // after the completion report the session is no longer delivered (VERIFYING: the requester's row policy hides the secret)
  const finalized = uploadThrough(w, url, content);
  assert.equal((await complete(w, uploadId, finalized.completionRef)).status, 202);
  assert.deepEqual(dataOf<ProtectedSessionView>(await get(sourceRoutes.uploadSession(uploadId))), { delivery: "UNAVAILABLE", unavailableReason: "SESSION_NOT_ACTIVE" });
  // a cancelled upload's session neither
  const cancelled = await reserved(w, revisionId, 2);
  assert.equal((await call(w, { url: sourceRoutes.cancelUpload(cancelled.data.upload.uploadId), token: w.operator.token, key: freshKey("session-read-cancel"), body: { expectedVersion: 2 } })).status, 200);
  assert.deepEqual(dataOf<ProtectedSessionView>(await get(sourceRoutes.uploadSession(cancelled.data.upload.uploadId))), { delivery: "UNAVAILABLE", unavailableReason: "SESSION_NOT_ACTIVE" });
  assert.equal(opens(), opensBefore + 1, "the vault opened the secret once: for its requester, while UPLOADING");

  assert.deepEqual((await facts()).slice(factsBefore), [
    ["ALLOW", "SESSION_DELIVERED", w.operator.userId],
    ["DENY", "NOT_REQUESTER", w.admin.userId],
    ["DENY", "ROLE_INSUFFICIENT", w.viewer.userId],
  ]);
});

test("PreviewTable (D-SAPI-7): the real preview reader of @kauro/data-plane reads the admitted generation through the storage port and returns at most 20 rows of at most 50 columns, each cell at most 200 characters, never cached; another agency's or another project's table is 404 and a revoked file's table 409 INPUT_NOT_ADMITTED; a generation the storage no longer holds is never previewed", async () => {
  const { revisionId } = await w.project(w.A, w.clientA);
  // a CSV of 60 columns and 30 records whose first cell is 300 characters long
  const labels = Array.from({ length: 60 }, (_, i) => `c${i}`);
  const long = "x".repeat(300);
  const records = Array.from({ length: 30 }, (_, r) => labels.map((_, c) => (r === 0 && c === 0 ? long : `r${r}c${c}`)).join(","));
  const content = new TextEncoder().encode(`${labels.join(",")}\n${records.join("\n")}\n`);
  const file = await uploadAndAdmit(w, revisionId, 1, { content, tables: [{ kind: "CSV_TABLE", visibility: "VISIBLE", columns: labels, rows: 30 }] });
  const tableId = file.tables[0]?.tableId as string;
  const reads = () => w.storage.calls("read").length;
  const readsBefore = reads();

  const preview = dataOf<TablePreviewView>(await get(sourceRoutes.preview(revisionId, tableId), w.viewer));
  assert.equal(reads(), readsBefore + 1, "the admitted generation, read once through the storage port");
  assert.deepEqual([preview.tableId, preview.fileId, preview.truncated], [tableId, file.fileId, true]);
  assert.equal(preview.rows.length, 20, "at most 20 rows");
  assert.ok(preview.rows.every((row) => row.length <= 50), "at most 50 columns");
  assert.ok(preview.rows.every((row) => row.every((cell) => cell === null || [...cell].length <= 200)), "at most 200 characters a cell");
  // the table's own top rows as stored: the header record, then the records; the long cell cut at 200 characters
  assert.deepEqual(preview.rows[0]?.slice(0, 3), ["c0", "c1", "c2"]);
  assert.equal(preview.rows[1]?.[0], long.slice(0, 200));
  assert.equal(preview.rows[2]?.[1], "r1c1");
  assert.deepEqual(preview.columns.map((c) => c.ordinal), Array.from({ length: 50 }, (_, i) => i));

  // another agency's revision, and a table that is not one of this revision's (another project's), answer alike
  const foreign = await w.project(w.B, w.clientB);
  assert.equal(outcome(w, await get(sourceRoutes.preview(foreign.revisionId, tableId))), "404 NOT_FOUND -");
  const other = await w.project(w.A, w.clientA);
  assert.equal(outcome(w, await get(sourceRoutes.preview(other.revisionId, tableId))), "404 NOT_FOUND -");
  // a revoked file's table: no longer an admitted file of the project (INPUT_NOT_ADMITTED), nothing read
  const revoked = await uploadAndAdmit(w, revisionId, 2);
  await revokeAdmission(w, w.A.agencyId, revoked.fileId, "GENERATION_MISSING");
  const readsAtRevoked = reads();
  const refused = await get(sourceRoutes.preview(revisionId, revoked.tables[0]?.tableId as string));
  assert.equal(outcome(w, refused), "409 PRECONDITION_FAILED INPUT_NOT_ADMITTED");
  assert.equal(reads(), readsAtRevoked);
  // a generation the storage no longer holds (deleted out of band) is never previewed from anything else
  const lost = await uploadAndAdmit(w, revisionId, 2);
  const acceptedLocation = w.storage.location("ACCEPTED");
  assert.ok(w.storage.deleteOutOfBand(acceptedLocation, acceptedObjectName(w.A.agencyId as AgencyId, lost.projectId, lost.fileId)));
  assert.equal(outcome(w, await get(sourceRoutes.preview(revisionId, lost.tables[0]?.tableId as string))), "422 INTEGRITY_FAILURE -");
});

test("the edition binds no provider adapter or preview reader (D-SAPI-6): ReserveUpload and PreviewTable answer INTEGRITY_FAILURE SOURCE_SERVICES_UNAVAILABLE, a session read finds nothing to open, and nothing is reserved", async () => {
  const edition = await world({ sources: () => ({ providers: null, preview: null }) });
  try {
    await activate(edition);
    const { revisionId } = await edition.project(edition.A, edition.clientA);
    const uploadsBefore = await edition.count("upload_sessions");
    const objectsBefore = await edition.count("stored_objects");
    const reply = await reserve(edition, revisionId, 1);
    assert.equal(outcome(edition, reply), "422 INTEGRITY_FAILURE SOURCE_SERVICES_UNAVAILABLE");
    assert.equal(await edition.count("upload_sessions"), uploadsBefore, "nothing reserved");
    assert.equal(await edition.count("stored_objects"), objectsBefore);
    assert.equal(await edition.count("command_journal", "operation = 'CMD013'"), 0);
    assert.equal(edition.storage.calls().length, 0, "no provider reached");
    // an admitted table (written by the source-lifecycle fixture of @kauro/persistence/testing as the control plane would): its
    // preview needs the storage adapter and the preview reader, which this edition does not bind
    const other = await edition.project(edition.A, edition.clientA);
    const admitted = await admitSourceFile(fixtureSessions(edition, edition.A), { agencyId: edition.A.agencyId, projectId: other.projectId, ownerUserId: edition.A.ownerUserId, ownerMembershipId: edition.A.ownerMembershipId }, { seed: "edition-preview" });
    const preview = await call(edition, { method: "GET", url: sourceRoutes.preview(admitted.revisionId, admitted.tableId), token: edition.operator.token, key: null, contentType: null });
    assert.equal(outcome(edition, preview), "422 INTEGRITY_FAILURE SOURCE_SERVICES_UNAVAILABLE");
    // the session read of an upload whose secret was never sealed finds nothing to open
    const session = await call(edition, { method: "GET", url: sourceRoutes.uploadSession(admitted.uploadId), token: edition.owner.token, key: null, contentType: null });
    assert.deepEqual(dataOfIn<ProtectedSessionView>(session), { delivery: "UNAVAILABLE", unavailableReason: "SESSION_NOT_ACTIVE" });
    assert.equal(edition.vault.calls().length, 0, "no vault reached");
    const revision = dataOfIn<SourceRevisionView>(await call(edition, { method: "GET", url: sourceRoutes.revision(revisionId), token: edition.operator.token, key: null, contentType: null }));
    assert.equal(revision.state, "DRAFT");
  } finally {
    await edition.stop();
  }
});

function dataOfIn<T>(reply: Reply): T {
  assert.equal(reply.status, 200, reply.text);
  return reply.json<{ data: T }>().data;
}
