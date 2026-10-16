/**
 * `effectsFromMigrationRun` (D3-CFG-3): what Migration Core did with each
 * fragment of a configuration, read off its own run truth and the document
 * its loader normalized — the product function a host's validation port
 * calls between the run and the disposal of its scratch store, and whose
 * result the receipt carries.
 *
 * Closed and payload-free: record mapping and association ids, column
 * locators and indexes, canonical destinations, counts and fragment hashes.
 * No header, no value, no path: a custom destination (which names a header)
 * is reported without its name. Each spooled family of the truth is walked
 * once, and nothing indexes the rows.
 */
import type { LoadedConfig, RunResult } from 'kauro-migration-core';

import { digestOf } from '../contracts/canonical.js';
import { IDENTIFIER_PATTERN, s } from '../contracts/schema.js';
import type { Schema } from '../contracts/schema.js';
import { columnFragmentHash, elementFragmentHash } from './migration-config.js';

/** Rows of a record mapping by the disposition Migration Core gave them. */
export interface RowDispositions {
  readonly output: number;
  readonly mergedProven: number;
  readonly isolated: number;
  readonly leftover: number;
  readonly rejected: number;
}

export interface RecordEffect {
  readonly recordMappingId: string;
  readonly object: string;
  readonly fragmentHash: string;
  readonly rows: RowDispositions;
  /** Records delivered for the mapping. */
  readonly deliveredRecords: number;
}

export interface FieldEffect {
  readonly recordMappingId: string;
  /** The canonical destination; null for a custom one, whose name is a header. */
  readonly destinationField: string | null;
  readonly columnIndex: number;
  readonly fragmentHash: string;
  /** Delivered records that hold a value for the destination. */
  readonly delivered: number;
  /** Values Migration Core changed on the way. */
  readonly changed: number;
  /** Values it could not interpret and flagged. */
  readonly flagged: number;
  /** Rows it set aside on account of this destination. */
  readonly setAside: number;
}

export interface AssociationEffect {
  readonly associationId: string;
  readonly fragmentHash: string;
  readonly edges: { readonly output: number; readonly deduplicated: number; readonly unresolved: number; readonly leftover: number };
  /** Edges whose endpoint Migration Core could not find. */
  readonly missingEndpoints: number;
}

/** A column no field mapped, as Migration Core accounted it: its populated cells are unmapped leftovers. */
export interface UnmappedEffect {
  readonly fileId: string;
  readonly columnLocator: string;
  readonly columnIndex: number;
  readonly cells: number;
  /** The fragment hash a preserved column of this locator has. */
  readonly fragmentHash: string;
}

/** A file no record mapping covered: every row of it is a leftover, and so is every one of its columns. */
export interface LeftoverFileEffect {
  readonly fileId: string;
  readonly rows: number;
}

/** The signals Migration Core reports a duplicate cluster under: a closed vocabulary, never the value the rows share. */
export const DUPLICATE_SIGNALS = Object.freeze(['EMAIL_EXACT', 'PHONE_E164', 'NAME_EXACT', 'COMPANY_DOMAIN', 'SOURCE_ID_ACROSS_NAMESPACES', 'SOURCE_ID_ACROSS_IDENTITY_SPACES', 'OTHER'] as const);

/**
 * One duplicate cluster Migration Core reported and merged nothing of
 * (D3-CAP-07): the signal it shares by its closed name, how many rows, and
 * the digest of their row addresses — the key a review group of the draft
 * is met on, since the addresses are the same in every run over the same
 * bytes while the cluster's own id is not. Never the shared value.
 */
export interface DuplicateClusterEffect {
  readonly signal: (typeof DUPLICATE_SIGNALS)[number];
  readonly rows: number;
  readonly rowsDigest: string;
}

/** At most this many clusters are listed one by one; identity.duplicateClusters counts them all. */
export const MAX_LISTED_DUPLICATE_CLUSTERS = 10_000;

/** The digest a set of row addresses is met on: the distinct addresses, sorted, bound to what they are. */
export function clusterRowsDigest(rowLocators: readonly string[]): string {
  return digestOf({ duplicateClusterRows: [...new Set(rowLocators)].sort() });
}

export interface MigrationEffects {
  /** The run truth's configHash: the loader hash of the document the run consumed. */
  readonly configHash: string;
  readonly records: readonly RecordEffect[];
  readonly fields: readonly FieldEffect[];
  readonly associations: readonly AssociationEffect[];
  readonly identity: { readonly provenMerges: number; readonly absorbedRows: number; readonly duplicateClusters: number; readonly duplicateRows: number };
  /** The duplicate clusters one by one, by rows digest, at most MAX_LISTED_DUPLICATE_CLUSTERS of them (D3-CAP-07). */
  readonly duplicateClusters: readonly DuplicateClusterEffect[];
  readonly unmapped: readonly UnmappedEffect[];
  readonly leftoverFiles: readonly LeftoverFileEffect[];
}

const CANONICAL_DESTINATION = /^[a-z]+\.[A-Za-z][A-Za-z0-9]*$/u;
const HASH = s.string({ pattern: /^[0-9a-f]{64}$/u });
const ID = s.string({ pattern: IDENTIFIER_PATTERN });
const COUNT = s.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });

/** The effects block's closed shape: every member typed, nothing a header or a value could ride in. */
export const MIGRATION_EFFECTS_SCHEMA: Schema = s.object({
  configHash: s.string({ pattern: /^(?:[a-z]{1,4}_)?[0-9a-f]{64}$/u }),
  records: s.array(s.object({ recordMappingId: ID, object: s.enumOf(['CONTACT', 'COMPANY', 'DEAL', 'LEAD']), fragmentHash: HASH, rows: s.object({ output: COUNT, mergedProven: COUNT, isolated: COUNT, leftover: COUNT, rejected: COUNT }), deliveredRecords: COUNT }), { maxItems: 1_024 }),
  fields: s.array(s.object({ recordMappingId: ID, destinationField: s.nullable(s.string({ pattern: CANONICAL_DESTINATION, maxLength: 128 })), columnIndex: COUNT, fragmentHash: HASH, delivered: COUNT, changed: COUNT, flagged: COUNT, setAside: COUNT }), { maxItems: 10_000 }),
  associations: s.array(s.object({ associationId: ID, fragmentHash: HASH, edges: s.object({ output: COUNT, deduplicated: COUNT, unresolved: COUNT, leftover: COUNT }), missingEndpoints: COUNT }), { maxItems: 1_024 }),
  identity: s.object({ provenMerges: COUNT, absorbedRows: COUNT, duplicateClusters: COUNT, duplicateRows: COUNT }),
  duplicateClusters: s.array(s.object({ signal: s.enumOf([...DUPLICATE_SIGNALS]), rows: COUNT, rowsDigest: HASH }), { maxItems: MAX_LISTED_DUPLICATE_CLUSTERS }),
  unmapped: s.array(s.object({ fileId: ID, columnLocator: ID, columnIndex: COUNT, cells: COUNT, fragmentHash: HASH }), { maxItems: 10_000 }),
  leftoverFiles: s.array(s.object({ fileId: ID, rows: COUNT }), { maxItems: 1_024 }),
});

interface NormalizedRecord {
  readonly id: string;
  readonly fileId: string;
  readonly sheet: string | null;
  readonly object: string;
  readonly fields: readonly { readonly destinationField: string; readonly column: { readonly index: number | null } }[];
}

/**
 * The effects of one run of Migration Core over a loaded configuration. The
 * run must be of that configuration — its truth names the loader's hash —
 * or there is nothing to report about it.
 */
export function effectsFromMigrationRun(input: { readonly loaded: LoadedConfig; readonly run: RunResult }): MigrationEffects {
  const { loaded, run } = input;
  const truth = run.truth;
  if (truth.configHash !== loaded.configHash) throw new Error('the run truth is about another configuration than the one loaded; its effects are not this configuration\'s');
  const normalized = loaded.normalizedJson as unknown as { readonly records: readonly NormalizedRecord[]; readonly files: readonly { readonly id: string; readonly path: string }[]; readonly associations: readonly { readonly id: string }[] };

  // Which record mapping a row address belongs to: the configuration file's path is the truth's file, and a mapping with no sheet reads the only one.
  const truthFileOfPath = new Map(truth.sourceFiles.map((file) => [file.path, file.fileId]));
  const pathOfConfigFile = new Map(normalized.files.map((file) => [file.id, file.path]));
  const mappingOfSheet = new Map<string, string>();
  for (const record of normalized.records) {
    const truthFile = truthFileOfPath.get(pathOfConfigFile.get(record.fileId) ?? '');
    if (truthFile !== undefined) mappingOfSheet.set(`${truthFile}|${record.sheet ?? ''}`, record.id);
  }
  const mappingOf = (address: { readonly fileId: string; readonly sheetName: string | null }): string | undefined => mappingOfSheet.get(`${address.fileId}|${address.sheetName ?? ''}`) ?? mappingOfSheet.get(`${address.fileId}|`);

  const rows = new Map<string, { output: number; mergedProven: number; isolated: number; leftover: number; rejected: number }>();
  const delivered = new Map<string, number>();
  const fieldCounts = new Map<string, { delivered: number; changed: number; flagged: number; setAside: number }>();
  const fieldKey = (recordMappingId: string, destinationField: string): string => `${recordMappingId}|${destinationField}`;
  for (const record of normalized.records) {
    rows.set(record.id, { output: 0, mergedProven: 0, isolated: 0, leftover: 0, rejected: 0 });
    delivered.set(record.id, 0);
    for (const field of record.fields) fieldCounts.set(fieldKey(record.id, field.destinationField), { delivered: 0, changed: 0, flagged: 0, setAside: 0 });
  }
  const leftoverFiles = new Map<string, number>();
  for (const entry of truth.lineage) {
    const tally = entry.recordMappingId === null ? undefined : rows.get(entry.recordMappingId);
    if (tally === undefined) {
      if (entry.recordMappingId === null && entry.disposition === 'LEFTOVER') leftoverFiles.set(entry.address.fileId, (leftoverFiles.get(entry.address.fileId) ?? 0) + 1);
      continue;
    }
    if (entry.disposition === 'OUTPUT') tally.output += 1;
    else if (entry.disposition === 'MERGED_PROVEN') tally.mergedProven += 1;
    else if (entry.disposition === 'ISOLATED') tally.isolated += 1;
    else if (entry.disposition === 'LEFTOVER') tally.leftover += 1;
    else tally.rejected += 1;
  }
  for (const record of truth.deliveredRecords) {
    delivered.set(record.recordMappingId, (delivered.get(record.recordMappingId) ?? 0) + 1);
    for (const destination of Object.keys(record.values)) {
      const counts = fieldCounts.get(fieldKey(record.recordMappingId, destination));
      if (counts !== undefined) counts.delivered += 1;
    }
  }
  for (const change of truth.changes) {
    const mapping = mappingOf(change.address);
    const counts = mapping === undefined ? undefined : fieldCounts.get(fieldKey(mapping, change.destinationField));
    if (counts !== undefined) counts.changed += 1;
  }
  for (const flag of truth.flags) {
    const mapping = mappingOf(flag.address);
    const counts = mapping === undefined ? undefined : fieldCounts.get(fieldKey(mapping, flag.destinationField));
    if (counts !== undefined) counts.flagged += 1;
  }
  for (const isolated of truth.isolated) {
    if (isolated.recordMappingId === null || isolated.field === null) continue;
    const counts = fieldCounts.get(fieldKey(isolated.recordMappingId, isolated.field));
    if (counts !== undefined) counts.setAside += 1;
  }
  const unmapped = new Map<string, { fileId: string; columnIndex: number; cells: number }>();
  for (const cell of truth.unmappedFields) {
    const entry = unmapped.get(cell.columnLocatorId) ?? { fileId: cell.address.fileId, columnIndex: cell.columnIndex, cells: 0 };
    entry.cells += 1;
    unmapped.set(cell.columnLocatorId, entry);
  }
  const edges = new Map<string, { output: number; deduplicated: number; unresolved: number; leftover: number }>();
  for (const association of normalized.associations) edges.set(association.id, { output: 0, deduplicated: 0, unresolved: 0, leftover: 0 });
  for (const edge of truth.edges) {
    const tally = edges.get(edge.associationMappingId);
    if (tally === undefined) continue;
    if (edge.disposition === 'OUTPUT') tally.output += 1;
    else if (edge.disposition === 'DEDUPLICATED') tally.deduplicated += 1;
    else if (edge.disposition === 'UNRESOLVED') tally.unresolved += 1;
    else tally.leftover += 1;
  }

  // The duplicate clusters, one walk: the family is written in cluster order, so a cluster is the run of entries sharing its id.
  const clusters: DuplicateClusterEffect[] = [];
  let clusterId: string | null = null;
  let clusterRows: string[] = [];
  let clusterSignal = '';
  const flushCluster = (): void => {
    if (clusterId === null) return;
    const signal = (DUPLICATE_SIGNALS as readonly string[]).includes(clusterSignal) ? (clusterSignal as DuplicateClusterEffect['signal']) : 'OTHER';
    clusters.push({ signal, rows: new Set(clusterRows).size, rowsDigest: clusterRowsDigest(clusterRows) });
  };
  for (const entry of truth.duplicateCandidates) {
    if (entry.clusterId !== clusterId) {
      flushCluster();
      clusterId = entry.clusterId;
      clusterRows = [];
      clusterSignal = entry.signal;
    }
    clusterRows.push(entry.rowLocatorId);
  }
  flushCluster();

  const identity = run.reconciliation.identity;
  const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return {
    configHash: truth.configHash,
    records: normalized.records.map((record, index) => ({ recordMappingId: record.id, object: record.object, fragmentHash: elementFragmentHash('RECORD', normalized, `/records/${String(index)}`) ?? '', rows: { ...(rows.get(record.id) ?? { output: 0, mergedProven: 0, isolated: 0, leftover: 0, rejected: 0 }) }, deliveredRecords: delivered.get(record.id) ?? 0 })),
    fields: normalized.records.flatMap((record, recordIndex) =>
      record.fields.map((field, fieldIndex) => ({
        recordMappingId: record.id,
        destinationField: CANONICAL_DESTINATION.test(field.destinationField) ? field.destinationField : null,
        columnIndex: field.column.index ?? 0,
        fragmentHash: elementFragmentHash('FIELD', normalized, `/records/${String(recordIndex)}/fields/${String(fieldIndex)}`) ?? '',
        ...(fieldCounts.get(fieldKey(record.id, field.destinationField)) ?? { delivered: 0, changed: 0, flagged: 0, setAside: 0 }),
      })),
    ),
    associations: normalized.associations.map((association, index) => {
      const tally = edges.get(association.id) ?? { output: 0, deduplicated: 0, unresolved: 0, leftover: 0 };
      return { associationId: association.id, fragmentHash: elementFragmentHash('ASSOCIATION', normalized, `/associations/${String(index)}`) ?? '', edges: { ...tally }, missingEndpoints: tally.unresolved };
    }),
    identity: { provenMerges: identity.provenMerges, absorbedRows: identity.absorbedRows, duplicateClusters: identity.duplicateCandidateClusters, duplicateRows: identity.duplicateCandidateRows },
    duplicateClusters: clusters.sort((a, b) => byCode(a.rowsDigest, b.rowsDigest)).slice(0, MAX_LISTED_DUPLICATE_CLUSTERS),
    unmapped: [...unmapped.entries()].sort((a, b) => byCode(a[0], b[0])).map(([columnLocator, entry]) => ({ fileId: entry.fileId, columnLocator, columnIndex: entry.columnIndex, cells: entry.cells, fragmentHash: columnFragmentHash('PRESERVED_COLUMN', entry.fileId, columnLocator) })),
    leftoverFiles: [...leftoverFiles.entries()].sort((a, b) => byCode(a[0], b[0])).map(([fileId, count]) => ({ fileId, rows: count })),
  };
}
