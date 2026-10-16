import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/mapping/load-config.js';
import { runMigration } from '../../src/run/run-migration.js';
import type { RunResult } from '../../src/run/run-migration.js';
import type { LineageEntry } from '../../src/reconcile/truth.js';
import { writeAndPromotePackage } from '../../src/artifacts/write-package.js';
import { packagePath } from '../../src/artifacts/layout.js';
import type { WritePackageResult } from '../../src/artifacts/write-package.js';
import { verifyPackage } from '../../src/verify/verify-package.js';
import { createFilesystemScratchStore } from '../../src/scratch/filesystem-scratch-store.js';
import { SCRATCH_BUDGET_BYTES } from '../../src/domain/resource-profile.js';
import type { ScratchStore } from '../../src/scratch/scratch-store.js';
import type { VerificationReport } from '../../src/verify/verify-package.js';
import { readCsv } from '../../src/ingest/csv-reader.js';
import { parseJson } from '../../src/util/json.js';
import type { JsonObject } from '../../src/util/json.js';
import { attestationFor } from '../../tools/attestation-fixture.js';

/** Walks up from the compiled test file until it finds the repository root. */
export function repoRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(current, 'package.json')) && existsSync(join(current, 'tsconfig.json'))) {
      return current;
    }
    current = dirname(current);
  }
  throw new Error('could not locate the repository root from the compiled test file');
}

export const GOLDEN_ROOT = join(repoRoot(), 'test', 'fixtures', 'golden');
export const ADVERSARIAL_ROOT = join(repoRoot(), 'test', 'fixtures', 'adversarial');

export function listCases(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** A scratch directory under tmp/, cleared first so a run never inherits stale bytes. */
export function scratchDir(...parts: string[]): string {
  const target = join(repoRoot(), 'tmp', 'test', ...parts);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  return target;
}

export interface CaseRun {
  readonly caseId: string;
  readonly fixtureDir: string;
  readonly packageDir: string;
  readonly result: RunResult;
  readonly written: WritePackageResult;
  readonly verification: VerificationReport;
  /** Held open so the run's families can still be read by the case. */
  readonly scratch: ScratchStore;
}

export interface RunFixtureOptions {
  /** Overrides the input directory, for metamorphic tests that reshape the source. */
  readonly inputDir?: string;
  /** Overrides the configuration file, for tests that vary one setting. */
  readonly configPath?: string;
  readonly scratchName?: string;
}

export function runFixture(root: string, caseId: string, options: RunFixtureOptions = {}): CaseRun {
  const fixtureDir = join(root, caseId);
  const inputDir = options.inputDir ?? join(fixtureDir, 'input');
  const configPath = options.configPath ?? join(fixtureDir, 'config.json');
  const packageDir = scratchDir(options.scratchName ?? caseId);

  const loaded = loadConfig(readFileSync(configPath, 'utf8'), configPath);
  // Deliberately not disposed. A case inspects the run's families after this
  // returns, and they read from here; the directory is wiped when the next case
  // asks for its own, so nothing accumulates across a suite.
  const scratch = caseScratch(options.scratchName ?? caseId);
  const result = runMigration({
    inputRoot: inputDir,
    config: loaded.config,
    configHash: loaded.configHash,
    scratch,
    // A CRM fixture attests, like any CRM run. See tools/attestation-fixture.ts
    // for why the fixtures were given real evidence rather than the default
    // being relaxed for them.
    ...attestationFor(loaded.config.target.mode),
  });
  const written = writeAndPromotePackage({
    result,
    config: loaded.config,
    normalizedConfig: loaded.normalizedJson,
    outputDir: packageDir,
    force: true,
  });
  const verification = verifyPackage(packageDir, { scratch: verifyScratch(packageDir) });

  return { caseId, fixtureDir, packageDir, result, written, verification, scratch };
}

/**
 * A scratch store for one case, under the same temporary root the packages use.
 *
 * A test needs the families to still be readable when it looks at them, so this
 * outlives the run on purpose. The quota is generous rather than realistic: a
 * fixture that hits it is telling us about the fixture, not about the engine.
 */
/**
 * A store for one verification, beside the package it verifies.
 *
 * The verifier spills the projections it joins on, so a caller has to say
 * where. The package directory is the name because it is one no other test
 * can produce: the suite runs its files in separate processes, and a counter
 * would have each of them counting from one, so two would name the same
 * directory and one would clear the other's segments out from under it.
 */
export function verifyScratch(packageDir: string): ScratchStore {
  const root = resolve(`${packageDir}.kauro-verify`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return createFilesystemScratchStore({
    root,
    runId: 'verify',
    quotaBytes: SCRATCH_BUDGET_BYTES,
  });
}

export function caseScratch(name: string): ScratchStore {
  // A directory of its own, every time.
  //
  // `scratchDir` clears what it hands back, so two calls with the same name
  // would leave the first store pointing at segments the second had deleted —
  // and the first store would go on reporting them, because it holds their
  // manifests. A property case that runs the same migration twice and compares
  // the results would then be comparing one run against a hollowed-out record
  // of the other, and reading it as a difference in the engine.
  caseScratchCount += 1;
  return createFilesystemScratchStore({
    root: scratchDir('work', `${name}-${String(caseScratchCount)}`),
    runId: 'case',
    quotaBytes: 512 * 1024 * 1024,
  });
}

let caseScratchCount = 0;

/**
 * A family, as an array.
 *
 * For tests only. Production code walks a family once and never collects it;
 * a case wants to make assertions about the whole of a small one, and saying so
 * explicitly is better than giving families methods that invite the same thing
 * where it would matter.
 */
export function collect<T>(family: Iterable<T>): T[] {
  return [...family];
}

export interface Table {
  readonly headers: readonly string[];
  readonly rows: readonly Readonly<Record<string, string>>[];
}

/**
 * A tabular artifact, addressed the way the contract names it.
 *
 * Tests ask for `changes.csv`; the layout decides that it lives under
 * 03_TRACEABILITY. Resolving through the same function the writer and the
 * verifier use means a test cannot pass by looking in a place a real reader
 * would never look.
 */
export function readTable(packageDir: string, name: string): Table {
  const relativePath = packagePath(name);
  const text = readFileSync(join(packageDir, ...relativePath.split('/')), 'utf8');
  const parsed = readCsv(text, {
    delimiter: ',',
    filePath: relativePath,
    maxCellLength: 10_000_000,
    maxColumns: 10_000,
    maxRows: 10_000_000,
  });
  const header = parsed.records[0];
  if (header === undefined) return { headers: [], rows: [] };
  const headers = [...header.fields];
  const rows = parsed.records.slice(1).map((record) => {
    const row: Record<string, string> = {};
    headers.forEach((name, index) => {
      row[name] = record.fields[index] ?? '';
    });
    return row;
  });
  return { headers, rows };
}

export function readJsonArtifact(packageDir: string, name: string): JsonObject {
  return parseJson(readFileSync(join(packageDir, ...packagePath(name).split('/')), 'utf8')) as JsonObject;
}

export function readTextArtifact(packageDir: string, name: string): string {
  return readFileSync(join(packageDir, ...packagePath(name).split('/')), 'utf8');
}

/** `contacts.csv#4` addresses the fourth physical row of contacts.csv. */
export function parseRowRef(reference: string): { file: string; rowNumber: number } {
  const index = reference.lastIndexOf('#');
  if (index === -1) throw new Error(`row reference "${reference}" must look like "file.csv#4"`);
  return { file: reference.slice(0, index), rowNumber: Number(reference.slice(index + 1)) };
}

export function findLineage(run: CaseRun, reference: string): LineageEntry {
  const { file, rowNumber } = parseRowRef(reference);
  for (const entry of run.result.truth.lineage) {
    if (entry.address.filePath === file && entry.address.rowNumberSource === rowNumber) return entry;
  }
  throw new Error(`${run.caseId}: no lineage entry for ${reference}`);
}

export function resolveConfigPath(root: string, caseId: string): string {
  return join(root, caseId, 'config.json');
}

export function resolveInputDir(root: string, caseId: string): string {
  return join(root, caseId, 'input');
}

export function readCaseExpectation(root: string, caseId: string): JsonObject {
  return parseJson(readFileSync(join(root, caseId, 'expected', 'case.json'), 'utf8')) as JsonObject;
}

export { resolve as resolvePath };
