/**
 * The counting pass as it crosses into the isolated child (JSON): per included file its attempt input and per included table the
 * parser choice, the selected columns, the projections and associations of that table; and back, per table the exact counts.
 * Types only.
 */
import type { ParserChoice } from "@kauro/domain";

export interface ProjectionPlan {
  readonly projectionKey: string;
  readonly kind: "ROW" | "REFERENCED_ENTITY";
  readonly fieldOrdinals: ReadonlyArray<number>;
  readonly keyOrdinals: ReadonlyArray<number>;
}

export interface AssociationPlan {
  readonly associationKey: string;
  readonly fromProjectionKey: string;
  readonly toProjectionKey: string;
}

export interface TablePlan {
  readonly tableId: string;
  readonly ordinal: number;
  readonly kind: "CSV_TABLE" | "WORKSHEET";
  readonly parser: ParserChoice;
  readonly selectedColumns?: ReadonlyArray<number>;
  readonly projections: ReadonlyArray<ProjectionPlan>;
  readonly associations: ReadonlyArray<AssociationPlan>;
}

export interface FilePlan {
  readonly fileId: string;
  readonly format: "CSV" | "XLSX";
  readonly path: string;
  readonly tables: ReadonlyArray<TablePlan>;
}

export interface EvaluatePayload {
  readonly files: ReadonlyArray<FilePlan>;
  readonly limits: {
    readonly decodedCellBytes: number;
    readonly decodedRecordBytes: number;
    readonly maxArchiveEntries: number;
    readonly xlsxExpandedPartBytes: number;
    readonly xlsxExpandedTotalBytes: number;
    readonly maxCompressionRatio: number;
    readonly ratioGraceBytes: number;
    readonly centralDirectoryBytes: number;
    readonly maxXmlDepth: number;
  };
  /** Distinct keys a projection holds in memory before it spills to the attempt scratch. */
  readonly distinctKeysInMemory: number;
}

export interface TableCount {
  readonly tableId: string;
  readonly physicalRows: number;
  readonly columnCount: number;
  readonly excludedHiddenRows: number;
  readonly issues: ReadonlyArray<string>;
  /** Admission-contract violations of this table (fatal_input_rejection; no silent removal). */
  readonly failures: ReadonlyArray<string>;
  readonly projections: ReadonlyArray<{ readonly projectionKey: string; readonly logicalRecords: number; readonly spilledKeys: number }>;
  readonly associations: ReadonlyArray<{ readonly associationKey: string; readonly edges: number }>;
}

export interface EvaluateResult {
  readonly tables: ReadonlyArray<TableCount>;
  readonly decompressedBytes: number;
}
