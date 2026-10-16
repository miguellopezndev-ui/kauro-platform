/**
 * Benchmarks.
 *
 * Generates synthetic contact sheets at three sizes and records elapsed time,
 * peak resident set size and the size of the resulting package.
 *
 * Each size runs in its own process so the memory figure belongs to that size
 * alone rather than to everything measured before it. These numbers describe
 * one machine running one synthetic fixture; they are not a capacity claim, and
 * nothing in the engine changes behaviour based on them.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/mapping/load-config.js';
import { createFilesystemScratchStore } from '../src/scratch/filesystem-scratch-store.js';
import { SCRATCH_BUDGET_BYTES } from '../src/domain/resource-profile.js';
import { runMigration } from '../src/run/run-migration.js';
import { listPackageFiles, writeAndPromotePackage } from '../src/artifacts/write-package.js';
import { verifyPackage } from '../src/verify/verify-package.js';
import { renderCsv } from '../src/artifacts/csv-writer.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)), '..');
const outRoot = join(repoRoot, 'bench', 'out');

const SIZES = [1_000, 10_000, 100_000];

const CONFIG = {
  configVersion: '3.0.0',
  source: { system: 'benchmark', namespace: 'bench' },
  target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' },
  files: [{ id: 'contacts', path: 'contacts.csv', format: 'CSV' }],
  records: [
    {
      id: 'contacts',
      fileId: 'contacts',
      object: 'CONTACT',
      sourceRecordIdColumn: { header: 'Contact ID' },
      fields: [
        { column: { header: 'First Name' }, destinationField: 'contact.firstName', semanticType: 'TEXT' },
        { column: { header: 'Last Name' }, destinationField: 'contact.lastName', semanticType: 'TEXT' },
        { column: { header: 'Email' }, destinationField: 'contact.email', semanticType: 'EMAIL' },
        {
          column: { header: 'Phone' },
          destinationField: 'contact.phone',
          semanticType: 'PHONE',
          options: { phoneCountry: 'US' },
        },
        { column: { header: 'Signed Up' }, destinationField: 'contact.createdAt', semanticType: 'DATE' },
      ],
    },
  ],
};

const CONFIG_TEXT = `${JSON.stringify(CONFIG, null, 2)}\n`;

/** Deterministic pseudo-values, so a benchmark run is reproducible. */
function makeSheet(rows: number): string {
  const data: string[][] = [];
  for (let index = 0; index < rows; index += 1) {
    const area = 200 + (index % 700);
    const line = 2000 + (index % 8000);
    data.push([
      `B-${String(index)}`,
      `First${String(index % 997)}`,
      `Last${String(index % 991)}`,
      `person${String(index)}@example.com`,
      `(${String(area)}) 555-${String(line).padStart(4, '0')}`,
      `2026-0${String((index % 9) + 1)}-1${String(index % 10)}`,
    ]);
  }
  return renderCsv(['Contact ID', 'First Name', 'Last Name', 'Email', 'Phone', 'Signed Up'], data);
}

function directorySize(directory: string): number {
  return listPackageFiles(directory).reduce(
    (sum, path) => sum + statSync(join(directory, ...path.split('/'))).size,
    0,
  );
}

function measure(rows: number): void {
  const caseDir = join(outRoot, String(rows));
  const inputDir = join(caseDir, 'input');
  rmSync(caseDir, { recursive: true, force: true });
  mkdirSync(inputDir, { recursive: true });
  writeFileSync(join(inputDir, 'contacts.csv'), Buffer.from(makeSheet(rows), 'utf8'));
  const configPath = join(caseDir, 'config.json');
  writeFileSync(configPath, Buffer.from(CONFIG_TEXT, 'utf8'));

  const loaded = loadConfig(CONFIG_TEXT, configPath);

  const startRun = process.hrtime.bigint();
  const scratch = createFilesystemScratchStore({
    root: join(caseDir, 'work'),
    runId: 'bench',
    quotaBytes: SCRATCH_BUDGET_BYTES,
  });
  const result = runMigration({
    inputRoot: inputDir,
    config: loaded.config,
    configHash: loaded.configHash,
    scratch,
  });
  const afterRun = process.hrtime.bigint();

  const packageDir = join(caseDir, 'package');
  writeAndPromotePackage({
    result,
    config: loaded.config,
    normalizedConfig: loaded.normalizedJson,
    outputDir: packageDir,
    force: true,
  });
  const afterWrite = process.hrtime.bigint();

  const report = verifyPackage(packageDir, { scratch });
  const afterVerify = process.hrtime.bigint();

  const ms = (from: bigint, to: bigint): string => (Number(to - from) / 1_000_000).toFixed(0);
  const peak = (process.memoryUsage().rss / (1024 * 1024)).toFixed(0);
  const size = (directorySize(packageDir) / 1024).toFixed(0);

  process.stdout.write(
    `${String(rows).padEnd(10)}${ms(startRun, afterRun).padStart(14)}${ms(afterRun, afterWrite).padStart(13)}` +
      `${ms(afterWrite, afterVerify).padStart(12)}${peak.padStart(9)}${size.padStart(13)}` +
      `${String(result.reconciliation.records.deliveredTotal).padStart(11)}${report.passed ? '' : '  NOT VERIFIED'}\n`,
  );

  if (!report.passed) {
    process.exitCode = 1;
    for (const problem of report.problems) process.stderr.write(`  ${problem.check}: ${problem.detail}\n`);
  }
}

function main(): void {
  const requested = process.argv.indexOf('--size');
  if (requested !== -1) {
    measure(Number(process.argv[requested + 1]));
    return;
  }

  rmSync(outRoot, { recursive: true, force: true });
  mkdirSync(outRoot, { recursive: true });
  process.stdout.write('rows      ingest+run(ms)  package(ms)  verify(ms)  rss(MB)  package(KB)  delivered\n');

  const self = fileURLToPath(import.meta.url);
  for (const rows of SIZES) {
    const child = spawnSync(process.execPath, [self, '--size', String(rows)], { encoding: 'utf8' });
    process.stdout.write(child.stdout ?? '');
    if (child.status !== 0) {
      process.stderr.write(child.stderr ?? '');
      process.exitCode = 1;
    }
  }

  process.stdout.write(
    '\nEach row above is a separate process, so rss is that process high-water mark.\n' +
      'These figures describe one machine running one synthetic fixture. They are not a capacity claim.\n',
  );
}

main();
