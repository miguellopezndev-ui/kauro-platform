import type {
  CanonicalObject,
  FieldSemanticsClass,
  ImportMode,
  SemanticType,
} from './canonical.js';
import type { RelationshipType } from './associations.js';
import type { SourceEncoding, SourceFormat } from './locators.js';

/**
 * The migration configuration.
 *
 * Nothing in the engine is driven by heuristics over the customer's data. Every
 * decision that could change a value comes from here, and the schema is closed:
 * an unrecognised key is a configuration error rather than a silent no-op.
 */

/**
 * 3.0.0 changed what an unwritten option means: `trim` is off unless the field
 * says otherwise (decision D67, whitespace is a value). A 2.x configuration
 * was written for a core that trimmed every field, so it is refused with that
 * explanation and never read with the new meaning.
 */
export const CONFIG_SCHEMA_VERSION = '3.0.0';

/**
 * The commercial modes. There are exactly three, and CLEAN_ONLY is not a fourth
 * CRM: it is the mode that has no destination instance at all, so it needs no
 * target contract and makes no claim about anybody's portal or org. The
 * vendor-neutral shaping it uses is an internal representation, not a product.
 */
export const TARGET_MODES = ['HUBSPOT', 'SALESFORCE', 'CLEAN_ONLY'] as const;
export type TargetMode = (typeof TARGET_MODES)[number];

export const DATE_FORMATS = [
  'ISO_8601',
  'MM/DD/YYYY',
  'DD/MM/YYYY',
  'YYYY/MM/DD',
  'MM-DD-YYYY',
  'DD-MM-YYYY',
  'DD.MM.YYYY',
  'MM.DD.YYYY',
  'SPREADSHEET_SERIAL',
] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export const DELIMITERS = [',', ';', '\t', '|'] as const;
export type Delimiter = (typeof DELIMITERS)[number];

export const AMBIGUITY_POLICIES = ['PRESERVE', 'ISOLATE_ROW'] as const;
export type AmbiguityPolicy = (typeof AMBIGUITY_POLICIES)[number];

/**
 * Unicode normalization form applied to a text value before it is interpreted.
 *
 * Only the canonical composition is offered. NFKC and NFKD are compatibility
 * mappings: they rewrite one character as a different one that merely looks
 * similar, which is a change to the customer's data rather than a normalization
 * of it. NFD is left out because the destinations this engine writes for expect
 * composed text.
 */
export const UNICODE_NORMALIZATIONS = ['PRESERVE', 'NFC'] as const;
export type UnicodeNormalization = (typeof UNICODE_NORMALIZATIONS)[number];

/**
 * Case rule applied to a text value the configuration asks to be re-cased.
 *
 * `TITLE_SIMPLE` is named for what it is: a mechanical rule over code points,
 * with no dictionary and no linguistic knowledge. It cannot reconstruct
 * McNamara, van der Waals or eBay, and it does not try. Such an exception is
 * written down in `valueMap`, which is consulted first.
 */
export const CASE_TRANSFORMS = ['PRESERVE', 'LOWER', 'UPPER', 'TITLE_SIMPLE'] as const;
export type CaseTransform = (typeof CASE_TRANSFORMS)[number];

/** One exact source value and the exact value the configuration asks for in its place. */
export interface ValueMapEntry {
  readonly from: string;
  readonly to: string;
}

export interface ColumnRef {
  /** Match by header text. Combine with `occurrence` when a header repeats. */
  readonly header: string | null;
  /** 1-based ordinal among columns sharing the same header. Defaults to 1. */
  readonly occurrence: number | null;
  /** Match by zero-based physical position. Mutually exclusive with `header`. */
  readonly index: number | null;
}

export interface Limits {
  readonly maxFiles: number;
  readonly maxBytesPerFile: number;
  readonly maxTotalBytes: number;
  readonly maxSheetsPerFile: number;
  readonly maxRowsPerSheet: number;
  readonly maxColumnsPerSheet: number;
  readonly maxCellLength: number;
  /** Guard against compressed archives that expand without bound: the most all the parts together may inflate to. */
  readonly maxWorkbookUncompressedBytes: number;
  /**
   * The most one part of a workbook may inflate to.
   *
   * The envelope of a workbook is conjunctive -- the file within its limit, and
   * every part within this one, and the parts together within the workbook
   * limit -- because a total alone admits a single part as large as the whole
   * allowance (D70).
   */
  readonly maxWorkbookPartUncompressedBytes: number;
  /**
   * The most one CSV record may hold, in UTF-8 bytes, counted while it grows.
   *
   * A record is cells that are each within `maxCellLength`, so the cell limit
   * alone bounds nothing about a record of a thousand of them (D71).
   */
  readonly maxRecordBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxFiles: 50,
  maxBytesPerFile: 104_857_600,
  maxTotalBytes: 524_288_000,
  maxSheetsPerFile: 25,
  maxRowsPerSheet: 250_000,
  maxColumnsPerSheet: 1_000,
  maxCellLength: 65_536,
  maxWorkbookUncompressedBytes: 268_435_456,
  maxWorkbookPartUncompressedBytes: 134_217_728,
  maxRecordBytes: 1_048_576,
};

export const OCCURRENCE_DECISIONS = ['INDEPENDENT', 'EXCLUDE_ONE'] as const;
export type OccurrenceDecision = (typeof OCCURRENCE_DECISIONS)[number];

/**
 * What the plan says about files that hold the same bytes (D69).
 *
 * A file is an occurrence, identified by its path, its source namespace and its
 * place in the plan. Equal bytes are evidence about what a file holds and never
 * make two occurrences one. Equal bytes across namespaces need no declaration.
 * Equal bytes inside one namespace stop the run until the plan says which they are:
 *
 * - `INDEPENDENT`: each file is its own export. Both are read and both stay in the lineage.
 * - `EXCLUDE_ONE`: the first file listed is the occurrence that is kept; the others are
 *   read, counted, and every one of their rows is rejected input with a reason.
 */
export interface OccurrenceDeclaration {
  /** File ids, in the order they are listed. */
  readonly files: readonly string[];
  readonly decision: OccurrenceDecision;
}

export interface Policies {
  /** A row whose column count differs from the header row. */
  readonly rowShapeMismatch: 'REJECT_ROW' | 'FAIL_RUN';
  /** A row with no value in any column. */
  readonly blankRow: 'REJECT_ROW' | 'FAIL_RUN';
  /**
   * What to do with a cell whose value the spreadsheet computed from a formula.
   * The engine never evaluates formulas either way; this only decides whether
   * the cached result may be delivered.
   */
  readonly formulaCachedValues: 'ISOLATE_ROW' | 'ACCEPT_WITH_PROVENANCE';
  /** What to do when two distinct source records would collide on the destination's matching key. */
  readonly destinationKeyConflict: 'ISOLATE' | 'DELIVER_WITH_ALTERNATE_KEY';
  /** What to do when rows proven to be one record disagree on a populated field. */
  readonly mergeFieldConflict: 'ISOLATE_RECORD' | 'PREFER_SURVIVOR';
  /**
   * Required when `mergeFieldConflict` is PREFER_SURVIVOR. Recorded verbatim in
   * every affected merge record so the choice is attributable.
   */
  readonly mergeFieldConflictJustification: string | null;
}

export const DEFAULT_POLICIES: Policies = {
  rowShapeMismatch: 'REJECT_ROW',
  blankRow: 'REJECT_ROW',
  formulaCachedValues: 'ISOLATE_ROW',
  destinationKeyConflict: 'ISOLATE',
  mergeFieldConflict: 'ISOLATE_RECORD',
  mergeFieldConflictJustification: null,
};

export interface LocaleEvidence {
  /** ISO 3166-1 alpha-2 country for phone numbers that carry no international prefix. */
  readonly phoneCountry: string | null;
  readonly dateFormat: DateFormat | null;
  readonly decimalSeparator: string | null;
  readonly thousandsSeparator: string | null;
}

export const DEFAULT_LOCALE_EVIDENCE: LocaleEvidence = {
  phoneCountry: null,
  dateFormat: null,
  decimalSeparator: null,
  thousandsSeparator: null,
};

/** What the engine does with a local time that happens twice in a declared zone. */
export const TIMEZONE_OVERLAP_POLICIES = ['REFUSE', 'EARLIER', 'LATER'] as const;
export type TimezoneOverlapPolicy = (typeof TIMEZONE_OVERLAP_POLICIES)[number];

/**
 * A declared IANA zone, bound to the tzdata release it was declared against.
 *
 * A zone name alone is not a rule: the rules behind it change between tzdata
 * releases, and a plan that names a zone without a release would deliver
 * different instants on a different runtime. The release is therefore part of
 * the plan, and a runtime whose own release differs refuses the plan.
 */
export interface TimezonePolicy {
  readonly zone: string;
  readonly tzdata: string;
  readonly overlap: TimezoneOverlapPolicy;
}

/**
 * An identity normalization, declared on the key column it applies to.
 *
 * An identifier is a value. Without this declaration a source id or an
 * authoritative external id enters its identity key exactly as the source
 * wrote it. With it, the normalized spelling is the key, every row whose key
 * the rule changed is flagged (IDENTITY_KEY_NORMALIZED), and a merge that only
 * exists because the rule made two spellings equal says so
 * (IDENTITY_NORMALIZATION_COLLISION).
 */
export interface IdentityNormalization {
  readonly trim: boolean;
  readonly unicode: 'NFC' | null;
}

/** A source column that carries an identity key, with the normalization its plan declared, if any. */
export interface KeyColumnRef extends ColumnRef {
  readonly identityNormalization: IdentityNormalization | null;
}

export interface FieldOptions {
  /**
   * Remove leading and trailing whitespace. Off by default: whitespace is part
   * of the value until a field approves removing it (D67).
   */
  readonly trim: boolean;
  /** Canonical Unicode composition, for TEXT and ENUM. */
  readonly unicodeNormalization: UnicodeNormalization;
  /** Mechanical re-casing, for TEXT. Skipped entirely when `valueMap` matched. */
  readonly caseTransform: CaseTransform;
  /**
   * Exact source-value substitutions, for TEXT and ENUM. The order of the array
   * carries no meaning: it is sorted when the configuration is normalized, and
   * two entries that would compare equal are a configuration error, so there is
   * no such thing as a first match winning.
   */
  readonly valueMap: readonly ValueMapEntry[];
  readonly lowercaseDomain: boolean;
  readonly phoneCountry: string | null;
  readonly phoneCountryColumn: ColumnRef | null;
  readonly extensionDestinationField: string | null;
  readonly dateFormat: DateFormat | null;
  readonly timezoneOffset: string | null;
  /** A declared zone with its tzdata release. Mutually exclusive with `timezoneOffset`. */
  readonly timezone: TimezonePolicy | null;
  readonly decimalSeparator: string | null;
  readonly thousandsSeparator: string | null;
  readonly trueValues: readonly string[];
  readonly falseValues: readonly string[];
  readonly allowedValues: readonly string[] | null;
  /**
   * Values the customer has explicitly authorized the engine to erase, such as
   * placeholder text meaning "no data". This is the only path by which a
   * non-empty source cell may become empty, and it requires
   * `destructiveAuthorization` to be set.
   */
  readonly clearWhenMatches: readonly string[];
  readonly destructiveAuthorization: boolean;
}

export const DEFAULT_FIELD_OPTIONS: FieldOptions = {
  trim: false,
  unicodeNormalization: 'PRESERVE',
  caseTransform: 'PRESERVE',
  valueMap: [],
  lowercaseDomain: true,
  phoneCountry: null,
  phoneCountryColumn: null,
  extensionDestinationField: null,
  dateFormat: null,
  timezoneOffset: null,
  timezone: null,
  decimalSeparator: null,
  thousandsSeparator: null,
  trueValues: ['true', 'yes', 'y', '1'],
  falseValues: ['false', 'no', 'n', '0'],
  allowedValues: null,
  clearWhenMatches: [],
  destructiveAuthorization: false,
};

/**
 * The spelling of an identifier that enters its identity key.
 *
 * Exactly what the source wrote, unless the key column declared a
 * normalization. Nothing else ever changes it.
 */
export function normalizeIdentityValue(
  raw: string,
  normalization: IdentityNormalization | null,
): string {
  if (normalization === null) return raw;
  const trimmed = normalization.trim ? raw.trim() : raw;
  return normalization.unicode === 'NFC' ? trimmed.normalize('NFC') : trimmed;
}

/**
 * The form a `valueMap` entry's `from` is compared in.
 *
 * A mapping is written against the value the source file holds, so it has to
 * live in the same comparison space the working value reaches by the time the
 * lookup happens: trimmed when the field trims, composed when the field
 * composes. Case is deliberately not folded here — an exact mapping is how an
 * exception to `caseTransform` is written down, so folding case would make the
 * exception unexpressible.
 */
export function effectiveValueMapFrom(
  from: string,
  options: Pick<FieldOptions, 'trim' | 'unicodeNormalization'>,
): string {
  const trimmed = options.trim ? from.trim() : from;
  return options.unicodeNormalization === 'NFC' ? trimmed.normalize('NFC') : trimmed;
}

export interface FieldMappingConfig {
  readonly column: ColumnRef;
  readonly destinationField: string;
  readonly semanticType: SemanticType;
  /**
   * Declares that this column carries consent, privacy or suppression meaning.
   * Canonical fields already know; a "custom:" field cannot, and a consent flag
   * carried in one is exactly the value that must never be resolved by policy.
   */
  readonly semanticsClass: FieldSemanticsClass | null;
  /** Required by the migration contract, independently of what the vendor requires. */
  readonly required: boolean;
  readonly onAmbiguous: AmbiguityPolicy;
  readonly onInvalid: AmbiguityPolicy;
  readonly options: FieldOptions;
}

export interface FileConfig {
  readonly id: string;
  /** Path relative to the input bundle root. Forward slashes on every platform. */
  readonly path: string;
  readonly format: SourceFormat;
  readonly encoding: SourceEncoding | null;
  readonly delimiter: Delimiter | null;
  readonly sourceSystem: string | null;
  readonly sourceNamespace: string | null;
  /** Worksheet names to read. `null` reads every visible sheet. */
  readonly sheets: readonly string[] | null;
}

export interface RecordMappingConfig {
  readonly id: string;
  readonly fileId: string;
  readonly sheet: string | null;
  /**
   * The scope inside which this sheet's record ids mean something. It defaults
   * to the mapping's own id, so two sheets with independent id sequences never
   * collide. Two sheets that are halves of one export declare the same value.
   */
  readonly identitySpace: string | null;
  readonly object: CanonicalObject;
  readonly sourceRecordIdColumn: KeyColumnRef | null;
  readonly authoritativeExternalIdColumns: readonly KeyColumnRef[];
  readonly fields: readonly FieldMappingConfig[];
}

export interface ColumnReferenceAssociationConfig {
  readonly id: string;
  readonly kind: 'COLUMN_REFERENCE';
  /** The record mapping whose rows carry the key column. */
  readonly recordMappingId: string;
  readonly relationshipType: RelationshipType;
  /**
   * Which end of the relationship the owning row sits on. A contact row
   * carrying a company key is the FROM end of CONTACT_TO_COMPANY; a deal row
   * carrying a company key is the TO end of COMPANY_TO_DEAL.
   */
  readonly ownerSide: 'FROM' | 'TO';
  readonly keyColumn: ColumnRef;
  readonly targetRecordMappingId: string;
  /** Whether the key matches the target's source record id, or a named column on the target. */
  readonly targetMatchKey: 'SOURCE_RECORD_ID' | 'COLUMN';
  readonly targetMatchColumn: ColumnRef | null;
  readonly label: string | null;
}

export interface EdgeFileAssociationConfig {
  readonly id: string;
  readonly kind: 'EDGE_FILE';
  readonly fileId: string;
  readonly sheet: string | null;
  readonly relationshipType: RelationshipType;
  /** Both endpoint columns match the source record id of their target record mapping. */
  readonly fromRecordMappingId: string;
  readonly fromKeyColumn: ColumnRef;
  readonly toRecordMappingId: string;
  readonly toKeyColumn: ColumnRef;
  readonly labelColumn: ColumnRef | null;
  readonly label: string | null;
}

export type AssociationMappingConfig =
  | ColumnReferenceAssociationConfig
  | EdgeFileAssociationConfig;

/**
 * What the destination is asked to match an existing record on.
 *
 * This is the whole of the separation between a Kauro trace key and destination
 * match authority. A trace key names a delivered record so it can be followed
 * back to its source rows. It is not evidence about anybody's instance, and
 * asking an operator to create a unique property or an External ID to hold it
 * would be Kauro requiring infrastructure inside a customer's account in order
 * to work. So matching is declared here, in the plan, and every declaration is
 * checked against the captured target contract before a package is written.
 *
 * `NONE` is the only authority a create-only import may declare: nothing is
 * matched, so nothing may claim to be.
 */
export const MATCH_AUTHORITIES = ['NONE', 'RECORD_ID', 'EXTERNAL_ID', 'TARGET_UNIQUE_FIELD'] as const;
export type MatchAuthority = (typeof MATCH_AUTHORITIES)[number];

/**
 * What to do with a row whose declared match value finds nothing at the
 * destination. `CREATE` is only legal where the import mode creates at all.
 */
export const MISSING_MATCH_POLICIES = ['CREATE', 'ISOLATE', 'FAIL_RUN'] as const;
export type MissingMatchPolicy = (typeof MISSING_MATCH_POLICIES)[number];

/**
 * What to do when two source records carry the same declared match value. They
 * would become one record at the destination, which is the silent merge this
 * engine exists to prevent, so there is no policy that delivers both.
 */
export const MATCH_CONFLICT_POLICIES = ['ISOLATE', 'FAIL_RUN'] as const;
export type MatchConflictPolicy = (typeof MATCH_CONFLICT_POLICIES)[number];

export interface DestinationMatchConfig {
  /** The record mapping this declaration governs. Exactly one per mapping when the import mode matches. */
  readonly recordMappingId: string;
  readonly matchAuthority: MatchAuthority;
  /**
   * The destination field the value is written to and matched on, by the name
   * the instance answers to: a Salesforce API name, a HubSpot internal name.
   * It must exist in the captured target contract with the attributes the
   * authority requires. Kauro never creates it.
   */
  readonly targetField: string | null;
  /** The mapped field on this record whose value is the match value. */
  readonly sourceField: string | null;
  readonly onMissingMatch: MissingMatchPolicy;
  readonly onMatchConflict: MatchConflictPolicy;
}

export const DEFAULT_DESTINATION_MATCH: Omit<DestinationMatchConfig, 'recordMappingId'> = {
  matchAuthority: 'NONE',
  targetField: null,
  sourceField: null,
  onMissingMatch: 'ISOLATE',
  onMatchConflict: 'ISOLATE',
};

export interface MigrationConfig {
  readonly configVersion: string;
  readonly source: {
    readonly system: string;
    readonly namespace: string;
    readonly encoding: SourceEncoding | null;
  };
  readonly target: {
    /** The commercial mode. HUBSPOT and SALESFORCE address a real instance; CLEAN_ONLY does not. */
    readonly mode: TargetMode;
    /** What the destination is asked to do with each delivered record. */
    readonly importMode: ImportMode;
  };
  readonly localeEvidence: LocaleEvidence;
  readonly limits: Limits;
  readonly policies: Policies;
  readonly files: readonly FileConfig[];
  readonly records: readonly RecordMappingConfig[];
  readonly associations: readonly AssociationMappingConfig[];
  /**
   * One entry per record mapping the destination is asked to match on. Empty
   * under CREATE_ONLY, where nothing is matched.
   */
  readonly destinationMatching: readonly DestinationMatchConfig[];
  /** Decisions about files that hold the same bytes. Empty when the plan has none. */
  readonly occurrences: readonly OccurrenceDeclaration[];
}
