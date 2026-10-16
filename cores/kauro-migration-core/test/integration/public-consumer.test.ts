import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { repoRoot } from '../support/harness.js';

/**
 * The public package, used by somebody who is not this repository.
 *
 * Everything else in the suite imports from `src/`. That proves the modules
 * work; it proves nothing about what a consumer installing the built package
 * can reach. Intelligence Core will install the tarball and import from
 * `kauro-migration-core`, and only what `src/index.ts` exports exists for it.
 *
 * So this packs the tree with `npm pack`, installs the tarball into a temporary
 * project outside the repository, and runs a consumer that uses only the public
 * entry point: profiles a bundle, builds a candidate set, runs a migration under
 * a plan bound to the profile, writes the package, verifies it, and then feeds
 * the loaders a tampered profile and a tampered candidate set. Nothing in the
 * consumer names a path under `dist/`.
 */

const root = repoRoot();

const CONSUMER = String.raw`
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CORE_VERSION,
  PACKAGE_FORMAT_VERSION,
  SOURCE_PROFILE_VERSION,
  CANDIDATE_SET_VERSION,
  SCRATCH_BUDGET_BYTES,
  createFilesystemScratchStore,
  loadConfig,
  produceSourceProfile,
  serializeSourceProfile,
  loadSourceProfile,
  buildCandidateSet,
  serializeCandidateSet,
  loadCandidateSet,
  assertCandidateSetMatches,
  runMigration,
  writePackage,
  promotePackage,
  verifyPackage,
  packageDigest,
  MigrationError,
} from 'kauro-migration-core';

const work = process.argv[2];
const input = join(work, 'input');
mkdirSync(input, { recursive: true });
writeFileSync(join(input, 'contacts.csv'), 'Contact ID,First Name,Last Name,Email\n1,Ada,Lovelace,ada@kauro-consumer.test\n2,Grace,Hopper,grace@kauro-consumer.test\n3,Alan,Turing,alan@kauro-consumer.test\n');
const configText = JSON.stringify({
  configVersion: '3.0.0',
  source: { system: 'consumer', namespace: 'consumer' },
  target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' },
  files: [{ id: 'contacts', path: 'contacts.csv', format: 'CSV' }],
  records: [{
    id: 'contacts', fileId: 'contacts', object: 'CONTACT',
    sourceRecordIdColumn: { header: 'Contact ID' },
    fields: [
      { column: { header: 'First Name' }, destinationField: 'contact.firstName', semanticType: 'TEXT' },
      { column: { header: 'Last Name' }, destinationField: 'contact.lastName', semanticType: 'TEXT' },
      { column: { header: 'Email' }, destinationField: 'contact.email', semanticType: 'EMAIL' },
    ],
  }],
});
const configPath = join(work, 'config.json');
writeFileSync(configPath, configText);
const loaded = loadConfig(configText, configPath);

const scratch = (name) => createFilesystemScratchStore({ root: join(work, 'scratch-' + name), runId: name, quotaBytes: SCRATCH_BUDGET_BYTES });
const out = {};
let store = scratch('profile');
try {
  const profiled = produceSourceProfile({ inputRoot: input, config: loaded.config, scratch: store });
  out.profileHash = profiled.profileHash;
  out.profileVersion = profiled.profile.profileVersion;
  const text = serializeSourceProfile(profiled);
  out.profileReloads = loadSourceProfile(text, 'profile.json').profileHash === profiled.profileHash;
  try { loadSourceProfile(text.replace(profiled.profileHash, '0'.repeat(63) + '1'), 'profile.json'); out.tamperedProfile = 'ACCEPTED'; }
  catch (error) { out.tamperedProfile = error instanceof MigrationError ? error.code : 'OTHER'; }
  try { loadSourceProfile('{"profileVersion":"1.0.0"}', 'profile.json'); out.bareProfile = 'ACCEPTED'; }
  catch (error) { out.bareProfile = error instanceof MigrationError ? error.code : 'OTHER'; }

  const candidates = buildCandidateSet({ profile: profiled, configHash: loaded.configHash });
  out.candidateCount = candidates.candidateSet.candidates.length;
  out.candidateSetVersion = candidates.candidateSet.candidateSetVersion;
  const setText = serializeCandidateSet(candidates);
  out.candidateSetReloads = loadCandidateSet(setText, 'set.json').candidateSetHash === candidates.candidateSetHash;
  try { loadCandidateSet(setText.replace(candidates.candidateSetHash, '0'.repeat(63) + '1'), 'set.json'); out.tamperedSet = 'ACCEPTED'; }
  catch (error) { out.tamperedSet = error instanceof MigrationError ? error.code : 'OTHER'; }
  try { assertCandidateSetMatches(candidates, { bundleId: 'B-0000000000000000', profileHash: profiled.profileHash }); out.foreignSet = 'ACCEPTED'; }
  catch (error) { out.foreignSet = error instanceof MigrationError ? error.details.reason : 'OTHER'; }

  const run = runMigration({ inputRoot: input, config: loaded.config, configHash: loaded.configHash, scratch: scratch('run'), sourceProfile: profiled });
  out.rows = run.reconciliation.sourceRows.total;
  out.equationHolds = run.reconciliation.sourceRows.equationHolds;
  out.boundProfile = run.truth.sourceProfileHash === profiled.profileHash;
  const written = writePackage({ result: run, config: loaded.config, normalizedConfig: loaded.normalizedJson, outputDir: join(work, 'package'), force: true });
  out.artifacts = written.artifacts.length;
  // Staged, verified where it was staged, published only if it verifies — the
  // order the contract asks for, done here through public exports alone.
  const verifyStore = scratch('verify');
  try {
    const report = verifyPackage(written.stagingDir, { scratch: verifyStore });
    out.verified = report.passed;
    out.checks = report.checks.length;
  } finally { verifyStore.dispose(); }
  out.published = promotePackage(written, { force: true });
  out.digest = packageDigest(join(work, 'package')).digest;
  out.versions = { CORE_VERSION, PACKAGE_FORMAT_VERSION, SOURCE_PROFILE_VERSION, CANDIDATE_SET_VERSION };
} finally { store.dispose(); }
process.stdout.write(JSON.stringify(out));
`;

interface Verdict {
  valid: boolean;
  reason: string;
}

function installPackage(work: string): string {
  const packed = spawnSync('npm', ['pack', '--silent', '--pack-destination', work], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  assert.equal(packed.status, 0, `npm pack failed: ${packed.stderr}`);
  const tarball = readdirSync(work).find((name) => name.endsWith('.tgz'));
  assert.ok(tarball !== undefined, 'npm pack produced a tarball');

  const project = join(work, 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'kauro-consumer', private: true, type: 'module' }));
  const installed = spawnSync('npm', ['install', '--silent', '--no-audit', '--no-fund', '--ignore-scripts', join(work, tarball)], {
    cwd: project,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  assert.equal(installed.status, 0, `npm install failed: ${installed.stderr}`);
  assert.ok(existsSync(join(project, 'node_modules', 'kauro-migration-core', 'dist', 'src', 'index.js')));
  return project;
}

/**
 * CMD024, the core half (amendment A5), through the installed package only.
 * The receipt is the six-hash evidence a host (B08) will persist. A receipt is
 * VALID only if every field is present, it names this subject, the package
 * verifies, and the package digest and attestation re-derive from the subject:
 * all computed from public exports, never from dist internals.
 */
const CMD024_CONSUMER = String.raw`
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { join } from 'node:path';
import {
  CORE_VERSION, SCRATCH_BUDGET_BYTES, createFilesystemScratchStore, loadConfig, produceSourceProfile,
  hashTargetContract, verifyAttestation, attestationSigningBytes, ATTESTATION_ALGORITHM, ATTESTATION_CONTRACT_VERSION,
  runMigration, writePackage, promotePackage, verifyPackage, packageDigest,
} from 'kauro-migration-core';

const work = process.argv[2];
const fixtures = process.argv[3];
const FIELDS = ['profile', 'configuration', 'contract', 'attestation', 'packageDigest', 'coreVersion'];
const NOW = '2026-09-15T00:00:00Z';
const issuerKey = generateKeyPairSync('ed25519');
const authority = { issuerId: 'agency:acme', keyId: 'k1', algorithm: ATTESTATION_ALGORITHM, publicKeyPem: issuerKey.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const contract = hashTargetContract({
  contractVersion: '1.0.0', parserVersion: '1.0.0', capturedAt: '2026-09-01T00:00:00Z',
  instance: { mode: 'HUBSPOT', instanceId: '00000001', instanceLabel: 'Acme portal', evidence: 'ARTIFACT' },
  artifacts: [{ path: 'export/properties.csv', sha256: 'a'.repeat(64), byteLength: 4096, kind: 'DESCRIBE' }],
  objects: [{
    apiName: 'Contact', label: 'Contact', createable: 'TRUE', updateable: 'TRUE', recordTypes: [],
    fields: [['email', 'Email', 'TRUE'], ['firstname', 'First name', 'FALSE'], ['lastname', 'Last name', 'FALSE'], ['jobtitle', 'Job title', 'FALSE']].map(([apiName, label, unique]) => ({
      apiName, label, type: 'string', createable: 'TRUE', updateable: 'TRUE', nillable: 'TRUE', length: null, precision: null, scale: null,
      unique, externalId: 'FALSE', idLookup: unique, calculated: 'FALSE', autoNumber: 'FALSE', defaultedOnCreate: 'FALSE',
      restrictedPicklist: 'FALSE', picklistValues: [], referenceTo: [], relationshipName: null, evidence: 'ARTIFACT',
    })),
  }],
  pipelines: [],
});
function signed() {
  const body = {
    attestationVersion: ATTESTATION_CONTRACT_VERSION, issuer: { id: 'agency:acme', name: 'Acme Partners', keyId: 'k1' },
    subject: { mode: 'HUBSPOT', instanceId: '00000001', instanceLabel: 'Acme portal' },
    artifacts: [{ path: 'export/properties.csv', sha256: 'a'.repeat(64), byteLength: 4096 }],
    contractHash: contract.contractHash, schemaVersion: '1.0.0', toolVersion: 'kauro-capture/1.0.0',
    capturedAt: '2026-09-01T00:00:00Z', expiresAt: '2026-10-01T00:00:00Z', nonce: null,
  };
  const candidate = { ...body, signature: { algorithm: ATTESTATION_ALGORITHM, value: '' } };
  const value = sign(null, Buffer.from(attestationSigningBytes(candidate), 'utf8'), issuerKey.privateKey).toString('base64');
  return { ...body, signature: { algorithm: ATTESTATION_ALGORITHM, value } };
}
const attestationHashOf = (att) => createHash('sha256').update(attestationSigningBytes(att)).digest('hex');
const scratch = (dir, name) => createFilesystemScratchStore({ root: join(dir, 'scratch-' + name), runId: name, quotaBytes: SCRATCH_BUDGET_BYTES });
const hex64 = (value, prefix, into) => {
  if (typeof value === 'string') { if (/^[0-9a-f]{64}$/u.test(value)) into[prefix] = value; }
  else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value)) hex64(v, prefix + '.' + k, into);
  return into;
};

/** One validation of one subject, in its own run directory. Everything it exposes is returned. */
function validate(name, mutate) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  const path = join(fixtures, 'hubspot-update.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (mutate) mutate(parsed);
  const loaded = loadConfig(JSON.stringify(parsed), path);
  const input = join(fixtures, 'input');
  const att = signed();
  const profStore = scratch(dir, 'profile');
  const runStore = scratch(dir, 'run');
  try {
    const profile = produceSourceProfile({ inputRoot: input, config: loaded.config, scratch: profStore });
    const run = runMigration({ inputRoot: input, config: loaded.config, configHash: loaded.configHash, scratch: runStore, sourceProfile: profile,
      targetContract: contract, targetAttestation: att, attestationAuthorities: [authority], attestationInstant: NOW });
    const written = writePackage({ result: run, config: loaded.config, normalizedConfig: loaded.normalizedJson, outputDir: join(dir, 'package'), force: true });
    promotePackage(written, { force: true });
    const packageDir = join(dir, 'package');
    const receipt = {
      profile: profile.profileHash, configuration: loaded.configHash, contract: contract.contractHash,
      attestation: attestationHashOf(att), packageDigest: packageDigest(packageDir).digest, coreVersion: CORE_VERSION,
    };
    const exposed = hex64(run.truth, 'truth', hex64(written.artifacts, 'artifacts', {}));
    return { receipt, exposed, packageDir, dir, attestation: att, profileHash: profile.profileHash, configHash: loaded.configHash };
  } finally { profStore.dispose(); runStore.dispose(); }
}

/** The verdict a host would store: VALID only when every public check agrees. */
function judge(receipt, subject) {
  if (receipt === null || receipt === undefined || typeof receipt !== 'object') return { valid: false, reason: 'RECEIPT_NULL' };
  for (const f of FIELDS) if (typeof receipt[f] !== 'string' || receipt[f].length === 0) return { valid: false, reason: 'RECEIPT_INCOMPLETE:' + f };
  if (receipt.profile !== subject.profileHash || receipt.configuration !== subject.configHash) return { valid: false, reason: 'RECEIPT_SUBJECT_MISMATCH' };
  if (receipt.coreVersion !== CORE_VERSION) return { valid: false, reason: 'RECEIPT_CORE_VERSION_MISMATCH' };
  const att = verifyAttestation({ attestation: subject.attestation, publicKeys: [authority], expect: { mode: 'HUBSPOT', instanceId: '00000001', contractHash: contract.contractHash, artifacts: subject.attestation.artifacts, at: NOW } });
  if (!att.ok || attestationHashOf(subject.attestation) !== receipt.attestation) return { valid: false, reason: 'RECEIPT_ATTESTATION_MISMATCH' };
  const store = scratch(subject.dir, 'verify');
  let report;
  try { report = verifyPackage(subject.packageDir, { scratch: store }); } finally { store.dispose(); }
  if (!report.passed) return { valid: false, reason: 'PACKAGE_NOT_VERIFIED' };
  if (packageDigest(subject.packageDir).digest !== receipt.packageDigest) return { valid: false, reason: 'PACKAGE_DIGEST_MISMATCH' };
  return { valid: true, reason: 'VALID' };
}

const out = {};
const a = validate('run-a');
const b = validate('run-b');
out.receiptA = a.receipt;
out.receiptB = b.receipt;
out.exposedA = a.exposed;
out.exposedB = b.exposed;
out.control = judge(a.receipt, a);
out.controlB = judge(a.receipt, b);

const altered = validate('run-altered');
const importFile = readdirSync(altered.packageDir, { recursive: true, encoding: 'utf8' }).filter((n) => n.endsWith('.csv') && n.includes('01_IMPORT')).sort()[0];
const target = join(altered.packageDir, importFile);
writeFileSync(target, readFileSync(target, 'utf8') + 'forged,row\n');
out.altered = judge(altered.receipt, altered);
const other = validate('run-other', (config) => { config.policies = { ...(config.policies ?? {}), formulaCachedValues: 'ACCEPT_WITH_PROVENANCE' }; });
out.otherDiffers = other.receipt.configuration !== a.receipt.configuration;
out.otherOwn = judge(other.receipt, other);
out.wrongSubject = judge(other.receipt, a);
out.incomplete = {};
for (const f of FIELDS) { const { [f]: _removed, ...rest } = a.receipt; out.incomplete[f] = judge(rest, a); }
out.nullReceipt = judge(null, a);
out.undefinedReceipt = judge(undefined, a);
process.stdout.write(JSON.stringify(out));
`;

describe('the built package, consumed through its public entry point', () => {
  it('profiles, proposes, runs, verifies and refuses tampering with only public exports', { timeout: 300_000 }, () => {
    const work = join(tmpdir(), `kauro-consumer-${String(process.pid)}`);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    try {
      const project = installPackage(work);

      writeFileSync(join(project, 'consumer.mjs'), CONSUMER);
      const ran = spawnSync(process.execPath, [join(project, 'consumer.mjs'), join(work, 'run')], { cwd: project, encoding: 'utf8' });
      assert.equal(ran.status, 0, `the consumer failed: ${ran.stderr}`);
      const out = JSON.parse(ran.stdout) as Record<string, unknown>;
      assert.equal(out['profileVersion'], '1.0.0');
      assert.equal(out['profileReloads'], true);
      assert.equal(out['tamperedProfile'], 'SOURCE_PROFILE_INVALID');
      assert.equal(out['bareProfile'], 'SOURCE_PROFILE_INVALID');
      assert.equal(out['candidateSetVersion'], '1.0.0');
      assert.ok(Number(out['candidateCount']) >= 1);
      assert.equal(out['candidateSetReloads'], true);
      assert.equal(out['tamperedSet'], 'CANDIDATE_SET_INVALID');
      assert.equal(out['foreignSet'], 'REFS_MISMATCH');
      assert.equal(out['rows'], 3);
      assert.equal(out['equationHolds'], true);
      assert.equal(out['boundProfile'], true);
      assert.equal(out['verified'], true);
      // 55 before package format 2.1.0; it adds manifest.formatVersion and the four humanView.* checks.
      assert.equal(out['checks'], 60);
      assert.match(String(out['digest']), /^[0-9a-f]{64}$/u);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('[CMD024-OK][CMD024-DENY][CMD024-RACE] the installed package gives identical complete receipts, never a VALID bad one, and the same receipt on retry', { timeout: 300_000 }, () => {
    const work = join(tmpdir(), `kauro-consumer-cmd024-${String(process.pid)}`);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    try {
      const project = installPackage(work);
      writeFileSync(join(project, 'cmd024.mjs'), CMD024_CONSUMER);
      const fixtures = join(root, 'test', 'fixtures', 'value-intent');
      const ran = spawnSync(process.execPath, [join(project, 'cmd024.mjs'), join(work, 'run'), fixtures], { cwd: project, encoding: 'utf8' });
      assert.equal(ran.status, 0, `the CMD024 consumer failed: ${ran.stderr}`);
      const out = JSON.parse(ran.stdout) as {
        receiptA: Record<string, string>; receiptB: Record<string, string>;
        exposedA: Record<string, string>; exposedB: Record<string, string>;
        control: Verdict; controlB: Verdict; altered: Verdict; otherDiffers: boolean; otherOwn: Verdict; wrongSubject: Verdict;
        incomplete: Record<string, Verdict>; nullReceipt: Verdict; undefinedReceipt: Verdict;
      };
      const fields = ['profile', 'configuration', 'contract', 'attestation', 'packageDigest', 'coreVersion'];

      // CMD024-OK and CMD024-RACE (core half): two separate run directories, same input.
      for (const f of fields) assert.ok(typeof out.receiptA[f] === 'string' && out.receiptA[f].length > 0, `receipt field ${f} is present`);
      for (const f of ['profile', 'configuration', 'contract', 'attestation', 'packageDigest']) assert.match(String(out.receiptA[f]), /^(?:tc_)?[0-9a-f]{64}$/u);
      assert.deepEqual(out.receiptB, out.receiptA, 'an identical retry returns the identical receipt');
      assert.ok(Object.keys(out.exposedA).length >= 6, 'every hash the run and the written package expose is compared, not one digest');
      assert.deepEqual(out.exposedB, out.exposedA, 'every exposed hash is identical across the two runs');
      assert.deepEqual(out.control, { valid: true, reason: 'VALID' }, 'the control receipt verifies');
      assert.deepEqual(out.controlB, { valid: true, reason: 'VALID' }, 'and verifies against the retried subject');

      // CMD024-DENY: each with its exact failure reason.
      assert.deepEqual(out.altered, { valid: false, reason: 'PACKAGE_NOT_VERIFIED' });
      assert.equal(out.otherDiffers, true);
      assert.deepEqual(out.otherOwn, { valid: true, reason: 'VALID' }, 'the other subject has its own valid receipt');
      assert.deepEqual(out.wrongSubject, { valid: false, reason: 'RECEIPT_SUBJECT_MISMATCH' });
      for (const f of fields) assert.deepEqual(out.incomplete[f], { valid: false, reason: `RECEIPT_INCOMPLETE:${f}` });
      assert.deepEqual(out.nullReceipt, { valid: false, reason: 'RECEIPT_NULL' });
      assert.deepEqual(out.undefinedReceipt, { valid: false, reason: 'RECEIPT_NULL' });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
