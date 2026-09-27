/**
 * Fixtures of the B07 command and read tests (mandate B07-COMMANDS; docs/design/B07-case-map.md): the source lifecycle driven through
 * the real routes of the composed api (support.ts) — ReserveUpload, CompleteUpload, CancelUpload, the selection manifest intake,
 * SelectInputTables, SealRevision, CreateRevision and the source reads — over the real PostgreSQL 17 cluster of the world.
 *
 * What the tests do that no route does: the control plane's steps between the request-handler commands (docs/design §12). Their
 * consumers are mandate B07-CONTROL's (`apps/control`), which this branch does not carry, so the fixtures perform exactly the writes
 * those consumers perform, through the same ports and adapters — `@kauro/persistence`'s source store in a SYSTEM unit of work of the
 * control-plane runtime role bound to the agency (kauro_control; D-CTRL-1), taking the revision row before any upload or file of it
 * (D-LOCK-2), every instant the database's own (D-CLOCK-1):
 *
 *   UPLOAD_INSPECTION   the attempt claimed and the provider observation recorded (claimInspectionAttempt, recordObservation), the
 *                       quarantine digest verified, the accepted generation promoted by the storage port's copy (the labelled fake,
 *                       SIMULATED) and registered, the receipt of the attempt, the file admitted with its detected tables, the upload
 *                       ADMITTED with its INPUT_ADMITTED anchor;
 *   SELECTION_EVALUATION the complete evaluation of the bound selection at the admitted generations and all_selected_inputs_admitted;
 *   the sweepers        a file's admission revoked (INTAKE_EXPIRED by the upload-deadline sweeper, GENERATION_CHANGED by the object
 *                       inventory).
 *
 * The inspection facts (tables, columns, row estimates, the scanner's report) are written as the inspector and the scanner would
 * report them; the scanner is named by the labelled scanner fake's tokens (SIMULATED) and the parsers by the versions of the real
 * parsers of @kauro/data-plane (the tokens of @kauro/persistence/testing). No fixture claims a provider effect. Past instants (an
 * intake window already closed, a first seal fifteen days old) come from the source-lifecycle fixture of @kauro/persistence/testing,
 * which positions the labelled TEST CLOCK of its own transactions only.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { CompletedResponse, ReserveUploadView, SealRevisionView, SelectInputTablesView, SourceRevisionView } from "@kauro/application";
import type { Sha256Hex } from "@kauro/contracts";
import {
  PRICING_DEFINITION,
  acceptedObjectName,
  evaluationHashOf,
  inspectionReceiptHashOf,
  parserProfileHashOf,
  quarantineObjectName,
  selectionHashOf,
  tableStructureHashOf,
  textDigest,
  type ActorRef,
  type AgencyId,
  type AggregateKind,
  type CausationId,
  type CorrelationId,
  type EvaluationId,
  type EventPayload,
  type EventType,
  type InspectionReceiptId,
  type ProjectId,
  type RetentionAnchorId,
  type RevisionId,
  type SelectionManifestDocument,
  type SelectionManifestId,
  type SourceFileId,
  type SourceTableId,
  type SourceUnitOfWork,
  type StoredObjectId,
  type SystemContext,
  type TableVisibility,
  type UploadId,
} from "@kauro/domain";
import { FIXTURE_EVALUATOR_VERSION, FIXTURE_INSPECTOR_VERSION, FIXTURE_SCANNER, FIXTURE_SCANNER_ENGINE_VERSION, FIXTURE_SIGNATURE_VERSION, type AgencyFixture, type SourceFixtureSessions } from "@kauro/persistence/testing";
import { call, completed, freshKey, ids, rawEvent, type Person, type Reply, type World } from "./support.js";

// --- routes ------------------------------------------------------------------------------------------------------------------------

export const sourceRoutes = {
  createRevision: (projectId: string) => `/api/v1/projects/${projectId}/revisions`,
  reserveUpload: (revisionId: string) => `/api/v1/revisions/${revisionId}/uploads`,
  completeUpload: (uploadId: string) => `/api/v1/uploads/${uploadId}/complete`,
  cancelUpload: (uploadId: string) => `/api/v1/uploads/${uploadId}/cancel`,
  selectInputTables: (revisionId: string) => `/api/v1/revisions/${revisionId}/selection`,
  sealRevision: (revisionId: string) => `/api/v1/revisions/${revisionId}/seal`,
  selectionManifests: (revisionId: string) => `/api/v1/revisions/${revisionId}/selection-manifests`,
  selectionManifest: (revisionId: string, selectionManifestId: string) => `/api/v1/revisions/${revisionId}/selection-manifests/${selectionManifestId}`,
  revision: (revisionId: string) => `/api/v1/revisions/${revisionId}`,
  inspection: (revisionId: string) => `/api/v1/revisions/${revisionId}/inspection`,
  uploads: (revisionId: string) => `/api/v1/revisions/${revisionId}/uploads`,
  upload: (uploadId: string) => `/api/v1/uploads/${uploadId}`,
  uploadSession: (uploadId: string) => `/api/v1/uploads/${uploadId}/session`,
  preview: (revisionId: string, tableId: string) => `/api/v1/revisions/${revisionId}/tables/${tableId}/preview`,
};

/**
 * The lock statements a waiting request is observed on (pg_stat_activity), as the adapters issue them. pg_stat_activity keeps the
 * first track_activity_query_size bytes (1,024 by default) of a statement, and the source adapters' row locks name every column
 * before their FROM clause (1,415 bytes for a revision, 2,056 for an upload), so a lock is recognised by the head of its statement:
 * a plain read of the same columns never waits on a lock, so a backend in a Lock wait on that head is waiting for the row lock.
 */
export const LOCKS = {
  revision: "SELECT revision_id, agency_id, project_id, version::text AS version, state, manifest_hash",
  upload: "SELECT upload_id, agency_id, project_id, revision_id, version::text AS version, state, declared_format",
  project: "FROM kauro.projects WHERE project_id = $1 FOR UPDATE",
  fileTransition: "await_transition('kauro.source_files'",
};

/** The application name of the control-plane pool of the harness (pg_stat_activity). */
export const CONTROL_APPLICATION_NAME = "kauro-test-control";

/** The service identity of the control-plane steps the fixtures perform (a SERVICE actor, never a person). */
export const CONTROL_SERVICE = "upload-inspection";

// --- the agency --------------------------------------------------------------------------------------------------------------------

/**
 * The agency's activation as its OWNER records it (CMD002's writes, agreements_and_profile_accepted: the accepted terms, privacy
 * agreement and legal profile, version + 1, agency.activated.v1). Customer data enters only an ACTIVE agency (CMD013).
 */
export async function activate(w: World, agency: AgencyFixture = w.A): Promise<void> {
  await w.asTenant(agency, async (c) => {
    const r = await c.query<{ version: string }>(
      "UPDATE kauro.agencies SET state = 'ACTIVE', terms_version = 'TERMS-2026-1', privacy_agreement_version = 'DPA-2026-1', legal_profile_ref = $2, version = version + 1 WHERE agency_id = $1 AND state = 'DRAFT' RETURNING version::text",
      [agency.agencyId, ids.next()],
    );
    const version = r.rows[0]?.version;
    assert.ok(version !== undefined, "the agency was DRAFT");
    await rawEvent(c, { aggregateKind: "agency", aggregateId: agency.agencyId, aggregateVersion: Number(version), agencyId: agency.agencyId, eventType: "agency.activated.v1", actorUserId: agency.ownerUserId, payload: { agencyId: agency.agencyId } });
  });
}

/** One control-plane transaction (kauro_control) bound to the agency, as the harness's own fixtures open it. */
export async function asControl<T>(w: World, agencyId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await w.h.controlPool.raw.connect();
  let destroy: Error | undefined;
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', '', true)", [agencyId]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    try {
      await c.query("ROLLBACK");
    } catch (rollbackError) {
      destroy = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    }
    throw e;
  } finally {
    c.release(destroy);
  }
}

/** An operations change of the agency's concurrent upload-session limit (the control plane's ledger column; D-UP-3). */
export async function setSessionLimit(w: World, agency: AgencyFixture, limit: number): Promise<void> {
  await asControl(w, agency.agencyId, (c) =>
    c.query("INSERT INTO kauro.upload_capacity (agency_id, active_sessions, session_limit, updated_at) VALUES ($1, 0, $2, now()) ON CONFLICT (agency_id) DO UPDATE SET session_limit = EXCLUDED.session_limit, updated_at = now()", [agency.agencyId, limit]),
  );
}

/** The sessions of the source-lifecycle fixture of @kauro/persistence/testing for an agency: its owner, and its control plane. */
export function fixtureSessions(w: World, agency: AgencyFixture): SourceFixtureSessions {
  return {
    app: (fn) => w.asTenant(agency, (c) => fn(c)),
    control: (fn) => asControl(w, agency.agencyId, (c) => fn(c)),
  };
}

// --- the control plane's units of work ----------------------------------------------------------------------------------------------

function controlContext(agencyId: string): SystemContext {
  return { kind: "SYSTEM", serviceId: CONTROL_SERVICE, correlationId: ids.next() as CorrelationId, agencyId: agencyId as AgencyId };
}

/** A control-plane unit of work of the product's own pg adapter (the harness's control pool), bound to the agency. */
export function controlUnitOfWork<T>(w: World, agencyId: string, work: (uow: SourceUnitOfWork, emit: Emit) => Promise<T>): Promise<T> {
  return w.h.control.runSource(controlContext(agencyId), (uow) => work(uow, emitterOf(uow, agencyId)));
}

type Emit = (kind: AggregateKind, id: string, version: number, type: EventType, payload: EventPayload) => Promise<void>;

function emitterOf(uow: SourceUnitOfWork, agencyId: string): Emit {
  const actor: ActorRef = { kind: "SERVICE", serviceId: CONTROL_SERVICE };
  return async (kind, id, version, type, payload) => {
    await uow.events.publish({ aggregateKind: kind, aggregateId: id, aggregateVersion: version, agencyId: agencyId as AgencyId, eventType: type, actor, causationId: ids.next() as CausationId, correlationId: uow.context.correlationId, payload });
  };
}

function applied<T>(write: { readonly kind: "APPLIED"; readonly record: T } | { readonly kind: "STALE" }, what: string): T {
  if (write.kind !== "APPLIED") throw new Error(`the control-plane fixture's ${what} was stale`);
  return write.record;
}

// --- the upload's journey ----------------------------------------------------------------------------------------------------------

/** The opaque quarantine name of an upload (D-OBJ-1), from the ids a view or a row carries. */
export function quarantineName(agencyId: string, projectId: string, revisionId: string, uploadId: string): string {
  return quarantineObjectName(agencyId as AgencyId, projectId as ProjectId, revisionId as RevisionId, uploadId as UploadId);
}

export function sha256Of(content: Uint8Array): Sha256Hex {
  return createHash("sha256").update(content).digest("hex") as Sha256Hex;
}

/** A small CSV: an Email and a Name column, `rows` records. */
export function csvContent(rows = 3, seed = "row"): Uint8Array {
  const lines = ["Email,Name", ...Array.from({ length: rows }, (_, i) => `${seed}${i}@example.com,${seed} ${i}`)];
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

export interface ReserveOptions {
  readonly person?: Person;
  readonly agency?: string;
  readonly key?: string;
  readonly bytes?: number;
  readonly format?: "CSV" | "XLSX";
  readonly displayName?: string;
}

/** The body of a ReserveUpload request. */
export function reserveBody(expectedVersion: number, options: Pick<ReserveOptions, "bytes" | "format" | "displayName"> = {}) {
  return { expectedVersion, declaredBytes: options.bytes ?? 1_000_000, declaredFormat: options.format ?? "CSV", displayName: options.displayName ?? "contacts export.csv" };
}

/** ReserveUpload through its route. */
export function reserve(w: World, revisionId: string, expectedVersion: number, options: ReserveOptions = {}): Promise<Reply> {
  return call(w, { url: sourceRoutes.reserveUpload(revisionId), token: (options.person ?? w.operator).token, ...(options.agency !== undefined ? { agency: options.agency } : {}), key: options.key ?? freshKey("reserve"), body: reserveBody(expectedVersion, options) });
}

/** A reservation the route answered 201, with the session delivered to its requester. */
export async function reserved(w: World, revisionId: string, expectedVersion: number, options: ReserveOptions = {}): Promise<CompletedResponse<ReserveUploadView>> {
  const body = completed<ReserveUploadView>(await reserve(w, revisionId, expectedVersion, options), 201);
  assert.equal(body.data.session.delivery, "PROTECTED_RESPONSE");
  return body as CompletedResponse<ReserveUploadView>;
}

/** The session URL a reservation delivered (the bearer credential of the protected response). */
export function sessionUrlOf(reply: CompletedResponse<ReserveUploadView>): string {
  const session = reply.data.session as { readonly uploadUrl?: string };
  assert.ok(typeof session.uploadUrl === "string", "the session was delivered");
  return session.uploadUrl;
}

export interface Finalized {
  readonly completionRef: string;
  readonly generation: string;
  readonly bytes: number;
  readonly content: Uint8Array;
}

/** The browser's upload through the resumable session of the labelled storage fake (SIMULATED): the provider's completion. */
export function uploadThrough(w: World, sessionUrl: string, content: Uint8Array): Finalized {
  const result = w.storage.uploadThroughSession(sessionUrl, content);
  assert.equal(result.outcome, "FINALIZED", JSON.stringify(result));
  if (result.outcome !== "FINALIZED") throw new Error("unreachable");
  return { completionRef: result.completionRef, generation: result.generation, bytes: result.bytes, content };
}

/** CompleteUpload through its route. */
export function complete(w: World, uploadId: string, completionRef: string, options: { readonly person?: Person; readonly key?: string } = {}): Promise<Reply> {
  return call(w, { url: sourceRoutes.completeUpload(uploadId), token: (options.person ?? w.operator).token, key: options.key ?? freshKey("complete"), body: { providerCompletionRef: completionRef } });
}

/** A detected table as the inspector reports it (the fixture writes exactly these facts). */
export interface DetectedTable {
  readonly kind: "CSV_TABLE" | "WORKSHEET";
  readonly name?: string;
  readonly visibility: TableVisibility;
  readonly columns: ReadonlyArray<string>;
  readonly rows: number;
}

export const CSV_TABLE: DetectedTable = { kind: "CSV_TABLE", visibility: "VISIBLE", columns: ["Email", "Name"], rows: 3 };

export interface AdmittedTable {
  readonly tableId: SourceTableId;
  readonly ordinal: number;
  readonly kind: DetectedTable["kind"];
  readonly visibility: TableVisibility;
  readonly structureHash: Sha256Hex;
  readonly columnCount: number;
  readonly rows: number;
}

export interface AdmittedFile {
  readonly uploadId: UploadId;
  readonly revisionId: RevisionId;
  readonly projectId: ProjectId;
  readonly fileId: SourceFileId;
  readonly format: "CSV" | "XLSX";
  readonly tables: ReadonlyArray<AdmittedTable>;
  readonly acceptedObjectId: StoredObjectId;
  readonly acceptedGeneration: string;
  readonly sha256: Sha256Hex;
  readonly bytes: number;
  readonly receiptHash: Sha256Hex;
  readonly parserProfileHash: Sha256Hex;
}

/**
 * UPLOAD_INSPECTION's writes for a VERIFYING upload (see the header): the claimed attempt observes the finalized generation, then —
 * revision row first — the quarantine digest is verified, the generation promoted by the storage port's copy and registered, the
 * receipt recorded, the file admitted with `tables`, the upload ADMITTED with its INPUT_ADMITTED anchor. The revision stays UPLOADING.
 */
export async function admit(w: World, agencyId: string, uploadId: string, finalized: Finalized, tables: ReadonlyArray<DetectedTable> = [CSV_TABLE]): Promise<AdmittedFile> {
  const claim = await controlUnitOfWork(w, agencyId, async (uow, emit) => {
    const found = await uow.sources.uploads.get(uploadId as UploadId);
    assert.ok(found, "the upload is visible to its agency's control plane");
    assert.ok(await uow.sources.revisions.lock(found.revisionId));
    const attempt = await uow.sources.uploads.claimInspectionAttempt(found.uploadId);
    assert.ok(attempt, "a VERIFYING upload yields an attempt");
    const current = await uow.sources.uploads.lock(found.uploadId);
    assert.ok(current);
    const observed = applied(await uow.sources.uploads.recordObservation(found.uploadId, current.version, { generation: finalized.generation, bytes: finalized.bytes }), "observation");
    await emit("upload_session", found.uploadId, observed.version, "upload_session.completion_observed.v1", { uploadId: found.uploadId, agencyId, revisionId: found.revisionId, observedBytes: finalized.bytes, claimConsistent: true });
    await uow.sources.objects.observe(found.quarantineObjectId, { generation: finalized.generation, bytes: finalized.bytes, observedAt: await uow.serverInstant() as never, late: false });
    return { attempt, upload: observed };
  });
  const { upload } = claim;
  const format = tables.some((t) => t.kind === "WORKSHEET") ? "XLSX" : "CSV";
  const fileId = ids.next() as SourceFileId;
  const acceptedObjectId = ids.next() as StoredObjectId;
  const sha256 = sha256Of(finalized.content);
  // the promotion: the exact quarantine generation copied to the accepted name through the storage port (the labelled fake)
  const quarantine = { location: w.storage.location("QUARANTINE"), objectName: quarantineObjectName(upload.agencyId, upload.projectId, upload.revisionId, upload.uploadId), generation: finalized.generation };
  const acceptedName = acceptedObjectName(upload.agencyId, upload.projectId, fileId);
  const { generation: acceptedGeneration } = await w.storage.copy(quarantine, { location: w.storage.location("ACCEPTED"), objectName: acceptedName });
  const parserProfileHash = parserProfileHashOf(format === "CSV" ? { inspector: FIXTURE_INSPECTOR_VERSION, format, encoding: "UTF_8", delimiter: "COMMA" } : { inspector: FIXTURE_INSPECTOR_VERSION, format });
  const admittedTables: AdmittedTable[] = [];
  const rows = tables.map((t, ordinal) => {
    const tableId = ids.next() as SourceTableId;
    const nameDigest = textDigest(t.name ?? "");
    const structureHash = tableStructureHashOf({
      fileId, ordinal, kind: t.kind, nameDigest, visibility: t.visibility, columnCount: t.columns.length, columnLabelDigests: t.columns.map((c) => textDigest(c)),
      hasFormulas: false, formulaCache: "NOT_APPLICABLE", mergedCellCount: 0, hiddenRowCount: 0, hiddenColumnCount: 0, issues: [],
    });
    admittedTables.push({ tableId, ordinal, kind: t.kind, visibility: t.visibility, structureHash, columnCount: t.columns.length, rows: t.rows });
    return {
      tableId, agencyId: agencyId as AgencyId, fileId, ordinal, kind: t.kind, ...(t.name !== undefined ? { nameDisplay: t.name } : {}), nameDigest, visibility: t.visibility, columnCount: t.columns.length, rowEstimate: t.rows,
      hasFormulas: false, formulaCache: "NOT_APPLICABLE" as const, mergedCellCount: 0, hiddenRowCount: 0, hiddenColumnCount: 0, issues: [], structureHash,
      columns: t.columns.map((label, i) => ({ tableId, ordinal: i, labelDisplay: label, labelDigest: textDigest(label), labelState: "PRESENT" as const })),
    };
  });
  const receiptHash = inspectionReceiptHashOf({ uploadId: upload.uploadId, inspectionFence: claim.attempt.inspectionFence, observedGeneration: finalized.generation, observedBytes: finalized.bytes, sha256, outcome: "ADMITTED", acceptedGeneration });
  await controlUnitOfWork(w, agencyId, async (uow, emit) => {
    assert.ok(await uow.sources.revisions.lock(upload.revisionId));
    const now = await uow.serverInstant();
    await uow.sources.objects.verify(upload.quarantineObjectId, sha256, now as never);
    await uow.sources.objects.register({
      objectId: acceptedObjectId, agencyId: upload.agencyId, projectId: upload.projectId, revisionId: upload.revisionId, uploadId: upload.uploadId, fileId,
      zone: "ACCEPTED", dataClass: "RAW", provider: w.storage.provider, locationRef: w.storage.location("ACCEPTED").locationRef, objectName: acceptedName,
      createdBy: { kind: "SERVICE", serviceId: CONTROL_SERVICE }, createdAt: now as never, observed: { generation: acceptedGeneration, bytes: finalized.bytes, observedAt: now as never, late: false },
    });
    await uow.sources.objects.verify(acceptedObjectId, sha256, now as never);
    await uow.sources.inspections.append({
      receiptId: ids.next() as InspectionReceiptId, agencyId: upload.agencyId, uploadId: upload.uploadId, revisionId: upload.revisionId, receiptHash, inspectionFence: claim.attempt.inspectionFence,
      quarantineObjectId: upload.quarantineObjectId, observedGeneration: finalized.generation, observedBytes: finalized.bytes, sha256,
      completionClaimDigest: upload.completionClaimDigest as Sha256Hex, claimConsistent: true, declaredFormat: upload.declaredFormat, detectedFormat: format,
      structureStatus: "STRUCTURE_VALID", scanState: "COVERED_CLEAN", semanticStatus: "SEMANTIC_NOT_YET_PROFILED",
      scanner: { engine: FIXTURE_SCANNER, engineVersion: FIXTURE_SCANNER_ENGINE_VERSION, signatureVersion: FIXTURE_SIGNATURE_VERSION, signaturesPublishedAt: new Date(Date.parse(now) - 3_600_000).toISOString(), signatureMaxAgeSeconds: 86_400, configHash: textDigest(`${FIXTURE_SCANNER}-config`), scannedAt: now, exitCode: 0, verdict: "CLEAN" },
      expectedParts: 1, expectedBytes: finalized.bytes, scannedParts: 1, scannedBytes: finalized.bytes,
      coverage: [{ partDigest: textDigest(`container-${upload.uploadId}`), partKind: "CONTAINER", expectedBytes: finalized.bytes, scannedBytes: finalized.bytes, outcome: "CLEAN" }],
      problems: [], parserProfileHash, inspectorVersion: FIXTURE_INSPECTOR_VERSION, outcome: "ADMITTED", accepted: { objectId: acceptedObjectId, generation: acceptedGeneration, sha256 },
      startedAt: claim.attempt.claimedAt, completedAt: now,
    } as never);
    await uow.sources.files.admit(
      { fileId, storageRef: acceptedObjectId, agencyId: upload.agencyId, projectId: upload.projectId, originRevisionId: upload.revisionId, originUploadId: upload.uploadId, inspectionReceiptHash: receiptHash, providerGeneration: acceptedGeneration, sha256, bytes: finalized.bytes, format, scanState: "COVERED_CLEAN", parserProfileHash },
      rows as never,
    );
    await emit("source_file", fileId, 1, "source_file.admitted.v1", { fileId, agencyId, projectId: upload.projectId, originRevisionId: upload.revisionId, originUploadId: upload.uploadId, inspectionReceiptHash: receiptHash, bytes: finalized.bytes, format });
    const current = await uow.sources.uploads.lock(upload.uploadId);
    assert.ok(current);
    const admitted = applied(await uow.sources.uploads.transition(upload.uploadId, current.version, { event: "inspection_admitted", fileId, receiptHash, inspectionFence: claim.attempt.inspectionFence }), "inspection_admitted");
    await emit("upload_session", upload.uploadId, admitted.version, "upload_session.admitted.v1", { uploadId: upload.uploadId, agencyId, revisionId: upload.revisionId, fileId, inspectionReceiptHash: receiptHash, observedBytes: finalized.bytes, scanState: "COVERED_CLEAN", detectedFormat: format });
    await uow.sources.retention.appendAnchor({ anchorId: ids.next() as RetentionAnchorId, agencyId: upload.agencyId, projectId: upload.projectId, revisionId: upload.revisionId, uploadId: upload.uploadId, kind: "INPUT_ADMITTED", sourceEvidenceHash: receiptHash });
  });
  return { uploadId: upload.uploadId, revisionId: upload.revisionId, projectId: upload.projectId, fileId, format, tables: admittedTables, acceptedObjectId, acceptedGeneration, sha256, bytes: finalized.bytes, receiptHash, parserProfileHash };
}

/**
 * An upload admitted end to end: ReserveUpload through its route, the bytes through the fake's session, CompleteUpload through its
 * route (202), then UPLOAD_INSPECTION's writes.
 */
export async function uploadAndAdmit(w: World, revisionId: string, expectedVersion: number, options: ReserveOptions & { readonly content?: Uint8Array; readonly tables?: ReadonlyArray<DetectedTable> } = {}): Promise<AdmittedFile> {
  const content = options.content ?? csvContent(3, `admit-${ids.next().slice(-6)}`);
  const format = options.tables?.some((t) => t.kind === "WORKSHEET") ? "XLSX" : "CSV";
  const r = await reserved(w, revisionId, expectedVersion, { ...options, bytes: content.byteLength, format });
  const finalized = uploadThrough(w, sessionUrlOf(r), content);
  const accepted = await complete(w, r.data.upload.uploadId, finalized.completionRef, { ...(options.person !== undefined ? { person: options.person } : {}) });
  assert.equal(accepted.status, 202, accepted.text);
  return admit(w, r.data.upload.agencyId, r.data.upload.uploadId, finalized, options.tables);
}

// --- selection, evaluation, seal ----------------------------------------------------------------------------------------------------

const CSV_PARSER = { kind: "CSV", encoding: "UTF_8", delimiter: "COMMA", quote: "DOUBLE_QUOTE", header: { mode: "FIRST_RECORD" }, blankLines: "SKIP" } as const;
const WORKSHEET_PARSER = { kind: "WORKSHEET", header: { mode: "ROW", rowIndex: 0 }, formulas: "NOT_PRESENT", hiddenRows: "EXCLUDE", hiddenColumns: "EXCLUDE", mergedCells: "AS_OBSERVED" } as const;

/**
 * A selection manifest that includes every file with every one of its tables (a ROW projection of each included table's columns),
 * made against `inventoryHash`. `adjust` edits the table entries (exclusions, acknowledgements, omissions).
 */
export function manifestOf(
  revisionId: string,
  inventoryHash: string,
  files: ReadonlyArray<{ readonly file: Pick<AdmittedFile, "fileId" | "tables">; readonly origin?: "THIS_REVISION" | "REUSED" }>,
  adjust: (entry: SelectionManifestDocument["tables"][number], table: AdmittedTable) => SelectionManifestDocument["tables"][number] | null = (entry) => entry,
): SelectionManifestDocument {
  const tables: Array<SelectionManifestDocument["tables"][number]> = [];
  for (const { file } of files) {
    for (const table of file.tables) {
      const base = { tableId: table.tableId, fileId: file.fileId, structureHash: table.structureHash, disposition: "INCLUDE" as const, parser: table.kind === "CSV_TABLE" ? CSV_PARSER : WORKSHEET_PARSER };
      const entry = adjust(base, table);
      if (entry !== null) tables.push(entry);
    }
  }
  const included = tables.filter((t) => t.disposition === "INCLUDE");
  return {
    schemaVersion: 1,
    revisionId: revisionId as RevisionId,
    inventoryHash: inventoryHash as Sha256Hex,
    files: files.map(({ file, origin }) => ({ fileId: file.fileId, origin: origin ?? "THIS_REVISION", disposition: "INCLUDE" as const })),
    tables,
    projections: included.map((t, i) => {
      const table = files.flatMap(({ file }) => file.tables).find((x) => x.tableId === t.tableId) as AdmittedTable;
      return { projectionKey: `CONTACT_${i}`, tableId: t.tableId, objectKind: "CONTACT", kind: "ROW" as const, fieldOrdinals: Array.from({ length: table.columnCount }, (_, c) => c) };
    }),
    associations: [],
  };
}

/** The revision's current inventory hash, as GET inspection shows it to the agency. */
export async function inventoryHashOfRoute(w: World, revisionId: string, person: Person = w.operator): Promise<string> {
  const reply = await call(w, { method: "GET", url: sourceRoutes.inspection(revisionId), token: person.token, key: null, contentType: null });
  assert.equal(reply.status, 200, reply.text);
  return reply.json<{ data: { inventoryHash: string } }>().data.inventoryHash;
}

/** The selection manifest intake through its route. */
export function submitManifest(w: World, revisionId: string, document: unknown, person: Person = w.operator): Promise<Reply> {
  return call(w, { url: sourceRoutes.selectionManifests(revisionId), token: person.token, key: null, body: document });
}

/** A manifest the intake stored (201) or found (200): its id. */
export async function storedManifest(w: World, revisionId: string, document: SelectionManifestDocument, person: Person = w.operator): Promise<{ readonly selectionManifestId: string; readonly bodyHash: string; readonly created: boolean }> {
  const reply = await submitManifest(w, revisionId, document, person);
  assert.ok(reply.status === 201 || reply.status === 200, reply.text);
  const body = reply.json<{ kind: string; data: { selectionManifestId: string; bodyHash: string; created: boolean } }>();
  assert.equal(body.kind, "STORED");
  assert.equal(body.data.bodyHash, selectionHashOf(document));
  return body.data;
}

/** SelectInputTables through its route. */
export function select(w: World, revisionId: string, expectedVersion: number, selectionManifestRef: string, options: { readonly person?: Person; readonly key?: string } = {}): Promise<Reply> {
  return call(w, { url: sourceRoutes.selectInputTables(revisionId), token: (options.person ?? w.operator).token, key: options.key ?? freshKey("select"), body: { expectedVersion, selectionManifestRef } });
}

/** A selection bound through the intake and CMD016 (200). */
export async function bound(w: World, revisionId: string, expectedVersion: number, document: SelectionManifestDocument): Promise<CompletedResponse<SelectInputTablesView>> {
  const manifest = await storedManifest(w, revisionId, document);
  return completed<SelectInputTablesView>(await select(w, revisionId, expectedVersion, manifest.selectionManifestId), 200) as CompletedResponse<SelectInputTablesView>;
}

export const COUNTS = { physicalSourceRows: 3, logicalSourceRecords: 3, billableSourceUnits: 3, associationEdges: 0 } as const;

/**
 * SELECTION_EVALUATION's writes (see the header): revision row first, the complete evaluation of the bound selection at the admitted
 * generations of its included files, all_selected_inputs_admitted with the counts, dataset_revision.ready_to_seal.v1. Returns the
 * revision's version (READY_TO_SEAL).
 */
export async function evaluate(w: World, agencyId: string, revisionId: string, files: ReadonlyArray<Pick<AdmittedFile, "fileId" | "acceptedGeneration" | "sha256" | "bytes" | "tables">>, counted: { readonly generationOf?: (file: Pick<AdmittedFile, "fileId" | "acceptedGeneration">) => string } = {}): Promise<{ readonly version: number; readonly evaluationHash: string }> {
  return controlUnitOfWork(w, agencyId, async (uow, emit) => {
    const revision = await uow.sources.revisions.lock(revisionId as RevisionId);
    assert.ok(revision && revision.selectionHash !== undefined && revision.selectionManifestId !== undefined, "a bound selection");
    const manifest = await uow.sources.selections.get(revision.revisionId, revision.selectionManifestId);
    assert.ok(manifest);
    const includedFiles = new Set(manifest.body.files.filter((f) => f.disposition === "INCLUDE").map((f) => f.fileId as string));
    const evaluated = files.filter((f) => includedFiles.has(f.fileId)).map((f) => ({ fileId: f.fileId, generation: counted.generationOf?.(f) ?? f.acceptedGeneration, sha256: f.sha256, bytes: f.bytes }));
    const includedTables = manifest.body.tables.filter((t) => t.disposition === "INCLUDE");
    const tables = includedTables.map((t) => {
      const table = files.flatMap((f) => f.tables).find((x) => x.tableId === t.tableId);
      assert.ok(table);
      return { tableId: t.tableId, physicalRows: table.rows, columnCount: table.columnCount, excludedHiddenRows: 0, issues: [] };
    });
    const physicalRows = tables.reduce((n, t) => n + t.physicalRows, 0);
    const populations = { physicalSourceRows: physicalRows, logicalSourceRecords: physicalRows, billableSourceUnits: physicalRows, associationEdges: 0 };
    const evaluationId = ids.next() as EvaluationId;
    const evaluationHash = evaluationHashOf({ revisionId: revision.revisionId, selectionHash: revision.selectionHash, files: evaluated, populations });
    const now = await uow.serverInstant();
    await uow.sources.evaluations.append({
      evaluationId, agencyId: revision.agencyId, revisionId: revision.revisionId, selectionManifestId: revision.selectionManifestId, selectionHash: revision.selectionHash, evaluationHash,
      result: "COMPLETE", populations, fileCount: evaluated.length, totalBytes: evaluated.reduce((n, f) => n + f.bytes, 0), files: evaluated, tables,
      projections: manifest.body.projections.map((p) => ({ projectionKey: p.projectionKey, objectKind: p.objectKind, logicalRecords: tables.find((t) => t.tableId === p.tableId)?.physicalRows ?? 0, billable: true })),
      failures: [], pricingDefinition: PRICING_DEFINITION, evaluatorVersion: FIXTURE_EVALUATOR_VERSION, startedAt: now, completedAt: now,
    } as never);
    const ready = applied(await uow.sources.revisions.transition(revision.revisionId, revision.version, { event: "all_selected_inputs_admitted", evaluationId, evaluationHash, populations }), "all_selected_inputs_admitted");
    await emit("dataset_revision", revision.revisionId, ready.version, "dataset_revision.ready_to_seal.v1", { revisionId: revision.revisionId, agencyId, projectId: revision.projectId, selectionHash: revision.selectionHash, evaluationHash, ...populations });
    return { version: ready.version, evaluationHash };
  });
}

/** SealRevision through its route. */
export function seal(w: World, revisionId: string, expectedVersion: number, selectionHash: string, options: { readonly person?: Person; readonly key?: string } = {}): Promise<Reply> {
  return call(w, { url: sourceRoutes.sealRevision(revisionId), token: (options.person ?? w.operator).token, key: options.key ?? freshKey("seal"), body: { expectedVersion, selectionHash } });
}

export interface ReadyRevision {
  readonly projectId: ProjectId;
  readonly revisionId: RevisionId;
  readonly file: AdmittedFile;
  readonly selectionManifestId: string;
  readonly selectionHash: string;
  readonly inventoryHash: string;
  /** READY_TO_SEAL's version (4 for a project's first revision). */
  readonly version: number;
}

/**
 * A READY_TO_SEAL revision through the product: a new project's DRAFT revision, one CSV reserved, uploaded, completed and admitted
 * (UPLOADING v2), the selection stored and bound (INSPECTING v3), counted by SELECTION_EVALUATION (READY_TO_SEAL v4).
 */
export async function readyRevision(w: World): Promise<ReadyRevision> {
  const { projectId, revisionId } = await w.project(w.A, w.clientA);
  const file = await uploadAndAdmit(w, revisionId, 1);
  const inventoryHash = await inventoryHashOfRoute(w, revisionId);
  const document = manifestOf(revisionId, inventoryHash, [{ file }]);
  const selected = await bound(w, revisionId, 2, document);
  const { version } = await evaluate(w, w.A.agencyId, revisionId, [file]);
  return { projectId, revisionId, file, selectionManifestId: selected.data.selection.selectionManifestId, selectionHash: selected.data.selection.selectionHash, inventoryHash, version };
}

export interface SealedThroughRoutes extends ReadyRevision {
  readonly manifestHash: string;
  readonly projectionHash: string;
  readonly sealedSubjectHash: string;
  readonly retentionId: string;
  /** SEALED's version (5 for a project's first revision). */
  readonly sealedVersion: number;
}

/** A SEALED revision through the product: readyRevision, then SealRevision through its route (200). */
export async function sealedThroughRoutes(w: World): Promise<SealedThroughRoutes> {
  const ready = await readyRevision(w);
  const body = completed<SealRevisionView>(await seal(w, ready.revisionId, ready.version, ready.selectionHash), 200);
  return { ...ready, manifestHash: body.data.manifestHash, projectionHash: body.data.projectionHash, sealedSubjectHash: body.data.sealedSubjectHash, retentionId: body.data.retention.retentionId, sealedVersion: body.data.revision.version };
}

/** CreateRevision through its route. */
export function createRevision(w: World, projectId: string, expectedVersion: number, supersedesRevisionId: string, options: { readonly person?: Person; readonly key?: string; readonly agency?: string } = {}): Promise<Reply> {
  return call(w, {
    url: sourceRoutes.createRevision(projectId),
    token: (options.person ?? w.operator).token,
    ...(options.agency !== undefined ? { agency: options.agency } : {}),
    key: options.key ?? freshKey("create-revision"),
    body: { expectedVersion, supersedesRevisionId },
  });
}

/** Superuser oracle: a project's version and current revision. */
export async function projectPointer(w: World, projectId: string): Promise<{ readonly version: number; readonly currentRevisionId: string }> {
  const row = await w.row<{ version: string; current_revision_id: string }>("projects", "project_id = $1", [projectId]);
  assert.ok(row, "the project exists");
  return { version: Number(row.version), currentRevisionId: row.current_revision_id };
}

/** GetRevision through its route. */
export async function revisionOf(w: World, revisionId: string, person: Person = w.operator): Promise<SourceRevisionView> {
  const reply = await call(w, { method: "GET", url: sourceRoutes.revision(revisionId), token: person.token, key: null, contentType: null });
  assert.equal(reply.status, 200, reply.text);
  return reply.json<{ data: SourceRevisionView }>().data;
}

// --- the sweepers ------------------------------------------------------------------------------------------------------------------

/** A file's admission revoked by its control-plane owner (D-FILE-1): the upload-deadline sweeper or the object inventory. */
export async function revokeAdmission(w: World, agencyId: string, fileId: string, reason: "INTAKE_EXPIRED" | "GENERATION_MISSING" | "GENERATION_CHANGED"): Promise<void> {
  await controlUnitOfWork(w, agencyId, async (uow, emit) => {
    const file = await uow.sources.files.get(fileId as SourceFileId);
    assert.ok(file);
    const revoked = applied(await uow.sources.files.revokeAdmission(file.fileId, file.version, reason), "revokeAdmission");
    await emit("source_file", file.fileId, revoked.version, "source_file.admission_revoked.v1", {
      fileId: file.fileId,
      agencyId,
      projectId: file.projectId,
      reason,
      selectedByRevisionIds: [...(await uow.sources.files.selectedBy(file.fileId))],
      sealedByRevisionIds: [...(await uow.sources.files.sealedBy(file.fileId))],
    });
  });
}

// --- oracles -----------------------------------------------------------------------------------------------------------------------

/** Superuser oracle: the exact microsecond ISO instant of a timestamptz expression over one row. */
export async function exactInstant(w: World, sql: string, params: ReadonlyArray<unknown>): Promise<string> {
  const r = await w.h.oracle.query<{ at: string | null }>(`SELECT to_char((${sql}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`, [...params]);
  const at = r.rows[0]?.at;
  assert.ok(typeof at === "string", `no instant for ${sql}`);
  return at;
}

/** A problem reply's `current` member. */
export function currentOf(reply: Reply): { readonly version: number; readonly state: string } | undefined {
  return reply.json<{ current?: { version: number; state: string } }>().current;
}
