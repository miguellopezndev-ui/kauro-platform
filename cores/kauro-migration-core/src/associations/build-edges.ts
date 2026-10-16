import { invariant } from '../util/assert.js';
import { MigrationError } from '../domain/errors.js';
import type { AssociationMappingConfig, IdentityNormalization, MigrationConfig } from '../domain/config.js';
import { normalizeIdentityValue } from '../domain/config.js';
import type { EdgeDisposition } from '../domain/disposition.js';
import type { ReasonCode } from '../domain/reason-codes.js';
import type { RelationshipType } from '../domain/associations.js';
import { cellAt } from '../domain/source-cell.js';
import type { DestinationAdapter } from '../adapters/adapter.js';
import type { IngestedFile, IngestedSheet } from '../ingest/sheet.js';
import { resolveColumn } from '../mapping/resolve-columns.js';
import { findSheet, rowAddress } from '../run/build-records.js';
import type { FamilyWriter, SpooledFamily } from '../run/spool.js';
import { openFamily, orderKey, orderNumber, orderText } from '../run/spool.js';
import type { ScratchStore } from '../scratch/scratch-store.js';
import type { RecordsByRow, RowRecord } from '../run/records-by-row.js';
import type { Keyed, KeyedSpill } from '../verify/join.js';
import { coGroup, openKeyedSpill } from '../verify/join.js';
import { DEFAULT_SPOOL_LIMITS } from '../run/spool.js';

// The engine's own spool configuration, stated at every call rather than
// inherited. `openKeyedSpill` lives in the verifier and defaults to the
// verifier's smaller runs, which exist because a verification interleaves
// several families and the run that matters is the sum of them. This file is the
// engine: it spills one family at a time from a loop it controls, so the reason
// does not apply and the extra merge pass it was paying for was waste.
const ENGINE_SPILL = DEFAULT_SPOOL_LIMITS;

/**
 * The most rows a relationship join holds from either side of one key.
 *
 * A parent with a hundred thousand children is an ordinary CRM shape, and the
 * join used to hold all hundred thousand at once (B02-R3). Past this many the
 * key is joined in pieces (see `coGroup`), so what a key can cost in memory is
 * this and not its size.
 */
const JOIN_BOUND = 8_192;

/**
 * A spill whose key is escaped on the way in.
 *
 * Every key in this file is a value out of a spreadsheet — the cell an
 * association matches on, the cell a relationship file names its ends by — and
 * a segment refuses a key holding a character its format owns. A quoted CSV
 * field may contain a line break, and the reader hands it back exactly as the
 * file had it: `"Acme\nInc"` in a key column is an ordinary export from an
 * ordinary system, and it aborted the migration in the external sort.
 *
 * Four spills in this file took the raw cell. The two families opened through
 * `openFamily` a hundred lines above escape theirs, so the file already knew
 * the rule and applied it to half its keys.
 *
 * Escaping is done here, once, rather than at each call site: escaping at the
 * call sites is how one side of a join ends up escaped and the other raw, which
 * does not fail loudly — it simply stops matching on the hostile key and reports
 * a relationship as unresolved. `orderText` is injective, so rows group after
 * escaping exactly when they grouped before it.
 *
 * What this changes for the reader: `group.key` is now the escaped spelling.
 * Nothing may put it in an artifact or an id. The raw spelling travels in the
 * record instead, which is what `keyRaw` is for on both sides of every join
 * below.
 */
function openEscapedSpill<T>(scratch: ScratchStore, schema: string): KeyedSpill<T> {
  const spill = openKeyedSpill<T>(scratch, schema, ENGINE_SPILL);
  return {
    add(entry: Keyed<T>): void {
      spill.add({ k: orderText(entry.k), v: entry.v });
    },
    seal(): SpooledFamily<Keyed<T>> {
      return spill.seal();
    },
  };
}
import type { SourceRow } from '../domain/source-cell.js';
import { edgeIdFor } from '../identity/migration-key.js';
import type { EdgeEntry, RowAddress } from '../reconcile/truth.js';

export interface BuildEdgesInput {
  readonly config: MigrationConfig;
  readonly filesByConfigId: ReadonlyMap<string, IngestedFile>;
  readonly recordsByRow: RecordsByRow;
  readonly scratch: ScratchStore;
  readonly adapter: DestinationAdapter;
}

export interface BuildEdgesResult {
  /**
   * Relationship candidates counted where they were produced. The anchor for
   * relationship conservation: counting `edges` instead would compare the array
   * the dispositions are tallied out of against itself.
   */
  readonly candidateCount: number;
  readonly edges: SpooledFamily<EdgeEntry>;
  /** Sheets whose rows exist only to describe relationships. */
  readonly associationOnlySheets: ReadonlySet<string>;
}

interface CandidateEdge {
  readonly associationMappingId: string;
  readonly relationshipType: RelationshipType;
  readonly label: string | null;
  readonly address: RowAddress;
  readonly fromKeyRaw: string;
  readonly toKeyRaw: string;
  readonly from: Endpoint;
  readonly to: Endpoint;
}

/**
 * Which record an end of a relationship points at.
 *
 * The migration key, not the record. Everything that reads an endpoint reads
 * that one field, and carrying the record meant a candidate held two of them --
 * so the candidates could not be written down without writing the records
 * again with them.
 */
type Endpoint =
  | {
      readonly kind: 'RESOLVED';
      readonly migrationKey: string;
      /**
       * Why the record this end points at was set aside, if it was.
       *
       * A relationship to a record that is not delivered is not delivered
       * either, and the reason has to name what happened to the record. The
       * detail is carried rather than the record so a candidate can be written
       * down.
       */
      readonly isolatedDetail: string | null;
    }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'AMBIGUOUS'; readonly count: number };

/**
 * Association mappings read key columns that are not destination fields. They
 * are reported here so the record builder does not also list them as unmapped
 * source data.
 */
export function computeAssociationConsumedColumns(
  config: MigrationConfig,
  filesByConfigId: ReadonlyMap<string, IngestedFile>,
): Map<string, Set<number>> {
  const consumed = new Map<string, Set<number>>();
  const add = (file: IngestedFile, sheet: IngestedSheet, columnIndex: number): void => {
    const key = `${file.file.fileId}:${sheet.sheet.sheetId}`;
    const existing = consumed.get(key);
    if (existing === undefined) consumed.set(key, new Set([columnIndex]));
    else existing.add(columnIndex);
  };

  for (const association of config.associations) {
    if (association.kind === 'COLUMN_REFERENCE') {
      const owner = requireRecordMapping(config, association.recordMappingId, association.id);
      const ownerFile = requireFile(filesByConfigId, owner.fileId, association.id);
      const ownerSheet = findSheet(ownerFile, owner.sheet, `association "${association.id}"`);
      add(
        ownerFile,
        ownerSheet,
        resolveColumn(association.keyColumn, ownerSheet.columns, `association "${association.id}" keyColumn`).columnIndex,
      );
      if (association.targetMatchKey === 'COLUMN' && association.targetMatchColumn !== null) {
        const target = requireRecordMapping(config, association.targetRecordMappingId, association.id);
        const targetFile = requireFile(filesByConfigId, target.fileId, association.id);
        const targetSheet = findSheet(targetFile, target.sheet, `association "${association.id}"`);
        add(
          targetFile,
          targetSheet,
          resolveColumn(
            association.targetMatchColumn,
            targetSheet.columns,
            `association "${association.id}" targetMatchColumn`,
          ).columnIndex,
        );
      }
    }
  }
  return consumed;
}

export function buildEdges(input: BuildEdgesInput): BuildEdgesResult {
  const { config, filesByConfigId, recordsByRow, adapter, scratch } = input;

  const associationOnlySheets = new Set<string>();

  // Every candidate this plan produces, written down in the order the
  // dispositions are decided in.
  //
  // It used to be an array, sorted afterwards: at a dense association graph that
  // is the whole relationship set held twice at the moment the run is already
  // holding the most. The order is the key now, so the family arrives sorted and
  // nothing is copied to sort it.
  const candidatesOut = openFamily<CandidateEdge>(scratch, {
    schema: 'edge-candidates',
    key: (candidate) =>
      orderKey(
        orderText(candidate.associationMappingId),
        orderText(candidate.address.filePath),
        orderText(candidate.address.sheetId),
        orderNumber(candidate.address.rowNumberSource),
        orderText(candidate.fromKeyRaw),
        orderText(candidate.toKeyRaw),
      ),
  });

  for (const association of config.associations) {
    if (association.kind === 'COLUMN_REFERENCE') {
      buildColumnReferenceEdges(association, config, filesByConfigId, recordsByRow, scratch, candidatesOut);
    } else {
      const file = requireFile(filesByConfigId, association.fileId, association.id);
      const sheet = findSheet(file, association.sheet, `association "${association.id}"`);
      associationOnlySheets.add(`${file.file.fileId}:${sheet.sheet.sheetId}`);
      buildEdgeFileEdges(association, config, filesByConfigId, recordsByRow, scratch, file, sheet, candidatesOut);
    }
  }

  const candidates = candidatesOut.seal();

  // Which candidate delivers each relationship, decided by writing every
  // candidate under the relationship it asserts and reading them back in that
  // order. The first of a group in source order delivers it and the rest are
  // deduplicated into it, which is what a map from relationship to edge id used
  // to say -- one entry per relationship, held for the whole stage.
  const claims = openFamily<{ pair: string; sourceEdgeId: string; address: RowAddress; fromKeyRaw: string; toKeyRaw: string }>(
    scratch,
    {
      schema: 'edge-claims',
      key: (claim) =>
        orderKey(
          orderText(claim.pair),
          orderText(claim.address.filePath),
          orderText(claim.address.sheetId),
          orderNumber(claim.address.rowNumberSource),
          orderText(claim.fromKeyRaw),
          orderText(claim.toKeyRaw),
        ),
    },
  );
  const decisionsOut = openFamily<{ sourceEdgeId: string; deduplicatedInto: string | null }>(scratch, {
    schema: 'edge-decisions',
    key: (decision) => decision.sourceEdgeId,
  });

  for (const candidate of candidates) {
    const sourceEdgeId = edgeIdFor(
      candidate.associationMappingId,
      candidate.address.rowLocatorId,
      candidate.fromKeyRaw,
      candidate.toKeyRaw,
    );
    if (adapter.relationships[candidate.relationshipType].kind === 'UNSUPPORTED') continue;
    if (describeUnresolved(candidate) !== null) continue;
    const from = (candidate.from as { kind: 'RESOLVED'; migrationKey: string }).migrationKey;
    const to = (candidate.to as { kind: 'RESOLVED'; migrationKey: string }).migrationKey;
    if (from === to) continue;
    claims.add({
      pair: `${candidate.relationshipType}|${from}|${to}|${candidate.label ?? ''}`,
      sourceEdgeId,
      address: candidate.address,
      fromKeyRaw: candidate.fromKeyRaw,
      toKeyRaw: candidate.toKeyRaw,
    });
  }

  let currentPair: string | null = null;
  let deliverer: string | null = null;
  const claimed = claims.seal();
  for (const claim of claimed) {
    if (claim.pair !== currentPair) {
      currentPair = claim.pair;
      deliverer = claim.sourceEdgeId;
      decisionsOut.add({ sourceEdgeId: claim.sourceEdgeId, deduplicatedInto: null });
      continue;
    }
    decisionsOut.add({ sourceEdgeId: claim.sourceEdgeId, deduplicatedInto: deliverer });
  }
  const decisions = decisionsOut.seal();

  // The edges themselves, written under the id each candidate has, and joined
  // against the decisions under the same id.
  const edgesOut = openFamily<EdgeEntry>(scratch, {
    schema: 'edges',
    key: (edge) => edge.sourceEdgeId,
  });
  const byId = openFamily<{ sourceEdgeId: string; candidate: CandidateEdge }>(scratch, {
    schema: 'edge-candidates-by-id',
    key: (held) => held.sourceEdgeId,
  });
  for (const candidate of candidates) {
    byId.add({
      sourceEdgeId: edgeIdFor(
        candidate.associationMappingId,
        candidate.address.rowLocatorId,
        candidate.fromKeyRaw,
        candidate.toKeyRaw,
      ),
      candidate,
    });
  }

  // The claims are spent: every one of them has been turned into a decision,
  // and the decisions are what the join below reads.
  claimed.release();

  let written = 0;
  const decisionCursor = decisions[Symbol.iterator]();
  let heldDecision = decisionCursor.next();
  const heldById = byId.seal();
  for (const held of heldById) {
    const candidate = held.candidate;
    const sourceEdgeId = held.sourceEdgeId;

    // The decisions are written under the same id and in the same order, so the
    // one for this candidate is at or after the cursor.
    while (heldDecision.done !== true && heldDecision.value.sourceEdgeId < sourceEdgeId) {
      heldDecision = decisionCursor.next();
    }
    const decision =
      heldDecision.done !== true && heldDecision.value.sourceEdgeId === sourceEdgeId ? heldDecision.value : null;

    const support = adapter.relationships[candidate.relationshipType];
    if (support.kind === 'UNSUPPORTED') {
      edgesOut.add(
        entry(candidate, sourceEdgeId, 'LEFTOVER', 'ASSOCIATION_UNSUPPORTED_BY_TARGET', support.reason, null, null, null),
      );
      written += 1;
      continue;
    }

    const unresolved = describeUnresolved(candidate);
    if (unresolved !== null) {
      edgesOut.add(
        entry(candidate, sourceEdgeId, 'UNRESOLVED', unresolved.reasonCode, unresolved.detail, null, null, null),
      );
      written += 1;
      continue;
    }

    const from = (candidate.from as { kind: 'RESOLVED'; migrationKey: string }).migrationKey;
    const to = (candidate.to as { kind: 'RESOLVED'; migrationKey: string }).migrationKey;

    if (from === to) {
      edgesOut.add(
        entry(
          candidate,
          sourceEdgeId,
          'UNRESOLVED',
          'ASSOCIATION_SELF_REFERENCE',
          'both ends of the relationship resolve to the same record',
          from,
          to,
          null,
        ),
      );
      written += 1;
      continue;
    }

    if (decision !== null && decision.deduplicatedInto !== null) {
      edgesOut.add(
        entry(
          candidate,
          sourceEdgeId,
          'DEDUPLICATED',
          'ASSOCIATION_DEDUPLICATED_AFTER_MERGE',
          'this relationship is already delivered once by another source row',
          from,
          to,
          decision.deduplicatedInto,
        ),
      );
      written += 1;
      continue;
    }

    edgesOut.add(
      entry(
        candidate,
        sourceEdgeId,
        'OUTPUT',
        'ASSOCIATION_RESOLVED',
        'both ends resolve to delivered records',
        from,
        to,
        null,
      ),
    );
    written += 1;
  }

  // The same anchor the rows have, for the same reason. Tallying dispositions
  // out of the edges and comparing the sum to the edge count is an identity that
  // holds however many relationships were lost on the way here. This number is
  // taken where the candidates are produced, before any of them is given a
  // disposition, and a relationship that disappears between the two is a defect
  // this file will not ship.
  invariant(
    written === candidates.count,
    'ASSOCIATIONS_ACCOUNTED_FOR',
    `${String(candidates.count)} relationship candidates were built but ${String(written)} were given a disposition`,
    { candidates: candidates.count, edges: written },
  );

  // Everything this stage built to decide the dispositions is spent now that
  // the edges are written: the candidates were read twice (once to raise the
  // claims, once to write them under their edge id) and this is after the
  // second, the by-id copy was the left side of the join that just finished,
  // and the decisions were its right side. The count the invariant above needs
  // is a number, not the family. What survives is the edges family, which is
  // what the caller asked for.
  candidates.release();
  heldById.release();
  decisions.release();

  return { edges: edgesOut.seal(), associationOnlySheets, candidateCount: candidates.count };
}

function describeUnresolved(
  candidate: CandidateEdge,
): { reasonCode: ReasonCode; detail: string } | null {
  for (const [side, endpoint, key] of [
    ['from', candidate.from, candidate.fromKeyRaw],
    ['to', candidate.to, candidate.toKeyRaw],
  ] as const) {
    if (endpoint.kind === 'NOT_FOUND') {
      return {
        reasonCode: 'ASSOCIATION_ENDPOINT_NOT_FOUND',
        detail:
          key.length === 0
            ? `the ${side} end of the relationship has no key value on this row`
            : `no source record matches the ${side} key "${key}"`,
      };
    }
    if (endpoint.kind === 'AMBIGUOUS') {
      return {
        reasonCode: 'ASSOCIATION_ENDPOINT_AMBIGUOUS',
        detail: `the ${side} key "${key}" matches ${String(endpoint.count)} source records`,
      };
    }
  }

  for (const [side, endpoint] of [['from', candidate.from], ['to', candidate.to]] as const) {
    if (endpoint.kind === 'RESOLVED' && endpoint.isolatedDetail !== null) {
      return {
        reasonCode: 'ASSOCIATION_ENDPOINT_NOT_DELIVERED',
        detail: `the ${side} end resolves to ${endpoint.migrationKey}, which was set aside: ${endpoint.isolatedDetail}`,
      };
    }
  }

  return null;
}

function entry(
  candidate: CandidateEdge,
  sourceEdgeId: string,
  disposition: EdgeDisposition,
  reasonCode: ReasonCode,
  detail: string,
  fromMigrationKey: string | null,
  toMigrationKey: string | null,
  deduplicatedIntoEdgeId: string | null,
): EdgeEntry {
  return {
    sourceEdgeId,
    associationMappingId: candidate.associationMappingId,
    relationshipType: candidate.relationshipType,
    label: candidate.label,
    address: candidate.address,
    fromKeyRaw: candidate.fromKeyRaw,
    toKeyRaw: candidate.toKeyRaw,
    fromMigrationKey,
    toMigrationKey,
    disposition,
    reasonCode,
    detail,
    deduplicatedIntoEdgeId,
  };
}

// ------------------------------------------------------------- candidates
//
// Both builders resolve an endpoint the same way: the rows that hold a key and
// the records that answer to it are written down under that key and read back
// together, so a key with no record, one record or several is a group of the
// size that says which. An index from every key to every record used to stand
// here, and at a dense association graph it was the records held a second time.

interface TargetRef {
  /** The key this record answered to, in the spelling the source had. */
  readonly keyRaw: string;
  readonly migrationKey: string;
  readonly isolatedDetail: string | null;
}

/**
 * What a key's targets come to: how many distinct records answer to it, and the
 * first of them. One record is an endpoint; more than one is an ambiguity that
 * needs only the count; none is absent. So the join holds this, one per key, and
 * not the records.
 */
interface TargetSummary {
  readonly count: number;
  readonly first: TargetRef;
}

function endpointOf(summary: TargetSummary | undefined, key: string): Endpoint {
  if (key.length === 0) return { kind: 'NOT_FOUND' };
  if (summary === undefined || summary.count === 0) return { kind: 'NOT_FOUND' };
  if (summary.count > 1) return { kind: 'AMBIGUOUS', count: summary.count };
  return { kind: 'RESOLVED', migrationKey: summary.first.migrationKey, isolatedDetail: summary.first.isolatedDetail };
}

/**
 * The records a sheet's rows resolve to, under the value each row holds in one
 * column.
 *
 * Endpoints are matched exactly, as identity is. Folding case here made the same
 * package invent an endpoint — a row referencing `co1` resolved to the record
 * whose id is `CO1`, which no source record has — and refuse a real one, because
 * two records differing only in case made every reference to either of them
 * ambiguous. Identity is case-sensitive, and a relationship that resolves
 * differently from identity is a relationship the source did not assert.
 *
 * A record that answers to the same key twice counts once: it is written under
 * (key, migration key), so its repeats are adjacent and `distinctTargets` skips
 * them in one pass.
 */
function spillTargets(
  scratch: ScratchStore,
  recordsByRow: RecordsByRow,
  file: IngestedFile,
  sheet: IngestedSheet,
  schema: string,
  keyOf: (row: SourceRow, record: RowRecord) => string,
): Iterable<Keyed<TargetSummary>> {
  // Ordered by the key and then by the record, not by the order the rows were
  // read: that is what lets the repeats of a record be found by looking at the
  // entry before, rather than at every record already kept.
  const writer = openFamily<Keyed<TargetRef>>(
    scratch,
    {
      schema,
      key: (entry) => orderKey(entry.k, orderText(entry.v.migrationKey)),
    },
    ENGINE_SPILL,
  );
  const cursor = recordsByRow.open();
  for (const row of sheet.rows) {
    const record = cursor.at(rowAddress(file, sheet, row.locator));
    if (record === null) continue;
    const key = keyOf(row, record);
    if (key.length === 0) continue;
    writer.add({
      k: orderText(key),
      v: { keyRaw: key, migrationKey: record.migrationKey, isolatedDetail: record.isolation?.detail ?? null },
    });
  }
  return summarizedTargets(writer.seal());
}

/**
 * The distinct records of a target family ordered by (key, migration key): every
 * entry whose key and record are those of the entry before it is dropped.
 *
 * One pass with one entry of memory, and two comparisons per entry. The test
 * this replaced looked for each record among all those already kept, which for
 * n distinct records under one key is n(n-1)/2 comparisons (B02-R3).
 */
export function* distinctTargets(entries: Iterable<Keyed<TargetRef>>): IterableIterator<Keyed<TargetRef>> {
  let previous: { readonly k: string; readonly migrationKey: string } | null = null;
  for (const entry of entries) {
    const migrationKey = entry.v.migrationKey;
    if (previous !== null && previous.k === entry.k && previous.migrationKey === migrationKey) continue;
    previous = { k: entry.k, migrationKey };
    yield entry;
  }
}

/** One entry per key: how many distinct records answer to it, and the first. */
function* summarize(entries: Iterable<Keyed<TargetRef>>): IterableIterator<Keyed<TargetSummary>> {
  let current: Keyed<TargetRef> | null = null;
  let count = 0;
  for (const entry of distinctTargets(entries)) {
    if (current !== null && current.k === entry.k) {
      count += 1;
      continue;
    }
    if (current !== null) yield { k: current.k, v: { count, first: current.v } };
    current = entry;
    count = 1;
  }
  if (current !== null) yield { k: current.k, v: { count, first: current.v } };
}

/**
 * The summary of a sorted target family, walked when it is joined. A key shared
 * by a hundred thousand parents is a hundred thousand entries in, one entry out.
 */
function summarizedTargets(sorted: SpooledFamily<Keyed<TargetRef>>): Iterable<Keyed<TargetSummary>> {
  return { [Symbol.iterator]: () => summarize(sorted) };
}

function buildColumnReferenceEdges(
  association: Extract<AssociationMappingConfig, { kind: 'COLUMN_REFERENCE' }>,
  config: MigrationConfig,
  filesByConfigId: ReadonlyMap<string, IngestedFile>,
  recordsByRow: RecordsByRow,
  scratch: ScratchStore,
  out: FamilyWriter<CandidateEdge>,
): void {
  const owner = requireRecordMapping(config, association.recordMappingId, association.id);
  const ownerFile = requireFile(filesByConfigId, owner.fileId, association.id);
  const ownerSheet = findSheet(ownerFile, owner.sheet, `association "${association.id}"`);
  const keyColumn = resolveColumn(
    association.keyColumn,
    ownerSheet.columns,
    `association "${association.id}" keyColumn`,
  );

  const targets = spillColumnReferenceTargets(association, config, filesByConfigId, recordsByRow, scratch);
  // A reference names its target the way the target's key column is keyed, so
  // it is normalized only if that column declared a normalization.
  const referenceNormalization =
    association.targetMatchKey === 'SOURCE_RECORD_ID'
      ? (config.records.find((record) => record.id === association.targetRecordMappingId)?.sourceRecordIdColumn?.identityNormalization ?? null)
      : null;

  // One entry per owning row that names a key, under the key it names.
  const owners = openEscapedSpill<{
    address: RowAddress;
    /** The key this row named, in the spelling the source had. */
    keyRaw: string;
    ownerKeyRaw: string;
    ownerMigrationKey: string;
    ownerIsolatedDetail: string | null;
  }>(scratch, `edge-owners-${association.id}`);
  const cursor = recordsByRow.open();
  for (const row of ownerSheet.rows) {
    const address = rowAddress(ownerFile, ownerSheet, row.locator);
    const ownerRecord = cursor.at(address);
    if (ownerRecord === null) continue;
    const keyRaw = referenceKey(cellAt(row, keyColumn.columnIndex).raw, referenceNormalization);
    if (keyRaw.length === 0) continue;
    owners.add({
      k: keyRaw,
      v: {
        address,
        keyRaw,
        ownerKeyRaw: ownerRecord.survivor.sourceRecordId ?? ownerRecord.migrationKey,
        ownerMigrationKey: ownerRecord.migrationKey,
        ownerIsolatedDetail: ownerRecord.isolation?.detail ?? null,
      },
    });
  }

  const ownerIsFrom = association.ownerSide === 'FROM';
  for (const group of coGroup(owners.seal(), targets, { bound: JOIN_BOUND, scratch })) {
    if (group.left.length === 0) continue;
    // The key as the source spelled it, recovered from either side of the join.
    // `group.key` is the escaped spelling and would reach `edgeIdFor` and the
    // from_key_raw / to_key_raw columns of associations.csv, which are supposed
    // to hold what the cell held.
    const matchKeyRaw = group.left[0]?.keyRaw ?? group.right[0]?.first.keyRaw ?? group.key;
    const targetEndpoint = endpointOf(group.right[0], matchKeyRaw);
    for (const owned of group.left) {
      const ownerEndpoint: Endpoint = {
        kind: 'RESOLVED',
        migrationKey: owned.ownerMigrationKey,
        isolatedDetail: owned.ownerIsolatedDetail,
      };
      out.add({
        associationMappingId: association.id,
        relationshipType: association.relationshipType,
        label: association.label,
        address: owned.address,
        fromKeyRaw: ownerIsFrom ? owned.ownerKeyRaw : matchKeyRaw,
        toKeyRaw: ownerIsFrom ? matchKeyRaw : owned.ownerKeyRaw,
        from: ownerIsFrom ? ownerEndpoint : targetEndpoint,
        to: ownerIsFrom ? targetEndpoint : ownerEndpoint,
      });
    }
  }
}

function spillColumnReferenceTargets(
  association: Extract<AssociationMappingConfig, { kind: 'COLUMN_REFERENCE' }>,
  config: MigrationConfig,
  filesByConfigId: ReadonlyMap<string, IngestedFile>,
  recordsByRow: RecordsByRow,
  scratch: ScratchStore,
): Iterable<Keyed<TargetSummary>> {
  if (association.targetMatchKey === 'SOURCE_RECORD_ID') {
    return spillSourceIdTargets(
      config,
      filesByConfigId,
      recordsByRow,
      scratch,
      association.targetRecordMappingId,
      association.id,
      `edge-targets-${association.id}`,
    );
  }

  const target = requireRecordMapping(config, association.targetRecordMappingId, association.id);
  const targetFile = requireFile(filesByConfigId, target.fileId, association.id);
  const targetSheet = findSheet(targetFile, target.sheet, `association "${association.id}"`);
  const column = resolveColumn(
    association.targetMatchColumn ?? { header: null, occurrence: null, index: null },
    targetSheet.columns,
    `association "${association.id}" targetMatchColumn`,
  );
  return spillTargets(
    scratch,
    recordsByRow,
    targetFile,
    targetSheet,
    `edge-targets-${association.id}`,
    (row) => referenceKey(cellAt(row, column.columnIndex).raw, null),
  );
}

function spillSourceIdTargets(
  config: MigrationConfig,
  filesByConfigId: ReadonlyMap<string, IngestedFile>,
  recordsByRow: RecordsByRow,
  scratch: ScratchStore,
  recordMappingId: string,
  associationId: string,
  schema: string,
): Iterable<Keyed<TargetSummary>> {
  const mapping = requireRecordMapping(config, recordMappingId, associationId);
  const file = requireFile(filesByConfigId, mapping.fileId, associationId);
  const sheet = findSheet(file, mapping.sheet, `association "${associationId}"`);
  // Each row answers to its own source id. A record that absorbed rows answers
  // to every one of their ids, and a reference to any of them reaches the
  // survivor; keying each row by the record's first id left the others
  // unreachable (B01-R8).
  return spillTargets(scratch, recordsByRow, file, sheet, schema, (_row, record) => record.member.sourceRecordId ?? '');
}

function buildEdgeFileEdges(
  association: Extract<AssociationMappingConfig, { kind: 'EDGE_FILE' }>,
  config: MigrationConfig,
  filesByConfigId: ReadonlyMap<string, IngestedFile>,
  recordsByRow: RecordsByRow,
  scratch: ScratchStore,
  file: IngestedFile,
  sheet: IngestedSheet,
  out: FamilyWriter<CandidateEdge>,
): void {
  const fromColumn = resolveColumn(
    association.fromKeyColumn,
    sheet.columns,
    `association "${association.id}" fromKeyColumn`,
  );
  const toColumn = resolveColumn(
    association.toKeyColumn,
    sheet.columns,
    `association "${association.id}" toKeyColumn`,
  );
  const labelColumn =
    association.labelColumn === null
      ? null
      : resolveColumn(association.labelColumn, sheet.columns, `association "${association.id}" labelColumn`);
  const fromNormalization =
    config.records.find((record) => record.id === association.fromRecordMappingId)?.sourceRecordIdColumn?.identityNormalization ?? null;
  const toNormalization =
    config.records.find((record) => record.id === association.toRecordMappingId)?.sourceRecordIdColumn?.identityNormalization ?? null;

  const fromTargets = spillSourceIdTargets(
    config,
    filesByConfigId,
    recordsByRow,
    scratch,
    association.fromRecordMappingId,
    association.id,
    `edge-from-targets-${association.id}`,
  );
  const toTargets = spillSourceIdTargets(
    config,
    filesByConfigId,
    recordsByRow,
    scratch,
    association.toRecordMappingId,
    association.id,
    `edge-to-targets-${association.id}`,
  );

  // Every row of the relationship file, and the two questions it asks, written
  // down under the row it belongs to and under the key it names.
  interface EdgeFileRow {
    readonly address: RowAddress;
    readonly fromKeyRaw: string;
    readonly toKeyRaw: string;
    readonly label: string | null;
  }
  /** A row asking what one of its two key cells resolves to. */
  interface EdgeFileQuery {
    readonly rowLocatorId: string;
    /** The key the cell held, in the spelling the source had. */
    readonly keyRaw: string;
  }
  const rows = openEscapedSpill<EdgeFileRow>(scratch, `edge-file-rows-${association.id}`);
  const fromQueries = openEscapedSpill<EdgeFileQuery>(scratch, `edge-file-from-${association.id}`);
  const toQueries = openEscapedSpill<EdgeFileQuery>(scratch, `edge-file-to-${association.id}`);
  for (const row of sheet.rows) {
    const address = rowAddress(file, sheet, row.locator);
    const fromKeyRaw = referenceKey(cellAt(row, fromColumn.columnIndex).raw, fromNormalization);
    const toKeyRaw = referenceKey(cellAt(row, toColumn.columnIndex).raw, toNormalization);
    const label =
      labelColumn === null
        ? association.label
        : nullIfEmpty((cellAt(row, labelColumn.columnIndex).raw ?? '').trim()) ?? association.label;
    rows.add({ k: address.rowLocatorId, v: { address, fromKeyRaw, toKeyRaw, label } });
    if (fromKeyRaw.length > 0) fromQueries.add({ k: fromKeyRaw, v: { rowLocatorId: address.rowLocatorId, keyRaw: fromKeyRaw } });
    if (toKeyRaw.length > 0) toQueries.add({ k: toKeyRaw, v: { rowLocatorId: address.rowLocatorId, keyRaw: toKeyRaw } });
  }

  const answered = (
    queries: SpooledFamily<Keyed<EdgeFileQuery>>,
    targets: Iterable<Keyed<TargetSummary>>,
    schema: string,
  ): SpooledFamily<Keyed<Endpoint>> => {
    const out = openEscapedSpill<Endpoint>(scratch, schema);
    for (const group of coGroup(queries, targets, { bound: JOIN_BOUND, scratch })) {
      if (group.left.length === 0) continue;
      const matchKeyRaw = group.left[0]?.keyRaw ?? group.right[0]?.first.keyRaw ?? group.key;
      const endpoint = endpointOf(group.right[0], matchKeyRaw);
      for (const query of group.left) out.add({ k: query.rowLocatorId, v: endpoint });
    }
    return out.seal();
  };

  const fromAnswers = answered(fromQueries.seal(), fromTargets, `edge-file-from-answers-${association.id}`);
  const toAnswers = answered(toQueries.seal(), toTargets, `edge-file-to-answers-${association.id}`);

  // The row and its two answers, brought together under the row.
  const withFrom = openEscapedSpill<{ row: EdgeFileRow; from: Endpoint }>(
    scratch,
    `edge-file-with-from-${association.id}`,
  );
  for (const group of coGroup(rows.seal(), fromAnswers)) {
    for (const row of group.left) {
      // The row's own locator, not `group.key`: the group's key is already
      // escaped, and escaping it again would spell it differently from the
      // answers this is about to be joined against.
      withFrom.add({ k: row.address.rowLocatorId, v: { row, from: group.right[0] ?? { kind: 'NOT_FOUND' } } });
    }
  }

  for (const group of coGroup(withFrom.seal(), toAnswers)) {
    for (const held of group.left) {
      out.add({
        associationMappingId: association.id,
        relationshipType: association.relationshipType,
        label: held.row.label,
        address: held.row.address,
        fromKeyRaw: held.row.fromKeyRaw,
        toKeyRaw: held.row.toKeyRaw,
        from: held.from,
        to: group.right[0] ?? { kind: 'NOT_FOUND' },
      });
    }
  }
}

function requireRecordMapping(config: MigrationConfig, id: string, associationId: string) {
  const mapping = config.records.find((record) => record.id === id);
  if (mapping === undefined) {
    throw new MigrationError(
      'MAPPING_INVALID',
      `association "${associationId}" refers to unknown record mapping "${id}"`,
      'Correct the record mapping id.',
      { associationId, recordMappingId: id },
    );
  }
  return mapping;
}

function requireFile(
  filesByConfigId: ReadonlyMap<string, IngestedFile>,
  fileId: string,
  associationId: string,
): IngestedFile {
  const file = filesByConfigId.get(fileId);
  if (file === undefined) {
    throw new MigrationError(
      'MAPPING_INVALID',
      `association "${associationId}" refers to file "${fileId}", which was not ingested`,
      'Correct the file id.',
      { associationId, fileId },
    );
  }
  return file;
}

/**
 * The key a reference cell names, exactly as the cell holds it.
 *
 * A reference is compared with the key it points at, and that key is an
 * identifier the source wrote (D67), so it is neither trimmed nor composed
 * unless the target's key column declared an identity normalization, in which
 * case the same normalization applies to the reference. A cell of only
 * whitespace names nothing.
 */
function referenceKey(raw: string | null, normalization: IdentityNormalization | null): string {
  if (raw === null || raw.trim().length === 0) return '';
  const normalized = normalizeIdentityValue(raw, normalization);
  return normalized.trim().length === 0 ? '' : normalized;
}

function nullIfEmpty(value: string): string | null {
  return value.length === 0 ? null : value;
}
