import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { assertReconciliationSound, computeReconciliation } from '../../src/reconcile/reconcile.js';
import { isMigrationError } from '../../src/domain/errors.js';
import type { LineageEntry, RowAddress, RunTruth } from '../../src/reconcile/truth.js';
import type { SpooledFamily } from '../../src/run/spool.js';
import { materialisedFamily } from '../../src/run/spool.js';
import { caseScratch } from '../support/harness.js';

/**
 * Somewhere for the soundness check to sort the small projections it needs.
 *
 * Held open for the file: these cases state their truth literally rather than
 * running a migration, so nothing is spilled here except the edge projections,
 * and those are empty.
 */
const scratch = caseScratch('reconcile');

/**
 * The row equation, tested directly.
 *
 * An independent review pointed out that comparing the lineage against a tally
 * of the same lineage is an identity, not a check: it holds however many rows
 * were lost upstream. These tests construct the disagreement the check exists
 * to catch, which is the only way to know the check does anything.
 */

function address(rowNumber: number): RowAddress {
  return {
    bundleId: 'B-test',
    fileId: 'F-test',
    fileSha256: 'a'.repeat(64),
    filePath: 'contacts.csv',
    sheetId: 'S0',
    sheetName: null,
    rowNumberSource: rowNumber,
    rowLocatorId: `F-test:S0:R${String(rowNumber)}`,
    rowHash: 'b'.repeat(64),
  };
}

function lineageEntry(rowNumber: number): LineageEntry {
  return {
    address: address(rowNumber),
    contributionKind: 'NONE',
    disposition: 'LEFTOVER',
    reasonCode: 'LEFTOVER_NO_RECORD_MAPPING',
    detail: 'test',
    recordMappingId: null,
    object: null,
    sourceSystem: null,
    sourceNamespace: null,
    sourceRecordId: null,
    identityKey: null,
    recordIdentityKey: null,
    migrationKey: null,
    mergeId: null,
  };
}

function truth(options: { rowsRead: number; lineageRows: number }): RunTruth {
  return {
    coreVersion: '0.0.0-test',
    bundleId: 'B-test',
    runId: 'run_test',
    configHash: 'c'.repeat(64),
    mode: 'CLEAN_ONLY',
    importMode: 'CREATE_ONLY',
    targetContractHash: null,
    sourceProfileHash: null,
    destinationMatching: [],
    sourceFiles: [
      {
        fileId: 'F-test',
        path: 'contacts.csv',
        sha256: 'a'.repeat(64),
        byteLength: 10,
        format: 'CSV',
        encoding: 'UTF8',
        encodingEvidence: 'UTF8_VALIDATED',
        sheets: [
          {
            sheetId: 'S0',
            sheetName: null,
            hidden: false,
            columnCount: 1,
            readerRowCount: options.rowsRead,
            dataRowCount: options.rowsRead,
            rejectedRowCount: 0,
            evidence: [],
          },
        ],
      },
    ],
    lineage: materialisedFamily(
      Array.from({ length: options.lineageRows }, (_, index) => lineageEntry(index + 2)),
    ),
    changes: materialisedFamily([]),
    flags: materialisedFamily([]),
    unmappedFields: materialisedFamily([]),
    isolated: materialisedFamily([]),
    leftovers: materialisedFamily(
      Array.from({ length: options.lineageRows }, (_, index) => ({
        address: address(index + 2),
        reasonCode: 'LEFTOVER_NO_RECORD_MAPPING' as const,
        detail: 'test',
      })),
    ),
    rejected: materialisedFamily([]),
    merges: [],
    duplicateCandidates: materialisedFamily([]),
    duplicateCandidateClusters: 0,
    duplicateCandidateRows: 0,
    edges: materialisedFamily([]),
    edgeCandidateCount: 0,
    destinationConflicts: [],
    instanceVerification: [],
    deliveredRecords: materialisedFamily([]),
    formulaRisks: materialisedFamily([]),
  };
}

describe('the row equation compares two independent counts', () => {
  it('holds when the readers and the lineage agree', () => {
    const subject = truth({ rowsRead: 4, lineageRows: 4 });
    const reconciliation = computeReconciliation(subject);
    assert.equal(reconciliation.sourceRows.ingested, 4);
    assert.equal(reconciliation.sourceRows.total, 4);
    assert.equal(reconciliation.sourceRows.accountedFor, 4);
    assert.equal(reconciliation.sourceRows.withoutDisposition, 0);
    assert.equal(reconciliation.sourceRows.equationHolds, true);
    assertReconciliationSound(subject, reconciliation, scratch);
  });

  it('fails when a row was read but never reached the lineage', () => {
    // The exact defect the identity could not see: four rows read, three
    // accounted for.
    const subject = truth({ rowsRead: 4, lineageRows: 3 });
    const reconciliation = computeReconciliation(subject);

    assert.equal(reconciliation.sourceRows.ingested, 4);
    assert.equal(reconciliation.sourceRows.total, 3);
    assert.equal(reconciliation.sourceRows.withoutDisposition, 1, 'one row is unaccounted for');
    assert.equal(reconciliation.sourceRows.equationHolds, false);

    assert.throws(
      () => {
        assertReconciliationSound(subject, reconciliation, scratch);
      },
      (error: unknown) => {
        if (!isMigrationError(error)) return false;
        assert.equal(error.code, 'RECONCILIATION_FAILED');
        assert.ok(
          JSON.stringify(error.details).includes('lost between ingest and accounting'),
          error.message,
        );
        return true;
      },
    );
  });

  it('fails when the lineage holds more rows than the readers produced', () => {
    const subject = truth({ rowsRead: 2, lineageRows: 3 });
    const reconciliation = computeReconciliation(subject);
    assert.equal(reconciliation.sourceRows.equationHolds, false);
    assert.throws(
      () => {
        assertReconciliationSound(subject, reconciliation, scratch);
      },
      (error: unknown) => isMigrationError(error) && error.code === 'RECONCILIATION_FAILED',
    );
  });

  it('counts rejected rows as rows that were read', () => {
    const subject = truth({ rowsRead: 3, lineageRows: 4 });
    const withRejected: RunTruth = {
      ...subject,
      sourceFiles: [
        {
          ...(subject.sourceFiles[0] as RunTruth['sourceFiles'][number]),
          sheets: [
            {
              ...(subject.sourceFiles[0]?.sheets[0] as RunTruth['sourceFiles'][number]['sheets'][number]),
              readerRowCount: 4,
              dataRowCount: 3,
              rejectedRowCount: 1,
            },
          ],
        },
      ],
    };
    const reconciliation = computeReconciliation(withRejected);
    assert.equal(reconciliation.sourceRows.ingested, 4);
    assert.equal(reconciliation.sourceRows.equationHolds, true);
    assertReconciliationSound(withRejected, reconciliation, scratch);
  });
});

/**
 * The corroboration of the exception artifacts must not re-read the lineage.
 *
 * Isolation, leftover and rejected entries were each corroborated by searching
 * the whole lineage for their row. That is one full scan per exception, so a
 * run whose rows are mostly exceptions does work proportional to rows squared,
 * and the soundness check becomes more expensive than the migration it checks.
 *
 * Counting element reads rather than timing makes the regression a fact rather
 * than a measurement: the quadratic shape reads roughly `rows x exceptions`
 * elements, the bounded one reads each element a fixed number of times.
 */
describe('reconciliation soundness stays bounded in the number of rows', () => {
  function countingLineage(family: SpooledFamily<LineageEntry>): {
    view: SpooledFamily<LineageEntry>;
    reads: () => number;
  } {
    let reads = 0;
    const view: SpooledFamily<LineageEntry> = {
      count: family.count,
      *[Symbol.iterator](): IterableIterator<LineageEntry> {
        for (const entry of family) {
          reads += 1;
          yield entry;
        }
      },
    };
    return { view, reads: () => reads };
  }

  it('reads each lineage entry a bounded number of times however many rows are exceptions', () => {
    const rows = 400;
    const subject = truth({ rowsRead: rows, lineageRows: rows });
    // Computed before instrumenting, so only the soundness check is counted.
    const reconciliation = computeReconciliation(subject);

    const counted = countingLineage(subject.lineage);
    assertReconciliationSound({ ...subject, lineage: counted.view }, reconciliation, scratch);

    // Every one of the 400 rows is also a leftover, so the scan-per-exception
    // shape reads about 160,000 elements. A bounded check reads each entry a
    // small constant number of times.
    assert.ok(
      counted.reads() <= rows * 4,
      `the soundness check read ${String(counted.reads())} lineage elements for ${String(rows)} rows, which is not bounded in the row count`,
    );
  });

  it('still corroborates every exception artifact against the lineage', () => {
    const rows = 8;
    const subject = truth({ rowsRead: rows, lineageRows: rows });
    const reconciliation = computeReconciliation(subject);

    // One leftover entry names a row the lineage does not hold at all. It is
    // appended, and the artifacts are written in row order, so the merge meets
    // it after the lineage has run out — which is exactly the shape a real
    // orphan takes.
    const forged: RunTruth = {
      ...subject,
      leftovers: materialisedFamily([
        ...[...subject.leftovers].slice(1),
        { address: address(9999), reasonCode: 'LEFTOVER_NO_RECORD_MAPPING' as const, detail: 'forged' },
      ]),
    };
    assert.throws(
      () => {
        assertReconciliationSound(forged, reconciliation, scratch);
      },
      (error: unknown) =>
        isMigrationError(error) &&
        error.code === 'RECONCILIATION_FAILED' &&
        JSON.stringify(error.details).includes('F-test:S0:R9999'),
    );

    // And a row whose lineage disposition contradicts the artifact it is in.
    const contradicted: RunTruth = {
      ...subject,
      lineage: materialisedFamily([
        { ...([...subject.lineage][0] as LineageEntry), disposition: 'OUTPUT' as const },
        ...[...subject.lineage].slice(1),
      ]),
    };
    assert.throws(
      () => {
        assertReconciliationSound(contradicted, reconciliation, scratch);
      },
      (error: unknown) => isMigrationError(error) && error.code === 'RECONCILIATION_FAILED',
    );
  });
});
