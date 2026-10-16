#!/usr/bin/env node
/**
 * RELEASE-DOSSIER-01: the dossier verifier refuses every way a release can
 * fail to be this candidate's, and accepts the one way it can be.
 *
 * A synthetic candidate — a small commit's worth of files, the package it
 * would pack, the records its gates would write — a synthetic dossier built
 * the way the real one is, a reconstruction of that commit as the verifier
 * would rebuild it, and a GitHub served from memory. Each case changes one
 * thing and the verifier must name it; the positive case must come back
 * clean. The freeze verdict calls the same function with the real transport,
 * so what is proved here is what the verdict does.
 *
 * No network, no token, no tree measured: the facts are fixtures. The rules
 * about the *real* tree — that the checkout is clean, that the digests
 * reproduce, that the commit rebuilds — are the verdict's other conditions,
 * EVIDENCE-RULES-01's, and `reconstructCandidate` over a real checkout.
 *
 * After the MC-07 audit finding (KAURO_AUDITORIA_MC_IC_20260911_V1 §4): the
 * verifier accepted a different executable with the right name and version,
 * a source archive that was not a tar, an evidence archive that was not a
 * tar, a preflight with a critical fact FALSE under an outer TRUE, and a
 * provenance record that was JSON null. Each is a case below, with the
 * forgeries beside it: a tampered archive entry, an extra and a missing
 * entry, an asset from another version, a delivery manifest listing a name
 * twice, a truncated record.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { EXCLUDED_DIRECTORIES, EXCLUDED_PATHS, EXCLUSION_RULE_VERSION, DIGEST_SERIALISATION_VERSION, MANIFEST_SCHEMA_VERSION, PROVENANCE_SCHEMA_VERSION, codeRecords, digestRecords } from './candidate-provenance.mjs';
import { RECEIPT_ARTIFACT_KIND, RECEIPT_SCHEMA_VERSION, buildReceipt, readWorkflow, receiptObservationProblems, receiptShapeProblems, requiredJobLegs } from './receipt-verify.mjs';
import * as chain from './chain.mjs';
import { pathToFileURL } from 'node:url';
import { chainIdentityCases } from './chain-identity-selftest.mjs';
import { UNIVERSE_SCHEMA_VERSION, UNIVERSE_STEP_IDS } from './universe-inventory.mjs';
import { CAMPAIGN_VERSION } from '../qualification/campaign.mjs';
import {
  DOSSIER_INVENTORY_VERSION,
  DOSSIER_MANIFEST_NAME,
  PREFLIGHT_FACT_NAMES,
  PREFLIGHT_SCHEMA_VERSION,
  RELEASE_PROVENANCE_VERSION,
  SUMS_NAME,
  archiveInventory,
  buildDossierManifest,
  candidateRecordProblems,
  derivePreflightFlag,
  dossierInventory,
  dossierProblems,
  parseSums,
  readTarEntries,
  sha256,
  verifyPublishedRelease,
} from './release-dossier.mjs';
import * as releaseDossier from './release-dossier.mjs';
import { versions } from './candidate-provenance.mjs';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const TAG = `v${versions.coreVersion}`;
const REPOSITORY = 'owner/kauro-migration-core';
const CORE_VERSION = versions.coreVersion;
// The receipt job's own check run, by the name the workflow gives it, resolved
// the way tools/receipt-verify.mjs resolves it.
const RECEIPT_JOB_NAME = readWorkflow().receiptJobName;

// ------------------------------------------------------- synthetic commit

/** The files of the synthetic commit; what `git archive` would give the verifier. */
const COMMIT_FILES = Object.freeze({
  'package.json': `${JSON.stringify({ name: 'kauro-migration-core', version: CORE_VERSION })}\n`,
  'package-lock.json': '{}\n',
  'tsconfig.json': '{}\n',
  'src/index.ts': 'export {};\n',
  'README.md': '# core\n',
  'qualification/evidence/x.json': '{}\n',
  'qualification/capacity/c.json': '{"result":"PASS"}\n',
  'qualification/candidate/campaign.json': '{}\n',
});
/** What the commit packs: the entries of the candidate's own tarball. */
const PACKAGE_FILES = Object.freeze({
  'package/package.json': COMMIT_FILES['package.json'],
  'package/dist/src/index.js': 'export {};\n',
  'package/dist/src/index.d.ts': 'export {};\n',
});
const inventoryOf = (files) =>
  Object.entries(files)
    .map(([path, content]) => ({ path, bytes: Buffer.byteLength(content), sha256: sha256(Buffer.from(content, 'utf8')) }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
const excluded = (path) => EXCLUDED_PATHS.includes(path) || EXCLUDED_DIRECTORIES.some((dir) => path.startsWith(`${dir}/`));
const TABLE = inventoryOf(COMMIT_FILES).filter((entry) => !excluded(entry.path));
const CODE_DIGEST = digestRecords('code', codeRecords(TABLE));
const MANIFEST_DIGEST = digestRecords('manifest', TABLE);

/** The reconstruction of the synthetic commit, as reconstructCandidate would return it. */
const RECONSTRUCTION = Object.freeze({
  sha: SHA,
  package: inventoryOf(PACKAGE_FILES),
  source: inventoryOf(COMMIT_FILES),
  evidence: inventoryOf(COMMIT_FILES).filter((entry) => entry.path.startsWith('qualification/evidence/') || entry.path.startsWith('qualification/capacity/')),
  problems: [],
  notes: [],
});

const FACTS = Object.freeze({
  repository: REPOSITORY,
  sha: SHA,
  gitTree: 'c'.repeat(40),
  tag: TAG,
  coreVersion: CORE_VERSION,
  packageFormatVersion: '2.0.0',
  codeDigest: CODE_DIGEST,
  manifestDigest: MANIFEST_DIGEST,
  subjectDigest: 'f'.repeat(64),
  campaignId: 'c_0123456789abcdef',
  producers: { 'tools/capacity.mjs': '1'.repeat(64), 'tools/universe.mjs': '2'.repeat(64) },
  receiptJobName: RECEIPT_JOB_NAME,
  requiredCheckNames: ['gate (ubuntu-latest)'],
  reconstruction: RECONSTRUCTION,
});

// ------------------------------------------------------------ synthetic tar

function tarOf(members) {
  const blocks = [];
  for (const [name, content] of Object.entries(members)) {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'utf8');
    header.write('0000000\0', 108, 8, 'utf8');
    header.write('0000000\0', 116, 8, 'utf8');
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
    header.write('00000000000\0', 136, 12, 'utf8');
    header.write('        ', 148, 8, 'utf8');
    header.write('0', 156, 1, 'utf8');
    header.write('ustar\0', 257, 6, 'utf8');
    header.write('00', 263, 2, 'utf8');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

const packageTgz = (version = CORE_VERSION, withEntry = true) =>
  tarOf({
    'package/package.json': version === CORE_VERSION ? PACKAGE_FILES['package/package.json'] : JSON.stringify({ name: 'kauro-migration-core', version }),
    ...(withEntry ? { 'package/dist/src/index.js': PACKAGE_FILES['package/dist/src/index.js'], 'package/dist/src/index.d.ts': PACKAGE_FILES['package/dist/src/index.d.ts'] } : {}),
  });
const sourceTgz = (sha = SHA, files = COMMIT_FILES) => tarOf(Object.fromEntries(Object.entries(files).map(([path, content]) => [`kauro-migration-core-${sha}/${path}`, content])));
const evidenceTgz = (files = { 'qualification/evidence/x.json': COMMIT_FILES['qualification/evidence/x.json'], 'qualification/capacity/c.json': COMMIT_FILES['qualification/capacity/c.json'] }) => tarOf(files);

// --------------------------------------------------------- synthetic records

const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

/** The records the candidate's own gates would write for `facts`, in their real shapes. */
function records(facts) {
  const versions = { coreVersion: facts.coreVersion, packageFormatVersion: facts.packageFormatVersion, sourceRegistryVersion: '2026-09-06', packageVersion: facts.coreVersion };
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    artifactKind: 'MIGRATION_CORE_CANDIDATE_MANIFEST',
    codeDigest: facts.codeDigest,
    codeFileCount: codeRecords(TABLE).length,
    digestSerialisationVersion: DIGEST_SERIALISATION_VERSION,
    exclusionRuleVersion: EXCLUSION_RULE_VERSION,
    exclusion: { directories: [...EXCLUDED_DIRECTORIES], paths: [...EXCLUDED_PATHS] },
    digestOver: 'kauro-candidate-digest/2.0.0',
    fileCount: TABLE.length,
    totalBytes: TABLE.reduce((sum, entry) => sum + entry.bytes, 0),
    manifestDigest: facts.manifestDigest,
    files: TABLE.map((entry) => ({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes })),
  };
  const provenance = {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    artifactKind: 'MIGRATION_CORE_CANDIDATE_PROVENANCE',
    generator: 'tools/candidate-provenance.mjs',
    coreVersion: facts.coreVersion,
    packageVersion: facts.coreVersion,
    packageFormatVersion: facts.packageFormatVersion,
    sourceRegistryVersion: '2026-09-06',
    manifestDigest: facts.manifestDigest,
    codeDigest: facts.codeDigest,
    manifestFileCount: TABLE.length,
    digestSerialisationVersion: DIGEST_SERIALISATION_VERSION,
    exclusionRuleVersion: EXCLUSION_RULE_VERSION,
    dependencies: { runtime: {}, development: {}, lockfileSha256: sha256(Buffer.from(COMMIT_FILES['package-lock.json'])) },
    authorities: ['KAURO_PRODUCT_CONSTITUTION_V1'],
    researchSnapshot: { sourceRegistryVersion: '2026-09-06' },
    capacityEvidence: [],
    vendorEvidence: [],
    knownExclusions: [],
    freezeDecision: { decidedBy: 'tools/freeze-verdict.mjs', outsideTree: true },
  };
  const preflight = {
    schemaVersion: PREFLIGHT_SCHEMA_VERSION,
    artifactKind: 'MIGRATION_CORE_CANDIDATE_PREFLIGHT',
    gate: 'RELEASE-CANDIDATE-01',
    digestSerialisationVersion: DIGEST_SERIALISATION_VERSION,
    manifestDigest: facts.manifestDigest,
    codeDigest: facts.codeDigest,
    versions,
    treeClean: true,
    treeCleanExcludes: ['qualification/candidate/preflight.json'],
    decidedElsewhere: [{ fact: 'cross_platform_reproducibility_passed', by: 'tools/receipt-verify.mjs, from a receipt written outside this tree' }],
    facts: Object.fromEntries(PREFLIGHT_FACT_NAMES.map((name) => [name, { value: true, by: 'EXECUTED' }])),
    MIGRATION_CORE_CANDIDATE_PREFLIGHT: 'TRUE',
  };
  const universe = {
    schemaVersion: UNIVERSE_SCHEMA_VERSION,
    gate: 'OFFLINE-UNIVERSE',
    scope: 'FULL',
    platform: 'synthetic',
    node: process.version,
    candidate: { manifestDigest: facts.manifestDigest, codeDigest: facts.codeDigest, codeFileCount: codeRecords(TABLE).length, fileCount: TABLE.length, digestSerialisationVersion: DIGEST_SERIALISATION_VERSION, exclusionRuleVersion: EXCLUSION_RULE_VERSION },
    steps: UNIVERSE_STEP_IDS.map((id) => ({ id, label: id, ok: true, status: 'ok', skipped: false, exitStatus: 0, signal: null, spawnProblem: null, detail: '', durationMs: 1, logPath: `universe-logs/${id}.log`, outputSha256: sha256(Buffer.from(id)), outputBytes: 0, outputLines: 1 })),
    passed: true,
  };
  const campaign = {
    campaignVersion: CAMPAIGN_VERSION,
    artifactKind: 'MIGRATION_CORE_CAMPAIGN',
    campaignId: facts.campaignId,
    sealedAt: '2026-09-11T00:00:00Z',
    subjectDigest: facts.subjectDigest,
    subjectVersion: '1.0.0',
    codeDigest: facts.codeDigest,
    versions: { ...versions, configSchemaVersion: '2.0.0' },
    classes: {},
    dependencies: {},
    producers: Object.fromEntries(Object.entries(facts.producers).map(([producer, fingerprint]) => [producer, { fingerprint, files: 1, kind: 'CAPACITY' }])),
    note: 'synthetic',
  };
  const releaseProvenance = {
    artifactKind: 'MIGRATION_CORE_PROVENANCE',
    provenanceVersion: RELEASE_PROVENANCE_VERSION,
    coreVersion: facts.coreVersion,
    packageVersion: facts.coreVersion,
    packageFormatVersion: facts.packageFormatVersion,
    sourceRegistryVersion: '2026-09-06',
    campaign: { campaignId: facts.campaignId, sealedAt: '2026-09-11T00:00:00Z', subjectDigest: facts.subjectDigest },
    freezeDecision: { decidedBy: 'tools/freeze-verdict.mjs', outsideTree: true },
    gatesAllPass: true,
    supportEnvelope: {},
    resourceContract: {},
    capacity: [],
    gates: [{ gate: 'CORE-CONSTITUTION-01', state: 'PASS', establishedBy: 'synthetic', observedAt: null, evidence: 'universe.json#constitution' }],
    evidence: [{ path: 'qualification/evidence/x.json', required: true, present: true, sha256: sha256(Buffer.from('{}\n')), claim: 'synthetic' }],
    inventoryProblems: [],
    doesNotClaim: [],
  };
  const sbom = { bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: 'urn:uuid:00000000-0000-0000-0000-000000000000', version: 1, metadata: { component: { type: 'library', name: 'kauro-migration-core', version: facts.coreVersion } }, components: [], dependencies: [] };
  return { manifest, provenance, preflight, universe, campaign, releaseProvenance, sbom };
}

/** The receipt CI would emit for `facts`, in its real shape. */
function receiptFor(facts = FACTS, overrides = {}) {
  return json({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    artifactKind: RECEIPT_ARTIFACT_KIND,
    generator: 'tools/receipt-verify.mjs --emit',
    repository: facts.repository,
    sha: facts.sha,
    gitTree: facts.gitTree,
    ref: 'refs/heads/main',
    branch: 'main',
    eventName: 'push',
    workflow: 'core gate',
    runId: '1',
    runNumber: '1',
    runAttempt: '1',
    manifestDigest: facts.manifestDigest,
    codeDigest: facts.codeDigest,
    digestSerialisationVersion: DIGEST_SERIALISATION_VERSION,
    exclusionRuleVersion: EXCLUSION_RULE_VERSION,
    versions: { coreVersion: facts.coreVersion, packageFormatVersion: facts.packageFormatVersion, sourceRegistryVersion: '2026-09-06', packageVersion: facts.coreVersion },
    node: process.version,
    runnerOs: 'Linux',
    requiredJobs: [{ name: 'gate', result: 'success' }],
    checkRuns: [{ checkRunId: 1, name: 'gate (ubuntu-latest)', conclusion: 'success', headSha: facts.sha, startedAt: null, completedAt: null, app: 'github-actions', checkSuiteId: 1 }],
    reruns: [],
    ...overrides,
  });
}
const receiptBytes = receiptFor();

// --------------------------------------------------------- synthetic dossier

/**
 * The dossier as tools/release-dossier.mjs --build writes it, in memory.
 * `mutate` edits the raw assets before the delivery manifest and the sums are
 * written over them, so a mutation there is "a dossier honestly built over
 * the wrong thing"; `after` edits the finished dossier, so a mutation there
 * is "a dossier tampered with after it was sealed".
 */
function dossier({ facts = FACTS, mutate = () => {}, after = () => {}, receipt = receiptBytes } = {}) {
  const inventory = dossierInventory({ coreVersion: facts.coreVersion, sha: facts.sha });
  const made = records(facts);
  const raw = new Map([
    [`kauro-migration-core-${facts.coreVersion}.tgz`, packageTgz(facts.coreVersion)],
    [`source-${facts.sha}.tar.gz`, sourceTgz(facts.sha)],
    ['sbom.cdx.json', json(made.sbom)],
    ['manifest.json', json(made.manifest)],
    ['provenance.json', json(made.provenance)],
    ['preflight.json', json(made.preflight)],
    ['universe.json', json(made.universe)],
    ['campaign.json', json(made.campaign)],
    ['migration-core-provenance.json', json(made.releaseProvenance)],
    ['ci-receipt.json', receipt],
    ['evidence.tar.gz', evidenceTgz()],
  ]);
  mutate(raw);
  const assets = [...raw.entries()].map(([name, bytes]) => ({ name, role: inventory.find((entry) => entry.name === name)?.role ?? 'UNKNOWN', bytes: bytes.length, sha256: sha256(bytes) }));
  const manifest = buildDossierManifest({ ...facts, assets, builtAt: '2026-09-11T00:00:00Z' });
  raw.set(DOSSIER_MANIFEST_NAME, json(manifest));
  raw.set(SUMS_NAME, sumsOf(raw));
  after(raw);
  return raw;
}

/** SHA256SUMS over every asset but itself, as the builder writes it. */
function sumsOf(raw) {
  return Buffer.from(
    [...raw.entries()]
      .filter(([name]) => name !== SUMS_NAME)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`)
      .join(''),
    'utf8',
  );
}

/** A record of the finished dossier, edited, and the manifest and sums rewritten to match: a forgery with every declared sum correct. */
function reseal(raw, edit) {
  edit(raw);
  const manifest = JSON.parse(raw.get(DOSSIER_MANIFEST_NAME).toString('utf8'));
  manifest.assets = manifest.assets.map((entry) => (raw.has(entry.name) ? { ...entry, bytes: raw.get(entry.name).length, sha256: sha256(raw.get(entry.name)) } : entry));
  raw.set(DOSSIER_MANIFEST_NAME, json(manifest));
  raw.set(SUMS_NAME, sumsOf(raw));
}

/** GitHub, from memory. `release` overrides fields; `failOn` makes one asset's download throw. */
function fakeGithub(assets, { release = {}, failOn = null, inlineCount = null } = {}) {
  const list = [...assets.entries()].map(([name, bytes], index) => ({ id: index + 1, name, size: bytes.length }));
  const body = { id: 77, tag_name: TAG, draft: false, prerelease: false, immutable: true, assets: inlineCount === null ? list : list.slice(0, inlineCount), ...release };
  const respond = (value) => ({ json: async () => value, text: async () => JSON.stringify(value), arrayBuffer: async () => value });
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path === `/repos/${REPOSITORY}/releases/tags/${encodeURIComponent(TAG)}`) return respond(body);
    const page = /\/releases\/77\/assets\?per_page=(\d+)&page=(\d+)$/u.exec(path);
    if (page !== null) {
      const per = Number(page[1]);
      const at = Number(page[2]);
      return respond(list.slice((at - 1) * per, at * per));
    }
    const asset = /\/releases\/assets\/(\d+)$/u.exec(path);
    if (asset !== null) {
      const entry = list[Number(asset[1]) - 1];
      if (entry === undefined) throw new Error(`GET ${path} returned 404 Not Found`);
      if (entry.name === failOn) throw new Error(`GET ${path} returned 502 Bad Gateway`);
      const bytes = assets.get(entry.name);
      return respond(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    }
    throw new Error(`GET ${path} returned 404 Not Found`);
  };
  return { api, calls };
}

async function verify(assets, options = {}, { receipt = receiptBytes, allowDraft = false, facts = FACTS } = {}) {
  const { api } = fakeGithub(assets, options);
  return verifyPublishedRelease({ api, repository: REPOSITORY, tagName: TAG, expectedSha: SHA, facts, receiptSha256: sha256(receipt), allowDraft });
}

// ------------------------------------------------------------------- cases

const cases = [];
const record = (id, ok, expected, observed) => cases.push({ id, ok, expected, observed });

/** A negative: the release must be refused, and the refusal must mention `mentions`. */
async function refuses(id, expected, run, mentions, { publishedToo = false } = {}) {
  const result = await run();
  const text = `${result.published.observed} ${result.assets.observed} ${(result.problems?.assets ?? []).join(' ')} ${(result.problems?.published ?? []).join(' ')}`;
  const refused = publishedToo ? result.published.value === false : result.assets.value === false;
  const named = mentions === null || text.includes(mentions);
  record(id, refused && named, expected, refused ? (named ? `refused: ${text.slice(0, 160)}` : `refused, but without naming "${mentions}": ${text.slice(0, 160)}`) : `ACCEPTED: ${text.slice(0, 160)}`);
}

{
  const result = await verify(dossier());
  record('dossier.positive', result.published.value && result.assets.value && result.draft === false, 'a published, immutable release carrying exactly this candidate\'s dossier is accepted on both conditions', `${result.published.observed} | ${result.assets.observed}`);
}
await refuses('dossier.foreignWithCorrectSums', 'a dossier built honestly over another commit, sums correct, is refused', () => verify(dossier({ facts: { ...FACTS, sha: OTHER_SHA, codeDigest: '9'.repeat(64) } })), 'code digest');
await refuses('dossier.foreignReceipt', 'a receipt for another commit is refused even though the sums cover it', () => verify(dossier({ receipt: receiptFor({ ...FACTS, sha: OTHER_SHA }) })), 'ci-receipt.json attests');
await refuses('dossier.receiptNotTheOneHanded', 'a receipt that is not byte-identical to the one the verdict was given is refused', () => verify(dossier(), {}, { receipt: receiptFor(FACTS, { runId: '2' }) }), 'byte-identical');
await refuses('dossier.oldManifest', 'a candidate manifest from an earlier tree is refused', () => verify(dossier({ mutate: (raw) => raw.set('manifest.json', json({ codeDigest: '3'.repeat(64), manifestDigest: FACTS.manifestDigest })) })), 'manifest.json is for code digest');
await refuses('dossier.tamperedPackageSumsUpdated', 'a package replaced after the delivery manifest was written is refused even when the sums were rewritten to match', () =>
  verify(
    dossier({
      after: (raw) => {
        raw.set(`kauro-migration-core-${FACTS.coreVersion}.tgz`, packageTgz('2.0.1', false));
        const sums = [...raw.entries()].filter(([name]) => name !== SUMS_NAME).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`).join('');
        raw.set(SUMS_NAME, Buffer.from(sums, 'utf8'));
      },
    }),
  ), 'hashes differently');
await refuses('dossier.tamperedPackageSumsStale', 'a package changed after the sums were written is refused by the sums', () => verify(dossier({ after: (raw) => raw.set(`kauro-migration-core-${FACTS.coreVersion}.tgz`, packageTgz('2.0.1', false)) })), 'SHA256SUMS says');
await refuses('dossier.wrongPackageVersion', 'a package tarball of another version is refused', () => verify(dossier({ mutate: (raw) => raw.set(`kauro-migration-core-${FACTS.coreVersion}.tgz`, packageTgz('2.0.0')) })), 'version 2.0.0');
await refuses('dossier.packageWithoutEntry', 'a package tarball without dist/src/index.js is refused', () => verify(dossier({ mutate: (raw) => raw.set(`kauro-migration-core-${FACTS.coreVersion}.tgz`, packageTgz('2.0.1', false)) })), 'dist/src/index.js');
await refuses('dossier.missingAsset', 'a release missing one inventory asset is refused', () => verify(dossier({ after: (raw) => raw.delete('universe.json') })), 'universe.json is missing');
await refuses('dossier.extraAssetWithCorrectSum', 'an asset outside the inventory is refused even when the sums name it', () =>
  verify(
    dossier({
      after: (raw) => {
        const extra = Buffer.from('not part of any candidate\n');
        raw.set('unrelated.txt', extra);
        raw.set(SUMS_NAME, Buffer.concat([raw.get(SUMS_NAME), Buffer.from(`${sha256(extra)}  unrelated.txt\n`)]));
      },
    }),
  ), 'not in the dossier inventory');
await refuses('dossier.duplicateNames', 'two assets with the same name are refused', async () => {
  const assets = dossier();
  const { api: inner } = fakeGithub(assets);
  const dup = { id: 99, name: 'preflight.json', size: assets.get('preflight.json').length };
  const api = async (path) => {
    if (path.endsWith(`/releases/tags/${TAG}`)) {
      const release = await (await inner(path)).json();
      return { json: async () => ({ ...release, assets: [...release.assets, dup] }) };
    }
    if (/\/assets\?per_page=/u.test(path)) {
      const list = await (await inner(path)).json();
      return { json: async () => [...list, dup] };
    }
    if (path.endsWith('/assets/99')) return inner(path.replace('/99', `/${String([...assets.keys()].indexOf('preflight.json') + 1)}`));
    return inner(path);
  };
  return verifyPublishedRelease({ api, repository: REPOSITORY, tagName: TAG, expectedSha: SHA, facts: FACTS, receiptSha256: sha256(receiptBytes) });
}, 'more than once');
await refuses('dossier.downloadError', 'a failed download refuses both conditions rather than skipping the asset', () => verify(dossier(), { failOn: 'campaign.json' }), '502', { publishedToo: true });
await refuses('dossier.paginationDisagrees', 'a release object listing fewer assets than the paginated list is refused', () => verify(dossier(), { inlineCount: 3 }), 'paginated list');
await refuses('dossier.mutable', 'immutable:false is refused on the published condition', () => verify(dossier(), { release: { immutable: false } }), 'not immutable', { publishedToo: true });
await refuses('dossier.immutabilityNotReported', 'a release object without an immutable field is not verified, so refused', () => verify(dossier(), { release: { immutable: undefined } }), 'not verified', { publishedToo: true });
await refuses('dossier.wrongTag', 'a release on another tag is refused', () => verify(dossier(), { release: { tag_name: 'v2.0.0' } }), `not ${TAG}`, { publishedToo: true });
await refuses('dossier.draftIsNotPublished', 'a draft is refused on the published condition', () => verify(dossier(), { release: { draft: true } }), 'draft', { publishedToo: true });
{
  const result = await verify(dossier(), { release: { draft: true } }, { allowDraft: true });
  record('dossier.draftReadyIsNotFrozen', result.draftReady === true && result.published.value === false && result.assets.value === true, 'a draft with a complete dossier is draft_ready and still not published', `draftReady=${String(result.draftReady)} published=${String(result.published.value)} assets=${String(result.assets.value)}`);
}
await refuses('dossier.campaignMismatch', 'a campaign.json for another campaign is refused', () => verify(dossier({ mutate: (raw) => raw.set('campaign.json', json({ campaignId: 'c_fedcba9876543210' })) })), 'campaign.json is campaign');
await refuses('dossier.producerMoved', 'a delivery manifest recording a producer fingerprint the candidate does not measure is refused', () => verify(dossier(), {}, { facts: { ...FACTS, producers: { ...FACTS.producers, 'tools/capacity.mjs': '4'.repeat(64) } } }), 'records tools/capacity.mjs');
await refuses('dossier.manifestListsItself', 'a delivery manifest that lists itself is refused', () =>
  verify(
    dossier({
      after: (raw) => {
        const manifest = JSON.parse(raw.get(DOSSIER_MANIFEST_NAME).toString('utf8'));
        manifest.assets.push({ name: DOSSIER_MANIFEST_NAME, role: 'DELIVERY_MANIFEST', bytes: 1, sha256: '0'.repeat(64) });
        raw.set(DOSSIER_MANIFEST_NAME, json(manifest));
        const sums = [...raw.entries()].filter(([name]) => name !== SUMS_NAME).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`).join('');
        raw.set(SUMS_NAME, Buffer.from(sums, 'utf8'));
      },
    }),
  ), 'which it must not');
await refuses('dossier.universeFailed', 'a universe report that did not pass is refused', () => verify(dossier({ mutate: (raw) => raw.set('universe.json', json({ candidate: { codeDigest: FACTS.codeDigest }, passed: false })) })), 'did not pass');
await refuses('dossier.releaseUnreadable', 'an unreadable release refuses both conditions', async () => verifyPublishedRelease({ api: async () => { throw new Error('GET returned 500'); }, repository: REPOSITORY, tagName: TAG, expectedSha: SHA, facts: FACTS, receiptSha256: null }), 'could not be read', { publishedToo: true });

// ------------------------------------------------- MC-07: the audit's forgeries

// The five variants the audit's probe (probe-mc-dossier.mjs) showed accepted,
// built the same way: honestly sealed over the forged asset, sums correct.
await refuses('mc07.differentExecutableSameVersion', 'a package tarball with the right name and version and other code inside is refused against the reconstruction of the commit', () =>
  verify(dossier({ mutate: (raw) => raw.set(`kauro-migration-core-${CORE_VERSION}.tgz`, tarOf({ 'package/package.json': PACKAGE_FILES['package/package.json'], 'package/dist/src/index.js': 'export const auditSentinel = "THIS IS NOT MIGRATION CORE";\n', 'package/dist/src/index.d.ts': 'export declare const auditSentinel: string;\n' })) })), 'differs from the reconstruction of the commit');
await refuses('mc07.sourceNotATar', 'a source archive that is not even gzip is refused', () => verify(dossier({ mutate: (raw) => raw.set(`source-${SHA}.tar.gz`, Buffer.from('unrelated source, not even gzip')) })), 'is not gzip');
await refuses('mc07.evidenceNotATar', 'an evidence archive that is not even gzip is refused', () => verify(dossier({ mutate: (raw) => raw.set('evidence.tar.gz', Buffer.from('unrelated evidence, not even gzip')) })), 'is not gzip');
await refuses('mc07.preflightFalseFactUnderTrue', 'a preflight whose facts contain FALSE cannot carry TRUE', () =>
  verify(dossier({ mutate: (raw) => raw.set('preflight.json', json({ ...records(FACTS).preflight, facts: { ...records(FACTS).preflight.facts, memory_budget_passed: { value: false, by: 'MEASURED' } } })) })), 'its facts derive FALSE');
await refuses('mc07.nullProvenance', 'a provenance record that is JSON null is refused', () => verify(dossier({ mutate: (raw) => raw.set('provenance.json', Buffer.from('null\n')) })), 'provenance.json is JSON null');
await refuses('mc07.wrongPackageVersionControl', 'the audit control: a package of another version is still refused', () => verify(dossier({ mutate: (raw) => raw.set(`kauro-migration-core-${CORE_VERSION}.tgz`, packageTgz('9.0.0')) })), 'version 9.0.0');

// The forgeries beside them.
await refuses('mc07.gzipOfNotATar', 'a gzip stream whose content is not a tar is refused by the header checksum', () => verify(dossier({ mutate: (raw) => raw.set('evidence.tar.gz', gzipSync(Buffer.alloc(1024, 0x41))) })), 'header checksum');
await refuses('mc07.truncatedArchive', 'an archive cut inside an entry is refused as truncated', () =>
  verify(dossier({ mutate: (raw) => {
    const whole = gunzipSync(sourceTgz());
    raw.set(`source-${SHA}.tar.gz`, gzipSync(whole.subarray(0, 512 * 3)));
  } })), 'truncated');
await refuses('mc07.tamperedArchiveEntry', 'a source archive with one byte of one entry changed, sealed with correct sums, is refused against the commit', () =>
  verify(dossier({ mutate: (raw) => raw.set(`source-${SHA}.tar.gz`, sourceTgz(SHA, { ...COMMIT_FILES, 'src/index.ts': 'export {} ;\n' })) })), 'src/index.ts differs from the reconstruction');
await refuses('mc07.tamperedPackageEntryResealed', 'a package edited after sealing, with the delivery manifest and sums rewritten to match, is refused against the reconstruction', () =>
  verify(dossier({ after: (raw) => reseal(raw, (edited) => edited.set(`kauro-migration-core-${CORE_VERSION}.tgz`, tarOf({ ...PACKAGE_FILES, 'package/dist/src/index.js': 'export const x = 1;\n' }))) })), 'differs from the reconstruction of the commit');
await refuses('mc07.extraArchiveEntry', 'a source archive carrying a file the commit does not is refused', () =>
  verify(dossier({ mutate: (raw) => raw.set(`source-${SHA}.tar.gz`, sourceTgz(SHA, { ...COMMIT_FILES, 'src/extra.ts': 'export {};\n' })) })), 'carries src/extra.ts, which the reconstruction of the commit does not');
await refuses('mc07.missingArchiveEntry', 'an evidence archive lacking a file the commit carries is refused', () => verify(dossier({ mutate: (raw) => raw.set('evidence.tar.gz', evidenceTgz({ 'qualification/evidence/x.json': '{}\n' })) })), 'lacks qualification/capacity/c.json');
await refuses('mc07.extraPackageEntry', 'a package carrying a file the commit does not build is refused', () =>
  verify(dossier({ mutate: (raw) => raw.set(`kauro-migration-core-${CORE_VERSION}.tgz`, tarOf({ ...PACKAGE_FILES, 'package/dist/src/extra.js': 'export {};\n' })) })), 'carries package/dist/src/extra.js');
await refuses('mc07.sourceRootedElsewhere', 'a source archive rooted at another commit\'s directory is refused', () => verify(dossier({ mutate: (raw) => raw.set(`source-${SHA}.tar.gz`, sourceTgz(OTHER_SHA)) })), 'is not rooted at');
await refuses('mc07.archivePathTraversal', 'an archive entry that escapes its root is refused before anything is compared', () => verify(dossier({ mutate: (raw) => raw.set('evidence.tar.gz', tarOf({ '../qualification/evidence/x.json': '{}\n' })) })), '. or .. segment');
await refuses('mc07.archiveAbsolutePath', 'an archive entry with an absolute path is refused', () => verify(dossier({ mutate: (raw) => raw.set('evidence.tar.gz', tarOf({ '/etc/passwd': 'x\n' })) })), 'is absolute');
await refuses('mc07.archiveDuplicateEntry', 'an archive naming one path twice is refused', () =>
  verify(dossier({ mutate: (raw) => {
    const one = gunzipSync(evidenceTgz({ 'qualification/evidence/x.json': '{}\n' }));
    const body = one.subarray(0, one.length - 1024);
    raw.set('evidence.tar.gz', gzipSync(Buffer.concat([body, body, Buffer.alloc(1024, 0)])));
  } })), 'twice');
await refuses('mc07.archiveSymlink', 'an archive carrying a symbolic link is refused', () =>
  verify(dossier({ mutate: (raw) => {
    const tar = gunzipSync(evidenceTgz({ 'qualification/evidence/x.json': '{}\n' }));
    tar.write('2', 156, 1, 'utf8');
    tar.write('        ', 148, 8, 'utf8');
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += tar[index];
    tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
    raw.set('evidence.tar.gz', gzipSync(tar));
  } })), 'only regular files and directories');
await refuses('mc07.assetFromAnotherVersion', 'a release provenance record for another core version is refused', () => verify(dossier({ mutate: (raw) => raw.set('migration-core-provenance.json', json({ ...records(FACTS).releaseProvenance, coreVersion: '2.0.0', packageVersion: '2.0.0' })) })), 'is for core 2.0.0');
await refuses('mc07.sbomForAnotherVersion', 'an SBOM about another version of the package is refused', () => verify(dossier({ mutate: (raw) => raw.set('sbom.cdx.json', json({ ...records(FACTS).sbom, metadata: { component: { type: 'library', name: 'kauro-migration-core', version: '2.0.0' } } })) })), 'about version 2.0.0');
await refuses('mc07.manifestDuplicatedName', 'a delivery manifest listing one asset name twice is refused', () =>
  verify(dossier({ after: (raw) => reseal(raw, (edited) => {
    const manifest = JSON.parse(edited.get(DOSSIER_MANIFEST_NAME).toString('utf8'));
    manifest.assets.push({ ...manifest.assets.find((entry) => entry.name === 'preflight.json') });
    edited.set(DOSSIER_MANIFEST_NAME, json(manifest));
  }) })), 'lists preflight.json twice');
await refuses('mc07.manifestUnknownField', 'a delivery manifest carrying a field its schema does not name is refused', () =>
  verify(dossier({ after: (raw) => reseal(raw, (edited) => {
    const manifest = JSON.parse(edited.get(DOSSIER_MANIFEST_NAME).toString('utf8'));
    manifest.verifiedElsewhere = true;
    edited.set(DOSSIER_MANIFEST_NAME, json(manifest));
  }) })), 'which its schema does not name');
await refuses('mc07.manifestForeignTree', 'a delivery manifest naming another git tree is refused', () => verify(dossier({ facts: { ...FACTS, gitTree: '9'.repeat(40) } })), 'says tree');
await refuses('mc07.truncatedJson', 'a record cut mid-document is refused as not JSON', () => verify(dossier({ mutate: (raw) => raw.set('universe.json', json(records(FACTS).universe).subarray(0, 200)) })), 'universe.json is not JSON');
await refuses('mc07.arrayRecord', 'a record that is a JSON array is refused', () => verify(dossier({ mutate: (raw) => raw.set('campaign.json', Buffer.from('[]\n')) })), 'campaign.json is JSON array, not a record');
await refuses('mc07.recordNotUtf8', 'a record that is not UTF-8 is refused', () => verify(dossier({ mutate: (raw) => raw.set('campaign.json', Buffer.from([0x7b, 0xff, 0xfe, 0x7d])) })), 'is not UTF-8');
await refuses('mc07.preflightMissingFact', 'a preflight that does not answer one fact of the closed list cannot be TRUE', () =>
  verify(dossier({ mutate: (raw) => {
    const preflight = records(FACTS).preflight;
    delete preflight.facts.secrets_and_customer_data_absent;
    raw.set('preflight.json', json(preflight));
  } })), 'does not answer secrets_and_customer_data_absent');
await refuses('mc07.preflightForeignFact', 'a preflight answering a fact that is not a preflight fact is refused', () =>
  verify(dossier({ mutate: (raw) => raw.set('preflight.json', json({ ...records(FACTS).preflight, facts: { ...records(FACTS).preflight.facts, invented: { value: true, by: 'EXECUTED' } } })) })), 'is not a preflight fact');
await refuses('mc07.preflightFactWithoutDerivation', 'a preflight fact that names no derivation this verifier knows is refused', () =>
  verify(dossier({ mutate: (raw) => raw.set('preflight.json', json({ ...records(FACTS).preflight, facts: { ...records(FACTS).preflight.facts, wall_clock_passed: { value: true, by: 'ASSUMED' } } })) })), 'not a derivation this verifier knows');
await refuses('mc07.preflightFlagFalseOverTrueFacts', 'a preflight stating FALSE over facts that derive TRUE is refused as contradictory', () => verify(dossier({ mutate: (raw) => raw.set('preflight.json', json({ ...records(FACTS).preflight, MIGRATION_CORE_CANDIDATE_PREFLIGHT: 'FALSE' })) })), 'is FALSE and its facts derive TRUE');
await refuses('mc07.universePassedOverFailedStep', 'a universe saying passed over a failed step is refused: the flag is derived from the steps', () =>
  verify(dossier({ mutate: (raw) => {
    const universe = records(FACTS).universe;
    universe.steps[3] = { ...universe.steps[3], ok: false, status: 'failed', exitStatus: 1 };
    raw.set('universe.json', json(universe));
  } })), 'says passed true and its steps derive false');
await refuses('mc07.universeMissingStep', 'a universe report lacking one inventory step is refused', () =>
  verify(dossier({ mutate: (raw) => {
    const universe = records(FACTS).universe;
    universe.steps = universe.steps.slice(1);
    raw.set('universe.json', json(universe));
  } })), 'is missing from the report');
await refuses('mc07.manifestTableDerivesAnotherDigest', 'a candidate manifest whose files table derives another digest than it states is refused', () =>
  verify(dossier({ mutate: (raw) => {
    const manifest = records(FACTS).manifest;
    manifest.files[0] = { ...manifest.files[0], sha256: '0'.repeat(64) };
    raw.set('manifest.json', json(manifest));
  } })), 'its own table derives');
{
  // Defence in depth: even when the measured digests agree with the table (a
  // measurement taken over the same forged files), the table is compared with
  // the commit's own files and the difference is named.
  const table = [...TABLE, { path: 'src/other.ts', sha256: sha256(Buffer.from('x')), bytes: 1 }];
  const manifest = { ...records(FACTS).manifest, files: table, fileCount: table.length, codeFileCount: codeRecords(table).length, manifestDigest: digestRecords('manifest', table), codeDigest: digestRecords('code', codeRecords(table)) };
  const problems = candidateRecordProblems('manifest.json', manifest, { ...FACTS, codeDigest: manifest.codeDigest, manifestDigest: manifest.manifestDigest, receiptSha256: null });
  record('mc07.manifestTableNotTheCommit', problems.some((problem) => problem.includes('src/other.ts')), 'a candidate manifest whose table is internally consistent but describes other files than the commit is refused, naming the file', problems.join('; ') || 'ACCEPTED');
}
await refuses('mc07.releaseProvenanceGatesAllPassOverFailedGate', 'a release provenance saying gatesAllPass over a gate that is not PASS is refused', () =>
  verify(dossier({ mutate: (raw) => raw.set('migration-core-provenance.json', json({ ...records(FACTS).releaseProvenance, gates: [{ gate: 'CORE-CONSTITUTION-01', state: 'FALSE', establishedBy: 'x', observedAt: null, evidence: 'x' }] })) })), 'gatesAllPass true and its gates');
await refuses('mc07.receiptRedCheckRun', 'a receipt recording a check run that did not conclude success is refused', () => verify(dossier({ receipt: receiptFor(FACTS, { checkRuns: [{ checkRunId: 1, name: 'gate', conclusion: 'failure', headSha: SHA, startedAt: null, completedAt: null, app: 'github-actions', checkSuiteId: 1 }] }) })), 'as failure');
await refuses('mc07.receiptForeignTree', 'a receipt attesting another git tree is refused', () => verify(dossier({ receipt: receiptFor({ ...FACTS, gitTree: '9'.repeat(40) }) })), 'attests tree');
await refuses('mc07.receiptCheckRunOnAnotherCommit', 'a receipt whose check run was on another commit is refused', () => verify(dossier({ receipt: receiptFor(FACTS, { checkRuns: [{ checkRunId: 1, name: 'gate', conclusion: 'success', headSha: OTHER_SHA, startedAt: null, completedAt: null, app: 'github-actions', checkSuiteId: 1 }] }) })), 'not this commit');
await refuses('mc07.campaignForeignSubject', 'a campaign record sealing another subject than the release provenance names is refused', () => verify(dossier({ mutate: (raw) => raw.set('campaign.json', json({ ...records(FACTS).campaign, subjectDigest: '8'.repeat(64) })) })), 'campaign subjectDigest');
await refuses('mc07.campaignProducerMoved', 'a campaign sealing a producer at another fingerprint than the candidate measures is refused', () =>
  verify(dossier({ mutate: (raw) => raw.set('campaign.json', json({ ...records(FACTS).campaign, producers: { ...records(FACTS).campaign.producers, 'tools/capacity.mjs': { fingerprint: '5'.repeat(64), files: 1, kind: 'CAPACITY' } } })) })), 'seals tools/capacity.mjs');
// D77: the universe is sealed for the record, not for the binding (tools/seal-campaign.mjs
// --check, the release gate). A moved universe is accepted; every other kind still binds,
// and a producer cannot escape the binding by calling itself UNIVERSE.
{
  const vendor = 'qualification/hubspot/run-target-qualification.mjs';
  const facts = { ...FACTS, producers: { ...FACTS.producers, [vendor]: '3'.repeat(64) }, receiptSha256: null };
  const sealed = (edits) => ({
    ...records(FACTS).campaign,
    producers: {
      'tools/capacity.mjs': { fingerprint: facts.producers['tools/capacity.mjs'], files: 1, kind: 'CAPACITY' },
      [vendor]: { fingerprint: facts.producers[vendor], files: 1, kind: 'VENDOR' },
      'tools/universe.mjs': { fingerprint: facts.producers['tools/universe.mjs'], files: 1, kind: 'UNIVERSE' },
      ...edits,
    },
  });
  const universeMoved = candidateRecordProblems('campaign.json', sealed({ 'tools/universe.mjs': { fingerprint: '6'.repeat(64), files: 1, kind: 'UNIVERSE' } }), facts);
  record('d77.campaignUniverseMovedAccepted', universeMoved.length === 0, 'a campaign whose UNIVERSE producer moved since the seal is accepted: the universe is sealed for the record, not for the binding', universeMoved.join('; ') || 'clean');
  const universeBadShape = candidateRecordProblems('campaign.json', sealed({ 'tools/universe.mjs': { fingerprint: 'nothex', files: 1, kind: 'UNIVERSE' } }), facts);
  record('d77.campaignUniverseStillShapeChecked', universeBadShape.some((problem) => problem.includes('tools/universe.mjs')), 'a UNIVERSE entry is still shape-checked', universeBadShape.join('; ') || 'ACCEPTED');
  const universeElsewhere = candidateRecordProblems('universe.json', { ...records(FACTS).universe, candidate: { ...records(FACTS).universe.candidate, codeDigest: '7'.repeat(64) } }, facts);
  record('d77.universeOverOtherCodeRefused', universeElsewhere.some((problem) => problem.includes('ran over code digest')), 'a universe report over other code is refused: its digests are what binds the universe, not the campaign', universeElsewhere.join('; ') || 'ACCEPTED');
  const capacityMoved = candidateRecordProblems('campaign.json', sealed({ 'tools/capacity.mjs': { fingerprint: '5'.repeat(64), files: 1, kind: 'CAPACITY' } }), facts);
  record('d77.campaignCapacityMovedRefused', capacityMoved.some((problem) => problem.includes('seals tools/capacity.mjs')), 'a campaign whose CAPACITY producer moved is refused', capacityMoved.join('; ') || 'ACCEPTED');
  const vendorMoved = candidateRecordProblems('campaign.json', sealed({ [vendor]: { fingerprint: '5'.repeat(64), files: 1, kind: 'VENDOR' } }), facts);
  record('d77.campaignVendorMovedRefused', vendorMoved.some((problem) => problem.includes(`seals ${vendor}`)), 'a campaign whose VENDOR producer moved is refused', vendorMoved.join('; ') || 'ACCEPTED');
  const disguised = candidateRecordProblems('campaign.json', sealed({ 'tools/capacity.mjs': { fingerprint: '5'.repeat(64), files: 1, kind: 'UNIVERSE' } }), facts);
  record('d77.campaignDisguisedAsUniverseRefused', disguised.some((problem) => problem.includes('tools/capacity.mjs')), 'a moved producer that calls itself UNIVERSE in the campaign, and is not one, is refused', disguised.join('; ') || 'ACCEPTED');
}
// D77: the receipt is written inside the run it describes, so its own job's check run is
// necessarily unfinished in it; receipt-verify skips that job by the workflow's name for it
// and the chain's receipt-observe proves the finished run green from outside.
{
  const gate = { checkRunId: 1, name: 'gate (ubuntu-latest)', conclusion: 'success', headSha: SHA, startedAt: null, completedAt: null, app: 'github-actions', checkSuiteId: 1 };
  const own = (conclusion, name = RECEIPT_JOB_NAME) => ({ checkRunId: 2, name, conclusion, headSha: SHA, startedAt: null, completedAt: null, app: 'github-actions', checkSuiteId: 1 });
  const withRuns = (...checkRuns) => receiptFor(FACTS, { checkRuns });
  const verifyWith = (receipt) => verify(dossier({ receipt }), {}, { receipt });
  record('d77.receiptJobNameResolved', typeof RECEIPT_JOB_NAME === 'string' && RECEIPT_JOB_NAME.length > 0, 'the workflow names the receipt job', String(RECEIPT_JOB_NAME));
  const inProgress = await verifyWith(withRuns(gate, own('in_progress (not concluded)')));
  record('d77.receiptOwnRunInProgressAccepted', inProgress.assets.value === true, 'a receipt recording its own job\'s check run as in progress is accepted', inProgress.assets.observed);
  await refuses('d77.receiptOwnRunFailedRefused', 'a receipt recording its own job\'s check run as failure is refused', () => verifyWith(withRuns(gate, own('failure'))), 'as failure');
  await refuses('d77.receiptOwnRunOnAnotherCommitRefused', 'the receipt job\'s own check run on another commit is refused', () => verifyWith(withRuns(gate, { ...own('in_progress (not concluded)'), headSha: OTHER_SHA })), 'not this commit');
  await refuses('d77.receiptOtherRunInProgressRefused', 'a receipt recording any other check run as in progress is refused', () => verifyWith(withRuns(gate, own('in_progress (not concluded)', 'gate (windows-latest)'))), 'gate (windows-latest)');
  await refuses('d77.receiptLookalikeRefused', 'a check run whose name only resembles the receipt job is not exempt', () => verifyWith(withRuns(gate, own('in_progress (not concluded)', `${String(RECEIPT_JOB_NAME)} `))), 'not concluded');
  const unresolved = candidateRecordProblems('ci-receipt.json', JSON.parse(withRuns(gate, own('in_progress (not concluded)')).toString('utf8')), { ...FACTS, receiptJobName: null, receiptSha256: null });
  record('d77.receiptJobUnresolvedRefused', unresolved.some((problem) => problem.includes('not concluded')), 'without the workflow\'s receipt job name nothing is exempt', unresolved.join('; ') || 'ACCEPTED');
}
// D77 / MCD-R3: the SBOM names the package, whatever the checkout's folder is called
// (npm 11 names metadata.component after the folder), and the installed tree is the
// cross-check: a checkout whose node_modules is not what the lockfile says is refused.
// A synthetic one-dependency package, so the fixture needs no network and no install.
{
  const sbomFixture = (installed, npmrc = null) => {
    const scratch = mkdtempSync(join(tmpdir(), 'kauro-sbom-selftest-'));
    const checkout = join(scratch, 'mc-203-fix');
    mkdirSync(checkout);
    writeFileSync(join(checkout, 'package.json'), `${JSON.stringify({ name: 'kauro-migration-core', version: CORE_VERSION, private: true, dependencies: { a: '1.0.0' } })}\n`);
    writeFileSync(join(checkout, 'package-lock.json'), `${JSON.stringify({
      name: 'kauro-migration-core',
      version: CORE_VERSION,
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'kauro-migration-core', version: CORE_VERSION, dependencies: { a: '1.0.0' } },
        'node_modules/a': { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', integrity: 'sha512-AAAA', license: 'MIT' },
      },
    })}\n`);
    if (npmrc !== null) writeFileSync(join(checkout, '.npmrc'), npmrc);
    for (const [name, version] of Object.entries(installed)) {
      mkdirSync(join(checkout, 'node_modules', name), { recursive: true });
      writeFileSync(join(checkout, 'node_modules', name, 'package.json'), `${JSON.stringify({ name, version, license: 'MIT' })}\n`);
    }
    return { scratch, checkout };
  };
  const attempt = (installed, npmrc = null) => {
    const { scratch, checkout } = sbomFixture(installed, npmrc);
    try {
      if (typeof releaseDossier.generateSbom !== 'function') return { error: 'release-dossier.mjs exports no generateSbom' };
      return { sbom: JSON.parse(releaseDossier.generateSbom({ root: checkout })) };
    } catch (error) {
      return { error: String(error.message).slice(0, 300) };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
  {
    const result = attempt({ a: '1.0.0' });
    const component = result.sbom?.metadata?.component ?? {};
    const ok = component.name === 'kauro-migration-core' && component.version === CORE_VERSION && component['bom-ref'] === `kauro-migration-core@${CORE_VERSION}` && (result.sbom?.components ?? []).map((entry) => `${entry.name}@${entry.version}`).join(',') === 'a@1.0.0';
    record('d77.sbomNamesThePackageNotTheFolder', ok, 'an SBOM generated from a checkout folder named mc-203-fix, installed as locked, names kauro-migration-core', result.error ?? `${String(component.name)} ${String(component.version)} ${String(component['bom-ref'])}`);
  }
  // MCD-R3, second review: npm configuration inherited from the environment or an
  // npmrc must not turn the installed-tree reading back into a lockfile reading.
  {
    const saved = process.env.npm_config_package_lock_only;
    process.env.npm_config_package_lock_only = 'true';
    let result;
    try {
      result = attempt({ a: '1.0.1' });
    } finally {
      if (saved === undefined) delete process.env.npm_config_package_lock_only;
      else process.env.npm_config_package_lock_only = saved;
    }
    record('r3b.sbomDriftRefusedUnderInheritedLockOnly', result.sbom === undefined && typeof result.error === 'string' && result.error !== 'release-dossier.mjs exports no generateSbom', 'installed drift is refused with npm_config_package_lock_only=true in the environment', result.error ?? 'ACCEPTED');
  }
  {
    const result = attempt({ a: '1.0.1' }, 'package-lock-only=true\n');
    record('r3b.sbomDriftRefusedUnderNpmrcLockOnly', result.sbom === undefined && typeof result.error === 'string' && result.error !== 'release-dossier.mjs exports no generateSbom', 'installed drift is refused with package-lock-only=true in the checkout\'s .npmrc', result.error ?? 'ACCEPTED');
  }
  for (const [id, expected, installed] of [
    ['r3.sbomInstalledDriftRefused', 'an installed dependency at another version than the lockfile is refused', { a: '1.0.1' }],
    ['r3.sbomInstalledExtraneousRefused', 'an installed package the lockfile does not name is refused', { a: '1.0.0', b: '2.0.0' }],
    ['r3.sbomNothingInstalledRefused', 'a checkout with nothing installed is refused rather than described from the lockfile alone', {}],
  ]) {
    const result = attempt(installed);
    record(id, result.sbom === undefined && typeof result.error === 'string' && result.error !== 'release-dossier.mjs exports no generateSbom', expected, result.error ?? 'ACCEPTED');
  }
}
// MCD-R2: the receipt job's own check run is identified by more than its name.
// In the receipt alone: app github-actions, the check suite every required leg
// ran in, this commit, unfinished, and exactly one such entry. Anything else
// carrying the name is an ordinary check run and must be success.
{
  const gate = { checkRunId: 1, name: 'gate (ubuntu-latest)', conclusion: 'success', headSha: SHA, startedAt: null, completedAt: null, app: 'github-actions', checkSuiteId: 1 };
  const own = { checkRunId: 2, name: RECEIPT_JOB_NAME, conclusion: 'in_progress (not concluded)', headSha: SHA, startedAt: null, completedAt: null, app: 'github-actions', checkSuiteId: 1 };
  const withRuns = (...checkRuns) => receiptFor(FACTS, { checkRuns });
  const verifyWith = (receipt) => verify(dossier({ receipt }), {}, { receipt });
  await refuses('r2.impostorOtherAppRefused', 'an unfinished check run from another app carrying the receipt job\'s exact name is refused beside the real one', () => verifyWith(withRuns(gate, own, { ...own, checkRunId: 3, app: 'another-integration', checkSuiteId: 9 })), 'not concluded');
  await refuses('r2.impostorAloneRefused', 'an unfinished same-name check run from another app, with no real one, is refused', () => verifyWith(withRuns(gate, { ...own, checkRunId: 3, app: 'another-integration' })), 'not concluded');
  await refuses('r2.otherSuiteRefused', 'an unfinished receipt-job entry in another check suite than the required legs is refused', () => verifyWith(withRuns(gate, { ...own, checkSuiteId: 7 })), 'not concluded');
  await refuses('r2.twoCandidatesRefused', 'two unfinished entries that both look like the receipt job: neither is exempt', () => verifyWith(withRuns(gate, own, { ...own, checkRunId: 4 })), 'not concluded');
  await refuses('r2.legsInTwoSuitesRefused', 'when the required legs do not share one check suite, nothing is exempt', () => verifyWith(withRuns(gate, { ...gate, checkRunId: 5, checkSuiteId: 8 }, own)), 'not concluded');
  const sameNameGreen = await verifyWith(withRuns(gate, own, { ...own, checkRunId: 6, app: 'another-integration', checkSuiteId: 9, conclusion: 'success' }));
  record('r2.sameNameSuccessIsOrdinary', sameNameGreen.assets.value === true, 'a same-name check run that concluded success is an ordinary green check beside the exempt one', sameNameGreen.assets.observed);
}
// MCD-R2 in the observer: the receipt job's own check run is the one whose id is the
// receipt job's id in this run and attempt, not every check run carrying its name.
{
  const workflow = readWorkflow();
  const legs = requiredJobLegs(workflow);
  const fixture = ({ finished = false } = {}) => {
    const suite = 77;
    const jobs = legs.map((leg, index) => ({ jobId: 1000 + index, name: leg.name, conclusion: 'success', status: 'completed', headSha: SHA, runAttempt: 1, startedAt: null, completedAt: null, labels: [leg.runsOn] }));
    const ownJob = { jobId: 2000, name: workflow.receiptJobName, conclusion: finished ? 'success' : 'in_progress (not concluded)', status: finished ? 'completed' : 'in_progress', headSha: SHA, runAttempt: 1, startedAt: null, completedAt: null, labels: ['ubuntu-latest'] };
    const asCheck = (job) => ({ checkRunId: job.jobId, name: job.name, conclusion: job.conclusion, status: job.status, headSha: SHA, startedAt: null, completedAt: null, app: 'github-actions', checkSuiteId: suite });
    const cachedOwn = { ...asCheck(ownJob), conclusion: 'in_progress (not concluded)', status: 'in_progress' };
    const strip = ({ status, ...rest }) => rest;
    const receipt = JSON.parse(receiptFor(FACTS, {
      runId: '42',
      checkRuns: [...jobs.map(asCheck), cachedOwn].map(strip),
      reruns: [`${workflow.receiptJobName}: an attempt did not conclude success`],
    }).toString('utf8'));
    const observation = {
      problems: [],
      run: { headSha: SHA, path: '.github/workflows/ci.yml', runAttempt: 1, status: finished ? 'completed' : 'in_progress', conclusion: finished ? 'success' : null, repository: REPOSITORY },
      commitTree: FACTS.gitTree,
      jobs: [...jobs, ownJob],
      jobsStatus: 'COMPLETE',
      checkRuns: [...jobs, ownJob].map(asCheck),
      checkRunsStatus: 'COMPLETE',
    };
    return { workflow, receipt, observation, ownJob, asCheck };
  };
  {
    const { receipt, observation } = fixture();
    const problems = receiptObservationProblems(receipt, workflow, observation);
    record('r2.observerInRunClean', problems.length === 0, 'an in-run observation with the receipt job unfinished is clean', problems.join('; ') || 'clean');
  }
  {
    const { receipt, observation } = fixture();
    const impostor = { checkRunId: 3000, name: workflow.receiptJobName, conclusion: 'in_progress (not concluded)', status: 'in_progress', headSha: SHA, startedAt: null, completedAt: null, app: 'another-integration', checkSuiteId: 99 };
    observation.checkRuns.push(impostor);
    receipt.checkRuns.push({ ...impostor, status: undefined });
    const problems = receiptObservationProblems(receipt, workflow, observation);
    record('r2.observerImpostorRefused', problems.some((problem) => problem.includes(workflow.receiptJobName)), 'an unfinished same-name check run that is not the receipt job is refused by the observer', problems.join('; ') || 'ACCEPTED');
  }
  {
    const { receipt, observation } = fixture();
    const impostor = { checkRunId: 3001, name: workflow.receiptJobName, conclusion: 'failure', status: 'completed', headSha: SHA, startedAt: null, completedAt: null, app: 'another-integration', checkSuiteId: 99 };
    observation.checkRuns.push(impostor);
    const problems = receiptObservationProblems(receipt, workflow, observation);
    record('r2.observerHiddenSameNameRefused', problems.some((problem) => problem.includes(workflow.receiptJobName)), 'a red same-name check run GitHub reports and the receipt omits is refused', problems.join('; ') || 'ACCEPTED');
  }
}
// MCD-R1: the observer that the exemption relies on proves, from outside and after
// the run, that the run concluded success and that the receipt job's own check
// run did. The in-run verification keeps asking only what can be answered in-run.
{
  const workflow = readWorkflow();
  const legs = requiredJobLegs(workflow);
  const fixture = () => {
    const jobs = legs.map((leg, index) => ({ jobId: 1000 + index, name: leg.name, conclusion: 'success', status: 'completed', headSha: SHA, runAttempt: 1, startedAt: null, completedAt: null, labels: [leg.runsOn] }));
    const ownJob = { jobId: 2000, name: workflow.receiptJobName, conclusion: 'success', status: 'completed', headSha: SHA, runAttempt: 1, startedAt: null, completedAt: null, labels: ['ubuntu-latest'] };
    const asCheck = (job) => ({ checkRunId: job.jobId, name: job.name, conclusion: job.conclusion, status: job.status, headSha: SHA, startedAt: null, completedAt: null, app: 'github-actions', checkSuiteId: 77 });
    const { status, ...cachedOwn } = { ...asCheck(ownJob), conclusion: 'in_progress (not concluded)' };
    const receipt = JSON.parse(receiptFor(FACTS, {
      runId: '42',
      checkRuns: [...jobs.map((job) => { const { status: s, ...rest } = asCheck(job); return rest; }), cachedOwn],
      reruns: [`${workflow.receiptJobName}: an attempt did not conclude success`],
    }).toString('utf8'));
    const observation = {
      problems: [],
      run: { headSha: SHA, path: '.github/workflows/ci.yml', runAttempt: 1, status: 'completed', conclusion: 'success', repository: REPOSITORY },
      commitTree: FACTS.gitTree,
      jobs: [...jobs, ownJob],
      jobsStatus: 'COMPLETE',
      checkRuns: [...jobs, ownJob].map(asCheck),
      checkRunsStatus: 'COMPLETE',
    };
    return { receipt, observation, ownJob };
  };
  const finished = { requireFinished: true };
  {
    const { receipt, observation } = fixture();
    const problems = receiptObservationProblems(receipt, workflow, observation, finished);
    record('r1.observerFinishedGreenClean', problems.length === 0, 'a finished run, the receipt job included, concluded success is clean from outside', problems.join('; ') || 'clean');
  }
  const refusedWhen = (id, expected, edit, mentions) => {
    const { receipt, observation, ownJob } = fixture();
    edit({ receipt, observation, ownJob });
    const problems = receiptObservationProblems(receipt, workflow, observation, finished);
    record(id, problems.some((problem) => problem.includes(mentions)), expected, problems.join('; ') || 'ACCEPTED');
  };
  refusedWhen('r1.runFailedRefused', 'a run that concluded failure is refused from outside', ({ observation }) => { observation.run.conclusion = 'failure'; }, 'concluded failure');
  refusedWhen('r1.runUnfinishedRefused', 'a run still in progress is not proof from outside', ({ observation }) => { observation.run.status = 'in_progress'; observation.run.conclusion = null; }, 'has not finished');
  refusedWhen('r1.receiptJobFailedRefused', 'a receipt job that failed after writing the receipt is refused from outside', ({ observation }) => {
    observation.jobs = observation.jobs.map((job) => (job.jobId === 2000 ? { ...job, conclusion: 'failure' } : job));
    observation.checkRuns = observation.checkRuns.map((run) => (run.checkRunId === 2000 ? { ...run, conclusion: 'failure' } : run));
  }, 'failure');
  refusedWhen('r1.receiptCheckRunFailedRefused', 'the receipt job\'s own check run concluded failure is refused even if the job reads success', ({ observation }) => {
    observation.checkRuns = observation.checkRuns.map((run) => (run.checkRunId === 2000 ? { ...run, conclusion: 'cancelled' } : run));
  }, 'cancelled');
  refusedWhen('r1.receiptCheckRunMissingRefused', 'the receipt job\'s own check run absent from GitHub is refused from outside', ({ observation }) => {
    observation.checkRuns = observation.checkRuns.filter((run) => run.checkRunId !== 2000);
  }, 'own check run');
  refusedWhen('r1.receiptJobMissingRefused', 'a run with no receipt job is refused from outside', ({ observation }) => {
    observation.jobs = observation.jobs.filter((job) => job.jobId !== 2000);
  }, workflow.receiptJobName);
}
// MCD-R2 (second review, the class): every check-run judgement is by identity — the
// check run's id, its app and its check suite — never by name. A re-run is the same
// job of the same workflow run across attempts; anything not identified as that must
// be success itself, and the receipt and GitHub must agree id by id.
{
  const workflow = readWorkflow();
  const legs = requiredJobLegs(workflow);
  const fixture = () => {
    const jobs = legs.map((leg, index) => ({ jobId: 1000 + index, name: leg.name, conclusion: 'success', status: 'completed', headSha: SHA, runAttempt: 1, startedAt: '2026-10-01T00:00:00Z', completedAt: '2026-10-01T00:05:00Z', labels: [leg.runsOn] }));
    const ownJob = { jobId: 2000, name: workflow.receiptJobName, conclusion: 'success', status: 'completed', headSha: SHA, runAttempt: 1, startedAt: '2026-10-01T00:06:00Z', completedAt: '2026-10-01T00:07:00Z', labels: ['ubuntu-latest'] };
    const asCheck = (job) => ({ checkRunId: job.jobId, name: job.name, conclusion: job.conclusion, status: job.status, headSha: SHA, startedAt: job.startedAt, completedAt: job.completedAt, app: 'github-actions', checkSuiteId: 77 });
    const cache = ({ status, ...rest }) => rest;
    const receipt = JSON.parse(receiptFor(FACTS, {
      runId: '42',
      checkRuns: [...jobs.map((job) => cache(asCheck(job))), { ...cache(asCheck(ownJob)), conclusion: 'in_progress (not concluded)' }],
      reruns: [`${workflow.receiptJobName}: an attempt did not conclude success`],
    }).toString('utf8'));
    const observation = {
      problems: [],
      run: { headSha: SHA, path: '.github/workflows/ci.yml', runAttempt: 1, status: 'completed', conclusion: 'success', repository: REPOSITORY },
      commitTree: FACTS.gitTree,
      jobs: [...jobs, ownJob],
      jobsStatus: 'COMPLETE',
      checkRuns: [...jobs, ownJob].map(asCheck),
      checkRunsStatus: 'COMPLETE',
    };
    return { receipt, observation, cache };
  };
  const finished = { requireFinished: true };
  const ordinary = { checkRunId: 5000, name: workflow.receiptJobName, conclusion: 'success', status: 'completed', headSha: SHA, startedAt: '2026-10-01T00:01:00Z', completedAt: '2026-10-01T00:02:00Z', app: 'another-integration', checkSuiteId: 99 };
  {
    const { receipt, observation, cache } = fixture();
    receipt.checkRuns.push(cache(ordinary));
    observation.checkRuns.push(ordinary);
    const clean = receiptObservationProblems(receipt, workflow, observation, finished);
    record('r2b.ordinarySameNameGreenClean', clean.length === 0, 'an ordinary green check run carrying the receipt job\'s name, cached and observed by id, is clean', clean.join('; ') || 'clean');
    observation.checkRuns.push({ ...ordinary, checkRunId: 5001, conclusion: 'queued (not concluded)', status: 'queued', startedAt: null, completedAt: null });
    const problems = receiptObservationProblems(receipt, workflow, observation, finished);
    record('r2b.queuedSameNameRefused', problems.some((problem) => problem.includes('5001') || problem.includes('queued')), 'a queued check run with the receipt job\'s name beside a green one, which the receipt omits, is refused (the review\'s reproduction)', problems.join('; ') || 'ACCEPTED');
  }
  {
    const { receipt, observation, cache } = fixture();
    const red = { ...ordinary, checkRunId: 5002, conclusion: 'failure', startedAt: '2026-09-30T00:00:00Z', completedAt: '2026-09-30T00:01:00Z' };
    receipt.checkRuns.push(cache(ordinary));
    observation.checkRuns.push(ordinary, red);
    const problems = receiptObservationProblems(receipt, workflow, observation, finished);
    record('r2b.unrelatedEarlierRedNotARerun', problems.some((problem) => problem.includes('failure')), 'a red check run of another app is not excused as an earlier attempt by a name in reruns', problems.join('; ') || 'ACCEPTED');
  }
  {
    const { receipt, observation, cache } = fixture();
    receipt.checkRuns.push(cache(ordinary));
    observation.checkRuns.push({ ...ordinary, checkRunId: 5003 });
    const problems = receiptObservationProblems(receipt, workflow, observation, finished);
    record('r2b.sameNameOtherIdRefused', problems.some((problem) => problem.includes('5003')) && problems.some((problem) => problem.includes('5000')), 'a cached check run and an observed one that share only a name and a conclusion are two check runs, each unmatched', problems.join('; ') || 'ACCEPTED');
  }
  {
    // buildReceipt: a re-run is recorded only for a GitHub Actions check run in the
    // required legs' check suite, never for the receipt job's own unfinished run or
    // for an unidentified check run that merely failed.
    const saved = { ...process.env };
    Object.assign(process.env, { GITHUB_REPOSITORY: REPOSITORY, GITHUB_SHA: SHA, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GITHUB_WORKFLOW: 'core gate', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2' });
    let observed = 'ACCEPTED';
    let ok = false;
    try {
      const leg = legs[0].name;
      const run = (checkRunId, name, conclusion, app = 'github-actions', checkSuiteId = 77) => ({ checkRunId, name, conclusion, headSha: SHA, startedAt: null, completedAt: null, app, checkSuiteId });
      const checkRuns = [
        ...legs.map((entry, index) => run(1000 + index, entry.name, 'success')),
        run(900, leg, 'failure'),
        run(2000, workflow.receiptJobName, 'in_progress (not concluded)'),
        run(5000, 'some other integration', 'failure', 'another-integration', 99),
      ];
      const live = { sha: SHA, gitTree: FACTS.gitTree, treeClean: true, manifestDigest: FACTS.manifestDigest, codeDigest: FACTS.codeDigest, repository: REPOSITORY, problems: [] };
      const built = buildReceipt(live, workflow, {}, checkRuns);
      observed = JSON.stringify(built.receipt?.reruns ?? built.problems);
      ok = JSON.stringify(built.receipt?.reruns) === JSON.stringify([`${leg}: an attempt did not conclude success`]);
    } catch (error) {
      observed = String(error.message);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
    record('r2b.buildReceiptRerunsByIdentity', ok, 'buildReceipt records a re-run only for a required leg\'s own earlier attempt', observed);
  }
  {
    // tools/chain.mjs readRequiredChecks (MCD-R4): each case is one the name-keyed,
    // string-compared reading got wrong. A leg is read from GitHub Actions in the
    // run's check suite, latest by numeric id; another app's check run with a leg's
    // name neither stands in for the leg nor hides behind it.
    const leg = legs[0].name;
    const actions = (id, conclusion, suite = 77, status = 'completed') => ({ id, name: leg, status, conclusion, app: { slug: 'github-actions' }, check_suite: { id: suite } });
    const other = (id, conclusion, status = 'completed') => ({ id, name: leg, status, conclusion, app: { slug: 'another-integration' }, check_suite: { id: 99 } });
    const rest = legs.slice(1).map((entry, index) => ({ id: 100 + index, name: entry.name, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, check_suite: { id: 77 } }));
    const read = (runs) => (typeof chain.readRequiredChecks === 'function' ? chain.readRequiredChecks({ workflow, gh: { list: async () => [...rest, ...runs] } }, SHA, { checkSuiteId: 77 }) : Promise.reject(new Error('tools/chain.mjs exports no readRequiredChecks')));
    const chainCases = [
      ['r4.chainLatestIsNumeric', 'a leg re-run from id 9 (failure) to id 10 (success) is green: 10 is later than 9', [actions(9, 'failure'), actions(10, 'success')], (checks) => checks.red.length === 0 && checks.pending.length === 0 && checks.missing.length === 0],
      ['r4.chainImpostorOnlyIsMissing', 'a leg reported only by another app is missing, not green', [other(5000, 'success')], (checks) => checks.missing.includes(leg)],
      ['r4.chainImpostorBesideLegIsPending', 'another app\'s queued check run with a leg\'s name is pending even beside the green leg', [actions(10, 'success'), other(1, null, 'queued')], (checks) => checks.pending.includes(leg)],
      ['r4.chainDecidedInItsOwnSuite', 'a leg failed in its own run\'s suite is red even when a later green run of its name sits in another suite', [actions(10, 'failure'), actions(20, 'success', 88)], (checks) => checks.red.includes(leg)],
    ];
    for (const [id, expected, runs, holds] of chainCases) {
      let observed;
      let ok = false;
      try {
        const checks = await read(runs);
        ok = holds(checks);
        observed = `red ${JSON.stringify(checks.red)} pending ${JSON.stringify(checks.pending)} missing ${JSON.stringify(checks.missing)}`;
      } catch (error) {
        observed = String(error.message).slice(0, 300);
      }
      record(id, ok, expected, observed);
    }
  }
}
// Chain identity self-test: main alone cannot prove which PR/head was merged,
// and a ledger or state from another PR/branch cannot authorize reuse.
{
  const merge = chain.NODES.find((node) => node.id === 'merge');
  for (const [id, pull, accepted] of [
    ['chain.mergeUnmergedRefused', { merged: false, head: { sha: SHA } }, false],
    ['chain.mergeForeignHeadRefused', { merged: true, head: { sha: OTHER_SHA } }, false],
  ]) {
    const result = await merge.check({ state: { prNumber: 16, branch: 'release/3.0.0-dossier', head: OTHER_SHA, candidate: SHA, prHead: OTHER_SHA, mergedSha: SHA }, saveState: () => {}, gh: { get: async (path) => path.includes('/pulls/') ? { number: 16, base: { ref: 'main' }, merge_commit_sha: SHA, ...pull, head: { ref: 'release/3.0.0-dossier', ...pull.head } } : { commit: { sha: SHA } } } });
    record(id, result.ok === accepted && result.detail.includes(id === 'chain.mergeUnmergedRefused' ? 'is not merged' : 'QUALIFIED_CANDIDATE_MISMATCH:'), `merge.check refuses for the specific PR/candidate rule even with main at the recorded merge SHA`, result.detail);
  }
  await chainIdentityCases(chain, record);
  const scratch = mkdtempSync(join(tmpdir(), 'kauro-chain-identity-selftest-'));
  try {
    const identity = { prNumber: 16, branch: 'release/3.0.0-dossier' };
    for (const [id, cachedIdentity, discard] of [
      ['chain.foreignPrStateDiscarded', { ...identity, prNumber: 15 }, true],
      ['chain.foreignBranchStateDiscarded', { ...identity, branch: 'release/other' }, true],
      ['chain.unboundStateDiscarded', {}, true],
      ['chain.sameIdentityStateReused', identity, false],
    ]) {
      const work = join(scratch, 'chain', id);
      mkdirSync(work, { recursive: true });
      writeFileSync(join(work, 'state.json'), JSON.stringify({ ...cachedIdentity, head: SHA, mergedSha: OTHER_SHA }));
      writeFileSync(join(work, 'ledger.jsonl'), 'stale ledger\n');
      let holds = false;
      let observed;
      try {
        const ctx = await chain.makeContext({ rehearsal: false, ...identity, recoveryRoot: scratch, workName: id });
        const saved = JSON.parse(readFileSync(ctx.statePath, 'utf8'));
        holds = saved.prNumber === identity.prNumber && saved.branch === identity.branch
          && (discard ? saved.candidate === saved.head && saved.mergedSha === undefined && !existsSync(ctx.ledgerPath)
            : saved.candidate === SHA && saved.prHead === SHA && saved.mergedSha === OTHER_SHA && existsSync(ctx.ledgerPath));
        observed = JSON.stringify(saved);
      } catch (error) {
        observed = String(error.message);
      }
      record(id, holds, discard ? 'foreign cached state and ledger are discarded and fresh identity is persisted' : 'matching identity preserves recorded state and ledger', observed);
    }
    const preload = join(scratch, 'github.mjs');
    const callsPath = join(scratch, 'calls.jsonl');
    writeFileSync(preload, `import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url, init) => {
  appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ url: String(url), method: init.method }) + '\\n');
  if (init.method !== 'GET' || !String(url).endsWith('/pulls/16')) throw new Error('unexpected remote mutation or read');
  return new Response(JSON.stringify({ head: { ref: 'release/other' } }), { status: 200 });
};\n`);
    // A syntactically valid PR/branch is insufficient to resume an earlier
    // merge. Pair the startup identity and directory checks with this bound
    // state control so an older startup-head implementation cannot pass.
    const qualifiedRecoveryRefused = async (id) => {
      const root = join(scratch, `${id}-qualified`);
      const workName = 'same-pr';
      const statePath = join(root, 'chain', workName, 'state.json');
      mkdirSync(join(root, 'chain', workName), { recursive: true });
      const bytes = JSON.stringify({ ...identity, head: SHA, candidate: OTHER_SHA, prHead: SHA, mergedHead: SHA, mergedSha: SHA });
      writeFileSync(statePath, bytes);
      try {
        await chain.makeContext({ rehearsal: false, ...identity, recoveryRoot: root, workName,
          pull: { number: 16, merged: true, head: { sha: SHA, ref: identity.branch }, base: { ref: 'main' }, merge_commit_sha: SHA } });
        return false;
      } catch (error) {
        return String(error.message).startsWith('QUALIFIED_CANDIDATE_MISMATCH:') && readFileSync(statePath, 'utf8') === bytes
          && !existsSync(join(root, 'chain', workName, 'logs'));
      }
    };
    for (const [id, overrides, expected] of [
      ['chain.zeroPrRefused', { KAURO_PR: '0' }, 'KAURO_PR is required'],
      ['chain.missingPrRefused', { KAURO_PR: undefined }, 'KAURO_PR is required'],
      ['chain.missingBranchRefused', { KAURO_BRANCH: undefined }, 'KAURO_BRANCH is required'],
      ['chain.branchMismatchRefused', {}, 'does not match PR #16 head.ref release/other'],
    ]) {
      rmSync(callsPath, { force: true });
      const root = join(scratch, id);
      const env = { ...process.env, GITHUB_TOKEN: 'CONTROL_FLOW_TEST_ONLY', GH_TOKEN: 'CONTROL_FLOW_TEST_ONLY', KAURO_PR: '16', KAURO_BRANCH: identity.branch, KAURO_CHAIN_ROOT: root, ...overrides };
      for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
      const ran = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, 'tools/chain.mjs', '--run', '--allow-mutations', '--until', 'seal-check'], { env, encoding: 'utf8', timeout: 30_000 });
      const calls = existsSync(callsPath) ? readFileSync(callsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
      const holds = ran.status === 1 && ran.stderr.includes(expected) && !existsSync(root)
        && (id === 'chain.branchMismatchRefused' ? calls.length === 1 && calls[0].method === 'GET' : calls.length === 0)
        && await qualifiedRecoveryRefused(id);
      record(id, holds, 'invalid PR/branch and valid identity with an unqualified cached merge are refused before startup writes or chain steps', ran.stderr.trim().split('\n')[0] ?? String(ran.status));
    }
    let workName = 'unavailable';
    try { workName = chain.finalWorkName(identity); } catch { /* Report a missing helper as a failed case. */ }
    record('chain.workNameBindsIdentity', workName === 'final-release-3.0.0-dossier-pr16' && await qualifiedRecoveryRefused('work-name'), 'final work directory names both branch and PR and cannot authorize an earlier candidate from that identity’s state', workName);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const [id, stdout, stderr, expected] of [
    ['chain.failureFirstStdoutLine', 'noise\nFALSE first cause\nFAIL later cause\nlast three\nare\nnoise', 'Error stderr cause', 'FALSE first cause'],
    ['chain.failureFirstStderrLine', 'ordinary output', 'noise\nError first cause\nproblem later cause\ntrailing noise', 'Error first cause'],
  ]) {
    let detail = 'unavailable';
    const refusal = await merge.check({ state: { prNumber: 16, branch: 'release/3.0.0-dossier', head: SHA, candidate: OTHER_SHA, prHead: SHA, mergedHead: SHA, mergedSha: SHA }, saveState: () => {},
      gh: { get: async () => ({ number: 16, merged: true, head: { sha: SHA, ref: 'release/3.0.0-dossier' }, base: { ref: 'main' }, merge_commit_sha: SHA }) } });
    // Exercise diagnostic retention with the actual candidate refusal, buried
    // before later generic failures, in both stdout and stderr positions.
    const cause = `${expected}: ${refusal.detail}`;
    try { detail = chain.failureDetail({ status: 7, stdout: stdout.replace(expected, cause), stderr: stderr.replace(expected, cause), log: '/full/step.log' }, 'step'); } catch { /* Report the old implementation as a failed case. */ }
    record(id, !refusal.ok && refusal.detail.startsWith('QUALIFIED_CANDIDATE_MISMATCH:') && detail === `step exited 7: ${cause}; full log: /full/step.log`, 'the actual qualified-candidate refusal remains the first diagnostic with its full log path', detail);
  }
  for (const [id, minutes] of [['universe', 480], ['pr-ci', 300], ['main-ci', 300]]) {
    const timeout = chain.NODES.find((node) => node.id === id).timeoutMs / 60_000;
    const guarded = chain.NODES.find((node) => node.id === (id === 'universe' ? 'records-final' : id));
    let refusal;
    try {
      refusal = await guarded.check({ state: { prNumber: 16, branch: 'release/3.0.0-dossier', head: SHA, candidate: OTHER_SHA, prHead: SHA, mergedHead: SHA, mergedSha: SHA }, saveState: () => {},
        gh: { get: async () => ({ number: 16, merged: true, head: { sha: SHA, ref: 'release/3.0.0-dossier' }, base: { ref: 'main' }, merge_commit_sha: SHA }) } });
    } catch (error) { refusal = { ok: false, detail: String(error.message) }; }
    record(`chain.${id}Timeout`, timeout === minutes && !refusal.ok && refusal.detail.startsWith('QUALIFIED_CANDIDATE_MISMATCH:'), `${id} has ${String(minutes)} minutes; its evidence cannot authorize an earlier merged candidate`, JSON.stringify({ timeout, refusal }));
  }
  const remoteScratch = mkdtempSync(join(tmpdir(), 'kauro-chain-remote-selftest-'));
  const savedFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  try {
    const workflow = readWorkflow();
    const legs = requiredJobLegs(workflow);
    const statePath = join(remoteScratch, 'github.json');
    writeFileSync(statePath, JSON.stringify({ repository: REPOSITORY, scenario: 'ok', requiredChecks: legs.map((leg) => leg.name), legs, main: SHA, runId: 42 }));
    Object.assign(process.env, { KAURO_CONTROL_FLOW_TEST_ONLY: '1', KAURO_FAKE_GITHUB_STATE: statePath });
    await import('./rehearsal/fake-github.mjs');
    const checks = (await (await fetch(`https://api.github.com/repos/${REPOSITORY}/commits/${SHA}/check-runs`)).json()).check_runs;
    const jobs = (await (await fetch(`https://api.github.com/repos/${REPOSITORY}/actions/runs/42/jobs`)).json()).jobs;
    const holds = checks.length === legs.length + 1 && checks.at(-1).name === workflow.receiptJobName
      && checks.every((check, i) => check.id === 2000 + i && check.html_url.includes(String(check.id))
        && check.id === jobs[i]?.id && check.name === jobs[i]?.name && check.html_url === jobs[i]?.html_url);
    const paths = [];
    const ci = await chain.NODES.find((node) => node.id === 'pr-ci').check({ workflow,
      state: { prNumber: 16, branch: 'release/3.0.0-dossier', head: SHA, candidate: SHA, prHead: OTHER_SHA },
      gh: { get: async () => ({ number: 16, merged: false, head: { sha: SHA, ref: 'release/3.0.0-dossier' }, base: { ref: 'main' } }),
        list: async (path) => { paths.push(path); const fixturePath = path.replace(/^\/repos\/[^/]+\/[^/]+/u, `/repos/${REPOSITORY}`); return (await (await fetch(`https://api.github.com${fixturePath}`)).json()).check_runs; } } });
    record('chain.rehearsalCheckIdsMatchJobs', holds && ci.ok && paths.length === 1 && paths[0].includes(`/commits/${SHA}/`), 'matching rehearsal check/job identities are read on the qualified candidate, independently of startup prHead', JSON.stringify({ checks: checks.map((check) => [check.name, check.id, check.html_url]), ci, paths }));
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    rmSync(remoteScratch, { recursive: true, force: true });
  }
}
// MCD-R2 (third review): only GitHub Actions check runs say which suite the required
// legs ran in. Another app's green check run carrying a leg's name is an ordinary
// check run; beside the real unfinished receipt run, the shape check, the dossier
// and the chain all accept the receipt.
{
  const workflow = readWorkflow();
  const legs = requiredJobLegs(workflow);
  const otherApp = { checkRunId: 5100, name: legs[0].name, conclusion: 'success', headSha: SHA, startedAt: null, completedAt: null, app: 'another-integration', checkSuiteId: 99 };
  const ownRun = { checkRunId: 2000, name: workflow.receiptJobName, conclusion: 'in_progress (not concluded)', headSha: SHA, startedAt: null, completedAt: null, app: 'github-actions', checkSuiteId: 77 };
  const legRuns = legs.map((leg, index) => ({ checkRunId: 1000 + index, name: leg.name, conclusion: 'success', headSha: SHA, startedAt: null, completedAt: null, app: 'github-actions', checkSuiteId: 77 }));
  const receipt = JSON.parse(receiptFor(FACTS, { checkRuns: [...legRuns, otherApp, ownRun] }).toString('utf8'));
  const live = { sha: SHA, gitTree: FACTS.gitTree, treeClean: true, manifestDigest: FACTS.manifestDigest, codeDigest: FACTS.codeDigest, repository: REPOSITORY, problems: [] };
  const shape = receiptShapeProblems(receipt, live, workflow).filter((problem) => problem.includes('check run'));
  record('r2c.shapeOtherAppLegNameAccepted', shape.length === 0, 'the receipt shape check accepts the real unfinished receipt run beside another app\'s green check run carrying a leg\'s name', shape.join('; ') || 'clean');
  const facts = { ...FACTS, requiredCheckNames: legs.map((leg) => leg.name), receiptSha256: null };
  const dossierSide = candidateRecordProblems('ci-receipt.json', receipt, facts);
  record('r2c.dossierOtherAppLegNameAccepted', dossierSide.length === 0, 'the dossier accepts the same receipt', dossierSide.join('; ') || 'clean');
  let observed;
  let ok = false;
  try {
    const asApi = (run) => ({ id: run.checkRunId, name: run.name, status: run.conclusion === 'success' ? 'completed' : 'in_progress', conclusion: run.conclusion === 'success' ? 'success' : null, app: { slug: run.app }, check_suite: { id: run.checkSuiteId } });
    const checks = await chain.readRequiredChecks({ workflow, gh: { list: async () => [...legRuns, otherApp, ownRun].map(asApi) } }, SHA, { checkSuiteId: 77 });
    ok = checks.red.length === 0 && checks.pending.length === 0 && checks.missing.length === 0;
    observed = JSON.stringify([checks.red, checks.pending, checks.missing]);
  } catch (error) {
    observed = String(error.message).slice(0, 300);
  }
  record('r2c.chainOtherAppLegNameAccepted', ok, 'the chain accepts the same check runs', observed);
}
await refuses('mc07.standInOutsideRehearsal', 'a rehearsal stand-in record is refused outside a rehearsal', () => verify(dossier({ mutate: (raw) => raw.set('preflight.json', json({ controlFlowTestOnly: true, note: 'stand-in', codeDigest: FACTS.codeDigest, MIGRATION_CORE_CANDIDATE_PREFLIGHT: 'TRUE', facts: {} })) })), 'is a rehearsal stand-in');
await refuses('mc07.noReconstruction', 'a verification without a reconstruction of the commit refuses the archives rather than passing them on their sums', () => verify(dossier(), {}, { facts: { ...FACTS, reconstruction: null } }), 'no reconstruction of commit');
await refuses('mc07.reconstructionFailed', 'a reconstruction that failed is a refusal, never a pass', () => verify(dossier(), {}, { facts: { ...FACTS, reconstruction: { ...RECONSTRUCTION, package: null, problems: ['the commit does not build'] } } }), 'the commit does not build');
await refuses('mc07.oldInventoryVersion', 'a dossier following inventory 1.0.0 is refused: it was verified under rules that accepted the forgeries above', () =>
  verify(dossier({ after: (raw) => reseal(raw, (edited) => {
    const manifest = JSON.parse(edited.get(DOSSIER_MANIFEST_NAME).toString('utf8'));
    manifest.dossierInventoryVersion = '1.0.0';
    edited.set(DOSSIER_MANIFEST_NAME, json(manifest));
  }) })), 'follows inventory 1.0.0');

// Positive controls beside the derivations: the same records, unchanged, are clean one by one.
{
  const made = records(FACTS);
  const clean = [
    ['manifest.json', made.manifest],
    ['provenance.json', made.provenance],
    ['preflight.json', made.preflight],
    ['universe.json', made.universe],
    ['campaign.json', made.campaign],
    ['migration-core-provenance.json', made.releaseProvenance],
    ['sbom.cdx.json', made.sbom],
    ['ci-receipt.json', JSON.parse(receiptBytes.toString('utf8'))],
  ].flatMap(([name, record]) => candidateRecordProblems(name, record, { ...FACTS, receiptSha256: null }).map((problem) => `${name}: ${problem}`));
  record('mc07.recordsCleanOneByOne', clean.length === 0, 'every synthetic record passes its closed schema with its flags derived', clean.join('; ') || 'clean');
  const derived = derivePreflightFlag(made.preflight.facts);
  record('mc07.preflightDerivesTrue', derived.flag === 'TRUE' && derived.problems.length === 0, 'a preflight with every fact true derives TRUE', `${derived.flag} ${derived.problems.join('; ')}`);
  const falsy = derivePreflightFlag({ ...made.preflight.facts, architecture_closed: { value: false, by: 'EXECUTED' } });
  record('mc07.preflightDerivesFalse', falsy.flag === 'FALSE' && falsy.problems.length === 0, 'a preflight with one fact false derives FALSE with no shape problem', `${falsy.flag} ${falsy.problems.join('; ')}`);
}
// Rehearsal stand-ins: accepted in a rehearsal, and still derived there.
{
  const rehearsal = { ...FACTS, controlFlowTestOnly: true, receiptSha256: null };
  const stand = { controlFlowTestOnly: true, note: 'stand-in written by tools/chain.mjs --rehearse; not a candidate record' };
  const ok = [
    ...candidateRecordProblems('manifest.json', { ...stand, codeDigest: FACTS.codeDigest, manifestDigest: FACTS.manifestDigest }, rehearsal),
    ...candidateRecordProblems('preflight.json', { ...stand, codeDigest: FACTS.codeDigest, MIGRATION_CORE_CANDIDATE_PREFLIGHT: 'TRUE', facts: {} }, rehearsal),
    ...candidateRecordProblems('universe.json', { ...stand, candidate: { codeDigest: FACTS.codeDigest, manifestDigest: FACTS.manifestDigest }, passed: true, steps: [] }, rehearsal),
    ...candidateRecordProblems('migration-core-provenance.json', { ...stand, coreVersion: CORE_VERSION, packageFormatVersion: '2.0.0' }, rehearsal),
  ];
  record('mc07.rehearsalStandInsAccepted', ok.length === 0, 'the stand-ins tools/chain.mjs --rehearse writes are accepted in a rehearsal', ok.join('; ') || 'clean');
  const lying = candidateRecordProblems('preflight.json', { ...stand, codeDigest: FACTS.codeDigest, MIGRATION_CORE_CANDIDATE_PREFLIGHT: 'TRUE', facts: { critical: { value: false, by: 'EXECUTED' } } }, rehearsal);
  record('mc07.rehearsalStandInCannotLie', lying.some((problem) => problem.includes('its facts derive FALSE')), 'a stand-in preflight with a false fact cannot carry TRUE even in a rehearsal', lying.join('; ') || 'ACCEPTED');
  const real = candidateRecordProblems('preflight.json', records(FACTS).preflight, rehearsal);
  record('mc07.realRecordInRehearsalRefused', real.length > 0, 'a real preflight is refused inside a rehearsal, which can only have stand-ins', real.join('; ').slice(0, 160) || 'ACCEPTED');
}
// The strict tar reader over the archives the builder writes.
{
  const read = readTarEntries(sourceTgz(), { label: 'source' });
  const inventory = archiveInventory(read.entries, (path) => path.slice(`kauro-migration-core-${SHA}/`.length));
  record('tar.readsWhatTheBuilderWrites', read.problems.length === 0 && JSON.stringify(inventory) === JSON.stringify(RECONSTRUCTION.source), 'the strict reader reads the builder\'s archive to the commit\'s inventory', read.problems.join('; ') || `${String(inventory.length)} entries`);
  const empty = readTarEntries(Buffer.alloc(0), { label: 'empty' });
  record('tar.emptyIsNotAnArchive', empty.problems.length > 0, 'zero bytes are not an archive', empty.problems.join('; ') || 'ACCEPTED');
}

// The records this tree carries, against the closed schemas, with their own
// identity: a producer whose output drifts from what this verifier reads is
// caught here, not at the release.
// Their own identity includes the package format the tree declares: the
// synthetic FACTS above pin 2.0.0 for the refusal cases, and 3.0.0 writes 2.1.0.
{
  const root = new URL('..', import.meta.url);
  const read = (relative) => JSON.parse(readFileSync(new URL(relative, root), 'utf8'));
  const committed = [
    ['manifest.json', 'qualification/candidate/manifest.json'],
    ['provenance.json', 'qualification/candidate/provenance.json'],
    ['preflight.json', 'qualification/candidate/preflight.json'],
    ['universe.json', 'qualification/candidate/universe.json'],
    ['campaign.json', 'qualification/candidate/campaign.json'],
    ['migration-core-provenance.json', 'migration-core-provenance.json'],
  ];
  let observed = 'clean';
  let ok = true;
  try {
    const manifest = read('qualification/candidate/manifest.json');
    const campaign = read('qualification/candidate/campaign.json');
    const own = { ...FACTS, packageFormatVersion: versions.packageFormatVersion, codeDigest: manifest.codeDigest, manifestDigest: manifest.manifestDigest, campaignId: campaign.campaignId, producers: Object.fromEntries(Object.entries(campaign.producers).map(([producer, entry]) => [producer, entry.fingerprint])), reconstruction: null, receiptSha256: null };
    const problems = committed.flatMap(([name, relative]) => candidateRecordProblems(name, read(relative), own).map((problem) => `${name}: ${problem}`));
    ok = problems.length === 0;
    observed = problems.join('; ') || 'clean';
  } catch (error) {
    ok = false;
    observed = String(error.message);
  }
  record('records.committedRecordsPassClosedSchemas', ok, 'the candidate records committed in this tree pass the closed schemas with their own identity', observed.slice(0, 400));
}

// The sums parser, line by line.
const sumsCases = [
  ['sums.crlf', `${'a'.repeat(64)}  x.json\r\n`, 'carriage return'],
  ['sums.blankLine', `${'a'.repeat(64)}  x.json\n\n${'b'.repeat(64)}  y.json\n`, 'blank'],
  ['sums.noFinalNewline', `${'a'.repeat(64)}  x.json`, 'newline'],
  ['sums.oneSpace', `${'a'.repeat(64)} x.json\n`, 'not "<sha256>  <name>"'],
  ['sums.path', `${'a'.repeat(64)}  dir/x.json\n`, 'path'],
  ['sums.binaryMarker', `${'a'.repeat(64)}  *x.json\n`, 'marker'],
  ['sums.duplicate', `${'a'.repeat(64)}  x.json\n${'b'.repeat(64)}  x.json\n`, 'second time'],
  ['sums.self', `${'a'.repeat(64)}  ${SUMS_NAME}\n`, 'itself'],
  ['sums.uppercaseHex', `${'A'.repeat(64)}  x.json\n`, 'not "<sha256>  <name>"'],
  ['sums.empty', '', 'empty'],
];
for (const [id, text, mentions] of sumsCases) {
  const parsed = parseSums(text);
  record(id, parsed.problems.length > 0 && parsed.problems.some((problem) => problem.includes(mentions)), `refused, naming "${mentions}"`, parsed.problems.join('; ') || 'ACCEPTED');
}
{
  const parsed = parseSums(`${'a'.repeat(64)}  x.json\n${'b'.repeat(64)}  y.tgz\n`);
  record('sums.wellFormed', parsed.problems.length === 0 && parsed.entries.size === 2, 'a well-formed file parses to its two entries', parsed.problems.join('; ') || `${String(parsed.entries.size)} entries`);
}
{
  const inventory = dossierInventory({ coreVersion: CORE_VERSION, sha: SHA });
  const names = inventory.map((entry) => entry.name);
  record('inventory.namesUnique', new Set(names).size === names.length && names.includes(SUMS_NAME) && names.includes(DOSSIER_MANIFEST_NAME), 'the inventory names are unique and include the sums and the delivery manifest', names.join(', '));
  let threw = false;
  try {
    dossierInventory({ coreVersion: CORE_VERSION, sha: 'abc' });
  } catch {
    threw = true;
  }
  record('inventory.refusesShortSha', threw, 'an inventory cannot be made for a commit that is not 40 hex characters', threw ? 'refused' : 'ACCEPTED');
}
{
  // dossierProblems is what both the verdict and --verify call; an empty asset list is every asset missing, never "nothing to check".
  const problems = dossierProblems({ inventory: dossierInventory({ coreVersion: CORE_VERSION, sha: SHA }), assets: [], expected: { ...FACTS, receiptSha256: null } });
  record('dossier.emptyIsNotClean', problems.length >= 13, 'an empty release is refused for every missing asset', `${String(problems.length)} problems`);
}

// ------------------------------------------------------------------ report

const failures = cases.filter((entry) => !entry.ok);
const reportAt = process.argv.indexOf('--report');
if (reportAt !== -1) writeFileSync(process.argv[reportAt + 1], `${JSON.stringify(cases, null, 2)}\n`);
process.stdout.write(`RELEASE-DOSSIER-01: ${String(cases.length)} cases, inventory ${DOSSIER_INVENTORY_VERSION}\n\n`);
for (const entry of cases) process.stdout.write(`  ${entry.ok ? 'ok   ' : 'FALSE'} ${entry.id}\n`);
for (const entry of failures) process.stdout.write(`\n  ${entry.id}\n    expected: ${entry.expected}\n    observed: ${entry.observed}\n`);
process.stdout.write(`\nRELEASE-DOSSIER-01 = ${failures.length === 0 ? 'PASS' : 'FALSE'}\n\n`);
process.stdout.write(`${JSON.stringify({ gate: 'RELEASE-DOSSIER-01', checksRun: cases.length, failures: failures.length, passed: failures.length === 0 }, null, 2)}\n`);
process.exit(failures.length === 0 ? 0 : 1);
