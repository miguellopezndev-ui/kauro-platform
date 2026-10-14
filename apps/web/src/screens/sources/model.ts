// UI14 source intake, UI15 selection and UI16 seal review as data (design D-STATE-1, D-OPS-1, D-SCR-3). What the api's views say and nothing
// more: the screens separate the facts of an upload (declared size, progress from this browser, the provider's observation, the scanner's
// coverage, the parser's state), show the inspection as the api reports it, and offer a command only when the server permits it. The browser
// clock only disables a resume; a session the server calls EXPIRED is the only reason a new reservation is offered.
import type {
  CancelUploadView,
  InspectionColumnView,
  InspectionFileView,
  InspectionTableView,
  InspectionView,
  ProtectedSessionView,
  ReserveUploadView,
  SelectionManifestDocument,
  SourceRevisionView,
  UploadView,
} from "../../api/generated.ts";
import type { ApiAnswer, CommandBody } from "../../client/answer.ts";
import type { ApiClient } from "../../client/api-client.ts";
import type { DurableRead, OperationRunner, OperationSubject, RunOutcome } from "../../client/operation-runner.ts";
import { message } from "../../copy/en.ts";

export type RevisionBlocker = SourceRevisionView["blockers"][number];

// ---------------------------------------------------------------- shared helpers

/** The data of a COMPLETED reply passed through `pick`; every other answer is unchanged. */
function mapData<From, To>(answer: ApiAnswer<CommandBody<From>>, pick: (data: From) => To): ApiAnswer<CommandBody<To>> {
  if (answer.kind === "REPLY" && answer.body.kind === "COMPLETED") return { ...answer, body: { ...answer.body, data: pick(answer.body.data) } };
  return answer as ApiAnswer<CommandBody<To>>;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- UI14: the facts of an upload

export interface UploadProgress {
  readonly sent: number;
  readonly total: number;
}

export type ScannerFact =
  | { readonly kind: "NOT_INSPECTED" }
  | {
      readonly kind: "INSPECTED";
      readonly state: NonNullable<UploadView["inspection"]>["scanState"];
      /** Only a clean scan that covered every expected part and byte is fully checked; a skip, an error and a partial scan are not. */
      readonly fullyChecked: boolean;
      readonly coverage: NonNullable<UploadView["inspection"]>["scanCoverage"];
    };

export type ParserFact = { readonly kind: "NOT_PARSED" } | { readonly kind: "PARSED"; readonly structure: NonNullable<UploadView["inspection"]>["structureStatus"]; readonly claimConsistent: boolean; readonly detectedFormat: NonNullable<UploadView["inspection"]>["detectedFormat"] };

export interface UploadFacts {
  readonly state: UploadView["state"];
  readonly declaredBytes: number;
  readonly progress: UploadProgress | null;
  readonly observation: NonNullable<UploadView["observation"]> | null;
  readonly scanner: ScannerFact;
  readonly parser: ParserFact;
  readonly problems: readonly string[];
  readonly terminalReason: string | null;
}

/** The five facts of one file, each from its own source and none derived from another (UI14: separate facts). */
export function uploadFacts(upload: UploadView, progress: UploadProgress | null = null): UploadFacts {
  const inspection = upload.inspection;
  return {
    state: upload.state,
    declaredBytes: upload.reservedBytes,
    progress,
    observation: upload.observation ?? null,
    scanner:
      inspection === undefined
        ? { kind: "NOT_INSPECTED" }
        : {
            kind: "INSPECTED",
            state: inspection.scanState,
            fullyChecked: inspection.scanState === "COVERED_CLEAN" && inspection.scanCoverage.scannedParts >= inspection.scanCoverage.expectedParts && inspection.scanCoverage.scannedBytes >= inspection.scanCoverage.expectedBytes,
            coverage: inspection.scanCoverage,
          },
    parser: inspection === undefined ? { kind: "NOT_PARSED" } : { kind: "PARSED", structure: inspection.structureStatus, claimConsistent: inspection.claimConsistent, detectedFormat: inspection.detectedFormat },
    problems: inspection?.problems ?? [],
    terminalReason: upload.terminalReason ?? null,
  };
}

export type ResumeOffer = "OFFERED" | "DISABLED_BY_CLOCK" | "NOT_OFFERED";

export interface UploadActions {
  /** Cancel is the server's: CancelUpload in the upload's permittedActions. */
  readonly canCancel: boolean;
  /** Resume continues a still-valid session. The browser clock can turn an offer into DISABLED_BY_CLOCK and nothing else. */
  readonly resume: ResumeOffer;
  /** A new, explicit reservation: only after the server itself calls the session EXPIRED (or CANCELLED), and only when it permits ReserveUpload. */
  readonly newReservation: boolean;
}

export function uploadActions(upload: UploadView, revision: SourceRevisionView, nowMs: number): UploadActions {
  const open = upload.state === "RESERVED" || upload.state === "UPLOADING";
  const mayAct = upload.permittedActions.includes("CompleteUpload");
  const clockPast = nowMs >= Date.parse(upload.applicationExpiresAt);
  return {
    canCancel: upload.permittedActions.includes("CancelUpload"),
    resume: !open || !mayAct ? "NOT_OFFERED" : clockPast ? "DISABLED_BY_CLOCK" : "OFFERED",
    newReservation: (upload.state === "EXPIRED" || upload.state === "CANCELLED") && revision.permittedActions.includes("ReserveUpload"),
  };
}

export interface SourcesModel {
  /** A new file can be added: the server permits ReserveUpload and the deployment has an upload destination. */
  readonly canAdd: boolean;
  readonly uploadUnavailable: boolean;
  readonly blockers: readonly RevisionBlocker[];
  readonly canGoToSelection: boolean;
}

export function sourcesModel(revision: SourceRevisionView, uploadOrigin: string | null): SourcesModel {
  const permitted = revision.permittedActions.includes("ReserveUpload");
  return {
    canAdd: permitted && uploadOrigin !== null,
    uploadUnavailable: permitted && uploadOrigin === null,
    blockers: revision.blockers,
    canGoToSelection: revision.permittedActions.includes("SelectInputTables") || revision.state === "INSPECTING" || revision.state === "READY_TO_SEAL",
  };
}

// ---------------------------------------------------------------- UI14: the cross-origin PUT (D-SCR-3)

export type UploadUnavailable = "NO_UPLOAD_ORIGIN" | "SESSION_UNAVAILABLE" | "ORIGIN_MISMATCH";

export type UploadTarget = { readonly kind: "READY"; readonly url: string } | { readonly kind: "UNAVAILABLE"; readonly reason: UploadUnavailable };

/** Where the file may be sent: the provider's session URL, and only when its origin is exactly the configured upload origin. */
export function uploadTarget(session: ProtectedSessionView, configuredOrigin: string | null): UploadTarget {
  if (configuredOrigin === null) return { kind: "UNAVAILABLE", reason: "NO_UPLOAD_ORIGIN" };
  if (session.delivery !== "PROTECTED_RESPONSE" || session.uploadUrl === undefined || session.method !== "PUT") return { kind: "UNAVAILABLE", reason: "SESSION_UNAVAILABLE" };
  let url: URL;
  try {
    url = new URL(session.uploadUrl);
  } catch {
    return { kind: "UNAVAILABLE", reason: "ORIGIN_MISMATCH" };
  }
  if (url.origin !== configuredOrigin || url.username !== "" || url.password !== "") return { kind: "UNAVAILABLE", reason: "ORIGIN_MISMATCH" };
  return { kind: "READY", url: session.uploadUrl };
}

export type PutResult = { readonly kind: "SENT"; readonly completionRef: string } | { readonly kind: "FAILED"; readonly status: number | null };

/** The browser's PUT to the provider (upload-transport.ts); a test passes its own. */
export interface UploadTransport {
  put(input: { readonly url: string; readonly body: Blob; readonly onProgress: (progress: UploadProgress) => void }): Promise<PutResult>;
}

export interface ChosenFile {
  readonly name: string;
  readonly size: number;
  readonly body: Blob;
}

export type FileProblem = "FORMAT" | "NAME";

export function formatOfName(name: string): "CSV" | "XLSX" | null {
  const lower = name.toLowerCase();
  return lower.endsWith(".csv") ? "CSV" : lower.endsWith(".xlsx") ? "XLSX" : null;
}

/** What the person is told before anything is sent: the api would refuse the same. */
export function fileProblem(file: Pick<ChosenFile, "name">): FileProblem | null {
  if (formatOfName(file.name) === null) return "FORMAT";
  // eslint-disable-next-line no-control-regex
  if (file.name.length === 0 || file.name.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(file.name)) return "NAME";
  return null;
}

// ---------------------------------------------------------------- UI14: the commands CMD013-CMD015

/** CMD013: one reservation per revision version and file. The subject names the file (name, size, format), so a reload replays the same key and a second file is a second intent. */
export async function reserveSubject(revision: SourceRevisionView, file: Pick<ChosenFile, "name" | "size">): Promise<OperationSubject> {
  const signature = (await sha256Hex(`${file.name}\n${file.size}\n${formatOfName(file.name) ?? ""}`)).slice(0, 32);
  return { kind: "SUBJECT", subjectId: revision.revisionId, subjectVersion: `${revision.version}-${signature}` };
}

export async function reserveUpload(client: ApiClient, runner: OperationRunner, revision: SourceRevisionView, file: Pick<ChosenFile, "name" | "size">): Promise<RunOutcome<ReserveUploadView>> {
  const declaredFormat = formatOfName(file.name);
  if (declaredFormat === null) throw new RangeError("a file is CSV or XLSX");
  return runner.run<ReserveUploadView>({
    command: "CMD013",
    subject: await reserveSubject(revision, file),
    send: (key) => client.call("ReserveUpload", { path: { revisionId: revision.revisionId }, body: { expectedVersion: revision.version, declaredBytes: file.size, declaredFormat, displayName: file.name }, idempotencyKey: key }),
  });
}

/** After a lost answer to complete or cancel, the durable upload says what happened. */
function readUploadWhere(client: ApiClient, uploadId: string, decided: (upload: UploadView) => boolean): () => Promise<DurableRead<UploadView>> {
  return async () => {
    const answer = await client.call("GetUpload", { path: { uploadId } });
    if (answer.kind !== "REPLY") return { kind: "NO_ANSWER" };
    return decided(answer.body.data) ? { kind: "RESOLVED", data: answer.body.data } : { kind: "NOT_YET" };
  };
}

/** CMD014: complete under the upload's own key. A lost answer re-reads the upload (never reserves again): any state past RESERVED/UPLOADING means the server took it. */
export function completeUpload(client: ApiClient, runner: OperationRunner, upload: UploadView, completionRef: string): Promise<RunOutcome<UploadView>> {
  return runner.run<UploadView>({
    command: "CMD014",
    subject: { kind: "SUBJECT", subjectId: upload.uploadId, subjectVersion: upload.version },
    send: (key) => client.call("CompleteUpload", { path: { uploadId: upload.uploadId }, body: { providerCompletionRef: completionRef }, idempotencyKey: key }),
    reread: readUploadWhere(client, upload.uploadId, (read) => read.state !== "RESERVED" && read.state !== "UPLOADING"),
  });
}

/** CMD015: cancel under the upload's own key; the durable result is CANCELLED. */
export function cancelUpload(client: ApiClient, runner: OperationRunner, upload: UploadView): Promise<RunOutcome<UploadView>> {
  return runner.run<UploadView>({
    command: "CMD015",
    subject: { kind: "SUBJECT", subjectId: upload.uploadId, subjectVersion: upload.version },
    send: async (key) => mapData<CancelUploadView, UploadView>(await client.call("CancelUpload", { path: { uploadId: upload.uploadId }, body: { expectedVersion: upload.version }, idempotencyKey: key }), (view) => view.upload),
    reread: readUploadWhere(client, upload.uploadId, (read) => read.state === "CANCELLED"),
  });
}

export interface UploadFlowDeps {
  readonly client: ApiClient;
  readonly runner: OperationRunner;
  readonly transport: UploadTransport;
  /** The configured upload origin (D-SCR-3), or null when the deployment names none. */
  readonly uploadOrigin: string | null;
  readonly onProgress: (uploadId: string, progress: UploadProgress) => void;
}

export type UploadFlowResult =
  | { readonly kind: "REFUSED"; readonly problem: FileProblem }
  | { readonly kind: "UNAVAILABLE"; readonly reason: UploadUnavailable; readonly upload: UploadView | null }
  | { readonly kind: "RESERVE_ENDED"; readonly outcome: RunOutcome<ReserveUploadView> }
  | { readonly kind: "SEND_FAILED"; readonly upload: UploadView; readonly status: number | null }
  | { readonly kind: "COMPLETE_ENDED"; readonly upload: UploadView; readonly outcome: RunOutcome<UploadView> };

async function sendAndComplete(deps: UploadFlowDeps, upload: UploadView, session: ProtectedSessionView, file: ChosenFile): Promise<UploadFlowResult> {
  const target = uploadTarget(session, deps.uploadOrigin);
  if (target.kind === "UNAVAILABLE") return { kind: "UNAVAILABLE", reason: target.reason, upload };
  const sent = await deps.transport.put({ url: target.url, body: file.body, onProgress: (progress) => deps.onProgress(upload.uploadId, progress) });
  if (sent.kind === "FAILED") return { kind: "SEND_FAILED", upload, status: sent.status };
  return { kind: "COMPLETE_ENDED", upload, outcome: await completeUpload(deps.client, deps.runner, upload, sent.completionRef) };
}

/** Reserve (CMD013), send the file to the provider's session, complete (CMD014). With no upload origin nothing is reserved. */
export async function uploadFile(deps: UploadFlowDeps, revision: SourceRevisionView, file: ChosenFile): Promise<UploadFlowResult> {
  const problem = fileProblem(file);
  if (problem !== null) return { kind: "REFUSED", problem };
  if (deps.uploadOrigin === null) return { kind: "UNAVAILABLE", reason: "NO_UPLOAD_ORIGIN", upload: null };
  const reserved = await reserveUpload(deps.client, deps.runner, revision, file);
  if (reserved.kind !== "COMPLETED" && reserved.kind !== "RECOVERED") return { kind: "RESERVE_ENDED", outcome: reserved };
  return sendAndComplete(deps, reserved.data.upload, reserved.data.session, file);
}

/** Resume (UI14): a still-valid session is read again and the same file is sent again. Never a reservation. */
export async function resumeUpload(deps: UploadFlowDeps, upload: UploadView, file: ChosenFile): Promise<UploadFlowResult> {
  if (deps.uploadOrigin === null) return { kind: "UNAVAILABLE", reason: "NO_UPLOAD_ORIGIN", upload };
  const answer = await deps.client.call("GetUploadSession", { path: { uploadId: upload.uploadId } });
  if (answer.kind !== "REPLY") return { kind: "UNAVAILABLE", reason: "SESSION_UNAVAILABLE", upload };
  return sendAndComplete(deps, upload, answer.body.data, file);
}

// ---------------------------------------------------------------- UI15: the inspection and the selection

/** "Email - column 3": a duplicated header is told apart by its position (the api's ordinal is zero-based). */
export function columnLabel(column: InspectionColumnView): string {
  const position = column.ordinal + 1;
  const label = column.label ?? "";
  switch (column.labelState) {
    case "DUPLICATE_LABEL":
      return message("screen.sources.selection.column.duplicate", { label, position });
    case "PRESENT":
      return message("screen.sources.selection.column.plain", { label });
    case "DISPLAY_TRUNCATED":
      return message("screen.sources.selection.column.DISPLAY_TRUNCATED", { label, position });
    case "EMPTY":
      return message("screen.sources.selection.column.EMPTY", { position });
    case "NO_HEADER":
      return message("screen.sources.selection.column.NO_HEADER", { position });
    case "UNDECODABLE":
      return message("screen.sources.selection.column.UNDECODABLE", { position });
  }
}

/** The reasons a table can be excluded for, as the api's reason tokens; the person picks one, the screen shows its words. */
export const EXCLUSION_REASONS = ["NOT_PART_OF_THIS_PROJECT", "OLD_OR_ARCHIVED_DATA", "DUPLICATE_OF_ANOTHER_TABLE", "TEST_OR_SAMPLE_DATA", "OTHER"] as const;

/** The words of a reason token: a known one in plain English, any other token (the api's own) as it is. */
export function exclusionReasonText(token: string): string {
  return (EXCLUSION_REASONS as readonly string[]).includes(token) || token === "FILE_NOT_ADMITTED" || token === "NO_TABLE_SELECTED" ? message(`screen.sources.reason.${token as "OTHER"}`) : token;
}

export interface DraftTable {
  readonly include: boolean;
  readonly reason: string;
  readonly hiddenAcknowledged: boolean;
}

export type Draft = Readonly<Record<string, DraftTable>>;


/** The selection the server holds, or - before any - the visible tables of the admitted files included and every other table to be decided. */
export function initialDraft(inspection: InspectionView): Draft {
  const draft: Record<string, DraftTable> = {};
  const held = new Map((inspection.selection?.tables ?? []).map((table) => [table.tableId, table] as const));
  for (const file of inspection.files) {
    for (const table of file.tables) {
      const known = held.get(table.tableId);
      if (known !== undefined) draft[table.tableId] = { include: known.disposition === "INCLUDE", reason: known.exclusionReason ?? "", hiddenAcknowledged: known.disposition === "INCLUDE" && table.visibility !== "VISIBLE" };
      else draft[table.tableId] = { include: file.admitted && table.visibility === "VISIBLE", reason: "", hiddenAcknowledged: false };
    }
  }
  return draft;
}

export type DraftProblem = { readonly tableId: string; readonly problem: "REASON_REQUIRED" | "HIDDEN_ACK_REQUIRED" };

/** What stops the person from confirming: an excluded table without its reason, a hidden sheet included without being acknowledged. */
export function draftProblems(inspection: InspectionView, draft: Draft): readonly DraftProblem[] {
  const found: DraftProblem[] = [];
  for (const file of inspection.files) {
    if (!file.admitted) continue;
    for (const table of file.tables) {
      const choice = draft[table.tableId];
      if (choice === undefined) continue;
      if (!choice.include && choice.reason.trim() === "") found.push({ tableId: table.tableId, problem: "REASON_REQUIRED" });
      if (choice.include && table.visibility !== "VISIBLE" && !choice.hiddenAcknowledged) found.push({ tableId: table.tableId, problem: "HIDDEN_ACK_REQUIRED" });
    }
  }
  return found;
}

export function draftChanged(inspection: InspectionView, draft: Draft): boolean {
  const held = initialDraft(inspection);
  return Object.keys({ ...held, ...draft }).some((tableId) => {
    const a = held[tableId];
    const b = draft[tableId];
    return a?.include !== b?.include || (a?.include === false && a.reason !== b?.reason);
  });
}

export interface CountsView {
  readonly populations: NonNullable<NonNullable<InspectionView["evaluation"]>["populations"]> | null;
  /** The counts belong to an earlier selection until the new one is evaluated (UI15: a change invalidates counts). */
  readonly stale: boolean;
}

export function countsView(revision: SourceRevisionView, inspection: InspectionView, draft: Draft): CountsView {
  const populations = inspection.evaluation?.populations ?? null;
  const serverSaysStale = revision.blockers.includes("SELECTION_STALE") || revision.blockers.includes("EVALUATION_PENDING");
  return { populations, stale: populations !== null && (draftChanged(inspection, draft) || serverSaysStale) };
}

/** The manifest the person confirmed, in the api's own document shape. Projections and associations are the plan's later decisions: none are invented here. */
export function selectionDocument(inspection: InspectionView, draft: Draft): SelectionManifestDocument {
  return {
    schemaVersion: 1,
    revisionId: inspection.revision.revisionId,
    inventoryHash: inspection.inventoryHash,
    files: inspection.files.map((file) => {
      const included = file.admitted && file.tables.some((table) => draft[table.tableId]?.include === true);
      return {
        fileId: file.fileId,
        origin: file.origin === "REUSABLE" ? ("REUSED" as const) : ("THIS_REVISION" as const),
        disposition: included ? ("INCLUDE" as const) : ("EXCLUDE" as const),
        ...(included ? {} : { exclusionReason: file.admitted ? "NO_TABLE_SELECTED" : "FILE_NOT_ADMITTED" }),
      };
    }),
    tables: inspection.files.flatMap((file) =>
      file.tables.map((table: InspectionTableView) => {
        const choice = draft[table.tableId];
        const include = file.admitted && choice?.include === true;
        return {
          tableId: table.tableId,
          fileId: file.fileId,
          structureHash: table.structureHash,
          disposition: include ? ("INCLUDE" as const) : ("EXCLUDE" as const),
          ...(include ? (table.visibility === "VISIBLE" ? {} : { hiddenSheetAcknowledged: true as const }) : { exclusionReason: file.admitted ? (choice?.reason.trim() ?? "") : "FILE_NOT_ADMITTED" }),
        };
      }),
    ),
    projections: [],
    associations: [],
  };
}

export type ConfirmSelectionResult =
  | { readonly kind: "SUBMIT_ENDED"; readonly answer: ApiAnswer<unknown> }
  | { readonly kind: "SELECT_ENDED"; readonly manifestId: string; readonly outcome: RunOutcome<SourceRevisionView> };

function readRevisionWhere(client: ApiClient, revisionId: string, decided: (revision: SourceRevisionView) => boolean): () => Promise<DurableRead<SourceRevisionView>> {
  return async () => {
    const answer = await client.call("GetRevision", { path: { revisionId } });
    if (answer.kind !== "REPLY") return { kind: "NO_ANSWER" };
    return decided(answer.body.data) ? { kind: "RESOLVED", data: answer.body.data } : { kind: "NOT_YET" };
  };
}

/** The document is stored by content (SubmitSelectionManifest has no key: the same document is the same manifest); CMD016 then selects it under the revision version and the manifest. */
export async function confirmSelection(client: ApiClient, runner: OperationRunner, revision: SourceRevisionView, document: SelectionManifestDocument): Promise<ConfirmSelectionResult> {
  const submitted = await client.call("SubmitSelectionManifest", { path: { revisionId: revision.revisionId }, body: document });
  if (submitted.kind !== "REPLY") return { kind: "SUBMIT_ENDED", answer: submitted };
  const manifestId = submitted.body.data.selectionManifestId;
  const outcome = await runner.run<SourceRevisionView>({
    command: "CMD016",
    subject: { kind: "SUBJECT", subjectId: revision.revisionId, subjectVersion: `${revision.version}-${manifestId}` },
    send: async (key) => mapData(await client.call("SelectInputTables", { path: { revisionId: revision.revisionId }, body: { expectedVersion: revision.version, selectionManifestRef: manifestId }, idempotencyKey: key }), (view) => view.revision),
    reread: readRevisionWhere(client, revision.revisionId, (read) => read.selection?.selectionManifestId === manifestId),
  });
  return { kind: "SELECT_ENDED", manifestId, outcome };
}

// ---------------------------------------------------------------- UI16: the seal review

export type SealOffer =
  | { readonly kind: "SEALED" }
  | { readonly kind: "BLOCKED"; readonly blockers: readonly RevisionBlocker[] }
  | { readonly kind: "STALE" }
  | { readonly kind: "NOT_PERMITTED" }
  | { readonly kind: "OFFERED"; readonly selectionHash: string; readonly inventoryHash: string };

/**
 * Seal is offered only for READY_TO_SEAL with nothing unresolved, a selection made against the inventory the page shows, and the server's
 * permission. The hash sent is the selection hash bound to the inventory shown; a selection made against another inventory is STALE.
 */
export function sealOffer(revision: SourceRevisionView, inspection: InspectionView): SealOffer {
  if (revision.state === "SEALED") return { kind: "SEALED" };
  const selection = revision.selection;
  if (revision.state !== "READY_TO_SEAL" || revision.blockers.length > 0 || selection === undefined || inspection.evaluation?.result !== "COMPLETE") return { kind: "BLOCKED", blockers: revision.blockers };
  if (selection.inventoryHash !== inspection.inventoryHash) return { kind: "STALE" };
  if (!revision.permittedActions.includes("SealRevision")) return { kind: "NOT_PERMITTED" };
  return { kind: "OFFERED", selectionHash: selection.selectionHash, inventoryHash: inspection.inventoryHash };
}

export interface SealMeasures {
  readonly physicalSourceRows: number;
  readonly billableSourceUnits: number;
  readonly associationEdges: number;
}

/** Three labelled measures from the api's populations; a single "records" figure is never composed (R2-065). */
export function sealMeasures(revision: SourceRevisionView, inspection: InspectionView): SealMeasures | null {
  const populations = revision.populations ?? inspection.evaluation?.populations;
  return populations === undefined ? null : { physicalSourceRows: populations.physicalSourceRows, billableSourceUnits: populations.billableSourceUnits, associationEdges: populations.associationEdges };
}

export interface SelectedTable {
  readonly tableId: string;
  readonly fileName: string;
  readonly tableName: string;
  readonly disposition: "INCLUDE" | "EXCLUDE";
  readonly exclusionReason: string | null;
}

/** The tables of the selection in force with the names of their files, in the inspection's order. */
export function selectedTables(inspection: InspectionView): readonly SelectedTable[] {
  const chosen = new Map((inspection.selection?.tables ?? []).map((table) => [table.tableId, table] as const));
  const names = new Map(inspection.uploads.map((upload) => [upload.fileId ?? "", upload.displayName] as const));
  return inspection.files.flatMap((file) =>
    file.tables.flatMap((table) => {
      const row = chosen.get(table.tableId);
      return row === undefined
        ? []
        : [{ tableId: table.tableId, fileName: names.get(file.fileId) ?? file.fileId, tableName: table.name ?? message("screen.sources.selection.table.unnamed.body", { ordinal: table.ordinal + 1 }), disposition: row.disposition, exclusionReason: row.exclusionReason ?? null }];
    }),
  );
}

/** CMD017: seal under the revision version and the selection hash; a lost answer re-reads the revision (SEALED means it took). */
export function sealRevision(client: ApiClient, runner: OperationRunner, revision: SourceRevisionView, selectionHash: string): Promise<RunOutcome<SourceRevisionView>> {
  return runner.run<SourceRevisionView>({
    command: "CMD017",
    subject: { kind: "SUBJECT", subjectId: revision.revisionId, subjectVersion: `${revision.version}-${selectionHash}` },
    send: async (key) => mapData(await client.call("SealRevision", { path: { revisionId: revision.revisionId }, body: { expectedVersion: revision.version, selectionHash }, idempotencyKey: key }), (view) => view.revision),
    reread: readRevisionWhere(client, revision.revisionId, (read) => read.state === "SEALED"),
  });
}
