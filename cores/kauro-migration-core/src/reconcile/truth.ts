import type { CanonicalObject } from '../domain/canonical.js';
import type { EdgeDisposition, RowDisposition } from '../domain/disposition.js';
import type { RelationshipType } from '../domain/associations.js';
import type { ReasonCode } from '../domain/reason-codes.js';
import type { IdentityEvidence } from '../domain/identity.js';
import type { TransformResult } from '../domain/transform.js';
import type { SpooledFamily } from '../run/spool.js';

/**
 * The single machine truth for a run.
 *
 * Every artifact in the package is rendered from this object, and the
 * reconciliation is computed from it exactly once. Nothing recomputes a count
 * for itself, which is what makes cross-artifact agreement structural rather
 * than something a reviewer has to spot-check.
 */

/** Flattened locator columns, repeated on every row-addressed artifact. */
export interface RowAddress {
  readonly bundleId: string;
  readonly fileId: string;
  readonly fileSha256: string;
  readonly filePath: string;
  readonly sheetId: string;
  readonly sheetName: string | null;
  readonly rowNumberSource: number;
  readonly rowLocatorId: string;
  readonly rowHash: string;
}

/**
 * What a source row contributed. A row on a record sheet contributes a record;
 * a row on a relationship-only sheet contributes associations. Keeping these
 * apart lets the reconciliation check both counts without conflating them.
 */
export type ContributionKind = 'RECORD' | 'ASSOCIATION' | 'NONE';

export interface LineageEntry {
  readonly address: RowAddress;
  readonly contributionKind: ContributionKind;
  readonly disposition: RowDisposition;
  readonly reasonCode: ReasonCode;
  readonly detail: string;
  readonly recordMappingId: string | null;
  readonly object: CanonicalObject | null;
  readonly sourceSystem: string | null;
  readonly sourceNamespace: string | null;
  readonly sourceRecordId: string | null;
  readonly identityKey: string | null;
  /** The identity key the record's migration key was derived from, so it can be recomputed. */
  readonly recordIdentityKey: string | null;
  /** Deterministic destination-side key for the record this row contributed to. */
  readonly migrationKey: string | null;
  readonly mergeId: string | null;
}

export interface ChangeEntry {
  readonly address: RowAddress;
  readonly columnLocatorId: string;
  readonly columnIndex: number;
  readonly columnHeader: string | null;
  readonly destinationField: string;
  readonly originalValue: string | null;
  readonly finalValue: string | null;
  readonly transformationId: string;
  readonly transformationVersion: string;
  readonly reasonCode: ReasonCode;
  readonly evidence: string;
}

export interface FlagEntry {
  readonly address: RowAddress;
  readonly columnLocatorId: string;
  readonly columnIndex: number;
  readonly columnHeader: string | null;
  readonly destinationField: string;
  readonly outcome: TransformResult['kind'];
  readonly preservedValue: string | null;
  readonly reasonCode: ReasonCode;
  readonly evidence: string;
  readonly blockedDelivery: boolean;
}

export interface UnmappedFieldEntry {
  readonly address: RowAddress;
  readonly columnLocatorId: string;
  readonly columnIndex: number;
  readonly columnHeader: string | null;
  readonly value: string;
  readonly reasonCode: ReasonCode;
}

export interface IsolatedEntry {
  readonly address: RowAddress;
  readonly object: CanonicalObject | null;
  readonly recordMappingId: string | null;
  readonly reasonCode: ReasonCode;
  /**
   * The destination field the reason is about, where the reason is about one.
   * Machine-readable on purpose: the corroboration used to be satisfied by the
   * mapping requiring *something*, which every real destination does, so a
   * delivered record could be withheld by relabelling it.
   */
  readonly field: string | null;
  readonly detail: string;
}

export interface LeftoverEntry {
  readonly address: RowAddress;
  readonly reasonCode: ReasonCode;
  readonly detail: string;
}

export interface RejectedEntry {
  readonly address: RowAddress;
  readonly reasonCode: ReasonCode;
  readonly detail: string;
}

export interface MergeFieldDecision {
  readonly destinationField: string;
  readonly value: string | null;
  readonly fromRowLocatorId: string;
  readonly reasonCode: ReasonCode;
}

export interface MergeConflict {
  readonly destinationField: string;
  readonly semanticsClass: 'STANDARD' | 'CONSENT';
  readonly values: readonly { readonly rowLocatorId: string; readonly value: string }[];
  readonly reasonCode: ReasonCode;
}

export interface MergeRecord {
  readonly mergeId: string;
  readonly object: CanonicalObject;
  readonly survivorMigrationKey: string;
  readonly survivorRowLocatorId: string;
  readonly absorbedRowLocatorIds: readonly string[];
  readonly identityEvidence: readonly IdentityEvidence[];
  readonly fieldDecisions: readonly MergeFieldDecision[];
  readonly conflicts: readonly MergeConflict[];
  readonly associationRemaps: readonly {
    readonly sourceEdgeId: string;
    readonly fromRowLocatorId: string;
    readonly toMigrationKey: string;
  }[];
  readonly ruleVersion: string;
}

export interface DuplicateCandidateEntry {
  readonly clusterId: string;
  readonly object: CanonicalObject;
  readonly migrationKey: string;
  readonly rowLocatorId: string;
  readonly filePath: string;
  readonly rowNumberSource: number;
  readonly signal: string;
  readonly signalValue: string;
  readonly evidence: string;
  readonly conflicts: string;
  readonly whyNotMerged: string;
  /** Which signal put these records in the same cluster. */
  readonly reasonCode: ReasonCode;
  /** Why the engine refused to combine them. */
  readonly notMergedReasonCode: ReasonCode;
}

export interface EdgeEntry {
  readonly sourceEdgeId: string;
  readonly associationMappingId: string;
  readonly relationshipType: RelationshipType;
  readonly label: string | null;
  readonly address: RowAddress;
  readonly fromKeyRaw: string;
  readonly toKeyRaw: string;
  readonly fromMigrationKey: string | null;
  readonly toMigrationKey: string | null;
  readonly disposition: EdgeDisposition;
  readonly reasonCode: ReasonCode;
  readonly detail: string;
  /** Set when this edge was folded into another after a proven merge. */
  readonly deduplicatedIntoEdgeId: string | null;
}

export interface DestinationConflictEntry {
  readonly object: CanonicalObject;
  readonly keyField: string;
  readonly keyValue: string;
  readonly migrationKeys: readonly string[];
  readonly rowLocatorIds: readonly string[];
  readonly reasonCode: ReasonCode;
  readonly detail: string;
}

export interface InstanceVerificationEntry {
  readonly scope: string;
  readonly detail: string;
  readonly sourceUrl: string;
  readonly reasonCode: ReasonCode;
}

export interface DeliveredRecord {
  readonly migrationKey: string;
  readonly object: CanonicalObject;
  readonly recordMappingId: string;
  readonly survivorRowLocatorId: string;
  readonly memberRowLocatorIds: readonly string[];
  readonly sourceSystem: string;
  readonly sourceNamespace: string;
  readonly sourceRecordId: string | null;
  /** Fields the destination is asked to hold a value for. */
  readonly values: Readonly<Record<string, string>>;
  /**
   * Fields the plan authorized emptying.
   *
   * Kept apart from `values` because a clear has no value and is not an
   * omission. Folding it into the value map is what made an authorized clear
   * disappear: the map dropped it for having nothing in it, and the import file
   * then looked exactly like a record that never mentioned the field.
   */
  readonly clearedFields: readonly string[];
}

export interface FormulaRiskEntry {
  readonly target: string;
  /** `ASSOCIATION` for a relationship label, which is delivered data too. */
  readonly object: CanonicalObject | 'ASSOCIATION';
  readonly migrationKey: string;
  readonly destinationField: string;
  readonly value: string;
  readonly reasonCode: ReasonCode;
}

/**
 * What the destination was asked to match on, once the captured contract had
 * been consulted. Recorded so the package states it rather than leaving a reader
 * to infer it from a column.
 */
export interface DestinationMatchRecord {
  readonly recordMappingId: string;
  readonly matchAuthority: string;
  readonly targetField: string | null;
  readonly sourceField: string | null;
  readonly onMissingMatch: string;
  readonly onMatchConflict: string;
  /** The attribute of the destination field that made the authority legal, for the audit trail. */
  readonly authorisedBy: string;
}

export interface RunTruth {
  readonly coreVersion: string;
  readonly bundleId: string;
  readonly runId: string;
  readonly configHash: string;
  readonly mode: string;
  readonly importMode: string;
  /**
   * The captured contract this run was shaped against, or null where there was
   * no destination instance to capture. A run that matched an existing record
   * always has one: nothing may match without evidence.
   */
  readonly targetContractHash: string | null;
  /**
   * The reading of the source this run was authorised against.
   *
   * Null where the host supplied no profile. Where it is set, the run has
   * already refused to proceed unless the profile described the bundle it read,
   * so this is a fact about the run rather than a label on it.
   */
  readonly sourceProfileHash: string | null;
  readonly destinationMatching: readonly DestinationMatchRecord[];
  readonly sourceFiles: readonly {
    readonly fileId: string;
    readonly path: string;
    readonly sha256: string;
    readonly byteLength: number;
    readonly format: string;
    readonly encoding: string;
    readonly encodingEvidence: string;
    readonly sheets: readonly {
      readonly sheetId: string;
      readonly sheetName: string | null;
      readonly hidden: boolean;
      readonly columnCount: number;
      /** Data rows the reader produced, counted at the reader. */
      readonly readerRowCount: number;
      readonly dataRowCount: number;
      readonly rejectedRowCount: number;
      readonly evidence: readonly { readonly kind: string; readonly detail: string }[];
    }[];
  }[];
  readonly lineage: SpooledFamily<LineageEntry>;
  readonly changes: SpooledFamily<ChangeEntry>;
  readonly flags: SpooledFamily<FlagEntry>;
  readonly unmappedFields: SpooledFamily<UnmappedFieldEntry>;
  readonly isolated: SpooledFamily<IsolatedEntry>;
  readonly leftovers: SpooledFamily<LeftoverEntry>;
  readonly rejected: SpooledFamily<RejectedEntry>;
  readonly merges: readonly MergeRecord[];
  readonly duplicateCandidates: SpooledFamily<DuplicateCandidateEntry>;
  /** Counted where the candidates were produced, like edgeCandidateCount and for the same reason. */
  readonly duplicateCandidateClusters: number;
  readonly duplicateCandidateRows: number;
  readonly edges: SpooledFamily<EdgeEntry>;
  /** Relationship candidates counted where they were produced, before any disposition. */
  readonly edgeCandidateCount: number;
  readonly destinationConflicts: readonly DestinationConflictEntry[];
  readonly instanceVerification: readonly InstanceVerificationEntry[];
  readonly deliveredRecords: SpooledFamily<DeliveredRecord>;
  readonly formulaRisks: SpooledFamily<FormulaRiskEntry>;
}
