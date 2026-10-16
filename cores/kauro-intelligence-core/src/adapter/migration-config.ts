/**
 * `toMigrationConfig` (D3-CFG-2): the whole Migration Core configuration
 * document a CandidateConfiguration stands for, made from its fragments and
 * the profile's own reading of the bundle — product code, the one
 * translation the core and the host both use, so the host validates exactly
 * the document the core produced and the core can name that document's hash.
 *
 * The rules are read off the vendored configuration schema (mapping/
 * config-schema, load-config OPTION_APPLICABILITY), which is the authority:
 * a fragment the frozen schema cannot express is refused as
 * UNSUPPORTED_BY_CORE by its decision ref, never dropped on the way, and a
 * configuration with a refused fragment yields no document at all. Every
 * fragment it does express is named in the coverage with the JSON pointer of
 * its element, so a fragment and what Migration Core consumed of it can be
 * met (D3-CFG-3). Problems are closed codes with the locator, id or
 * destination they are about — never a header, a value or a path.
 */
import { CANONICAL_OBJECTS, MigrationError, RELATIONSHIP_SHAPES, loadConfig } from 'kauro-migration-core';
import type { HashedSourceProfile } from 'kauro-migration-core';

import { digestOf } from '../contracts/canonical.js';
import { DATE_FORMAT_DOMAIN } from '../contracts/proposal.js';
import type { CandidateConfiguration, ConfigColumnRef, ConfigFragmentField, FragmentKind } from '../ports/ports.js';

/** A Migration Core configuration document: JSON, as its loader reads it. */
export type MigrationConfigDocument = Readonly<Record<string, unknown>>;

/** Where one fragment of the configuration is in the document. */
export interface FragmentPointer {
  readonly kind: FragmentKind;
  /** The fragment's position among the configuration's fragments of its kind. */
  readonly index: number;
  readonly decisionRef: string;
  readonly fragmentHash: string;
  /** The JSON pointer of the fragment's element; null for a column fragment, which Migration Core preserves without one. */
  readonly pointer: string | null;
}

/** A fragment the frozen schema cannot take, by its decision ref, with the problem. */
export interface RefusedFragment {
  readonly kind: FragmentKind;
  readonly index: number;
  readonly decisionRef: string;
  readonly problem: string;
}

export interface MigrationConfigTranslation {
  /** The whole document, or null when a fragment was refused: a configuration with a refused fragment is not run at all. */
  readonly document: MigrationConfigDocument | null;
  /** One pointer per fragment the document expresses. */
  readonly coverage: readonly FragmentPointer[];
  readonly refused: readonly RefusedFragment[];
  /** Every problem, refused fragments' and the configuration's own; empty exactly when the document is whole. */
  readonly problems: readonly string[];
}

/** The source system every document names; the namespace scoping source record ids is the profiled bundle's (open question: a project-declared scope, B08). */
export const MIGRATION_SOURCE_SYSTEM = 'kauro';

/** A create-only import matches nothing at the destination (plan, open question 2). */
export const MIGRATION_IMPORT_MODE = 'CREATE_ONLY';

/** Migration Core's identifier grammar for ids of files, record mappings and associations. */
const MIGRATION_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const REGION = /^[A-Z]{2}$/u;
const DECIMAL = /^[.,]$/u;

type Json = Record<string, unknown>;

/**
 * How one field fragment's primitive becomes Migration Core's field
 * options, or why the frozen configuration schema cannot express it. Every
 * primitive of the proposal catalogue is named here.
 */
export function optionsOfPrimitive(field: ConfigFragmentField): { readonly options: Json } | { readonly problem: string } {
  const params = field.typedTransformParams ?? {};
  const unsupported = (why: string): { readonly problem: string } => ({ problem: `UNSUPPORTED_BY_CORE:${String(field.transformPrimitive)}:${why}` });
  // Configuration schema 3.0.0 (MC D67): whitespace is a value, and a field trims only when its options say so. Decided per
  // primitive (D4-MC3-1): a typed parse trims, because padding is not data there and Migration Core records the trim in its
  // evidence (TRANSFORM_WHITESPACE_TRIMMED); PRESERVE_AS_IS and no primitive deliver the cell as written.
  const TRIM = { trim: true } as const;
  switch (field.transformPrimitive) {
    case null:
    case 'PRESERVE_AS_IS':
      return { options: {} };
    case 'TRIM_WHITESPACE':
      return { options: { ...TRIM } };
    case 'NORMALISE_EMAIL_CASE':
      // The engine lowercases the domain and never the local part; that is the whole of what this primitive may mean.
      return field.semanticType === 'EMAIL' ? { options: { ...TRIM, lowercaseDomain: true } } : unsupported('only for EMAIL');
    case 'PARSE_PHONE_E164':
      return field.semanticType === 'PHONE' && REGION.test(params['defaultRegion'] ?? '') ? { options: { ...TRIM, phoneCountry: params['defaultRegion'] } } : unsupported('needs PHONE and defaultRegion');
    case 'NORMALISE_NUMBER':
      return field.semanticType === 'NUMBER' && DECIMAL.test(params['decimalSeparator'] ?? '') ? { options: { ...TRIM, decimalSeparator: params['decimalSeparator'], thousandsSeparator: 'NONE' } } : unsupported('needs NUMBER and decimalSeparator');
    case 'NORMALISE_BOOLEAN':
      return field.semanticType === 'BOOLEAN' ? { options: { ...TRIM } } : unsupported('only for BOOLEAN');
    case 'PARSE_DATE_ISO':
      // A zone needs the tzdata release it was planned against (MC D68); the proposal carries no such release, so a zone is refused, never written without it.
      if (params['timezone'] !== undefined) return unsupported('a DATETIME zone needs its tzdata release (D68)');
      // The declared format of the column, one of the schema's own DATE_FORMATS (D3-CAP-04).
      return (field.semanticType === 'DATE' || field.semanticType === 'DATETIME') && (DATE_FORMAT_DOMAIN as readonly string[]).includes(params['dateFormat'] ?? '') ? { options: { ...TRIM, dateFormat: params['dateFormat'] } } : unsupported('needs DATE or DATETIME and a dateFormat of the schema');
    case 'MAP_ENUM_VALUE':
      // A value map is the field's valueMap, whose `from` is the host's summary of the column and never a parameter (D3-CAP-05): as a primitive it expresses nothing.
      return unsupported('a value map is the field valueMap, not a primitive');
    case 'CLEAR_VALUE':
      return unsupported('clearing needs destructiveAuthorization the agency never gave');
    default:
      return unsupported('unknown primitive');
  }
}

/**
 * The Migration Core field element a field fragment is, at the column index
 * its locator names: the destination, the semantic type, required, the value
 * policies and every option — the primitive's, the value map, the allowed
 * values — or why the frozen schema cannot take it.
 */
export function fieldElementOf(field: ConfigFragmentField, columnIndex: number): { readonly element: Json } | { readonly problem: string } {
  const translated = optionsOfPrimitive(field);
  if ('problem' in translated) return translated;
  // An ENUM destination carries the contract's options as the frozen schema's allowedValues; an ENUM without them is refused by the engine, never accepted silently.
  if (field.semanticType === 'ENUM' && (field.allowedValues === undefined || field.allowedValues.length === 0)) return { problem: `ENUM_WITHOUT_ALLOWED_VALUES:${field.destinationField}` };
  if (field.allowedValues !== undefined && field.semanticType !== 'ENUM') return { problem: `UNSUPPORTED_BY_CORE:ALLOWED_VALUES:only for ENUM:${field.destinationField}` };
  const valueMap = [...((translated.options['valueMap'] as { from: string; to: string }[] | undefined) ?? []), ...(field.valueMap ?? []).map((entry) => ({ from: entry.from, to: entry.to }))];
  if (valueMap.length > 0 && !(field.semanticType === 'ENUM' || field.semanticType === 'TEXT')) return { problem: `UNSUPPORTED_BY_CORE:VALUE_MAP:only for ENUM or TEXT:${field.destinationField}` };
  if (valueMap.some((entry) => entry.from.trim() === '' || (field.semanticType === 'ENUM' && !(field.allowedValues ?? []).includes(entry.to))) || new Set(valueMap.map((entry) => entry.from)).size !== valueMap.length) return { problem: `UNSUPPORTED_BY_CORE:VALUE_MAP:an empty or repeated from, or a to outside the allowed values:${field.destinationField}` };
  const options: Json = { ...translated.options, ...(valueMap.length > 0 ? { valueMap } : {}), ...(field.semanticType === 'ENUM' && field.allowedValues !== undefined ? { allowedValues: [...field.allowedValues] } : {}) };
  return { element: { column: { index: columnIndex }, destinationField: field.destinationField, semanticType: field.semanticType, required: field.required, onInvalid: field.onInvalid, onAmbiguous: field.onAmbiguous, ...(Object.keys(options).length > 0 ? { options } : {}) } };
}

/** The profile's columns by locator, with the file and index each sits at and the header as Migration Core read it (headerRaw): a field names its column by that raw header, compared raw to raw (D4-HDR-1). */
function columnsOf(profile: HashedSourceProfile): ReadonlyMap<string, { readonly fileId: string; readonly filePath: string; readonly columnIndex: number; readonly header: string }> {
  const columns = new Map<string, { fileId: string; filePath: string; columnIndex: number; header: string }>();
  for (const file of profile.profile.files) for (const sheet of file.sheets) for (const column of sheet.columns) columns.set(column.columnLocatorId, { fileId: file.fileId, filePath: file.path, columnIndex: column.columnIndex, header: column.headerRaw ?? '' });
  return columns;
}

/**
 * The whole Migration Core document of a configuration, from its fragments
 * and the profile's own reading of the bundle: the reading (encoding,
 * limits, row policies, files) exactly as the profile recorded it, so the
 * run accepts the profile; one record mapping per file with the object and
 * the identity the fragments name; every field by the physical index of its
 * column; every association; and a pointer for each fragment.
 */
export function toMigrationConfig(configuration: CandidateConfiguration, profile: HashedSourceProfile): MigrationConfigTranslation {
  const refused: RefusedFragment[] = [];
  const problems: string[] = [];
  const coverage: FragmentPointer[] = [];
  const refuse = (kind: FragmentKind, index: number, decisionRef: string, problem: string): void => {
    refused.push({ kind, index, decisionRef, problem });
    problems.push(problem);
  };
  const columns = columnsOf(profile);
  const filesById = new Map(profile.profile.files.map((file) => [file.fileId, file]));
  /** A column of the named file by its locator; a field's is checked against the header the field names as well. */
  const columnRef = (fileId: string, ref: ConfigColumnRef & { readonly columnHeader?: string }): { readonly index: number } | { readonly problem: string } => {
    const column = columns.get(ref.columnLocator);
    if (column === undefined || column.fileId !== fileId) return { problem: `COLUMN_LOCATOR_UNKNOWN:${ref.columnLocator}` };
    if (ref.columnHeader !== undefined && column.header !== ref.columnHeader) return { problem: `COLUMN_LOCATOR_HEADER_MISMATCH:${ref.columnLocator}` };
    return { index: column.columnIndex };
  };

  // Records: one per file, the object the fragment assigns and the identity it declares.
  const records: { readonly id: string; readonly fileId: string; readonly object: string; readonly declaresRecordId: boolean; readonly element: Json & { fields: Json[] }; readonly pointer: string }[] = [];
  for (const [index, record] of configuration.records.entries()) {
    const file = filesById.get(record.fileId);
    if (file === undefined || file.path !== record.filePath) {
      refuse('RECORD', index, record.decisionRef, `FILE_UNKNOWN:${record.fileId}`);
      continue;
    }
    if (!MIGRATION_IDENTIFIER.test(record.recordId) || !CANONICAL_OBJECTS.includes(record.object as (typeof CANONICAL_OBJECTS)[number])) {
      refuse('RECORD', index, record.decisionRef, `RECORD_MAPPING_INVALID:${record.recordId}`);
      continue;
    }
    // One file is one object in one record mapping; a candidate that splits a file across two is not expressible as one run.
    if (records.some((entry) => entry.fileId === record.fileId) || records.some((entry) => entry.id === record.recordId)) {
      refuse('RECORD', index, record.decisionRef, `MULTIPLE_OBJECTS_FOR_FILE:${record.fileId}`);
      continue;
    }
    const idColumn = record.sourceRecordIdColumn === null ? null : columnRef(record.fileId, record.sourceRecordIdColumn);
    if (idColumn !== null && 'problem' in idColumn) {
      refuse('RECORD', index, record.decisionRef, idColumn.problem);
      continue;
    }
    const externalIds = record.authoritativeExternalIdColumns.map((ref) => columnRef(record.fileId, ref));
    const externalProblem = externalIds.find((entry): entry is { readonly problem: string } => 'problem' in entry);
    if (externalProblem !== undefined) {
      refuse('RECORD', index, record.decisionRef, externalProblem.problem);
      continue;
    }
    const pointer = `/records/${String(records.length)}`;
    records.push({
      id: record.recordId,
      fileId: record.fileId,
      object: record.object,
      declaresRecordId: idColumn !== null,
      element: { id: record.recordId, fileId: record.fileId, sheet: null, identitySpace: record.identitySpace, object: record.object, sourceRecordIdColumn: idColumn === null ? null : { index: idColumn.index }, authoritativeExternalIdColumns: externalIds.map((entry) => ({ index: (entry as { readonly index: number }).index })), fields: [] },
      pointer,
    });
    coverage.push({ kind: 'RECORD', index, decisionRef: record.decisionRef, fragmentHash: record.fragmentHash, pointer });
  }
  const recordOf = (recordId: string): (typeof records)[number] | undefined => records.find((entry) => entry.id === recordId);

  // Fields, under their record mapping, by the physical index of their column.
  const mappedLocators = new Set<string>();
  for (const [index, field] of configuration.fields.entries()) {
    const record = recordOf(field.recordId);
    if (record === undefined) {
      refuse('FIELD', index, field.decisionRef, `RECORD_UNKNOWN:${field.recordId}`);
      continue;
    }
    if (field.fileId !== record.fileId || field.object !== record.object || !field.destinationField.startsWith(`${field.object.toLowerCase()}.`)) {
      refuse('FIELD', index, field.decisionRef, `OBJECT_MISMATCH:${field.destinationField}`);
      continue;
    }
    const column = columnRef(field.fileId, field);
    if ('problem' in column) {
      refuse('FIELD', index, field.decisionRef, column.problem);
      continue;
    }
    const made = fieldElementOf(field, column.index);
    if ('problem' in made) {
      refuse('FIELD', index, field.decisionRef, made.problem);
      continue;
    }
    if (record.element.fields.some((entry) => entry['destinationField'] === field.destinationField)) {
      refuse('FIELD', index, field.decisionRef, `DUPLICATE_DESTINATION:${field.recordId}:${field.destinationField}`);
      continue;
    }
    const pointer = `${record.pointer}/fields/${String(record.element.fields.length)}`;
    record.element.fields.push(made.element);
    mappedLocators.add(field.columnLocator);
    coverage.push({ kind: 'FIELD', index, decisionRef: field.decisionRef, fragmentHash: field.fragmentHash, pointer });
  }

  // Associations: a key column of one record mapping naming the source record id of another.
  const associations: Json[] = [];
  for (const [index, association] of configuration.associations.entries()) {
    const owner = recordOf(association.recordId);
    const target = recordOf(association.targetRecordId);
    if (owner === undefined || target === undefined || !MIGRATION_IDENTIFIER.test(association.associationId) || associations.some((entry) => entry['id'] === association.associationId)) {
      refuse('ASSOCIATION', index, association.decisionRef, `ASSOCIATION_INVALID:${association.associationId}`);
      continue;
    }
    const shape = (RELATIONSHIP_SHAPES as Readonly<Record<string, { readonly from: string; readonly to: string } | undefined>>)[association.relationshipType];
    const [from, to] = association.ownerSide === 'FROM' ? [owner.object, target.object] : [target.object, owner.object];
    if (shape === undefined || shape.from !== from || shape.to !== to) {
      refuse('ASSOCIATION', index, association.decisionRef, `RELATIONSHIP_NOT_SUPPORTED:${association.associationId}`);
      continue;
    }
    // Matching on the target's source record id needs the target to declare one.
    if (!target.declaresRecordId) {
      refuse('ASSOCIATION', index, association.decisionRef, `ASSOCIATION_ENDPOINT_UNDECLARED:${association.associationId}`);
      continue;
    }
    const key = columnRef(owner.fileId, association.keyColumn);
    if ('problem' in key) {
      refuse('ASSOCIATION', index, association.decisionRef, key.problem);
      continue;
    }
    const pointer = `/associations/${String(associations.length)}`;
    associations.push({ id: association.associationId, kind: 'COLUMN_REFERENCE', recordMappingId: owner.id, relationshipType: association.relationshipType, ownerSide: association.ownerSide, keyColumn: { index: key.index }, targetRecordMappingId: target.id, targetMatchKey: association.targetMatchKey, targetMatchColumn: null, label: null });
    coverage.push({ kind: 'ASSOCIATION', index, decisionRef: association.decisionRef, fragmentHash: association.fragmentHash, pointer });
  }

  // Preserved columns need no element: Migration Core accounts every unmapped value as a leftover. A column both mapped and preserved is two claims on one column.
  for (const [index, column] of configuration.preservedColumns.entries()) {
    const ref = columnRef(column.fileId, column);
    if ('problem' in ref || filesById.get(column.fileId)?.path !== column.filePath) {
      refuse('PRESERVED_COLUMN', index, column.decisionRef, 'problem' in ref ? ref.problem : `FILE_UNKNOWN:${column.fileId}`);
      continue;
    }
    if (mappedLocators.has(column.columnLocator)) {
      refuse('PRESERVED_COLUMN', index, column.decisionRef, `PRESERVED_COLUMN_IS_MAPPED:${column.columnLocator}`);
      continue;
    }
    coverage.push({ kind: 'PRESERVED_COLUMN', index, decisionRef: column.decisionRef, fragmentHash: column.fragmentHash, pointer: null });
  }
  // The frozen schema has no exclusion: every column no field maps is preserved as a leftover.
  for (const [index, column] of configuration.excludedColumns.entries()) refuse('EXCLUDED_COLUMN', index, column.decisionRef, `UNSUPPORTED_BY_CORE:EXCLUDED_COLUMN:${column.columnLocator}`);

  if (records.length === 0 && associations.length === 0) problems.push('NO_RECORD_MAPPING');
  if (problems.length > 0) return { document: null, coverage: [], refused, problems };

  const reading = profile.profile.readConfig;
  const document: MigrationConfigDocument = {
    configVersion: reading.configVersion,
    source: { system: MIGRATION_SOURCE_SYSTEM, namespace: `kauro-${profile.profile.bundleId}`, encoding: reading.sourceEncoding },
    target: { mode: configuration.mode, importMode: MIGRATION_IMPORT_MODE },
    // The reading the profile was made under, so the run accepts the profile: a different reading is a different dataset.
    limits: { ...reading.limits },
    policies: { rowShapeMismatch: reading.rowShapeMismatch, blankRow: reading.blankRow, formulaCachedValues: reading.formulaCachedValues },
    files: profile.profile.files.map((file) => {
      const read = reading.files.find((entry) => entry.path === file.path);
      return { id: file.fileId, path: file.path, format: read?.format ?? file.format, encoding: read?.encoding ?? null, delimiter: read?.delimiter ?? null, sheets: read?.sheets === undefined || read.sheets === null ? null : [...read.sheets] };
    }),
    records: records.map((entry) => entry.element),
    associations,
  };
  return { document, coverage, refused, problems };
}

/** The member a JSON pointer names, or undefined. */
function at(json: unknown, pointer: string): unknown {
  let current = json;
  for (const segment of pointer.split('/').slice(1)) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment.replace(/~1/gu, '/').replace(/~0/gu, '~')];
  }
  return current;
}

/**
 * The fragment hash of the element at a pointer of a loaded configuration
 * (Migration Core's normalized document): the element as its loader
 * normalized it, bound to its kind — a field to the record mapping it
 * belongs to, a record without its fields. Undefined when nothing is there.
 */
export function elementFragmentHash(kind: 'RECORD' | 'FIELD' | 'ASSOCIATION', loaded: unknown, pointer: string): string | undefined {
  const element = at(loaded, pointer);
  if (element === null || typeof element !== 'object' || Array.isArray(element)) return undefined;
  if (kind === 'RECORD') {
    const { fields, ...record } = element as Json;
    void fields;
    return digestOf({ fragmentKind: 'RECORD', element: record });
  }
  if (kind === 'FIELD') {
    const record = at(loaded, pointer.slice(0, pointer.lastIndexOf('/fields/'))) as Json | undefined;
    if (record === undefined) return undefined;
    return digestOf({ fragmentKind: 'FIELD', recordMappingId: record['id'], element });
  }
  return digestOf({ fragmentKind: 'ASSOCIATION', element });
}

/** The fragment hash of a column fragment, which is no element of the document: its kind, its file and its locator. */
export function columnFragmentHash(kind: 'PRESERVED_COLUMN' | 'EXCLUDED_COLUMN', fileId: string, columnLocator: string): string {
  return digestOf({ fragmentKind: kind, fileId, columnLocator });
}

/** A configuration sealed for the host: every fragment hashed on what Migration Core's loader made of it, the document, its pointers and the loader's hash. */
export interface SealedConfiguration {
  readonly configuration: CandidateConfiguration;
  readonly document: MigrationConfigDocument;
  readonly coverage: readonly FragmentPointer[];
  /** Migration Core's loader hash of the document: the coreConfigHash a receipt about this configuration must name. */
  readonly coreConfigHash: string;
}

/** Equal as Migration Core's loader compares them: a value map is a set of pairs (its loader sorts it), anything else by canonical form. */
function sameOption(key: string, expected: unknown, loaded: unknown): boolean {
  if (key === 'valueMap' && Array.isArray(expected) && Array.isArray(loaded)) {
    const pairs = (list: readonly unknown[]): string[] => list.map((entry) => digestOf(entry)).sort();
    return digestOf(pairs(expected)) === digestOf(pairs(loaded));
  }
  return digestOf(expected ?? null) === digestOf(loaded ?? null);
}

/**
 * Does the element a pointer names stand for the fragment it is the pointer
 * of, whole? A field is compared member by member and option by option with
 * the element the fragment makes at its locator's index, so a translation
 * that drops or alters any of it — not only one that points elsewhere — is a
 * defect, not a coverage.
 */
function elementIsFragment(configuration: CandidateConfiguration, entry: FragmentPointer, element: Json, columns: ReturnType<typeof columnsOf>): boolean {
  /** A loaded column ref (normalized to { header: null, occurrence: null, index }) standing for a fragment's column by its locator. */
  const sameColumn = (loaded: unknown, ref: ConfigColumnRef | null): boolean => {
    if (ref === null) return loaded === null;
    const column = columns.get(ref.columnLocator);
    return column !== undefined && loaded !== null && typeof loaded === 'object' && (loaded as Json)['index'] === column.columnIndex && (loaded as Json)['header'] === null;
  };
  switch (entry.kind) {
    case 'RECORD': {
      const record = configuration.records[entry.index];
      const external = Array.isArray(element['authoritativeExternalIdColumns']) ? (element['authoritativeExternalIdColumns'] as unknown[]) : [];
      return record !== undefined && element['id'] === record.recordId && element['fileId'] === record.fileId && element['object'] === record.object && element['identitySpace'] === record.identitySpace && sameColumn(element['sourceRecordIdColumn'], record.sourceRecordIdColumn) && external.length === record.authoritativeExternalIdColumns.length && record.authoritativeExternalIdColumns.every((ref, index) => sameColumn(external[index], ref));
    }
    case 'FIELD': {
      const field = configuration.fields[entry.index];
      const column = field === undefined ? undefined : columns.get(field.columnLocator);
      if (field === undefined || column === undefined) return false;
      const made = fieldElementOf(field, column.columnIndex);
      if ('problem' in made) return false;
      const loadedOptions = (element['options'] ?? {}) as Json;
      const expectedOptions = (made.element['options'] ?? {}) as Json;
      // The loader normalizes a column ref by index into { header: null, occurrence: null, index }: the index is what is compared.
      const loadedColumn = (element['column'] ?? {}) as Json;
      return loadedColumn['index'] === column.columnIndex && loadedColumn['header'] === null && ['destinationField', 'semanticType', 'required', 'onInvalid', 'onAmbiguous'].every((key) => digestOf(made.element[key]) === digestOf(element[key])) && Object.entries(expectedOptions).every(([key, value]) => sameOption(key, value, loadedOptions[key]));
    }
    case 'ASSOCIATION': {
      const association = configuration.associations[entry.index];
      return association !== undefined && element['id'] === association.associationId && element['kind'] === 'COLUMN_REFERENCE' && element['recordMappingId'] === association.recordId && element['relationshipType'] === association.relationshipType && element['ownerSide'] === association.ownerSide && sameColumn(element['keyColumn'], association.keyColumn) && element['targetRecordMappingId'] === association.targetRecordId && element['targetMatchKey'] === association.targetMatchKey && element['targetMatchColumn'] === null;
    }
    default:
      return false;
  }
}

/**
 * Seals a configuration whose fragments carry their decision refs: the
 * document is made, Migration Core's own loader reads it, and each fragment
 * is stamped with the hash of the element the loader made of it. Every
 * fragment must be expressed exactly once — one that is refused, or that the
 * translation leaves without an element, is named, and nothing is sealed.
 */
export function sealConfiguration(configuration: CandidateConfiguration, profile: HashedSourceProfile): { readonly ok: true; readonly sealed: SealedConfiguration } | { readonly ok: false; readonly problems: readonly string[] } {
  const translation = toMigrationConfig(configuration, profile);
  if (translation.document === null) return { ok: false, problems: translation.refused.length > 0 ? translation.refused.map((entry) => `${entry.problem}@${entry.decisionRef}`) : translation.problems };
  let loaded: { readonly normalizedJson: unknown; readonly configHash: string };
  try {
    loaded = loadConfig(JSON.stringify(translation.document), 'kauro-candidate-configuration.json');
  } catch (error) {
    // The loader's own refusal, by its code: its message may quote a header.
    return { ok: false, problems: [`MIGRATION_CONFIG_REFUSED:${error instanceof MigrationError ? error.code : 'UNKNOWN'}`] };
  }
  const columns = columnsOf(profile);
  const expected: readonly (readonly [FragmentKind, readonly { readonly decisionRef: string }[]])[] = [['RECORD', configuration.records], ['FIELD', configuration.fields], ['ASSOCIATION', configuration.associations], ['PRESERVED_COLUMN', configuration.preservedColumns], ['EXCLUDED_COLUMN', configuration.excludedColumns]];
  const problems: string[] = [];
  const hashes = new Map<string, string>();
  for (const [kind, fragments] of expected) {
    for (const [index, fragment] of fragments.entries()) {
      const entries = translation.coverage.filter((entry) => entry.kind === kind && entry.index === index);
      const entry = entries[0];
      if (entries.length !== 1 || entry === undefined) {
        problems.push(`FRAGMENT_NOT_EXPRESSED:${kind}:${fragment.decisionRef}`);
        continue;
      }
      if (entry.pointer === null) {
        const column = kind === 'PRESERVED_COLUMN' ? configuration.preservedColumns[index] : configuration.excludedColumns[index];
        if ((kind === 'PRESERVED_COLUMN' || kind === 'EXCLUDED_COLUMN') && column !== undefined) hashes.set(`${kind}#${String(index)}`, columnFragmentHash(kind, column.fileId, column.columnLocator));
        else problems.push(`FRAGMENT_NOT_EXPRESSED:${kind}:${fragment.decisionRef}`);
        continue;
      }
      const element = at(loaded.normalizedJson, entry.pointer);
      const hash = kind === 'RECORD' || kind === 'FIELD' || kind === 'ASSOCIATION' ? elementFragmentHash(kind, loaded.normalizedJson, entry.pointer) : undefined;
      if (hash === undefined || element === null || typeof element !== 'object' || !elementIsFragment(configuration, entry, element as Json, columns)) {
        problems.push(`FRAGMENT_NOT_EXPRESSED:${kind}:${fragment.decisionRef}`);
        continue;
      }
      hashes.set(`${kind}#${String(index)}`, hash);
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  const hashOf = (kind: FragmentKind, index: number): string => hashes.get(`${kind}#${String(index)}`) ?? '';
  const stamped: CandidateConfiguration = {
    ...configuration,
    records: configuration.records.map((record, index) => ({ ...record, fragmentHash: hashOf('RECORD', index) })),
    fields: configuration.fields.map((field, index) => ({ ...field, fragmentHash: hashOf('FIELD', index) })),
    associations: configuration.associations.map((association, index) => ({ ...association, fragmentHash: hashOf('ASSOCIATION', index) })),
    preservedColumns: configuration.preservedColumns.map((column, index) => ({ ...column, fragmentHash: hashOf('PRESERVED_COLUMN', index) })),
    excludedColumns: configuration.excludedColumns.map((column, index) => ({ ...column, fragmentHash: hashOf('EXCLUDED_COLUMN', index) })),
  };
  return { ok: true, sealed: { configuration: stamped, document: translation.document, coverage: translation.coverage.map((entry) => ({ ...entry, fragmentHash: hashOf(entry.kind, entry.index) })), coreConfigHash: loaded.configHash } };
}
