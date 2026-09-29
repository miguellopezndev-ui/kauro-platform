// CMD016 SelectInputTables — POST /api/v1/revisions/{revisionId}/selection — AGENCY_OPERATOR, with the selection manifest intake
// POST /api/v1/revisions/{revisionId}/selection-manifests (registry cases CMD016-OK / -DENY / -RACE; docs/design/B07-upload-source-
// lifecycle.md §11 CMD016, D-INTAKE-1, D-SEL-1..4, D-LOCK-1, D-LOCK-2). The real routes and composition root over PostgreSQL 17.
// The selection is the agency's explicit closing of an UPLOADING intake (all_uploads_completed); counting it is the control plane's
// SELECTION_EVALUATION (mandate B07-CONTROL), whose writes source-support performs through the product's adapters. The uploads'
// sessions come from the labelled storage and vault fakes of @kauro/application/testing (SIMULATED). Interleavings by hold points and
// pg_stat_activity; UPLOAD_INSPECTION's decision unit of work is held open as a control-plane transaction (heldAdmission).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { SelectInputTablesView, SourceRevisionView } from "@kauro/application";
import { inventoryHashOf, selectionHashOf, type RevisionId } from "@kauro/domain";
import { PgSourceStore } from "@kauro/persistence";
import { SimulatedCrash, asProblem, call, completed, freshKey, outcome, replayTextOf, rootCause, waitForApiLockWait, world, type Reply, type World } from "./support.js";
import {
  LOCKS,
  activate,
  complete,
  csvContent,
  evaluate,
  exactInstant,
  heldAdmission,
  inventoryHashOfRoute,
  manifestOf,
  reserved,
  revisionOf,
  select,
  sessionUrlOf,
  setSessionLimit,
  sourceRoutes,
  storedManifest,
  submitManifest,
  uploadAndAdmit,
  uploadThrough,
  type DetectedTable,
} from "./source-support.js";
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

const WORKBOOK: ReadonlyArray<DetectedTable> = [
  { kind: "WORKSHEET", name: "Contacts", visibility: "VISIBLE", columns: ["Email", "Name"], rows: 3 },
  { kind: "WORKSHEET", name: "Archive", visibility: "HIDDEN", columns: ["Email"], rows: 2 },
];

async function revisionRow(revisionId: string) {
  const row = await w.row<{ state: string; version: string; selection_manifest_id: string | null; selection_hash: string | null; inventory_hash: string | null; evaluation_hash: string | null }>("dataset_revisions", "revision_id = $1", [revisionId]);
  assert.ok(row);
  return { state: row.state, version: Number(row.version), manifest: row.selection_manifest_id, selectionHash: row.selection_hash, inventoryHash: row.inventory_hash, evaluationHash: row.evaluation_hash };
}

function cancel(uploadId: string, expectedVersion: number): Promise<Reply> {
  return call(w, { url: sourceRoutes.cancelUpload(uploadId), token: w.operator.token, key: freshKey("cmd016-cancel"), body: { expectedVersion } });
}

test("OK: an OPERATOR stores a selection manifest (201, then the same body again → created false) and binds it on the UPLOADING revision — all_uploads_completed, the revision INSPECTING with the selection and inventory hashes, uncounted; SELECTION_EVALUATION then counts it READY_TO_SEAL", async () => {
  const { projectId, revisionId } = await w.project(w.A, w.clientA);
  const csv = await uploadAndAdmit(w, revisionId, 1);
  const workbook = await uploadAndAdmit(w, revisionId, 2, { tables: WORKBOOK });
  const inventoryHash = await inventoryHashOfRoute(w, revisionId);
  assert.equal((await revisionRow(revisionId)).state, "UPLOADING", "admissions never close the intake (D-INTAKE-1)");
  // the agency's explicit choices: both files, the visible sheet and the CSV included, the hidden sheet excluded with its reason
  const document = manifestOf(revisionId, inventoryHash, [{ file: csv }, { file: workbook }], (entry, table) => (table.visibility === "VISIBLE" ? entry : { tableId: entry.tableId, fileId: entry.fileId, structureHash: entry.structureHash, disposition: "EXCLUDE", exclusionReason: "ARCHIVE_SHEET" }));

  // the intake: stored once per content — 201 created, then the same body again answers the stored manifest (200, created false)
  const firstReply = await submitManifest(w, revisionId, document);
  assert.equal(firstReply.status, 201, firstReply.text);
  const first = firstReply.json<{ kind: string; data: { selectionManifestId: string; revisionId: string; bodyHash: string; created: boolean } }>();
  assert.deepEqual([first.kind, first.data.revisionId, first.data.bodyHash, first.data.created], ["STORED", revisionId, selectionHashOf(document), true]);
  const againReply = await submitManifest(w, revisionId, document);
  assert.equal(againReply.status, 200, againReply.text);
  assert.deepEqual(againReply.json<{ data: unknown }>().data, { ...first.data, created: false });
  assert.equal(await w.count("selection_manifests", "revision_id = $1", [revisionId]), 1);
  // stored, not bound: the intake changes no aggregate (no version, no event, no journal entry, D-SEL-2)
  assert.deepEqual(await revisionRow(revisionId), { state: "UPLOADING", version: 2, manifest: null, selectionHash: null, inventoryHash: null, evaluationHash: null });

  const key = freshKey("cmd016-ok");
  const body = completed<SelectInputTablesView>(await select(w, revisionId, 2, first.data.selectionManifestId, { key }), 200);
  // UPLOADING -> INSPECTING (all_uploads_completed: the agency's explicit closing of the intake), version 3, bound and uncounted
  assert.deepEqual([body.version, body.data.revision.state, body.data.revision.version], [3, "INSPECTING", 3]);
  assert.deepEqual(body.data.selection, { selectionManifestId: first.data.selectionManifestId, selectionHash: selectionHashOf(document), includedFileCount: 2, includedTableCount: 2, reusedFileIds: [] });
  assert.deepEqual(body.data.revision.selection?.selectionHash, selectionHashOf(document));
  assert.equal(body.data.revision.selection?.inventoryHash, inventoryHash);
  assert.equal(body.data.revision.populations, undefined, "uncounted until SELECTION_EVALUATION counts it");
  assert.deepEqual(body.data.revision.blockers, ["EVALUATION_PENDING"]);
  assert.deepEqual(await revisionRow(revisionId), { state: "INSPECTING", version: 3, manifest: first.data.selectionManifestId, selectionHash: selectionHashOf(document), inventoryHash, evaluationHash: null });
  const selectedAt = await exactInstant(w, "SELECT selected_at FROM kauro.dataset_revisions WHERE revision_id = $1", [revisionId]);
  assert.equal(body.data.revision.selection?.selectedAt, new Date(Date.parse(selectedAt)).toISOString());
  // one event with the previous state, routed to SELECTION_EVALUATION with the keys its consumer reads
  const event = (await w.events("dataset_revision", revisionId)).at(-1);
  assert.deepEqual([event?.version, event?.type], [3, "dataset_revision.selection_changed.v1"]);
  assert.deepEqual(event?.payload, {
    revisionId,
    agencyId: w.A.agencyId,
    projectId,
    selectionManifestId: first.data.selectionManifestId,
    selectionHash: selectionHashOf(document),
    inventoryHash,
    previousState: "UPLOADING",
    state: "INSPECTING",
    includedFileCount: 2,
    includedTableCount: 2,
    reusedFileIds: [],
  });
  assert.deepEqual(await w.outbox(event?.eventId as string), ["SELECTION_EVALUATION"]);
  const journal = await w.journal(key);
  assert.deepEqual(journal && [journal.state, journal.status, journal.resourceKind, journal.resourceId], ["COMMITTED", 200, "dataset_revision", revisionId]);
  // the stored manifest is readable as stored (GetSelectionManifest)
  const stored = await call(w, { method: "GET", url: sourceRoutes.selectionManifest(revisionId, first.data.selectionManifestId), token: w.viewer.token, key: null, contentType: null });
  assert.deepEqual(stored.json<{ data: { document: unknown; bodyHash: string } }>().data.document, document);

  // SELECTION_EVALUATION counts the bound selection at the admitted generations: INSPECTING -> READY_TO_SEAL with its counts
  const counted = await evaluate(w, w.A.agencyId, revisionId, [csv, workbook]);
  assert.equal(counted.version, 4);
  const ready: SourceRevisionView = await revisionOf(w, revisionId);
  assert.deepEqual([ready.state, ready.version, ready.evaluationHash, ready.populations], ["READY_TO_SEAL", 4, counted.evaluationHash, { physicalSourceRows: 6, logicalSourceRecords: 6, billableSourceUnits: 6, associationEdges: 0 }]);
  assert.deepEqual(ready.permittedActions, ["CreateRevision", "SelectInputTables", "SealRevision"]);
});

test("DENY: a manifest made against another inventory → 409 SELECTION_STALE; a hidden worksheet included without acknowledgement → 400 HIDDEN_SHEET_NOT_ACKNOWLEDGED; an undisposed table → 400 SELECTION_INCOMPLETE; uploads in flight → 409 UPLOADS_UNRESOLVED; VIEWER → 403; foreign → 404", async () => {
  const { revisionId } = await w.project(w.A, w.clientA);
  const csv = await uploadAndAdmit(w, revisionId, 1);
  const workbook = await uploadAndAdmit(w, revisionId, 2, { tables: WORKBOOK });
  const inventoryHash = await inventoryHashOfRoute(w, revisionId);
  const files = [{ file: csv }, { file: workbook }];
  const acknowledged = manifestOf(revisionId, inventoryHash, files, (entry, table) => (table.visibility === "VISIBLE" ? entry : { ...entry, hiddenSheetAcknowledged: true }));
  const hidden = manifestOf(revisionId, inventoryHash, files);
  const incomplete = manifestOf(revisionId, inventoryHash, files, (entry, table) => (table.visibility === "VISIBLE" ? entry : null));
  const ok = await storedManifest(w, revisionId, acknowledged);
  const hiddenStored = await storedManifest(w, revisionId, hidden);
  const incompleteStored = await storedManifest(w, revisionId, { ...incomplete, projections: incomplete.projections });
  const foreign = await w.project(w.B, w.clientB);
  const before = await revisionRow(revisionId);
  const selectionsBefore = await w.count("domain_events", "event_type = 'dataset_revision.selection_changed.v1'");
  const denialsBefore = (await w.securityEvents("CMD016")).length;

  // a hidden worksheet is never included silently: its inclusion needs the agency's explicit acknowledgement
  assert.equal(outcome(w, await select(w, revisionId, 2, hiddenStored.selectionManifestId)), "400 INVALID_REQUEST HIDDEN_SHEET_NOT_ACKNOWLEDGED");
  // every table of an included file carries an explicit disposition: a missing one invalidates the selection
  assert.equal(outcome(w, await select(w, revisionId, 2, incompleteStored.selectionManifestId)), "400 INVALID_REQUEST SELECTION_INCOMPLETE");
  // the role (a durable DENY fact) and another agency's revision (answered as a missing one)
  assert.equal(outcome(w, await select(w, revisionId, 2, ok.selectionManifestId, { person: w.viewer })), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.equal(outcome(w, await select(w, foreign.revisionId, 1, ok.selectionManifestId)), "404 NOT_FOUND -");
  // an upload in flight: the inventory is not settled, the selection waits for it (D-SEL-3)
  const inFlight = await reserved(w, revisionId, 2);
  const unresolved = await select(w, revisionId, 2, ok.selectionManifestId);
  assert.equal(outcome(w, unresolved), "409 PRECONDITION_FAILED UPLOADS_UNRESOLVED");
  assert.deepEqual(asProblem(w, unresolved).current, { version: 2, state: "UPLOADING" });
  // settled again by its cancellation, the inventory is no longer the one the manifest was made against: a changed inventory
  // invalidates the selection (catalogue CMD016 failure)
  assert.equal((await cancel(inFlight.data.upload.uploadId, 2)).status, 200);
  assert.notEqual(await inventoryHashOfRoute(w, revisionId), inventoryHash);
  const stale = await select(w, revisionId, 2, ok.selectionManifestId);
  assert.equal(outcome(w, stale), "409 PRECONDITION_FAILED SELECTION_STALE");
  assert.deepEqual(asProblem(w, stale).current, { version: 2, state: "UPLOADING" });

  // no binding after any denial: the revision UPLOADING at version 2 without a selection, no selection event; the viewer's fact
  assert.deepEqual(await revisionRow(revisionId), before);
  assert.equal(await w.count("domain_events", "event_type = 'dataset_revision.selection_changed.v1'"), selectionsBefore);
  assert.deepEqual((await w.securityEvents("CMD016")).slice(denialsBefore).map((f) => [f.outcome, f.reason, f.actorId]), [["DENY", "ROLE_INSUFFICIENT", w.viewer.userId]]);
  // the control: the same agency's manifest made against the settled inventory binds
  const current = manifestOf(revisionId, await inventoryHashOfRoute(w, revisionId), files, (entry, table) => (table.visibility === "VISIBLE" ? entry : { ...entry, hiddenSheetAcknowledged: true }));
  const bound = completed<SelectInputTablesView>(await select(w, revisionId, 2, (await storedManifest(w, revisionId, current)).selectionManifestId), 200);
  assert.equal(bound.data.revision.state, "INSPECTING");
});

test("RACE: two selections on one version → one 200, one 409 STALE_VERSION; identical retry replays; the same key with another manifest → 409; a selection racing the admission of the last open upload waits on the revision row and binds the settled inventory; a crash leaves the previous selection bound", async () => {
  // two selections of version 2: the first held before its journal commit (the revision row locked, bound), the second observed
  // waiting on the revision row; the first commits, the second reads version 3: STALE_VERSION
  const one = await w.project(w.A, w.clientA);
  const file = await uploadAndAdmit(w, one.revisionId, 1);
  const document = manifestOf(one.revisionId, await inventoryHashOfRoute(w, one.revisionId), [{ file }]);
  const manifest = await storedManifest(w, one.revisionId, document);
  const keyA = freshKey("cmd016-race-a");
  const hold = w.holds.arm("journal.commit");
  const a = select(w, one.revisionId, 2, manifest.selectionManifestId, { key: keyA });
  let b: Promise<Reply> | undefined;
  try {
    await reachedHold(hold, a);
    b = select(w, one.revisionId, 2, manifest.selectionManifestId, { key: freshKey("cmd016-race-b") });
    await waitForApiLockWait(w, LOCKS.revision);
  } finally {
    hold.release();
  }
  const [first, second] = await Promise.all([a, b as Promise<Reply>]);
  assert.equal(completed<SelectInputTablesView>(first, 200).data.revision.version, 3);
  assert.equal(outcome(w, second), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, second).current, { version: 3, state: "INSPECTING" });
  assert.equal(await w.count("domain_events", "aggregate_id = $1 AND event_type = 'dataset_revision.selection_changed.v1'", [one.revisionId]), 1, "one selection event per version");
  // identical retry replays; the same key with another manifest is a typed conflict with no effect
  const replay = await select(w, one.revisionId, 2, manifest.selectionManifestId, { key: keyA });
  assert.equal(replay.status, 200);
  assert.equal(replay.text, replayTextOf(first));
  const other = await storedManifest(w, one.revisionId, { ...document, projections: [] });
  assert.equal(outcome(w, await select(w, one.revisionId, 2, other.selectionManifestId, { key: keyA })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal((await revisionRow(one.revisionId)).manifest, manifest.selectionManifestId);

  // the admission of the revision's last open upload is held by UPLOAD_INSPECTION (the control plane holds the revision row with the
  // file admitted, uncommitted); the agency's selection, made against the inventory that admission settles, is observed waiting on
  // the revision row; the admission commits; the selection then reads the settled inventory — nothing in flight — and binds it
  const two = await w.project(w.A, w.clientA);
  const settledFile = await uploadAndAdmit(w, two.revisionId, 1);
  const content = csvContent(3, "cmd016-race-last");
  const last = await reserved(w, two.revisionId, 2, { bytes: content.byteLength });
  const finalized = uploadThrough(w, sessionUrlOf(last), content);
  assert.equal((await complete(w, last.data.upload.uploadId, finalized.completionRef)).status, 202);
  const { writer, admitted } = await heldAdmission(w, w.A, last.data.upload.uploadId, finalized);
  let selecting: Promise<Reply> | undefined;
  try {
    // the inventory the held admission settles, read inside it (the control plane reads ids and hashes, never customer text)
    const settledHash = inventoryHashOf(await new PgSourceStore(writer.client, "CONTROL").revisions.inventory(two.revisionId as RevisionId));
    const settledDocument = manifestOf(two.revisionId, settledHash, [{ file: settledFile }, { file: admitted }]);
    const settledManifest = await storedManifest(w, two.revisionId, settledDocument);
    selecting = select(w, two.revisionId, 2, settledManifest.selectionManifestId);
    await waitForApiLockWait(w, LOCKS.revision);
    await writer.commit();
  } finally {
    await writer.close();
  }
  const bound = completed<SelectInputTablesView>(await (selecting as Promise<Reply>), 200);
  assert.deepEqual([bound.data.revision.state, bound.data.revision.version, bound.data.selection.includedFileCount], ["INSPECTING", 3, 2]);
  assert.equal((await w.row<{ state: string }>("upload_sessions", "upload_id = $1", [last.data.upload.uploadId]))?.state, "ADMITTED");
  const boundEvent = (await w.events("dataset_revision", two.revisionId)).at(-1);
  assert.deepEqual([boundEvent?.type, boundEvent?.payload["previousState"]], ["dataset_revision.selection_changed.v1", "UPLOADING"]);

  // a crash before COMMIT of a rebinding (INSPECTING stays INSPECTING under another selection): the previous selection stays bound
  const boundRow = await revisionRow(two.revisionId);
  const rebinding = manifestOf(two.revisionId, boundRow.inventoryHash as string, [{ file: settledFile }, { file: admitted }], (entry, table) => (table.tableId === admitted.tables[0]?.tableId ? { tableId: entry.tableId, fileId: entry.fileId, structureHash: entry.structureHash, disposition: "EXCLUDE", exclusionReason: "DUPLICATE_EXPORT" } : entry));
  const rebindingDocument = { ...rebinding, files: rebinding.files.map((f) => (f.fileId === admitted.fileId ? { fileId: f.fileId, origin: f.origin, disposition: "EXCLUDE" as const, exclusionReason: "DUPLICATE_EXPORT" } : f)) };
  const rebound = await storedManifest(w, two.revisionId, rebindingDocument);
  const crashKey = freshKey("cmd016-crash");
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await select(w, two.revisionId, 3, rebound.selectionManifestId, { key: crashKey });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.equal(rootCause(w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true);
  assert.deepEqual(await revisionRow(two.revisionId), boundRow);
  assert.equal(await w.journal(crashKey), null);
  assert.equal(await w.count("domain_events", "aggregate_id = $1 AND event_type = 'dataset_revision.selection_changed.v1'", [two.revisionId]), 1);
  // the same key is then the first execution: the rebinding commits once (selection_rebound, the revision stays INSPECTING)
  const retried = completed<SelectInputTablesView>(await select(w, two.revisionId, 3, rebound.selectionManifestId, { key: crashKey }), 200);
  assert.deepEqual([retried.replayed, retried.data.revision.state, retried.data.revision.version, retried.data.selection.includedFileCount], [false, "INSPECTING", 4, 1]);
});
