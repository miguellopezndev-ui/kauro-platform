import { MigrationError } from '../domain/errors.js';
import type { CanonicalObject, FieldSemanticsClass } from '../domain/canonical.js';
import { effectiveSemanticsClass } from '../domain/canonical.js';
import type { IdentityNormalization, MigrationConfig, RecordMappingConfig } from '../domain/config.js';
import { normalizeIdentityValue } from '../domain/config.js';
import type { ReasonCode } from '../domain/reason-codes.js';
import { isSentinelIdentifier, renderIdentityKey } from '../domain/identity.js';
import { cellAt } from '../domain/source-cell.js';
import type { IngestedFile, IngestedSheet } from '../ingest/sheet.js';
import { resolveColumn } from '../mapping/resolve-columns.js';
import { applyFieldTransform, shouldFlag } from '../transform/apply.js';
import type { ValueIntent } from '../domain/value-intent.js';
import { carriesValue, intentFor, set } from '../domain/value-intent.js';
import type { ChangeEntry, FlagEntry, RowAddress, UnmappedFieldEntry } from '../reconcile/truth.js';
import type { FamilyWriter } from './spool.js';

export interface DraftValue {
  /**
   * What the destination is being asked to do with this field.
   *
   * Not a `string | null`. A field this row says nothing about and a field the
   * plan authorized clearing both have no value, and they are opposite
   * instructions; every stage that reduced them to the same absence lost the
   * clear.
   */
  readonly intent: ValueIntent;
  /**
   * Carried on the value rather than looked up by field name, because a
   * "custom:" field's meaning is declared by the configuration and cannot be
   * recovered from its name.
   */
  readonly semanticsClass: FieldSemanticsClass;
  /**
   * There is no `columnLocatorId`, `columnIndex` or `columnHeader` here, and
   * there were.
   *
   * Which column a value came from is recorded where it is asked for: the same
   * loop that fills this map writes the change, the flag and the unmapped-cell
   * entry, each carrying the column locator, index and header, and those three
   * families are what the package renders the cell-level trail from. Nothing
   * ever read the copy on the draft -- identity resolution reads `intent` and
   * `semanticsClass`, and that is the whole readership of a `DraftValue`.
   *
   * The copy was not free. A draft is spilled twice, once in row order and once
   * re-keyed by the identity component it lands in, so three strings per value
   * per row were written to scratch twice over: the 'drafts' and
   * 'identity-groups' families were 16.9% of everything the run spilled, and
   * this was about a third of both.
   */
}

/** A key that, on its own, proves two rows describe one record. */
export interface ProvingKey {
  readonly key: string;
  readonly kind: 'SOURCE_RECORD_ID' | 'AUTHORITATIVE_EXTERNAL_ID';
  /**
   * The identifier as the source wrote it. Carried only when the key column
   * declared an identity normalization, because only then can two spellings
   * share one key, and the merge that results has to name them.
   */
  readonly sourceValue?: string;
}

export interface DraftRecord {
  readonly recordMappingId: string;
  readonly object: CanonicalObject;
  readonly address: RowAddress;
  readonly sourceSystem: string;
  readonly sourceNamespace: string;
  readonly sourceRecordId: string | null;
  /** The scope inside which `sourceRecordId` means something. Defaults to the record mapping. */
  readonly identitySpace: string;
  /** Namespaced keys that prove identity. Empty when the source carries no authoritative identifier. */
  readonly identityKeys: readonly ProvingKey[];
  readonly values: ReadonlyMap<string, DraftValue>;
  readonly isolation: {
    readonly reasonCode: ReasonCode;
    readonly detail: string;
    readonly field?: string | null;
  } | null;
}

export interface BuildRecordsResult {
  /** How many drafts were written. The drafts themselves went to the family. */
  readonly draftCount: number;
}

/**
 * Where the three cell-scale families go as they are made.
 *
 * They are the largest thing this stage produces — one entry per changed cell,
 * per flagged cell, per unmapped populated cell — and they were returned as
 * arrays, which meant the caller held all three in full before it had even
 * begun to sort them. Handing the writers down means a cell is written down and
 * released in the same breath.
 */
/** Where a draft goes as soon as the row that produced it has been read. */
export interface DraftSink {
  add(draft: DraftRecord): void;
}

export interface RecordFamilyWriters {
  readonly changes: FamilyWriter<ChangeEntry>;
  readonly flags: FamilyWriter<FlagEntry>;
  readonly unmappedFields: FamilyWriter<UnmappedFieldEntry>;
  readonly drafts: DraftSink;
}

export function rowAddress(file: IngestedFile, sheet: IngestedSheet, locator: {
  rowNumberSource: number;
  rowLocatorId: string;
  rowHash: string;
}): RowAddress {
  return {
    bundleId: file.file.bundleId,
    fileId: file.file.fileId,
    fileSha256: file.file.fileSha256,
    filePath: file.file.filePathRelative,
    sheetId: sheet.sheet.sheetId,
    sheetName: sheet.sheet.sheetName,
    rowNumberSource: locator.rowNumberSource,
    rowLocatorId: locator.rowLocatorId,
    rowHash: locator.rowHash,
  };
}

export function findSheet(
  file: IngestedFile,
  sheetName: string | null,
  where: string,
): IngestedSheet {
  if (sheetName === null) {
    if (file.sheets.length !== 1) {
      throw new MigrationError(
        'MAPPING_INVALID',
        `${where} does not name a sheet, but ${file.file.filePathRelative} contains ${String(file.sheets.length)} sheets`,
        'Set "sheet" to the worksheet name this mapping applies to.',
        { where, sheets: file.sheets.map((entry) => entry.sheet.sheetName) },
      );
    }
    return file.sheets[0] as IngestedSheet;
  }
  const found = file.sheets.find((entry) => entry.sheet.sheetName === sheetName);
  if (found === undefined) {
    throw new MigrationError(
      'MAPPING_INVALID',
      `${where} names the sheet "${sheetName}", which ${file.file.filePathRelative} does not contain`,
      'Correct the sheet name.',
      { where, sheetName, sheets: file.sheets.map((entry) => entry.sheet.sheetName) },
    );
  }
  return found;
}

export interface BuildRecordsInput {
  readonly config: MigrationConfig;
  readonly filesByConfigId: ReadonlyMap<string, IngestedFile>;
  /** Column indexes consumed by association mappings, so they are not reported as unmapped. */
  readonly consumedColumns: ReadonlyMap<string, ReadonlySet<number>>;
  readonly booleanText: { readonly trueText: string; readonly falseText: string };
  readonly out: RecordFamilyWriters;
}

export function buildRecords(input: BuildRecordsInput): BuildRecordsResult {
  // Written down and released as each row is understood. Held as an array,
  // this was the largest thing the run carried: one draft per source row, each
  // holding every value it produced with the address and column it came from.
  const sink = input.out.drafts;
  let draftCount = 0;
  const drafts: DraftSink = {
    add(draft): void {
      draftCount += 1;
      sink.add(draft);
    },
  };

  for (const mapping of input.config.records) {
    const file = input.filesByConfigId.get(mapping.fileId);
    if (file === undefined) {
      throw new MigrationError(
        'MAPPING_INVALID',
        `record mapping "${mapping.id}" refers to file "${mapping.fileId}", which was not ingested`,
        'Check the file id in the configuration.',
        { recordMappingId: mapping.id, fileId: mapping.fileId },
      );
    }
    const sheet = findSheet(file, mapping.sheet, `record mapping "${mapping.id}"`);
    buildForSheet(mapping, file, sheet, input, drafts);
  }

  return { draftCount };
}

function buildForSheet(
  mapping: RecordMappingConfig,
  file: IngestedFile,
  sheet: IngestedSheet,
  input: BuildRecordsInput,
  drafts: DraftSink,
): void {
  const changes = input.out.changes;
  const flags = input.out.flags;
  const unmappedFields = input.out.unmappedFields;
  const where = `record mapping "${mapping.id}"`;
  const fileConfig = input.config.files.find((entry) => entry.id === mapping.fileId);
  const sourceSystem = fileConfig?.sourceSystem ?? input.config.source.system;
  const sourceNamespace = fileConfig?.sourceNamespace ?? input.config.source.namespace;

  const idColumn =
    mapping.sourceRecordIdColumn === null
      ? null
      : resolveColumn(mapping.sourceRecordIdColumn, sheet.columns, `${where} sourceRecordIdColumn`);
  const externalIdColumns = mapping.authoritativeExternalIdColumns.map((ref, index) =>
    resolveColumn(ref, sheet.columns, `${where} authoritativeExternalIdColumns[${String(index)}]`),
  );

  const resolvedFields = mapping.fields.map((field) => ({
    field,
    column: resolveColumn(field.column, sheet.columns, `${where} field "${field.destinationField}"`),
    countryColumn:
      field.options.phoneCountryColumn === null
        ? null
        : resolveColumn(
            field.options.phoneCountryColumn,
            sheet.columns,
            `${where} field "${field.destinationField}" phoneCountryColumn`,
          ),
  }));

  const consumed = new Set<number>(input.consumedColumns.get(sheetKey(file, sheet)) ?? []);
  if (idColumn !== null) consumed.add(idColumn.columnIndex);
  for (const column of externalIdColumns) consumed.add(column.columnIndex);
  for (const entry of resolvedFields) {
    consumed.add(entry.column.columnIndex);
    if (entry.countryColumn !== null) consumed.add(entry.countryColumn.columnIndex);
  }

  for (const row of sheet.rows) {
    const address = rowAddress(file, sheet, row.locator);
    const values = new Map<string, DraftValue>();
    let isolation: { reasonCode: ReasonCode; detail: string; field?: string | null } | null = null;
    const blockedFields = new Set<string>();

    for (const entry of resolvedFields) {
      const cell = cellAt(row, entry.column.columnIndex);
      const countryEvidence = resolveCountry(entry, row, input);

      const result = applyFieldTransform({
        cell,
        field: entry.field,
        locale: input.config.localeEvidence,
        policies: input.config.policies,
        countryEvidence: countryEvidence.value,
        countryEvidenceSource: countryEvidence.source,
      });

      // Only a value the boolean transformation actually recognised is written
      // in the destination's spelling. A value it could not read was preserved
      // deliberately, and rewriting it here would undo that.
      const rendered =
        entry.field.semanticType === 'BOOLEAN' &&
        result.final !== null &&
        result.reasonCode === 'TRANSFORM_BOOLEAN_PARSED'
          ? renderBoolean(result.final, input.booleanText)
          : result.final;

      // The transformation settled the intent; rendering a recognised boolean
      // in the destination's spelling changes the value it carries, so the
      // intent is re-derived from the string actually being delivered. It is
      // the same derivation, never a second opinion about what the outcome
      // meant, and a clear stays a clear through it.
      const intent =
        rendered === result.final ? result.intent : intentFor(result.kind, result.original, rendered);

      values.set(entry.field.destinationField, {
        intent,
        semanticsClass: declaredSemanticsClass(entry.field),
      });

      if (rendered !== result.original) {
        changes.add({
          address,
          columnLocatorId: entry.column.columnLocatorId,
          columnIndex: entry.column.columnIndex,
          columnHeader: entry.column.headerRaw,
          destinationField: entry.field.destinationField,
          originalValue: result.original,
          finalValue: rendered,
          transformationId: result.transformationId,
          transformationVersion: result.transformationVersion,
          reasonCode: result.reasonCode,
          evidence: renderEvidence(result.evidence),
        });
      }

      const blocking = decideIsolation(result.kind, result.reasonCode, entry.field.onAmbiguous, entry.field.onInvalid);
      if (blocking !== null && isolation === null) {
        isolation = {
          reasonCode: blocking,
          detail: `field "${entry.field.destinationField}" from column ${String(entry.column.columnIndex)} (${entry.column.headerRaw ?? 'no header'}): ${result.reasonCode}`,
        };
      }
      if (blocking !== null) blockedFields.add(entry.field.destinationField);

      if (shouldFlag(result)) {
        flags.add({
          address,
          columnLocatorId: entry.column.columnLocatorId,
          columnIndex: entry.column.columnIndex,
          columnHeader: entry.column.headerRaw,
          destinationField: entry.field.destinationField,
          outcome: result.kind,
          preservedValue: result.final,
          reasonCode: result.reasonCode,
          evidence: renderEvidence(result.evidence),
          blockedDelivery: blocking !== null,
        });
      }

      const extension = result.derived['extension'];
      const extensionTarget = entry.field.options.extensionDestinationField;
      if (extension !== undefined && extensionTarget !== null) {
        values.set(extensionTarget, {
          intent: set(extension),
          semanticsClass: effectiveSemanticsClass(extensionTarget, entry.field.semanticsClass),
        });
        changes.add({
          address,
          columnLocatorId: entry.column.columnLocatorId,
          columnIndex: entry.column.columnIndex,
          columnHeader: entry.column.headerRaw,
          destinationField: extensionTarget,
          originalValue: null,
          finalValue: extension,
          transformationId: result.transformationId,
          transformationVersion: result.transformationVersion,
          reasonCode: 'TRANSFORM_PHONE_EXTENSION_SEPARATED',
          evidence: renderEvidence(result.evidence),
        });
      }

      // A required field the plan authorized clearing is still a required field
      // with nothing in it, so a clear isolates exactly as an absence does.
      if (entry.field.required && !carriesValue(intent) && isolation === null) {
        isolation = {
          reasonCode: 'DESTINATION_REQUIRED_FIELD_MISSING',
          field: entry.field.destinationField,
          detail: `the migration configuration marks "${entry.field.destinationField}" required and this row has no value for it`,
        };
      }
    }

    for (const cell of row.cells) {
      if (consumed.has(cell.columnIndex)) continue;
      if (cell.raw === null || cell.raw.length === 0) continue;
      const column = sheet.columns[cell.columnIndex];
      unmappedFields.add({
        address,
        columnLocatorId: column?.columnLocatorId ?? `${address.fileId}:${address.sheetId}:C${String(cell.columnIndex)}`,
        columnIndex: cell.columnIndex,
        columnHeader: column?.headerRaw ?? null,
        value: cell.raw,
        reasonCode: 'UNMAPPED_COLUMN_PRESERVED',
      });
    }

    // An identifier is a value, and whitespace is part of it (D67). It enters
    // its identity key exactly as the source wrote it, unless the key column
    // declared an identity normalization; then the normalized spelling is the
    // key, and the row says so.
    const idNormalization = mapping.sourceRecordIdColumn?.identityNormalization ?? null;
    const rawIdCell = idColumn === null ? null : cellAt(row, idColumn.columnIndex).raw;
    const rawSourceRecordId = idColumn === null ? null : identifierOrNull(rawIdCell, idNormalization);
    if (idColumn !== null && rawIdCell !== null && rawIdCell.length > 0 && rawSourceRecordId === null) {
      // Whitespace only. It names nothing, so it is no id, and it is said out
      // loud because an id column that holds it is an id column that failed.
      flags.add({
        address,
        columnLocatorId: idColumn.columnLocatorId,
        columnIndex: idColumn.columnIndex,
        columnHeader: idColumn.headerRaw,
        destinationField: 'source record id',
        outcome: 'UNSUPPORTED',
        preservedValue: rawIdCell,
        reasonCode: 'IDENTITY_DISTINCT_NO_PROVING_EVIDENCE',
        evidence: 'the record id column holds only whitespace, which names no record, so this row proves nothing about identity',
        blockedDelivery: false,
      });
    }
    // An export sentinel is not an identifier. Treating one as proof would
    // merge every row whose id column failed to export.
    const sourceRecordId =
      rawSourceRecordId !== null && isSentinelIdentifier(rawSourceRecordId) ? null : rawSourceRecordId;
    if (rawSourceRecordId !== null && sourceRecordId === null && idColumn !== null) {
      flags.add({
        address,
        columnLocatorId: idColumn.columnLocatorId,
        columnIndex: idColumn.columnIndex,
        columnHeader: idColumn.headerRaw,
        destinationField: 'source record id',
        outcome: 'UNSUPPORTED',
        preservedValue: rawSourceRecordId,
        reasonCode: 'IDENTITY_DISTINCT_NO_PROVING_EVIDENCE',
        evidence: `the record id column holds "${rawSourceRecordId}", which is an export placeholder rather than an identifier, so this row proves nothing about identity`,
        blockedDelivery: false,
      });
    }
    if (idColumn !== null && sourceRecordId !== null && rawIdCell !== null && idNormalization !== null && sourceRecordId !== rawIdCell) {
      flags.add(normalizedKeyFlag(address, idColumn, 'source record id', rawIdCell, sourceRecordId, idNormalization));
    }

    const identitySpace = mapping.identitySpace ?? mapping.id;
    const identityKeys: ProvingKey[] = [];
    if (sourceRecordId !== null) {
      identityKeys.push({
        kind: 'SOURCE_RECORD_ID',
        ...(idNormalization === null || rawIdCell === null ? {} : { sourceValue: rawIdCell }),
        key: renderIdentityKey({
          sourceSystem,
          sourceNamespace,
          identitySpace,
          objectType: mapping.object,
          keyKind: 'SOURCE_RECORD_ID',
          keyColumn: '',
          keyColumnAddress: '',
          sourceRecordId,
        }),
      });
    }
    for (const [columnPosition, column] of externalIdColumns.entries()) {
      const externalNormalization = mapping.authoritativeExternalIdColumns[columnPosition]?.identityNormalization ?? null;
      const rawExternal = cellAt(row, column.columnIndex).raw;
      const value = identifierOrNull(rawExternal, externalNormalization);
      if (value === null) {
        if (rawExternal !== null && rawExternal.length > 0) {
          flags.add({
            address,
            columnLocatorId: column.columnLocatorId,
            columnIndex: column.columnIndex,
            columnHeader: column.headerRaw,
            destinationField: 'authoritative external id',
            outcome: 'UNSUPPORTED',
            preservedValue: rawExternal,
            reasonCode: 'IDENTITY_DISTINCT_NO_PROVING_EVIDENCE',
            evidence: `the column "${column.headerRaw ?? String(column.columnIndex)}" is declared an authoritative external identifier and holds only whitespace, which names no record, so this row proves nothing about identity`,
            blockedDelivery: false,
          });
        }
        continue;
      }
      if (isSentinelIdentifier(value)) {
        // Same rule as the record-id column, and the same reason: the operator
        // declared this column authoritative, so silently discarding its value
        // tells them nothing about why the record is keyed by its row address.
        flags.add({
          address,
          columnLocatorId: column.columnLocatorId,
          columnIndex: column.columnIndex,
          columnHeader: column.headerRaw,
          destinationField: 'authoritative external id',
          outcome: 'UNSUPPORTED',
          preservedValue: value,
          reasonCode: 'IDENTITY_DISTINCT_NO_PROVING_EVIDENCE',
          evidence: `the column "${column.headerRaw ?? String(column.columnIndex)}" is declared an authoritative external identifier and holds "${value}", which is an export placeholder rather than an identifier, so this row proves nothing about identity`,
          blockedDelivery: false,
        });
        continue;
      }
      if (externalNormalization !== null && rawExternal !== null && value !== rawExternal) {
        flags.add(normalizedKeyFlag(address, column, 'authoritative external id', rawExternal, value, externalNormalization));
      }
      identityKeys.push({
        kind: 'AUTHORITATIVE_EXTERNAL_ID',
        ...(externalNormalization === null || rawExternal === null ? {} : { sourceValue: rawExternal }),
        key: renderIdentityKey({
          sourceSystem,
          sourceNamespace,
          identitySpace,
          objectType: mapping.object,
          keyKind: 'EXTERNAL_ID',
          keyColumn: column.headerRaw ?? '',
          keyColumnAddress:
            column.headerRaw === null
              ? `index:${String(column.columnIndex)}`
              : `occurrence:${String(column.headerOccurrence)}`,
          sourceRecordId: value,
        }),
      });
    }

    drafts.add({
      recordMappingId: mapping.id,
      object: mapping.object,
      address,
      sourceSystem,
      sourceNamespace,
      identitySpace,
      sourceRecordId,
      identityKeys,
      values,
      isolation,
    });
  }
}

function sheetKey(file: IngestedFile, sheet: IngestedSheet): string {
  return `${file.file.fileId}:${sheet.sheet.sheetId}`;
}

function resolveCountry(
  entry: {
    field: { options: { phoneCountry: string | null } };
    countryColumn: { columnIndex: number } | null;
  },
  row: Parameters<typeof cellAt>[0],
  input: BuildRecordsInput,
): { value: string | null; source: string } {
  if (entry.field.options.phoneCountry !== null) {
    return { value: entry.field.options.phoneCountry, source: 'the field mapping' };
  }
  if (entry.countryColumn !== null) {
    const raw = cellAt(row, entry.countryColumn.columnIndex).raw;
    // A padded code is not a code: whitespace is a value, and nothing here
    // decides that it should not be.
    if (raw !== null && /^[A-Za-z]{2}$/u.test(raw)) {
      return { value: raw.toUpperCase(), source: 'the country column on this row' };
    }
    return { value: null, source: 'the country column on this row, which holds no usable country code' };
  }
  if (input.config.localeEvidence.phoneCountry !== null) {
    return { value: input.config.localeEvidence.phoneCountry, source: 'localeEvidence.phoneCountry' };
  }
  return { value: null, source: 'no source' };
}

/**
 * Whether an outcome should set the whole row aside.
 *
 * A row is only isolated when the configuration asks for it, or when the row
 * depends on a spreadsheet formula result the configuration has not authorized.
 * Everything else preserves the value and records a flag.
 */
function decideIsolation(
  kind: string,
  reasonCode: ReasonCode,
  onAmbiguous: 'PRESERVE' | 'ISOLATE_ROW',
  onInvalid: 'PRESERVE' | 'ISOLATE_ROW',
): ReasonCode | null {
  if (reasonCode === 'TRANSFORM_FORMULA_CACHED_VALUE_NOT_AUTHORIZED') {
    return 'ISOLATED_FORMULA_CACHED_VALUE';
  }
  // Under either policy: there is no cached value to accept, so the row is set
  // aside whatever onAmbiguous says.
  if (reasonCode === 'TRANSFORM_FORMULA_CACHED_VALUE_ABSENT') {
    return 'ISOLATED_FORMULA_CACHED_VALUE_ABSENT';
  }
  if (kind === 'AMBIGUOUS' && onAmbiguous === 'ISOLATE_ROW') return 'ISOLATED_AMBIGUOUS_FIELD';
  if (kind === 'INVALID' && onInvalid === 'ISOLATE_ROW') return 'ISOLATED_INVALID_FIELD';
  if (kind === 'UNSUPPORTED' && onAmbiguous === 'ISOLATE_ROW') return 'ISOLATED_UNSUPPORTED_FIELD';
  return null;
}

function renderBoolean(value: string, texts: { trueText: string; falseText: string }): string {
  if (value === 'true') return texts.trueText;
  if (value === 'false') return texts.falseText;
  return value;
}

export function renderEvidence(evidence: readonly { kind: string; detail: string }[]): string {
  return evidence.map((item) => `${item.kind}: ${item.detail}`).join(' | ');
}

/** The declared class wins; otherwise the canonical model decides, and a custom field is STANDARD. */
function declaredSemanticsClass(field: { semanticsClass: FieldSemanticsClass | null; destinationField: string }): FieldSemanticsClass {
  return effectiveSemanticsClass(field.destinationField, field.semanticsClass);
}

export function isEmpty(value: string | null): boolean {
  return value === null || value.length === 0;
}

/**
 * The identifier a cell names, or null when it names none.
 *
 * Never alters the value: a non-blank identifier is returned exactly as the
 * source wrote it, unless the key column declared an identity normalization.
 * A cell of only whitespace is no identifier.
 */
function identifierOrNull(value: string | null, normalization: IdentityNormalization | null): string | null {
  if (value === null || value.trim().length === 0) return null;
  const normalized = normalizeIdentityValue(value, normalization);
  return normalized.trim().length === 0 ? null : normalized;
}

/** The row-level record of an identity normalization that changed an identifier. */
function normalizedKeyFlag(
  address: RowAddress,
  column: { columnLocatorId: string; columnIndex: number; headerRaw: string | null },
  destinationField: string,
  raw: string,
  keyed: string,
  normalization: IdentityNormalization,
): FlagEntry {
  const rules = [normalization.trim ? 'trim' : null, normalization.unicode === 'NFC' ? 'Unicode NFC' : null]
    .filter((rule): rule is string => rule !== null)
    .join(' and ');
  return {
    address,
    columnLocatorId: column.columnLocatorId,
    columnIndex: column.columnIndex,
    columnHeader: column.headerRaw,
    destinationField,
    outcome: 'CHANGED_SAFE',
    preservedValue: raw,
    reasonCode: 'IDENTITY_KEY_NORMALIZED',
    evidence: `the plan declares an identity normalization (${rules}) for this key column; the source wrote ${JSON.stringify(raw)} and the row is keyed as ${JSON.stringify(keyed)}`,
    blockedDelivery: false,
  };
}
