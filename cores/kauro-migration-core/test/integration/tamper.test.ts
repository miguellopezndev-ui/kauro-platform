import { strict as assert } from 'node:assert';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { GOLDEN_ROOT, readTable, runFixture, verifyScratch } from '../support/harness.js';
import { READ_BLOCK_BYTES, verifyPackage } from '../../src/verify/verify-package.js';
import { listPackageFiles } from '../../src/artifacts/write-package.js';
import { packagePath } from '../../src/artifacts/layout.js';
import { sha256Hex } from '../../src/util/hash.js';
import { canonicalJsonText, parseJson } from '../../src/util/json.js';
import { renderAudit } from '../../src/artifacts/audit.js';
import { renderCsv } from '../../src/artifacts/csv-writer.js';
import { mergeIdFor } from '../../src/identity/migration-key.js';
import type { JsonObject } from '../../src/util/json.js';
import type { Reconciliation } from '../../src/reconcile/reconcile.js';
import type { DestinationAdapter } from '../../src/adapters/adapter.js';

/**
 * Tampering.
 *
 * An independent review took finished packages apart and found 21 different
 * edits the verifier accepted. Each case below is one of those edits, applied
 * the same way the reviewer applied it: the artifact is changed and then the
 * manifest is repaired so the hashes match again, which is what makes the
 * tamper hard to see. The verifier has to catch it on the content, not on the
 * bytes.
 */

interface Package {
  readonly dir: string;
  /** The adapter the package was shaped for: its import directory and its trace key header. */
  readonly adapter: DestinationAdapter;
}

function open(caseId: string, scratchName: string): Package {
  const run = runFixture(GOLDEN_ROOT, caseId, { scratchName });
  return { dir: run.packageDir, adapter: run.result.adapter };
}

// Artifacts are named the way the contract names them; the layout says where
// each one lives. A tamper test that hard-coded an address would keep passing
// against a package whose artifacts had all moved.
function read(pkg: Package, name: string): string {
  return readFileSync(join(pkg.dir, ...packagePath(name).split('/')), 'utf8');
}

function write(pkg: Package, name: string, text: string): void {
  writeFileSync(join(pkg.dir, ...packagePath(name).split('/')), Buffer.from(text, 'utf8'));
}

/**
 * The same, in bytes.
 *
 * `read` and `write` go through a string, which is exactly right for a tamper
 * that edits a value and exactly wrong for one that edits a byte: a string
 * cannot hold a sequence that is not valid UTF-8, and putting one through
 * `Buffer.from(text, 'utf8')` would replace it before it ever reached the file.
 * The checks under test compare bytes, so the tampers that exercise them have to
 * be able to write bytes.
 */
function readBytes(pkg: Package, name: string): Buffer {
  return readFileSync(join(pkg.dir, ...packagePath(name).split('/')));
}

function writeBytes(pkg: Package, name: string, bytes: Buffer): void {
  writeFileSync(join(pkg.dir, ...packagePath(name).split('/')), bytes);
}

function readJson(pkg: Package, relativePath: string): JsonObject {
  return parseJson(read(pkg, relativePath)) as JsonObject;
}

function writeJson(pkg: Package, relativePath: string, value: JsonObject): void {
  write(pkg, relativePath, canonicalJsonText(value));
}

/** Repairs every hash, byte length and row count in the manifest after an edit. */
/**
 * Removes a delivered record from an import file the way a forger would have to.
 *
 * Both files, or neither: taking the row out of the import file alone leaves a
 * crosswalk that accounts for a row that is not there, which is caught before
 * the check being tested is reached. So the crosswalk row goes too and the rest
 * of that file is renumbered, which is the strongest version of the tamper.
 */
function withholdDeliveredRecord(pkg: Package, importPath: string, migrationKey: string): void {
  const rowNumber = importRowNumberFor(pkg, importPath, migrationKey);
  const table = readTable(pkg.dir, importPath);
  write(
    pkg,
    importPath,
    renderCsv(
      table.headers,
      table.rows
        .filter((_row, index) => index + 1 !== rowNumber)
        .map((row) => table.headers.map((header) => row[header] ?? '')),
    ),
  );

  const crosswalk = readTable(pkg.dir, 'import-crosswalk.csv');
  let kept = 0;
  const rows = crosswalk.rows
    .filter((row) => !((row['import_path'] ?? '') === importPath && (row['migration_key'] ?? '') === migrationKey))
    .map((row) => {
      const mine = (row['import_path'] ?? '') === importPath;
      if (mine) kept += 1;
      return crosswalk.headers.map((header) =>
        mine && header === 'import_row_number' ? String(kept) : row[header] ?? '',
      );
    });
  write(pkg, 'import-crosswalk.csv', renderCsv(crosswalk.headers, rows));
}

/**
 * Which line of an import file is a given record.
 *
 * The file does not say -- that is the separation package format 2.0.0 makes
 * -- so a tamper that wants to rewrite one record has to look it up in the
 * crosswalk, exactly as a reader would. A test that looked for a key column
 * that is no longer there would silently rewrite nothing and pass.
 */
function importRowNumberFor(pkg: Package, importPath: string, migrationKey: string): number {
  const crosswalk = readTable(pkg.dir, 'import-crosswalk.csv');
  const entry = crosswalk.rows.find(
    (row) =>
      (row['import_path'] ?? '') === importPath && (row['migration_key'] ?? '') === migrationKey,
  );
  assert.ok(entry !== undefined, `${migrationKey} is in no crosswalk row for ${importPath}`);
  return Number(entry['import_row_number'] ?? '0');
}

/**
 * Adds a delivered record to an import file the way a forger would have to.
 *
 * In package format 2.0.0 an import file does not say which record each of its
 * rows is; the crosswalk does. So inserting a row means inserting the matching
 * crosswalk row, renumbering the rest of that file, and putting both back in
 * the order the package declares. A tamper that only edits the import file is
 * caught by the crosswalk before any deeper check is reached, which makes it a
 * test of the crosswalk rather than of the check it was written for.
 */
function deliverExtraRecord(
  pkg: Package,
  importPath: string,
  migrationKey: string,
  cells: readonly string[],
  object: string,
): void {
  const importTable = readTable(pkg.dir, importPath);
  const crosswalk = readTable(pkg.dir, 'import-crosswalk.csv');

  const mine = crosswalk.rows.filter((row) => (row['import_path'] ?? '') === importPath);
  const others = crosswalk.rows.filter((row) => (row['import_path'] ?? '') !== importPath);
  const combined = mine.map((row, index) => ({
    migrationKey: row['migration_key'] ?? '',
    associationKey: row['association_key'] ?? '',
    survivor: row['survivor_row_locator_id'] ?? '',
    cells: importTable.headers.map((header) => importTable.rows[index]?.[header] ?? ''),
  }));
  combined.push({
    migrationKey,
    associationKey: '',
    survivor: 'F-forged:S0:R2',
    cells: [...cells],
  });
  combined.sort((a, b) => (a.migrationKey < b.migrationKey ? -1 : a.migrationKey > b.migrationKey ? 1 : 0));

  write(pkg, importPath, renderCsv(importTable.headers, combined.map((entry) => entry.cells)));
  write(
    pkg,
    'import-crosswalk.csv',
    renderCsv(crosswalk.headers, [
      ...others.map((row) => crosswalk.headers.map((header) => row[header] ?? '')),
      ...combined.map((entry, index) =>
        crosswalk.headers.map((header) => {
          if (header === 'import_path') return importPath;
          if (header === 'import_row_number') return String(index + 1);
          if (header === 'association_key') return entry.associationKey;
          if (header === 'migration_key') return entry.migrationKey;
          if (header === 'object') return object;
          if (header === 'survivor_row_locator_id') return entry.survivor;
          return '';
        }),
      ),
    ].sort((a, b) => {
      const left = `${a[0] ?? ''}|${String(a[1] ?? '').padStart(12, '0')}`;
      const right = `${b[0] ?? ''}|${String(b[1] ?? '').padStart(12, '0')}`;
      return left < right ? -1 : left > right ? 1 : 0;
    })),
  );

  const reconciliation = readJson(pkg, 'reconciliation.json');
  const records = reconciliation['records'] as { deliveredTotal: number; byObject: Record<string, number> };
  records.deliveredTotal += 1;
  records.byObject[object] = (records.byObject[object] ?? 0) + 1;
  writeJson(pkg, 'reconciliation.json', reconciliation);
  repairAudit(pkg);
  repairManifest(pkg);
}

function repairManifest(pkg: Package): void {
  const manifest = readJson(pkg, 'manifest.json');
  const present = new Set(listPackageFiles(pkg.dir).filter((path) => path !== 'manifest.json'));
  const artifacts = (manifest['artifacts'] as { path: string; rowCount: number | null; kind?: string }[])
    .filter((artifact) => present.has(artifact.path))
    .map((artifact) => {
      const bytes = readFileSync(join(pkg.dir, ...artifact.path.split('/')));
      const rowCount =
        artifact.rowCount === null
          ? null
          : Math.max(0, bytes.toString('utf8').split('\n').filter((line) => line.length > 0).length - 1);
      // Everything else the manifest declares about an artifact (its kind, since
      // package format 2.1.0) is kept: a repair restores the hashes, it does not
      // re-declare what the file is.
      return { ...artifact, sha256: sha256Hex(bytes), byteLength: bytes.length, rowCount };
    });
  writeJson(pkg, 'manifest.json', { ...manifest, artifacts: artifacts as never });
}

/** Re-renders the audit summary so it agrees with a reconciliation the tamper edited. */
function repairAudit(pkg: Package): void {
  const reconciliation = readJson(pkg, 'reconciliation.json') as unknown as Reconciliation;
  const { adapter } = pkg;
  write(
    pkg,
    'audit.md',
    renderAudit(reconciliation, {
      instanceVerification: readTable(pkg.dir, 'instance-verification.csv').rows.map((row) => ({
        scope: row['scope'] ?? '',
        detail: row['detail'] ?? '',
        sourceUrl: row['source_url'] ?? '',
      })),
      vendorSources: adapter.sources,
      adapterNotes: adapter.objects.flatMap((spec) => spec.notes),
    }),
  );
}

function expectCaught(pkg: Package, check: string): void {
  const report = verifyPackage(pkg.dir, { scratch: verifyScratch(pkg.dir) });
  assert.equal(report.passed, false, 'the verifier accepted a tampered package');
  assert.ok(
    report.problems.some((problem) => problem.check === check),
    `expected check "${check}" to fire; problems were: ${report.problems.map((problem) => `${problem.check}: ${problem.detail}`).join(' | ') || '(none)'}`,
  );
}

/**
 * The same, insisting on which of a check's several things it said.
 *
 * `manifest.artifactHashes` compares a digest and a length, and a case written
 * to prove one of those is checked passes on the other unless it says which. A
 * tamper that changes the length would be caught by the digest as well, so
 * "something fired" is not evidence that the length is compared at all.
 */
function expectCaughtSaying(pkg: Package, check: string, fragment: string): void {
  const report = verifyPackage(pkg.dir, { scratch: verifyScratch(pkg.dir) });
  assert.equal(report.passed, false, 'the verifier accepted a tampered package');
  assert.ok(
    report.problems.some((problem) => problem.check === check && problem.detail.includes(fragment)),
    `expected check "${check}" to say "${fragment}"; problems were: ${report.problems.map((problem) => `${problem.check}: ${problem.detail}`).join(' | ') || '(none)'}`,
  );
}

/**
 * A check that must stay silent about a package it has no business refusing.
 *
 * A verifier that rejects a correct package is worse than one that misses a
 * tampered one, and the canonical-bytes check has already cost this repository
 * one of those: a scan for CRLF anywhere in a file aborted runs whose data
 * legitimately held a line break. Only the named check is asserted on, because
 * these packages are deliberately wrong in other ways -- an artifact this
 * configuration does not produce is refused by a different check saying a
 * different thing, which is correct and is not what is under test here.
 */
function expectNotCaught(pkg: Package, check: string): void {
  const report = verifyPackage(pkg.dir, { scratch: verifyScratch(pkg.dir) });
  assert.deepEqual(
    report.problems.filter((problem) => problem.check === check).map((problem) => problem.detail),
    [],
    `"${check}" refused a package it should have accepted`,
  );
}

describe('a leftover is a row the configuration did not cover', () => {
  it('is caught when a row the configuration did cover is listed as a leftover', () => {
    // The corroboration a leftover needs. `LEFTOVER_NO_RECORD_MAPPING` says the
    // configuration covered nothing on this row, and the lineage is the witness:
    // if it names a record mapping for the row, the package is contradicting
    // itself. Without this the reason code could be attached to any row at all,
    // which is how a delivered record is withheld by relabelling it.
    const pkg = open('G01-clean-contacts', 'tamper-leftover-covered');
    const lineage = readTable(pkg.dir, 'source-lineage.csv');
    const covered = lineage.rows.find((row) => (row['record_mapping_id'] ?? '') !== '');
    assert.ok(covered !== undefined, 'the fixture needs a row the configuration covers');

    const leftovers = readTable(pkg.dir, 'leftovers.csv');
    write(
      pkg,
      'leftovers.csv',
      renderCsv(leftovers.headers, [
        ...leftovers.rows.map((row) => leftovers.headers.map((header) => row[header] ?? '')),
        leftovers.headers.map((header) =>
          header === 'reason_code'
            ? 'LEFTOVER_NO_RECORD_MAPPING'
            : header === 'detail'
              ? 'relabelled by hand'
              : covered[header] ?? '',
        ),
      ]),
    );

    // The counts are repaired so the tamper is not caught by arithmetic alone.
    const reconciliation = readJson(pkg, 'reconciliation.json');
    const sourceRows = reconciliation['sourceRows'] as {
      total: number;
      ingested: number;
      accountedFor: number;
      byDisposition: Record<string, number>;
    };
    sourceRows.byDisposition['LEFTOVER'] = (sourceRows.byDisposition['LEFTOVER'] ?? 0) + 1;
    sourceRows.total += 1;
    sourceRows.ingested += 1;
    sourceRows.accountedFor += 1;
    const tally = reconciliation['reasonCodeTally'] as Record<string, number>;
    tally['LEFTOVER_NO_RECORD_MAPPING'] = (tally['LEFTOVER_NO_RECORD_MAPPING'] ?? 0) + 1;
    writeJson(pkg, 'reconciliation.json', reconciliation);
    repairAudit(pkg);
    repairManifest(pkg);

    expectCaught(pkg, 'leftovers.corroborated');
  });
});

describe('a delivered value cannot be rewritten', () => {
  it('is caught when a value the change log describes is altered', () => {
    const pkg = open('G02-safe-formatting', 'tamper-value');
    const path = '01_IMPORT/clean-only/contacts.csv';
    write(pkg, path, read(pkg, path).replace('+12125550147', '+19999999999'));
    repairManifest(pkg);
    expectCaught(pkg, 'changes.matchDeliveredValues');
  });

  it('is caught when a record no source row produced is inserted', () => {
    const pkg = open('G01-clean-contacts', 'tamper-ghost');
    const path = '01_IMPORT/clean-only/contacts.csv';
    const columns = readTable(pkg.dir, path).headers.length;
    deliverExtraRecord(
      pkg,
      path,
      'mk_contact_zzzzzzzzzzzzzzzzzzzz',
      Array<string>(columns).fill('ghost'),
      'CONTACT',
    );

    expectCaught(pkg, 'import.everyRecordHasASourceRow');
  });

  it('is caught when an extra file is added and listed in the manifest', () => {
    const pkg = open('G01-clean-contacts', 'tamper-extra-file');
    write(
      pkg,
      '01_IMPORT/clean-only/contacts-extra.csv',
      `${pkg.adapter.associationKeyHeader},contact.email\nmk_x,evil@example.com\n`,
    );
    repairManifest(pkg);
    const manifest = readJson(pkg, 'manifest.json');
    const artifacts = manifest['artifacts'] as { path: string; sha256: string; byteLength: number; rowCount: number | null }[];
    const bytes = readFileSync(join(pkg.dir, '01_IMPORT', 'clean-only', 'contacts-extra.csv'));
    artifacts.push({
      path: '01_IMPORT/clean-only/contacts-extra.csv',
      sha256: sha256Hex(bytes),
      byteLength: bytes.length,
      rowCount: 1,
    });
    artifacts.sort((a, b) => (a.path < b.path ? -1 : 1));
    writeJson(pkg, 'manifest.json', manifest);
    expectCaught(pkg, 'manifest.noUnexpectedArtifacts');
  });
});

describe('the audit trail cannot be thinned out', () => {
  it('is caught when a change is deleted and the count is corrected', () => {
    const pkg = open('G02-safe-formatting', 'tamper-drop-change');
    const lines = read(pkg, 'changes.csv').split('\n').filter((line) => line.length > 0);
    write(pkg, 'changes.csv', `${[lines[0], ...lines.slice(2)].join('\n')}\n`);

    const reconciliation = readJson(pkg, 'reconciliation.json');
    const cells = reconciliation['cells'] as { changed: number };
    cells.changed -= 1;
    writeJson(pkg, 'reconciliation.json', reconciliation);
    repairAudit(pkg);
    repairManifest(pkg);

    expectCaught(pkg, 'reconciliation.reasonCodeTally');
  });

  it('is caught when a reason code is replaced with one that does not exist', () => {
    const pkg = open('G01-clean-contacts', 'tamper-reason-code');
    write(pkg, 'source-lineage.csv', read(pkg, 'source-lineage.csv').split('INGEST_ROW_ACCEPTED').join('NOT_A_REAL_CODE'));
    repairManifest(pkg);
    expectCaught(pkg, 'reasonCodes.registered');
  });

  it('is caught when the reconciliation is edited to describe evidence that is not there', () => {
    const pkg = open('G01-clean-contacts', 'tamper-reconciliation');
    const reconciliation = readJson(pkg, 'reconciliation.json');
    const cells = reconciliation['cells'] as { flagged: number; unmappedPreserved: number };
    cells.flagged = 3;
    cells.unmappedPreserved = 8;
    const identity = reconciliation['identity'] as { absorbedRows: number; duplicateCandidateClusters: number };
    identity.absorbedRows = 42;
    identity.duplicateCandidateClusters = 7;
    writeJson(pkg, 'reconciliation.json', reconciliation);
    repairAudit(pkg);
    repairManifest(pkg);
    expectCaught(pkg, 'artifacts.countsAgree');
  });

  it('is caught when the reconciliation asserts its own equation while the counts disagree', () => {
    const pkg = open('G01-clean-contacts', 'tamper-equation');
    const reconciliation = readJson(pkg, 'reconciliation.json');
    const rows = reconciliation['sourceRows'] as {
      ingested: number;
      total: number;
      accountedFor: number;
      byDisposition: Record<string, number>;
      withoutDisposition: number;
      equationHolds: boolean;
    };
    rows.byDisposition['OUTPUT'] = (rows.byDisposition['OUTPUT'] ?? 0) - 1;
    rows.equationHolds = true;
    rows.withoutDisposition = 0;
    writeJson(pkg, 'reconciliation.json', reconciliation);
    repairAudit(pkg);
    repairManifest(pkg);
    expectCaught(pkg, 'reconciliation.equation');
  });

  it('is caught when the manifest metadata contradicts the reconciliation', () => {
    const pkg = open('G01-clean-contacts', 'tamper-manifest-meta');
    const manifest = readJson(pkg, 'manifest.json');
    manifest['coreVersion'] = '9.9.9';
    manifest['runId'] = 'run_forged';
    writeJson(pkg, 'manifest.json', manifest);
    expectCaught(pkg, 'manifest.agreesWithData');
  });
});

describe('relationships cannot be added, removed or doubled', () => {
  const RELATIONSHIP_FILE = '01_IMPORT/clean-only/associations/contact_to_company.csv';

  it('is caught when a relationship no source row asserts is appended', () => {
    const pkg = open('G11-associations', 'tamper-edge-add');
    const lines = read(pkg, RELATIONSHIP_FILE).split('\n').filter((line) => line.length > 0);
    const first = (lines[1] ?? '').split(',');
    write(pkg, RELATIONSHIP_FILE, `${[...lines, `${String(first[0])},mk_company_ffffffffffffffffffff,`].join('\n')}\n`);
    repairManifest(pkg);
    expectCaught(pkg, 'import.associationFiles');
  });

  it('is caught when a delivered relationship is deleted', () => {
    const pkg = open('G11-associations', 'tamper-edge-remove');
    const lines = read(pkg, RELATIONSHIP_FILE).split('\n').filter((line) => line.length > 0);
    write(pkg, RELATIONSHIP_FILE, `${[lines[0], ...lines.slice(2)].join('\n')}\n`);
    repairManifest(pkg);
    expectCaught(pkg, 'import.associationFiles');
  });

  it('is caught when a relationship is delivered twice', () => {
    const pkg = open('G11-associations', 'tamper-edge-double');
    const lines = read(pkg, RELATIONSHIP_FILE).split('\n').filter((line) => line.length > 0);
    write(pkg, RELATIONSHIP_FILE, `${[...lines, String(lines[1])].join('\n')}\n`);
    repairManifest(pkg);
    expectCaught(pkg, 'import.associationFiles');
  });

  it('is caught when a whole relationship file is removed', () => {
    const pkg = open('G11-associations', 'tamper-edge-file-gone');
    const { associationFromHeader, associationToHeader } = pkg.adapter;
    write(pkg, RELATIONSHIP_FILE, `${associationFromHeader},${associationToHeader},Association Label\n`);
    repairManifest(pkg);
    expectCaught(pkg, 'import.associationFiles');
  });

  it('is caught when a deduplicated relationship points at nothing', () => {
    const pkg = open('G13-merge-association-remap', 'tamper-dedup-pointer');
    const text = read(pkg, 'associations.csv');
    const match = /,(ed_[0-9a-f]{16})\n/u.exec(text);
    assert.ok(match !== null, 'the fixture must contain a deduplication pointer');
    write(pkg, 'associations.csv', text.replace(match[0], ',ed_0000000000000000\n'));
    repairManifest(pkg);
    expectCaught(pkg, 'associations.deduplicationPointer');
  });

  it('is caught when the unresolved list names a relationship that does not exist', () => {
    const pkg = open('G12-missing-endpoint', 'tamper-unresolved');
    const lines = read(pkg, 'unresolved-associations.csv').split('\n');
    const row = (lines[1] ?? '').split(',');
    row[0] = 'ed_ffffffffffffffff';
    lines[1] = row.join(',');
    write(pkg, 'unresolved-associations.csv', lines.join('\n'));
    repairManifest(pkg);
    expectCaught(pkg, 'associations.unresolvedAreReal');
  });
});

describe('a record set aside cannot be quietly delivered', () => {
  it('is caught when a destination key conflict is delivered anyway', () => {
    const pkg = open('G06-false-email-duplicates', 'tamper-conflict-delivered');
    const conflicts = readTable(pkg.dir, 'destination-conflicts.csv');
    const key = (conflicts.rows[0]?.['migration_keys'] ?? '').split(' ')[0] ?? '';
    assert.notEqual(key, '', 'the fixture must record a destination key conflict');

    const path = '01_IMPORT/hubspot/contacts.csv';
    const columns = readTable(pkg.dir, path).headers.length;
    deliverExtraRecord(
      pkg,
      path,
      key,
      ['shared@example.com', ...Array<string>(columns - 1).fill('x')],
      'CONTACT',
    );

    expectCaught(pkg, 'destination.conflictsAreNotDelivered');
  });
});

describe('the spreadsheet warning names the real values', () => {
  it('is caught when the warning rows are rewritten but the count is kept', () => {
    const pkg = open('G16-hostile-csv', 'tamper-formula-risk');
    // Parsed and re-rendered rather than split on commas, because the values in
    // this fixture deliberately contain commas and quotes.
    const table = readTable(pkg.dir, 'formula-risk.csv');
    assert.ok(table.rows.length > 0, 'the fixture must declare formula-risk values');
    write(
      pkg,
      'formula-risk.csv',
      renderCsv(
        table.headers,
        table.rows.map((row) => table.headers.map((header) => (header === 'value' ? 'nonsense' : row[header] ?? ''))),
      ),
    );
    repairManifest(pkg);
    expectCaught(pkg, 'csvSafety.riskValuesMatch');
  });
});

describe('the human view cannot carry an executable cell (R2-010)', () => {
  const VIEW = '04_DOCUMENTATION/data-view/clean-only/contacts.csv';

  it('[R2-010] the verifier refuses a package whose human view carries an executable cell', () => {
    // A view whose neutralising apostrophe was taken off again, manifest repaired.
    const pkg = open('G16-hostile-csv', 'tamper-human-view-cell');
    assert.ok(read(pkg, VIEW).includes("'=SUM(A1:A9)"), 'the fixture must have a data view with a neutralised formula');
    write(pkg, VIEW, read(pkg, VIEW).replace("'=SUM(A1:A9)", '=SUM(A1:A9)'));
    repairManifest(pkg);
    expectCaught(pkg, 'humanView.noExecutableCell');

    // The same in formula-risk.csv, which is a human view too.
    const risk = open('G16-hostile-csv', 'tamper-human-view-risk');
    const table = readTable(risk.dir, 'formula-risk.csv');
    write(
      risk,
      'formula-risk.csv',
      renderCsv(
        table.headers,
        table.rows.map((row) =>
          table.headers.map((header) => {
            const value = row[header] ?? '';
            return header === 'value' && value.startsWith("'") ? value.slice(1) : value;
          }),
        ),
      ),
    );
    repairManifest(risk);
    expectCaught(risk, 'humanView.noExecutableCell');
  });

  it('refuses a view that no longer matches what its import file says', () => {
    const pkg = open('G16-hostile-csv', 'tamper-human-view-drift');
    write(pkg, VIEW, read(pkg, VIEW).replace('Lovelace', 'Babbage'));
    repairManifest(pkg);
    expectCaught(pkg, 'humanView.matchesImport');
  });

  it('refuses a package whose data view is missing for an import file that has a risky cell', () => {
    const missing = open('G16-hostile-csv', 'tamper-human-view-missing');
    rmSync(join(missing.dir, ...VIEW.split('/')));
    repairManifest(missing);
    expectCaught(missing, 'humanView.presence');
  });

  it('refuses a manifest that calls a human view exact, or an import file a view', () => {
    const pkg = open('G16-hostile-csv', 'tamper-human-view-kind');
    const manifest = readJson(pkg, 'manifest.json');
    const artifacts = manifest['artifacts'] as { path: string; kind: string }[];
    for (const artifact of artifacts) if (artifact.path === VIEW) artifact.kind = 'MACHINE_EVIDENCE_CSV';
    writeJson(pkg, 'manifest.json', manifest);
    expectCaught(pkg, 'humanView.kindDeclared');
  });
});

/**
 * A second review took the strengthened verifier apart again and got 65 more
 * edits past it. These are the ones it ranked as changing what an operator
 * would import or read; each names the gap it walked through.
 */
describe('a second review: rows that were counted but never checked', () => {
  it('is caught when an object is removed from the reconciliation instead of counted as zero', () => {
    // The check iterated the reconciliation's own keys, so deleting one
    // skipped the check for that object and its records could be removed.
    const pkg = open('G01-clean-contacts', 'tamper-object-key');
    const path = '01_IMPORT/clean-only/contacts.csv';
    const lines = read(pkg, path).split('\n').filter((line) => line.length > 0);
    write(pkg, path, `${[lines[0], ...lines.slice(2)].join('\n')}\n`);
    const reconciliation = readJson(pkg, 'reconciliation.json');
    const records = reconciliation['records'] as { byObject: Record<string, number> };
    delete records.byObject['CONTACT'];
    writeJson(pkg, 'reconciliation.json', reconciliation);
    repairAudit(pkg);
    repairManifest(pkg);
    expectCaught(pkg, 'import.recordCounts');
  });

  it('is caught when one row of the change log is overwritten with a copy of another', () => {
    // Row count, reason-code tally and every other number stay exactly right.
    // One real change is erased and another is listed twice.
    const pkg = open('G02-safe-formatting', 'tamper-duplicate-change');
    const table = readTable(pkg.dir, 'changes.csv');
    assert.ok(table.rows.length >= 2, 'the fixture needs at least two changes');
    const rows = table.rows.map((row, index) => table.headers.map((header) => (index === 1 ? table.rows[0]?.[header] ?? '' : row[header] ?? '')));
    write(pkg, 'changes.csv', renderCsv(table.headers, rows));
    repairManifest(pkg);
    expectCaught(pkg, 'artifacts.uniqueKeys');
  });

  it('is caught when an artifact is reordered', () => {
    const pkg = open('G02-safe-formatting', 'tamper-reorder-changes');
    const table = readTable(pkg.dir, 'changes.csv');
    assert.ok(table.rows.length >= 2, 'the fixture needs at least two changes');
    const rows = [...table.rows].reverse().map((row) => table.headers.map((header) => row[header] ?? ''));
    write(pkg, 'changes.csv', renderCsv(table.headers, rows));
    repairManifest(pkg);
    expectCaught(pkg, 'artifacts.ordering');
  });

  it('is caught when an artifact repeats a source row incorrectly', () => {
    const pkg = open('G02-safe-formatting', 'tamper-provenance');
    const table = readTable(pkg.dir, 'changes.csv');
    const rows = table.rows.map((row) => table.headers.map((header) => (header === 'row_hash' ? '0'.repeat(64) : row[header] ?? '')));
    write(pkg, 'changes.csv', renderCsv(table.headers, rows));
    repairManifest(pkg);
    expectCaught(pkg, 'artifacts.provenanceAgrees');
  });

  it('is caught when an import file is given CRLF line endings', () => {
    const pkg = open('G01-clean-contacts', 'tamper-crlf');
    const path = '01_IMPORT/clean-only/contacts.csv';
    write(pkg, path, read(pkg, path).split('\n').join('\r\n'));
    repairManifest(pkg);
    expectCaught(pkg, 'artifacts.canonicalBytes');
  });

  it('is caught when an import file is given a byte order mark', () => {
    const pkg = open('G01-clean-contacts', 'tamper-bom');
    const path = '01_IMPORT/clean-only/contacts.csv';
    write(pkg, path, `\uFEFF${read(pkg, path)}`);
    repairManifest(pkg);
    expectCaught(pkg, 'artifacts.canonicalBytes');
  });

  it('is caught when every field of an import file is re-quoted', () => {
    const pkg = open('G01-clean-contacts', 'tamper-requote');
    const path = '01_IMPORT/clean-only/contacts.csv';
    const requoted = read(pkg, path)
      .split('\n')
      .map((line) => (line.length === 0 ? line : line.split(',').map((field) => `"${field.replace(/"/gu, '""')}"`).join(',')))
      .join('\n');
    write(pkg, path, requoted);
    repairManifest(pkg);
    expectCaught(pkg, 'artifacts.canonicalBytes');
  });

  it('is caught when bytes are appended after the last row of an artifact', () => {
    // The canonical-bytes check compares a line at a time rather than building a
    // second copy of the whole file. Comparing line by line is only equivalent
    // to comparing the file if the lines are also all of the file, so a trailer
    // after the final row is the case that separates the two.
    const pkg = open('G01-clean-contacts', 'tamper-trailer');
    const path = '01_IMPORT/clean-only/contacts.csv';
    write(pkg, path, `${read(pkg, path)}# appended\n`);
    repairManifest(pkg);
    expectCaught(pkg, 'artifacts.canonicalBytes');
  });

  it('is caught when a row carries fewer fields than the header declares', () => {
    // A short row re-renders as a short line, so a check that compared the file
    // against a re-render of its own raw records would reproduce the damage and
    // call it canonical. The comparison addresses fields by header name for
    // exactly this reason.
    const pkg = open('G01-clean-contacts', 'tamper-short-row');
    const path = '01_IMPORT/clean-only/contacts.csv';
    const lines = read(pkg, path).split('\n');
    const second = lines[1] ?? '';
    lines[1] = second.slice(0, second.lastIndexOf(','));
    write(pkg, path, lines.join('\n'));
    repairManifest(pkg);
    expectCaught(pkg, 'artifacts.canonicalBytes');
  });

  it('is caught when the package claims an import mode the destination does not support', () => {
    const pkg = open('G01-clean-contacts', 'tamper-mode');
    const manifest = readJson(pkg, 'manifest.json');
    (manifest['target'] as { importMode: string }).importMode = 'UPSERT';
    writeJson(pkg, 'manifest.json', manifest);
    const reconciliation = readJson(pkg, 'reconciliation.json');
    reconciliation['importMode'] = 'UPSERT';
    writeJson(pkg, 'reconciliation.json', reconciliation);
    repairAudit(pkg);
    repairManifest(pkg);
    expectCaught(pkg, 'import.modeSupported');
  });

  it('is caught when a delivered record is relabelled as isolated with nothing behind it', () => {
    const pkg = open('G01-clean-contacts', 'tamper-relabel-isolated');
    const lineage = readTable(pkg.dir, 'source-lineage.csv');
    const victim = lineage.rows.find((row) => (row['disposition'] ?? '') === 'OUTPUT' && (row['contribution_kind'] ?? '') === 'RECORD');
    assert.ok(victim !== undefined, 'the fixture needs a delivered row');
    const isolated = readTable(pkg.dir, 'isolated.csv');
    const row = isolated.headers.map((header) => {
      if (header === 'reason_code') return 'ISOLATED_INVALID_FIELD';
      if (header === 'detail') return 'relabelled by hand';
      if (header === 'object') return 'CONTACT';
      if (header === 'record_mapping_id') return victim['record_mapping_id'] ?? '';
      return victim[header] ?? '';
    });
    write(pkg, 'isolated.csv', renderCsv(isolated.headers, [...isolated.rows.map((existing) => isolated.headers.map((header) => existing[header] ?? '')), row]));
    repairManifest(pkg);
    expectCaught(pkg, 'isolated.corroborated');
  });
});

describe('a second review: claims with nothing behind them', () => {
  it('is caught when a delivered relationship is re-pointed at another delivered record', () => {
    // Only endpoint existence was checked, so an edge declared by one row
    // could be made to start at a different record of the right object.
    const pkg = open('G11-associations', 'tamper-repoint');
    const table = readTable(pkg.dir, 'associations.csv');
    const owned = table.rows.find((row) => (row['disposition'] ?? '') === 'OUTPUT');
    assert.ok(owned !== undefined, 'the fixture needs a delivered relationship');
    const otherKey = table.rows
      .map((row) => row['from_migration_key'] ?? '')
      .find((key) => key !== (owned['from_migration_key'] ?? '') && key !== '');
    assert.ok(otherKey !== undefined, 'the fixture needs a second record to re-point at');
    const rows = table.rows.map((row) =>
      table.headers.map((header) =>
        row === owned && header === 'from_migration_key' ? otherKey : row[header] ?? '',
      ),
    );
    write(pkg, 'associations.csv', renderCsv(table.headers, rows));

    // Re-pointed in the import file too, which is what the reviewer did: the
    // ledger and the delivered file agree with each other and with every count.
    const importPath = `01_IMPORT/${pkg.adapter.importDirectory}/associations/${(owned['relationship_type'] ?? '').toLowerCase()}.csv`;
    write(
      pkg,
      importPath,
      read(pkg, importPath).split(owned['from_migration_key'] ?? '').join(otherKey),
    );
    repairManifest(pkg);
    expectCaught(pkg, 'associations.ownerSideAgrees');
  });

  it('is caught when a verification note is rewritten', () => {
    const pkg = open('G23-destination-required-field', 'tamper-instance-note');
    const table = readTable(pkg.dir, 'instance-verification.csv');
    assert.ok(table.rows.length >= 1, 'the fixture needs a verification note');
    const rows = table.rows.map((row, index) =>
      table.headers.map((header) =>
        index === 0 && header === 'reason_code' ? 'DESTINATION_FORMULA_RISK_VALUE' : row[header] ?? '',
      ),
    );
    write(pkg, 'instance-verification.csv', renderCsv(table.headers, rows));
    repairAudit(pkg);
    repairManifest(pkg);
    expectCaught(pkg, 'instanceVerification.matchesAdapter');
  });

  it('is caught when a destination conflict names a record no source row produced', () => {
    const pkg = open('G06-false-email-duplicates', 'tamper-conflict-key');
    const table = readTable(pkg.dir, 'destination-conflicts.csv');
    assert.ok(table.rows.length >= 1, 'the fixture needs a destination key conflict');
    const rows = table.rows.map((row, index) =>
      table.headers.map((header) =>
        index === 0 && header === 'migration_keys'
          ? 'mk_contact_zzzzzzzzzzzzzzzzzzzz mk_contact_yyyyyyyyyyyyyyyyyyyy'
          : row[header] ?? '',
      ),
    );
    write(pkg, 'destination-conflicts.csv', renderCsv(table.headers, rows));
    repairManifest(pkg);
    expectCaught(pkg, 'destination.conflictsAreNotDelivered');
  });
});

/**
 * A fourth review ran 66 tampers against the 50-check verifier and 50 were
 * accepted. These are the ones it ranked highest: a record invented out of
 * nothing, a merge that never happened, a delivered record withheld by
 * relabelling it, and a policy rewritten inside the package it governs.
 */
describe('a fourth review: identifiers that do not follow from their own inputs', () => {
  it('is caught when a record is invented out of nothing', () => {
    const pkg = open('G01-clean-contacts', 'tamper-invent-record');
    const lineage = readTable(pkg.dir, 'source-lineage.csv');
    const model = lineage.rows[0];
    assert.ok(model !== undefined, 'the fixture needs a lineage row to copy');
    const planted = lineage.headers.map((header) => {
      if (header === 'row_number') return '99';
      if (header === 'row_locator_id') return `${model['file_id'] ?? ''}:${model['sheet_id'] ?? ''}:R99`;
      if (header === 'row_hash') return 'a'.repeat(64);
      if (header === 'migration_key') return 'mk_contact_ffffffffffffffffffff';
      return model[header] ?? '';
    });
    write(
      pkg,
      'source-lineage.csv',
      renderCsv(lineage.headers, [
        ...lineage.rows.map((row) => lineage.headers.map((header) => row[header] ?? '')),
        planted,
      ]),
    );
    const importPath = '01_IMPORT/clean-only/contacts.csv';
    const table = readTable(pkg.dir, importPath);
    write(
      pkg,
      importPath,
      renderCsv(table.headers, [
        ...table.rows.map((row) => table.headers.map((header) => row[header] ?? '')),
        table.headers.map((header) =>
          header === pkg.adapter.associationKeyHeader ? 'mk_contact_ffffffffffffffffffff' : 'planted',
        ),
      ]),
    );
    const reconciliation = readJson(pkg, 'reconciliation.json');
    const sourceRows = reconciliation['sourceRows'] as { total: number; ingested: number; accountedFor: number; byDisposition: Record<string, number> };
    sourceRows.total += 1;
    sourceRows.ingested += 1;
    sourceRows.accountedFor += 1;
    sourceRows.byDisposition['OUTPUT'] = (sourceRows.byDisposition['OUTPUT'] ?? 0) + 1;
    const records = reconciliation['records'] as { deliveredTotal: number; byObject: Record<string, number> };
    records.deliveredTotal += 1;
    records.byObject['CONTACT'] = (records.byObject['CONTACT'] ?? 0) + 1;
    writeJson(pkg, 'reconciliation.json', reconciliation);
    repairAudit(pkg);
    repairManifest(pkg);
    expectCaught(pkg, 'identifiers.recomputed');
  });

  it('is caught when a merge that never happened is written into the package', () => {
    const pkg = open('G22-same-name-different-people', 'tamper-forge-merge');
    const lineage = readTable(pkg.dir, 'source-lineage.csv');
    const rows = lineage.rows.filter((row) => (row['contribution_kind'] ?? '') === 'RECORD');
    assert.ok(rows.length >= 2, 'the fixture needs two records');
    const survivor = rows[0];
    const victim = rows[1];
    assert.ok(survivor !== undefined && victim !== undefined);
    const mergeId = 'mg_0000000000000001';
    const rewritten = lineage.rows.map((row) => {
      if (row !== victim && row !== survivor) return lineage.headers.map((header) => row[header] ?? '');
      return lineage.headers.map((header) => {
        if (header === 'merge_id') return mergeId;
        if (row === victim) {
          if (header === 'disposition') return 'MERGED_PROVEN';
          if (header === 'reason_code') return 'IDENTITY_ROW_ABSORBED_BY_PROVEN_MERGE';
          if (header === 'migration_key') return survivor['migration_key'] ?? '';
          if (header === 'identity_key') return survivor['identity_key'] ?? '';
          if (header === 'record_identity_key') return survivor['record_identity_key'] ?? '';
        }
        return row[header] ?? '';
      });
    });
    write(pkg, 'source-lineage.csv', renderCsv(lineage.headers, rewritten));
    writeJson(pkg, 'merges.json', {
      merges: [
        {
          mergeId,
          object: 'CONTACT',
          survivorMigrationKey: survivor['migration_key'] ?? '',
          survivorRowLocatorId: survivor['row_locator_id'] ?? '',
          absorbedRowLocatorIds: [victim['row_locator_id'] ?? ''],
          identityEvidence: [
            {
              kind: 'SOURCE_RECORD_ID',
              authority: 'PROVING',
              heldByMembers: 2,
              value: survivor['identity_key'] ?? '',
              reasonCode: 'IDENTITY_PROVEN_SOURCE_RECORD_ID',
            },
          ],
          fieldDecisions: [],
          conflicts: [],
          associationRemaps: [],
          ruleVersion: '1.0.0',
        },
      ],
    } as never);
    const importPath = '01_IMPORT/clean-only/contacts.csv';
    withholdDeliveredRecord(pkg, importPath, victim['migration_key'] ?? '');
    const reconciliation = readJson(pkg, 'reconciliation.json');
    const sourceRows = reconciliation['sourceRows'] as { byDisposition: Record<string, number> };
    sourceRows.byDisposition['OUTPUT'] = (sourceRows.byDisposition['OUTPUT'] ?? 0) - 1;
    sourceRows.byDisposition['MERGED_PROVEN'] = (sourceRows.byDisposition['MERGED_PROVEN'] ?? 0) + 1;
    const records = reconciliation['records'] as { deliveredTotal: number; byObject: Record<string, number> };
    records.deliveredTotal -= 1;
    records.byObject['CONTACT'] = (records.byObject['CONTACT'] ?? 0) - 1;
    const identity = reconciliation['identity'] as { provenMerges: number };
    identity.provenMerges += 1;
    writeJson(pkg, 'reconciliation.json', reconciliation);
    repairAudit(pkg);
    repairManifest(pkg);
    expectCaught(pkg, 'identifiers.recomputed');
  });

  it('is caught when a delivered record is withheld as a leftover', () => {
    const pkg = open('G01-clean-contacts', 'tamper-withhold-leftover');
    const lineage = readTable(pkg.dir, 'source-lineage.csv');
    const victim = lineage.rows.find((row) => (row['disposition'] ?? '') === 'OUTPUT');
    assert.ok(victim !== undefined);
    const rewritten = lineage.rows.map((row) =>
      lineage.headers.map((header) => {
        if (row !== victim) return row[header] ?? '';
        if (header === 'disposition') return 'LEFTOVER';
        if (header === 'reason_code') return 'LEFTOVER_ASSOCIATION_SHEET_ONLY';
        return row[header] ?? '';
      }),
    );
    write(pkg, 'source-lineage.csv', renderCsv(lineage.headers, rewritten));
    const leftovers = readTable(pkg.dir, 'leftovers.csv');
    write(
      pkg,
      'leftovers.csv',
      renderCsv(leftovers.headers, [
        ...leftovers.rows.map((row) => leftovers.headers.map((header) => row[header] ?? '')),
        leftovers.headers.map((header) => (header === 'reason_code' ? 'LEFTOVER_ASSOCIATION_SHEET_ONLY' : header === 'detail' ? 'relabelled' : victim[header] ?? '')),
      ]),
    );
    repairManifest(pkg);
    expectCaught(pkg, 'leftovers.corroborated');
  });

  it('is caught when a merge that absorbs nothing buys the change-log exemption', () => {
    const pkg = open('G02-safe-formatting', 'tamper-empty-merge');
    const changes = readTable(pkg.dir, 'changes.csv');
    const change = changes.rows[0];
    assert.ok(change !== undefined);
    const lineage = readTable(pkg.dir, 'source-lineage.csv');
    const owner = lineage.rows.find((row) => (row['row_locator_id'] ?? '') === (change['row_locator_id'] ?? ''));
    assert.ok(owner !== undefined);
    const key = owner['migration_key'] ?? '';
    const evidenceValue = owner['identity_key'] ?? '';
    const mergeId = mergeIdFor([evidenceValue]);
    writeJson(pkg, 'merges.json', {
      merges: [
        {
          mergeId,
          object: 'CONTACT',
          survivorMigrationKey: key,
          survivorRowLocatorId: owner['row_locator_id'] ?? '',
          absorbedRowLocatorIds: [],
          identityEvidence: [
            {
              kind: 'SOURCE_RECORD_ID',
              authority: 'PROVING',
              heldByMembers: 2,
              value: evidenceValue,
              reasonCode: 'IDENTITY_PROVEN_SOURCE_RECORD_ID',
            },
          ],
          fieldDecisions: [],
          conflicts: [],
          associationRemaps: [],
          ruleVersion: '1.0.0',
        },
      ],
    } as never);
    write(
      pkg,
      'source-lineage.csv',
      renderCsv(
        lineage.headers,
        lineage.rows.map((row) =>
          lineage.headers.map((header) =>
            row === owner && header === 'merge_id' ? mergeId : row[header] ?? '',
          ),
        ),
      ),
    );
    const reconciliation = readJson(pkg, 'reconciliation.json');
    (reconciliation['identity'] as { provenMerges: number }).provenMerges = 1;
    writeJson(pkg, 'reconciliation.json', reconciliation);
    repairAudit(pkg);
    const importPath = '01_IMPORT/clean-only/contacts.csv';
    const rowNumber = importRowNumberFor(pkg, importPath, key);
    const table = readTable(pkg.dir, importPath);
    write(
      pkg,
      importPath,
      renderCsv(
        table.headers,
        table.rows.map((row, index) =>
          table.headers.map((header) =>
            index + 1 === rowNumber && header === 'contact.firstName' ? 'Rewritten' : row[header] ?? '',
          ),
        ),
      ),
    );
    repairManifest(pkg);
    expectCaught(pkg, 'changes.matchDeliveredValues');
  });
});

describe('a fourth review: checks that could be disabled by the artifact they audit', () => {
  it('is caught when the conflict report is emptied and a conflicted record delivered', () => {
    // The whole check used to live inside a loop over this file, so emptying
    // it disabled the check rather than failing it.
    const pkg = open('G06-false-email-duplicates', 'tamper-empty-conflicts');
    const conflicts = readTable(pkg.dir, 'destination-conflicts.csv');
    assert.ok(conflicts.rows.length >= 1, 'the fixture needs a destination key conflict');
    write(pkg, 'destination-conflicts.csv', renderCsv(conflicts.headers, []));
    const reconciliation = readJson(pkg, 'reconciliation.json');
    (reconciliation['destination'] as { keyConflicts: number }).keyConflicts = 0;
    writeJson(pkg, 'reconciliation.json', reconciliation);
    repairAudit(pkg);
    repairManifest(pkg);
    expectCaught(pkg, 'destination.conflictsAreNotDelivered');
  });

  it('is caught when an edge-file relationship is re-pointed at another record', () => {
    // Edge-file relationships were skipped entirely, so every one of them
    // could be pointed at any other delivered record of the right object.
    const pkg = open('G11-associations', 'tamper-edgefile-repoint');
    const table = readTable(pkg.dir, 'associations.csv');
    const edge = table.rows.find(
      (row) => (row['disposition'] ?? '') === 'OUTPUT' && (row['association_mapping_id'] ?? '') === 'contact-deal',
    );
    assert.ok(edge !== undefined, 'the fixture needs a delivered edge-file relationship');
    const otherKey = table.rows
      .map((row) => row['to_migration_key'] ?? '')
      .find((key) => key !== (edge['to_migration_key'] ?? '') && key.startsWith('mk_deal_'));
    assert.ok(otherKey !== undefined, 'the fixture needs a second deal to re-point at');
    write(
      pkg,
      'associations.csv',
      renderCsv(
        table.headers,
        table.rows.map((row) =>
          table.headers.map((header) => (row === edge && header === 'to_migration_key' ? otherKey : row[header] ?? '')),
        ),
      ),
    );
    const importPath = `01_IMPORT/${pkg.adapter.importDirectory}/associations/contact_to_deal.csv`;
    write(
      pkg,
      importPath,
      read(pkg, importPath).split(edge['to_migration_key'] ?? '').join(otherKey),
    );
    repairManifest(pkg);
    expectCaught(pkg, 'associations.ownerSideAgrees');
  });
});

describe('a relationship row says what the ledger says', () => {
  it('is caught when an isolation blames a reason the relationship ledger does not record', () => {
    const pkg = open('G34-relationship-endpoint-absent', 'tamper-assoc-reason');
    const isolated = readTable(pkg.dir, 'isolated.csv');
    assert.ok(isolated.rows.length >= 1, 'the fixture needs an isolated relationship row');
    write(
      pkg,
      'isolated.csv',
      renderCsv(
        isolated.headers,
        isolated.rows.map((row) =>
          isolated.headers.map((header) => (header === 'reason_code' ? 'ASSOCIATION_ENDPOINT_AMBIGUOUS' : row[header] ?? '')),
        ),
      ),
    );
    const lineage = readTable(pkg.dir, 'source-lineage.csv');
    write(
      pkg,
      'source-lineage.csv',
      renderCsv(
        lineage.headers,
        lineage.rows.map((row) =>
          lineage.headers.map((header) =>
            (row['disposition'] ?? '') === 'ISOLATED' && header === 'reason_code'
              ? 'ASSOCIATION_ENDPOINT_AMBIGUOUS'
              : row[header] ?? '',
          ),
        ),
      ),
    );
    const reconciliation = readJson(pkg, 'reconciliation.json');
    const tally = reconciliation['reasonCodeTally'] as Record<string, number>;
    delete tally['ASSOCIATION_ENDPOINT_NOT_FOUND'];
    tally['ASSOCIATION_ENDPOINT_AMBIGUOUS'] = 1;
    writeJson(pkg, 'reconciliation.json', reconciliation);
    repairAudit(pkg);
    repairManifest(pkg);
    expectCaught(pkg, 'isolated.corroborated');
  });
});

describe('a record named in a conflict cannot simply vanish', () => {
  it('is caught when a conflicted record is neither delivered nor set aside', () => {
    // Both records sharing a destination key are set aside. Moving one of them
    // to the rejected-input partition takes it out of both the delivered and
    // the isolated sets, so the conflict report names a record the package no
    // longer accounts for as a record at all.
    const pkg = open('G06-false-email-duplicates', 'tamper-conflict-vanish');
    const isolated = readTable(pkg.dir, 'isolated.csv');
    const victim = isolated.rows.find((row) => (row['reason_code'] ?? '') === 'DESTINATION_KEY_CONFLICT');
    assert.ok(victim !== undefined, 'the fixture needs a record set aside for a key conflict');
    const rowId = victim['row_locator_id'] ?? '';
    write(
      pkg,
      'isolated.csv',
      renderCsv(
        isolated.headers,
        isolated.rows
          .filter((row) => (row['row_locator_id'] ?? '') !== rowId)
          .map((row) => isolated.headers.map((header) => row[header] ?? '')),
      ),
    );
    const rejected = readTable(pkg.dir, 'rejected-input.csv');
    write(
      pkg,
      'rejected-input.csv',
      renderCsv(rejected.headers, [
        ...rejected.rows.map((row) => rejected.headers.map((header) => row[header] ?? '')),
        rejected.headers.map((header) =>
          header === 'reason_code'
            ? 'INGEST_ROW_BLANK'
            : header === 'detail'
              ? 'relabelled by hand'
              : victim[header] ?? '',
        ),
      ]),
    );
    const lineage = readTable(pkg.dir, 'source-lineage.csv');
    write(
      pkg,
      'source-lineage.csv',
      renderCsv(
        lineage.headers,
        lineage.rows.map((row) =>
          lineage.headers.map((header) => {
            if ((row['row_locator_id'] ?? '') !== rowId) return row[header] ?? '';
            if (header === 'disposition') return 'REJECTED_INPUT';
            if (header === 'reason_code') return 'INGEST_ROW_BLANK';
            return row[header] ?? '';
          }),
        ),
      ),
    );
    const reconciliation = readJson(pkg, 'reconciliation.json');
    const sourceRows = reconciliation['sourceRows'] as { byDisposition: Record<string, number> };
    sourceRows.byDisposition['ISOLATED'] = (sourceRows.byDisposition['ISOLATED'] ?? 0) - 1;
    sourceRows.byDisposition['REJECTED_INPUT'] = (sourceRows.byDisposition['REJECTED_INPUT'] ?? 0) + 1;
    const tally = reconciliation['reasonCodeTally'] as Record<string, number>;
    tally['DESTINATION_KEY_CONFLICT'] = (tally['DESTINATION_KEY_CONFLICT'] ?? 1) - 1;
    if (tally['DESTINATION_KEY_CONFLICT'] === 0) delete tally['DESTINATION_KEY_CONFLICT'];
    tally['INGEST_ROW_BLANK'] = (tally['INGEST_ROW_BLANK'] ?? 0) + 1;
    writeJson(pkg, 'reconciliation.json', reconciliation);
    repairAudit(pkg);
    repairManifest(pkg);
    expectCaught(pkg, 'destination.conflictsAreNotDelivered');
  });
});

describe('a withheld record must name a field that is actually required', () => {
  it('is caught when the named field is one nothing requires', () => {
    // The corroborator used to be "this mapping requires something", which is
    // true of every object of every real destination, so a delivered record
    // could be withheld by relabelling it. The package now names the field.
    const pkg = open('G28-unrecognised-boolean', 'tamper-withhold-required');
    const lineage = readTable(pkg.dir, 'source-lineage.csv');
    const victim = lineage.rows.find(
      (row) => (row['disposition'] ?? '') === 'OUTPUT' && (row['contribution_kind'] ?? '') === 'RECORD',
    );
    assert.ok(victim !== undefined, 'the fixture needs a delivered record');
    const rowId = victim['row_locator_id'] ?? '';
    const isolated = readTable(pkg.dir, 'isolated.csv');
    write(
      pkg,
      'isolated.csv',
      renderCsv(isolated.headers, [
        ...isolated.rows.map((row) => isolated.headers.map((header) => row[header] ?? '')),
        isolated.headers.map((header) => {
          if (header === 'reason_code') return 'DESTINATION_REQUIRED_FIELD_MISSING';
          if (header === 'field') return 'contact.jobTitle';
          if (header === 'detail') return 'relabelled by hand';
          if (header === 'object') return 'CONTACT';
          return victim[header] ?? '';
        }),
      ]),
    );
    write(
      pkg,
      'source-lineage.csv',
      renderCsv(
        lineage.headers,
        lineage.rows.map((row) =>
          lineage.headers.map((header) => {
            if ((row['row_locator_id'] ?? '') !== rowId) return row[header] ?? '';
            if (header === 'disposition') return 'ISOLATED';
            if (header === 'reason_code') return 'DESTINATION_REQUIRED_FIELD_MISSING';
            return row[header] ?? '';
          }),
        ),
      ),
    );
    const importPath = `01_IMPORT/${pkg.adapter.importDirectory}/contacts.csv`;
    withholdDeliveredRecord(pkg, importPath, victim['migration_key'] ?? '');
    const reconciliation = readJson(pkg, 'reconciliation.json');
    const sourceRows = reconciliation['sourceRows'] as { byDisposition: Record<string, number> };
    sourceRows.byDisposition['OUTPUT'] = (sourceRows.byDisposition['OUTPUT'] ?? 0) - 1;
    sourceRows.byDisposition['ISOLATED'] = (sourceRows.byDisposition['ISOLATED'] ?? 0) + 1;
    const records = reconciliation['records'] as { deliveredTotal: number; byObject: Record<string, number> };
    records.deliveredTotal -= 1;
    records.byObject['CONTACT'] = (records.byObject['CONTACT'] ?? 0) - 1;
    const tally = reconciliation['reasonCodeTally'] as Record<string, number>;
    tally['INGEST_ROW_ACCEPTED'] = (tally['INGEST_ROW_ACCEPTED'] ?? 1) - 1;
    if (tally['INGEST_ROW_ACCEPTED'] === 0) delete tally['INGEST_ROW_ACCEPTED'];
    tally['DESTINATION_REQUIRED_FIELD_MISSING'] = (tally['DESTINATION_REQUIRED_FIELD_MISSING'] ?? 0) + 1;
    writeJson(pkg, 'reconciliation.json', reconciliation);
    repairAudit(pkg);
    repairManifest(pkg);
    expectCaught(pkg, 'isolated.corroborated');
  });
});

/**
 * ---- the byte-level checks, now that neither of them holds a file ----
 *
 * `manifest.artifactHashes` read each artifact whole with `readFileSync` to take
 * its hash and its length. `artifacts.canonicalBytes` read each CSV whole and
 * decoded it into a second whole-file string, then compared line by line against
 * that string. Both now read in fixed blocks: the manifest check folds each block
 * into a running SHA-256 and a running length, and the canonical check feeds the
 * file's own bytes to one digest while feeding the canonical rendering of each
 * record the incremental parser produces to a second, comparing the two digests
 * and the two lengths at the end.
 *
 * Equal digest and equal length is byte equality. The cases below are what makes
 * that claim testable rather than argued: every way a file can differ from what
 * this engine writes, applied to a real artifact where that is safe and to an
 * artifact whose every byte the test chose where exactness is the point.
 *
 * Two of them are acceptances. A comparison that refuses everything is not a
 * comparison, and the multi-line case is a refusal this repository has actually
 * shipped.
 */

/**
 * The read sizes a boundary case has to hold for.
 *
 * This file used to carry `const READ_BLOCK_BYTES = 1 << 16`, its own copy of
 * the verifier's block size, and walked offsets at multiples of it. An
 * adversarial pass named what that costs and it is exactly right: change the
 * size in `verify-package.ts` and this keeps asserting about offsets that are
 * no longer read boundaries, so the acceptance below -- the only case here that
 * can tell a correct block reader from a broken one -- silently stops
 * discriminating and goes on passing. The risk note claimed the opposite, that
 * the test "fails loudly if the read block size ever changes". Two independent
 * constants cannot check each other.
 *
 * So the verifier's block size is imported now, and there is no copy. That
 * settles the verifier's own reads. It does not settle the other reader in the
 * picture: `artifacts.canonicalBytes` also drives the incremental CSV reader,
 * which declares its own block size in `src/ingest/read-csv-file.ts`, and this
 * suite cannot see that one -- it is not exported, and exporting it would tie
 * how ingest reads a file to how the verifier hashes one.
 *
 * A case that has to hold for two block sizes and can only name one is a case
 * that should stop naming sizes. The probe artifact below is built so that a
 * character is split across a boundary at *every* power of two from a
 * sixteenth of the verifier's block up to twice it -- which is every read size
 * either reader could plausibly use -- and the search that builds it fails if
 * it cannot find one. Whichever of the two block sizes a case is exercising,
 * and whatever either becomes, the character still straddles.
 */
const CANDIDATE_BLOCK_SIZES: readonly number[] = (() => {
  const sizes: number[] = [];
  for (let size = READ_BLOCK_BYTES / 16; size <= READ_BLOCK_BYTES * 2; size *= 2) sizes.push(size);
  return sizes;
})();

/** An artifact this configuration does not produce, whose bytes a case chooses. */
const PROBE_PATH = '03_TRACEABILITY/block-boundary-probe.csv';

/**
 * Lists a file in the manifest that the package did not produce.
 *
 * `repairManifest` re-measures what the manifest already names and drops what is
 * gone; it cannot add. A case that needs to choose an artifact's every byte has
 * to say so here.
 */
function listExtraArtifact(pkg: Package, path: string, rowCount: number | null): void {
  const manifest = readJson(pkg, 'manifest.json');
  const artifacts = manifest['artifacts'] as {
    path: string;
    sha256: string;
    byteLength: number;
    rowCount: number | null;
  }[];
  const bytes = readFileSync(join(pkg.dir, ...path.split('/')));
  const existing = artifacts.find((artifact) => artifact.path === path);
  if (existing === undefined) {
    artifacts.push({ path, sha256: sha256Hex(bytes), byteLength: bytes.length, rowCount });
  } else {
    existing.sha256 = sha256Hex(bytes);
    existing.byteLength = bytes.length;
    existing.rowCount = rowCount;
  }
  artifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  writeJson(pkg, 'manifest.json', manifest);
}

/**
 * A canonical CSV several reads long, dense with characters wider than a byte.
 *
 * Every golden fixture fits inside one read, so nothing in this suite has ever
 * exercised what happens at a block boundary — which is precisely where a
 * block-wise reader goes wrong, and goes wrong silently: a digest that folded
 * blocks in the wrong order, or a decoder that finished at every boundary and
 * turned one character split across two reads into two replacement characters.
 * The second is a corruption whose position depends on the block size, which is
 * the one kind of non-determinism nothing downstream could detect.
 */
function probeCsv(rows: number): string {
  const wide =
    'ñáéíóúàèìòùâêîôû' +
    'äëïöü';
  // Two bytes, three bytes, and four bytes — the last a surrogate pair in the
  // reader's own UTF-16 as well as a multi-byte sequence on disk.
  const line = `-${wide}-中文-\u{1f600}`;
  const lines = ['note'];
  for (let index = 0; index < rows; index += 1) lines.push(`r${String(index)}${line}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Which read boundaries fall inside a character, for one block size.
 *
 * Derived from the bytes rather than assumed: a byte in the range 0x80–0xBF is a
 * UTF-8 continuation byte, so finding one exactly at a boundary proves the
 * character began in the block before it. A case that meant to straddle a
 * boundary and did not would otherwise pass while testing nothing.
 */
function straddledBoundaries(bytes: Buffer, blockBytes: number): number[] {
  const found: number[] = [];
  for (let at = blockBytes; at < bytes.length; at += blockBytes) {
    const byte = bytes[at] ?? 0;
    if (byte >= 0x80 && byte < 0xc0) found.push(at);
  }
  return found;
}

/**
 * The probe artifact, and the row count the manifest has to state for it.
 *
 * Searched rather than chosen: the row count is raised until the bytes split a
 * character at every candidate block size, so the case cannot quietly become
 * one that reads a whole artifact inside one block. The search is deterministic
 * and runs once. It throws rather than returning a probe that straddles
 * nothing, because a boundary case that does not straddle is a case that passes
 * for the wrong reason.
 */
let probeArtifact: { bytes: Buffer; rows: number } | null = null;
function probe(): { bytes: Buffer; rows: number } {
  if (probeArtifact !== null) return probeArtifact;
  const widest = Math.max(...CANDIDATE_BLOCK_SIZES);
  for (let rows = 2_500; rows < 40_000; rows += 1) {
    const bytes = Buffer.from(probeCsv(rows), 'utf8');
    // Two boundaries of the widest size, so no candidate is satisfied by an
    // artifact that simply ends before its first read boundary.
    if (bytes.length <= widest * 2) continue;
    if (CANDIDATE_BLOCK_SIZES.every((size) => straddledBoundaries(bytes, size).length > 0)) {
      probeArtifact = { bytes, rows };
      return probeArtifact;
    }
  }
  throw new Error('no probe artifact splits a character at every candidate read boundary');
}

describe('an artifact is the bytes the manifest names, hashed a block at a time', () => {
  it('is caught when a byte changes and the length does not, so only the digest can see it', () => {
    // The documentation file, because nothing else in the package reads it: the
    // case is about the hash and should fail for no other reason.
    const pkg = open('G01-clean-contacts', 'tamper-hash-one-byte');
    const bytes = readBytes(pkg, 'import-instructions.md');
    assert.ok(bytes.length > 16, 'the fixture needs an import-instructions.md to damage');
    const flipped = Buffer.from(bytes);
    const at = flipped.length - 2;
    // Lowest bit of an ASCII byte: the file stays the same length and stays
    // decodable, so the length comparison and every later check see nothing.
    flipped[at] = (flipped[at] ?? 0) ^ 0x01;
    writeBytes(pkg, 'import-instructions.md', flipped);
    expectCaughtSaying(pkg, 'manifest.artifactHashes', 'hashes to');
  });

  it('is caught when the length changes and the hash is repaired, so only the length can see it', () => {
    // A forger who recomputes the digest and forgets the byte count. Checking
    // the length is not redundant with checking the digest: it is the cheap,
    // independent witness, and a check that dropped it would be trusting one
    // number where the manifest states two.
    const pkg = open('G01-clean-contacts', 'tamper-hash-length');
    const bytes = readBytes(pkg, 'import-instructions.md');
    writeBytes(pkg, 'import-instructions.md', Buffer.concat([bytes, Buffer.from('\n', 'utf8')]));

    const manifest = readJson(pkg, 'manifest.json');
    const artifacts = manifest['artifacts'] as { path: string; sha256: string; byteLength: number }[];
    const entry = artifacts.find((artifact) => artifact.path === packagePath('import-instructions.md'));
    assert.ok(entry !== undefined, 'the manifest must list import-instructions.md');
    entry.sha256 = sha256Hex(readBytes(pkg, 'import-instructions.md'));
    // byteLength deliberately left describing the file as it was.
    writeJson(pkg, 'manifest.json', manifest);

    expectCaughtSaying(pkg, 'manifest.artifactHashes', 'bytes, but the manifest says');
  });

  it('is caught when an artifact the manifest lists is not in the package at all', () => {
    // The block reader opens the file rather than reading it whole, so the case
    // that used to be "readFileSync threw" is now "openSync threw". It has to
    // still be reported as a missing artifact and not as a hash mismatch.
    const pkg = open('G01-clean-contacts', 'tamper-hash-missing');
    rmSync(join(pkg.dir, ...packagePath('import-instructions.md').split('/')));
    expectCaughtSaying(pkg, 'manifest.artifactHashes', 'missing from the package');
  });

  it('folds every block of an artifact longer than one read, and no more than every block', () => {
    // The discriminating direction. A hasher that stopped after the first block,
    // or hashed the blocks in the wrong order, or let the decoder resolve a
    // character at a boundary, would refuse this untampered artifact — and no
    // "is it caught" case can tell that apart from working correctly, because
    // both of them fire.
    const pkg = open('G01-clean-contacts', 'tamper-blocks-accepted');
    const { bytes, rows } = probe();
    assert.ok(bytes.length > READ_BLOCK_BYTES * 2, 'the probe artifact must span more than two reads');
    for (const size of CANDIDATE_BLOCK_SIZES) {
      assert.ok(
        straddledBoundaries(bytes, size).length > 0,
        `the probe artifact must split a character across a ${String(size)}-byte read boundary, or it tests nothing at that size`,
      );
    }
    writeBytes(pkg, PROBE_PATH, bytes);
    listExtraArtifact(pkg, PROBE_PATH, rows);

    expectNotCaught(pkg, 'manifest.artifactHashes');
    expectNotCaught(pkg, 'artifacts.canonicalBytes');
  });

  it('is caught when a byte changes in a block after the first', () => {
    const pkg = open('G01-clean-contacts', 'tamper-blocks-late-byte');
    const { bytes, rows } = probe();
    writeBytes(pkg, PROBE_PATH, bytes);
    listExtraArtifact(pkg, PROBE_PATH, rows);

    // Two reads in, on an ASCII digit, so the file stays valid UTF-8 and the
    // same length: nothing but a digest over every block can see this.
    const damaged = Buffer.from(bytes);
    let at = READ_BLOCK_BYTES * 2;
    while (at < damaged.length && ((damaged[at] ?? 0) < 0x30 || (damaged[at] ?? 0) > 0x39)) at += 1;
    assert.ok(at < damaged.length, 'the probe artifact must carry a digit past the second read');
    damaged[at] = (damaged[at] ?? 0) === 0x39 ? 0x38 : (damaged[at] ?? 0) + 1;
    writeBytes(pkg, PROBE_PATH, damaged);

    expectCaughtSaying(pkg, 'manifest.artifactHashes', 'hashes to');
  });
});

describe('an artifact is written the way this engine writes a CSV, compared without holding it', () => {
  it('is caught when an artifact carries a byte that is not valid UTF-8', () => {
    // The case the old comparison could not see. An invalid byte decodes to
    // U+FFFD, and a check that compared the decoded text against a re-render of
    // the same decoded text matched that replacement character against itself
    // and called the file canonical. Comparing the file's own bytes against the
    // bytes of the rendering parts them: 0xFF on disk, EF BF BD in the
    // rendering, which is a different digest and a different length.
    const pkg = open('G01-clean-contacts', 'tamper-invalid-utf8');
    const path = '01_IMPORT/clean-only/contacts.csv';
    const bytes = readBytes(pkg, path);
    // The second byte of the header, which is a letter: not a delimiter, not a
    // quote, not a terminator, so the file's structure is untouched and the
    // reader still finds exactly the records it found before.
    assert.ok(bytes.length > 8, 'the fixture needs an import file to damage');
    const second = bytes[1] ?? 0;
    assert.ok(second !== 0x2c && second !== 0x22 && second !== 0x0a, 'the byte damaged must not be structural');
    const damaged = Buffer.from(bytes);
    damaged[1] = 0xff;
    writeBytes(pkg, path, damaged);
    repairManifest(pkg);

    expectCaught(pkg, 'artifacts.canonicalBytes');
  });

  it('is caught when the final newline is removed and the manifest is repaired', () => {
    // The smallest truncation there is, and the one the old check caught with
    // "the offset reached the end of the file". A record with no terminator is
    // still a record to the reader, and the rendering ends it — so the rendering
    // is exactly one byte longer than the file, which the length comparison sees
    // before any cryptography is relied on.
    const pkg = open('G01-clean-contacts', 'tamper-truncated');
    const bytes = readBytes(pkg, 'instance-verification.csv');
    assert.equal(bytes[bytes.length - 1], 0x0a, 'a canonical CSV ends with a newline');
    writeBytes(pkg, 'instance-verification.csv', bytes.subarray(0, bytes.length - 1));
    repairManifest(pkg);

    expectCaught(pkg, 'artifacts.canonicalBytes');
  });

  it('is caught when an artifact is emptied and the manifest is repaired', () => {
    // An empty file renders as nothing at all, so its digest and its length match
    // the file exactly. It is the one case a rendering comparison cannot decide
    // arithmetically, and the reason the check refuses an artifact the reader
    // finds no records in: every artifact this format defines has a header line.
    const pkg = open('G01-clean-contacts', 'tamper-emptied');
    writeBytes(pkg, 'instance-verification.csv', Buffer.alloc(0));
    repairManifest(pkg);

    expectCaught(pkg, 'artifacts.canonicalBytes');
  });

  it('is caught when lines end with a bare carriage return, which is the same length as a newline', () => {
    // The case that separates the digest from the length. A file whose
    // terminators are CR is byte-for-byte as long as the file this engine would
    // have written, so the arithmetic agrees and only the digests part.
    const pkg = open('G01-clean-contacts', 'tamper-bare-cr');
    const canonical = Buffer.from(renderCsv(['note'], [['value']]), 'utf8');
    const carriageReturns = Buffer.from(canonical.toString('utf8').split('\n').join('\r'), 'utf8');
    assert.equal(carriageReturns.length, canonical.length, 'the case is only about the digest if the lengths agree');
    writeBytes(pkg, PROBE_PATH, carriageReturns);
    listExtraArtifact(pkg, PROBE_PATH, 1);

    expectCaught(pkg, 'artifacts.canonicalBytes');
  });

  it('is caught when a single field is quoted that this engine would not quote', () => {
    // The whole-file re-quote is already a case. This is the smallest version of
    // it: one field, on one line, in a file that is otherwise exactly right.
    const pkg = open('G01-clean-contacts', 'tamper-one-quoted-field');
    writeBytes(pkg, PROBE_PATH, Buffer.from('note\n"value"\n', 'utf8'));
    listExtraArtifact(pkg, PROBE_PATH, 1);

    expectCaught(pkg, 'artifacts.canonicalBytes');
  });

  it('accepts a delivered value that legitimately holds a line break, including a CRLF one', () => {
    // The refusal this repository shipped. A scan for CRLF anywhere in a file
    // matched a properly quoted multi-line address typed on Windows and aborted
    // the run, and the whole reason the check compares a rendering rather than
    // scanning for a byte sequence is that a value may contain one.
    //
    // The rendering re-quotes the field exactly as the writer did, so the two
    // digests and the two lengths agree and the check has nothing to say.
    const pkg = open('G01-clean-contacts', 'tamper-multiline-accepted');
    const text = renderCsv(['note'], [['line one\r\nline two']]);
    assert.ok(text.includes('\r\n'), 'the case needs a CRLF inside the quoted field');
    writeBytes(pkg, PROBE_PATH, Buffer.from(text, 'utf8'));
    listExtraArtifact(pkg, PROBE_PATH, 1);

    expectNotCaught(pkg, 'artifacts.canonicalBytes');
  });

  it('accepts an artifact whose characters are split across reads', () => {
    // The decoder is fed a block at a time and must keep a partial character for
    // the next block. One that finished at every boundary would render two
    // replacement characters where the file holds one character, and the check
    // would refuse a correct artifact for a reason that depends on how large a
    // read is.
    const pkg = open('G01-clean-contacts', 'tamper-boundary-accepted');
    const { bytes, rows } = probe();
    for (const size of CANDIDATE_BLOCK_SIZES) {
      assert.ok(
        straddledBoundaries(bytes, size).length > 0,
        `the probe artifact must split a character across a ${String(size)}-byte read boundary`,
      );
    }
    writeBytes(pkg, PROBE_PATH, bytes);
    listExtraArtifact(pkg, PROBE_PATH, rows);

    expectNotCaught(pkg, 'artifacts.canonicalBytes');
  });
});

describe('an untampered package still verifies', () => {
  it('passes on every check after the manifest is rewritten identically', () => {
    const pkg = open('G19-multi-file-bundle', 'tamper-control');
    repairManifest(pkg);
    const report = verifyPackage(pkg.dir, { scratch: verifyScratch(pkg.dir) });
    assert.deepEqual(
      report.problems,
      [],
      report.problems.map((problem) => `${problem.check}: ${problem.detail}`).join(' | '),
    );
    assert.ok(report.checks.length >= 30, `only ${String(report.checks.length)} checks ran`);
  });
});
