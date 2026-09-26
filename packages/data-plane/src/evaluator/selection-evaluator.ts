/**
 * The platform's SelectionEvaluatorPort (design §12.2 SELECTION_EVALUATION; 03 "Count the correct population"; 04 "Facts used as
 * proof must be exact"). Not a provider: always real, in tests too.
 *
 * One call owns one directory under the scratch root it was constructed with (09 "Derived data and worker scratch") and removes
 * exactly that directory when it returns:
 *
 * 1. the manifest is checked against the files and tables it is given (defence in depth behind CMD016 and the database): every
 *    included table belongs to an included, admitted file and has a parser choice of its kind; a hidden or very hidden worksheet is
 *    included only with its acknowledgement; projections and associations name included tables, selected columns inside the
 *    table, a confirmed key for a referenced entity, a ROW source and a REFERENCED_ENTITY target of the same table; the envelope
 *    (files, revision bytes, selected columns) holds. A violation is ADMISSION_FAILED (fatal_input_rejection: no silent removal);
 * 2. every included file's accepted generation is streamed into the attempt input and its SHA-256 and length compared with the
 *    admitted file's (a difference is ERROR ACCEPTED_GENERATION_MISMATCH: the bytes are not the admitted ones, retry or dead letter);
 * 3. the counting task runs in an isolated child (decision D-ISO-1) that may read those inputs and write only the attempt scratch,
 *    where distinct keys and shared strings spill (bounded memory);
 * 4. the counts are assembled: billable units under the pricing definition (R2-INITIAL: every declared object projection is
 *    priced, so billable = logical; an unknown definition is ERROR), the populations, the association ceiling (ADMISSION_FAILED
 *    ASSOCIATION_LIMIT beyond it).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InspectionIsolation, SelectionEvaluationInput, SelectionEvaluationOutcome, SelectionEvaluatorPort } from "@kauro/application";
import { PRICING_DEFINITION, type EvaluatedFile, type EvaluatedProjection, type EvaluatedTable, type EvaluationFailure, type SourceTableId } from "@kauro/domain";
import { ARCHIVE_BOUNDS, EVALUATOR_VERSION } from "../limits.js";
import { runIsolated } from "../sandbox/runner.js";
import { streamToFile } from "../inspector/container-inspector.js";
import type { EvaluatePayload, EvaluateResult, FilePlan, TablePlan } from "./plan.js";

const EVALUATE_TASK = join(dirname(fileURLToPath(import.meta.url)), "evaluate-task.js");

/** Pricing definitions this evaluator knows: which declared object projections are priced (03 billableSourceUnits). */
export function billableUnder(pricingDefinition: string): ((objectKind: string) => boolean) | undefined {
  if (pricingDefinition === PRICING_DEFINITION) return () => true;
  return undefined;
}

export interface SelectionEvaluatorOptions {
  /** The directory under which each evaluation creates, and removes, its own attempt scratch. */
  readonly scratchRoot: string;
  /** Distinct keys a projection keeps in memory before spilling to the scratch (default 200,000). */
  readonly distinctKeysInMemory?: number;
  readonly heapMegabytes?: number;
}

export interface EvaluationEvidence {
  readonly outcome: SelectionEvaluationOutcome;
  /** The isolation of the counting child (absent when nothing was parsed: a manifest or digest failure). */
  readonly isolation?: InspectionIsolation;
  /** Distinct keys that went to the attempt scratch, per projection key. */
  readonly spilledKeys: ReadonlyMap<string, number>;
}

function failure(code: string, tableId?: SourceTableId): EvaluationFailure {
  return tableId === undefined ? { code } : { code, tableId };
}

export class IsolatedSelectionEvaluator implements SelectionEvaluatorPort {
  readonly version = EVALUATOR_VERSION;

  constructor(private readonly options: SelectionEvaluatorOptions) {}

  async evaluate(input: SelectionEvaluationInput): Promise<SelectionEvaluationOutcome> {
    return (await this.evaluateWithEvidence(input)).outcome;
  }

  async evaluateWithEvidence(input: SelectionEvaluationInput): Promise<EvaluationEvidence> {
    const noSpill = new Map<string, number>();
    const pricing = billableUnder(input.pricingDefinition);
    if (pricing === undefined) return { outcome: { result: "ERROR", failures: [failure("PRICING_DEFINITION_UNKNOWN")] }, spilledKeys: noSpill };
    const checked = checkManifest(input);
    if (checked.failures.length > 0) return { outcome: { result: "ADMISSION_FAILED", files: [], tables: [], failures: checked.failures }, spilledKeys: noSpill };
    const attempt = mkdtempSync(join(realpathSync.native(this.options.scratchRoot), "evaluation-"));
    try {
      const inputDir = join(attempt, "input");
      const workDir = join(attempt, "work");
      mkdirSync(inputDir);
      mkdirSync(workDir);
      const evaluatedFiles: EvaluatedFile[] = [];
      const plans: FilePlan[] = [];
      for (const f of checked.files) {
        const path = join(inputDir, f.entry.file.fileId);
        const streamed = await streamToFile(f.entry.open, path, input.limits.fileBytes);
        if (!streamed.complete || streamed.sha256 !== f.entry.file.sha256 || streamed.bytes !== f.entry.file.bytes) {
          return { outcome: { result: "ERROR", failures: [failure("ACCEPTED_GENERATION_MISMATCH")] }, spilledKeys: noSpill };
        }
        evaluatedFiles.push({ fileId: f.entry.file.fileId, generation: f.entry.file.providerGeneration, sha256: streamed.sha256, bytes: streamed.bytes });
        plans.push({ fileId: f.entry.file.fileId, format: f.entry.file.format, path, tables: f.tables });
      }
      const payload: EvaluatePayload = {
        files: plans,
        limits: {
          decodedCellBytes: input.limits.decodedCellBytes,
          decodedRecordBytes: input.limits.decodedRecordBytes,
          maxArchiveEntries: input.limits.maxArchiveEntries,
          xlsxExpandedPartBytes: input.limits.xlsxExpandedPartBytes,
          xlsxExpandedTotalBytes: input.limits.xlsxExpandedTotalBytes,
          maxCompressionRatio: input.limits.maxCompressionRatio,
          ratioGraceBytes: ARCHIVE_BOUNDS.ratioGraceBytes,
          centralDirectoryBytes: ARCHIVE_BOUNDS.centralDirectoryBytes,
          maxXmlDepth: input.limits.maxXmlDepth,
        },
        distinctKeysInMemory: this.options.distinctKeysInMemory ?? 200_000,
      };
      const run = await runIsolated<EvaluateResult>({
        task: EVALUATE_TASK,
        payload,
        readPaths: [inputDir],
        workDir,
        timeoutMs: input.limits.wallClockMs,
        heapMegabytes: this.options.heapMegabytes ?? ARCHIVE_BOUNDS.childHeapMegabytes,
      });
      if (run.timedOut || run.memoryExhausted || run.outcome === undefined || !run.outcome.ok) {
        const code = run.timedOut ? "EVALUATION_WALL_CLOCK_LIMIT" : run.memoryExhausted ? "EVALUATION_MEMORY_LIMIT" : "EVALUATOR_FAILED";
        return { outcome: { result: "ERROR", failures: [failure(code)] }, spilledKeys: noSpill };
      }
      const counted = run.outcome.value;
      const isolation: InspectionIsolation = {
        mechanism: "NODE_PERMISSION_CHILD",
        outsideWriteAttempts: run.observers.outsideWriteAttempts,
        networkAttempts: run.observers.networkAttempts,
        processAttempts: run.observers.processAttempts,
        decompressedBytes: counted.decompressedBytes,
      };
      const spilledKeys = new Map<string, number>();
      const tables: EvaluatedTable[] = [];
      const failures: EvaluationFailure[] = [];
      const projections: EvaluatedProjection[] = [];
      const associations: Array<{ readonly associationKey: string; readonly edges: number }> = [];
      const kindOf = new Map(input.selection.projections.map((p) => [p.projectionKey, p.objectKind]));
      for (const t of counted.tables) {
        const tableId = t.tableId as SourceTableId;
        tables.push({ tableId, physicalRows: t.physicalRows, columnCount: t.columnCount, excludedHiddenRows: t.excludedHiddenRows, issues: t.issues });
        for (const code of t.failures) failures.push(failure(code, tableId));
        for (const p of t.projections) {
          const objectKind = kindOf.get(p.projectionKey) ?? "";
          projections.push({ projectionKey: p.projectionKey, objectKind, logicalRecords: p.logicalRecords, billable: pricing(objectKind) });
          spilledKeys.set(p.projectionKey, p.spilledKeys);
        }
        for (const a of t.associations) associations.push(a);
      }
      if (isolation.outsideWriteAttempts + isolation.networkAttempts + isolation.processAttempts > 0) failures.push(failure("ISOLATION_VIOLATION_OBSERVED"));
      const edges = associations.reduce((n, a) => n + a.edges, 0);
      if (edges > input.limits.associationCandidates) failures.push(failure("ASSOCIATION_LIMIT"));
      if (failures.length > 0) return { outcome: { result: "ADMISSION_FAILED", files: evaluatedFiles, tables, failures }, isolation, spilledKeys };
      const logical = projections.reduce((n, p) => n + p.logicalRecords, 0);
      const billable = projections.filter((p) => p.billable).reduce((n, p) => n + p.logicalRecords, 0);
      return {
        outcome: {
          result: "COMPLETE",
          populations: { physicalSourceRows: tables.reduce((n, t) => n + t.physicalRows, 0), logicalSourceRecords: logical, billableSourceUnits: billable, associationEdges: edges },
          files: evaluatedFiles,
          tables,
          projections,
          associations,
        },
        isolation,
        spilledKeys,
      };
    } finally {
      rmSync(attempt, { recursive: true, force: true });
    }
  }
}

interface CheckedFile {
  readonly entry: SelectionEvaluationInput["files"][number];
  readonly tables: TablePlan[];
}

/** The manifest against the files and tables it is evaluated over (see the module comment, step 1). */
export function checkManifest(input: SelectionEvaluationInput): { readonly files: ReadonlyArray<CheckedFile>; readonly failures: ReadonlyArray<EvaluationFailure> } {
  const selection = input.selection;
  const failures: EvaluationFailure[] = [];
  const byFileId = new Map(input.files.map((f) => [f.file.fileId as string, f]));
  const includedFiles = selection.files.filter((f) => f.disposition === "INCLUDE");
  if (includedFiles.length === 0) failures.push(failure("NO_INCLUDED_FILE"));
  if (includedFiles.length > input.limits.files) failures.push(failure("SELECTION_FILE_LIMIT"));
  let bytes = 0;
  const files: CheckedFile[] = [];
  const included = new Map<string, CheckedFile>();
  for (const f of includedFiles) {
    const entry = byFileId.get(f.fileId);
    if (entry === undefined) {
      failures.push(failure("SELECTION_FILE_UNKNOWN"));
      continue;
    }
    if (entry.file.state !== "ADMITTED" || !entry.file.admitted) failures.push(failure("INPUT_NOT_ADMITTED"));
    bytes += entry.file.bytes;
    const checked: CheckedFile = { entry, tables: [] };
    files.push(checked);
    included.set(f.fileId, checked);
  }
  if (bytes > input.limits.revisionBytes) failures.push(failure("SELECTION_BYTES_LIMIT"));
  const tableFacts = new Map<string, { readonly fileId: string; readonly record: SelectionEvaluationInput["files"][number]["tables"][number] }>();
  for (const f of input.files) for (const t of f.tables) tableFacts.set(t.tableId, { fileId: f.file.fileId, record: t });
  const plans = new Map<string, TablePlan & { selectedColumns?: ReadonlyArray<number> }>();
  const columnsOf = new Map<string, { readonly count: number; readonly selected?: ReadonlySet<number> }>();
  for (const t of selection.tables) {
    if (t.disposition !== "INCLUDE") continue;
    const tableId = t.tableId as SourceTableId;
    const facts = tableFacts.get(t.tableId);
    const file = included.get(t.fileId);
    if (facts === undefined || file === undefined || facts.fileId !== t.fileId) {
      failures.push(failure("SELECTION_UNKNOWN_TABLE", tableId));
      continue;
    }
    const record = facts.record;
    if (t.parser === undefined || (t.parser.kind === "CSV") !== (record.kind === "CSV_TABLE")) {
      failures.push(failure("PARSER_KIND_MISMATCH", tableId));
      continue;
    }
    if (record.visibility !== "VISIBLE" && t.hiddenSheetAcknowledged !== true) failures.push(failure("HIDDEN_SHEET_NOT_ACKNOWLEDGED", tableId));
    if (t.selectedColumns !== undefined) {
      if (t.selectedColumns.length > input.limits.columns) failures.push(failure("SELECTED_COLUMNS_LIMIT", tableId));
      if (t.selectedColumns.some((c) => !Number.isInteger(c) || c < 0 || c >= record.columnCount)) failures.push(failure("COLUMN_OUT_OF_RANGE", tableId));
    } else if (record.columnCount > input.limits.columns) failures.push(failure("SELECTED_COLUMNS_LIMIT", tableId));
    const plan: TablePlan = {
      tableId: t.tableId,
      ordinal: record.ordinal,
      kind: record.kind,
      parser: t.parser,
      ...(t.selectedColumns === undefined ? {} : { selectedColumns: [...t.selectedColumns] }),
      projections: [],
      associations: [],
    };
    plans.set(t.tableId, plan);
    columnsOf.set(t.tableId, t.selectedColumns === undefined ? { count: record.columnCount } : { count: record.columnCount, selected: new Set(t.selectedColumns) });
    file.tables.push(plan);
  }
  const projectionKinds = new Map<string, { readonly tableId: string; readonly kind: "ROW" | "REFERENCED_ENTITY" }>();
  for (const p of selection.projections) {
    const plan = plans.get(p.tableId);
    const columns = columnsOf.get(p.tableId);
    const tableId = p.tableId as SourceTableId;
    if (plan === undefined || columns === undefined) {
      failures.push(failure("PROJECTION_TABLE_NOT_INCLUDED", tableId));
      continue;
    }
    const keys = p.keyOrdinals ?? [];
    const ordinals = [...p.fieldOrdinals, ...keys];
    if (ordinals.some((o) => !Number.isInteger(o) || o < 0 || o >= columns.count || (columns.selected !== undefined && !columns.selected.has(o)))) failures.push(failure("PROJECTION_COLUMN_NOT_SELECTED", tableId));
    if (p.kind === "REFERENCED_ENTITY" && (keys.length === 0 || p.keyConfirmed !== true)) failures.push(failure("KEY_NOT_CONFIRMED", tableId));
    if (projectionKinds.has(p.projectionKey)) failures.push(failure("PROJECTION_KEY_DUPLICATE", tableId));
    projectionKinds.set(p.projectionKey, { tableId: p.tableId, kind: p.kind });
    (plan.projections as Array<TablePlan["projections"][number]>).push({ projectionKey: p.projectionKey, kind: p.kind, fieldOrdinals: [...p.fieldOrdinals], keyOrdinals: [...keys] });
  }
  for (const a of selection.associations) {
    const from = projectionKinds.get(a.fromProjectionKey);
    const to = projectionKinds.get(a.toProjectionKey);
    const plan = plans.get(a.tableId);
    if (plan === undefined || from === undefined || to === undefined || from.tableId !== a.tableId || to.tableId !== a.tableId || from.kind !== "ROW" || to.kind !== "REFERENCED_ENTITY") {
      failures.push(failure("ASSOCIATION_INVALID", a.tableId as SourceTableId));
      continue;
    }
    (plan.associations as Array<TablePlan["associations"][number]>).push({ associationKey: a.associationKey, fromProjectionKey: a.fromProjectionKey, toProjectionKey: a.toProjectionKey });
  }
  return { files, failures };
}
