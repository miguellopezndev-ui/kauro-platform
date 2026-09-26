// Admitted files for the counting pass: each file of the corpus is inspected by the real container inspector (as UPLOAD_INSPECTION
// does), and its admitted record and table inventory are the stored forms the control plane would write (storedTableFacts, the
// parser profile hash). Nothing here decides a count: the tests compute their expected counts from the data they wrote.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { DetectedTable } from "@kauro/application";
import type { SelectionEvaluationInput } from "@kauro/application";
import type { SourceFileRecord, SourceTableRecord } from "@kauro/domain";
import { IsolatedContainerInspector, inspectionLimits, parserProfileHashOfInspection, storedTableFacts } from "../../src/index.js";
import { source } from "./harness.js";

export type EvaluationFile = SelectionEvaluationInput["files"][number];

export interface Admitted {
  readonly entry: EvaluationFile;
  readonly bytes: Buffer;
  /** Tables by ordinal. */
  readonly tables: ReadonlyArray<SourceTableRecord>;
  readonly detected: ReadonlyArray<DetectedTable>;
}

const AGENCY = randomUUID();
const PROJECT = randomUUID();
const REVISION = randomUUID();
const inspector = new IsolatedContainerInspector();

export const SCOPE = Object.freeze({ agencyId: AGENCY, projectId: PROJECT, revisionId: REVISION });

/** Inspects `bytes` in `scratch` and returns the admitted file with its inventory; `open` may be replaced (a file never read). */
export async function admit(bytes: Buffer, format: "CSV" | "XLSX", scratch: string, open?: () => AsyncIterable<Uint8Array>): Promise<Admitted> {
  const inspection = await inspector.inspect({ open: source(bytes), declaredFormat: format, observedBytes: bytes.length, limits: inspectionLimits(), scratchDir: scratch });
  assert.equal(inspection.refusal, undefined, JSON.stringify(inspection.problems));
  assert.equal(inspection.detectedFormat, format);
  const fileId = randomUUID();
  const file = {
    fileId,
    storageRef: randomUUID(),
    agencyId: AGENCY,
    projectId: PROJECT,
    originRevisionId: REVISION,
    originUploadId: randomUUID(),
    inspectionReceiptHash: createHash("sha256").update(`receipt-${fileId}`).digest("hex"),
    version: 1,
    state: "ADMITTED",
    admittedAt: new Date().toISOString(),
    providerGeneration: String(1_000 + bytes.length),
    sha256: inspection.sha256,
    bytes: inspection.bytes,
    format,
    scanState: "COVERED_CLEAN",
    parserProfileHash: parserProfileHashOfInspection(inspection),
    admitted: true,
  } as unknown as SourceFileRecord;
  const tables = inspection.tables.map((t) => {
    const facts = storedTableFacts(fileId, t);
    return {
      tableId: randomUUID(),
      agencyId: AGENCY,
      fileId,
      ordinal: t.ordinal,
      kind: t.kind,
      ...(t.name === undefined ? {} : { nameDisplay: t.name }),
      nameDigest: facts.nameDigest,
      visibility: t.visibility,
      columnCount: t.columnCount,
      ...(t.rowEstimate === undefined ? {} : { rowEstimate: t.rowEstimate }),
      hasFormulas: t.hasFormulas,
      formulaCache: t.formulaCache,
      mergedCellCount: t.mergedCellCount,
      hiddenRowCount: t.hiddenRowCount,
      hiddenColumnCount: t.hiddenColumnCount,
      issues: t.issues,
      structureHash: facts.structureHash,
    } as unknown as SourceTableRecord;
  });
  return { entry: { file, tables, open: open ?? source(bytes) }, bytes, tables, detected: inspection.tables };
}

/** CSV text of `records` (RFC 4180 quoting where a field needs it), with `newline` after every record. */
export function csvText(records: ReadonlyArray<ReadonlyArray<string>>, delimiter = ",", newline = "\n"): string {
  const field = (v: string): string => (v.includes(delimiter) || v.includes('"') || v.includes("\n") || v.includes("\r") ? `"${v.replace(/"/g, '""')}"` : v);
  return records.map((r) => r.map(field).join(delimiter) + newline).join("");
}
