import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { repoRoot, scratchDir } from '../support/harness.js';

/**
 * The repository's self-tests, run by `npm test` and named here.
 *
 * Until this file existed the release-dossier and evidence self-tests ran only
 * when somebody ran them by hand, so their execution was absent from the
 * verification log the reviewer reads. Each test below spawns the tool, reads
 * what the tool says about each of its cases, and insists on the ones it
 * names. A case that is missing is a failure: "the tool exited 0" is not the
 * statement, because a tool that stopped running a case would exit 0 too.
 */

function run(tool: string, args: readonly string[] = []): { status: number | null; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, [join(repoRoot(), 'tools', tool), ...args], {
    cwd: repoRoot(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
  });
  return { status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
}

/** The `ok` / `FALSE` line the dossier self-test prints for each of its cases. */
function dossierCases(stdout: string): Map<string, boolean> {
  const cases = new Map<string, boolean>();
  for (const line of stdout.split('\n')) {
    const match = /^ {2}(ok|FALSE) +(\S+)$/u.exec(line.trimEnd());
    if (match !== null) cases.set(match[2] as string, match[1] === 'ok');
  }
  return cases;
}

describe('the release-dossier self-tests (MC-07)', () => {
  it('[MC-07] release-dossier self-tests pass', () => {
    const child = run('release-dossier-selftest.mjs');
    const cases = dossierCases(child.stdout);
    assert.ok(cases.size >= 50, `the self-test reported ${String(cases.size)} cases: ${child.stdout.slice(0, 400)}${child.stderr.slice(0, 400)}`);
    for (const id of [
      'dossier.positive',
      'mc07.differentExecutableSameVersion',
      'mc07.sourceNotATar',
      'mc07.preflightFalseFactUnderTrue',
      'mc07.nullProvenance',
    ]) {
      assert.ok(cases.has(id), `${id} did not run`);
      assert.equal(cases.get(id), true, `${id} did not pass`);
    }
    // Every case of the tool except the one about records committed by a
    // sealed campaign, which this tree has not had yet (it is the seal's).
    const failed = [...cases].filter(([id, ok]) => !ok && id !== 'records.committedRecordsPassClosedSchemas').map(([id]) => id);
    assert.deepEqual(failed, [], 'every other dossier case passes');
  });
});

describe('the evidence self-tests (S092)', () => {
  it('[S092] evidence self-tests pass', () => {
    const out = join(scratchDir('self-tests'), 'evidence.json');
    mkdirSync(join(out, '..'), { recursive: true });
    const child = run('evidence-selftest.mjs', ['--evidence', out]);
    assert.equal(child.status, 0, `${child.stderr.slice(-600)}`);
    const report = JSON.parse(readFileSync(out, 'utf8')) as { cases: { id: string; ok: boolean }[]; result: string };
    const byId = new Map(report.cases.map((entry) => [entry.id, entry.ok]));
    for (const id of [
      'closure.onlyItsOwnInputsMoveTheFingerprint',
      'closure.unresolvedImportRefusesToFingerprint',
      'closure.scorerOnlyChangeKeepsProducerFingerprint',
      'closure.scorerInsideAProducerImportMovesTheFingerprint',
      'reuse.withoutEquivalenceRecordRefused',
    ]) {
      assert.ok(byId.has(id), `${id} did not run`);
      assert.equal(byId.get(id), true, `${id} did not pass`);
    }
    assert.equal(report.result, 'PASS');
  });
});

describe('the published-asset check (R2-017)', () => {
  it('[R2-017] a same-version tarball with one hidden byte changed is refused before its install counts', () => {
    const child = run('published-asset-check.mjs', ['--self-test']);
    const lines = child.stdout.trim().split('\n');
    const summary = JSON.parse(lines.slice(lines.findIndex((line) => line.startsWith('{'))).join('\n')) as {
      passed: boolean;
      cases: { id: string; ok: boolean }[];
    };
    const byId = new Map(summary.cases.map((entry) => [entry.id, entry.ok]));
    for (const id of [
      'genuine.assetIsAccepted',
      'hiddenByte.sameVersionRefusedBeforeInstall',
      'hiddenByte.sumsRewrittenStillRefusedBeforeInstall',
      'install.filesMustEqualTarEntries',
      'version.textAloneIsNotTheCheck',
      'operator.digestAndUrlAccepted',
      'operator.wrongDigestRefusedBeforeInstall',
      'operator.urlServingOtherBytesRefusedBeforeInstall',
      'operator.urlMustBeThePackageAsset',
    ]) {
      assert.ok(byId.has(id), `${id} did not run`);
      assert.equal(byId.get(id), true, `${id} did not pass`);
    }
    assert.equal(child.status, 0, child.stderr.slice(-400));
    assert.equal(summary.passed, true);
  });
});
