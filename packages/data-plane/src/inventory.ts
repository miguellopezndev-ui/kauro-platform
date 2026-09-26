/**
 * The stored form of a detected table (tables kauro.source_tables and kauro.source_table_columns; decision D-HASH-2): the digests
 * a selection binds are computed from the inspection's DetectedTable in one place, so the control plane that stores the inventory
 * and every later reader agree. Customer text (a worksheet name, a header label) enters only as a digest; the display value is kept
 * only when it is a safe label (it always is: the inspector hands out display forms only).
 */
import type { DetectedTable } from "@kauro/application";
import { tableStructureHashOf, textDigest, type SourceColumnRecord } from "@kauro/domain";
import type { Sha256Hex } from "@kauro/contracts";

export interface StoredTableFacts {
  readonly nameDigest: Sha256Hex;
  readonly structureHash: Sha256Hex;
  readonly columns: ReadonlyArray<Omit<SourceColumnRecord, "tableId">>;
}

/** Name and label digests (over the display text, "" when absent) and the KAURO_SOURCE_TABLE_V1 structure hash of one table. */
export function storedTableFacts(fileId: string, table: DetectedTable): StoredTableFacts {
  const nameDigest = textDigest(table.name ?? "");
  const columns = table.columns.map((c) => ({
    ordinal: c.ordinal,
    ...(c.label === undefined ? {} : { labelDisplay: c.label }),
    labelDigest: textDigest(c.label ?? ""),
    labelState: c.labelState,
  }));
  const structureHash = tableStructureHashOf({
    fileId,
    ordinal: table.ordinal,
    kind: table.kind,
    nameDigest,
    visibility: table.visibility,
    columnCount: table.columnCount,
    columnLabelDigests: columns.map((c) => c.labelDigest),
    hasFormulas: table.hasFormulas,
    formulaCache: table.formulaCache,
    mergedCellCount: table.mergedCellCount,
    hiddenRowCount: table.hiddenRowCount,
    hiddenColumnCount: table.hiddenColumnCount,
    issues: table.issues,
  });
  return { nameDigest, structureHash, columns };
}
