import { MigrationError } from '../domain/errors.js';
import type { JsonObject, JsonValue } from '../util/json.js';
import { canonicalJsonText } from '../util/json.js';
import { sha256Hex } from '../util/hash.js';
import { validateAgainstSchema } from './schema-validator.js';
import { CONFIG_SCHEMA } from './config-schema.js';
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_FIELD_OPTIONS,
  DEFAULT_LIMITS,
  DEFAULT_LOCALE_EVIDENCE,
  DEFAULT_POLICIES,
  effectiveValueMapFrom,
} from '../domain/config.js';
import { assertTimezoneUsable } from '../transform/timezone.js';
import type {
  AssociationMappingConfig,
  CaseTransform,
  DestinationMatchConfig,
  MatchAuthority,
  MatchConflictPolicy,
  MissingMatchPolicy,
  ColumnRef,
  IdentityNormalization,
  KeyColumnRef,
  TimezoneOverlapPolicy,
  TimezonePolicy,
  Delimiter,
  DateFormat,
  FieldMappingConfig,
  FieldOptions,
  FileConfig,
  LocaleEvidence,
  Limits,
  MigrationConfig,
  OccurrenceDecision,
  OccurrenceDeclaration,
  Policies,
  RecordMappingConfig,
  UnicodeNormalization,
  ValueMapEntry,
  TargetMode,
} from '../domain/config.js';
import { by, onString, sorted } from '../util/sorting.js';
import type {
  CanonicalObject,
  FieldSemanticsClass,
  ImportMode,
  SemanticType,
} from '../domain/canonical.js';
import {
  assertFieldBelongsToObject,
  fieldSemanticsClass,
  isCanonicalField,
  isCustomField,
} from '../domain/canonical.js';
import { relationshipShape } from '../domain/associations.js';
import type { RelationshipType } from '../domain/associations.js';
import type { SourceEncoding, SourceFormat } from '../domain/locators.js';

export interface LoadedConfig {
  readonly config: MigrationConfig;
  /** SHA-256 over the canonical rendering of the normalized configuration. */
  readonly configHash: string;
  /** The normalized configuration as JSON, recorded in the package for reproduction. */
  readonly normalizedJson: JsonObject;
}

/** Options that only apply to certain semantic types. Setting one elsewhere is a configuration error. */
const OPTION_APPLICABILITY: Readonly<Record<string, readonly SemanticType[]>> = {
  unicodeNormalization: ['TEXT', 'ENUM'],
  caseTransform: ['TEXT'],
  valueMap: ['TEXT', 'ENUM'],
  lowercaseDomain: ['EMAIL'],
  phoneCountry: ['PHONE'],
  phoneCountryColumn: ['PHONE'],
  extensionDestinationField: ['PHONE'],
  dateFormat: ['DATE', 'DATETIME'],
  timezoneOffset: ['DATETIME'],
  timezone: ['DATETIME'],
  decimalSeparator: ['NUMBER'],
  thousandsSeparator: ['NUMBER'],
  trueValues: ['BOOLEAN'],
  falseValues: ['BOOLEAN'],
  allowedValues: ['ENUM'],
};

export function loadConfig(text: string, origin: string): LoadedConfig {
  let raw: JsonValue;
  try {
    raw = JSON.parse(text) as JsonValue;
  } catch (error) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `${origin} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      'Fix the JSON syntax and run again.',
      { origin },
    );
  }

  refuseEarlierSchema(raw, origin);

  const violations = validateAgainstSchema(raw, CONFIG_SCHEMA);
  if (violations.length > 0) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `${origin} does not match configuration schema ${CONFIG_SCHEMA_VERSION}`,
      'Correct each listed pointer. The schema is closed, so unknown properties are rejected rather than ignored.',
      {
        origin,
        violations: violations.map((violation) => ({
          pointer: violation.pointer === '' ? '/' : violation.pointer,
          message: violation.message,
        })),
      },
    );
  }

  const config = normalize(raw as JsonObject);
  crossValidate(config, origin);

  const normalizedJson = configToJson(config);
  return {
    config,
    configHash: sha256Hex(canonicalJsonText(normalizedJson)),
    normalizedJson,
  };
}

/**
 * A 2.x configuration is refused, never reinterpreted.
 *
 * Schema 3.0.0 changed the meaning of an unwritten option: `trim` used to be
 * on for every field and is now off until a field approves it, because
 * whitespace is part of a value (D67). A plan written against 2.x assumed the
 * trimming it never declared, so reading it under 3.0.0 would silently deliver
 * different values from the ones its author expected, and reading it under the
 * old meaning would trim fields nobody approved.
 */
function refuseEarlierSchema(raw: JsonValue, origin: string): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
  const declared = (raw as JsonObject)['configVersion'];
  if (typeof declared !== 'string' || !/^2\./u.test(declared)) return;
  throw new MigrationError(
    'CONFIG_INVALID',
    `${origin} is a configuration of schema ${declared}, and this core reads schema ${CONFIG_SCHEMA_VERSION}. Schema ${CONFIG_SCHEMA_VERSION} changed the default of "trim": a field trims only when it says "trim": true, because whitespace is part of a value. A ${declared} plan was written for a core that trimmed every field, so it is not read with the new meaning.`,
    `Decide, field by field, which fields should still be trimmed and set "trim": true on each of them. Then set "configVersion" to "${CONFIG_SCHEMA_VERSION}". A field that says nothing keeps its whitespace.`,
    { origin, declaredVersion: declared, readVersion: CONFIG_SCHEMA_VERSION, changed: 'options.trim default true -> false' },
  );
}

// --------------------------------------------------------------- normalizing

function obj(value: JsonValue | undefined): JsonObject {
  return (value ?? {}) as JsonObject;
}

function str(value: JsonValue | undefined, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function strOrNull(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function bool(value: JsonValue | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function num(value: JsonValue | undefined, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function strArray(value: JsonValue | undefined, fallback: readonly string[]): readonly string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : fallback;
}

function normalizeColumnRef(value: JsonValue | undefined): ColumnRef {
  const source = obj(value);
  return {
    header: strOrNull(source['header']),
    occurrence: typeof source['occurrence'] === 'number' ? source['occurrence'] : null,
    index: typeof source['index'] === 'number' ? source['index'] : null,
  };
}

function normalizeColumnRefOrNull(value: JsonValue | undefined): ColumnRef | null {
  if (value === undefined || value === null) return null;
  return normalizeColumnRef(value);
}

function normalizeIdentityNormalization(value: JsonValue | undefined): IdentityNormalization | null {
  if (value === undefined || value === null) return null;
  const source = obj(value);
  const unicode = source['unicode'];
  return { trim: bool(source['trim'], false), unicode: unicode === 'NFC' ? 'NFC' : null };
}

function normalizeKeyColumnRef(value: JsonValue | undefined): KeyColumnRef {
  return {
    ...normalizeColumnRef(value),
    identityNormalization: normalizeIdentityNormalization(obj(value)['identityNormalization']),
  };
}

function normalizeTimezone(value: JsonValue | undefined): TimezonePolicy | null {
  if (value === undefined || value === null) return null;
  const source = obj(value);
  return {
    zone: str(source['zone'], ''),
    tzdata: str(source['tzdata'], ''),
    overlap: str(source['overlap'], 'REFUSE') as TimezoneOverlapPolicy,
  };
}

/**
 * Value mappings in a declared order.
 *
 * The order the operator happened to write them in is not part of the meaning,
 * so two plans that say the same thing have to normalize — and therefore
 * hash — identically. Sorting by the comparison form rather than by the raw
 * `from` is what makes that true, and it is the same form the lookup uses at
 * run time.
 */
function normalizeValueMap(
  value: JsonValue | undefined,
  options: Pick<FieldOptions, 'trim' | 'unicodeNormalization'>,
): readonly ValueMapEntry[] {
  if (!Array.isArray(value)) return DEFAULT_FIELD_OPTIONS.valueMap;
  const entries = value.map((item): ValueMapEntry => {
    const entry = obj(item);
    return { from: str(entry['from'], ''), to: str(entry['to'], '') };
  });
  return sorted(
    entries,
    by(
      onString((entry) => effectiveValueMapFrom(entry.from, options)),
      onString((entry) => entry.to),
    ),
  );
}

function normalizeFieldOptions(value: JsonValue | undefined): FieldOptions {
  const source = obj(value);
  const trim = bool(source['trim'], DEFAULT_FIELD_OPTIONS.trim);
  const unicodeNormalization = str(
    source['unicodeNormalization'],
    DEFAULT_FIELD_OPTIONS.unicodeNormalization,
  ) as UnicodeNormalization;
  return {
    trim,
    unicodeNormalization,
    caseTransform: str(source['caseTransform'], DEFAULT_FIELD_OPTIONS.caseTransform) as CaseTransform,
    valueMap: normalizeValueMap(source['valueMap'], { trim, unicodeNormalization }),
    lowercaseDomain: bool(source['lowercaseDomain'], DEFAULT_FIELD_OPTIONS.lowercaseDomain),
    phoneCountry: strOrNull(source['phoneCountry']),
    phoneCountryColumn: normalizeColumnRefOrNull(source['phoneCountryColumn']),
    extensionDestinationField: strOrNull(source['extensionDestinationField']),
    dateFormat: strOrNull(source['dateFormat']) as DateFormat | null,
    timezoneOffset: strOrNull(source['timezoneOffset']),
    timezone: normalizeTimezone(source['timezone']),
    decimalSeparator: strOrNull(source['decimalSeparator']),
    thousandsSeparator: strOrNull(source['thousandsSeparator']),
    trueValues: strArray(source['trueValues'], DEFAULT_FIELD_OPTIONS.trueValues),
    falseValues: strArray(source['falseValues'], DEFAULT_FIELD_OPTIONS.falseValues),
    allowedValues: Array.isArray(source['allowedValues'])
      ? source['allowedValues'].map((item) => String(item))
      : null,
    clearWhenMatches: strArray(source['clearWhenMatches'], DEFAULT_FIELD_OPTIONS.clearWhenMatches),
    destructiveAuthorization: bool(
      source['destructiveAuthorization'],
      DEFAULT_FIELD_OPTIONS.destructiveAuthorization,
    ),
  };
}

function normalizeField(value: JsonValue): FieldMappingConfig {
  const source = obj(value);
  return {
    column: normalizeColumnRef(source['column']),
    destinationField: str(source['destinationField'], ''),
    semanticType: str(source['semanticType'], 'TEXT') as SemanticType,
    semanticsClass: strOrNull(source['semanticsClass']) as FieldSemanticsClass | null,
    required: bool(source['required'], false),
    onAmbiguous: str(source['onAmbiguous'], 'PRESERVE') as 'PRESERVE' | 'ISOLATE_ROW',
    onInvalid: str(source['onInvalid'], 'PRESERVE') as 'PRESERVE' | 'ISOLATE_ROW',
    options: normalizeFieldOptions(source['options']),
  };
}

function normalizeLimits(value: JsonValue | undefined): Limits {
  const source = obj(value);
  return {
    maxFiles: num(source['maxFiles'], DEFAULT_LIMITS.maxFiles),
    maxBytesPerFile: num(source['maxBytesPerFile'], DEFAULT_LIMITS.maxBytesPerFile),
    maxTotalBytes: num(source['maxTotalBytes'], DEFAULT_LIMITS.maxTotalBytes),
    maxSheetsPerFile: num(source['maxSheetsPerFile'], DEFAULT_LIMITS.maxSheetsPerFile),
    maxRowsPerSheet: num(source['maxRowsPerSheet'], DEFAULT_LIMITS.maxRowsPerSheet),
    maxColumnsPerSheet: num(source['maxColumnsPerSheet'], DEFAULT_LIMITS.maxColumnsPerSheet),
    maxCellLength: num(source['maxCellLength'], DEFAULT_LIMITS.maxCellLength),
    maxWorkbookUncompressedBytes: num(
      source['maxWorkbookUncompressedBytes'],
      DEFAULT_LIMITS.maxWorkbookUncompressedBytes,
    ),
    maxWorkbookPartUncompressedBytes: num(
      source['maxWorkbookPartUncompressedBytes'],
      DEFAULT_LIMITS.maxWorkbookPartUncompressedBytes,
    ),
    maxRecordBytes: num(source['maxRecordBytes'], DEFAULT_LIMITS.maxRecordBytes),
  };
}

function normalizePolicies(value: JsonValue | undefined): Policies {
  const source = obj(value);
  return {
    rowShapeMismatch: str(source['rowShapeMismatch'], DEFAULT_POLICIES.rowShapeMismatch) as Policies['rowShapeMismatch'],
    blankRow: str(source['blankRow'], DEFAULT_POLICIES.blankRow) as Policies['blankRow'],
    formulaCachedValues: str(
      source['formulaCachedValues'],
      DEFAULT_POLICIES.formulaCachedValues,
    ) as Policies['formulaCachedValues'],
    destinationKeyConflict: str(
      source['destinationKeyConflict'],
      DEFAULT_POLICIES.destinationKeyConflict,
    ) as Policies['destinationKeyConflict'],
    mergeFieldConflict: str(
      source['mergeFieldConflict'],
      DEFAULT_POLICIES.mergeFieldConflict,
    ) as Policies['mergeFieldConflict'],
    mergeFieldConflictJustification: strOrNull(source['mergeFieldConflictJustification']),
  };
}

function normalizeLocaleEvidence(value: JsonValue | undefined): LocaleEvidence {
  const source = obj(value);
  return {
    phoneCountry: strOrNull(source['phoneCountry']) ?? DEFAULT_LOCALE_EVIDENCE.phoneCountry,
    dateFormat: (strOrNull(source['dateFormat']) as DateFormat | null) ?? DEFAULT_LOCALE_EVIDENCE.dateFormat,
    decimalSeparator: strOrNull(source['decimalSeparator']) ?? DEFAULT_LOCALE_EVIDENCE.decimalSeparator,
    thousandsSeparator: strOrNull(source['thousandsSeparator']) ?? DEFAULT_LOCALE_EVIDENCE.thousandsSeparator,
  };
}

function normalizeAssociation(value: JsonValue): AssociationMappingConfig {
  const source = obj(value);
  const kind = str(source['kind'], '');
  if (kind === 'EDGE_FILE') {
    return {
      id: str(source['id'], ''),
      kind: 'EDGE_FILE',
      fileId: str(source['fileId'], ''),
      sheet: strOrNull(source['sheet']),
      relationshipType: str(source['relationshipType'], '') as RelationshipType,
      fromRecordMappingId: str(source['fromRecordMappingId'], ''),
      fromKeyColumn: normalizeColumnRef(source['fromKeyColumn']),
      toRecordMappingId: str(source['toRecordMappingId'], ''),
      toKeyColumn: normalizeColumnRef(source['toKeyColumn']),
      labelColumn: normalizeColumnRefOrNull(source['labelColumn']),
      label: strOrNull(source['label']),
    };
  }
  return {
    id: str(source['id'], ''),
    kind: 'COLUMN_REFERENCE',
    recordMappingId: str(source['recordMappingId'], ''),
    relationshipType: str(source['relationshipType'], '') as RelationshipType,
    ownerSide: str(source['ownerSide'], 'FROM') as 'FROM' | 'TO',
    keyColumn: normalizeColumnRef(source['keyColumn']),
    targetRecordMappingId: str(source['targetRecordMappingId'], ''),
    targetMatchKey: str(source['targetMatchKey'], 'SOURCE_RECORD_ID') as 'SOURCE_RECORD_ID' | 'COLUMN',
    targetMatchColumn: normalizeColumnRefOrNull(source['targetMatchColumn']),
    label: strOrNull(source['label']),
  };
}

function normalize(source: JsonObject): MigrationConfig {
  const sourceBlock = obj(source['source']);
  const targetBlock = obj(source['target']);
  const files = (source['files'] as JsonValue[] | undefined) ?? [];
  const records = (source['records'] as JsonValue[] | undefined) ?? [];
  const associations = (source['associations'] as JsonValue[] | undefined) ?? [];
  const destinationMatching = (source['destinationMatching'] as JsonValue[] | undefined) ?? [];
  const occurrences = (source['occurrences'] as JsonValue[] | undefined) ?? [];

  return {
    configVersion: str(source['configVersion'], CONFIG_SCHEMA_VERSION),
    source: {
      system: str(sourceBlock['system'], ''),
      namespace: str(sourceBlock['namespace'], ''),
      encoding: strOrNull(sourceBlock['encoding']) as SourceEncoding | null,
    },
    target: {
      mode: str(targetBlock['mode'], 'CLEAN_ONLY') as TargetMode,
      importMode: str(targetBlock['importMode'], 'CREATE_ONLY') as ImportMode,
    },
    localeEvidence: normalizeLocaleEvidence(source['localeEvidence']),
    limits: normalizeLimits(source['limits']),
    policies: normalizePolicies(source['policies']),
    files: files.map((entry): FileConfig => {
      const file = obj(entry);
      return {
        id: str(file['id'], ''),
        path: str(file['path'], ''),
        format: str(file['format'], 'CSV') as SourceFormat,
        encoding: strOrNull(file['encoding']) as SourceEncoding | null,
        delimiter: strOrNull(file['delimiter']) as Delimiter | null,
        sourceSystem: strOrNull(file['sourceSystem']),
        sourceNamespace: strOrNull(file['sourceNamespace']),
        sheets: Array.isArray(file['sheets']) ? file['sheets'].map((item) => String(item)) : null,
      };
    }),
    records: records.map((entry): RecordMappingConfig => {
      const record = obj(entry);
      const fields = (record['fields'] as JsonValue[] | undefined) ?? [];
      const externalIds = (record['authoritativeExternalIdColumns'] as JsonValue[] | undefined) ?? [];
      return {
        id: str(record['id'], ''),
        fileId: str(record['fileId'], ''),
        sheet: strOrNull(record['sheet']),
        identitySpace: strOrNull(record['identitySpace']),
        object: str(record['object'], 'CONTACT') as CanonicalObject,
        sourceRecordIdColumn:
          record['sourceRecordIdColumn'] === undefined || record['sourceRecordIdColumn'] === null
            ? null
            : normalizeKeyColumnRef(record['sourceRecordIdColumn']),
        authoritativeExternalIdColumns: externalIds.map(normalizeKeyColumnRef),
        fields: fields.map(normalizeField),
      };
    }),
    associations: associations.map(normalizeAssociation),
    destinationMatching: destinationMatching.map((entry): DestinationMatchConfig => {
      const match = obj(entry);
      return {
        recordMappingId: str(match['recordMappingId'], ''),
        matchAuthority: str(match['matchAuthority'], 'NONE') as MatchAuthority,
        targetField: strOrNull(match['targetField']),
        sourceField: strOrNull(match['sourceField']),
        onMissingMatch: str(match['onMissingMatch'], 'ISOLATE') as MissingMatchPolicy,
        onMatchConflict: str(match['onMatchConflict'], 'ISOLATE') as MatchConflictPolicy,
      };
    }),
    occurrences: occurrences.map((entry): OccurrenceDeclaration => {
      const declaration = obj(entry);
      return {
        files: ((declaration['files'] as JsonValue[] | undefined) ?? []).map((id) => str(id, '')),
        decision: str(declaration['decision'], 'INDEPENDENT') as OccurrenceDecision,
      };
    }),
  };
}

// -------------------------------------------------------- cross-validation

function fail(message: string, remedy: string, details: JsonObject): never {
  throw new MigrationError('MAPPING_INVALID', message, remedy, details);
}

function requireUnique(ids: readonly string[], what: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      fail(`duplicate ${what} id "${id}"`, `Give every ${what} a unique id.`, { id });
    }
    seen.add(id);
  }
}

function validateColumnRef(ref: ColumnRef, where: string): void {
  const hasHeader = ref.header !== null;
  const hasIndex = ref.index !== null;
  if (hasHeader === hasIndex) {
    fail(
      `${where} must address a column by exactly one of "header" or "index"`,
      'Set "header" (optionally with "occurrence") or "index", but not both and not neither.',
      { where },
    );
  }
  if (!hasHeader && ref.occurrence !== null) {
    fail(
      `${where} sets "occurrence" without "header"`,
      '"occurrence" disambiguates repeated headers and only applies alongside "header".',
      { where },
    );
  }
}

function crossValidate(config: MigrationConfig, origin: string): void {
  requireUnique(config.files.map((file) => file.id), 'file');
  // A path names one occurrence. Two entries with one path are the same file
  // listed twice, and the file id derived for an occurrence is a function of
  // its path, so the two could not be told apart downstream.
  requireUnique(config.files.map((file) => file.path), 'file path');
  requireUnique(config.records.map((record) => record.id), 'record mapping');
  requireUnique(config.associations.map((association) => association.id), 'association mapping');

  const fileIds = new Set(config.files.map((file) => file.id));
  const recordsById = new Map(config.records.map((record) => [record.id, record]));

  for (const file of config.files) {
    if (file.path.includes('\\')) {
      fail(
        `file "${file.id}" uses a backslash in its path`,
        'Use forward slashes so the configuration behaves identically on every platform.',
        { fileId: file.id, path: file.path },
      );
    }
    if (file.path.startsWith('/') || /^[A-Za-z]:/u.test(file.path) || file.path.split('/').includes('..')) {
      fail(
        `file "${file.id}" path must stay inside the input bundle`,
        'Use a relative path with no leading slash, drive letter or ".." segment.',
        { fileId: file.id, path: file.path },
      );
    }
    if (file.format === 'CSV' && file.sheets !== null) {
      fail(
        `file "${file.id}" declares sheets but is a CSV`,
        'Remove "sheets", or change the format to XLSX.',
        { fileId: file.id },
      );
    }
    if (file.format === 'XLSX' && file.delimiter !== null) {
      fail(
        `file "${file.id}" declares a delimiter but is a workbook`,
        'Remove "delimiter", or change the format to CSV.',
        { fileId: file.id },
      );
    }
  }

  const covered = new Map<string, number>();
  config.occurrences.forEach((declaration, index) => {
    const named = new Set<string>();
    for (const id of declaration.files) {
      if (!fileIds.has(id)) {
        fail(
          `occurrences[${String(index)}] names file "${id}", which the plan does not list`,
          'List only file ids that appear under "files".',
          { occurrence: index, fileId: id },
        );
      }
      if (named.has(id)) {
        fail(
          `occurrences[${String(index)}] names file "${id}" twice`,
          'Name each file once in a decision.',
          { occurrence: index, fileId: id },
        );
      }
      named.add(id);
      const other = covered.get(id);
      if (other !== undefined) {
        fail(
          `file "${id}" is covered by occurrences[${String(other)}] and occurrences[${String(index)}]`,
          'A file takes part in at most one occurrence decision. Merge the two decisions into one list.',
          { fileId: id, occurrences: [other, index] },
        );
      }
      covered.set(id, index);
    }
  });

  if (
    config.policies.mergeFieldConflict === 'PREFER_SURVIVOR' &&
    config.policies.mergeFieldConflictJustification === null
  ) {
    fail(
      'policy mergeFieldConflict=PREFER_SURVIVOR requires a written justification',
      'Set policies.mergeFieldConflictJustification to the provenance reason that makes the surviving row authoritative, or use ISOLATE_RECORD.',
      {},
    );
  }

  // What an import mode may match on.
  //
  // The engine used to refuse UPDATE_ONLY and UPSERT outright, because the only
  // key it wrote into an import file was its own migration key, and that key is
  // not stable across exports: a later export can bring a row carrying a smaller
  // identity key, fill an identifier cell that was empty, or add an unrelated
  // row and change the bundle id. Matching on it would create a record the
  // second time instead of updating it — the duplicate this engine exists to
  // prevent, introduced by the engine itself.
  //
  // The refusal was the right answer to the wrong question. The key was never
  // the thing to fix: a Kauro-owned identifier should not be destination match
  // authority at all, however stable it is, because using one means asking the
  // agency to carry a Kauro field inside their own instance. So matching is
  // declared here instead, against a field the instance already has, and the
  // declaration is checked against the captured target contract before anything
  // is written. What follows is the part that can be decided from the
  // configuration alone; whether the named field exists and carries the right
  // attributes is decided against the contract at run time.
  const matchByMapping = new Map<string, DestinationMatchConfig>();
  for (const match of config.destinationMatching) {
    if (matchByMapping.has(match.recordMappingId)) {
      fail(
        `record mapping "${match.recordMappingId}" has more than one destinationMatching entry`,
        'A record mapping is matched one way. Remove the duplicate declaration.',
        { recordMappingId: match.recordMappingId },
      );
    }
    matchByMapping.set(match.recordMappingId, match);
    if (!config.records.some((record) => record.id === match.recordMappingId)) {
      fail(
        `destinationMatching names record mapping "${match.recordMappingId}", which does not exist`,
        'Remove the declaration or correct the recordMappingId.',
        { recordMappingId: match.recordMappingId },
      );
    }
  }

  if (config.target.importMode === 'CREATE_ONLY') {
    for (const match of config.destinationMatching) {
      if (match.matchAuthority !== 'NONE') {
        fail(
          `record mapping "${match.recordMappingId}" declares match authority ${match.matchAuthority} under CREATE_ONLY`,
          'A create-only import never matches an existing record, so declaring what it would match on claims behaviour that does not happen. Remove the declaration, or use UPDATE_ONLY or UPSERT.',
          { recordMappingId: match.recordMappingId, importMode: config.target.importMode },
        );
      }
    }
  } else {
    if (config.target.mode === 'CLEAN_ONLY') {
      fail(
        `CLEAN_ONLY cannot run in ${config.target.importMode}`,
        'CLEAN_ONLY has no destination instance, so there is no existing record to match. Use CREATE_ONLY, or choose HUBSPOT or SALESFORCE.',
        { mode: config.target.mode, importMode: config.target.importMode },
      );
    }
    for (const record of config.records) {
      const match = matchByMapping.get(record.id);
      if (match === undefined || match.matchAuthority === 'NONE') {
        fail(
          `record mapping "${record.id}" is delivered in ${config.target.importMode} but declares no destination match authority`,
          'Add a destinationMatching entry naming what the destination matches on, which of its fields carries the value, which mapped field supplies it, and what happens when the match finds nothing or finds two.',
          { recordMappingId: record.id, importMode: config.target.importMode },
        );
      }
      if (match.sourceField === null) {
        fail(
          `record mapping "${record.id}" declares ${match.matchAuthority} but names no source field`,
          'Set destinationMatching.sourceField to the mapped field whose value the destination should match on.',
          { recordMappingId: record.id, matchAuthority: match.matchAuthority },
        );
      }
      const mapped = record.fields.some((field) => field.destinationField === match.sourceField);
      if (!mapped) {
        fail(
          `record mapping "${record.id}" matches on source field "${match.sourceField}", which it does not map`,
          'The match value has to come from a field this mapping actually delivers. Map the column, or name a field that is mapped.',
          { recordMappingId: record.id, sourceField: match.sourceField },
        );
      }
      if (match.matchAuthority !== 'RECORD_ID' && match.targetField === null) {
        fail(
          `record mapping "${record.id}" declares ${match.matchAuthority} but names no destination field`,
          'Set destinationMatching.targetField to the name the destination instance answers to. It must already exist there; Kauro does not create it.',
          { recordMappingId: record.id, matchAuthority: match.matchAuthority },
        );
      }
      if (match.onMissingMatch === 'CREATE' && config.target.importMode !== 'UPSERT') {
        fail(
          `record mapping "${record.id}" says to create on a missing match, but ${config.target.importMode} does not create`,
          'Use UPSERT if an unmatched row should be created, or set onMissingMatch to ISOLATE or FAIL_RUN.',
          { recordMappingId: record.id, importMode: config.target.importMode, onMissingMatch: match.onMissingMatch },
        );
      }
    }
  }

  if (config.policies.destinationKeyConflict === 'DELIVER_WITH_ALTERNATE_KEY') {
    // The policy promised something the engine never did. A destination key
    // conflict is by definition a collision on a field the destination matches
    // records by, so delivering both records makes the destination merge them —
    // the silent merge the whole report exists to prevent. Nothing here assigns
    // an alternate key, and a name is not an implementation.
    fail(
      'policy destinationKeyConflict=DELIVER_WITH_ALTERNATE_KEY is not implemented and cannot be made safe by this engine',
      'A destination key conflict is a collision on a field the destination matches on, so delivering both records merges them at the destination. Use ISOLATE and resolve the collision in the source.',
      { mode: config.target.mode },
    );
  }

  // A source row belongs to exactly one record mapping. Two mappings over the
  // same sheet would give one row two records, and only one of them could be
  // reported against that row.
  const sheetOwners = new Map<string, string>();
  for (const record of config.records) {
    const key = `${record.fileId}|${record.sheet ?? ''}`;
    const owner = sheetOwners.get(key);
    if (owner !== undefined) {
      fail(
        `record mappings "${owner}" and "${record.id}" both cover ${record.fileId}${record.sheet === null ? '' : `!${record.sheet}`}`,
        'A sheet may feed at most one record mapping. Split the sheet into separate files, or map the second object from its own sheet.',
        { first: owner, second: record.id, fileId: record.fileId, sheet: record.sheet },
      );
    }
    sheetOwners.set(key, record.id);
  }

  // "No sheet named" and "this sheet named" are different keys above but can be
  // the same physical sheet: a mapping with no sheet resolves to the only sheet
  // of a single-sheet file. Two mappings written that way passed the guard and
  // then failed much later as a reconciliation error that blamed the engine for
  // the operator's configuration.
  const unnamedByFile = new Map<string, string>();
  const namedByFile = new Map<string, string>();
  for (const record of config.records) {
    if (record.sheet === null) unnamedByFile.set(record.fileId, record.id);
    else if (!namedByFile.has(record.fileId)) namedByFile.set(record.fileId, record.id);
  }
  for (const [fileId, unnamed] of unnamedByFile) {
    const named = namedByFile.get(fileId);
    if (named === undefined) continue;
    fail(
      `record mappings "${unnamed}" and "${named}" both cover file "${fileId}", one by name and one without one`,
      'A mapping with no sheet takes the only sheet of a single-sheet file, which may be the sheet the other mapping names. Name the sheet in both mappings so the configuration says which sheet each one reads.',
      { first: unnamed, second: named, fileId },
    );
  }

  // An identity space is shared on purpose or not at all. A mapping that
  // declares the id of another mapping that did not declare its own has landed
  // on that mapping's implicit default, which merges two id sequences by
  // accident rather than by intent.
  const declaredSpaces = new Map<string, string>();
  for (const record of config.records) {
    if (record.identitySpace !== null) declaredSpaces.set(record.id, record.identitySpace);
  }
  for (const record of config.records) {
    const space = record.identitySpace;
    if (space === null || space === record.id) continue;
    const other = config.records.find((item) => item.id === space);
    if (other === undefined || declaredSpaces.has(other.id)) continue;
    fail(
      `record mapping "${record.id}" declares identitySpace "${space}", which is the implicit identity space of record mapping "${other.id}"`,
      'Sharing an identity space has to be deliberate on both sides. Declare the same identitySpace on both mappings, or choose a name that is not another mapping id.',
      { recordMappingId: record.id, identitySpace: space, collidesWith: other.id },
    );
  }

  for (const record of config.records) {
    if (!fileIds.has(record.fileId)) {
      fail(
        `record mapping "${record.id}" refers to unknown file "${record.fileId}"`,
        'Add the file to "files" or correct the fileId.',
        { recordMappingId: record.id, fileId: record.fileId },
      );
    }
    if (record.sourceRecordIdColumn !== null) {
      validateColumnRef(record.sourceRecordIdColumn, `record mapping "${record.id}" sourceRecordIdColumn`);
    }
    record.authoritativeExternalIdColumns.forEach((ref, index) => {
      validateColumnRef(ref, `record mapping "${record.id}" authoritativeExternalIdColumns[${String(index)}]`);
    });

    const destinations = new Set<string>();
    for (const field of record.fields) {
      const where = `record mapping "${record.id}" field "${field.destinationField}"`;
      validateColumnRef(field.column, `${where} column`);
      assertFieldBelongsToObject(field.destinationField, record.object, where);

      if (destinations.has(field.destinationField)) {
        fail(
          `${where} is mapped more than once`,
          'Two source columns cannot write the same destination field. Map one of them to a different field.',
          { recordMappingId: record.id, destinationField: field.destinationField },
        );
      }
      destinations.add(field.destinationField);

      validateOptionApplicability(field, where);
      validateTimezone(field, where);
      validateValueMap(field, where);

      if (field.options.clearWhenMatches.length > 0 && !field.options.destructiveAuthorization) {
        fail(
          `${where} lists clearWhenMatches without destructiveAuthorization`,
          'Erasing a non-empty source value requires options.destructiveAuthorization to be set to true.',
          { recordMappingId: record.id, destinationField: field.destinationField },
        );
      }
      if (field.options.destructiveAuthorization && field.options.clearWhenMatches.length === 0) {
        fail(
          `${where} sets destructiveAuthorization but authorizes no values`,
          'List the exact values in options.clearWhenMatches, or remove destructiveAuthorization.',
          { recordMappingId: record.id, destinationField: field.destinationField },
        );
      }
      if (field.semanticsClass !== null && field.semanticsClass !== fieldSemanticsClass(field.destinationField) && fieldSemanticsClass(field.destinationField) === 'CONSENT') {
        fail(
          `${where} declares semanticsClass "${field.semanticsClass}" on a field the canonical model defines as CONSENT`,
          'Remove the declaration. A declaration may raise protection, never lower it; otherwise the consent guard could be switched off from the configuration file.',
          { recordMappingId: record.id, destinationField: field.destinationField },
        );
      }
      // Mapping a consent field is not resolving one by policy. Refusing the
      // configuration outright meant an export with an ordinary Unsubscribed
      // column could not use PREFER_SURVIVOR at all, even with no duplicates in
      // it — and it made the runtime guard unreachable, so the rule that
      // actually protects consent was never exercised. That guard is in
      // `mergeValues`: a CONSENT field is never resolved by the policy,
      // whatever the policy says, and the record is set aside instead.
      if (field.options.extensionDestinationField !== null) {
        const extension = field.options.extensionDestinationField;
        if (isCanonicalField(extension) || isCustomField(extension)) {
          assertFieldBelongsToObject(extension, record.object, `${where} extensionDestinationField`);
        } else {
          fail(
            `${where} names an unknown extensionDestinationField "${extension}"`,
            'Use a canonical field name or a "custom:" field.',
            { recordMappingId: record.id, extensionDestinationField: extension },
          );
        }
      }
    }
  }

  for (const record of config.records) {
    const mapped = new Set(record.fields.map((field) => field.destinationField));
    for (const field of record.fields) {
      const extension = field.options.extensionDestinationField;
      if (extension === null) continue;
      if (extension === field.destinationField) {
        fail(
          `record mapping "${record.id}" field "${field.destinationField}" writes its extension into itself`,
          'Choose a different destination for the extension; writing it into the same field would replace the number with the extension.',
          { recordMappingId: record.id, destinationField: field.destinationField },
        );
      }
      const otherExtension = record.fields.find(
        (other) => other !== field && other.options.extensionDestinationField === extension,
      );
      if (otherExtension !== undefined) {
        fail(
          `record mapping "${record.id}" fields "${field.destinationField}" and "${otherExtension.destinationField}" both write their extension into "${extension}"`,
          'Two sources cannot write one destination field. One extension would overwrite the other while the change log recorded both.',
          { recordMappingId: record.id, extensionDestinationField: extension },
        );
      }
      if (mapped.has(extension)) {
        fail(
          `record mapping "${record.id}" field "${field.destinationField}" writes its extension into "${extension}", which another column already maps`,
          'Two sources cannot write one destination field. Map the extension somewhere else, or remove the other mapping.',
          { recordMappingId: record.id, destinationField: field.destinationField, extensionDestinationField: extension },
        );
      }
    }
  }

  for (const association of config.associations) {
    const shape = relationshipShape(association.relationshipType);
    if (association.kind === 'COLUMN_REFERENCE') {
      const owner = recordsById.get(association.recordMappingId);
      const target = recordsById.get(association.targetRecordMappingId);
      requireRecord(owner, association.id, association.recordMappingId);
      requireRecord(target, association.id, association.targetRecordMappingId);
      validateColumnRef(association.keyColumn, `association "${association.id}" keyColumn`);
      if (association.targetMatchKey === 'COLUMN') {
        if (association.targetMatchColumn === null) {
          fail(
            `association "${association.id}" uses targetMatchKey=COLUMN without targetMatchColumn`,
            'Name the column on the target sheet that the key value should match.',
            { associationId: association.id },
          );
        }
        validateColumnRef(association.targetMatchColumn, `association "${association.id}" targetMatchColumn`);
      } else if (association.targetMatchColumn !== null) {
        fail(
          `association "${association.id}" sets targetMatchColumn but matches on SOURCE_RECORD_ID`,
          'Remove targetMatchColumn, or set targetMatchKey to COLUMN.',
          { associationId: association.id },
        );
      } else if (target !== undefined && target.sourceRecordIdColumn === null) {
        fail(
          `association "${association.id}" matches the source record id of "${association.targetRecordMappingId}", which declares none`,
          'Add sourceRecordIdColumn to the target record mapping, or match on a named column.',
          { associationId: association.id },
        );
      }
      const ownerIsFrom = association.ownerSide === 'FROM';
      assertShape(
        association.id,
        shape.from,
        ownerIsFrom ? owner?.object : target?.object,
        shape.to,
        ownerIsFrom ? target?.object : owner?.object,
      );
    } else {
      if (!fileIds.has(association.fileId)) {
        fail(
          `association "${association.id}" refers to unknown file "${association.fileId}"`,
          'Add the file to "files" or correct the fileId.',
          { associationId: association.id, fileId: association.fileId },
        );
      }
      const from = recordsById.get(association.fromRecordMappingId);
      const to = recordsById.get(association.toRecordMappingId);
      requireRecord(from, association.id, association.fromRecordMappingId);
      requireRecord(to, association.id, association.toRecordMappingId);
      validateColumnRef(association.fromKeyColumn, `association "${association.id}" fromKeyColumn`);
      validateColumnRef(association.toKeyColumn, `association "${association.id}" toKeyColumn`);
      if (association.labelColumn !== null) {
        validateColumnRef(association.labelColumn, `association "${association.id}" labelColumn`);
      }
      for (const [side, record] of [['from', from], ['to', to]] as const) {
        if (record !== undefined && record.sourceRecordIdColumn === null) {
          fail(
            `association "${association.id}" matches the source record id of "${record.id}" on the ${side} side, which declares none`,
            'Edge files match endpoints by source record id, so both record mappings must declare sourceRecordIdColumn.',
            { associationId: association.id, recordMappingId: record.id },
          );
        }
      }
      assertShape(association.id, shape.from, from?.object, shape.to, to?.object);
    }
  }

  if (config.records.length === 0 && config.associations.length === 0) {
    fail(
      `${origin} maps no records and no associations`,
      'Declare at least one record mapping so the run produces something.',
      { origin },
    );
  }
}

function requireRecord(
  record: RecordMappingConfig | undefined,
  associationId: string,
  recordMappingId: string,
): void {
  if (record === undefined) {
    fail(
      `association "${associationId}" refers to unknown record mapping "${recordMappingId}"`,
      'Add the record mapping to "records" or correct the reference.',
      { associationId, recordMappingId },
    );
  }
}

function assertShape(
  associationId: string,
  expectedFrom: CanonicalObject,
  actualFrom: CanonicalObject | undefined,
  expectedTo: CanonicalObject,
  actualTo: CanonicalObject | undefined,
): void {
  if (actualFrom !== undefined && actualFrom !== expectedFrom) {
    fail(
      `association "${associationId}" starts at a ${actualFrom} but its relationship type starts at a ${expectedFrom}`,
      'Choose a relationship type whose endpoints match the record mappings.',
      { associationId, expected: expectedFrom, actual: actualFrom },
    );
  }
  if (actualTo !== undefined && actualTo !== expectedTo) {
    fail(
      `association "${associationId}" ends at a ${actualTo} but its relationship type ends at a ${expectedTo}`,
      'Choose a relationship type whose endpoints match the record mappings.',
      { associationId, expected: expectedTo, actual: actualTo },
    );
  }
}

/**
 * A declared zone is a plan decision, so its faults are the plan's.
 *
 * It excludes a fixed offset (two answers to one question), and it is refused
 * here, at load, when the runtime's tzdata is not the release the plan was
 * declared against.
 */
function validateTimezone(field: FieldMappingConfig, where: string): void {
  const timezone = field.options.timezone;
  if (timezone === null) return;
  if (field.options.timezoneOffset !== null) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `${where} declares both timezone and timezoneOffset`,
      'Declare one. timezoneOffset is a fixed offset for every value; timezone is a zone with its own daylight-saving rules.',
      { where, option: 'timezoneOffset' },
    );
  }
  assertTimezoneUsable(timezone, where);
}

function validateOptionApplicability(field: FieldMappingConfig, where: string): void {
  const options = field.options as unknown as Record<string, unknown>;
  for (const [option, applicable] of Object.entries(OPTION_APPLICABILITY)) {
    if (applicable.includes(field.semanticType)) continue;
    const value = options[option];
    const defaulted = (DEFAULT_FIELD_OPTIONS as unknown as Record<string, unknown>)[option];
    if (isExplicitlySet(value, defaulted)) {
      fail(
        `${where} sets option "${option}", which only applies to ${applicable.join(', ')}`,
        `Remove "${option}" or change the semanticType.`,
        { where, option, semanticType: field.semanticType },
      );
    }
  }
  if (field.semanticType === 'ENUM' && field.options.allowedValues === null) {
    fail(
      `${where} is an ENUM without allowedValues`,
      'List the allowed options so unexpected values can be reported rather than accepted silently.',
      { where },
    );
  }
}

/**
 * A value map has to be unambiguous before the run starts.
 *
 * Two entries whose `from` reaches the same comparison form would make the
 * delivered value depend on which one the engine happened to read first, and
 * the plan never declared an order. They are refused rather than resolved by
 * one. An entry that compares as empty matches nothing a populated cell can
 * hold, so it is refused too rather than sitting in the plan doing nothing.
 */
function validateValueMap(field: FieldMappingConfig, where: string): void {
  const seen = new Map<string, string>();
  for (const entry of field.options.valueMap) {
    const compared = effectiveValueMapFrom(entry.from, field.options);
    if (compared.length === 0) {
      fail(
        `${where} maps from "${entry.from}", which is empty once this field's trimming and normalization are applied`,
        'A mapping needs a source value to match. Remove the entry, or write the value the source file actually holds.',
        { where, from: entry.from },
      );
    }
    const first = seen.get(compared);
    if (first !== undefined) {
      fail(
        `${where} maps both "${first}" and "${entry.from}", which are the same value once this field's trimming and normalization are applied`,
        'Two mappings that compare equal would make the delivered value depend on which one was read first. Keep exactly one of them.',
        { where, first, second: entry.from, comparedAs: compared },
      );
    }
    seen.set(compared, entry.from);
  }
}

function isExplicitlySet(value: unknown, defaulted: unknown): boolean {
  if (Array.isArray(value) && Array.isArray(defaulted)) {
    return JSON.stringify(value) !== JSON.stringify(defaulted);
  }
  return value !== defaulted && value !== null;
}

// ------------------------------------------------------------- serialization

function columnRefToJson(ref: ColumnRef | null): JsonValue {
  if (ref === null) return null;
  return { header: ref.header, occurrence: ref.occurrence, index: ref.index };
}

function keyColumnRefToJson(ref: KeyColumnRef | null): JsonValue {
  if (ref === null) return null;
  return {
    header: ref.header,
    occurrence: ref.occurrence,
    index: ref.index,
    identityNormalization:
      ref.identityNormalization === null
        ? null
        : { trim: ref.identityNormalization.trim, unicode: ref.identityNormalization.unicode },
  };
}

export function configToJson(config: MigrationConfig): JsonObject {
  return {
    configVersion: config.configVersion,
    source: { ...config.source },
    target: { ...config.target },
    localeEvidence: { ...config.localeEvidence },
    limits: { ...config.limits },
    policies: { ...config.policies },
    files: config.files.map((file) => ({ ...file, sheets: file.sheets === null ? null : [...file.sheets] })),
    records: config.records.map((record) => ({
      id: record.id,
      fileId: record.fileId,
      sheet: record.sheet,
      identitySpace: record.identitySpace,
      object: record.object,
      sourceRecordIdColumn: keyColumnRefToJson(record.sourceRecordIdColumn),
      authoritativeExternalIdColumns: record.authoritativeExternalIdColumns.map((ref) => keyColumnRefToJson(ref)),
      fields: record.fields.map((field) => ({
        column: columnRefToJson(field.column),
        destinationField: field.destinationField,
        semanticType: field.semanticType,
        semanticsClass: field.semanticsClass,
        required: field.required,
        onAmbiguous: field.onAmbiguous,
        onInvalid: field.onInvalid,
        options: {
          ...field.options,
          valueMap: field.options.valueMap.map((entry) => ({ from: entry.from, to: entry.to })),
          phoneCountryColumn: columnRefToJson(field.options.phoneCountryColumn),
          timezone:
            field.options.timezone === null
              ? null
              : {
                  zone: field.options.timezone.zone,
                  tzdata: field.options.timezone.tzdata,
                  overlap: field.options.timezone.overlap,
                },
          trueValues: [...field.options.trueValues],
          falseValues: [...field.options.falseValues],
          allowedValues: field.options.allowedValues === null ? null : [...field.options.allowedValues],
          clearWhenMatches: [...field.options.clearWhenMatches],
        },
      })),
    })),
    associations: config.associations.map((association) =>
      association.kind === 'EDGE_FILE'
        ? {
            id: association.id,
            kind: association.kind,
            fileId: association.fileId,
            sheet: association.sheet,
            relationshipType: association.relationshipType,
            fromRecordMappingId: association.fromRecordMappingId,
            fromKeyColumn: columnRefToJson(association.fromKeyColumn),
            toRecordMappingId: association.toRecordMappingId,
            toKeyColumn: columnRefToJson(association.toKeyColumn),
            labelColumn: columnRefToJson(association.labelColumn),
            label: association.label,
          }
        : {
            id: association.id,
            kind: association.kind,
            recordMappingId: association.recordMappingId,
            relationshipType: association.relationshipType,
            ownerSide: association.ownerSide,
            keyColumn: columnRefToJson(association.keyColumn),
            targetRecordMappingId: association.targetRecordMappingId,
            targetMatchKey: association.targetMatchKey,
            targetMatchColumn: columnRefToJson(association.targetMatchColumn),
            label: association.label,
          },
    ),
    destinationMatching: config.destinationMatching.map((match) => ({
      recordMappingId: match.recordMappingId,
      matchAuthority: match.matchAuthority,
      targetField: match.targetField,
      sourceField: match.sourceField,
      onMissingMatch: match.onMissingMatch,
      onMatchConflict: match.onMatchConflict,
    })),
    occurrences: config.occurrences.map((declaration) => ({
      files: [...declaration.files],
      decision: declaration.decision,
    })),
  };
}
