// The source lifecycle end to end on b07/integration (design §15: "the end-to-end cases of the case map run there"; decision D-INT-1):
// every request is the application's own handler of CMD012..CMD017, a source read or the selection manifest intake on B06's
// pipeline, as apps/api binds them, each answer checked against its route's response contract as the transport checks it
// (support/product.ts); every continuation is this package's dispatcher, consumers and sweepers — both halves over one real
// PostgreSQL 17 cluster (kauro_app_test for the requests, kauro_control_test for the control plane) and one set of labelled contract
// fakes (object storage, session vault, authority journal of @kauro/application/testing; the malware scanner of
// @kauro/data-plane/testing — CONTRACT FAKES, evidence class SIMULATED). The platform's parsers are real. What each half writes is what
// the other half reads: the event payloads, the recorded claim, the sealed bearer record and its binding, the provider horizon, the
// quarantine name and location, the receipt, the file and its frozen inventory. Instants in the past only through the labelled TEST
// CLOCK of a fixture's own transaction; the oracle is the superuser.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { SOURCE_ROUTES, type CancelUploadView, type CreateRevisionView, type InspectionView, type ReserveUploadView, type SealRevisionView, type SelectInputTablesView, type SelectionManifestIntakeView, type SourceRevisionView, type TablePreviewView, type UploadPage, type UploadView } from "@kauro/application";
import { inventoryHashOf, selectionHashOf, textDigest, type AgencyId, type RevisionId } from "@kauro/domain";
import { completionRefOf } from "@kauro/application/testing";
import { fixtureSelection } from "@kauro/persistence/testing";
import { clock, startControlEnv, type ControlEnv } from "./support/env.js";
import { asOwner, issue, oracle, oracleRows, project, reserve, setSessionLimit, tenant, type Tenant } from "./support/fixtures.js";
import { activate, completedView, problemOf, product, type Product } from "./support/product.js";
import { buildCsv, buildWorkbook } from "./support/workbook.js";

let env: ControlEnv;
let app: Product;

const HOUR_MS = 3_600_000;
/** The consumers of the source lifecycle this package implements (the NOTIFICATIONS and EXECUTION_CONTROL records are later packages'). */
const SOURCE_CONSUMERS = ["UPLOAD_INSPECTION", "SELECTION_EVALUATION", "STORAGE_LIFECYCLE", "AUTHORITY_JOURNAL"];

before(async () => {
  env = await startControlEnv();
  app = product(env);
  // the location read-back comes first: a deletion is never recorded at a location never read back (D-OBJ-2)
  await env.plane.sweepers.locationPolicy.sweep(env.plane.units, 10);
});

after(async () => {
  await env.stop();
});

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function csv(label: string, rows = 3): Uint8Array {
  return buildCsv(["Email", "Name"], Array.from({ length: rows }, (_, i) => [`${label}-${i}@example.test`, `${label} ${i}`]));
}

async function activeTenant(label: string): Promise<Tenant> {
  const t = await tenant(env, label);
  await activate(env, t);
  await setSessionLimit(env, t, 10);
  return t;
}

async function versionOf(table: "dataset_revisions" | "projects", column: "revision_id" | "project_id", id: string): Promise<number> {
  return Number((await oracle<{ version: string }>(env, `SELECT version::text AS version FROM kauro.${table} WHERE ${column} = $1`, [id])).version);
}

/** CMD013 through its handler: the reservation and the session the requester's browser receives. */
async function reserveUpload(t: Tenant, revisionId: string, content: Uint8Array, format: "CSV" | "XLSX" = "CSV"): Promise<{ readonly view: ReserveUploadView; readonly sessionUrl: string }> {
  const view = completedView<ReserveUploadView>(
    await app.command(t, "CMD013", { revisionId }, { expectedVersion: await versionOf("dataset_revisions", "revision_id", revisionId), declaredBytes: content.length, declaredFormat: format, displayName: format === "CSV" ? "contacts export.csv" : "contacts workbook.xlsx" }),
    201,
  );
  const session = view.session as { readonly delivery: string; readonly uploadUrl?: string };
  assert.equal(session.delivery, "PROTECTED_RESPONSE", "the session reaches its requester");
  assert.ok(typeof session.uploadUrl === "string");
  return { view, sessionUrl: session.uploadUrl };
}

/** The browser's upload through the provider session (the labelled storage fake): the completion reference it forwards. */
function browserUpload(sessionUrl: string, content: Uint8Array): { readonly generation: string; readonly completionRef: string } {
  const written = env.storage.uploadThroughSession(sessionUrl, content);
  assert.equal(written.outcome, "FINALIZED", JSON.stringify(written));
  if (written.outcome !== "FINALIZED") throw new Error("unreachable");
  return { generation: written.generation, completionRef: written.completionRef };
}

/** Every consumer's due records dispatched: none retried, none dead-lettered. */
async function drainAll(): Promise<Record<string, number>> {
  const delivered: Record<string, number> = {};
  for (const consumer of [env.plane.consumers.uploadInspection, env.plane.consumers.selectionEvaluation, env.plane.consumers.storageLifecycle, env.plane.consumers.authorityJournal]) {
    const counts = await env.plane.drain(consumer, clock.now());
    assert.deepEqual([counts.retried, counts.deadLettered], [0, 0], `${consumer.consumer}: nothing retried or dead-lettered`);
    delivered[consumer.consumer] = counts.delivered;
  }
  return delivered;
}

/** Every outbox record of the agency's source-lifecycle consumers is DELIVERED (nothing pending, retried or dead-lettered). */
async function assertEverythingDelivered(agencyId: string): Promise<void> {
  const open = await oracleRows<{ consumer: string; event_type: string; state: string; last_error_code: string | null }>(
    env,
    `SELECT o.consumer, e.event_type, o.state, o.last_error_code FROM kauro.outbox_records o JOIN kauro.domain_events e ON e.event_id = o.event_id
      WHERE e.agency_id = $1 AND o.consumer = ANY($2::text[]) AND o.state <> 'DELIVERED' ORDER BY e.sequence`,
    [agencyId, SOURCE_CONSUMERS],
  );
  assert.deepEqual(open, [], "every record the handlers and the control plane produced for a source-lifecycle consumer was delivered");
}

test("b07/integration end to end: ReserveUpload, the browser's upload through its session, CompleteUpload, UPLOAD_INSPECTION, the manifest intake, SelectInputTables, SELECTION_EVALUATION and SealRevision compose — each command through the application's handler on B06's pipeline, each continuation through the control plane's dispatcher, every answer and every source read over the control plane's rows within its route's contract — and the seal names the generation the control plane observed and promoted; CreateRevision over it is tombstoned REVISION_SUPERSEDED", { timeout: 300_000 }, async () => {
  const t = await activeTenant("e2e-seal");
  const p = await project(env, t);
  const content = csv("seal", 4);

  // CMD013 → the browser → CMD014: the request records the browser's claim and answers 202; nothing is admitted by it
  const reserved = await reserveUpload(t, p.revisionId, content);
  const uploadId = reserved.view.upload.uploadId;
  const written = browserUpload(reserved.sessionUrl, content);
  const accepted = await app.command(t, "CMD014", { uploadId }, { providerCompletionRef: written.completionRef });
  assert.equal(accepted.kind, "ACCEPTED", JSON.stringify(accepted));
  if (accepted.kind !== "ACCEPTED") throw new Error("unreachable");
  assert.deepEqual([accepted.status, accepted.operationId, accepted.state], [202, uploadId, "VERIFYING"]);
  assert.equal(accepted.statusPath, SOURCE_ROUTES.GetUpload.path.replace("{uploadId}", uploadId), "the status path is the GetUpload route");

  // UPLOAD_INSPECTION reads the handler's event (uploadId, revisionId), its recorded claim and the quarantine name CMD013 registered
  assert.deepEqual(await drainAll(), { UPLOAD_INSPECTION: 1, SELECTION_EVALUATION: 0, STORAGE_LIFECYCLE: 0, AUTHORITY_JOURNAL: 0 });
  const upload = await oracle<{ state: string; observed_generation: string; observed_bytes: string; file_id: string; inspection_receipt_hash: string; secrets: string }>(
    env,
    "SELECT state, observed_generation, observed_bytes::text, file_id, inspection_receipt_hash, (SELECT count(*) FROM kauro.upload_session_secrets s WHERE s.upload_id = u.upload_id)::text AS secrets FROM kauro.upload_sessions u WHERE upload_id = $1",
    [uploadId],
  );
  assert.deepEqual([upload.state, upload.observed_generation, Number(upload.observed_bytes), upload.secrets], ["ADMITTED", written.generation, content.length, "0"], "admitted at the generation the provider holds; the finalized session's bearer record purged");
  const file = await oracle<{ file_id: string; provider_generation: string; sha256: string; bytes: string; table_id: string; structure_hash: string }>(
    env,
    "SELECT f.file_id, f.provider_generation, f.sha256, f.bytes::text, t.table_id, t.structure_hash FROM kauro.source_files f JOIN kauro.source_tables t ON t.file_id = f.file_id WHERE f.origin_upload_id = $1 AND f.state = 'ADMITTED'",
    [uploadId],
  );
  assert.equal(file.file_id, upload.file_id);
  assert.deepEqual([file.sha256, Number(file.bytes)], [sha256(content), content.length]);

  // the reads over what the control plane wrote: the status path, the uploads, the inspection with the frozen inventory, the preview
  const polled = await app.read<UploadView>(t, "GetUpload", { uploadId });
  assert.deepEqual([polled.state, polled.inspectionReceiptHash], ["ADMITTED", upload.inspection_receipt_hash]);
  const page = await app.read<UploadPage>(t, "ListUploads", { revisionId: p.revisionId });
  assert.deepEqual(page.items.map((u) => [u.uploadId, u.state]), [[uploadId, "ADMITTED"]]);
  const inspection = await app.read<InspectionView>(t, "GetInspection", { revisionId: p.revisionId });
  assert.equal(inspection.revision.state, "UPLOADING", "the intake stays open until the agency's selection closes it (D-INTAKE-1)");
  assert.deepEqual(
    inspection.files.map((f) => [f.fileId, f.sha256, f.bytes, f.scanState, f.admitted, f.tables.map((x) => [x.tableId, x.kind, x.columnCount, x.structureHash])]),
    [[file.file_id, sha256(content), content.length, "COVERED_CLEAN", true, [[file.table_id, "CSV_TABLE", 2, file.structure_hash]]]],
  );
  const inventoryHash = inventoryHashOf(await env.h.app.runSource(asOwner(env, t), (uow) => uow.sources.revisions.inventory(p.revisionId as RevisionId)));
  assert.equal(inspection.inventoryHash, inventoryHash);
  const preview = await app.read<TablePreviewView>(t, "PreviewTable", { revisionId: p.revisionId, tableId: file.table_id });
  assert.deepEqual([preview.fileId, preview.rows.length, preview.truncated], [file.file_id, 5, false], "the real preview reader reads the promoted generation (the header record and four rows)");

  // the manifest intake and CMD016 against the revision's current inventory: the agency closes the intake
  const document = fixtureSelection(p.revisionId, { fileId: file.file_id, tableId: file.table_id, structureHash: file.structure_hash, origin: "THIS_REVISION" }, inventoryHash);
  const stored = await app.submitManifest<SelectionManifestIntakeView>(t, p.revisionId, document);
  assert.equal(stored.created, true);
  const selected = completedView<SelectInputTablesView>(
    await app.command(t, "CMD016", { revisionId: p.revisionId }, { expectedVersion: await versionOf("dataset_revisions", "revision_id", p.revisionId), selectionManifestRef: stored.view.selectionManifestId }),
    200,
  );
  assert.equal(selected.revision.state, "INSPECTING");
  assert.equal(selected.selection.selectionHash, selectionHashOf(document));

  // SELECTION_EVALUATION reads the handler's event (revisionId, selectionManifestId, selectionHash) and counts the admitted bytes
  assert.deepEqual(await drainAll(), { UPLOAD_INSPECTION: 0, SELECTION_EVALUATION: 1, STORAGE_LIFECYCLE: 0, AUTHORITY_JOURNAL: 0 });
  const counted = await app.read<InspectionView>(t, "GetInspection", { revisionId: p.revisionId });
  assert.equal(counted.revision.state, "READY_TO_SEAL");
  assert.deepEqual([counted.evaluation?.result, counted.evaluation?.populations?.physicalSourceRows, counted.evaluation?.populations?.billableSourceUnits], ["COMPLETE", 4, 4], "every row of the admitted bytes counted by the real evaluator");

  // CMD017: the seal commits the manifest and the file set at exactly the generation the control plane observed, promoted and verified
  const sealed = completedView<SealRevisionView>(
    await app.command(t, "CMD017", { revisionId: p.revisionId }, { expectedVersion: await versionOf("dataset_revisions", "revision_id", p.revisionId), selectionHash: selectionHashOf(document) }),
    200,
  );
  assert.equal(sealed.revision.state, "SEALED");
  const sealedFile = await oracle<{ provider_generation: string; sha256: string; disposition: string; accepted_generation: string; accepted_state: string; object_name: string }>(
    env,
    `SELECT s.provider_generation, s.sha256, s.disposition, o.generation AS accepted_generation, o.state AS accepted_state, o.object_name
       FROM kauro.sealed_revision_files s JOIN kauro.source_files f ON f.file_id = s.file_id JOIN kauro.stored_objects o ON o.object_id = f.accepted_object_id
      WHERE s.revision_id = $1`,
    [p.revisionId],
  );
  assert.deepEqual([sealedFile.provider_generation, sealedFile.sha256, sealedFile.disposition, sealedFile.accepted_state], [file.provider_generation, sha256(content), "INCLUDED", "VERIFIED"]);
  assert.equal(sealedFile.accepted_generation, file.provider_generation, "the sealed generation is the accepted copy the control plane promoted");
  assert.deepEqual(
    env.storage.generationsOf(env.storage.location("ACCEPTED"), sealedFile.object_name).map((g) => [g.generation, g.sha256, g.status]),
    [[file.provider_generation, sha256(content), "LIVE"]],
    "the provider holds exactly the sealed generation",
  );
  const revision = await app.read<SourceRevisionView>(t, "GetRevision", { revisionId: p.revisionId });
  assert.deepEqual([revision.state, revision.seal?.manifestHash], ["SEALED", sealed.manifestHash]);

  // CMD012 replaces the SEALED revision: AUTHORITY_JOURNAL reads the handler's superseded event and tombstones it
  const replaced = completedView<CreateRevisionView>(
    await app.command(t, "CMD012", { projectId: p.projectId }, { expectedVersion: await versionOf("projects", "project_id", p.projectId), supersedesRevisionId: p.revisionId }),
    201,
  );
  assert.deepEqual([replaced.predecessor.state, replaced.revision.state], ["SUPERSEDED", "DRAFT"]);
  assert.deepEqual(await drainAll(), { UPLOAD_INSPECTION: 0, SELECTION_EVALUATION: 0, STORAGE_LIFECYCLE: 0, AUTHORITY_JOURNAL: 1 });
  const tombstones = await env.journal.list(t.ag.agencyId as AgencyId, 0);
  assert.deepEqual(tombstones.map((x) => [x.kind, x.state, x.subjectId, x.revisionId]), [["REVISION_SUPERSEDED", "SUPERSEDED", p.revisionId, p.revisionId]]);
  await assertEverythingDelivered(t.ag.agencyId);
});

test("b07/integration end to end: CancelUpload and a CreateRevision over a mutable revision with an upload in flight reach STORAGE_LIFECYCLE and AUTHORITY_JOURNAL — each provider session the handler issued and sealed is cancelled with the reference the vault opens under the handler's binding, the answer recorded and the bearer record purged; a late object written through the replaced revision's session is registered RESIDUAL and deleted by generation; the tombstones of both cancelled uploads and of the cancelled revision are appended once each, and the late CompleteUpload is 409 UPLOAD_CANCELLED", { timeout: 300_000 }, async () => {
  const t = await activeTenant("e2e-cancel");
  const p = await project(env, t);

  // CMD013 then CMD015: the requester cancels; the database requests the provider cancellation with the tombstone (D-ROLE-3)
  const first = await reserveUpload(t, p.revisionId, csv("first"));
  const cancelled = completedView<CancelUploadView>(await app.command(t, "CMD015", { uploadId: first.view.upload.uploadId }, { expectedVersion: first.view.upload.version }), 200);
  assert.equal(cancelled.upload.state, "CANCELLED");
  // a second upload in flight when CMD012 replaces the mutable revision: its tombstone is the replacement's (REVISION_REPLACED)
  const late = csv("late");
  const second = await reserveUpload(t, p.revisionId, late);
  const replaced = completedView<CreateRevisionView>(
    await app.command(t, "CMD012", { projectId: p.projectId }, { expectedVersion: await versionOf("projects", "project_id", p.projectId), supersedesRevisionId: p.revisionId }),
    201,
  );
  assert.deepEqual([replaced.predecessor.state, replaced.cancelledUploadIds], ["CANCELLED", [second.view.upload.uploadId]]);
  for (const up of [first, second]) {
    const row = await app.read<UploadView>(t, "GetUpload", { uploadId: up.view.upload.uploadId });
    assert.deepEqual([row.state, row.providerCancellationState], ["CANCELLED", "REQUESTED"]);
  }
  // the provider session outlives the application's tombstone until the control plane cancels it: a late object lands in quarantine
  const lateObject = browserUpload(second.sessionUrl, late);

  // STORAGE_LIFECYCLE: the two upload tombstones and the revision's; AUTHORITY_JOURNAL: the three terminal facts
  assert.deepEqual(await drainAll(), { UPLOAD_INSPECTION: 0, SELECTION_EVALUATION: 0, STORAGE_LIFECYCLE: 3, AUTHORITY_JOURNAL: 3 });
  const cancellations = env.storage.calls("cancelResumableSession").map((c) => c.request["sessionDigest"]);
  for (const up of [first, second]) {
    assert.ok(cancellations.includes(textDigest(up.sessionUrl)), "the provider was asked to cancel the very session the handler issued (the vault opened the handler's sealed reference)");
    const row = await oracle<{ provider_cancellation_state: string; secrets: string }>(
      env,
      "SELECT provider_cancellation_state, (SELECT count(*) FROM kauro.upload_session_secrets s WHERE s.upload_id = u.upload_id)::text AS secrets FROM kauro.upload_sessions u WHERE upload_id = $1",
      [up.view.upload.uploadId],
    );
    assert.deepEqual([row.provider_cancellation_state, row.secrets], ["CONFIRMED", "0"], "the provider's answer recorded and the bearer record purged");
    assert.equal((await app.read<UploadView>(t, "GetUpload", { uploadId: up.view.upload.uploadId })).providerCancellationState, "CONFIRMED");
  }
  assert.equal(env.storage.sessionView(first.sessionUrl)?.usable, false, "the open session was cancelled at the provider");
  const residual = await oracle<{ zone: string; data_class: string; late: boolean; state: string; deletion_result: string; object_name: string }>(
    env,
    "SELECT zone, data_class, late, state, deletion_result, object_name FROM kauro.stored_objects WHERE upload_id = $1 AND generation = $2",
    [second.view.upload.uploadId, lateObject.generation],
  );
  assert.deepEqual([residual.zone, residual.data_class, residual.late, residual.state, residual.deletion_result], ["QUARANTINE", "RESIDUAL", true, "DELETED", "DELETED"]);
  assert.equal(env.storage.generationsOf(env.storage.location("QUARANTINE"), residual.object_name).find((g) => g.generation === lateObject.generation)?.status, "SOFT_DELETED", "deleted at the provider by its exact generation");
  const neverObserved = await oracle<{ state: string; deletion_result: string }>(env, "SELECT state, deletion_result FROM kauro.stored_objects WHERE upload_id = $1", [first.view.upload.uploadId]);
  assert.deepEqual([neverObserved.state, neverObserved.deletion_result], ["DELETED", "ALREADY_ABSENT"], "a name the browser never wrote is closed by its absence");
  const tombstones = await env.journal.list(t.ag.agencyId as AgencyId, 0);
  assert.deepEqual(
    tombstones.map((x) => [x.kind, x.state, x.subjectId]),
    [
      ["UPLOAD_ACCEPTANCE_REVOKED", "CANCELLED", first.view.upload.uploadId],
      ["UPLOAD_ACCEPTANCE_REVOKED", "CANCELLED", second.view.upload.uploadId],
      ["REVISION_CANCELLED", "CANCELLED", p.revisionId],
    ],
  );

  // the requester's completion report of the late object: refused, nothing of it inspected or admitted
  const lateReport = await app.command(t, "CMD014", { uploadId: second.view.upload.uploadId }, { providerCompletionRef: lateObject.completionRef });
  assert.deepEqual(problemOf(lateReport), { status: 409, code: "PRECONDITION_FAILED", reason: "UPLOAD_CANCELLED" });
  assert.equal((await oracle<{ n: string }>(env, "SELECT count(*)::text AS n FROM kauro.source_files WHERE origin_upload_id = ANY($1::uuid[])", [[first.view.upload.uploadId, second.view.upload.uploadId]])).n, "0");
  await assertEverythingDelivered(t.ag.agencyId);
});

test("FINAL-N3 on b07/integration: R2-051 across both halves — a reservation initiated twenty-five hours ago on the labelled TEST CLOCK is expired by UPLOAD_DEADLINES on the server clock while its provider session stays usable; the requester's late CompleteUpload of an object written through that session afterwards is 409 RESERVATION_EXPIRED through the CMD014 handler, STORAGE_LIFECYCLE cancels the session and deletes the late object by generation as a RESIDUAL, AUTHORITY_JOURNAL appends the expired upload's tombstone, and nothing of it is admitted", { timeout: 300_000 }, async () => {
  const t = await activeTenant("e2e-late");
  const p = await project(env, t);
  const content = csv("late", 2);
  // CMD013's writes stand in the past only through the labelled TEST CLOCK of their own transactions (the provider clock pinned alike)
  const initiated = new Date(Date.now() - 25 * HOUR_MS);
  const up = await reserve(env, t, p, content.length, "CSV", initiated);
  const sessionUrl = await issue(env, t, up, initiated);

  // UPLOAD_DEADLINES on the server clock, never early; the provider session outlives the application's tombstone
  const swept = await env.plane.sweepers.uploadDeadlines.sweep(env.plane.units, 100);
  assert.deepEqual([swept.acted, swept.failed], [1, []]);
  assert.deepEqual(await oracle(env, "SELECT state, provider_cancellation_state FROM kauro.upload_sessions WHERE upload_id = $1", [up.uploadId]), { state: "EXPIRED", provider_cancellation_state: "REQUESTED" });
  assert.equal(env.storage.sessionView(sessionUrl)?.usable, true, "the provider session is still usable after the application deadline");

  // a late completion through the session, and the requester's report of it through the CMD014 handler: refused, nothing recorded
  const lateObject = browserUpload(sessionUrl, content);
  const late = await app.command(t, "CMD014", { uploadId: up.uploadId }, { providerCompletionRef: lateObject.completionRef });
  assert.deepEqual(problemOf(late), { status: 409, code: "PRECONDITION_FAILED", reason: "RESERVATION_EXPIRED" });
  assert.deepEqual(await oracle(env, "SELECT state, completion_claim_digest FROM kauro.upload_sessions WHERE upload_id = $1", [up.uploadId]), { state: "EXPIRED", completion_claim_digest: null });

  // the continuations of the expiry: the session cancelled and recorded, the late object RESIDUAL and deleted, the tombstone appended
  assert.deepEqual(await drainAll(), { UPLOAD_INSPECTION: 0, SELECTION_EVALUATION: 0, STORAGE_LIFECYCLE: 1, AUTHORITY_JOURNAL: 1 });
  assert.deepEqual(
    await oracle(env, "SELECT provider_cancellation_state, (SELECT count(*) FROM kauro.upload_session_secrets s WHERE s.upload_id = u.upload_id)::text AS secrets FROM kauro.upload_sessions u WHERE upload_id = $1", [up.uploadId]),
    { provider_cancellation_state: "CONFIRMED", secrets: "0" },
  );
  assert.deepEqual(
    await oracle(env, "SELECT data_class, late, state, deletion_result FROM kauro.stored_objects WHERE upload_id = $1 AND generation = $2", [up.uploadId, lateObject.generation]),
    { data_class: "RESIDUAL", late: true, state: "DELETED", deletion_result: "DELETED" },
  );
  assert.equal(env.storage.generationsOf(env.storage.location("QUARANTINE"), up.objectName).find((g) => g.generation === lateObject.generation)?.status, "SOFT_DELETED");
  const tombstones = await env.journal.list(t.ag.agencyId as AgencyId, 0);
  assert.deepEqual(tombstones.map((x) => [x.kind, x.state, x.subjectId]), [["UPLOAD_ACCEPTANCE_REVOKED", "EXPIRED", up.uploadId]]);
  for (const [table, column] of [["inspection_receipts", "upload_id"], ["source_files", "origin_upload_id"]] as const) {
    assert.equal((await oracle<{ n: string }>(env, `SELECT count(*)::text AS n FROM kauro.${table} WHERE ${column} = $1`, [up.uploadId])).n, "0", `${table}: nothing of the late object is inspected or admitted`);
  }
  assert.deepEqual(await oracleRows(env, "SELECT event_type FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'upload_session.completion_reported.v1'", [up.uploadId]), [], "no completion report was ever recorded");
  const polled = await app.read<UploadView>(t, "GetUpload", { uploadId: up.uploadId });
  assert.deepEqual([polled.state, polled.providerCancellationState], ["EXPIRED", "CONFIRMED"]);
  await assertEverythingDelivered(t.ag.agencyId);
});

test("b07/integration end to end: S024 and S053 through the handlers — a hostile workbook and a completion claiming a false size, each reported through CompleteUpload, are REJECTED by UPLOAD_INSPECTION with their class while an honest workbook's worksheet is admitted; GetUpload and GetInspection answer the control plane's receipts within their routes' contracts; STORAGE_LIFECYCLE deletes the rejected quarantine generations and AUTHORITY_JOURNAL tombstones both rejections; a whole control-plane cycle then finds nothing to repair", { timeout: 300_000 }, async () => {
  const t = await activeTenant("e2e-reject");
  const p = await project(env, t);
  const rows = [["Email", "Name"], ["ana@example.test", "Ana"], ["bo@example.test", "Bo"]];
  const hostile = buildWorkbook({ sheet: "Contacts", rows, extra: [{ name: "../../outside.xml", data: "<x/>" }] });
  const honest = buildWorkbook({ sheet: "Contacts", rows });
  const forged = csv("forged", 2);

  // three uploads through CMD013, the browser and CMD014: the hostile workbook, a CSV whose completion claims a false size, an honest workbook
  const hostileUp = await reserveUpload(t, p.revisionId, hostile, "XLSX");
  const hostileWritten = browserUpload(hostileUp.sessionUrl, hostile);
  const forgedUp = await reserveUpload(t, p.revisionId, forged);
  const forgedWritten = browserUpload(forgedUp.sessionUrl, forged);
  const claimed = env.storage.parseCompletionClaim(forgedWritten.completionRef);
  if (claimed.kind !== "CLAIM") throw new Error("unreachable");
  const falseClaim = completionRefOf({ generation: forgedWritten.generation, bytes: (claimed.claim.bytes ?? forged.length) + 1 });
  const honestUp = await reserveUpload(t, p.revisionId, honest, "XLSX");
  const honestWritten = browserUpload(honestUp.sessionUrl, honest);
  for (const [up, ref] of [[hostileUp, hostileWritten.completionRef], [forgedUp, falseClaim], [honestUp, honestWritten.completionRef]] as const) {
    const accepted = await app.command(t, "CMD014", { uploadId: up.view.upload.uploadId }, { providerCompletionRef: ref });
    assert.equal(accepted.kind, "ACCEPTED", JSON.stringify(accepted));
  }

  assert.deepEqual(await drainAll(), { UPLOAD_INSPECTION: 3, SELECTION_EVALUATION: 0, STORAGE_LIFECYCLE: 2, AUTHORITY_JOURNAL: 2 });
  const expected: ReadonlyArray<readonly [string, string, string]> = [
    [hostileUp.view.upload.uploadId, "REJECTED", "CORRUPT_STRUCTURE"],
    [forgedUp.view.upload.uploadId, "REJECTED", "CLAIM_MISMATCH"],
  ];
  for (const [uploadId, state, rejectionClass] of expected) {
    const polled = await app.read<UploadView>(t, "GetUpload", { uploadId });
    assert.deepEqual([polled.state, polled.inspection?.rejectionClass, polled.fileId], [state, rejectionClass, undefined], rejectionClass);
    const quarantine = await oracle<{ state: string; deletion_result: string; object_name: string; generation: string }>(env, "SELECT state, deletion_result, object_name, generation FROM kauro.stored_objects WHERE upload_id = $1 AND zone = 'QUARANTINE'", [uploadId]);
    assert.deepEqual([quarantine.state, quarantine.deletion_result], ["DELETED", "DELETED"], `${rejectionClass}: the rejected quarantine generation deleted by STORAGE_LIFECYCLE`);
    assert.equal(env.storage.generationsOf(env.storage.location("QUARANTINE"), quarantine.object_name).find((g) => g.generation === quarantine.generation)?.status, "SOFT_DELETED");
    assert.equal((await oracle<{ n: string }>(env, "SELECT count(*)::text AS n FROM kauro.source_files WHERE origin_upload_id = $1", [uploadId])).n, "0", `${rejectionClass}: nothing admitted`);
  }
  const hostilePolled = await app.read<UploadView>(t, "GetUpload", { uploadId: hostileUp.view.upload.uploadId });
  assert.ok(hostilePolled.inspection?.problems.includes("PATH_TRAVERSAL"), JSON.stringify(hostilePolled.inspection));
  const forgedPolled = await app.read<UploadView>(t, "GetUpload", { uploadId: forgedUp.view.upload.uploadId });
  assert.equal(forgedPolled.inspection?.claimConsistent, false, "the claim is judged against the server's own observation (S053)");

  // the honest workbook: admitted with its worksheet; the inspection read carries every upload's outcome and the admitted inventory
  const inspection = await app.read<InspectionView>(t, "GetInspection", { revisionId: p.revisionId });
  assert.deepEqual(
    inspection.uploads.map((u) => [u.uploadId, u.state]).sort(),
    [[hostileUp.view.upload.uploadId, "REJECTED"], [forgedUp.view.upload.uploadId, "REJECTED"], [honestUp.view.upload.uploadId, "ADMITTED"]].sort(),
  );
  assert.deepEqual(
    inspection.files.map((f) => [f.uploadId, f.format, f.scanState, f.tables.map((x) => [x.kind, x.name, x.visibility, x.columnCount])]),
    [[honestUp.view.upload.uploadId, "XLSX", "COVERED_CLEAN", [["WORKSHEET", "Contacts", "VISIBLE", 2]]]],
  );
  const tombstones = await env.journal.list(t.ag.agencyId as AgencyId, 0);
  assert.deepEqual(
    tombstones.map((x) => [x.kind, x.state, x.subjectId]),
    [
      ["UPLOAD_ACCEPTANCE_REVOKED", "REJECTED", hostileUp.view.upload.uploadId],
      ["UPLOAD_ACCEPTANCE_REVOKED", "REJECTED", forgedUp.view.upload.uploadId],
    ],
  );
  await assertEverythingDelivered(t.ag.agencyId);

  // one whole control-plane cycle over everything the handlers and the control plane registered: the object inventory parses every
  // name CMD013 and UPLOAD_INSPECTION reserved and finds each generation the provider lists in the registry — nothing to repair
  const cycle = await env.plane.runCycle(clock.now());
  for (const [name, sweep] of Object.entries(cycle.sweeps)) assert.deepEqual(sweep?.failed, [], `${name}: no failure`);
  const inventory = env.plane.sweepers.objectInventory;
  const again = await inventory.sweep(env.plane.units, 100);
  assert.deepEqual([again.failed, again.residualsDeleted, again.admissionsRevoked], [[], 0, 0], "no unregistered generation, no missing or changed accepted generation");
  for (const counts of Object.values(cycle.dispatched)) assert.deepEqual([counts.retried, counts.deadLettered], [0, 0]);
});
