import { MigrationError } from '../domain/errors.js';
import type { CanonicalObject } from '../domain/canonical.js';
import { CANONICAL_OBJECTS } from '../domain/canonical.js';
import { EDGE_DISPOSITIONS, ROW_DISPOSITIONS } from '../domain/disposition.js';
import type { EdgeDisposition, RowDisposition } from '../domain/disposition.js';
import type { JsonObject } from '../util/json.js';
import { compareCodeUnits } from '../util/json.js';
import type { RunTruth } from './truth.js';
import type { ScratchStore } from '../scratch/scratch-store.js';
import { openFamily, orderKey, orderText, rowOrderKey } from '../run/spool.js';

/**
 * Reconciliation is computed once, here, from the run's machine truth. Every
 * count that appears anywhere else in the package — including the human audit
 * summary — is read out of this object rather than recounted.
 */
export interface Reconciliation {
  readonly coreVersion: string;
  readonly runId: string;
  readonly bundleId: string;
  readonly configHash: string;
  readonly target: { readonly mode: string; readonly importMode: string };
  readonly inputs: {
    readonly fileCount: number;
    readonly totalByteLength: number;
    readonly sheetCount: number;
  };
  readonly sourceRows: {
    /**
     * Rows the readers actually produced, counted per sheet at ingest time.
     * This is the independent number: without it, comparing the lineage against
     * itself would be an identity that no lost row could ever break.
     */
    readonly ingested: number;
    readonly total: number;
    readonly byDisposition: Readonly<Record<RowDisposition, number>>;
    readonly accountedFor: number;
    readonly withoutDisposition: number;
    readonly equationHolds: boolean;
  };
  readonly records: {
    readonly deliveredTotal: number;
    readonly byObject: Readonly<Record<CanonicalObject, number>>;
  };
  readonly cells: {
    readonly changed: number;
    readonly rowsWithChanges: number;
    readonly clearedByExplicitAuthorization: number;
    readonly flagged: number;
    readonly unmappedPreserved: number;
  };
  readonly identity: {
    readonly provenMerges: number;
    readonly absorbedRows: number;
    readonly mergeConflicts: number;
    readonly consentConflicts: number;
    readonly duplicateCandidateClusters: number;
    readonly duplicateCandidateRows: number;
  };
  readonly associations: {
    readonly sourceEdges: number;
    readonly byDisposition: Readonly<Record<EdgeDisposition, number>>;
    readonly accountedFor: number;
    readonly withoutDisposition: number;
    readonly equationHolds: boolean;
  };
  readonly destination: {
    readonly keyConflicts: number;
    readonly instanceVerificationItems: number;
    readonly spreadsheetFormulaRiskValues: number;
  };
  readonly reasonCodeTally: Readonly<Record<string, number>>;
}

/**
 * Every count in a package, taken in one walk of each family.
 *
 * The families are read from where they were spilled, so walking one twice
 * means reading it twice. Each is therefore visited exactly once and everything
 * derived from it is accumulated in that pass, rather than the collection of
 * separate `filter().length` and `new Set(map())` expressions this used to be —
 * each of which was a second copy of a family the run had just written out.
 */
export function computeReconciliation(truth: RunTruth): Reconciliation {
  const reasonCodeTally: Record<string, number> = {};
  const tally = (code: string): void => {
    reasonCodeTally[code] = (reasonCodeTally[code] ?? 0) + 1;
  };

  const byDisposition = emptyTally(ROW_DISPOSITIONS);
  for (const entry of truth.lineage) {
    byDisposition[entry.disposition] += 1;
    tally(entry.reasonCode);
  }
  const totalRows = truth.lineage.count;
  const accountedFor = ROW_DISPOSITIONS.reduce((sum, key) => sum + byDisposition[key], 0);
  // Counted by the readers, not by the lineage. These are the two numbers whose
  // agreement is the whole claim.
  const ingestedRows = truth.sourceFiles.reduce(
    (sum, file) => sum + file.sheets.reduce((inner, sheet) => inner + sheet.readerRowCount, 0),
    0,
  );

  const edgeTally = emptyTally(EDGE_DISPOSITIONS);
  for (const edge of truth.edges) {
    edgeTally[edge.disposition] += 1;
    tally(edge.reasonCode);
  }
  const edgesAccountedFor = EDGE_DISPOSITIONS.reduce((sum, key) => sum + edgeTally[key], 0);

  const recordsByObject = Object.fromEntries(
    CANONICAL_OBJECTS.map((object) => [object, 0]),
  ) as Record<CanonicalObject, number>;
  for (const record of truth.deliveredRecords) {
    recordsByObject[record.object] += 1;
  }

  // Distinct rows, counted without a set of every row that changed.
  //
  // The change log is written in row order, so every entry for one row is
  // adjacent to the rest. Comparing each entry with the one before it counts
  // the distinct rows exactly, in constant memory — the canonical order pays
  // for itself here.
  let rowsWithChanges = 0;
  let previousChangedRow: string | null = null;
  let clearedByExplicitAuthorization = 0;
  let changedCells = 0;
  for (const change of truth.changes) {
    changedCells += 1;
    tally(change.reasonCode);
    if (change.reasonCode === 'TRANSFORM_CLEARED_BY_EXPLICIT_AUTHORIZATION') clearedByExplicitAuthorization += 1;
    if (change.address.rowLocatorId !== previousChangedRow) {
      rowsWithChanges += 1;
      previousChangedRow = change.address.rowLocatorId;
    }
  }

  for (const entry of truth.flags) tally(entry.reasonCode);
  for (const entry of truth.duplicateCandidates) tally(entry.reasonCode);
  for (const entry of truth.destinationConflicts) tally(entry.reasonCode);

  const mergeConflicts = truth.merges.reduce((sum, merge) => sum + merge.conflicts.length, 0);
  const consentConflicts = truth.merges.reduce(
    (sum, merge) => sum + merge.conflicts.filter((conflict) => conflict.semanticsClass === 'CONSENT').length,
    0,
  );

  return {
    coreVersion: truth.coreVersion,
    runId: truth.runId,
    bundleId: truth.bundleId,
    configHash: truth.configHash,
    target: { mode: truth.mode, importMode: truth.importMode },
    inputs: {
      fileCount: truth.sourceFiles.length,
      totalByteLength: truth.sourceFiles.reduce((sum, file) => sum + file.byteLength, 0),
      sheetCount: truth.sourceFiles.reduce((sum, file) => sum + file.sheets.length, 0),
    },
    sourceRows: {
      ingested: ingestedRows,
      total: totalRows,
      byDisposition,
      accountedFor,
      withoutDisposition: ingestedRows - accountedFor,
      equationHolds: ingestedRows === totalRows && totalRows === accountedFor,
    },
    records: {
      deliveredTotal: truth.deliveredRecords.count,
      byObject: recordsByObject,
    },
    cells: {
      changed: changedCells,
      rowsWithChanges,
      clearedByExplicitAuthorization,
      flagged: truth.flags.count,
      unmappedPreserved: truth.unmappedFields.count,
    },
    identity: {
      provenMerges: truth.merges.length,
      absorbedRows: truth.merges.reduce((sum, merge) => sum + merge.absorbedRowLocatorIds.length, 0),
      mergeConflicts,
      consentConflicts,
      // Counted where the candidates were produced, not by building two sets
      // over the family they came from. The sets were one entry per cluster and
      // one per row locator, held together, over a table that is itself as large
      // as the customer data collides with itself.
      duplicateCandidateClusters: truth.duplicateCandidateClusters,
      duplicateCandidateRows: truth.duplicateCandidateRows,
    },
    associations: {
      // Counted where the candidates were produced, not by tallying the array
      // the dispositions come from. The two are compared, which is the whole
      // point: the tally alone is an identity.
      sourceEdges: truth.edgeCandidateCount,
      byDisposition: edgeTally,
      accountedFor: edgesAccountedFor,
      withoutDisposition: truth.edgeCandidateCount - edgesAccountedFor,
      equationHolds:
        truth.edgeCandidateCount === truth.edges.count && truth.edges.count === edgesAccountedFor,
    },
    destination: {
      keyConflicts: truth.destinationConflicts.length,
      instanceVerificationItems: truth.instanceVerification.length,
      spreadsheetFormulaRiskValues: truth.formulaRisks.count,
    },
    reasonCodeTally: Object.fromEntries(
      Object.entries(reasonCodeTally).sort(([a], [b]) => compareCodeUnits(a, b)),
    ),
  };
}

/**
 * Structural checks that must hold before a package may be written. Each one
 * corresponds to a way the engine could quietly lose or double-count data.
 */
/**
 * Structural checks that must hold before a package may be written. Each one
 * corresponds to a way the engine could quietly lose or double-count data.
 *
 * Every check here is a merge over families that are already in canonical order,
 * so none of them builds an index of the dataset to check the dataset. That is
 * not a performance note: an index of every row is one more full-size copy of
 * the migration, held at the moment the run is holding the most, and the whole
 * point of spilling the families was to stop making those.
 *
 * Where a check needs an order a family is not in — edges by the row that
 * produced them, edge endpoints by the record they name — it spills a compact
 * projection and sorts that, rather than holding the family a second way.
 */
export function assertReconciliationSound(
  truth: RunTruth,
  reconciliation: Reconciliation,
  scratch: ScratchStore,
): void {
  const problems: string[] = [];
  const say = (problem: string): void => {
    // Bounded on purpose. A run that has lost its shape can produce a problem
    // per row, and a failure that cannot be reported without exhausting memory
    // is not a failure report.
    if (problems.length < MAX_REPORTED_PROBLEMS) problems.push(problem);
    else if (problems.length === MAX_REPORTED_PROBLEMS) {
      problems.push(`more than ${String(MAX_REPORTED_PROBLEMS)} problems; the rest are not listed`);
    }
  };

  if (reconciliation.sourceRows.ingested !== reconciliation.sourceRows.total) {
    say(
      `the readers produced ${String(reconciliation.sourceRows.ingested)} rows but the lineage holds ${String(reconciliation.sourceRows.total)}; ${String(reconciliation.sourceRows.ingested - reconciliation.sourceRows.total)} rows were lost between ingest and accounting`,
    );
  }
  if (!reconciliation.sourceRows.equationHolds) {
    say(
      `source row partition does not close: ${String(reconciliation.sourceRows.ingested)} rows read, ${String(reconciliation.sourceRows.total)} in the lineage, ${String(reconciliation.sourceRows.accountedFor)} dispositions`,
    );
  }

  // Projections, spilled and sorted into the orders these checks need. Each
  // holds one small tuple per edge, never an edge.
  const edgeRows = openFamily<{ readonly rowOrderKey: string }>(scratch, {
    schema: 'check-edge-rows',
    key: (item) => item.rowOrderKey,
  });
  const edgeEndpoints = openFamily<{ readonly migrationKey: string; readonly sourceEdgeId: string; readonly side: string }>(
    scratch,
    { schema: 'check-edge-endpoints', key: (item) => orderKey(item.migrationKey, item.sourceEdgeId, item.side) },
  );
  const deliveredPairs = openFamily<{ readonly pair: string; readonly sourceEdgeId: string }>(scratch, {
    schema: 'check-edge-pairs',
    // The pair holds the relationship label, which is a cell out of the
    // association file — a label typed across two lines puts a line feed in a
    // sort key and stops the run at the last check before the package is
    // written. build-edges.ts escapes the identically composed key; this is the
    // copy that did not.
    key: (item) => orderKey(orderText(item.pair), item.sourceEdgeId),
  });

  let previousEdgeId: string | null = null;
  for (const edge of truth.edges) {
    if (previousEdgeId !== null && edge.sourceEdgeId === previousEdgeId) {
      say(`edge ${edge.sourceEdgeId} has more than one disposition`);
    }
    previousEdgeId = edge.sourceEdgeId;

    edgeRows.add({ rowOrderKey: rowOrderKey(edge.address) });

    if (edge.disposition === 'OUTPUT') {
      if (edge.fromMigrationKey === null || edge.toMigrationKey === null) {
        say(`edge ${edge.sourceEdgeId} is delivered without both endpoints resolved`);
      } else {
        edgeEndpoints.add({ migrationKey: edge.fromMigrationKey, sourceEdgeId: edge.sourceEdgeId, side: 'from' });
        edgeEndpoints.add({ migrationKey: edge.toMigrationKey, sourceEdgeId: edge.sourceEdgeId, side: 'to' });
      }
      deliveredPairs.add({
        pair: `${edge.relationshipType}|${String(edge.fromMigrationKey)}|${String(edge.toMigrationKey)}|${edge.label ?? ''}`,
        sourceEdgeId: edge.sourceEdgeId,
      });
    }
  }
  const edgeRowsSorted = edgeRows.seal();
  const edgeEndpointsSorted = edgeEndpoints.seal();
  const deliveredPairsSorted = deliveredPairs.seal();

  // ------------------------------------------------------ the row-order merge
  //
  // Lineage, isolation, leftover, rejected and the change log are all written
  // in file, sheet, row order. Walking them together corroborates every
  // exception against the row it claims, and notices an exception naming a row
  // the lineage does not hold, without either side being indexed.
  const isolated = openCursor(truth.isolated, (entry) => rowOrderKey(entry.address));
  const leftovers = openCursor(truth.leftovers, (entry) => rowOrderKey(entry.address));
  const rejected = openCursor(truth.rejected, (entry) => rowOrderKey(entry.address));
  const changes = openCursor(truth.changes, (entry) => rowOrderKey(entry.address));
  const edgeRowCursor = openCursor(edgeRowsSorted, (entry) => entry.rowOrderKey);

  const orphan = (cursor: Cursor<unknown>, artifact: string, describe: (item: never) => string): void => {
    say(`the ${artifact} artifact names ${describe(cursor.value as never)}, which the lineage does not hold`);
    cursor.advance();
  };

  let recordOutputRows = 0;
  let mergedRows = 0;
  let previousRowKey: string | null = null;

  for (const entry of truth.lineage) {
    const key = rowOrderKey(entry.address);
    if (previousRowKey !== null && key === previousRowKey) {
      say(`row ${entry.address.rowLocatorId} has more than one disposition`);
    }
    if (previousRowKey !== null && compareCodeUnits(key, previousRowKey) < 0) {
      say(`the lineage is not in row order at ${entry.address.rowLocatorId}`);
    }
    previousRowKey = key;

    if (entry.disposition === 'OUTPUT' && entry.contributionKind === 'RECORD') recordOutputRows += 1;
    if (entry.disposition === 'MERGED_PROVEN') mergedRows += 1;

    // Anything still sitting before this row belongs to a row the lineage never
    // reached.
    while (!isolated.done && compareCodeUnits(isolated.key(), key) < 0) {
      orphan(isolated, 'isolation', (item: { address: { rowLocatorId: string } }) => item.address.rowLocatorId);
    }
    while (!leftovers.done && compareCodeUnits(leftovers.key(), key) < 0) {
      orphan(leftovers, 'leftover', (item: { address: { rowLocatorId: string } }) => item.address.rowLocatorId);
    }
    while (!rejected.done && compareCodeUnits(rejected.key(), key) < 0) {
      orphan(rejected, 'rejected', (item: { address: { rowLocatorId: string } }) => item.address.rowLocatorId);
    }
    while (!changes.done && compareCodeUnits(changes.key(), key) < 0) {
      say(`change log refers to unknown row ${changes.value.address.rowLocatorId}`);
      changes.advance();
    }
    while (!edgeRowCursor.done && compareCodeUnits(edgeRowCursor.key(), key) < 0) {
      edgeRowCursor.advance();
    }

    // And anything on this row is corroborated against its disposition.
    let isolatedHere = 0;
    while (!isolated.done && isolated.key() === key) {
      isolatedHere += 1;
      isolated.advance();
    }
    if (isolatedHere > 0 && entry.disposition !== 'ISOLATED') {
      say(`row ${entry.address.rowLocatorId} appears in the isolation artifact but is not ISOLATED`);
    }

    let leftoverHere = 0;
    while (!leftovers.done && leftovers.key() === key) {
      leftoverHere += 1;
      leftovers.advance();
    }
    if (leftoverHere > 0 && entry.disposition !== 'LEFTOVER') {
      say(`row ${entry.address.rowLocatorId} appears in the leftover artifact but is not LEFTOVER`);
    }

    let rejectedHere = 0;
    while (!rejected.done && rejected.key() === key) {
      rejectedHere += 1;
      rejected.advance();
    }
    if (rejectedHere > 0 && entry.disposition !== 'REJECTED_INPUT') {
      say(`row ${entry.address.rowLocatorId} appears in the rejected artifact but is not REJECTED_INPUT`);
    }

    while (!changes.done && changes.key() === key) {
      const change = changes.value;
      if (change.originalValue === change.finalValue) {
        say(
          `change log records ${change.address.rowLocatorId}/${change.destinationField} but the value did not change`,
        );
      }
      changes.advance();
    }

    let edgesHere = 0;
    while (!edgeRowCursor.done && edgeRowCursor.key() === key) {
      edgesHere += 1;
      edgeRowCursor.advance();
    }
    if (entry.contributionKind === 'ASSOCIATION' && edgesHere === 0) {
      say(`row ${entry.address.rowLocatorId} is recorded as contributing associations but produced none`);
    }
  }

  // Whatever is left names a row after the last one the lineage holds.
  while (!isolated.done) {
    orphan(isolated, 'isolation', (item: { address: { rowLocatorId: string } }) => item.address.rowLocatorId);
  }
  while (!leftovers.done) {
    orphan(leftovers, 'leftover', (item: { address: { rowLocatorId: string } }) => item.address.rowLocatorId);
  }
  while (!rejected.done) {
    orphan(rejected, 'rejected', (item: { address: { rowLocatorId: string } }) => item.address.rowLocatorId);
  }
  while (!changes.done) {
    say(`change log refers to unknown row ${changes.value.address.rowLocatorId}`);
    changes.advance();
  }

  if (recordOutputRows !== truth.deliveredRecords.count) {
    say(
      `${String(recordOutputRows)} record rows are marked OUTPUT but ${String(truth.deliveredRecords.count)} records are delivered; each delivered record must have exactly one surviving source row`,
    );
  }

  const absorbed = truth.merges.flatMap((merge) => merge.absorbedRowLocatorIds);
  if (new Set(absorbed).size !== absorbed.length) {
    say('a source row is absorbed by more than one merge');
  }
  if (mergedRows !== absorbed.length) {
    say(
      `${String(mergedRows)} rows are marked MERGED_PROVEN but merge records account for ${String(absorbed.length)}`,
    );
  }

  // ------------------------------------------- delivered records and the edges
  //
  // Delivered records are written in migration-key order, and the endpoint
  // projection was sorted into the same order, so one merge answers both "are
  // two records sharing a key" and "does a delivered edge point at a record
  // nobody delivered".
  const endpoints = openCursor(edgeEndpointsSorted, (item) => item.migrationKey);
  let previousMigrationKey: string | null = null;
  for (const record of truth.deliveredRecords) {
    if (previousMigrationKey !== null && record.migrationKey === previousMigrationKey) {
      say('two delivered records share a migration key');
    }
    previousMigrationKey = record.migrationKey;

    while (!endpoints.done && compareCodeUnits(endpoints.value.migrationKey, record.migrationKey) < 0) {
      say(`edge ${endpoints.value.sourceEdgeId} points at undelivered record ${endpoints.value.migrationKey}`);
      endpoints.advance();
    }
    while (!endpoints.done && endpoints.value.migrationKey === record.migrationKey) {
      endpoints.advance();
    }
  }
  while (!endpoints.done) {
    say(`edge ${endpoints.value.sourceEdgeId} points at undelivered record ${endpoints.value.migrationKey}`);
    endpoints.advance();
  }

  if (!reconciliation.associations.equationHolds) {
    say('association partition does not close');
  }

  let previousPair: string | null = null;
  for (const entry of deliveredPairsSorted) {
    if (previousPair !== null && entry.pair === previousPair) {
      say(`relationship ${entry.pair} is delivered more than once`);
    }
    previousPair = entry.pair;
  }

  if (problems.length > 0) {
    throw new MigrationError(
      'RECONCILIATION_FAILED',
      `the run's own facts do not reconcile (${String(problems.length)} problems)`,
      'This is a defect in the engine, not in the customer data. The package was not written.',
      { problems },
    );
  }
}

/** How many problems a failed reconciliation lists before it stops. */
const MAX_REPORTED_PROBLEMS = 100;

interface Cursor<T> {
  readonly done: boolean;
  readonly value: T;
  key(): string;
  advance(): void;
}

/**
 * One position in a family, for walking two of them together.
 *
 * Holds the current record and nothing else, which is what makes a merge over
 * two spilled families cost the same whatever they hold.
 */
function openCursor<T>(family: Iterable<T>, keyOf: (item: T) => string): Cursor<T> {
  const iterator = family[Symbol.iterator]();
  let step = iterator.next();
  return {
    get done(): boolean {
      return step.done === true;
    },
    get value(): T {
      return step.value as T;
    },
    key(): string {
      return keyOf(step.value as T);
    },
    advance(): void {
      step = iterator.next();
    },
  };
}

export function reconciliationToJson(reconciliation: Reconciliation): JsonObject {
  return JSON.parse(JSON.stringify(reconciliation)) as JsonObject;
}

function emptyTally<T extends string>(keys: readonly T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}
