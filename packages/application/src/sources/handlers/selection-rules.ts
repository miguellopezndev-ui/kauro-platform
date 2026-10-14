/**
 * The rules a selection manifest meets (design §11 CMD016 step 7; D-SEL-1, D-SEL-3, D-SEL-4, D-RET-3; catalogue CMD016 failure
 * "Missing or newly changed tables invalidate previous selection; no hidden-sheet silent inclusion"; 03 "Count the correct
 * population"; 04 "XLSX parser requirements").
 *
 * Two halves. `checkDocument` is the document's internal consistency, decided without the inventory — the selection manifest
 * intake stores only a document that passes it (D-SEL-2), and CMD016 repeats it: an exclusion names its reason, an included table
 * names a parser of one kind with that kind's choices, a projection names an included table, positional fields and, for a
 * referenced entity, a confirmed key, an association joins a ROW projection to a REFERENCED_ENTITY projection of the same table.
 * `checkAgainstInventory` is CMD016's comparison with the revision's settled inventory and the project's reusable files: every
 * candidate disposed, every file and table known at its current structure, included files admitted (a reused one still within the
 * fourteen days of its bytes' first seal, D-RET-3), hidden sheets acknowledged, formula policies named, parser choices fitting the
 * detected table, columns in range and within 800, the revision envelope. The database repeats the file-and-table comparison row by
 * row at binding (kauro.check_selection_inventory, D-SEL-4): the backstop a handler cannot skip.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { ParserChoice, ProjectionDeclaration, SelectionManifestDocument, SourceFileId, SourceFileRecord, SourceRevisionRecord, SourceTableRecord, SourceUnitOfWork } from "@kauro/domain";
import { DomainFailure, INPUT_ENVELOPE, effectNowOf, unpaidSealedDeadlines } from "@kauro/domain";
import { reachedOnServer } from "./shared.js";

/** What CMD016 binds and reports once a manifest passed every rule. */
export interface SelectionSummary {
  readonly includedFileCount: number;
  readonly includedTableCount: number;
  readonly reusedFileIds: ReadonlyArray<SourceFileId>;
}

function parserFits(parser: ParserChoice | undefined, kind: SourceTableRecord["kind"] | "ANY"): boolean {
  if (parser === undefined) return false;
  const p = parser as unknown as Readonly<Record<string, unknown>>;
  const has = (k: string): boolean => p[k] !== undefined;
  const header = p["header"] as { readonly mode?: string; readonly rowIndex?: number } | undefined;
  if (p["kind"] === "CSV") {
    if (kind === "WORKSHEET") return false;
    if (!has("encoding") || !has("delimiter") || !has("quote") || !has("blankLines") || header === undefined) return false;
    if (header.mode !== "FIRST_RECORD" && header.mode !== "NONE") return false;
    if (header.rowIndex !== undefined) return false;
    return !["formulas", "hiddenRows", "hiddenColumns", "mergedCells"].some(has);
  }
  if (p["kind"] === "WORKSHEET") {
    if (kind === "CSV_TABLE") return false;
    if (!has("formulas") || !has("hiddenRows") || !has("hiddenColumns") || !has("mergedCells") || header === undefined) return false;
    if (header.mode === "ROW" ? header.rowIndex === undefined : header.mode !== "NONE" || header.rowIndex !== undefined) return false;
    return !["encoding", "delimiter", "quote", "blankLines"].some(has);
  }
  return false;
}

/** The document's internal consistency (the intake's rule, repeated by CMD016). */
export function checkDocument(document: SelectionManifestDocument): void {
  for (const f of document.files) {
    if (f.disposition === "EXCLUDE" && f.exclusionReason === undefined) {
      throw new DomainFailure("INVALID_REQUEST", "an excluded file names its reason", { reason: "EXCLUSION_REASON_REQUIRED" });
    }
  }
  const included = new Set<string>();
  for (const t of document.tables) {
    if (t.disposition === "EXCLUDE") {
      if (t.exclusionReason === undefined) throw new DomainFailure("INVALID_REQUEST", "an excluded table names its reason", { reason: "EXCLUSION_REASON_REQUIRED" });
      continue;
    }
    if (!parserFits(t.parser, "ANY")) throw new DomainFailure("INVALID_REQUEST", "an included table names a parser of one kind with that kind's choices", { reason: "PARSER_CHOICE_INVALID" });
    included.add(t.tableId);
  }
  const projections = new Map<string, ProjectionDeclaration>();
  for (const p of document.projections) {
    if (projections.has(p.projectionKey) || !included.has(p.tableId)) throw new DomainFailure("INVALID_REQUEST", "a projection names an included table under a key of its own", { reason: "PROJECTION_INVALID" });
    if (p.kind === "ROW" && (p.keyOrdinals !== undefined || p.keyConfirmed !== undefined)) throw new DomainFailure("INVALID_REQUEST", "a row projection declares no key", { reason: "PROJECTION_INVALID" });
    if (p.kind === "REFERENCED_ENTITY" && (p.keyOrdinals === undefined || p.keyConfirmed !== true)) {
      throw new DomainFailure("INVALID_REQUEST", "a referenced-entity projection names a key the agency confirmed", { reason: "PROJECTION_KEY_NOT_CONFIRMED" });
    }
    projections.set(p.projectionKey, p);
  }
  const associations = new Set<string>();
  for (const a of document.associations) {
    const from = projections.get(a.fromProjectionKey);
    const to = projections.get(a.toProjectionKey);
    if (associations.has(a.associationKey) || from === undefined || to === undefined || from.kind !== "ROW" || to.kind !== "REFERENCED_ENTITY" || from.tableId !== a.tableId || to.tableId !== a.tableId) {
      throw new DomainFailure("INVALID_REQUEST", "an association joins a row projection to a referenced entity of the same table", { reason: "PROJECTION_INVALID" });
    }
    associations.add(a.associationKey);
  }
}

/**
 * The fourteen days of reused bytes: the first seal of any of them (D-RET-3) is the start of their hard cap. Each window is judged at
 * the effect instant read after the read it judges (CLOCK-SWEEP-B07 S5); the seal re-judges the cap (S4, the deferred COMMIT trigger).
 */
async function reuseAvailable(uow: SourceUnitOfWork, file: SourceFileRecord): Promise<boolean> {
  const [first] = await uow.sources.seals.firstSeals([file.fileId]);
  if (first !== undefined) {
    const effectNow = await effectNowOf(uow);
    return !reachedOnServer(unpaidSealedDeadlines(first.sealedAt as UtcInstant).hardDeadline, effectNow);
  }
  // bytes no seal ever included follow their upload's window (D-RET-1): an expired intake is no longer reusable
  const upload = await uow.sources.uploads.get(file.originUploadId);
  const effectNow = await effectNowOf(uow);
  return upload !== null && !reachedOnServer(upload.applicationExpiresAt, effectNow);
}

/**
 * CMD016's comparison of a manifest with the revision's settled inventory (its own admitted files) and the project's reusable
 * files, in the reasons of the catalogue. The inventory hash equality (SELECTION_STALE) is decided before, by the handler.
 */
export async function checkAgainstInventory(uow: SourceUnitOfWork, revision: SourceRevisionRecord, document: SelectionManifestDocument): Promise<SelectionSummary> {
  checkDocument(document);
  const own = (await uow.sources.files.listForRevision(revision.revisionId)).filter((f) => f.state === "ADMITTED");
  const named = new Map(document.files.map((f) => [f.fileId as string, f]));
  if (named.size !== document.files.length) throw new DomainFailure("INVALID_REQUEST", "the manifest disposes a file twice", { reason: "SELECTION_UNKNOWN_TABLE" });
  // every candidate of the settled inventory is disposed (a missing input invalidates the selection)
  for (const f of own) if (!named.has(f.fileId)) throw new DomainFailure("INVALID_REQUEST", "an admitted file of the revision has no disposition", { reason: "SELECTION_INCOMPLETE" });
  const files = new Map<string, SourceFileRecord>();
  const reused: SourceFileId[] = [];
  let includedBytes = 0;
  let includedFiles = 0;
  for (const entry of document.files) {
    const file = await uow.sources.files.get(entry.fileId);
    const thisRevision = file !== null && file.originRevisionId === revision.revisionId;
    if (file === null || file.projectId !== revision.projectId || (entry.origin === "THIS_REVISION") !== thisRevision) {
      throw new DomainFailure("INVALID_REQUEST", "the manifest names a file the inventory does not have", { reason: "SELECTION_UNKNOWN_TABLE" });
    }
    files.set(file.fileId, file);
    if (entry.disposition !== "INCLUDE") continue;
    if (entry.origin === "THIS_REVISION" && file.state !== "ADMITTED") {
      throw new DomainFailure("INVALID_REQUEST", "an included file is not an admitted file of this project", { reason: "SELECTION_FILE_NOT_ADMITTED" });
    }
    if (entry.origin === "REUSED") {
      if (file.state !== "ADMITTED" || !(await reuseAvailable(uow, file))) {
        throw new DomainFailure("PRECONDITION_FAILED", "a reused file's bytes are no longer available for a new seal", { reason: "REUSE_NOT_AVAILABLE" });
      }
      reused.push(file.fileId);
    }
    includedFiles += 1;
    includedBytes += file.bytes;
  }
  if (includedFiles === 0) throw new DomainFailure("INVALID_REQUEST", "a selection includes at least one file", { reason: "SELECTION_INCOMPLETE" });
  // the tables: exactly the detected tables of the named files at their current structure, each of an included file disposed
  const tablesOf = new Map<string, ReadonlyArray<SourceTableRecord>>();
  for (const fileId of files.keys()) tablesOf.set(fileId, await uow.sources.files.tables(fileId as SourceFileId));
  const disposed = new Set<string>();
  let includedTables = 0;
  for (const t of document.tables) {
    const table = tablesOf.get(t.fileId)?.find((x) => x.tableId === t.tableId);
    const fileEntry = named.get(t.fileId);
    if (table === undefined || fileEntry === undefined || table.structureHash !== t.structureHash || disposed.has(t.tableId) || (t.disposition === "INCLUDE" && fileEntry.disposition !== "INCLUDE")) {
      throw new DomainFailure("INVALID_REQUEST", "the manifest names a table the inventory does not have", { reason: "SELECTION_UNKNOWN_TABLE" });
    }
    disposed.add(t.tableId);
    if (t.disposition !== "INCLUDE") continue;
    includedTables += 1;
    if (table.visibility !== "VISIBLE" && t.hiddenSheetAcknowledged !== true) {
      throw new DomainFailure("INVALID_REQUEST", "a hidden worksheet is included without its acknowledgement", { reason: "HIDDEN_SHEET_NOT_ACKNOWLEDGED" });
    }
    if (!parserFits(t.parser, table.kind)) throw new DomainFailure("INVALID_REQUEST", "the parser choice does not fit the detected table", { reason: "PARSER_CHOICE_INVALID" });
    if (table.kind === "WORKSHEET" && table.hasFormulas && t.parser !== undefined && t.parser.kind === "WORKSHEET" && t.parser.formulas === "NOT_PRESENT") {
      throw new DomainFailure("INVALID_REQUEST", "an included worksheet with formulas names its formula policy", { reason: "FORMULA_POLICY_REQUIRED" });
    }
    const columns = t.selectedColumns ?? null;
    if (columns === null ? table.columnCount > INPUT_ENVELOPE.columns : columns.length > INPUT_ENVELOPE.columns) {
      throw new DomainFailure("INVALID_REQUEST", "a table selects at most 800 columns", { reason: "SELECTED_COLUMNS_LIMIT" });
    }
    if (columns !== null && (new Set(columns).size !== columns.length || columns.some((c) => c >= table.columnCount))) {
      throw new DomainFailure("INVALID_REQUEST", "the selected columns are positions of the detected table", { reason: "PARSER_CHOICE_INVALID" });
    }
  }
  for (const [fileId, tables] of tablesOf) {
    if (named.get(fileId)?.disposition !== "INCLUDE") continue;
    for (const t of tables) if (!disposed.has(t.tableId)) throw new DomainFailure("INVALID_REQUEST", "a table of an included file has no disposition", { reason: "SELECTION_INCOMPLETE" });
  }
  // projections over the included tables' selected columns
  const tableEntry = new Map(document.tables.map((t) => [t.tableId as string, t]));
  for (const p of document.projections) {
    const t = tableEntry.get(p.tableId);
    const table = t === undefined ? undefined : tablesOf.get(t.fileId)?.find((x) => x.tableId === p.tableId);
    if (t === undefined || table === undefined) throw new DomainFailure("INVALID_REQUEST", "a projection names an included table", { reason: "PROJECTION_INVALID" });
    const selected = t.selectedColumns === undefined ? null : new Set(t.selectedColumns);
    const inScope = (c: number): boolean => c < table.columnCount && (selected === null || selected.has(c));
    if (!p.fieldOrdinals.every(inScope) || !(p.keyOrdinals ?? []).every(inScope)) {
      throw new DomainFailure("INVALID_REQUEST", "a projection names selected columns of its table", { reason: "PROJECTION_INVALID" });
    }
  }
  if (includedFiles > INPUT_ENVELOPE.files || includedBytes > INPUT_ENVELOPE.revisionBytes) {
    throw new DomainFailure("PRECONDITION_FAILED", "the selected files exceed the revision envelope", { reason: "SELECTION_BYTES_LIMIT" });
  }
  return { includedFileCount: includedFiles, includedTableCount: includedTables, reusedFileIds: reused };
}
