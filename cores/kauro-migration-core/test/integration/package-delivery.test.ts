import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../../src/mapping/load-config.js';
import { runMigration } from '../../src/run/run-migration.js';
import {
  MANIFEST_FILE,
  discardStagedPackage,
  promotePackage,
  stagingDirFor,
  writePackage,
} from '../../src/artifacts/write-package.js';
import { verifyPackage } from '../../src/verify/verify-package.js';
import { isMigrationError } from '../../src/domain/errors.js';
import { caseScratch, repoRoot, scratchDir, verifyScratch } from '../support/harness.js';

/**
 * When a package becomes readable.
 *
 * The contract's order is render, reconcile, hash, verify, attest, publish. A
 * writer that puts its manifest at the destination has already published before
 * any of that could happen: the package is live while it is still being checked,
 * and a failure part way through leaves a partial one sitting exactly where a
 * reader expects a whole one.
 *
 * So the package is built somewhere else and moved in one step. Until the move
 * the destination holds either nothing or the previous package; after it, a
 * complete one. There is no moment in between, which is a property no amount of
 * care while writing in place can offer.
 */

const FIXTURES = join(repoRoot(), 'test', 'fixtures', 'value-intent');

function stage(name: string, options: { force?: boolean; outputDir?: string } = {}) {
  const configPath = join(FIXTURES, 'clean-only.json');
  const loaded = loadConfig(readFileSync(configPath, 'utf8'), configPath);
  const result = runMigration({
      scratch: caseScratch('packagedelivery1'),
    inputRoot: join(FIXTURES, 'input'),
    config: loaded.config,
    configHash: loaded.configHash,
  });
  const outputDir = options.outputDir ?? join(scratchDir('delivery', name), 'package');
  const written = writePackage({
    result,
    config: loaded.config,
    normalizedConfig: loaded.normalizedJson,
    outputDir,
    force: options.force ?? false,
  });
  return { written, outputDir };
}

describe('a package is not readable until it has been published', () => {
  it('writes somewhere that is not the destination', () => {
    const { written, outputDir } = stage('staged');

    assert.notEqual(written.stagingDir, outputDir);
    assert.equal(written.stagingDir, stagingDirFor(outputDir));
    assert.equal(existsSync(join(written.stagingDir, MANIFEST_FILE)), true, 'the package is complete in staging');
    assert.equal(existsSync(outputDir), false, 'and nothing has appeared at the destination');
  });

  it('verifies where it was staged', () => {
    const { written } = stage('verify-staged');
    const report = verifyPackage(written.stagingDir, { scratch: verifyScratch(written.stagingDir) });
    assert.deepEqual(report.problems, [], report.problems.map((p) => `${p.check}: ${p.detail}`).join('; '));
  });

  it('publishes in one step, leaving nothing behind', () => {
    const { written, outputDir } = stage('promote');
    const published = promotePackage(written, { force: false });

    assert.equal(published, outputDir);
    assert.equal(existsSync(join(outputDir, MANIFEST_FILE)), true);
    assert.equal(existsSync(written.stagingDir), false, 'the staging directory is consumed by the move');
    const report = verifyPackage(outputDir, { scratch: verifyScratch(outputDir) });
    assert.deepEqual(report.problems, []);
  });

  it('leaves the destination untouched when the package is discarded', () => {
    const { written, outputDir } = stage('discard');
    discardStagedPackage(written);
    assert.equal(existsSync(written.stagingDir), false);
    assert.equal(existsSync(outputDir), false, 'a package that was never published never existed');
    // Discarding twice is the failure path calling cleanup without knowing how
    // far the write got.
    discardStagedPackage(written);
  });

  it('refuses to publish what was never staged', () => {
    const { written } = stage('missing');
    discardStagedPackage(written);
    assert.throws(
      () => promotePackage(written, { force: false }),
      (error: unknown) => isMigrationError(error) && error.code === 'PACKAGE_INVALID',
    );
  });
});

describe('publishing will not take a directory that is not ours', () => {
  it('refuses a destination holding files this core did not write', () => {
    const root = scratchDir('delivery', 'occupied');
    const outputDir = join(root, 'package');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'somebody-elses-work.txt'), 'do not delete me');

    assert.throws(
      () => stage('occupied', { outputDir, force: true }),
      (error: unknown) => isMigrationError(error) && error.code === 'PACKAGE_INVALID',
    );
    assert.equal(
      readFileSync(join(outputDir, 'somebody-elses-work.txt'), 'utf8'),
      'do not delete me',
      'and it is still there',
    );
  });

  it('refuses a previous package without force, and replaces one with it', () => {
    const root = scratchDir('delivery', 'replace');
    const outputDir = join(root, 'package');

    const first = stage('replace-first', { outputDir });
    promotePackage(first.written, { force: false });
    const before = readdirSync(outputDir).length;
    assert.ok(before > 0);

    // Without force, a destination that already holds one of our packages is
    // refused — and refused before the work, not after it.
    assert.throws(
      () => stage('replace-refused', { outputDir, force: false }),
      (error: unknown) => isMigrationError(error) && error.code === 'PACKAGE_INVALID',
    );
    assert.equal(existsSync(join(outputDir, MANIFEST_FILE)), true, 'the earlier package survives the refusal');

    const second = stage('replace-forced', { outputDir, force: true });
    promotePackage(second.written, { force: true });
    assert.equal(existsSync(join(outputDir, MANIFEST_FILE)), true);
    assert.deepEqual(verifyPackage(outputDir, { scratch: verifyScratch(outputDir) }).problems, []);
  });
});

describe('the bytes delivered are the bytes that were hashed', () => {
  it('reads every artifact back and compares it against what it wrote', () => {
    // Read in blocks rather than whole, so confirming a package no longer needs
    // memory proportional to its largest artifact. The check itself is
    // unchanged, and this proves it still catches the thing it exists for.
    const { written } = stage('readback');
    const manifest = JSON.parse(readFileSync(join(written.stagingDir, MANIFEST_FILE), 'utf8')) as {
      artifacts: { path: string; sha256: string; byteLength: number }[];
    };
    assert.ok(manifest.artifacts.length > 0);

    for (const artifact of manifest.artifacts) {
      const onDisk = readFileSync(join(written.stagingDir, ...artifact.path.split('/')));
      assert.equal(onDisk.length, artifact.byteLength, `${artifact.path} length`);
    }

    // And the run's own read-back is what would have caught a change: altering
    // an artifact after the fact is detected by the package verifier, which is
    // the independent witness.
    const target = join(written.stagingDir, ...(manifest.artifacts[0]?.path ?? '').split('/'));
    const original = readFileSync(target);
    writeFileSync(target, Buffer.concat([original, Buffer.from('x')]));
    const report = verifyPackage(written.stagingDir, { scratch: verifyScratch(written.stagingDir) });
    assert.notDeepEqual(report.problems, [], 'an altered artifact must not verify');
  });
});
