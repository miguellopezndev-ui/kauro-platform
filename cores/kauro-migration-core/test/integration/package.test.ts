import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { GOLDEN_ROOT, readJsonArtifact, readTable, readTextArtifact, repoRoot, runFixture, verifyScratch } from '../support/harness.js';
import { verifyPackage } from '../../src/verify/verify-package.js';
import { startsLikeFormula } from '../../src/run/validate-destination.js';
import { sha256Hex } from '../../src/util/hash.js';
import { runInline, textField } from '../support/inline.js';
import { renderAudit } from '../../src/artifacts/audit.js';
import { packagePath } from '../../src/artifacts/layout.js';
import { getAdapter } from '../../src/adapters/specs.js';
import type { Reconciliation } from '../../src/reconcile/reconcile.js';

const MULTI = 'G19-multi-file-bundle';

describe('the package is internally consistent', () => {
  const run = runFixture(GOLDEN_ROOT, MULTI, { scratchName: 'pkg-consistency' });

  it('lists every artifact in the manifest with a matching hash', () => {
    const manifest = readJsonArtifact(run.packageDir, 'manifest.json');
    const artifacts = manifest['artifacts'] as { path: string; sha256: string; byteLength: number }[];
    assert.ok(artifacts.length >= 18, 'the package should contain the full artifact set');
    for (const artifact of artifacts) {
      const bytes = readFileSync(join(run.packageDir, ...artifact.path.split('/')));
      assert.equal(bytes.length, artifact.byteLength, `${artifact.path} byte length`);
    }
  });

  it('records the core version, input hashes and registry version', () => {
    const manifest = readJsonArtifact(run.packageDir, 'manifest.json');
    assert.equal(manifest['coreVersion'], run.result.truth.coreVersion);
    assert.equal(manifest['configHash'], run.result.truth.configHash);
    assert.ok(typeof manifest['sourceRegistryVersion'] === 'string');
    const inputs = manifest['inputs'] as { sha256: string }[];
    assert.equal(inputs.length, run.result.truth.sourceFiles.length);
    for (const input of inputs) assert.match(input.sha256, /^[0-9a-f]{64}$/u);
  });

  it('contains no timestamp anywhere in a machine artifact', () => {
    const manifest = readTextArtifact(run.packageDir, 'manifest.json');
    const reconciliation = readTextArtifact(run.packageDir, 'reconciliation.json');
    for (const text of [manifest, reconciliation]) {
      assert.ok(
        !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u.test(text),
        'artifacts must not carry a wall-clock timestamp',
      );
    }
  });

  it('covers every source row in the lineage exactly once', () => {
    const lineage = readTable(run.packageDir, 'source-lineage.csv');
    const ids = lineage.rows.map((row) => row['row_locator_id'] ?? '');
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, run.result.reconciliation.sourceRows.total);
    for (const row of lineage.rows) {
      assert.ok((row['reason_code'] ?? '').length > 0, 'every row carries a reason code');
      assert.ok((row['row_hash'] ?? '').length === 64, 'every row carries its hash');
    }
  });

  it('renders the audit summary from the reconciliation alone', () => {
    const reconciliation = readJsonArtifact(run.packageDir, 'reconciliation.json') as unknown as Reconciliation;
    const adapter = getAdapter('CLEAN_ONLY');
    const rebuilt = renderAudit(reconciliation, {
      instanceVerification: readTable(run.packageDir, 'instance-verification.csv').rows.map((row) => ({
        scope: row['scope'] ?? '',
        detail: row['detail'] ?? '',
        sourceUrl: row['source_url'] ?? '',
      })),
      vendorSources: adapter.sources,
      adapterNotes: adapter.objects.flatMap((spec) => spec.notes),
    });
    assert.equal(readTextArtifact(run.packageDir, 'audit.md'), rebuilt);
  });

  it('says nothing disappeared, and can prove it', () => {
    const audit = readTextArtifact(run.packageDir, 'audit.md');
    assert.match(
      audit,
      /All 8 source rows read from the input files have exactly one disposition\. 0 rows disappeared\./u,
    );
  });
});

describe('the verifier is independent of the generator', () => {
  it('passes when run in a separate process after the generator has exited', () => {
    const run = runFixture(GOLDEN_ROOT, MULTI, { scratchName: 'pkg-independent' });
    const cli = join(repoRoot(), 'dist', 'src', 'cli', 'main.js');
    const result = spawnSync(process.execPath, [cli, 'verify', '--package', run.packageDir], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /package verified/u);
  });

  it('fails when a delivered value is altered after hashing', () => {
    const run = runFixture(GOLDEN_ROOT, MULTI, { scratchName: 'pkg-tampered' });
    const target = join(run.packageDir, '01_IMPORT', 'clean-only', 'contacts.csv');
    writeFileSync(target, `${readFileSync(target, 'utf8')}mk_contact_tampered,,,\n`);
    const report = verifyPackage(run.packageDir, { scratch: verifyScratch(run.packageDir) });
    assert.equal(report.passed, false);
    assert.ok(report.problems.some((problem) => problem.check === 'manifest.artifactHashes'));
  });

  it('fails when a byte is changed without changing the file length', () => {
    // Length-preserving tampering is the case a byte-count check alone would
    // miss, so this is what actually proves the hashes are being compared.
    const run = runFixture(GOLDEN_ROOT, MULTI, { scratchName: 'pkg-same-length' });
    const target = join(run.packageDir, '01_IMPORT', 'clean-only', 'contacts.csv');
    const text = readFileSync(target, 'utf8');
    const tampered = text.replace('Ada', 'Eve');
    assert.notEqual(tampered, text, 'the fixture must contain the value this test rewrites');
    assert.equal(tampered.length, text.length, 'the tamper must not change the file length');
    writeFileSync(target, tampered);

    const report = verifyPackage(run.packageDir, { scratch: verifyScratch(run.packageDir) });
    assert.equal(report.passed, false);
    assert.ok(
      report.problems.some(
        (problem) => problem.check === 'manifest.artifactHashes' && problem.detail.includes('hashes to'),
      ),
      'the verifier must compare the hash, not only the byte count',
    );
  });

  it('fails when a row is removed from the lineage', () => {
    const run = runFixture(GOLDEN_ROOT, MULTI, { scratchName: 'pkg-lineage-cut' });
    const target = join(run.packageDir, ...packagePath('source-lineage.csv').split('/'));
    const lines = readFileSync(target, 'utf8').split('\n');
    writeFileSync(target, [lines[0], ...lines.slice(2)].join('\n'));
    const report = verifyPackage(run.packageDir, { scratch: verifyScratch(run.packageDir) });
    assert.equal(report.passed, false);
  });

  it('fails when the audit summary is edited by hand', () => {
    const run = runFixture(GOLDEN_ROOT, MULTI, { scratchName: 'pkg-audit-edit' });
    const target = join(run.packageDir, ...packagePath('audit.md').split('/'));
    writeFileSync(target, readFileSync(target, 'utf8').replace('8 source rows', '7 source rows'));
    const report = verifyPackage(run.packageDir, { scratch: verifyScratch(run.packageDir) });
    assert.equal(report.passed, false);
    assert.ok(
      report.problems.some(
        (problem) =>
          problem.check === 'manifest.artifactHashes' || problem.check === 'audit.derivedFromReconciliation',
      ),
    );
  });

  it('runs at least twenty distinct checks', () => {
    const run = runFixture(GOLDEN_ROOT, MULTI, { scratchName: 'pkg-check-count' });
    assert.ok(run.verification.checks.length >= 20, `only ${String(run.verification.checks.length)} checks ran`);
    assert.equal(new Set(run.verification.checks).size, run.verification.checks.length);
  });
});

describe('the command line', () => {
  const cli = join(repoRoot(), 'dist', 'src', 'cli', 'main.js');

  it('inspects a bundle without changing anything', () => {
    const outDir = join(repoRoot(), 'tmp', 'test', 'cli-inspect');
    const result = spawnSync(
      process.execPath,
      [cli, 'inspect', '--input', join(GOLDEN_ROOT, MULTI, 'input'), '--out', outDir],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const report = JSON.parse(readFileSync(join(outDir, 'inspection.json'), 'utf8')) as {
      files: { sheets: { columns: unknown[] }[] }[];
    };
    assert.equal(report.files.length, 4);
    const markdown = readFileSync(join(outDir, 'inspection.md'), 'utf8');
    assert.match(markdown, /draws no conclusion about identity/u);
  });

  it('exits non-zero and explains itself when the configuration is wrong', () => {
    const result = spawnSync(process.execPath, [cli, 'run', '--input', '.', '--config', 'nope.json', '--out', 'x'], {
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
  });

  it('refuses to write into a directory it did not create', () => {
    const outDir = join(repoRoot(), 'tmp', 'test', 'cli-occupied');
    spawnSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(outDir)},{recursive:true});require('fs').writeFileSync(${JSON.stringify(join(outDir, 'someones-file.txt'))},'x')`]);
    const result = spawnSync(
      process.execPath,
      [
        cli,
        'run',
        '--input',
        join(GOLDEN_ROOT, MULTI, 'input'),
        '--config',
        join(GOLDEN_ROOT, MULTI, 'config.json'),
        '--out',
        outDir,
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PACKAGE_INVALID/u);
  });
});

describe('the human data view (R2-010)', () => {
  const IMPORT_FILE = '01_IMPORT/clean-only/contacts.csv';
  const VIEW_FILE = '04_DOCUMENTATION/data-view/clean-only/contacts.csv';

  it("[R2-010] the import file keeps '=1+1' byte-exact while the human data view and formula-risk.csv neutralise it", () => {
    const ran = runInline('r2-010-human-view', {
      headers: ['Contact ID', 'First Name', 'Last Name'],
      rows: [
        ['1', '=1+1', 'Lovelace'],
        ['2', 'Alan', 'Turing'],
      ],
      fields: [textField('First Name', 'contact.firstName'), textField('Last Name', 'contact.lastName')],
    });
    assert.deepEqual(ran.verification.problems, []);

    // The import file is the machine truth (D7): the value is exactly what the source wrote.
    const importFile = readFileSync(join(ran.packageDir, ...IMPORT_FILE.split('/')), 'utf8');
    const imported = readTable(ran.packageDir, IMPORT_FILE);
    const firstName = imported.headers.find((header) => header.toLowerCase().includes('first'));
    assert.ok(firstName !== undefined);
    // Import files are ordered by migration key, not by source row.
    assert.deepEqual(imported.rows.map((row) => row[firstName]).sort(), ['=1+1', 'Alan']);
    assert.ok(!importFile.includes("'=1+1"), 'the import file carries no apostrophe');

    // The human data view: same headers, same rows, the risky value neutralised by one leading U+0027.
    const view = readTable(ran.packageDir, VIEW_FILE);
    assert.deepEqual(view.headers, imported.headers);
    assert.equal(view.rows.length, imported.rows.length);
    assert.deepEqual(view.rows.map((row) => row[firstName]).sort(), ["'=1+1", 'Alan']);
    // Row for row, the view is the import file with the risky cell neutralised.
    view.rows.forEach((row, index) => {
      const original = imported.rows[index]?.[firstName] ?? '';
      assert.equal(row[firstName], original === '=1+1' ? "'=1+1" : original);
    });
    for (const row of view.rows) {
      for (const value of Object.values(row)) {
        assert.ok(!startsLikeFormula(value), `${JSON.stringify(value)} would be executed by a spreadsheet`);
      }
    }

    // formula-risk.csv: a neutralised value and the digest of the exact one.
    const risk = readTable(ran.packageDir, 'formula-risk.csv');
    assert.ok(risk.headers.includes('value') && risk.headers.includes('value_sha256'));
    assert.equal(risk.rows.length, 1);
    assert.equal(risk.rows[0]?.['value'], "'=1+1");
    assert.equal(risk.rows[0]?.['value_sha256'], sha256Hex('=1+1'));
    for (const row of risk.rows) for (const value of Object.values(row)) assert.ok(!startsLikeFormula(value));

    // The manifest declares what each CSV is.
    const manifest = readJsonArtifact(ran.packageDir, 'manifest.json');
    assert.equal(manifest['manifestVersion'], '2.1.0');
    const kinds = new Map((manifest['artifacts'] as { path: string; kind: string }[]).map((item) => [item.path, item.kind]));
    assert.equal(kinds.get(IMPORT_FILE), 'MACHINE_IMPORT_CSV');
    assert.equal(kinds.get(VIEW_FILE), 'HUMAN_VIEW_CSV');
    assert.equal(kinds.get('02_EXCEPTIONS/formula-risk.csv'), 'HUMAN_VIEW_CSV');
    for (const [path, kind] of kinds) {
      assert.ok(typeof kind === 'string' && kind.length > 0, `${path} declares a kind`);
      if (path.endsWith('.csv')) assert.match(kind, /^(MACHINE_IMPORT_CSV|MACHINE_EVIDENCE_CSV|MACHINE_EXCEPTION_CSV|HUMAN_VIEW_CSV)$/u, path);
    }
    for (const name of ['isolated.csv', 'leftovers.csv', 'rejected-input.csv', 'unmapped-fields.csv', 'unresolved-associations.csv', 'destination-conflicts.csv', 'duplicate-candidates.csv']) {
      assert.equal(kinds.get(`02_EXCEPTIONS/${name}`), 'MACHINE_EXCEPTION_CSV', name);
    }
  });

  it('writes no data view for an import file without a risky cell', () => {
    const ran = runInline('r2-010-no-risk', {
      headers: ['Contact ID', 'First Name'],
      rows: [['1', 'Ada']],
      fields: [textField('First Name', 'contact.firstName')],
    });
    assert.deepEqual(ran.verification.problems, []);
    const manifest = readJsonArtifact(ran.packageDir, 'manifest.json');
    const paths = (manifest['artifacts'] as { path: string }[]).map((item) => item.path);
    assert.ok(!paths.some((path) => path.startsWith('04_DOCUMENTATION/data-view/')));
  });
});
