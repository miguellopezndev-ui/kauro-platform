/**
 * Digests of the source lifecycle (reference/HASHING_AND_ACCOUNTING_RULES "Hash domain separation": every structured digest uses a
 * named domain and version; the preimage is the UTF-8 bytes of the closed wrapper {domain, version, payload} under the canonical
 * JSON profile; a raw file hash is over the file bytes and is never interchangeable with a structured digest).
 *
 * The authority names one domain the source lifecycle produces — the revision manifest (KAURO_SOURCE_REVISION_V1, amendment A2
 * of KAVO_SOURCE_REVISION_V1) — and computes it with @kauro/contracts' closed DOMAINS table. The other digests B07 needs have no
 * authority domain; they are platform domains in the same wrapper shape (decisions D-HASH-2 and D-HASH-3, like B06's
 * KAURO_COMMAND_REQUEST_V1), each with its own name so no digest can be read as another authority class.
 */
import type { Sha256Hex } from "@kauro/contracts";
import { DOMAINS, canonicalBytes, rawDigest, structuredDigest } from "@kauro/contracts";
import type { SealedManifestDocument } from "./records.js";
import type { SelectionManifestDocument } from "./selection.js";

export const SOURCE_DIGEST_DOMAINS = Object.freeze({
  /** A selection manifest body (CMD016/CMD017 selectionHash). */
  SELECTION: "KAURO_SOURCE_SELECTION_V1",
  /** The sealed object projection (DatasetRevision.projectionHash: "Exact billable object interpretation"). */
  PROJECTION: "KAURO_SOURCE_PROJECTION_V1",
  /** The inventory of a revision's own uploads, files and detected tables (the facts a selection was made against). */
  INVENTORY: "KAURO_SOURCE_INVENTORY_V1",
  /** The detected facts of one table (source_tables.structure_hash). */
  TABLE: "KAURO_SOURCE_TABLE_V1",
  /** The pinned parser/inspector configuration of an inspection (FileManifest.parserProfileHash). */
  PARSER_PROFILE: "KAURO_PARSER_PROFILE_V1",
  /** One inspection receipt (UploadSession.inspectionReceiptHash). */
  INSPECTION_RECEIPT: "KAURO_INSPECTION_RECEIPT_V1",
  /** One selection evaluation (the counting pass). */
  EVALUATION: "KAURO_SELECTION_EVALUATION_V1",
  /** One retention anchor fact (RetentionRecord.anchorEvidenceHash). */
  RETENTION_ANCHOR: "KAURO_RETENTION_ANCHOR_V1",
  /** One external authority tombstone (upload acceptance, revision, deletion). */
  AUTHORITY_TOMBSTONE: "KAURO_AUTHORITY_TOMBSTONE_V1",
} as const);

export type SourceDigestDomain = (typeof SOURCE_DIGEST_DOMAINS)[keyof typeof SOURCE_DIGEST_DOMAINS];

/** SHA-256 of the canonical {domain, version: 1, payload} wrapper of a platform domain. */
export function sourceDigest(domain: SourceDigestDomain, payload: unknown): Sha256Hex {
  return rawDigest(canonicalBytes({ domain, version: 1, payload }));
}

/** selectionHash: the digest of the selection manifest body exactly as stored. */
export function selectionHashOf(body: SelectionManifestDocument): Sha256Hex {
  return sourceDigest(SOURCE_DIGEST_DOMAINS.SELECTION, body);
}

/** manifestHash of a sealed revision (authority domain KAURO_SOURCE_REVISION_V1). */
export function sourceRevisionManifestHashOf(manifest: SealedManifestDocument): Sha256Hex {
  return structuredDigest(DOMAINS.SOURCE_REVISION, 1, manifest);
}

/** projectionHash: the sealed projections and associations under the pricing definition that decides billable units. */
export function projectionHashOf(projection: {
  readonly projections: SealedManifestDocument["projections"];
  readonly associations: SealedManifestDocument["associations"];
  readonly pricingDefinition: string;
}): Sha256Hex {
  return sourceDigest(SOURCE_DIGEST_DOMAINS.PROJECTION, projection);
}

/** The inventory a selection is made against: the revision's own uploads (with their outcome) and the detected tables of its files. */
export interface RevisionInventory {
  readonly revisionId: string;
  /** Ordered by uploadId. */
  readonly uploads: ReadonlyArray<{ readonly uploadId: string; readonly state: string; readonly fileId: string | null; readonly inspectionReceiptHash: string | null }>;
  /** Ordered by fileId; tables ordered by ordinal. */
  readonly files: ReadonlyArray<{
    readonly fileId: string;
    readonly generation: string;
    readonly sha256: Sha256Hex;
    readonly bytes: number;
    readonly tables: ReadonlyArray<{ readonly tableId: string; readonly ordinal: number; readonly structureHash: Sha256Hex }>;
  }>;
}

export function inventoryHashOf(inventory: RevisionInventory): Sha256Hex {
  return sourceDigest(SOURCE_DIGEST_DOMAINS.INVENTORY, inventory);
}

/** The detected facts of one table; customer text enters only as digests (name and header labels). */
export interface TableStructureFacts {
  readonly fileId: string;
  readonly ordinal: number;
  readonly kind: "CSV_TABLE" | "WORKSHEET";
  readonly nameDigest: Sha256Hex;
  readonly visibility: string;
  readonly columnCount: number;
  readonly columnLabelDigests: ReadonlyArray<Sha256Hex>;
  readonly hasFormulas: boolean;
  readonly formulaCache: string;
  readonly mergedCellCount: number;
  readonly hiddenRowCount: number;
  readonly hiddenColumnCount: number;
  readonly issues: ReadonlyArray<string>;
}

export function tableStructureHashOf(facts: TableStructureFacts): Sha256Hex {
  return sourceDigest(SOURCE_DIGEST_DOMAINS.TABLE, facts);
}

/** The pinned inspection configuration: implementation versions, limits and the detected container facts it decided on. */
export function parserProfileHashOf(profile: Readonly<Record<string, unknown>>): Sha256Hex {
  return sourceDigest(SOURCE_DIGEST_DOMAINS.PARSER_PROFILE, profile);
}

/** The receipt payload is the receipt record without its own hash, id and storage times (canonical members only). */
export function inspectionReceiptHashOf(payload: Readonly<Record<string, unknown>>): Sha256Hex {
  return sourceDigest(SOURCE_DIGEST_DOMAINS.INSPECTION_RECEIPT, payload);
}

export function evaluationHashOf(payload: Readonly<Record<string, unknown>>): Sha256Hex {
  return sourceDigest(SOURCE_DIGEST_DOMAINS.EVALUATION, payload);
}

export function retentionAnchorHashOf(anchor: {
  readonly kind: string;
  readonly agencyId: string;
  readonly projectId: string;
  readonly revisionId: string;
  readonly uploadId: string | null;
  readonly occurredAt: string;
  readonly sourceEvidenceHash: Sha256Hex | null;
}): Sha256Hex {
  return sourceDigest(SOURCE_DIGEST_DOMAINS.RETENTION_ANCHOR, anchor);
}

export function authorityTombstoneHashOf(tombstone: Readonly<Record<string, unknown>>): Sha256Hex {
  return sourceDigest(SOURCE_DIGEST_DOMAINS.AUTHORITY_TOMBSTONE, tombstone);
}

/** Digest of a raw text value that must never be stored (a completion reference, a provider session reference, a label). */
export function textDigest(value: string): Sha256Hex {
  return rawDigest(new TextEncoder().encode(value));
}
