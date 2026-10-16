import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADVERSARIAL_ROOT, caseScratch, collect, listCases, repoRoot, runFixture } from '../support/harness.js';
import { withTraps } from '../support/traps.js';
import { REASON_CODES } from '../../src/domain/reason-codes.js';
import type { ReasonCode } from '../../src/domain/reason-codes.js';
import { materialisedFamily } from '../../src/run/spool.js';
import { parseJson } from '../../src/util/json.js';
import type { JsonObject } from '../../src/util/json.js';
import { isMigrationError } from '../../src/domain/errors.js';
import * as loadConfigModule from '../../src/mapping/load-config.js';
import * as validateModule from '../../src/run/validate-destination.js';
import * as adaptersModule from '../../src/adapters/specs.js';

/**
 * The adversarial corpus.
 *
 * Each case must either fail closed with a named error code and a message an
 * operator can act on, or complete with every row accounted for. Silently
 * accepting part of a damaged file is the outcome this suite exists to prevent.
 */

const expectations = parseJson(
  readFileSync(join(ADVERSARIAL_ROOT, 'expected.json'), 'utf8'),
) as JsonObject;
const cases = (expectations['cases'] ?? {}) as Record<string, JsonObject>;

describe('adversarial corpus', () => {
  const caseIds = listCases(ADVERSARIAL_ROOT);
  assert.equal(caseIds.length, Object.keys(cases).length, 'every fixture must have a stated expectation');

  for (const caseId of caseIds) {
    const expectation = cases[caseId];
    assert.ok(expectation !== undefined, `${caseId} has no expectation`);

    it(`${caseId}: ${String(expectation['title'])}`, () => {
      if (expectation['outcome'] === 'FATAL') {
        let thrown: unknown = null;
        try {
          runFixture(ADVERSARIAL_ROOT, caseId, { scratchName: `adv-${caseId}` });
        } catch (error) {
          thrown = error;
        }
        assert.ok(thrown !== null, `${caseId} should have failed`);
        assert.ok(isMigrationError(thrown), `${caseId} must fail with a structured error, got ${String(thrown)}`);
        assert.equal(thrown.code, expectation['errorCode'], `${caseId} error code`);
        const fragment = String(expectation['messageIncludes']);
        const stated = `${thrown.message} ${JSON.stringify(thrown.details)}`;
        assert.ok(
          stated.includes(fragment),
          `${caseId} should state "${fragment}", got: ${stated}`,
        );
        assert.ok(thrown.remedy.length > 20, `${caseId} must tell the operator what to do`);
        return;
      }

      // A case that says nothing may be fetched is run with every door to the
      // outside counted, and every count must be zero. The repository holds the
      // bundle, the scratch space and the code, so anything outside it is a
      // path the workbook named rather than one the run needed.
      const trapped =
        expectation['zeroExternalOpens'] === true
          ? withTraps([repoRoot()], () => runFixture(ADVERSARIAL_ROOT, caseId, { scratchName: `adv-${caseId}` }))
          : null;
      const run = trapped?.value ?? runFixture(ADVERSARIAL_ROOT, caseId, { scratchName: `adv-${caseId}` });
      if (trapped !== null) {
        assert.deepEqual(
          { dns: trapped.counts.dns, socket: trapped.counts.socket, http: trapped.counts.http, fileOutsideBundle: trapped.counts.fileOutsideBundle },
          { dns: 0, socket: 0, http: 0, fileOutsideBundle: 0 },
          `${caseId} reached outside the bundle: ${trapped.counts.outsidePaths.join(', ')}`,
        );
      }
      assert.deepEqual(
        run.verification.problems,
        [],
        `${caseId}: ${run.verification.problems.map((problem) => problem.detail).join('; ')}`,
      );

      const rows = (expectation['rows'] ?? {}) as Record<string, number>;
      const actual = run.result.reconciliation.sourceRows;
      assert.equal(actual.total, rows['total'], 'total rows');
      for (const disposition of ['OUTPUT', 'MERGED_PROVEN', 'ISOLATED', 'LEFTOVER', 'REJECTED_INPUT'] as const) {
        assert.equal(actual.byDisposition[disposition], rows[disposition], `${disposition} rows`);
      }
      assert.equal(actual.withoutDisposition, 0);

      const rejectedCodes = (expectation['rejectedReasonCodes'] as string[] | undefined) ?? [];
      for (const code of rejectedCodes) {
        assert.ok(
          collect(run.result.truth.rejected).some((entry) => entry.reasonCode === code),
          `${caseId} should reject a row with ${code}`,
        );
      }

      for (const code of (expectation['isolatedReasonCodes'] as string[] | undefined) ?? []) {
        assert.ok(
          collect(run.result.truth.isolated).some((entry) => entry.reasonCode === code),
          `${caseId} should isolate a row with ${code}`,
        );
      }
      // The operator reads the reason code's description: it must state the way out.
      for (const code of (expectation['isolatedReasonCodes'] as string[] | undefined) ?? []) {
        const description = REASON_CODES[code as ReasonCode].description;
        for (const fragment of (expectation['remedyIncludes'] as string[] | undefined) ?? []) {
          assert.ok(description.includes(fragment), `${code} should tell the operator about "${fragment}"`);
        }
      }

      const distinctFiles = expectation['distinctSourceFiles'];
      if (typeof distinctFiles === 'number') {
        assert.equal(
          new Set(run.result.truth.sourceFiles.map((file) => file.fileId)).size,
          distinctFiles,
          'every occurrence is its own file',
        );
        const locators = collect(run.result.truth.lineage).map((entry) => entry.address.rowLocatorId);
        assert.equal(new Set(locators).size, actual.total, 'every source row has a locator of its own');
      }

      const flags = expectation['flags'];
      if (typeof flags === 'number') {
        assert.equal(run.result.reconciliation.cells.flagged, flags, 'flagged fields');
      }
      for (const code of (expectation['flagReasonCodes'] as string[] | undefined) ?? []) {
        assert.ok(
          collect(run.result.truth.flags).some((entry) => entry.reasonCode === code),
          `${caseId} should flag a field with ${code}`,
        );
      }
      for (const kind of (expectation['sheetEvidenceKinds'] as string[] | undefined) ?? []) {
        const found = run.result.truth.sourceFiles.some((file) =>
          file.sheets.some((sheet) => sheet.evidence.some((item) => item.kind === kind)),
        );
        assert.ok(found, `${caseId} should record ${kind} as source evidence`);
      }
    });
  }
});

describe('configuration rejection', () => {
  it('rejects an unknown property rather than ignoring it', () => {
    const text = JSON.stringify({
      configVersion: '3.0.0',
      source: { system: 'x', namespace: 'y' },
      target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' },
      files: [{ id: 'a', path: 'a.csv', format: 'CSV' }],
      records: [
        {
          id: 'a',
          fileId: 'a',
          object: 'CONTACT',
          fields: [{ column: { header: 'X' }, destinationField: 'contact.email', semanticType: 'EMAIL' }],
        },
      ],
      thisIsNotARealSetting: true,
    });
    assert.throws(
      () => {
        loadOrThrow(text);
      },
      (error: unknown) => isMigrationError(error) && error.code === 'CONFIG_INVALID',
    );
  });

  it('rejects a field the destination cannot deliver', () => {
    const text = JSON.stringify({
      configVersion: '3.0.0',
      source: { system: 'x', namespace: 'y' },
      target: { mode: 'SALESFORCE', importMode: 'CREATE_ONLY' },
      files: [{ id: 'a', path: 'a.csv', format: 'CSV' }],
      records: [
        {
          id: 'a',
          fileId: 'a',
          object: 'CONTACT',
          fields: [
            { column: { header: 'X' }, destinationField: 'contact.lifecycleStage', semanticType: 'TEXT' },
          ],
        },
      ],
    });
    const loaded = loadOrThrow(text);
    assert.throws(
      () => {
        assertDeliverable(loaded);
      },
      (error: unknown) => isMigrationError(error) && error.code === 'DESTINATION_FIELD_UNKNOWN',
    );
  });
});

function loadOrThrow(text: string) {
  return loadConfigModule.loadConfig(text, 'inline-test-config.json');
}

function assertDeliverable(loaded: ReturnType<typeof loadOrThrow>): void {
  // No records: the question here is whether the configuration itself is
  // deliverable, which is decided before any record is looked at.
  const scratch = caseScratch(`deliverable-${String((deliverableCount += 1))}`);
  try {
    validateModule.validateDestination(
      materialisedFamily<never>([]),
      loaded.config,
      adaptersModule.getAdapter(loaded.config.target.mode),
      scratch,
    );
  } finally {
    scratch.dispose();
  }
}

let deliverableCount = 0;

