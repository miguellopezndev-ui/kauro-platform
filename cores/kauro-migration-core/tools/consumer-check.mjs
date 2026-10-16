#!/usr/bin/env node
/**
 * The built tarball, consumed by a TypeScript strict project that is not this
 * repository — the seam Intelligence Core will sit on.
 *
 * test/integration/public-consumer.test.ts proves a JavaScript consumer can
 * reach the public entry and run CLEAN_ONLY. This is the rest of what the
 * freeze needs to know before the package is the one IC installs: the type
 * declarations resolve under `strict` and `moduleResolution: node16`; every
 * name IC builds against exists and has the type it needs; the three modes run
 * on small fixtures through the public entry alone, HUBSPOT and SALESFORCE
 * under a target contract the consumer constructed and an attestation it
 * signed with the exported signing bytes; a tampered profile, a foreign
 * candidate set, an incompatible attestation and a plan for another profile
 * are refused. The project has no path to `src/`, no `../kauro-migration-core`,
 * and no credential of any kind.
 *
 *   node tools/consumer-check.mjs --tarball <kauro-migration-core-x.y.z.tgz> --out <report.json>
 *
 * `tsc` is run from this repository's node_modules with `--project` pointing
 * at the temporary project, so the compiler's location is irrelevant to what
 * the consumer can import: module resolution starts at the project.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1] ?? null;
};
const tarball = valueOf('--tarball');
const out = valueOf('--out');
if (tarball === null || out === null || !existsSync(tarball)) {
  process.stderr.write('usage: node tools/consumer-check.mjs --tarball <existing .tgz> --out <report.json>\n');
  process.exit(64);
}

const CONSUMER = String.raw`
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ATTESTATION_ALGORITHM,
  ATTESTATION_CONTRACT_VERSION,
  CANDIDATE_SET_VERSION,
  CANDIDATE_TYPES,
  CONFIG_SCHEMA_VERSION,
  CORE_VERSION,
  IDENTITY_RULE_VERSION,
  MigrationError,
  PACKAGE_FORMAT_VERSION,
  SAFETY_CLASSES,
  SCRATCH_BUDGET_BYTES,
  SEMANTIC_TYPES,
  SOURCE_PROFILE_VERSION,
  TARGET_CONTRACT_VERSION,
  TARGET_PARSER_VERSION,
  TARGET_MODES,
  TRANSFORM_KINDS,
  VALUE_INTENT_KINDS,
  ALL_ADAPTERS,
  getAdapter,
  attestationSigningBytes,
  assertCandidateSetMatches,
  buildCandidateSet,
  createFilesystemScratchStore,
  hashTargetContract,
  intentFor,
  loadCandidateSet,
  loadConfig,
  loadSourceProfile,
  produceSourceProfile,
  promotePackage,
  runMigration,
  serializeCandidateSet,
  serializeSourceProfile,
  verifyAttestation,
  verifyPackage,
  writePackage,
  packagePath,
  TRACEABILITY_AREA,
} from 'kauro-migration-core';
import type {
  AttestationAuthority,
  CandidateSetV1,
  DestinationAdapter,
  HashedCandidateSet,
  HashedSourceProfile,
  HashedTargetContract,
  MigrationConfig,
  RunResult,
  SourceProfileV1,
  TargetAttestation,
  TargetContract,
  TargetMode,
  ValueIntent,
} from 'kauro-migration-core';

type Check = { readonly id: string; readonly ok: boolean; readonly observed: string };
const checks: Check[] = [];
const check = (id: string, ok: boolean, observed: string): void => {
  checks.push({ id, ok, observed });
};
const refused = (id: string, attempt: () => unknown, expectCode?: string): void => {
  try {
    attempt();
    check(id, false, 'ACCEPTED');
  } catch (error) {
    const code = error instanceof MigrationError ? error.code : 'OTHER:' + String(error instanceof Error ? error.message : error).slice(0, 80);
    check(id, expectCode === undefined ? error instanceof MigrationError : code === expectCode, code);
  }
};

const work = process.argv[2] as string;
mkdirSync(work, { recursive: true });
const scratch = (name: string) =>
  createFilesystemScratchStore({ root: join(work, 'scratch-' + name), runId: name, quotaBytes: SCRATCH_BUDGET_BYTES });

// ----------------------------------------------------------- vocabularies
const exportedVersions = [CORE_VERSION, PACKAGE_FORMAT_VERSION, SOURCE_PROFILE_VERSION, CANDIDATE_SET_VERSION, TARGET_CONTRACT_VERSION, ATTESTATION_CONTRACT_VERSION, IDENTITY_RULE_VERSION, CONFIG_SCHEMA_VERSION, TARGET_PARSER_VERSION];
check('versions', CORE_VERSION === process.argv[3] && exportedVersions.every((version) => /^\d+\.\d+\.\d+$/.test(version)), exportedVersions.join('/') + ' (installed ' + String(process.argv[3]) + ')');
check('valueIntents', VALUE_INTENT_KINDS.length === 4 && VALUE_INTENT_KINDS.includes('PRESERVE') && VALUE_INTENT_KINDS.includes('CLEAR'), VALUE_INTENT_KINDS.join(','));
check('transformKinds', TRANSFORM_KINDS.length > 0 && SAFETY_CLASSES.length > 0, TRANSFORM_KINDS.join(',') + ' | ' + SAFETY_CLASSES.join(','));
check('semanticTypes', SEMANTIC_TYPES.includes('EMAIL') && SEMANTIC_TYPES.includes('PHONE'), String(SEMANTIC_TYPES.length) + ' types');
check('candidateTypes', CANDIDATE_TYPES.length === 4, CANDIDATE_TYPES.join(','));
check('targetModes', (TARGET_MODES as readonly TargetMode[]).length === 3, TARGET_MODES.join(','));
const setIntent: ValueIntent = intentFor('SET', 'a', 'b');
check('intentFor', setIntent.kind === 'SET', setIntent.kind);
const adapters: readonly DestinationAdapter[] = ALL_ADAPTERS;
check('supportEnvelope', adapters.length >= 2 && getAdapter('HUBSPOT').mode === 'HUBSPOT', adapters.map((adapter) => adapter.mode).join(','));
check('layout', packagePath('manifest.json').length > 0 && TRACEABILITY_AREA === '03_TRACEABILITY', TRACEABILITY_AREA);

// ------------------------------------------------------------------ fixtures
const input = join(work, 'input');
mkdirSync(input, { recursive: true });
writeFileSync(join(input, 'contacts.csv'), 'Contact ID,First Name,Last Name,Email,Phone\n1,Ada,Lovelace,ada@kauro-consumer.test,+57 300 123 4567\n2,Grace,Hopper,grace@kauro-consumer.test,\n3,Alan,Turing,alan@kauro-consumer.test,+1 415 555 0100\n4,Alan,Turing,ALAN@kauro-consumer.test,\n');
writeFileSync(join(input, 'companies.csv'), 'Company ID,Name,Domain\nC1,Analytical Engines,analytical.test\nC2,COBOL Works,cobol.test\n');

const configFor = (mode: TargetMode): string =>
  JSON.stringify({
    configVersion: CONFIG_SCHEMA_VERSION,
    source: { system: 'consumer', namespace: 'consumer-' + mode.toLowerCase() },
    target: { mode, importMode: 'CREATE_ONLY' },
    files: [
      { id: 'contacts', path: 'contacts.csv', format: 'CSV' },
      { id: 'companies', path: 'companies.csv', format: 'CSV' },
    ],
    records: [
      {
        id: 'companies', fileId: 'companies', object: 'COMPANY',
        sourceRecordIdColumn: { header: 'Company ID' },
        fields: [
          { column: { header: 'Name' }, destinationField: 'company.name', semanticType: 'TEXT' },
          { column: { header: 'Domain' }, destinationField: 'company.website', semanticType: 'URL' },
        ],
      },
      {
        id: 'contacts', fileId: 'contacts', object: 'CONTACT',
        sourceRecordIdColumn: { header: 'Contact ID' },
        fields: [
          { column: { header: 'First Name' }, destinationField: 'contact.firstName', semanticType: 'TEXT' },
          { column: { header: 'Last Name' }, destinationField: 'contact.lastName', semanticType: 'TEXT' },
          { column: { header: 'Email' }, destinationField: 'contact.email', semanticType: 'EMAIL' },
          { column: { header: 'Phone' }, destinationField: 'contact.phone', semanticType: 'PHONE' },
        ],
      },
    ],
  });

// A target contract the consumer constructs for a synthetic instance, hashed
// by the package, and an attestation the consumer signs with the package's
// own signing bytes.
const issuer = generateKeyPairSync('ed25519');
const authority: AttestationAuthority = {
  issuerId: 'consumer:check',
  keyId: 'k1',
  algorithm: ATTESTATION_ALGORITHM,
  publicKeyPem: issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
};
const field = (apiName: string, label: string, type: string, extra: Partial<TargetContract['objects'][number]['fields'][number]> = {}) => ({
  apiName, label, type, createable: 'TRUE' as const, updateable: 'TRUE' as const, nillable: 'TRUE' as const,
  length: 255, precision: null, scale: null, unique: 'FALSE' as const, externalId: 'FALSE' as const, idLookup: 'FALSE' as const,
  calculated: 'FALSE' as const, autoNumber: 'FALSE' as const, defaultedOnCreate: 'FALSE' as const, restrictedPicklist: 'FALSE' as const,
  picklistValues: [], referenceTo: [], relationshipName: null, evidence: 'ARTIFACT' as const, ...extra,
});
const contractFor = (mode: 'HUBSPOT' | 'SALESFORCE'): HashedTargetContract =>
  hashTargetContract({
    contractVersion: TARGET_CONTRACT_VERSION,
    parserVersion: TARGET_PARSER_VERSION,
    capturedAt: '2026-09-01T00:00:00Z',
    instance: { mode, instanceId: mode === 'HUBSPOT' ? '00000001' : '00D000000000001', instanceLabel: 'consumer synthetic ' + mode, evidence: 'ARTIFACT' },
    artifacts: [{ path: 'export/schema.json', sha256: 'a'.repeat(64), byteLength: 4096, kind: 'DESCRIBE' }],
    objects: [
      { apiName: mode === 'HUBSPOT' ? 'contact' : 'Contact', label: 'Contact', createable: 'TRUE', updateable: 'TRUE', recordTypes: [], fields: [
        field(mode === 'HUBSPOT' ? 'email' : 'Email', 'Email', mode === 'HUBSPOT' ? 'string' : 'email', { unique: 'TRUE', idLookup: 'TRUE' }),
        field(mode === 'HUBSPOT' ? 'firstname' : 'FirstName', 'First Name', 'string'),
        field(mode === 'HUBSPOT' ? 'lastname' : 'LastName', 'Last Name', 'string'),
        field(mode === 'HUBSPOT' ? 'phone' : 'Phone', 'Phone', mode === 'HUBSPOT' ? 'string' : 'phone'),
      ] },
      { apiName: mode === 'HUBSPOT' ? 'company' : 'Account', label: 'Company', createable: 'TRUE', updateable: 'TRUE', recordTypes: [], fields: [
        field(mode === 'HUBSPOT' ? 'name' : 'Name', 'Name', 'string'),
        field(mode === 'HUBSPOT' ? 'website' : 'Website', 'Website', 'string'),
      ] },
    ],
    pipelines: [],
  });
const attestationFor = (contract: HashedTargetContract, mode: 'HUBSPOT' | 'SALESFORCE', overrides: Partial<Omit<TargetAttestation, 'signature'>> = {}): TargetAttestation => {
  const body: Omit<TargetAttestation, 'signature'> = {
    attestationVersion: ATTESTATION_CONTRACT_VERSION,
    issuer: { id: 'consumer:check', name: 'Consumer Check', keyId: 'k1' },
    subject: { mode, instanceId: contract.contract.instance.instanceId, instanceLabel: contract.contract.instance.instanceLabel },
    artifacts: [{ path: 'export/schema.json', sha256: 'a'.repeat(64), byteLength: 4096 }],
    contractHash: contract.contractHash,
    schemaVersion: TARGET_CONTRACT_VERSION,
    toolVersion: 'consumer-check/' + CORE_VERSION,
    capturedAt: '2026-09-01T00:00:00Z',
    expiresAt: '2026-12-01T00:00:00Z',
    nonce: null,
    ...overrides,
  };
  const candidate: TargetAttestation = { ...body, signature: { algorithm: ATTESTATION_ALGORITHM, value: '' } };
  const value = signBytes(null, Buffer.from(attestationSigningBytes(candidate), 'utf8'), issuer.privateKey).toString('base64');
  return { ...body, signature: { algorithm: ATTESTATION_ALGORITHM, value } };
};

// ------------------------------------------------------------------- modes
const results: Record<string, { rows: number; equationHolds: boolean; verified: boolean; artifacts: number }> = {};
let firstProfile: HashedSourceProfile | null = null;
let firstCandidates: HashedCandidateSet | null = null;
for (const mode of ['CLEAN_ONLY', 'HUBSPOT', 'SALESFORCE'] as const) {
  const configText = configFor(mode);
  const configPath = join(work, 'config-' + mode + '.json');
  writeFileSync(configPath, configText);
  const loaded = loadConfig(configText, configPath);
  const config: MigrationConfig = loaded.config;
  const profileStore = scratch('profile-' + mode);
  const runStore = scratch('run-' + mode);
  const verifyStore = scratch('verify-' + mode);
  try {
    const profiled: HashedSourceProfile = produceSourceProfile({ inputRoot: input, config, scratch: profileStore });
    const profile: SourceProfileV1 = profiled.profile;
    const candidates: HashedCandidateSet = buildCandidateSet({ profile: profiled, configHash: loaded.configHash });
    const set: CandidateSetV1 = candidates.candidateSet;
    check('candidates.' + mode, set.candidates.length >= 1 && set.candidates.every((candidate) => Array.isArray(candidate.allowedTargetRefs)), String(set.candidates.length) + ' candidates, allowedTargetRefs empty on ' + String(set.candidates.filter((candidate) => candidate.allowedTargetRefs.length === 0).length));
    if (firstProfile === null) {
      firstProfile = profiled;
      firstCandidates = candidates;
    }
    const contract = mode === 'CLEAN_ONLY' ? null : contractFor(mode);
    const attestation = mode === 'CLEAN_ONLY' || contract === null ? null : attestationFor(contract, mode);
    if (contract !== null && attestation !== null) {
      const verification = verifyAttestation({ attestation, publicKeys: [authority], expect: { mode, instanceId: contract.contract.instance.instanceId, contractHash: contract.contractHash, artifacts: attestation.artifacts, at: '2026-09-15T00:00:00Z' } });
      check('attestation.' + mode, verification.ok === true, verification.ok ? 'verified by the package' : verification.reasons.join('; '));
    }
    const run: RunResult = runMigration({
      inputRoot: input,
      config,
      configHash: loaded.configHash,
      scratch: runStore,
      sourceProfile: profiled,
      ...(contract === null ? {} : { targetContract: contract, targetAttestation: attestation, attestationAuthorities: [authority], attestationInstant: '2026-09-15T00:00:00Z' }),
    });
    check('boundProfile.' + mode, run.truth.sourceProfileHash === profiled.profileHash && profile.profileVersion === SOURCE_PROFILE_VERSION, String(run.truth.sourceProfileHash).slice(0, 12));
    const written = writePackage({ result: run, config, normalizedConfig: loaded.normalizedJson, outputDir: join(work, 'package-' + mode), force: true });
    const report = verifyPackage(written.stagingDir, { scratch: verifyStore });
    promotePackage(written, { force: true });
    results[mode] = { rows: run.reconciliation.sourceRows.total, equationHolds: run.reconciliation.sourceRows.equationHolds, verified: report.passed, artifacts: written.artifacts.length };
    // Four contacts and two companies.
    check('run.' + mode, run.reconciliation.sourceRows.total === 6 && run.reconciliation.sourceRows.equationHolds && report.passed, JSON.stringify(results[mode]));
  } finally {
    profileStore.dispose();
    runStore.dispose();
    verifyStore.dispose();
  }
}

// --------------------------------------------------------------- refusals
if (firstProfile !== null && firstCandidates !== null) {
  const profileText = serializeSourceProfile(firstProfile);
  refused('refuses.tamperedProfile', () => loadSourceProfile(profileText.replace(firstProfile!.profileHash, '0'.repeat(63) + '1'), 'p.json'), 'SOURCE_PROFILE_INVALID');
  const setText = serializeCandidateSet(firstCandidates);
  refused('refuses.tamperedCandidateSet', () => loadCandidateSet(setText.replace(firstCandidates!.candidateSetHash, '0'.repeat(63) + '1'), 's.json'), 'CANDIDATE_SET_INVALID');
  refused('refuses.foreignCandidateSet', () => assertCandidateSetMatches(firstCandidates!, { bundleId: 'B-0000000000000000', profileHash: firstProfile!.profileHash }));
  const futureProfileVersion = String(Number(SOURCE_PROFILE_VERSION.split('.')[0]) + 1) + '.0.0';
  refused('refuses.futureVersion', () => loadSourceProfile(profileText.replace('"profileVersion": "' + SOURCE_PROFILE_VERSION + '"', '"profileVersion": "' + futureProfileVersion + '"'), 'p.json'));
  // A plan for another profile: the same input under a configuration the
  // profile was not produced for. The profile is bound to the bundle and the
  // read configuration it described, and a run under a different plan is
  // refused before a row is written.
  const otherInput = join(work, 'other-input');
  mkdirSync(otherInput, { recursive: true });
  writeFileSync(join(otherInput, 'contacts.csv'), 'Contact ID,First Name,Last Name,Email,Phone\n9,Other,Person,other@kauro-consumer.test,\n');
  writeFileSync(join(otherInput, 'companies.csv'), 'Company ID,Name,Domain\nC9,Other Co,other.test\n');
  const otherStore = scratch('other');
  try {
    const first = loadConfig(configFor('CLEAN_ONLY'), join(work, 'config-CLEAN_ONLY.json'));
    refused('refuses.profileForAnotherBundle', () => runMigration({ inputRoot: otherInput, config: first.config, configHash: first.configHash, scratch: otherStore, sourceProfile: firstProfile! }));
  } finally {
    otherStore.dispose();
  }
}
{
  const contract = contractFor('HUBSPOT');
  const stale = attestationFor(contract, 'HUBSPOT', { expiresAt: '2026-09-02T00:00:00Z' });
  const expectFor = (hashed: HashedTargetContract, signed: TargetAttestation, mode: 'HUBSPOT' | 'SALESFORCE') => ({ mode, instanceId: hashed.contract.instance.instanceId, contractHash: hashed.contractHash, artifacts: signed.artifacts, at: '2026-09-15T00:00:00Z' });
  const verification = verifyAttestation({ attestation: stale, publicKeys: [authority], expect: expectFor(contract, stale, 'HUBSPOT') });
  check('refuses.expiredAttestation', verification.ok === false, verification.ok ? 'ACCEPTED' : verification.reasons.join('; ').slice(0, 120));
  const impostor = generateKeyPairSync('ed25519');
  const forged = { ...attestationFor(contract, 'HUBSPOT'), signature: { algorithm: ATTESTATION_ALGORITHM, value: signBytes(null, Buffer.from(attestationSigningBytes({ ...attestationFor(contract, 'HUBSPOT'), signature: { algorithm: ATTESTATION_ALGORITHM, value: '' } }), 'utf8'), impostor.privateKey).toString('base64') } };
  const forgedVerification = verifyAttestation({ attestation: forged, publicKeys: [authority], expect: expectFor(contract, forged, 'HUBSPOT') });
  check('refuses.forgedAttestation', forgedVerification.ok === false, forgedVerification.ok ? 'ACCEPTED' : 'refused');
  const otherContract = contractFor('SALESFORCE');
  const hubspotAttestation = attestationFor(contract, 'HUBSPOT');
  const crossed = verifyAttestation({ attestation: hubspotAttestation, publicKeys: [authority], expect: expectFor(otherContract, hubspotAttestation, 'SALESFORCE') });
  check('refuses.attestationForAnotherContract', crossed.ok === false, crossed.ok ? 'ACCEPTED' : 'refused');
}

process.stdout.write(JSON.stringify({ checks, results }));
`;

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const work = join(tmpdir(), `kauro-consumer-check-${String(process.pid)}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const project = join(work, 'project');
mkdirSync(project, { recursive: true });
const shell = process.platform === 'win32';
const report = { artifactKind: 'MIGRATION_CORE_CONSUMER_CHECK', tarball: resolve(tarball), tarballSha256: sha256(readFileSync(tarball)), writtenAt: `${new Date().toISOString().slice(0, 19)}Z`, steps: [], checks: [], results: null, problems: [], ok: false };
/** Every file under `directory`, by path relative to it, with its length and digest. */
function inventoryOf(directory) {
  const found = [];
  const walk = (relative) => {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else {
        const bytes = readFileSync(join(directory, path));
        found.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
  };
  walk('');
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
const step = (id, command, commandArgs, options = {}) => {
  // A shell only for npm, which is a .cmd on Windows; node's own path has a
  // space in it and a shell would split it.
  const result = spawnSync(command, commandArgs, { cwd: project, encoding: 'utf8', shell: shell && command === 'npm', maxBuffer: 64 * 1024 * 1024, ...options });
  report.steps.push({ id, exit: result.status, stderrTail: (result.stderr ?? '').trim().split('\n').slice(-5).join('\n') });
  return result;
};
try {
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'kauro-consumer-check', private: true, type: 'module' }, null, 2));
  writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'Node16', moduleResolution: 'Node16', types: ['node'], noEmitOnError: true, outDir: 'out', exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, skipLibCheck: false }, files: ['consumer.ts'] }, null, 2));
  writeFileSync(join(project, 'consumer.ts'), CONSUMER);
  // Installed from the tarball's bytes, with no path to this repository: the
  // project's node_modules holds the package and its two runtime dependencies.
  const installed = step('install', 'npm', ['install', '--silent', '--no-audit', '--no-fund', '--ignore-scripts', resolve(tarball)]);
  if (installed.status !== 0) throw new Error(`npm install exited ${String(installed.status)}`);
  const { version: installedVersion } = JSON.parse(readFileSync(join(project, 'node_modules', 'kauro-migration-core', 'package.json'), 'utf8'));
  if (!existsSync(join(project, 'node_modules', 'kauro-migration-core', 'dist', 'src', 'index.d.ts'))) throw new Error('the installed package carries no dist/src/index.d.ts');
  // What npm actually laid down, file by file, so tools/published-asset-check.mjs
  // can compare the installation with the tarball's own entries.
  report.installed = { root: 'node_modules/kauro-migration-core', files: inventoryOf(join(project, 'node_modules', 'kauro-migration-core')) };
  // @types/node for the consumer's node: imports; taken from this repository's
  // node_modules by copy, not by path, so nothing in the project points here.
  const typesNode = join(repoRoot, 'node_modules', '@types', 'node');
  if (!existsSync(typesNode)) throw new Error('@types/node is not available to copy');
  mkdirSync(join(project, 'node_modules', '@types'), { recursive: true });
  spawnSync(process.platform === 'win32' ? 'robocopy' : 'cp', process.platform === 'win32' ? [typesNode, join(project, 'node_modules', '@types', 'node'), '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'] : ['-r', typesNode, join(project, 'node_modules', '@types', 'node')], { encoding: 'utf8' });
  const undici = join(repoRoot, 'node_modules', 'undici-types');
  if (existsSync(undici)) spawnSync(process.platform === 'win32' ? 'robocopy' : 'cp', process.platform === 'win32' ? [undici, join(project, 'node_modules', 'undici-types'), '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'] : ['-r', undici, join(project, 'node_modules', 'undici-types')], { encoding: 'utf8' });
  const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  const compiled = step('tsc', process.execPath, [tsc, '--project', join(project, 'tsconfig.json')]);
  if (compiled.status !== 0) throw new Error(`tsc exited ${String(compiled.status)}: ${(compiled.stdout || compiled.stderr).trim().split('\n').slice(0, 12).join('\n')}`);
  const ran = step('run', process.execPath, [join(project, 'out', 'consumer.js'), join(work, 'run'), installedVersion]);
  if (ran.status !== 0) throw new Error(`the consumer exited ${String(ran.status)}: ${ran.stderr.trim().split('\n').slice(-6).join('\n')}`);
  const output = JSON.parse(ran.stdout);
  report.checks = output.checks;
  report.results = output.results;
  const failed = output.checks.filter((entry) => entry.ok !== true);
  if (failed.length > 0) report.problems.push(...failed.map((entry) => `${entry.id}: ${entry.observed}`));
  for (const mode of ['CLEAN_ONLY', 'HUBSPOT', 'SALESFORCE']) if (output.results?.[mode] === undefined) report.problems.push(`${mode} did not run`);
  report.ok = report.problems.length === 0;
} catch (error) {
  report.problems.push(String(error.message));
  report.ok = false;
} finally {
  if (process.env.KAURO_CONSUMER_KEEP === '1' && !report.ok) process.stderr.write(`kept ${work}
`);
  else rmSync(work, { recursive: true, force: true });
}
mkdirSync(dirname(resolve(out)), { recursive: true });
writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${report.ok ? 'CONSUMER-CHECK = PASS' : 'CONSUMER-CHECK = FALSE'}: ${String(report.checks.length)} checks; ${report.problems.join('; ') || 'no problems'}\n`);
process.exit(report.ok ? 0 : 1);
