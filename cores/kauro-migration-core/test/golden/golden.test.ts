import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { GOLDEN_ROOT, collect, findLineage, listCases, readCaseExpectation, readTextArtifact, runFixture } from '../support/harness.js';
import type { CaseRun } from '../support/harness.js';
import type { JsonObject, JsonValue } from '../../src/util/json.js';

/**
 * The golden corpus.
 *
 * Every expectation here was written before the engine was run against the
 * fixture. When one of these fails, the engine is wrong until the case is shown
 * to be wrong on its own terms — never the other way round.
 */

const caseIds = listCases(GOLDEN_ROOT);

function obj(value: JsonValue | undefined): JsonObject {
  return (value ?? {}) as JsonObject;
}

function num(value: JsonValue | undefined): number | null {
  return typeof value === 'number' ? value : null;
}

function list(value: JsonValue | undefined): JsonObject[] {
  return Array.isArray(value) ? (value as JsonObject[]) : [];
}

function str(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

describe('golden corpus', () => {
  assert.ok(caseIds.length >= 20, `expected at least 20 golden cases, found ${String(caseIds.length)}`);

  for (const caseId of caseIds) {
    describe(caseId, () => {
      const expectation = readCaseExpectation(GOLDEN_ROOT, caseId);
      const run: CaseRun = runFixture(GOLDEN_ROOT, caseId);
      const expect = obj(expectation['expect']);
      const reconciliation = run.result.reconciliation;
      const truth = run.result.truth;

      it('produces a package that verifies from disk', () => {
        assert.deepEqual(
          run.verification.problems,
          [],
          `${caseId}: ${run.verification.problems.map((problem) => `${problem.check}: ${problem.detail}`).join('; ')}`,
        );
      });

      it('accounts for every source row exactly once', () => {
        const rows = obj(expect['rows']);
        assert.equal(reconciliation.sourceRows.total, num(rows['total']), 'total source rows');
        for (const disposition of ['OUTPUT', 'MERGED_PROVEN', 'ISOLATED', 'LEFTOVER', 'REJECTED_INPUT'] as const) {
          assert.equal(
            reconciliation.sourceRows.byDisposition[disposition],
            num(rows[disposition]),
            `${disposition} rows`,
          );
        }
        assert.equal(reconciliation.sourceRows.withoutDisposition, 0, 'rows without a disposition');
        assert.equal(reconciliation.sourceRows.equationHolds, true);
      });

      it('delivers the expected records', () => {
        const records = obj(expect['records']);
        for (const object of ['CONTACT', 'COMPANY', 'DEAL', 'LEAD'] as const) {
          assert.equal(reconciliation.records.byObject[object], num(records[object]), `${object} records`);
        }
      });

      it('matches the expected counts', () => {
        assert.equal(reconciliation.cells.changed, num(expect['changedCells']), 'changed cells');
        assert.equal(reconciliation.cells.flagged, num(expect['flags']), 'flagged fields');
        assert.equal(reconciliation.cells.unmappedPreserved, num(expect['unmappedFields']), 'unmapped values');
        assert.equal(reconciliation.identity.provenMerges, num(expect['merges']), 'proven merges');
        assert.equal(reconciliation.identity.mergeConflicts, num(expect['mergeConflicts']), 'merge conflicts');
        assert.equal(
          reconciliation.identity.duplicateCandidateClusters,
          num(expect['duplicateCandidateClusters']),
          'duplicate candidate clusters',
        );
        assert.equal(
          reconciliation.destination.keyConflicts,
          num(expect['destinationKeyConflicts']),
          'destination key conflicts',
        );
        assert.equal(
          reconciliation.destination.spreadsheetFormulaRiskValues,
          num(expect['formulaRisks']),
          'values a spreadsheet would read as a formula',
        );

        const edges = obj(expect['edges']);
        assert.equal(reconciliation.associations.sourceEdges, num(edges['total']), 'source relationships');
        for (const disposition of ['OUTPUT', 'DEDUPLICATED', 'UNRESOLVED', 'LEFTOVER'] as const) {
          assert.equal(
            reconciliation.associations.byDisposition[disposition],
            num(edges[disposition]),
            `${disposition} relationships`,
          );
        }
        assert.equal(reconciliation.associations.withoutDisposition, 0);

        const decisions = num(expect['mergeFieldDecisions']);
        if (decisions !== null) {
          const actual = truth.merges.reduce((sum, merge) => sum + merge.fieldDecisions.length, 0);
          assert.equal(actual, decisions, 'merge field decisions');
        }
      });

      it('records exactly the expected changes', () => {
        const expected = list(expectation['changes']);
        assert.equal(truth.changes.count, expected.length, 'the case must list every change it expects');

        for (const change of expected) {
          const reference = str(change['row']) ?? '';
          const { file, rowNumber } = splitRef(reference);
          const found = collect(truth.changes).find(
            (entry) =>
              entry.address.filePath === file &&
              entry.address.rowNumberSource === rowNumber &&
              entry.destinationField === str(change['field']),
          );
          assert.ok(found !== undefined, `${caseId}: no change for ${reference} ${String(change['field'])}`);
          assert.equal(found.originalValue, change['from'] === null ? null : str(change['from']), `${reference} original`);
          assert.equal(found.finalValue, str(change['to']), `${reference} final`);
          assert.equal(found.reasonCode, str(change['reasonCode']), `${reference} reason`);
        }
      });

      it('records exactly the expected flags', () => {
        const expected = list(expectation['flagDetails']);
        assert.equal(truth.flags.count, expected.length, 'the case must list every flag it expects');

        for (const flag of expected) {
          const reference = str(flag['row']) ?? '';
          const { file, rowNumber } = splitRef(reference);
          const found = collect(truth.flags).find(
            (entry) =>
              entry.address.filePath === file &&
              entry.address.rowNumberSource === rowNumber &&
              entry.destinationField === str(flag['field']),
          );
          assert.ok(found !== undefined, `${caseId}: no flag for ${reference} ${String(flag['field'])}`);
          assert.equal(found.outcome, str(flag['outcome']), `${reference} outcome`);
          assert.equal(found.preservedValue, str(flag['preserved']), `${reference} preserved value`);
          assert.equal(found.reasonCode, str(flag['reasonCode']), `${reference} reason`);
          if (typeof flag['blockedDelivery'] === 'boolean') {
            assert.equal(found.blockedDelivery, flag['blockedDelivery'], `${reference} blocked delivery`);
          }
        }
      });

      it('gives each named row the expected disposition', () => {
        for (const item of list(expectation['dispositions'])) {
          const reference = str(item['row']) ?? '';
          const entry = findLineage(run, reference);
          assert.equal(entry.disposition, str(item['disposition']), `${reference} disposition`);
          const reasonCode = str(item['reasonCode']);
          if (reasonCode !== null) assert.equal(entry.reasonCode, reasonCode, `${reference} reason`);
          const contributionKind = str(item['contributionKind']);
          if (contributionKind !== null) {
            assert.equal(entry.contributionKind, contributionKind, `${reference} contribution`);
          }
        }
      });

      it('delivers the expected values', () => {
        for (const item of list(expectation['delivered'])) {
          const sourceRecordId = str(item['sourceRecordId']);
          const values = obj(item['values']);
          const candidates = collect(truth.deliveredRecords).filter(
            (record) => record.sourceRecordId === sourceRecordId,
          );
          assert.ok(
            candidates.length > 0,
            `${caseId}: no delivered record with source record id ${String(sourceRecordId)}`,
          );
          const match = candidates.find((record) =>
            Object.entries(values).every(([field, value]) => record.values[field] === value),
          );
          assert.ok(
            match !== undefined,
            `${caseId}: no delivered record ${String(sourceRecordId)} with ${JSON.stringify(values)}; saw ${JSON.stringify(candidates.map((record) => record.values))}`,
          );
        }
      });

      it('reports the expected duplicate candidate clusters', () => {
        for (const cluster of list(expectation['duplicateClusters'])) {
          const members = [...truth.duplicateCandidates].filter(
            (entry) => entry.signal === str(cluster['signal']) && entry.signalValue === str(cluster['signalValue']),
          );
          assert.equal(
            members.length,
            num(cluster['members']),
            `${caseId}: members of ${String(cluster['signal'])} cluster ${String(cluster['signalValue'])}`,
          );
          for (const member of members) {
            assert.equal(member.reasonCode, str(cluster['reasonCode']), 'cluster signal reason');
            assert.equal(member.notMergedReasonCode, str(cluster['notMergedReasonCode']), 'why it was not merged');
          }
        }
      });

      it('reports the expected merges in full', () => {
        for (const merge of list(expectation['merges'])) {
          const survivorRef = splitRef(str(merge['survivorRow']) ?? '');
          const survivorLineage = must(
            collect(truth.lineage).find(
              (entry) =>
                entry.address.filePath === survivorRef.file &&
                entry.address.rowNumberSource === survivorRef.rowNumber,
            ),
            'survivor row must exist',
          );
          const record = must(
            truth.merges.find(
              (entry) => entry.survivorRowLocatorId === survivorLineage.address.rowLocatorId,
            ),
            `${caseId}: no merge with survivor ${String(merge['survivorRow'])}`,
          );

          const absorbedRefs = (merge['absorbedRows'] as string[] | undefined) ?? [];
          assert.equal(record.absorbedRowLocatorIds.length, absorbedRefs.length, 'absorbed row count');
          for (const reference of absorbedRefs) {
            const entry = findLineage(run, reference);
            assert.ok(
              record.absorbedRowLocatorIds.includes(entry.address.rowLocatorId),
              `${caseId}: ${reference} should be absorbed by ${record.mergeId}`,
            );
            assert.equal(entry.disposition, 'MERGED_PROVEN');
          }

          const kinds = (merge['identityEvidenceKinds'] as string[] | undefined) ?? [];
          for (const kind of kinds) {
            assert.ok(
              record.identityEvidence.some((item) => item.kind === kind && item.authority === 'PROVING'),
              `${caseId}: merge ${record.mergeId} must cite ${kind} as proving evidence`,
            );
          }

          const conflicts = list(merge['conflicts']);
          assert.equal(record.conflicts.length, conflicts.length, 'conflict count');
          for (const conflict of conflicts) {
            const found = must(
              record.conflicts.find((entry) => entry.destinationField === str(conflict['field'])),
              `${caseId}: expected a conflict on ${String(conflict['field'])}`,
            );
            const values = ((conflict['values'] as string[] | undefined) ?? []).slice().sort();
            assert.deepEqual(found.values.map((entry) => entry.value).sort(), values, 'conflicting values');
            assert.equal(found.reasonCode, str(conflict['reasonCode']));
          }

          const decisions = list(merge['fieldDecisions']);
          assert.equal(record.fieldDecisions.length, decisions.length, 'field decision count');
          for (const decision of decisions) {
            const found = must(
              record.fieldDecisions.find((entry) => entry.destinationField === str(decision['field'])),
              `${caseId}: expected a decision on ${String(decision['field'])}`,
            );
            assert.equal(found.value, str(decision['value']));
            assert.equal(found.reasonCode, str(decision['reasonCode']));
            assert.equal(
              found.fromRowLocatorId,
              findLineage(run, str(decision['fromRow']) ?? '').address.rowLocatorId,
            );
          }
        }
      });

      it('gives each named relationship the expected disposition', () => {
        for (const item of list(expectation['edgeDetails'])) {
          const reference = str(item['row']) ?? '';
          const { file, rowNumber } = splitRef(reference);
          const matches = collect(truth.edges).filter(
            (edge) =>
              edge.address.filePath === file &&
              edge.address.rowNumberSource === rowNumber &&
              edge.relationshipType === str(item['relationshipType']),
          );
          const fromKeyRaw = str(item['fromKeyRaw']);
          const toKeyRaw = str(item['toKeyRaw']);
          const found = matches.find(
            (edge) =>
              (fromKeyRaw === null || edge.fromKeyRaw === fromKeyRaw) &&
              (toKeyRaw === null || edge.toKeyRaw === toKeyRaw),
          );
          assert.ok(found !== undefined, `${caseId}: no relationship on ${reference} matching ${JSON.stringify(item)}`);
          assert.equal(found.disposition, str(item['disposition']), `${reference} disposition`);
          assert.equal(found.reasonCode, str(item['reasonCode']), `${reference} reason`);
        }
      });

      it('preserves the expected unmapped values', () => {
        for (const item of list(expectation['unmapped'])) {
          const reference = str(item['row']) ?? '';
          const { file, rowNumber } = splitRef(reference);
          const found = collect(truth.unmappedFields).find(
            (entry) =>
              entry.address.filePath === file &&
              entry.address.rowNumberSource === rowNumber &&
              entry.columnHeader === str(item['columnHeader']),
          );
          assert.ok(found !== undefined, `${caseId}: ${reference} ${String(item['columnHeader'])} was not preserved`);
          assert.equal(found.value, str(item['value']));
        }
      });

      it('quotes the reconciliation in the audit summary rather than recounting', () => {
        // Read straight from the package and compare against numbers this test
        // computes itself, so a defect inside the audit renderer cannot hide
        // behind the verifier re-rendering with the same defect.
        const audit = readTextArtifact(run.packageDir, 'audit.md');
        const rows = reconciliation.sourceRows;
        const plural = rows.ingested === 1 ? '' : 's';
        assert.ok(
          audit.includes(
            `All ${String(rows.ingested)} source row${plural} read from the input files have exactly one disposition. 0 rows disappeared.`,
          ),
          `${caseId}: audit.md does not state the source row total from the reconciliation`,
        );
        for (const disposition of ['OUTPUT', 'MERGED_PROVEN', 'ISOLATED', 'LEFTOVER', 'REJECTED_INPUT'] as const) {
          assert.ok(
            audit.includes(`| ${disposition} | ${String(rows.byDisposition[disposition])} |`),
            `${caseId}: audit.md does not state the ${disposition} count`,
          );
        }
      });

      it('declares the expected spreadsheet-formula risks', () => {
        const expected = (expectation['formulaRiskValues'] as string[] | undefined) ?? null;
        if (expected === null) return;
        assert.deepEqual(
          collect(truth.formulaRisks).map((entry) => entry.value).sort(),
          [...expected].sort(),
          'declared formula-risk values',
        );
      });
    });
  }
});

function must<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function splitRef(reference: string): { file: string; rowNumber: number } {
  const index = reference.lastIndexOf('#');
  return { file: reference.slice(0, index), rowNumber: Number(reference.slice(index + 1)) };
}
