import type { MigrationConfig } from '../domain/config.js';
import type { CanonicalObject } from '../domain/canonical.js';
import { customFieldLabel, isCanonicalField, isCustomField } from '../domain/canonical.js';
import type { CanonicalFieldName } from '../domain/canonical.js';
import type { DestinationAdapter } from '../adapters/adapter.js';
import { objectSpec, vendorHeader } from '../adapters/adapter.js';
import type { Reconciliation } from '../reconcile/reconcile.js';
import { reconciliationToJson } from '../reconcile/reconcile.js';
import type { DeliveredRecord, RowAddress, RunTruth } from '../reconcile/truth.js';
import type { JsonObject, JsonValue } from '../util/json.js';
import { canonicalJsonText, compareCodeUnits } from '../util/json.js';
import { by, onString, sorted } from '../util/sorting.js';
import { renderAudit } from './audit.js';
import { mapFamily, selectFrom } from '../run/spool.js';
import { IMPORT_AREA, dataViewPathFor, packagePath } from './layout.js';
import { neutraliseCell } from './human-view.js';
import { sha256Hex } from '../util/hash.js';
import { importKeyFor, objectsNeedingImportKey } from './import-key.js';
import { renderImportInstructions } from './import-instructions.js';
import { importPartPath, planImportParts } from './import-partition.js';

/**
 * An artifact, described rather than rendered.
 *
 * A tabular artifact carries its headers and its rows, not the text they make.
 * The writer turns them into bytes a row at a time and hashes as it goes, so no
 * artifact is ever a whole string and a whole buffer at once. At half a million
 * rows the package is most of a gigabyte, and holding each of those twice —
 * once as UTF-16 text, once as bytes — was most of what the packaging stage
 * spent.
 *
 * A document artifact is small and structural (a manifest, a reconciliation, an
 * audit), so it is kept as text.
 */
export type ArtifactFile =
  | {
      readonly kind: 'DOCUMENT';
      /** Path relative to the package root, using forward slashes. */
      readonly path: string;
      readonly text: string;
      readonly rowCount: null;
    }
  | {
      readonly kind: 'TABLE';
      readonly path: string;
      readonly headers: readonly string[];
      /**
       * Walked once by the writer, never collected. A family with a projection
       * over it is still a family: nothing between here and the bytes on disk
       * holds more than one row.
       */
      readonly rows: Iterable<readonly (string | null)[]>;
      /**
       * How many rows this artifact is expected to hold, where that is known
       * before it is written. The writer counts what it actually wrote and
       * refuses a disagreement, so this is a claim that gets checked rather
       * than a number the manifest takes on trust. Null where the rows are a
       * selection and the count is not known until they have been walked.
       */
      readonly rowCount: number | null;
      /**
       * A table that also has a human view (D72): the writer walks the rows once
       * and, beside this file, writes a copy with every spreadsheet-executable
       * cell neutralised. The copy is kept only if some cell needed it, so an
       * import file with nothing risky in it has no view and the package does
       * not list an empty one. The rows are walked once, never twice, and the
       * view is written a block at a time like any other table.
       */
      readonly humanView?: { readonly path: string };
    };

const ADDRESS_HEADERS = [
  'bundle_id',
  'file_id',
  'file_sha256',
  'file_path',
  'sheet_id',
  'sheet_name',
  'row_number',
  'row_locator_id',
  'row_hash',
] as const;

function addressCells(address: RowAddress): (string | null)[] {
  return [
    address.bundleId,
    address.fileId,
    address.fileSha256,
    address.filePath,
    address.sheetId,
    address.sheetName,
    String(address.rowNumberSource),
    address.rowLocatorId,
    address.rowHash,
  ];
}

export interface RenderInput {
  readonly truth: RunTruth;
  readonly reconciliation: Reconciliation;
  readonly adapter: DestinationAdapter;
  readonly config: MigrationConfig;
  readonly normalizedConfig: JsonObject;
}

/**
 * Renders every artifact except the manifest, which is written last because it
 * carries the hashes of these files.
 */
export function renderPackage(input: RenderInput): ArtifactFile[] {
  const { truth, reconciliation, adapter } = input;
  const files: ArtifactFile[] = [];

  const csv = (
    name: string,
    headers: readonly string[],
    rows: Iterable<readonly (string | null)[]>,
    rowCount: number | null,
  ): void => {
    files.push({ kind: 'TABLE', path: packagePath(name), headers, rows, rowCount });
  };

  files.push({
    kind: 'DOCUMENT',
    path: packagePath('reconciliation.json'),
    text: canonicalJsonText(reconciliationToJson(reconciliation)),
    rowCount: null,
  });

  files.push({
    kind: 'DOCUMENT',
    path: packagePath('config.normalized.json'),
    text: canonicalJsonText(input.normalizedConfig),
    rowCount: null,
  });

  csv(
    'source-lineage.csv',
    [
      ...ADDRESS_HEADERS,
      'contribution_kind',
      'disposition',
      'reason_code',
      'detail',
      'record_mapping_id',
      'object',
      'source_system',
      'source_namespace',
      'source_record_id',
      'identity_key',
      'record_identity_key',
      'migration_key',
      'merge_id',
    ],
    mapFamily(truth.lineage, (entry) => [
      ...addressCells(entry.address),
      entry.contributionKind,
      entry.disposition,
      entry.reasonCode,
      entry.detail,
      entry.recordMappingId,
      entry.object,
      entry.sourceSystem,
      entry.sourceNamespace,
      entry.sourceRecordId,
      entry.identityKey,
      entry.recordIdentityKey,
      entry.migrationKey,
      entry.mergeId,
    ]),
    truth.lineage.count,
  );

  csv(
    'changes.csv',
    [
      ...ADDRESS_HEADERS,
      'column_locator_id',
      'column_index',
      'column_header',
      'destination_field',
      'original_value',
      'final_value',
      'transformation_id',
      'transformation_version',
      'reason_code',
      'evidence',
    ],
    mapFamily(truth.changes, (entry) => [
      ...addressCells(entry.address),
      entry.columnLocatorId,
      String(entry.columnIndex),
      entry.columnHeader,
      entry.destinationField,
      entry.originalValue,
      entry.finalValue,
      entry.transformationId,
      entry.transformationVersion,
      entry.reasonCode,
      entry.evidence,
    ]),
    truth.changes.count,
  );

  csv(
    'flags.csv',
    [
      ...ADDRESS_HEADERS,
      'column_locator_id',
      'column_index',
      'column_header',
      'destination_field',
      'outcome',
      'preserved_value',
      'reason_code',
      'evidence',
      'blocked_delivery',
    ],
    mapFamily(truth.flags, (entry) => [
      ...addressCells(entry.address),
      entry.columnLocatorId,
      String(entry.columnIndex),
      entry.columnHeader,
      entry.destinationField,
      entry.outcome,
      entry.preservedValue,
      entry.reasonCode,
      entry.evidence,
      entry.blockedDelivery ? 'true' : 'false',
    ]),
    truth.flags.count,
  );

  csv(
    'unmapped-fields.csv',
    [...ADDRESS_HEADERS, 'column_locator_id', 'column_index', 'column_header', 'value', 'reason_code'],
    // One declared order, like every other artifact: without it, the rows sat in
    // whatever order the mappings happened to run in and no check could tell a
    // reordered file from a correct one. The order is now the one the family
    // was spilled in, so this reads it rather than sorting it again.
    mapFamily(truth.unmappedFields, (entry) => [
      ...addressCells(entry.address),
      entry.columnLocatorId,
      String(entry.columnIndex),
      entry.columnHeader,
      entry.value,
      entry.reasonCode,
    ]),
    truth.unmappedFields.count,
  );

  csv(
    'isolated.csv',
    [...ADDRESS_HEADERS, 'object', 'record_mapping_id', 'reason_code', 'field', 'detail'],
    mapFamily(truth.isolated, (entry) => [
      ...addressCells(entry.address),
      entry.object,
      entry.recordMappingId,
      entry.reasonCode,
      entry.field,
      entry.detail,
    ]),
    truth.isolated.count,
  );

  csv(
    'leftovers.csv',
    [...ADDRESS_HEADERS, 'reason_code', 'detail'],
    mapFamily(truth.leftovers, (entry) => [...addressCells(entry.address), entry.reasonCode, entry.detail]),
    truth.leftovers.count,
  );

  csv(
    'rejected-input.csv',
    [...ADDRESS_HEADERS, 'reason_code', 'detail'],
    mapFamily(truth.rejected, (entry) => [...addressCells(entry.address), entry.reasonCode, entry.detail]),
    truth.rejected.count,
  );

  csv(
    'duplicate-candidates.csv',
    [
      'cluster_id',
      'object',
      'migration_key',
      'row_locator_id',
      'file_path',
      'row_number',
      'signal',
      'signal_value',
      'evidence',
      'conflicts',
      'why_not_merged',
      'reason_code',
      'not_merged_reason_code',
    ],
    mapFamily(truth.duplicateCandidates, (entry) => [
      entry.clusterId,
      entry.object,
      entry.migrationKey,
      entry.rowLocatorId,
      entry.filePath,
      String(entry.rowNumberSource),
      entry.signal,
      entry.signalValue,
      entry.evidence,
      entry.conflicts,
      entry.whyNotMerged,
      entry.reasonCode,
      entry.notMergedReasonCode,
    ]),
    truth.duplicateCandidates.count,
  );

  csv(
    'associations.csv',
    [
      'source_edge_id',
      'association_mapping_id',
      'relationship_type',
      'label',
      ...ADDRESS_HEADERS,
      'from_key_raw',
      'to_key_raw',
      'from_migration_key',
      'to_migration_key',
      'disposition',
      'reason_code',
      'detail',
      'deduplicated_into_edge_id',
    ],
    mapFamily(truth.edges, (entry) => [
      entry.sourceEdgeId,
      entry.associationMappingId,
      entry.relationshipType,
      entry.label,
      ...addressCells(entry.address),
      entry.fromKeyRaw,
      entry.toKeyRaw,
      entry.fromMigrationKey,
      entry.toMigrationKey,
      entry.disposition,
      entry.reasonCode,
      entry.detail,
      entry.deduplicatedIntoEdgeId,
    ]),
    truth.edges.count,
  );

  csv(
    'unresolved-associations.csv',
    [
      'source_edge_id',
      'association_mapping_id',
      'relationship_type',
      ...ADDRESS_HEADERS,
      'from_key_raw',
      'to_key_raw',
      'disposition',
      'reason_code',
      'detail',
    ],
    selectFrom(truth.edges, (entry) =>
      entry.disposition === 'UNRESOLVED' || entry.disposition === 'LEFTOVER'
        ? [
            entry.sourceEdgeId,
            entry.associationMappingId,
            entry.relationshipType,
            ...addressCells(entry.address),
            entry.fromKeyRaw,
            entry.toKeyRaw,
            entry.disposition,
            entry.reasonCode,
            entry.detail,
          ]
        : null,
    ),
    null,
  );

  csv(
    'destination-conflicts.csv',
    ['object', 'key_field', 'key_value', 'migration_keys', 'row_locator_ids', 'reason_code', 'detail'],
    truth.destinationConflicts.map((entry) => [
      entry.object,
      entry.keyField,
      entry.keyValue,
      entry.migrationKeys.join(' '),
      entry.rowLocatorIds.join(' '),
      entry.reasonCode,
      entry.detail,
    ]),
    truth.destinationConflicts.length,
  );

  // A human view (D72). Every cell is neutralised, the value among them, so a
  // spreadsheet shows the text instead of running it; value_sha256 is the digest
  // of the exact value, which the import file holds, so the two can still be
  // joined without the file being executable.
  csv(
    'formula-risk.csv',
    ['target', 'object', 'migration_key', 'destination_field', 'value', 'value_sha256', 'reason_code'],
    mapFamily(truth.formulaRisks, (entry) =>
      [
        entry.target,
        entry.object,
        entry.migrationKey,
        entry.destinationField,
        entry.value,
        sha256Hex(entry.value),
        entry.reasonCode,
      ].map(neutraliseCell),
    ),
    truth.formulaRisks.count,
  );

  csv(
    'instance-verification.csv',
    ['scope', 'detail', 'source_url', 'reason_code'],
    truth.instanceVerification.map((entry) => [entry.scope, entry.detail, entry.sourceUrl, entry.reasonCode]),
    truth.instanceVerification.length,
  );

  // What the destination was asked to match on, and what in the captured
  // contract made that legal. Written even when it is empty: a create-only
  // package saying "nothing is matched" in as many words is not the same
  // artifact as one that forgot to say.
  csv(
    'destination-matching.csv',
    [
      'record_mapping_id',
      'match_authority',
      'target_field',
      'source_field',
      'on_missing_match',
      'on_match_conflict',
      'authorised_by',
    ],
    truth.destinationMatching.map((entry) => [
      entry.recordMappingId,
      entry.matchAuthority,
      entry.targetField,
      entry.sourceField,
      entry.onMissingMatch,
      entry.onMatchConflict,
      entry.authorisedBy,
    ]),
    truth.destinationMatching.length,
  );

  files.push({
    kind: 'DOCUMENT',
    path: packagePath('merges.json'),
    text: canonicalJsonText({ merges: truth.merges as unknown as JsonValue }),
    rowCount: null,
  });

  // The import tables, how they have to be cut, and then the files themselves.
  // The plan is computed once and shared with the crosswalk, so where a record
  // landed and what the crosswalk says about it are one derivation rather than
  // two that happen to agree.
  const importTablesForRun = importTables(input);
  const importPlan = planImportFiles(input, importTablesForRun);
  files.push(...withHumanViews(renderImportFiles(input, importTablesForRun, importPlan)));

  // The way back from an import row to the source rows behind it.
  //
  // 01_IMPORT no longer carries the trace key, so without this file the two
  // halves of the package could not be joined by anything but guesswork. With
  // it, whoever holds the package can follow any import row to its record and
  // its lineage -- and the destination, which never receives this file, cannot.
  csv(
    'import-crosswalk.csv',
    ['import_path', 'import_row_number', 'association_key', 'migration_key', 'object', 'survivor_row_locator_id'],
    crosswalkRows(input, importPlan),
    truth.deliveredRecords.count,
  );

  files.push({
    kind: 'DOCUMENT',
    path: packagePath('import-instructions.md'),
    text: renderImportInstructions({ truth, reconciliation, adapter, config: input.config, importParts: importPlan }),
    rowCount: null,
  });

  files.push({
    kind: 'DOCUMENT',
    path: packagePath('audit.md'),
    text: renderAudit(reconciliation, {
      instanceVerification: truth.instanceVerification,
      vendorSources: adapter.sources,
      adapterNotes: adapter.objects.flatMap((spec) => spec.notes),
    }),
    rowCount: null,
  });

  return sorted(files, by(onString((file) => file.path)));
}

/**
 * One row per delivered record, in the position that record occupies in its
 * import file.
 *
 * The position is produced by walking the same family with the same filter in
 * the same order the import file is written from, so the two agree by
 * construction rather than by a second sort that could disagree with the
 * first. The family is walked once per object, which is at most four passes,
 * and one record is held at a time.
 */
function* crosswalkRows(input: RenderInput, plan: ImportPlan): IterableIterator<(string | null)[]> {
  const { truth, adapter, config } = input;
  const keyed = objectsNeedingImportKey(config);

  // Ordered by import path, not by object. The two agree for CLEAN_ONLY and
  // HubSpot and disagree for Salesforce, whose CONTACT lands in Contact.csv and
  // whose COMPANY lands in Account.csv -- so ordering by object name produced a
  // crosswalk out of its own declared order, and the run refused to deliver the
  // package. The declared order is what a reader can rely on, so it is what the
  // writer follows.
  const targets = sorted(
    [...new Set(config.records.map((mapping) => mapping.object))].flatMap((object) => {
      const spec = objectSpec(adapter, object);
      if (spec === null) return [];
      return [{ object, importPath: `${IMPORT_AREA}/${adapter.importDirectory}/${spec.fileName}` }];
    }),
    by(onString((target) => target.importPath)),
  );

  for (const { object, importPath } of targets) {
    // Which part this record landed in, and its row number *within that part*.
    // The verifier joins the crosswalk to a file by position, so a row number
    // counted across the whole object rather than within the file it names would
    // be wrong on every part after the first.
    const counts = plan.get(object) ?? [0];
    let part = 0;
    let rowNumber = 0;
    for (const record of truth.deliveredRecords) {
      if (record.object !== object) continue;
      while (part < counts.length - 1 && rowNumber >= (counts[part] ?? 0)) {
        part += 1;
        rowNumber = 0;
      }
      rowNumber += 1;
      yield [
        importPartPath(importPath, part + 1, counts.length),
        String(rowNumber),
        keyed.has(object) ? importKeyFor(truth.runId, record.migrationKey) : '',
        record.migrationKey,
        object,
        record.survivorRowLocatorId,
      ];
    }
  }
}

// ------------------------------------------------------------- import files
//
// 01_IMPORT holds what the destination is meant to receive, and nothing else.
// Every column here is one the importer recognises, the contract permits and
// the plan requires; a column that exists for Kauro's benefit belongs in
// 03_TRACEABILITY, where the operator is not asked to map it.

/**
 * One object's import table, before it has been cut or written.
 *
 * Extracted so the renderer, the partition plan and the crosswalk all derive the
 * columns, the header row and the cells of a record from one place. They used to
 * be derived twice -- once to write the file and once to say in the crosswalk
 * where each record landed -- which agreed only because both walked the same
 * family in the same order. Cutting a file into parts adds a second thing they
 * have to agree about, and two derivations that agree by coincidence do not
 * survive that.
 */
interface ImportTable {
  readonly object: CanonicalObject;
  readonly basePath: string;
  readonly headers: readonly string[];
  readonly keyed: boolean;
  cells(record: DeliveredRecord): readonly (string | null)[];
}

function importTables(input: RenderInput): ImportTable[] {
  const { truth, adapter, config } = input;
  const carriesKey = objectsNeedingImportKey(config);
  const tables: ImportTable[] = [];

  const groups = new Map<string, { object: CanonicalObject }>();
  for (const mapping of config.records) {
    groups.set(mapping.object, {
      object: mapping.object,
    });
  }

  for (const key of sorted([...groups.keys()], compareCodeUnits)) {
    const group = groups.get(key);
    if (group === undefined) continue;
    const spec = objectSpec(adapter, group.object);
    if (spec === null) continue;

    const mapped = new Set<string>();
    for (const mapping of config.records) {
      if (mapping.object !== group.object) continue;
      for (const fieldMapping of mapping.fields) {
        mapped.add(fieldMapping.destinationField);
        if (fieldMapping.options.extensionDestinationField !== null) {
          mapped.add(fieldMapping.options.extensionDestinationField);
        }
      }
    }

    const canonicalColumns = spec.fields
      .filter((entry) => mapped.has(entry.canonicalField))
      .map((entry) => ({ field: entry.canonicalField as string, header: entry.header }));
    const customColumns = sorted([...mapped].filter(isCustomField), compareCodeUnits).map((fieldName) => ({
      field: fieldName,
      header: adapter.customFieldHeader(customFieldLabel(fieldName)),
    }));
    const columns = [...canonicalColumns, ...customColumns];

    // The association key column, on the objects that take part in a
    // relationship this plan declares, and on no others. An object nothing is
    // associated with gets a file of destination fields only: there is nothing
    // for the operator to join it to, so there is no column to explain, ignore
    // or accidentally map.
    const keyed = carriesKey.has(group.object);
    const clearRepresentation = adapter.clearRepresentation;
    const headers = columns.map((column) => column.header);

    tables.push({
      object: group.object,
      basePath: `${IMPORT_AREA}/${adapter.importDirectory}/${spec.fileName}`,
      headers: keyed ? [adapter.associationKeyHeader, ...headers] : headers,
      keyed,
      // An empty cell means "this record said nothing about the field". Where
      // the plan authorized emptying one, the cell has to say so in the only
      // spelling this destination understands.
      //
      // For HubSpot and Salesforce there is no such spelling, and a record whose
      // clear could have reached an existing value was already set aside by
      // destination validation. What survives to here is a create, where there
      // is nothing to remove and an absent value is the whole of the
      // instruction.
      cells(record: DeliveredRecord): readonly (string | null)[] {
        // One record's cleared fields, not every record's: the set is rebuilt
        // per row and released with it, so it is bounded by the width of an
        // object rather than by how many records the migration delivers.
        const cleared = new Set(record.clearedFields);
        const values = columns.map((column) =>
          cleared.has(column.field) && clearRepresentation.kind === 'EXPLICIT_TOKEN'
            ? clearRepresentation.token
            : record.values[column.field] ?? '',
        );
        return keyed ? [importKeyFor(truth.runId, record.migrationKey), ...values] : values;
      },
    });
  }
  return tables;
}

/**
 * How each object's import file has to be cut, if at all.
 *
 * Computed once, here, and handed to both the renderer and the crosswalk. The
 * family is walked one extra time per object to measure what each row will
 * occupy; nothing is held but a running total.
 */
type ImportPlan = ReadonlyMap<CanonicalObject, readonly number[]>;

function planImportFiles(input: RenderInput, tables: readonly ImportTable[]): ImportPlan {
  const { truth, adapter } = input;
  const plan = new Map<CanonicalObject, readonly number[]>();
  for (const table of tables) {
    // The key of the record being measured, so an over-size row is reported by
    // name. One string, replaced as the walk moves, rather than a list of every
    // key seen.
    let measuring = '';
    const rows = (function* (): IterableIterator<readonly (string | null)[]> {
      for (const record of truth.deliveredRecords) {
        if (record.object !== table.object) continue;
        measuring = record.migrationKey;
        yield table.cells(record);
      }
    })();
    plan.set(
      table.object,
      planImportParts(table.headers, rows, adapter.fileConstraints.maxFileBytes, () => `record ${measuring}`),
    );
  }
  return plan;
}

/** One part's rows: the same walk, in the same order, bounded to this part's slice. */
function rangeOf(
  truth: RunTruth,
  table: ImportTable,
  start: number,
  end: number,
): Iterable<readonly (string | null)[]> {
  return {
    *[Symbol.iterator](): IterableIterator<readonly (string | null)[]> {
      let index = 0;
      for (const record of truth.deliveredRecords) {
        if (record.object !== table.object) continue;
        const at = index;
        index += 1;
        if (at < start) continue;
        if (at >= end) break;
        yield table.cells(record);
      }
    },
  };
}

/**
 * Every import file also declares the human view it may get (D72). Whether it
 * gets one is decided by the writer, from the rows, in the same pass that writes
 * the import file.
 */
function withHumanViews(files: readonly ArtifactFile[]): ArtifactFile[] {
  return files.map((file) =>
    file.kind === 'TABLE' && file.path.startsWith(`${IMPORT_AREA}/`) ? { ...file, humanView: { path: dataViewPathFor(file.path) } } : file,
  );
}

function renderImportFiles(input: RenderInput, tables: readonly ImportTable[], plan: ImportPlan): ArtifactFile[] {
  const { truth, adapter, config } = input;
  const files: ArtifactFile[] = [];

  for (const table of tables) {
    const counts = plan.get(table.object) ?? [0];
    let from = 0;
    for (let part = 0; part < counts.length; part += 1) {
      const start = from;
      const end = start + (counts[part] ?? 0);
      from = end;
      files.push({
        kind: 'TABLE',
        path: importPartPath(table.basePath, part + 1, counts.length),
        headers: table.headers,
        rows: rangeOf(truth, table, start, end),
        // Known now, because the plan counted it, and checked by the writer
        // against what it actually wrote.
        rowCount: counts[part] ?? 0,
      });
    }
  }

  // One association file per relationship the plan declares, whether or not
  // this dataset resolved any of them. The same configuration produces the same
  // set of files, so an operator following the instructions does not have to
  // work out whether a missing file means "none" or "not supported", and the
  // verifier can rebuild the expected file set from the configuration alone.
  //
  // Each file is one pass over the edge family, filtered. Three relationship
  // types means at most three passes and one edge held at a time, where the
  // previous version grouped every delivered edge into a map of arrays first.
  for (const relationshipType of sorted(declaredRelationshipTypes(config), compareCodeUnits)) {
    const rows = selectFrom(truth.edges, (edge) => {
      if (edge.disposition !== 'OUTPUT' || edge.relationshipType !== relationshipType) return null;
      return [
        importKeyOrBlank(truth.runId, edge.fromMigrationKey),
        importKeyOrBlank(truth.runId, edge.toMigrationKey),
        edge.label ?? '',
      ];
    });
    files.push({
      kind: 'TABLE',
      path: `${IMPORT_AREA}/${adapter.importDirectory}/associations/${relationshipType.toLowerCase()}.csv`,
      headers: [adapter.associationFromHeader, adapter.associationToHeader, 'Association Label'],
      rows,
      rowCount: null,
    });
  }

  return files;
}

/**
 * An endpoint's import key, or nothing when the endpoint has no delivered
 * record. A digest of the empty string is a well-formed key for a record that
 * does not exist, which is exactly the kind of confident nonsense an import
 * file must not contain.
 */
function importKeyOrBlank(runId: string, migrationKey: string | null): string {
  if (migrationKey === null || migrationKey === '') return '';
  return importKeyFor(runId, migrationKey);
}

/** The relationship types this plan declares, deduplicated. */
export function declaredRelationshipTypes(config: MigrationConfig): string[] {
  return [...new Set(config.associations.map((association) => association.relationshipType as string))];
}

/** Exposed so the verifier can rebuild the same expected header set from the package's own configuration. */
export function importColumnsFor(
  adapter: DestinationAdapter,
  config: MigrationConfig,
  object: CanonicalObject,
): string[] {
  const spec = objectSpec(adapter, object);
  if (spec === null) return [];
  const mapped = new Set<string>();
  for (const mapping of config.records) {
    if (mapping.object !== object) continue;
    for (const fieldMapping of mapping.fields) {
      mapped.add(fieldMapping.destinationField);
      if (fieldMapping.options.extensionDestinationField !== null) {
        mapped.add(fieldMapping.options.extensionDestinationField);
      }
    }
  }
  const canonical = spec.fields
    .filter((entry) => mapped.has(entry.canonicalField))
    .map((entry) => entry.header);
  const custom = sorted([...mapped].filter(isCustomField), compareCodeUnits).map((fieldName) =>
    adapter.customFieldHeader(customFieldLabel(fieldName)),
  );
  const headers = [...canonical, ...custom];
  return objectsNeedingImportKey(config).has(object)
    ? [adapter.associationKeyHeader, ...headers]
    : headers;
}

/** Kept for symmetry with the header builder; used by tests that assert a field maps to a vendor column. */
export function headerForField(
  adapter: DestinationAdapter,
  object: CanonicalObject,
  field: string,
): string | null {
  const spec = objectSpec(adapter, object);
  if (spec === null) return null;
  if (isCustomField(field)) return adapter.customFieldHeader(customFieldLabel(field));
  if (!isCanonicalField(field)) return null;
  return vendorHeader(spec, field as CanonicalFieldName)?.header ?? null;
}
