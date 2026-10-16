/**
 * Determinism replay.
 *
 * Runs every golden and acceptance fixture twice, in two separate child
 * processes writing to two different directories, and compares the SHA-256 of
 * every artifact. Using separate processes matters: it rules out determinism
 * that only holds because a single process happened to reuse state.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../src/util/hash.js';
import { canonicalJsonText, compareCodeUnits, parseJson } from '../src/util/json.js';
import { targetContractToJson } from '../src/target/contract.js';
import { fixtureAttestation } from './attestation-fixture.js';
import { listPackageFiles } from '../src/artifacts/write-package.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)), '..');
const cli = join(repoRoot, 'dist', 'src', 'cli', 'main.js');
const scratch = join(repoRoot, 'tmp', 'determinism');

interface Fixture {
  readonly id: string;
  readonly inputDir: string;
  readonly configPath: string;
}

function collect(root: string, label: string): Fixture[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareCodeUnits)
    .map((name) => ({
      id: `${label}/${name}`,
      inputDir: join(root, name, 'input'),
      configPath: join(root, name, 'config.json'),
    }));
}

function fingerprint(packageDir: string): string {
  const lines = listPackageFiles(packageDir).map(
    (path) => `${sha256Hex(readFileSync(join(packageDir, ...path.split('/'))))}  ${path}`,
  );
  return lines.join('\n');
}

/**
 * The evidence a CRM fixture needs, written where the CLI can be pointed at it.
 *
 * This replay drives the command line rather than the library, which is the
 * point of it — the operator's path is the one that has to be reproducible. So
 * when attestation became REQUIRED for the CRM modes, this had to start doing
 * what an operator does: write the contract, the attestation and the issuer list
 * to disk and name them on the command line.
 *
 * The files are written once per fixture and reused for both runs. They must be,
 * or the two runs would carry different contract hashes and the comparison would
 * fail on the evidence rather than on the engine.
 */
function evidenceFlags(fixture: Fixture, dir: string): string[] {
  const mode = (parseJson(readFileSync(fixture.configPath, 'utf8')) as { target?: { mode?: string } }).target?.mode;
  if (mode !== 'HUBSPOT' && mode !== 'SALESFORCE') return [];
  mkdirSync(dir, { recursive: true });
  const evidence = fixtureAttestation(mode);
  const contractPath = join(dir, 'contract.json');
  const attestationPath = join(dir, 'attestation.json');
  const issuersPath = join(dir, 'issuers.json');
  // The wrapper, not the bare contract. A contract file carries the body and the
  // digest that names it, so a reader can tell an edited capture from an intact
  // one. Writing only the body produced a file the loader refused as "does not
  // carry both a contract and the digest that names it" — which is the loader
  // being right.
  writeFileSync(
    contractPath,
    `${canonicalJsonText({
      contract: targetContractToJson(evidence.targetContract.contract),
      contractHash: evidence.targetContract.contractHash,
    })}\n`,
  );
  writeFileSync(attestationPath, `${JSON.stringify(evidence.targetAttestation, null, 2)}\n`);
  writeFileSync(issuersPath, `${JSON.stringify({ authorities: evidence.attestationAuthorities }, null, 2)}\n`);
  return [
    '--target-contract',
    contractPath,
    '--attestation',
    attestationPath,
    '--attestation-issuer',
    issuersPath,
    '--attestation-instant',
    evidence.attestationInstant,
  ];
}

function runOnce(fixture: Fixture, outputDir: string, evidence: readonly string[]): boolean {
  const result = spawnSync(
    process.execPath,
    [cli, 'run', '--input', fixture.inputDir, '--config', fixture.configPath, '--out', outputDir, '--force', ...evidence],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    process.stderr.write(`${fixture.id} failed to run:\n${result.stdout}${result.stderr}\n`);
    return false;
  }
  return true;
}

/**
 * How many fixtures each corpus must hold for this replay to mean anything.
 *
 * A floor, not a fixed list. The replay reported success on whatever it found,
 * so an empty `test/fixtures/golden` — a bad checkout, a deleted directory, a
 * `.gitignore` mistake — printed "0 fixtures run twice, 0 produced different
 * bytes" and exited zero, and the universe scored determinism as passing on a
 * run that compared nothing. The count itself is derived rather than declared,
 * so adding a fixture never needs an edit here; what is declared is that the
 * corpora exist and are not smaller than the contract says.
 *
 * The figures come from `docs/CONTRACT.md` 14 and the acceptance ledger: 38
 * golden cases and 5 acceptance cases at the time MC-3 froze. A corpus that
 * grows passes; one that shrinks is a corpus somebody has to explain.
 */
const EXPECTED_FIXTURES: Readonly<Record<string, number>> = { golden: 40, acceptance: 5 };

function main(): void {
  rmSync(scratch, { recursive: true, force: true });

  const golden = collect(join(repoRoot, 'test', 'fixtures', 'golden'), 'golden');
  const acceptance = collect(join(repoRoot, 'test', 'fixtures', 'acceptance'), 'acceptance');
  const inventory: string[] = [];
  for (const [label, found] of [
    ['golden', golden],
    ['acceptance', acceptance],
  ] as const) {
    const expected = EXPECTED_FIXTURES[label] as number;
    if (found.length < expected) {
      inventory.push(`${label} holds ${String(found.length)} fixtures and the contract states at least ${String(expected)}`);
    }
  }
  if (inventory.length > 0) {
    process.stderr.write(
      `determinism replay refused: ${inventory.join('; ')}\n` +
        'A replay over an empty or shortened corpus compares nothing and reports success for it.\n',
    );
    process.exitCode = 1;
    return;
  }

  const fixtures = [...golden, ...acceptance];

  let compared = 0;
  const differing: string[] = [];
  const failed: string[] = [];

  for (const fixture of fixtures) {
    const safe = fixture.id.split('/').join('-');
    const first = join(scratch, `${safe}-a`);
    const second = join(scratch, `${safe}-b`);

    const evidence = evidenceFlags(fixture, join(scratch, `${safe}-evidence`));
    if (!runOnce(fixture, first, evidence) || !runOnce(fixture, second, evidence)) {
      failed.push(fixture.id);
      continue;
    }

    compared += 1;
    if (fingerprint(first) !== fingerprint(second)) differing.push(fixture.id);
  }

  process.stdout.write(
    `determinism replay: ${String(compared)} of ${String(fixtures.length)} fixtures run twice in separate processes ` +
      `(${String(golden.length)} golden, ${String(acceptance.length)} acceptance), ` +
      `${String(differing.length)} produced different bytes\n`,
  );
  if (compared !== fixtures.length) {
    process.stderr.write(
      `${String(fixtures.length - compared)} fixtures were not compared at all, which is not the same as agreeing\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (failed.length > 0) {
    process.stderr.write(`fixtures that would not run: ${failed.join(', ')}\n`);
  }
  if (differing.length > 0) {
    process.stderr.write(`fixtures whose artifacts differ between runs: ${differing.join(', ')}\n`);
  }
  if (failed.length > 0 || differing.length > 0) {
    process.exitCode = 1;
    return;
  }

  rmSync(scratch, { recursive: true, force: true });
}

main();
