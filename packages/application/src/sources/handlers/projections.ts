/**
 * The safe views of the source lifecycle, built from records (sources/views; the closed schemas of sources/response-views, which
 * the api validates every reply against): what a member of the agency may see of an upload, a revision, its inspection, its
 * retention — never a provider generation, an object name, a location or a session reference (D-SESSION-2); display names,
 * worksheet names and header labels only in the tenant's own reads, as untrusted text the UI escapes.
 *
 * A view's readiness blockers and permitted actions are facts recomputed at read time (10: a readiness flag is informative, never
 * authority): every command re-checks its role, state, version and guards in its own transaction.
 */
import type { Sha256Hex } from "@kauro/contracts";
import type {
  AgencyRecord,
  InspectionReceiptRecord,
  MembershipRole,
  ProjectRecord,
  ResolvedMembership,
  RetentionRecordRow,
  SelectionEvaluationRecord,
  SourceColumnRecord,
  SourceFileRecord,
  SourceRevisionRecord,
  SourceTableRecord,
  SourceUnitOfWork,
  UploadSessionRecord,
} from "@kauro/domain";
import { AGENCY_OPEN_STATES, DomainFailure, INPUT_ENVELOPE, REVISION_MUTABLE_STATES, REVISION_SELECTABLE_STATES, REVISION_UPLOAD_STATES, UPLOAD_LIVE_STATES, UPLOAD_TOMBSTONE_STATES, inventoryHashOf, isOffered, roleSatisfies } from "@kauro/domain";
import { B07_COMMANDS, type B07CommandId } from "../contracts.js";
import type { SourceResourceAction } from "../response-views.js";
import type {
  InspectionColumnView,
  InspectionFileView,
  InspectionTableView,
  RetentionView,
  RevisionQuotaView,
  RevisionSummaryView,
  SourceBlocker,
  SourceRevisionView,
  UploadInspectionView,
  UploadView,
} from "../views.js";
import { reachedOnServer, utc } from "./shared.js";

function admits(command: B07CommandId, role: MembershipRole): boolean {
  return roleSatisfies(B07_COMMANDS[command].role, role);
}

// --- uploads -------------------------------------------------------------------------------------------------------------------

/**
 * The commands a member may issue on an upload: CompleteUpload (CMD014) while UPLOADING and CancelUpload (CMD015) while in flight,
 * each to the upload's own requester with an operating role (D-SRC-2).
 */
export function uploadActions(membership: Pick<ResolvedMembership, "role" | "userId">, upload: Pick<UploadSessionRecord, "state" | "requestedByUserId">): ReadonlyArray<SourceResourceAction> {
  if (upload.requestedByUserId !== membership.userId) return [];
  const out: SourceResourceAction[] = [];
  if (admits("CMD014", membership.role) && upload.state === "UPLOADING") out.push("CompleteUpload");
  if (admits("CMD015", membership.role) && UPLOAD_LIVE_STATES.has(upload.state)) out.push("CancelUpload");
  return out;
}

/** An inspection receipt's separate results (09 "Completion and inspection": never one generic safe flag). */
export function uploadInspectionView(receipt: InspectionReceiptRecord): UploadInspectionView {
  return {
    structureStatus: receipt.structureStatus,
    scanState: receipt.scanState,
    semanticStatus: receipt.semanticStatus,
    detectedFormat: receipt.detectedFormat,
    claimConsistent: receipt.claimConsistent,
    scanCoverage: { expectedParts: receipt.expectedParts, scannedParts: receipt.scannedParts, expectedBytes: receipt.expectedBytes, scannedBytes: receipt.scannedBytes },
    problems: receipt.problems.map((p) => p.code),
    ...(receipt.rejectionClass !== undefined ? { rejectionClass: receipt.rejectionClass } : {}),
  };
}

/** An upload's safe progress (UploadView): the provider observation once the server made it, the inspection once decided. */
export function uploadView(upload: UploadSessionRecord, membership: Pick<ResolvedMembership, "role" | "userId">, receipt: InspectionReceiptRecord | null = null): UploadView {
  if (upload.displayName === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a request handler reads the upload with its display name");
  return {
    uploadId: upload.uploadId,
    revisionId: upload.revisionId,
    version: upload.version,
    state: upload.state,
    reservedBytes: upload.reservedBytes,
    applicationExpiresAt: utc(upload.applicationExpiresAt),
    providerCancellationState: upload.providerCancellationState,
    ...(upload.inspectionReceiptHash !== undefined ? { inspectionReceiptHash: upload.inspectionReceiptHash } : {}),
    agencyId: upload.agencyId,
    projectId: upload.projectId,
    displayName: upload.displayName,
    declaredFormat: upload.declaredFormat,
    ...(upload.observedBytes !== undefined && upload.completionObservedAt !== undefined ? { observation: { bytes: upload.observedBytes, observedAt: utc(upload.completionObservedAt) } } : {}),
    ...(receipt !== null ? { inspection: uploadInspectionView(receipt) } : {}),
    ...(upload.fileId !== undefined ? { fileId: upload.fileId } : {}),
    ...(upload.terminalReason !== undefined ? { terminalReason: upload.terminalReason } : {}),
    requestedByMembershipId: upload.requestedByMembershipId,
    createdAt: utc(upload.createdAt),
    permittedActions: uploadActions(membership, upload),
  };
}

/** The receipt of an upload's decided inspection (the one its outcome names), or null while undecided. */
export async function decidedReceipt(uow: SourceUnitOfWork, upload: UploadSessionRecord): Promise<InspectionReceiptRecord | null> {
  if (upload.inspectionReceiptHash === undefined) return null;
  return uow.sources.inspections.getByHash(upload.inspectionReceiptHash);
}

/** The revision's intake envelope as committed, with the agency's session ledger (R2-052: the database decides; this informs). */
export async function quotaView(uow: SourceUnitOfWork, revision: Pick<SourceRevisionRecord, "revisionId" | "agencyId">): Promise<RevisionQuotaView> {
  const quota = await uow.sources.uploads.quota(revision.revisionId);
  const capacity = await uow.sources.uploads.capacity(revision.agencyId);
  return {
    reservedBytes: quota.reservedBytes,
    fileCount: quota.fileCount,
    revisionBytesLimit: INPUT_ENVELOPE.revisionBytes,
    revisionFileLimit: INPUT_ENVELOPE.files,
    fileBytesLimit: INPUT_ENVELOPE.fileBytes,
    agencyActiveSessions: capacity.activeSessions,
    agencySessionLimit: capacity.sessionLimit,
  };
}

// --- revisions -------------------------------------------------------------------------------------------------------------------

export function revisionSummary(revision: Pick<SourceRevisionRecord, "revisionId" | "version" | "state">): RevisionSummaryView {
  return { revisionId: revision.revisionId, version: revision.version, state: revision.state };
}

export function retentionView(record: RetentionRecordRow): RetentionView {
  return {
    retentionId: record.retentionId,
    class: record.class,
    anchorEvidenceHash: record.anchorEvidenceHash,
    ...(record.softDeadline !== undefined ? { softDeadline: utc(record.softDeadline) } : {}),
    hardDeadline: utc(record.hardDeadline),
    effectiveDeadline: utc(record.effectiveDeadline),
    policyVersion: record.policyVersion,
    providerResiduals: [...record.providerResiduals],
    state: record.state,
  };
}

/** The durable facts a revision's view is computed from, read in the caller's unit of work. */
export interface RevisionFacts {
  readonly revision: SourceRevisionRecord;
  readonly project: ProjectRecord | null;
  readonly agency: AgencyRecord | null;
  readonly capabilityOffered: boolean;
  readonly uploads: ReadonlyArray<UploadSessionRecord>;
  /** Files admitted from the revision's own uploads, revoked ones included. */
  readonly files: ReadonlyArray<SourceFileRecord>;
  readonly records: ReadonlyArray<RetentionRecordRow>;
  /** The latest evaluation of the bound selection, when one is bound. */
  readonly evaluation: SelectionEvaluationRecord | null;
  /** The revision's current inventory hash (KAURO_SOURCE_INVENTORY_V1, D-SEL-3), for a revision whose inventory can still change. */
  readonly inventoryHash: Sha256Hex | null;
  readonly serverNow: string;
}

const ALL_UPLOAD_STATES = ["RESERVED", "UPLOADING", "VERIFYING", "ADMITTED", "CANCELLED", "EXPIRED", "REJECTED"] as const;

export async function revisionFacts(uow: SourceUnitOfWork, revision: SourceRevisionRecord): Promise<RevisionFacts> {
  const project = await uow.projects.get(revision.projectId);
  const agency = await uow.agencies.get(revision.agencyId);
  const capability = project === null ? null : await uow.capabilities.get(project.capabilityId);
  const uploads = await uow.sources.uploads.inStates(revision.revisionId, ALL_UPLOAD_STATES);
  const files = await uow.sources.files.listForRevision(revision.revisionId);
  const records = await uow.sources.retention.recordsFor(revision.revisionId);
  const evaluation = revision.selectionHash === undefined ? null : await uow.sources.evaluations.latestFor(revision.revisionId, revision.selectionHash);
  const inventoryHash = REVISION_MUTABLE_STATES.has(revision.state) ? inventoryHashOf(await uow.sources.revisions.inventory(revision.revisionId)) : null;
  return { revision, project, agency, capabilityOffered: capability !== null && isOffered(capability), uploads, files, records, evaluation, inventoryHash, serverNow: await uow.serverInstant() };
}

/**
 * Why a mutable revision cannot move forward now, in SOURCE_BLOCKERS order, from durable facts only. A closed revision (sealed,
 * superseded, rejected, cancelled, expired, deleted) has no next step a blocker could name.
 */
export function blockersOf(f: RevisionFacts): ReadonlyArray<SourceBlocker> {
  const r = f.revision;
  if (!REVISION_MUTABLE_STATES.has(r.state)) return [];
  const out: SourceBlocker[] = [];
  const intake = r.state === "DRAFT" || r.state === "UPLOADING";
  const inFlight = f.uploads.filter((u) => u.state === "RESERVED" || u.state === "UPLOADING");
  const verifying = f.uploads.filter((u) => u.state === "VERIFYING");
  const standing = f.files.filter((file) => file.state === "ADMITTED");
  if (f.agency === null || f.agency.state !== "ACTIVE") out.push("AGENCY_NOT_ACTIVE");
  if (f.project === null || f.project.state !== "OPEN") out.push("PROJECT_NOT_OPEN");
  if (!f.capabilityOffered) out.push("CAPABILITY_RESTRICTED");
  if (intake && f.uploads.length === 0 && r.selectionHash === undefined) out.push("NO_UPLOADS");
  if (inFlight.length > 0) out.push("UPLOADS_IN_PROGRESS");
  if (verifying.length > 0) out.push("INSPECTION_PENDING");
  if (intake && standing.length > 0 && inFlight.length === 0 && verifying.length === 0 && r.selectionHash === undefined) out.push("SELECTION_MISSING");
  if (r.selectionHash !== undefined && f.inventoryHash !== null && r.inventoryHash !== f.inventoryHash) out.push("SELECTION_STALE");
  if (r.state === "INSPECTING" && r.selectionHash !== undefined && f.evaluation === null) out.push("EVALUATION_PENDING");
  if (r.state === "INSPECTING" && f.evaluation !== null && f.evaluation.result !== "COMPLETE") out.push("EVALUATION_FAILED");
  if (f.files.some((file) => file.state === "ADMISSION_REVOKED")) out.push("INPUT_ADMISSION_REVOKED");
  // Q-B07-15: an intake whose every upload ended or passed its deadline with nothing admitted stays mutable, and says so
  const ended = (u: UploadSessionRecord): boolean => UPLOAD_TOMBSTONE_STATES.has(u.state) || (UPLOAD_LIVE_STATES.has(u.state) && reachedOnServer(u.applicationExpiresAt, f.serverNow));
  if (r.state === "UPLOADING" && f.uploads.length > 0 && standing.length === 0 && f.uploads.every(ended)) out.push("INTAKE_DEADLINE_PASSED");
  return out;
}

/**
 * The source-lifecycle commands a member may issue on a revision: CreateRevision (CMD012) on the project's current revision of an
 * OPEN project in an open agency; ReserveUpload (CMD013) while DRAFT or UPLOADING in an ACTIVE agency; SelectInputTables (CMD016)
 * while selectable; SealRevision (CMD017) once READY_TO_SEAL — each to an operating role (informative, never authority).
 */
export function revisionActions(role: MembershipRole, f: RevisionFacts): ReadonlyArray<SourceResourceAction> {
  const r = f.revision;
  const projectOpen = f.project !== null && f.project.state === "OPEN";
  const out: SourceResourceAction[] = [];
  if (admits("CMD012", role) && projectOpen && f.project?.currentRevisionId === r.revisionId && f.agency !== null && AGENCY_OPEN_STATES.has(f.agency.state)) out.push("CreateRevision");
  if (admits("CMD013", role) && projectOpen && REVISION_UPLOAD_STATES.has(r.state) && f.agency?.state === "ACTIVE") out.push("ReserveUpload");
  if (admits("CMD016", role) && REVISION_SELECTABLE_STATES.has(r.state)) out.push("SelectInputTables");
  if (admits("CMD017", role) && r.state === "READY_TO_SEAL") out.push("SealRevision");
  return out;
}

/** A revision: lifecycle, lineage, bound selection, frozen populations, seal and retention (SourceRevisionView). */
export function sourceRevisionView(f: RevisionFacts, role: MembershipRole): SourceRevisionView {
  const r = f.revision;
  const active = f.records.filter((x) => x.state === "ACTIVE");
  const availableUntil = active.map((x) => x.effectiveDeadline).sort()[0];
  const sealed = r.manifestHash !== undefined && r.projectionHash !== undefined && r.sealedFileCount !== undefined && r.sealedBytes !== undefined;
  return {
    revisionId: r.revisionId,
    version: r.version,
    state: r.state,
    ...(r.sealedAt !== undefined ? { sealedAt: utc(r.sealedAt) } : {}),
    ...(r.supersedesRevisionId !== undefined ? { supersedesRevisionId: r.supersedesRevisionId } : {}),
    agencyId: r.agencyId,
    projectId: r.projectId,
    ...(r.supersededByRevisionId !== undefined ? { supersededByRevisionId: r.supersededByRevisionId } : {}),
    ...(r.selectionManifestId !== undefined && r.selectionHash !== undefined && r.inventoryHash !== undefined && r.selectedAt !== undefined
      ? { selection: { selectionManifestId: r.selectionManifestId, selectionHash: r.selectionHash, inventoryHash: r.inventoryHash, selectedAt: utc(r.selectedAt) } }
      : {}),
    ...(r.evaluationHash !== undefined ? { evaluationHash: r.evaluationHash } : {}),
    ...(r.populations !== undefined ? { populations: r.populations } : {}),
    ...(sealed ? { seal: { manifestHash: r.manifestHash as Sha256Hex, projectionHash: r.projectionHash as Sha256Hex, fileCount: r.sealedFileCount as number, bytes: r.sealedBytes as number } } : {}),
    ...(f.records.length > 0 ? { retention: f.records.map(retentionView) } : {}),
    ...(availableUntil !== undefined ? { dataAvailableUntil: utc(availableUntil) } : {}),
    ...(r.terminalReason !== undefined ? { terminalReason: r.terminalReason } : {}),
    blockers: blockersOf(f),
    createdAt: utc(r.createdAt),
    permittedActions: revisionActions(role, f),
  };
}

/** The view of a revision as the caller's unit of work reads it now. */
export async function readRevisionView(uow: SourceUnitOfWork, revision: SourceRevisionRecord, role: MembershipRole): Promise<SourceRevisionView> {
  return sourceRevisionView(await revisionFacts(uow, revision), role);
}

// --- inspection ---------------------------------------------------------------------------------------------------------------

export function inspectionColumnView(column: SourceColumnRecord): InspectionColumnView {
  return { ordinal: column.ordinal, ...(column.labelDisplay !== undefined ? { label: column.labelDisplay } : {}), labelState: column.labelState };
}

export function inspectionTableView(table: SourceTableRecord, columns: ReadonlyArray<SourceColumnRecord>): InspectionTableView {
  return {
    tableId: table.tableId,
    ordinal: table.ordinal,
    kind: table.kind,
    ...(table.nameDisplay !== undefined ? { name: table.nameDisplay } : {}),
    visibility: table.visibility,
    columnCount: table.columnCount,
    ...(table.rowEstimate !== undefined ? { rowEstimate: table.rowEstimate } : {}),
    hasFormulas: table.hasFormulas,
    formulaCache: table.formulaCache,
    mergedCellCount: table.mergedCellCount,
    hiddenRowCount: table.hiddenRowCount,
    hiddenColumnCount: table.hiddenColumnCount,
    issues: [...table.issues],
    structureHash: table.structureHash,
    columns: columns.map(inspectionColumnView),
  };
}

/** An admitted file with its detected tables (FileManifest projection; the generation and the storage reference withheld). */
export async function inspectionFileView(uow: SourceUnitOfWork, file: SourceFileRecord, origin: InspectionFileView["origin"]): Promise<InspectionFileView> {
  const tables: InspectionTableView[] = [];
  for (const table of await uow.sources.files.tables(file.fileId)) tables.push(inspectionTableView(table, await uow.sources.files.columns(table.tableId)));
  return {
    fileId: file.fileId,
    sha256: file.sha256,
    bytes: file.bytes,
    format: file.format,
    scanState: file.scanState,
    parserProfileHash: file.parserProfileHash,
    admitted: file.admitted,
    origin,
    uploadId: file.originUploadId,
    tables,
  };
}

/** The upload views of a revision's uploads, each with its decided inspection. */
export async function uploadViews(uow: SourceUnitOfWork, uploads: ReadonlyArray<UploadSessionRecord>, membership: Pick<ResolvedMembership, "role" | "userId">): Promise<ReadonlyArray<UploadView>> {
  const out: UploadView[] = [];
  for (const upload of uploads) out.push(uploadView(upload, membership, await decidedReceipt(uow, upload)));
  return out;
}
