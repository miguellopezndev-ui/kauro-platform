/**
 * The selection manifest document (CMD016 selectionManifestRef; decision D-SEL-1) — what the agency confirms before sealing:
 * every candidate file and every table of every included file with an explicit disposition, the parser choices of each included
 * table and the object projection that turns physical rows into billable object occurrences (09 "Accepted immutability and
 * sealing": the agency selects tables and confirms parsing and projection; 03 "Count the correct population": the approved
 * intake interpretation declares which column groups represent object occurrences, and a referenced-entity projection needs a
 * source key the agency confirms; 04 "XLSX parser requirements": formula policy, hidden rows/columns under the sealed selection
 * policy, merged cells as observed; UI15 "excluded content requires a visible reason").
 *
 * The document carries ids, positions, digests and tokens only — never a display name, a worksheet name or a header label — so it
 * can be stored, hashed (KAURO_SOURCE_SELECTION_V1) and sealed without customer text. Projection identities are minted at seal;
 * in a draft a projection is named by its `projectionKey`.
 */
import type { Sha256Hex } from "@kauro/contracts";
import type { RevisionId } from "../ids.js";
import type { SourceFileId, SourceTableId } from "./ids.js";

export const SELECTION_MANIFEST_SCHEMA_VERSION = 1;

/** Machine token of an exclusion reason or an object kind (same shape as a reason code). */
export type SelectionToken = string;

export type Disposition = "INCLUDE" | "EXCLUDE";

/** CSV parser choices (04 "CSV parser requirements": dialect, quote, header policy and tolerated variations are part of the profile). */
export interface CsvParserChoice {
  readonly kind: "CSV";
  readonly encoding: "UTF_8" | "UTF_16LE" | "UTF_16BE" | "WINDOWS_1252" | "LATIN_1";
  readonly delimiter: "COMMA" | "SEMICOLON" | "TAB" | "PIPE";
  readonly quote: "DOUBLE_QUOTE" | "NONE";
  /** Headerless input requires an explicit generated-field profile; the first record is never consumed as a header by default. */
  readonly header: { readonly mode: "FIRST_RECORD" } | { readonly mode: "NONE" };
  /** Blank lines are an explicit choice when the inspection found them (issue BLANK_LINES_PRESENT). */
  readonly blankLines: "COUNT_AS_RECORDS" | "SKIP";
}

/** Worksheet parser choices (04 "XLSX parser requirements"). */
export interface WorksheetParserChoice {
  readonly kind: "WORKSHEET";
  /** Zero-based header row within the used range, or NONE for a generated-field profile. */
  readonly header: { readonly mode: "ROW"; readonly rowIndex: number } | { readonly mode: "NONE" };
  /** Required whenever the table has formulas; NOT_PRESENT is valid only for a formula-free table. */
  readonly formulas: "NOT_PRESENT" | "REJECT_FORMULAS" | "USE_PRESENT_CACHED_VALUES_WITH_DISCLOSURE";
  readonly hiddenRows: "INCLUDE" | "EXCLUDE";
  readonly hiddenColumns: "INCLUDE" | "EXCLUDE";
  /** Merged cells are represented as observed; filling covered cells is a transformation, never a parsing default. */
  readonly mergedCells: "AS_OBSERVED";
}

export type ParserChoice = CsvParserChoice | WorksheetParserChoice;

export interface SelectionFileEntry {
  readonly fileId: SourceFileId;
  /** THIS_REVISION: admitted from an upload of this revision; REUSED: a previously admitted file of the same project. */
  readonly origin: "THIS_REVISION" | "REUSED";
  readonly disposition: Disposition;
  /** Required for EXCLUDE (a visible reason), absent for INCLUDE. */
  readonly exclusionReason?: SelectionToken;
}

export interface SelectionTableEntry {
  readonly tableId: SourceTableId;
  readonly fileId: SourceFileId;
  /** The table facts the agency reviewed (source_tables.structure_hash): a changed table invalidates the selection. */
  readonly structureHash: Sha256Hex;
  readonly disposition: Disposition;
  readonly exclusionReason?: SelectionToken;
  /** Required and true when a HIDDEN or VERY_HIDDEN worksheet is included: no hidden-sheet silent inclusion. */
  readonly hiddenSheetAcknowledged?: true;
  /** Required for INCLUDE. */
  readonly parser?: ParserChoice;
  /** Zero-based column ordinals the table contributes (at most 800 selected columns); absent means every column. */
  readonly selectedColumns?: ReadonlyArray<number>;
}

/**
 * One object projection of one included table (03). ROW: every parsed data record is one occurrence of `objectKind`.
 * REFERENCED_ENTITY: distinct confirmed key values are the occurrences (a company repeated on every contact row counts once per
 * confirmed source key; a label alone never establishes identity).
 */
export interface ProjectionDeclaration {
  /** Unique within the manifest; the seal mints the ProjectionId the locators will use. */
  readonly projectionKey: SelectionToken;
  readonly tableId: SourceTableId;
  readonly objectKind: SelectionToken;
  readonly kind: "ROW" | "REFERENCED_ENTITY";
  /** Positional column group of the object (ordinals of selected columns). */
  readonly fieldOrdinals: ReadonlyArray<number>;
  /** REFERENCED_ENTITY only: the source key columns. */
  readonly keyOrdinals?: ReadonlyArray<number>;
  /** REFERENCED_ENTITY only: the agency confirms the key identifies the same source object. */
  readonly keyConfirmed?: true;
}

/** A relationship candidate between two projections of the same table (counted as association edges, never as billable units). */
export interface AssociationDeclaration {
  readonly associationKey: SelectionToken;
  readonly tableId: SourceTableId;
  /** A ROW projection of the table. */
  readonly fromProjectionKey: SelectionToken;
  /** A REFERENCED_ENTITY projection of the table. */
  readonly toProjectionKey: SelectionToken;
  readonly relationType: SelectionToken;
}

export interface SelectionManifestDocument {
  readonly schemaVersion: typeof SELECTION_MANIFEST_SCHEMA_VERSION;
  readonly revisionId: RevisionId;
  /** KAURO_SOURCE_INVENTORY_V1 digest of the revision's own uploads, files and tables the agency reviewed (GET inspection). */
  readonly inventoryHash: Sha256Hex;
  readonly files: ReadonlyArray<SelectionFileEntry>;
  readonly tables: ReadonlyArray<SelectionTableEntry>;
  readonly projections: ReadonlyArray<ProjectionDeclaration>;
  readonly associations: ReadonlyArray<AssociationDeclaration>;
}

/** Tokens: exclusion reasons, object kinds, relation types, projection and association keys. */
export const SELECTION_TOKEN = /^[A-Z][A-Z0-9_]{0,63}$/;
