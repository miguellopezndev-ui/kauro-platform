#!/usr/bin/env node
/**
 * The release dossier: what a release of this core must carry, built outside
 * the tree it describes and verified byte by byte after download.
 *
 * ---- why the inventory is declared here and not derived from the release ----
 *
 * `release_assets_verified` in the freeze verdict used to read whatever assets
 * the release happened to carry, require each to be named in SHA256SUMS,
 * download it and hash it. That is a proof that the sums match the files. It
 * is not a proof that the files are this candidate's: a release carrying
 * `unrelated.txt` and a matching SHA256SUMS satisfied it, and so did a release
 * whose `immutable` flag was false. The expected inventory is written down
 * here, versioned, with the role and origin of every asset, and the verdict
 * compares against it. Nothing in the inventory is read from the release.
 *
 * ---- what binds the dossier to the candidate ----
 *
 * `dossier-manifest.json` names the repository, the commit, its tree, the
 * versions, the candidate's code and manifest digests, the campaign, the
 * per-producer fingerprints, and every other asset with its size and digest.
 * It is generated after the assets it lists, outside the tree, and it does not
 * hash itself. SHA256SUMS covers every asset including the dossier manifest
 * and does not contain its own hash. The verdict checks the manifest's claims
 * against what it measured in the clean checkout and against the receipt it
 * was handed — a sum uploaded beside a file proves nothing about where the
 * file came from.
 *
 * The final freeze verdict is not an asset. It is decided after publication,
 * about the published release, and an immutable release cannot receive it
 * afterwards; putting it inside would either be a draft verdict masquerading
 * as the final one or a cycle in which the verdict vouches for itself.
 *
 *   node tools/release-dossier.mjs --build --out <dir> --receipt <path> [--tag v2.0.1]
 *   node tools/release-dossier.mjs --verify <dir> --receipt <path> [--sha <sha>] [--tag v2.0.1]
 *   node tools/release-dossier.mjs --verify-remote --tag v2.0.1 --receipt <path> [--allow-draft]
 *
 * `--verify-remote` with `--allow-draft` is the preparation check: it downloads
 * a draft's assets and runs the same verification, and it reports
 * `draft_ready`. It never emits a freeze flag; only the freeze verdict does,
 * and only over a published, immutable release.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

import { DIGEST_SERIALISATION_VERSION, EXCLUDED_DIRECTORIES, EXCLUDED_PATHS, EXCLUSION_RULE_VERSION, MANIFEST_SCHEMA_VERSION, PROVENANCE_SCHEMA_VERSION, codeRecords, digestRecords, measureTree, repoRoot, versions } from './candidate-provenance.mjs';
import { PRODUCERS, measureProducers } from './producer-closure.mjs';
import { RECEIPT_ARTIFACT_KIND, RECEIPT_SCHEMA_VERSION, githubToken, liveCandidate, normaliseRepository, readWorkflow, receiptCheckIdentity, receiptOwnCheckRun } from './receipt-verify.mjs';
import { UNIVERSE_SCHEMA_VERSION, universeReportProblems } from './universe-inventory.mjs';
import { measureSubject } from './execution-subject.mjs';
import { CAMPAIGN_VERSION, readCampaign } from '../qualification/campaign.mjs';
import { packPackage, writeTarGz as writeDeterministicTarGz } from './pack.mjs';

// 1.1.0: the asset list is 1.0.0's; what changed is what a verifier of this
// inventory must prove per asset class (see dossierProblems). A dossier that
// says 1.0.0 was verified under rules that accepted a foreign executable, a
// non-tar archive and a preflight contradicting its own facts, and is refused.
export const DOSSIER_INVENTORY_VERSION = '1.1.0';
export const DOSSIER_MANIFEST_KIND = 'MIGRATION_CORE_RELEASE_DOSSIER';
export const DOSSIER_MANIFEST_NAME = 'dossier-manifest.json';
export const SUMS_NAME = 'SHA256SUMS';
const API_TIMEOUT_MS = 60_000;
const PAGE = 100;

export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * Every asset a release of this core carries, by name, with what it is and
 * where it comes from. The names that depend on the candidate take the core
 * version and the commit; nothing else varies.
 *
 * @param {{coreVersion: string, sha: string}} candidate
 * @returns {ReadonlyArray<{name: string, role: string, kind: string, origin: string}>}
 */
export function dossierInventory({ coreVersion, sha }) {
  if (typeof coreVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(coreVersion)) throw new Error(`a core version is x.y.z, got ${String(coreVersion)}`);
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/u.test(sha)) throw new Error(`a commit is 40 hex characters, got ${String(sha)}`);
  return Object.freeze([
    { name: `kauro-migration-core-${coreVersion}.tgz`, role: 'PACKAGE', kind: 'application/gzip', origin: 'npm pack from the clean checkout at the commit' },
    { name: `source-${sha}.tar.gz`, role: 'SOURCE', kind: 'application/gzip', origin: 'git archive of the commit' },
    { name: 'sbom.cdx.json', role: 'SBOM', kind: 'application/json', origin: 'npm sbom --sbom-format cyclonedx over the lockfile' },
    { name: 'manifest.json', role: 'CANDIDATE_MANIFEST', kind: 'application/json', origin: 'qualification/candidate/manifest.json at the commit' },
    { name: 'provenance.json', role: 'CANDIDATE_PROVENANCE', kind: 'application/json', origin: 'qualification/candidate/provenance.json at the commit' },
    { name: 'preflight.json', role: 'PREFLIGHT', kind: 'application/json', origin: 'qualification/candidate/preflight.json at the commit' },
    { name: 'universe.json', role: 'UNIVERSE', kind: 'application/json', origin: 'qualification/candidate/universe.json at the commit' },
    { name: 'campaign.json', role: 'CAMPAIGN', kind: 'application/json', origin: 'qualification/candidate/campaign.json at the commit' },
    { name: 'migration-core-provenance.json', role: 'RELEASE_PROVENANCE', kind: 'application/json', origin: 'migration-core-provenance.json at the commit' },
    { name: 'ci-receipt.json', role: 'CI_RECEIPT', kind: 'application/json', origin: "downloaded from the merged commit's workflow run, observer-verified" },
    { name: 'evidence.tar.gz', role: 'EVIDENCE', kind: 'application/gzip', origin: 'qualification/evidence and qualification/capacity at the commit' },
    { name: DOSSIER_MANIFEST_NAME, role: 'DELIVERY_MANIFEST', kind: 'application/json', origin: 'written by tools/release-dossier.mjs outside the tree, after the assets it lists' },
    { name: SUMS_NAME, role: 'SUMS', kind: 'text/plain', origin: 'sha256 of every other asset, the delivery manifest included, never itself' },
  ]);
}

/**
 * A strict reader for SHA256SUMS.
 *
 * Every line is `<64 hex>  <name>` with exactly two spaces, one line per name,
 * LF line endings, a final newline, no blank lines, no paths, no binary
 * marker, no duplicate names and no entry for the sums file itself. Anything
 * else is a problem, named; nothing is skipped.
 *
 * @param {string} text
 * @returns {{entries: Map<string, string>, problems: string[]}}
 */
export function parseSums(text) {
  const problems = [];
  const entries = new Map();
  if (typeof text !== 'string') return { entries, problems: ['SHA256SUMS is not text'] };
  if (text === '') return { entries, problems: ['SHA256SUMS is empty'] };
  if (text.includes('\r')) problems.push('SHA256SUMS contains a carriage return');
  if (!text.endsWith('\n')) problems.push('SHA256SUMS does not end with a newline');
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  lines.forEach((line, index) => {
    const at = `line ${String(index + 1)}`;
    if (line === '') {
      problems.push(`${at} is blank`);
      return;
    }
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
    if (match === null) {
      problems.push(`${at} is not "<sha256>  <name>": ${line.slice(0, 80)}`);
      return;
    }
    const [, digest, name] = match;
    if (name !== name.trim()) problems.push(`${at} names "${name}" with surrounding whitespace`);
    if (/[/\\]/u.test(name)) problems.push(`${at} names a path, not a file: ${name}`);
    if (name.startsWith('*') || name.startsWith('-')) problems.push(`${at} carries a marker or option prefix: ${name}`);
    if (name === SUMS_NAME) problems.push(`${at} names ${SUMS_NAME} itself`);
    if (entries.has(name)) problems.push(`${at} names ${name} a second time`);
    entries.set(name, digest);
  });
  return { entries, problems };
}

/**
 * The delivery manifest, from measurements taken in the clean checkout and
 * from the assets already written. It lists the other assets, never itself and
 * never the sums.
 */
export function buildDossierManifest({ repository, sha, gitTree, tag, coreVersion, packageFormatVersion, codeDigest, manifestDigest, subjectDigest, campaignId, producers, assets, builtAt, controlFlowTestOnly = false }) {
  const listed = assets
    .filter((asset) => asset.name !== DOSSIER_MANIFEST_NAME && asset.name !== SUMS_NAME)
    .map((asset) => ({ name: asset.name, role: asset.role, bytes: asset.bytes, sha256: asset.sha256 }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  return {
    artifactKind: DOSSIER_MANIFEST_KIND,
    dossierInventoryVersion: DOSSIER_INVENTORY_VERSION,
    repository,
    sha,
    gitTree,
    tag,
    versions: { coreVersion, packageFormatVersion },
    codeDigest,
    manifestDigest,
    subjectDigest,
    campaignId,
    producers,
    assets: listed,
    builtAt,
    builtBy: 'tools/release-dossier.mjs',
    // A dossier built from stand-in records in a rehearsal says so in its own
    // manifest, and the verifier refuses it outside a rehearsal.
    ...(controlFlowTestOnly ? { controlFlowTestOnly: true } : {}),
  };
}

/**
 * Bounds on what an archive asset may make this verifier read. A dossier is a
 * few tens of megabytes; an archive that decompresses past these is refused
 * before it is decompressed that far, whatever its declared sums say.
 */
export const ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;
export const ARCHIVE_MAX_ENTRY_BYTES = 256 * 1024 * 1024;
export const ARCHIVE_MAX_ENTRIES = 20_000;

const TAR_FILE_TYPES = new Set(['0', '\0', '7']);

function tarOctal(field) {
  const text = field.toString('utf8').replace(/\0.*$/su, '').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/u.test(text)) return null;
  return parseInt(text, 8);
}

function tarString(field) {
  return field.toString('utf8').replace(/\0.*$/su, '');
}

/**
 * Whether a member path could name something outside the extraction root or
 * two things at once. Absolute paths, drive letters, backslashes, `.` and
 * `..` segments, empty segments and control characters are all refused.
 */
export function archivePathProblem(path) {
  if (typeof path !== 'string' || path === '') return 'is empty';
  if (path.includes('\0')) return 'contains a NUL byte';
  if (/[\u0000-\u001f\u007f]/u.test(path)) return 'contains a control character';
  if (path.includes('\\')) return 'contains a backslash';
  if (path.startsWith('/')) return 'is absolute';
  if (/^[A-Za-z]:/u.test(path)) return 'names a drive';
  const segments = path.replace(/\/$/u, '').split('/');
  if (segments.some((segment) => segment === '')) return 'has an empty segment';
  if (segments.some((segment) => segment === '.' || segment === '..')) return 'has a . or .. segment';
  return null;
}

/**
 * A ustar/pax reader that refuses what it does not understand.
 *
 * Every header is checksummed and must carry the ustar magic; every size must
 * be an octal number that fits inside the archive and inside the bounds above;
 * every path must be safe to extract; a path may appear once. Regular files
 * and directories are read; pax extended headers are honoured for `path` and
 * `size` and a pax global header is kept as `global` (git archive writes the
 * commit id there); links, devices, FIFOs and unknown types are problems.
 * Nothing is skipped silently: anything the reader cannot account for is a
 * problem, and the caller decides that a problem list is a refusal.
 *
 * @param {Buffer} gzBytes
 * @param {{label?: string}} [options]
 * @returns {{entries: Map<string, {type: 'file'|'directory', bytes: Buffer}>, global: Record<string, string>, problems: string[]}}
 */
export function readTarEntries(gzBytes, { label = 'the archive' } = {}) {
  const problems = [];
  const entries = new Map();
  const global = {};
  if (!Buffer.isBuffer(gzBytes)) return { entries, global, problems: [`${label} is not bytes`] };
  if (gzBytes.length < 18 || gzBytes[0] !== 0x1f || gzBytes[1] !== 0x8b) return { entries, global, problems: [`${label} is not gzip: it does not start with the gzip magic`] };
  let tar;
  try {
    tar = gunzipSync(gzBytes, { maxOutputLength: ARCHIVE_MAX_BYTES });
  } catch (error) {
    return { entries, global, problems: [`${label} is not a readable gzip stream: ${String(error.code ?? error.message)}`] };
  }
  if (tar.length === 0 || tar.length % 512 !== 0) {
    problems.push(`${label} decompresses to ${String(tar.length)} bytes, which is not a whole number of tar blocks`);
    return { entries, global, problems };
  }
  let offset = 0;
  let pending = null;
  let count = 0;
  let sawEnd = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      sawEnd = true;
      break;
    }
    const at = `${label} entry at block ${String(offset / 512)}`;
    let expected = 0;
    for (let index = 0; index < 512; index += 1) expected += index >= 148 && index < 156 ? 32 : header[index];
    const declared = tarOctal(header.subarray(148, 156));
    if (declared === null || declared !== expected) {
      problems.push(`${at} fails its header checksum; ${label} is not a tar archive`);
      return { entries, global, problems };
    }
    if (tarString(header.subarray(257, 262)) !== 'ustar') {
      problems.push(`${at} carries no ustar magic; ${label} is not a ustar/pax archive`);
      return { entries, global, problems };
    }
    const size = tarOctal(header.subarray(124, 136));
    if (size === null) {
      problems.push(`${at} declares a size that is not octal`);
      return { entries, global, problems };
    }
    const type = String.fromCharCode(header[156]);
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    offset += 512;
    if (size > ARCHIVE_MAX_ENTRY_BYTES) {
      problems.push(`${at} declares ${String(size)} bytes, over the ${String(ARCHIVE_MAX_ENTRY_BYTES)} byte bound`);
      return { entries, global, problems };
    }
    if (offset + size > tar.length) {
      problems.push(`${at} declares ${String(size)} bytes and ${label} ends after ${String(tar.length - offset)}; truncated`);
      return { entries, global, problems };
    }
    const body = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'g') {
      const parsed = parsePaxRecords(body);
      if (parsed === null) {
        problems.push(`${at} is a pax header that does not parse`);
        return { entries, global, problems };
      }
      if (type === 'g') Object.assign(global, parsed);
      else pending = parsed;
      continue;
    }
    let path = prefix === '' ? name : `${prefix}/${name}`;
    let bytes = body;
    if (pending !== null) {
      if (typeof pending.path === 'string') path = pending.path;
      if (typeof pending.size === 'string' && Number(pending.size) !== size) {
        problems.push(`${at} (${path}) has a pax size that disagrees with its header`);
        return { entries, global, problems };
      }
      pending = null;
    }
    const pathProblem = archivePathProblem(path);
    if (pathProblem !== null) {
      problems.push(`${at} has a path that ${pathProblem}: ${JSON.stringify(path.slice(0, 80))}`);
      return { entries, global, problems };
    }
    count += 1;
    if (count > ARCHIVE_MAX_ENTRIES) {
      problems.push(`${label} has more than ${String(ARCHIVE_MAX_ENTRIES)} entries`);
      return { entries, global, problems };
    }
    if (type === '5') {
      const dir = path.replace(/\/$/u, '');
      if (size !== 0) problems.push(`${at} is a directory (${dir}) with ${String(size)} bytes of content`);
      if (entries.has(dir)) problems.push(`${label} names ${dir} twice`);
      entries.set(dir, { type: 'directory', bytes: Buffer.alloc(0) });
      continue;
    }
    if (!TAR_FILE_TYPES.has(type)) {
      problems.push(`${at} (${path}) is of type ${JSON.stringify(type)}; only regular files and directories are read`);
      return { entries, global, problems };
    }
    if (path.endsWith('/')) {
      problems.push(`${at} is a file whose path ends in a slash: ${path}`);
      return { entries, global, problems };
    }
    if (entries.has(path)) problems.push(`${label} names ${path} twice`);
    entries.set(path, { type: 'file', bytes });
  }
  if (!sawEnd) problems.push(`${label} has no end-of-archive marker`);
  return { entries, global, problems };
}

function parsePaxRecords(body) {
  const out = {};
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space === -1) return null;
    const length = Number(body.subarray(at, space).toString('utf8'));
    if (!Number.isInteger(length) || length <= 0 || at + length > body.length) return null;
    const record = body.subarray(space + 1, at + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals === -1) return null;
    out[record.slice(0, equals)] = record.slice(equals + 1);
    at += length;
  }
  return out;
}

/**
 * The files of an archive as a sorted inventory: path, size, digest. Two
 * archives with the same inventory carry the same files with the same bytes,
 * whatever their gzip framing, header order or mtimes say.
 *
 * @param {Map<string, {type: string, bytes: Buffer}>} entries
 * @param {(path: string) => string|null} [rename] map a path, or drop it with null
 * @returns {Array<{path: string, bytes: number, sha256: string}>}
 */
export function archiveInventory(entries, rename = (path) => path) {
  const out = [];
  for (const [path, entry] of entries) {
    if (entry.type !== 'file') continue;
    const renamed = rename(path);
    if (renamed === null) continue;
    out.push({ path: renamed, bytes: entry.bytes.length, sha256: sha256(entry.bytes) });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Every way one inventory differs from another, as problems naming the
 * asset: entries the asset has and the reconstruction does not, entries it
 * lacks, and entries whose bytes differ.
 */
export function inventoryDifferences(label, actual, expected) {
  const problems = [];
  const have = new Map(actual.map((entry) => [entry.path, entry]));
  const want = new Map(expected.map((entry) => [entry.path, entry]));
  for (const [path, entry] of want) {
    const found = have.get(path);
    if (found === undefined) problems.push(`${label} lacks ${path}, which the reconstruction of the commit carries`);
    else if (found.sha256 !== entry.sha256 || found.bytes !== entry.bytes) problems.push(`${label} entry ${path} differs from the reconstruction of the commit (${String(found.bytes)} bytes, ${found.sha256.slice(0, 16)} vs ${String(entry.bytes)} bytes, ${entry.sha256.slice(0, 16)})`);
  }
  for (const path of have.keys()) if (!want.has(path)) problems.push(`${label} carries ${path}, which the reconstruction of the commit does not`);
  return problems;
}

/**
 * Member names and bytes of a gzip'd tar, for callers that want a map and a
 * throw. Everything the strict reader refuses is thrown, nothing is skipped.
 */
export function tarMembers(gzBytes) {
  const read = readTarEntries(gzBytes);
  if (read.problems.length > 0) throw new Error(read.problems[0]);
  const members = new Map();
  for (const [path, entry] of read.entries) if (entry.type === 'file') members.set(path, entry.bytes);
  return members;
}

/**
 * A gzip'd ustar archive of the given files, written here rather than by
 * whichever `tar` is first on the PATH: GNU tar reads `C:\\…` as a remote
 * host, bsdtar and GNU tar disagree on defaults, and an archive whose bytes
 * depend on the machine cannot be reproduced. Entries are sorted by path,
 * mtime is zero, mode is 0644, owner is nobody.
 *
 * @param {ReadonlyArray<{path: string, bytes: Buffer}>} files
 */
export function writeTarGz(files) {
  // tools/pack.mjs: the same ustar layout, compressed by a pinned pure-JavaScript
  // deflate, so the archive's bytes no longer depend on the zlib a Node links.
  return writeDeterministicTarGz(files);
}

function filesUnder(root, relativeDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else out.push({ path: rel, bytes: readFileSync(join(root, rel)) });
    }
  };
  walk(relativeDir);
  return out;
}

// ------------------------------------------------------------ record schemas

const HEX40 = /^[0-9a-f]{40}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const SEMVER = /^\d+\.\d+\.\d+$/u;
const CAMPAIGN_ID = /^c_[0-9a-f]{16}$/u;

/** The preflight record this verifier reads, and the closed set of facts it must answer. */
export const PREFLIGHT_SCHEMA_VERSION = '1.0.0';
export const PREFLIGHT_FACT_NAMES = Object.freeze([
  'architecture_closed',
  'offline_release_universe_passed',
  'spec_and_document_drift_absent',
  'source_registry_current',
  'declared_versions_at_or_above_floor',
  'hubspot_target_current',
  'salesforce_target_current',
  'salesforce_ocr_disposition_current',
  'crm_attestation_required_by_default',
  'capacity_hubspot_1m_representative',
  'capacity_salesforce_1m_representative',
  'capacity_clean_only_1m_representative',
  'capacity_profiles_matrix_complete',
  'memory_budget_passed',
  'scratch_budget_passed',
  'scratch_amplification_explained',
  'wall_clock_passed',
  'candidate_bytes_deterministic',
  'package_verify_and_attest_passed',
  'evidence_bound_to_exact_candidate',
  'secrets_and_customer_data_absent',
  'candidate_provenance_valid',
]);
export const PREFLIGHT_FACT_DERIVATIONS = Object.freeze(['EXECUTED', 'EVIDENCE_VERIFIED', 'MEASURED', 'INSTRUMENTED']);
export const RELEASE_PROVENANCE_VERSION = '2';
export const SBOM_FORMAT = 'CycloneDX';

const typeName = (value) => (value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value);
const is = {
  string: (value) => (typeof value === 'string' && value !== '' ? null : `is ${typeName(value)}, not a non-empty string`),
  boolean: (value) => (typeof value === 'boolean' ? null : `is ${typeName(value)}, not a boolean`),
  integer: (value) => (Number.isInteger(value) && value >= 0 ? null : `is ${String(value)}, not a non-negative integer`),
  array: (value) => (Array.isArray(value) ? null : `is ${typeName(value)}, not an array`),
  object: (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? null : `is ${typeName(value)}, not an object`),
  hex40: (value) => (typeof value === 'string' && HEX40.test(value) ? null : `is ${JSON.stringify(value)}, not a commit id`),
  hex64: (value) => (typeof value === 'string' && HEX64.test(value) ? null : `is ${JSON.stringify(value)}, not a sha256`),
  semver: (value) => (typeof value === 'string' && SEMVER.test(value) ? null : `is ${JSON.stringify(value)}, not x.y.z`),
  equals: (expected, what = null) => (value) => (value === expected ? null : `is ${JSON.stringify(value)}, ${what ?? `not ${JSON.stringify(expected)}`}`),
  isTrue: (value) => (value === true ? null : `is ${JSON.stringify(value)}, not true`),
  nullable: (check) => (value) => (value === null ? null : check(value)),
  any: () => null,
};

/**
 * A record against a closed schema: every named field present and of its
 * type, no field the schema does not name, and never a null, an array or a
 * scalar where a record was expected. A record that fails here is refused
 * before any of its values are compared with the candidate.
 *
 * @param {unknown} record
 * @param {string} label
 * @param {Record<string, (value: unknown) => string|null>} fields
 * @param {{optional?: string[]}} [options]
 * @returns {string[]}
 */
export function recordShapeProblems(record, label, fields, { optional = [] } = {}) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return [`${label} is ${typeName(record)}, not a record`];
  const problems = [];
  for (const [key, check] of Object.entries(fields)) {
    if (!Object.hasOwn(record, key)) {
      if (!optional.includes(key)) problems.push(`${label} has no ${key}`);
      continue;
    }
    const problem = check(record[key]);
    if (problem !== null) problems.push(`${label}.${key} ${problem}`);
  }
  for (const key of Object.keys(record)) if (!Object.hasOwn(fields, key)) problems.push(`${label} carries ${key}, which its schema does not name`);
  return problems;
}

/** The stand-in a rehearsal writes: marked, and bound to the measured digests, nothing more. */
function standInProblems(record, label, fields) {
  return recordShapeProblems(record, label, { controlFlowTestOnly: is.isTrue, note: is.string, ...fields });
}

/**
 * The preflight's flag, derived from its facts. TRUE only when every fact of
 * the closed list is present, decided here, and true; the outer flag must say
 * the same, and a preflight whose facts contain FALSE cannot carry TRUE.
 */
export function derivePreflightFlag(facts, { factNames = PREFLIGHT_FACT_NAMES, closed = true } = {}) {
  const problems = [];
  if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) return { flag: 'FALSE', problems: [`preflight.json.facts is ${typeName(facts)}, not a record of facts`] };
  let allTrue = true;
  for (const [name, entry] of Object.entries(facts)) {
    if (closed && !factNames.includes(name)) problems.push(`preflight.json answers ${name}, which is not a preflight fact`);
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`preflight.json fact ${name} is ${typeName(entry)}, not {value, by}`);
      allTrue = false;
      continue;
    }
    const shape = recordShapeProblems(entry, `preflight.json fact ${name}`, { value: is.boolean, by: (value) => (PREFLIGHT_FACT_DERIVATIONS.includes(value) ? null : `is ${JSON.stringify(value)}, not a derivation this verifier knows`) });
    problems.push(...shape);
    if (entry.value !== true) allTrue = false;
  }
  if (closed) for (const name of factNames) if (!Object.hasOwn(facts, name)) problems.push(`preflight.json does not answer ${name}`);
  if (closed && Object.keys(facts).length === 0) allTrue = false;
  return { flag: allTrue && problems.length === 0 ? 'TRUE' : 'FALSE', problems };
}

/**
 * Every candidate record, against its closed schema, with its flags derived
 * from its facts and its identity compared with the candidate. In a rehearsal
 * the records are the stand-ins tools/chain.mjs writes, marked as such; a
 * stand-in outside a rehearsal, or a real record inside one, is refused.
 *
 * @param {string} name the asset name
 * @param {unknown} record the parsed JSON
 * @param {object} expected the candidate facts
 * @returns {string[]}
 */
export function candidateRecordProblems(name, record, expected) {
  const rehearsal = expected.controlFlowTestOnly === true;
  const problems = [];
  if (record !== null && typeof record === 'object' && !Array.isArray(record) && record.controlFlowTestOnly === true && !rehearsal) problems.push(`${name} is a rehearsal stand-in, not a candidate record`);
  // Identity, in the record's own fields, before any schema: a record for
  // another candidate is refused by name whatever else is wrong with it.
  // The campaign is the exception: its codeDigest is the code at seal time,
  // and the repository binds a campaign to a candidate per producer
  // fingerprint, deliberately, not by whole-tree digest (see freeze-verdict's
  // campaign_covers_this_subject).
  if (record !== null && typeof record === 'object' && !Array.isArray(record)) {
    if (name !== 'campaign.json' && Object.hasOwn(record, 'codeDigest') && record.codeDigest !== expected.codeDigest) problems.push(`${name} is for code digest ${String(record.codeDigest).slice(0, 16)}, not ${String(expected.codeDigest).slice(0, 16)}`);
    if (Object.hasOwn(record, 'manifestDigest') && record.manifestDigest !== expected.manifestDigest) problems.push(`${name} is for manifest digest ${String(record.manifestDigest).slice(0, 16)}, not ${String(expected.manifestDigest).slice(0, 16)}`);
    if (Object.hasOwn(record, 'coreVersion') && record.coreVersion !== expected.coreVersion) problems.push(`${name} is for core ${String(record.coreVersion)}, not ${expected.coreVersion}`);
    if (Object.hasOwn(record, 'packageFormatVersion') && record.packageFormatVersion !== expected.packageFormatVersion) problems.push(`${name} is for package format ${String(record.packageFormatVersion)}, not ${expected.packageFormatVersion}`);
  }
  const codeDigest = is.hex64;
  const manifestDigest = is.hex64;
  const coreVersion = is.semver;
  const packageFormatVersion = is.semver;

  if (name === 'manifest.json') {
    if (rehearsal) return [...problems, ...standInProblems(record, name, { codeDigest, manifestDigest })];
    problems.push(
      ...recordShapeProblems(record, name, {
        schemaVersion: is.equals(MANIFEST_SCHEMA_VERSION),
        artifactKind: is.equals('MIGRATION_CORE_CANDIDATE_MANIFEST'),
        codeDigest,
        codeFileCount: is.integer,
        digestSerialisationVersion: is.equals(DIGEST_SERIALISATION_VERSION),
        exclusionRuleVersion: is.equals(EXCLUSION_RULE_VERSION),
        exclusion: is.object,
        digestOver: is.string,
        fileCount: is.integer,
        totalBytes: is.integer,
        manifestDigest,
        files: is.array,
      }),
    );
    if (problems.length > 0) return problems;
    // The digests, derived from the table the record carries, not read from
    // its header; and the table, compared with the commit's own files.
    const files = record.files;
    const rows = files.every((row) => row !== null && typeof row === 'object' && typeof row.path === 'string' && HEX64.test(String(row.sha256)) && Number.isInteger(row.bytes));
    if (!rows) return [`${name} carries a files table with rows that are not {path, sha256, bytes}`];
    if (files.length !== record.fileCount) problems.push(`${name} states ${String(record.fileCount)} files and carries ${String(files.length)}`);
    const code = codeRecords(files);
    if (code.length !== record.codeFileCount) problems.push(`${name} states ${String(record.codeFileCount)} code files and its table has ${String(code.length)}`);
    try {
      const table = digestRecords('manifest', files);
      const codeTable = digestRecords('code', code);
      if (table !== record.manifestDigest) problems.push(`${name} states manifest digest ${record.manifestDigest.slice(0, 16)} and its own table derives ${table.slice(0, 16)}`);
      if (codeTable !== record.codeDigest) problems.push(`${name} states code digest ${record.codeDigest.slice(0, 16)} and its own table derives ${codeTable.slice(0, 16)}`);
    } catch (error) {
      problems.push(`${name} table cannot be serialised: ${String(error.message)}`);
    }
    const exclusion = recordShapeProblems(record.exclusion, `${name}.exclusion`, { directories: is.array, paths: is.array });
    problems.push(...exclusion);
    if (exclusion.length === 0) {
      if (JSON.stringify(record.exclusion.directories) !== JSON.stringify(EXCLUDED_DIRECTORIES)) problems.push(`${name} excludes directories ${JSON.stringify(record.exclusion.directories)}, rule ${EXCLUSION_RULE_VERSION} excludes ${JSON.stringify(EXCLUDED_DIRECTORIES)}`);
      if (JSON.stringify(record.exclusion.paths) !== JSON.stringify(EXCLUDED_PATHS)) problems.push(`${name} excludes paths ${JSON.stringify(record.exclusion.paths)}, rule ${EXCLUSION_RULE_VERSION} excludes ${JSON.stringify(EXCLUDED_PATHS)}`);
    }
    const source = expected.reconstruction?.source ?? null;
    if (Array.isArray(source)) {
      const excluded = (path) => EXCLUDED_PATHS.includes(path) || EXCLUDED_DIRECTORIES.some((dir) => path.startsWith(`${dir}/`));
      const commitFiles = source.filter((entry) => !excluded(entry.path)).map((entry) => ({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 }));
      const table = files.map((row) => ({ path: row.path, bytes: row.bytes, sha256: row.sha256 })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      problems.push(...inventoryDifferences(`${name} files table`, table, commitFiles).map((problem) => problem.replace('the reconstruction of the commit', `the commit ${String(expected.sha).slice(0, 12)}`)));
    }
    return problems;
  }

  if (name === 'provenance.json') {
    if (rehearsal) return [...problems, ...standInProblems(record, name, { codeDigest, manifestDigest })];
    return [
      ...problems,
      ...recordShapeProblems(record, name, {
        schemaVersion: is.equals(PROVENANCE_SCHEMA_VERSION),
        artifactKind: is.equals('MIGRATION_CORE_CANDIDATE_PROVENANCE'),
        generator: is.equals('tools/candidate-provenance.mjs'),
        coreVersion,
        packageVersion: is.semver,
        packageFormatVersion,
        sourceRegistryVersion: is.string,
        manifestDigest,
        codeDigest,
        manifestFileCount: is.integer,
        digestSerialisationVersion: is.equals(DIGEST_SERIALISATION_VERSION),
        exclusionRuleVersion: is.equals(EXCLUSION_RULE_VERSION),
        dependencies: is.object,
        authorities: is.array,
        researchSnapshot: is.object,
        capacityEvidence: is.array,
        vendorEvidence: is.array,
        supersedes: is.string,
        knownExclusions: is.array,
        freezeDecision: is.object,
      }, { optional: ['supersedes'] }),
    ];
  }

  if (name === 'preflight.json') {
    const flagField = (value) => (value === 'TRUE' || value === 'FALSE' ? null : `is ${JSON.stringify(value)}, neither TRUE nor FALSE`);
    if (rehearsal) {
      problems.push(...standInProblems(record, name, { codeDigest, facts: is.object, MIGRATION_CORE_CANDIDATE_PREFLIGHT: flagField }));
    } else {
      problems.push(
        ...recordShapeProblems(record, name, {
          schemaVersion: is.equals(PREFLIGHT_SCHEMA_VERSION),
          artifactKind: is.equals('MIGRATION_CORE_CANDIDATE_PREFLIGHT'),
          gate: is.equals('RELEASE-CANDIDATE-01'),
          digestSerialisationVersion: is.equals(DIGEST_SERIALISATION_VERSION),
          manifestDigest,
          codeDigest,
          versions: is.object,
          treeClean: is.isTrue,
          treeCleanExcludes: is.array,
          decidedElsewhere: is.array,
          facts: is.object,
          MIGRATION_CORE_CANDIDATE_PREFLIGHT: flagField,
        }),
      );
      if (record !== null && typeof record === 'object' && record.versions !== null && typeof record.versions === 'object') {
        if (record.versions.coreVersion !== expected.coreVersion) problems.push(`${name}.versions.coreVersion is ${JSON.stringify(record.versions.coreVersion)}, not ${expected.coreVersion}`);
        if (record.versions.packageFormatVersion !== expected.packageFormatVersion) problems.push(`${name}.versions.packageFormatVersion is ${JSON.stringify(record.versions.packageFormatVersion)}, not ${expected.packageFormatVersion}`);
      }
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return problems;
    // The flag is derived, never read. A stand-in answers no facts, so its
    // set is not closed; it still may not contain FALSE and carry TRUE.
    const derived = derivePreflightFlag(record.facts, { closed: !rehearsal });
    problems.push(...derived.problems);
    const stated = record.MIGRATION_CORE_CANDIDATE_PREFLIGHT;
    if (stated !== derived.flag) problems.push(`${name} is ${String(stated)} and its facts derive ${derived.flag}`);
    if (derived.flag !== 'TRUE') problems.push(`${name} is ${derived.flag}: a fact is missing, malformed or false`);
    return problems;
  }

  if (name === 'universe.json') {
    if (record !== null && typeof record === 'object' && !Array.isArray(record) && record.passed !== true) problems.push(`${name} did not pass`);
    if (rehearsal) {
      problems.push(...standInProblems(record, name, { candidate: is.object, passed: is.boolean, steps: is.array }));
      if (problems.length > 0) return problems;
      if (record.candidate.codeDigest !== expected.codeDigest) problems.push(`${name} is for code digest ${String(record.candidate.codeDigest).slice(0, 16)}`);
      if (record.candidate.manifestDigest !== expected.manifestDigest) problems.push(`${name} is for manifest digest ${String(record.candidate.manifestDigest).slice(0, 16)}`);
      const derived = record.steps.every((step) => step !== null && typeof step === 'object' && step.ok === true && step.status === 'ok');
      if (record.passed !== derived) problems.push(`${name} says passed ${String(record.passed)} and its steps derive ${String(derived)}`);
      if (!derived && record.passed === true) problems.push(`${name} did not pass`);
      return problems;
    }
    problems.push(
      ...recordShapeProblems(record, name, {
        schemaVersion: is.equals(UNIVERSE_SCHEMA_VERSION),
        gate: is.equals('OFFLINE-UNIVERSE'),
        scope: is.equals('FULL'),
        platform: is.string,
        node: is.string,
        candidate: is.object,
        steps: is.array,
        passed: is.boolean,
      }),
    );
    if (problems.length > 0) return problems;
    problems.push(
      ...recordShapeProblems(record.candidate, `${name}.candidate`, {
        manifestDigest,
        codeDigest,
        codeFileCount: is.integer,
        fileCount: is.integer,
        digestSerialisationVersion: is.equals(DIGEST_SERIALISATION_VERSION),
        exclusionRuleVersion: is.equals(EXCLUSION_RULE_VERSION),
      }),
    );
    // The universe binds to the candidate through these two digests, which is
    // why the campaign does not bind it (D77): they must be this candidate's.
    if (problems.length === 0 && record.candidate.codeDigest !== expected.codeDigest) problems.push(`${name} ran over code digest ${record.candidate.codeDigest.slice(0, 16)}, not ${String(expected.codeDigest).slice(0, 16)}`);
    if (problems.length === 0 && record.candidate.manifestDigest !== expected.manifestDigest) problems.push(`${name} ran over manifest digest ${record.candidate.manifestDigest.slice(0, 16)}, not ${String(expected.manifestDigest).slice(0, 16)}`);
    // The inventory reader decides what a passing universe is; `passed` must agree with it.
    const report = universeReportProblems(record).map((problem) => `${name}: ${problem}`);
    problems.push(...report);
    const derived = report.length === 0 && record.steps.every((step) => step.ok === true);
    if (record.passed !== derived) problems.push(`${name} says passed ${String(record.passed)} and its steps derive ${String(derived)}`);
    if (!derived && record.passed === true) problems.push(`${name} did not pass`);
    return problems;
  }

  if (name === 'campaign.json') {
    if (record !== null && typeof record === 'object' && !Array.isArray(record) && record.campaignId !== expected.campaignId) problems.push(`${name} is campaign ${String(record.campaignId)}, not ${String(expected.campaignId)}`);
    problems.push(
      ...recordShapeProblems(record, name, {
        campaignVersion: is.equals(CAMPAIGN_VERSION),
        artifactKind: is.equals('MIGRATION_CORE_CAMPAIGN'),
        campaignId: (value) => (typeof value === 'string' && CAMPAIGN_ID.test(value) ? null : `is ${JSON.stringify(value)}, not a campaign id`),
        sealedAt: is.string,
        subjectDigest: is.hex64,
        subjectVersion: is.semver,
        codeDigest: is.hex64,
        versions: is.object,
        classes: is.object,
        dependencies: is.object,
        producers: is.object,
        note: is.string,
      }, { optional: ['note'] }),
    );
    if (problems.length > 0) return problems;
    if (record.versions.coreVersion !== expected.coreVersion) problems.push(`${name}.versions.coreVersion is ${JSON.stringify(record.versions.coreVersion)}, not ${expected.coreVersion}`);
    if (record.versions.packageFormatVersion !== expected.packageFormatVersion) problems.push(`${name}.versions.packageFormatVersion is ${JSON.stringify(record.versions.packageFormatVersion)}, not ${expected.packageFormatVersion}`);
    for (const [producer, entry] of Object.entries(record.producers)) {
      const shape = recordShapeProblems(entry, `${name}.producers[${producer}]`, { fingerprint: is.hex64, files: is.integer, kind: is.string });
      problems.push(...shape);
      // The universe is sealed for the record and not for the binding, as in
      // tools/seal-campaign.mjs --check and the release gate (D77): it binds
      // through the manifest and code digests universe.json records. Only a
      // producer the closure itself declares UNIVERSE is excused; one that
      // merely calls itself so in the campaign still binds.
      const universe = shape.length === 0 && entry.kind === 'UNIVERSE' && PRODUCERS[producer]?.kind === 'UNIVERSE';
      if (shape.length === 0 && !universe && Object.hasOwn(expected.producers ?? {}, producer) && expected.producers[producer] !== entry.fingerprint) problems.push(`${name} seals ${producer} at ${entry.fingerprint.slice(0, 16)}, the candidate measures ${String(expected.producers[producer]).slice(0, 16)}`);
    }
    return problems;
  }

  if (name === 'migration-core-provenance.json') {
    if (rehearsal) return [...problems, ...standInProblems(record, name, { coreVersion, packageFormatVersion })];
    problems.push(
      ...recordShapeProblems(record, name, {
        artifactKind: is.equals('MIGRATION_CORE_PROVENANCE'),
        provenanceVersion: is.equals(RELEASE_PROVENANCE_VERSION),
        coreVersion,
        packageVersion: is.semver,
        packageFormatVersion,
        sourceRegistryVersion: is.string,
        campaign: is.object,
        freezeDecision: is.object,
        gatesAllPass: is.boolean,
        supportEnvelope: is.object,
        resourceContract: is.object,
        capacity: is.array,
        gates: is.array,
        evidence: is.array,
        inventoryProblems: is.array,
        doesNotClaim: is.array,
      }),
    );
    if (problems.length > 0) return problems;
    if (record.campaign.campaignId !== expected.campaignId) problems.push(`${name} is for campaign ${String(record.campaign.campaignId)}, not ${String(expected.campaignId)}`);
    if (record.freezeDecision.outsideTree !== true || record.freezeDecision.decidedBy !== 'tools/freeze-verdict.mjs') problems.push(`${name} does not leave the freeze decision to tools/freeze-verdict.mjs outside the tree`);
    // Derived: every gate PASS, every required evidence present, no inventory problems.
    const gates = record.gates.every((gate) => gate !== null && typeof gate === 'object' && gate.state === 'PASS');
    const evidence = record.evidence.every((entry) => entry !== null && typeof entry === 'object' && (entry.required !== true || entry.present === true));
    const derived = gates && evidence && record.inventoryProblems.length === 0 && record.gates.length > 0;
    if (record.gatesAllPass !== derived) problems.push(`${name} says gatesAllPass ${String(record.gatesAllPass)} and its gates, evidence and inventory derive ${String(derived)}`);
    if (!derived) problems.push(`${name} does not establish that every gate passed`);
    return problems;
  }

  if (name === 'ci-receipt.json') {
    if (record !== null && typeof record === 'object' && !Array.isArray(record) && record.sha !== expected.sha) problems.push(`${name} attests ${String(record.sha).slice(0, 12)}, not ${String(expected.sha).slice(0, 12)}`);
    problems.push(
      ...recordShapeProblems(record, name, {
        schemaVersion: is.equals(RECEIPT_SCHEMA_VERSION),
        artifactKind: is.equals(RECEIPT_ARTIFACT_KIND),
        generator: is.string,
        repository: is.string,
        sha: is.hex40,
        gitTree: is.hex40,
        ref: is.string,
        branch: is.nullable(is.string),
        eventName: is.string,
        workflow: is.string,
        runId: is.string,
        runNumber: is.nullable(is.string),
        runAttempt: is.string,
        manifestDigest,
        codeDigest,
        digestSerialisationVersion: is.equals(DIGEST_SERIALISATION_VERSION),
        exclusionRuleVersion: is.equals(EXCLUSION_RULE_VERSION),
        versions: is.object,
        node: is.string,
        runnerOs: is.nullable(is.string),
        requiredJobs: is.array,
        checkRuns: is.array,
        reruns: is.array,
      }),
    );
    if (problems.length > 0) return problems;
    if (typeof expected.gitTree === 'string' && record.gitTree !== expected.gitTree) problems.push(`${name} attests tree ${record.gitTree.slice(0, 12)}, the commit's tree is ${expected.gitTree.slice(0, 12)}`);
    if (record.repository !== expected.repository) problems.push(`${name} is for ${record.repository}, not ${String(expected.repository)}`);
    if (record.versions.coreVersion !== expected.coreVersion) problems.push(`${name}.versions.coreVersion is ${JSON.stringify(record.versions.coreVersion)}, not ${expected.coreVersion}`);
    // Derived: the receipt is green only if every required job and every check run it recorded concluded success on this commit.
    if (record.requiredJobs.length === 0) problems.push(`${name} records no required jobs`);
    for (const job of record.requiredJobs) if (job === null || typeof job !== 'object' || job.result !== 'success') problems.push(`${name} records required job ${String(job?.name)} as ${String(job?.result)}`);
    if (record.checkRuns.length === 0) problems.push(`${name} records no check runs`);
    // The receipt is written by its own job, inside the run it describes, so
    // that job's check run is necessarily unfinished in it; receipt-verify
    // excuses it by its job's id, and the chain's receipt-observe proves the
    // finished run, that job included, green from outside (D77). Here, from the
    // receipt alone: exactly one entry, identified by more than its name (see
    // receiptOwnCheckRun). Anything else must be success.
    const own = receiptOwnCheckRun(record, { receiptJobName: expected.receiptJobName, requiredCheckNames: expected.requiredCheckNames });
    for (const run of record.checkRuns) {
      if (run === null || typeof run !== 'object') {
        problems.push(`${name} records a check run that is not a record`);
        continue;
      }
      if (run.conclusion !== 'success' && run !== own) problems.push(`${name} records check run ${String(run.name)} as ${String(run.conclusion)}`);
      if (run.headSha !== null && run.headSha !== expected.sha) problems.push(`${name} records check run ${String(run.name)} on ${String(run.headSha).slice(0, 12)}, not this commit`);
    }
    return problems;
  }

  if (name === 'sbom.cdx.json') {
    problems.push(
      ...recordShapeProblems(record, name, {
        $schema: is.string,
        bomFormat: is.equals(SBOM_FORMAT),
        specVersion: is.string,
        serialNumber: is.string,
        version: is.integer,
        metadata: is.object,
        components: is.array,
        dependencies: is.array,
      }, { optional: ['$schema', 'serialNumber', 'version', 'dependencies'] }),
    );
    if (problems.length > 0) return problems;
    const component = record.metadata.component;
    if (component === null || typeof component !== 'object') return [...problems, `${name}.metadata.component is ${typeName(component)}, not the component the SBOM is about`];
    if (component.name !== 'kauro-migration-core') problems.push(`${name} is about ${String(component.name)}, not kauro-migration-core`);
    if (component.version !== expected.coreVersion) problems.push(`${name} is about version ${String(component.version)}, not ${expected.coreVersion}`);
    return problems;
  }

  return [`${name} has no record schema in this verifier`];
}

// ---------------------------------------------------------- reconstruction

/**
 * The three archive assets, rebuilt from the commit itself and nothing else.
 *
 * A sum uploaded beside a file proves the file matches the sum. What the
 * dossier has to prove is that the file is *this commit's*: the package the
 * commit builds, the source the commit contains, the evidence the commit
 * carries. So the verifier reads the commit out of git (`git archive <sha>`,
 * never the working tree), builds the package from that archive in a
 * temporary directory outside the tree with the repository's own build and
 * pack, and takes the inventory of each — path, size, digest of every
 * entry. The released assets are compared with these inventories, not with
 * the sums beside them.
 *
 * Dependencies are not part of the package (`files: dist, spec`), but the
 * compiler is; the build in the temporary directory resolves it from this
 * checkout's node_modules through a junction, and the reconstruction records
 * the compiler version it used. No network, no install.
 *
 * @param {{sha: string, coreVersion: string, root?: string}} input
 * @returns {Promise<{sha: string, package: Array<{path: string, bytes: number, sha256: string}>|null, source: Array<{path: string, bytes: number, sha256: string}>|null, evidence: Array<{path: string, bytes: number, sha256: string}>|null, problems: string[], notes: string[]}>}
 */
const reconstructions = new Map();

/**
 * npm, invoked as a script under this node rather than through a shell: a
 * shell would concatenate the temporary directory's path into a command line,
 * and a path with a space in it would then be two arguments.
 */
function npmInvocation() {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(cli)) return { command: process.execPath, prefix: [cli], shell: false };
  return { command: 'npm', prefix: [], shell: process.platform === 'win32' };
}

export async function reconstructCandidate({ sha, coreVersion, root = repoRoot }) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/u.test(sha)) throw new Error(`a commit is 40 hex characters, got ${String(sha)}`);
  const key = `${root}\n${sha}\n${coreVersion}`;
  if (!reconstructions.has(key)) reconstructions.set(key, reconstructUncached({ sha, coreVersion, root }));
  return reconstructions.get(key);
}

function reconstructUncached({ sha, coreVersion, root }) {
  const problems = [];
  const notes = [];
  const result = { sha, package: null, packageSha256: null, source: null, evidence: null, problems, notes };

  // The commit, out of git. `git archive` refuses a sha the repository does
  // not have, and that refusal is the answer: nothing can be reconstructed.
  const archived = spawnSync('git', ['archive', '--format=tar', sha], { cwd: root, maxBuffer: ARCHIVE_MAX_BYTES, encoding: 'buffer' });
  if (archived.status !== 0) {
    problems.push(`git archive ${sha.slice(0, 12)} exited ${String(archived.status)}: ${String(archived.stderr ?? '').trim().slice(-200)}`);
    return result;
  }
  const commit = readTarEntries(gzipSync(archived.stdout, { level: 1 }), { label: `git archive ${sha.slice(0, 12)}` });
  if (commit.problems.length > 0) {
    problems.push(...commit.problems);
    return result;
  }
  const files = archiveInventory(commit.entries);
  result.source = files;
  result.evidence = files.filter((entry) => entry.path.startsWith('qualification/evidence/') || entry.path.startsWith('qualification/capacity/'));
  if (result.evidence.length === 0) problems.push(`the commit ${sha.slice(0, 12)} carries no qualification/evidence or qualification/capacity files`);

  const packageJson = commit.entries.get('package.json');
  let declaredVersion = null;
  try {
    declaredVersion = packageJson === undefined ? null : JSON.parse(packageJson.bytes.toString('utf8')).version;
  } catch {
    declaredVersion = null;
  }
  if (declaredVersion !== coreVersion) {
    problems.push(`the commit ${sha.slice(0, 12)} declares package version ${String(declaredVersion)}, the candidate is ${coreVersion}`);
    return result;
  }

  // The package: the commit's files in a temporary directory outside the
  // tree, built with the repository's own compiler, packed with npm.
  const work = mkdtempSync(join(tmpdir(), 'kauro-reconstruct-'));
  try {
    for (const [path, entry] of commit.entries) {
      const target = join(work, ...path.split('/'));
      if (entry.type === 'directory') {
        mkdirSync(target, { recursive: true });
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.bytes);
    }
    const modules = join(root, 'node_modules');
    if (!existsSync(modules)) {
      problems.push(`no node_modules beside ${root}; the commit cannot be built`);
      return result;
    }
    symlinkSync(modules, join(work, 'node_modules'), 'junction');
    const tsc = join(work, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!existsSync(tsc)) {
      problems.push('no typescript compiler in node_modules; the commit cannot be built');
      return result;
    }
    const compilerVersion = JSON.parse(readFileSync(join(work, 'node_modules', 'typescript', 'package.json'), 'utf8')).version;
    let lockedCompiler = null;
    try {
      lockedCompiler = JSON.parse(commit.entries.get('package-lock.json').bytes.toString('utf8')).packages['node_modules/typescript'].version;
    } catch {
      lockedCompiler = null;
    }
    if (lockedCompiler !== compilerVersion) problems.push(`the commit locks typescript ${String(lockedCompiler)} and the compiler available is ${String(compilerVersion)}; the build would not be the commit's`);
    notes.push(`built with typescript ${compilerVersion} from ${modules}`);
    const built = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (built.status !== 0) {
      problems.push(`the commit does not build: tsc exited ${String(built.status)}: ${String(built.stdout ?? '').trim().slice(-300)}`);
      return result;
    }
    const outDir = join(work, 'packed');
    mkdirSync(outDir);
    // The same packer the dossier is built with (tools/pack.mjs): the file list
    // from npm in the rebuilt commit, the container fixed.
    let filename;
    try {
      const packed = packPackage({ root: work, outDir });
      filename = packed.filename;
      // The tarball's own digest, for callers that compare a downloaded asset with it
      // (tools/published-asset-check.mjs); the dossier compares inventories.
      result.packageSha256 = packed.sha256;
    } catch (error) {
      problems.push(`the commit's packer failed: ${String(error?.message ?? error).slice(-300)}`);
      return result;
    }
    if (filename !== `kauro-migration-core-${coreVersion}.tgz`) {
      problems.push(`npm pack of the commit wrote ${String(filename)}, not kauro-migration-core-${coreVersion}.tgz`);
      return result;
    }
    const tarball = readTarEntries(readFileSync(join(outDir, filename)), { label: 'the reconstructed package' });
    if (tarball.problems.length > 0) {
      problems.push(...tarball.problems);
      return result;
    }
    result.package = archiveInventory(tarball.entries);
    notes.push(`package reconstructed from ${sha.slice(0, 12)}: ${String(result.package.length)} entries`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return result;
}

/**
 * Every way a dossier can fail to be this candidate's, as a list of problems.
 * Pure: the caller supplies the bytes, however it obtained them, and the
 * reconstruction of the commit, however it built it.
 *
 * What is proved, per asset class:
 *   - every asset is named by the inventory, present once, non-empty, and
 *     matches SHA256SUMS and the delivery manifest byte for byte;
 *   - the delivery manifest follows a closed schema and names this candidate
 *     (repository, commit, tree, tag, versions, digests, campaign, producers);
 *   - every JSON record parses to a record, follows its closed schema, binds
 *     to this candidate in its own fields, and carries flags that are derived
 *     from its facts here and compared with what it states — a preflight whose
 *     facts contain FALSE cannot carry TRUE, a universe whose steps failed
 *     cannot say passed, a manifest whose table derives another digest cannot
 *     claim this one;
 *   - every archive opens with the strict reader (bounded, no traversal, no
 *     links, no duplicates), the source archive is rooted at a directory
 *     naming the commit, and each archive's entry inventory equals the
 *     reconstruction of the commit — the package the commit builds, the files
 *     the commit contains, the evidence the commit carries. A sum beside a
 *     file is never what proves the file.
 *
 * @param {{
 *   inventory: ReadonlyArray<{name: string, role: string}>,
 *   assets: ReadonlyArray<{name: string, bytes: Buffer}>,
 *   expected: {repository: string, sha: string, gitTree?: string|null, tag: string, coreVersion: string, packageFormatVersion: string,
 *              codeDigest: string, manifestDigest: string, subjectDigest?: string|null, campaignId: string,
 *              producers: Record<string, string>, receiptSha256: string|null, controlFlowTestOnly?: boolean,
 *              reconstruction?: {package: Array<{path: string, bytes: number, sha256: string}>|null, source: Array<{path: string, bytes: number, sha256: string}>|null, evidence: Array<{path: string, bytes: number, sha256: string}>|null, problems?: string[]}|null},
 * }} input
 * @returns {string[]}
 */
export function dossierProblems({ inventory, assets, expected }) {
  const problems = [];
  const byName = new Map();
  for (const asset of assets) {
    if (byName.has(asset.name)) problems.push(`${asset.name} appears more than once`);
    byName.set(asset.name, asset);
  }
  const wanted = new Set(inventory.map((entry) => entry.name));
  for (const name of wanted) if (!byName.has(name)) problems.push(`${name} is missing`);
  for (const name of byName.keys()) if (!wanted.has(name)) problems.push(`${name} is not in the dossier inventory ${DOSSIER_INVENTORY_VERSION}`);
  for (const asset of assets) if (asset.bytes.length === 0) problems.push(`${asset.name} is empty`);

  // The sums, strictly, and against the bytes.
  const sumsAsset = byName.get(SUMS_NAME);
  if (sumsAsset !== undefined) {
    const sums = parseSums(sumsAsset.bytes.toString('utf8'));
    problems.push(...sums.problems);
    for (const asset of assets) {
      if (asset.name === SUMS_NAME) continue;
      const declared = sums.entries.get(asset.name);
      if (declared === undefined) {
        problems.push(`${SUMS_NAME} does not name ${asset.name}`);
        continue;
      }
      const actual = sha256(asset.bytes);
      if (actual !== declared) problems.push(`${asset.name} hashes ${actual.slice(0, 16)} and ${SUMS_NAME} says ${declared.slice(0, 16)}`);
    }
    for (const name of sums.entries.keys()) if (!byName.has(name)) problems.push(`${SUMS_NAME} names ${name}, which is not here`);
  }

  // A JSON asset is bytes that parse to a record. `null`, an array, a scalar,
  // a truncated document and a non-UTF-8 document are each a problem; the
  // record checks below run only over what parsed.
  const parses = new Map();
  const parsed = (name) => {
    if (parses.has(name)) return parses.get(name);
    const result = parseOnce(name);
    parses.set(name, result);
    return result;
  };
  const parseOnce = (name) => {
    const asset = byName.get(name);
    if (asset === undefined) return { present: false, value: null };
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(asset.bytes);
    } catch {
      problems.push(`${name} is not UTF-8`);
      return { present: false, value: null };
    }
    try {
      const value = JSON.parse(text);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        problems.push(`${name} is JSON ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}, not a record`);
        return { present: false, value: null };
      }
      return { present: true, value };
    } catch (error) {
      problems.push(`${name} is not JSON: ${String(error.message)}`);
      return { present: false, value: null };
    }
  };

  // The delivery manifest: closed schema, the candidate it names is the one
  // measured, and the assets it lists are the ones here, byte for byte.
  const manifestRead = parsed(DOSSIER_MANIFEST_NAME);
  if (manifestRead.present) {
    const manifest = manifestRead.value;
    problems.push(
      ...recordShapeProblems(manifest, DOSSIER_MANIFEST_NAME, {
        artifactKind: is.equals(DOSSIER_MANIFEST_KIND, `not a ${DOSSIER_MANIFEST_KIND}`),
        dossierInventoryVersion: is.string,
        repository: is.string,
        sha: is.hex40,
        gitTree: is.hex40,
        tag: is.string,
        versions: is.object,
        codeDigest: is.hex64,
        manifestDigest: is.hex64,
        subjectDigest: is.nullable(is.hex64),
        campaignId: is.nullable(is.string),
        producers: is.object,
        assets: is.array,
        builtAt: is.string,
        builtBy: is.equals('tools/release-dossier.mjs'),
        controlFlowTestOnly: is.isTrue,
      }, { optional: ['controlFlowTestOnly'] }),
    );
    if (manifest.artifactKind !== DOSSIER_MANIFEST_KIND) problems.push(`${DOSSIER_MANIFEST_NAME} is a ${String(manifest.artifactKind)}, not a ${DOSSIER_MANIFEST_KIND}`);
    if (manifest.dossierInventoryVersion !== DOSSIER_INVENTORY_VERSION) problems.push(`${DOSSIER_MANIFEST_NAME} follows inventory ${String(manifest.dossierInventoryVersion)}, this verifier ${DOSSIER_INVENTORY_VERSION}`);
    if (manifest.controlFlowTestOnly === true && expected.controlFlowTestOnly !== true) problems.push(`${DOSSIER_MANIFEST_NAME} is marked CONTROL_FLOW_TEST_ONLY: a rehearsal dossier is never a release`);
    if (manifest.controlFlowTestOnly !== true && expected.controlFlowTestOnly === true) problems.push(`${DOSSIER_MANIFEST_NAME} is not marked CONTROL_FLOW_TEST_ONLY and this is a rehearsal`);
    const same = (field, value, label = field) => {
      if (manifest[field] !== value) problems.push(`${DOSSIER_MANIFEST_NAME} says ${label} ${String(manifest[field]).slice(0, 40)}, the candidate is ${String(value).slice(0, 40)}`);
    };
    same('repository', expected.repository);
    same('sha', expected.sha);
    if (typeof expected.gitTree === 'string') same('gitTree', expected.gitTree, 'tree');
    same('tag', expected.tag);
    same('codeDigest', expected.codeDigest);
    same('manifestDigest', expected.manifestDigest);
    if (expected.subjectDigest !== undefined && expected.subjectDigest !== null) same('subjectDigest', expected.subjectDigest);
    same('campaignId', expected.campaignId);
    if (manifest.versions?.coreVersion !== expected.coreVersion) problems.push(`${DOSSIER_MANIFEST_NAME} says core ${String(manifest.versions?.coreVersion)}, the candidate is ${expected.coreVersion}`);
    if (manifest.versions?.packageFormatVersion !== expected.packageFormatVersion) problems.push(`${DOSSIER_MANIFEST_NAME} says package format ${String(manifest.versions?.packageFormatVersion)}, the candidate is ${expected.packageFormatVersion}`);
    const declaredProducers = manifest.producers !== null && typeof manifest.producers === 'object' ? manifest.producers : {};
    for (const [producer, fingerprint] of Object.entries(expected.producers ?? {})) {
      if (declaredProducers[producer] !== fingerprint) problems.push(`${DOSSIER_MANIFEST_NAME} records ${producer} at ${String(declaredProducers[producer]).slice(0, 16)}, the candidate measures ${String(fingerprint).slice(0, 16)}`);
    }
    for (const producer of Object.keys(declaredProducers)) {
      if (!(producer in (expected.producers ?? {}))) problems.push(`${DOSSIER_MANIFEST_NAME} records a producer the candidate does not declare: ${producer}`);
    }
    const listed = Array.isArray(manifest.assets) ? manifest.assets : [];
    const listedNames = new Set();
    for (const entry of listed) {
      const shape = recordShapeProblems(entry, `${DOSSIER_MANIFEST_NAME} asset entry`, { name: is.string, role: is.string, bytes: is.integer, sha256: is.hex64 });
      if (shape.length > 0) {
        problems.push(...shape);
        continue;
      }
      if (listedNames.has(entry.name)) problems.push(`${DOSSIER_MANIFEST_NAME} lists ${entry.name} twice`);
      listedNames.add(entry.name);
      if (entry.name === DOSSIER_MANIFEST_NAME || entry.name === SUMS_NAME) {
        problems.push(`${DOSSIER_MANIFEST_NAME} lists ${entry.name}, which it must not`);
        continue;
      }
      const asset = byName.get(entry.name);
      if (asset === undefined) {
        problems.push(`${DOSSIER_MANIFEST_NAME} lists ${String(entry.name)}, which is not here`);
        continue;
      }
      if (asset.bytes.length !== entry.bytes) problems.push(`${entry.name} is ${String(asset.bytes.length)} bytes, ${DOSSIER_MANIFEST_NAME} says ${String(entry.bytes)}`);
      if (sha256(asset.bytes) !== entry.sha256) problems.push(`${entry.name} hashes differently from what ${DOSSIER_MANIFEST_NAME} records`);
      const role = inventory.find((item) => item.name === entry.name)?.role;
      if (role !== undefined && entry.role !== role) problems.push(`${entry.name} is listed as ${String(entry.role)}, the inventory says ${role}`);
    }
    for (const name of wanted) {
      if (name === DOSSIER_MANIFEST_NAME || name === SUMS_NAME) continue;
      if (!listedNames.has(name)) problems.push(`${DOSSIER_MANIFEST_NAME} does not list ${name}`);
    }
  }

  // Each record: closed schema, bound to this candidate in its own fields,
  // flags derived from facts.
  for (const entry of inventory) {
    if (entry.kind !== 'application/json' || entry.name === DOSSIER_MANIFEST_NAME) continue;
    const read = parsed(entry.name);
    if (!read.present) continue;
    problems.push(...candidateRecordProblems(entry.name, read.value, expected));
  }
  // Across records: the release provenance describes the campaign the
  // campaign record seals — id, seal time and subject — not another one.
  const campaignRead = parsed('campaign.json');
  const releaseRead = parsed('migration-core-provenance.json');
  if (campaignRead.present && releaseRead.present && expected.controlFlowTestOnly !== true && releaseRead.value.campaign !== null && typeof releaseRead.value.campaign === 'object') {
    for (const field of ['campaignId', 'sealedAt', 'subjectDigest']) {
      if (releaseRead.value.campaign[field] !== campaignRead.value[field]) problems.push(`migration-core-provenance.json names campaign ${field} ${String(releaseRead.value.campaign[field]).slice(0, 20)} and campaign.json seals ${String(campaignRead.value[field]).slice(0, 20)}`);
    }
  }
  const receiptAsset = byName.get('ci-receipt.json');
  if (expected.receiptSha256 !== null && expected.receiptSha256 !== undefined && receiptAsset !== undefined && sha256(receiptAsset.bytes) !== expected.receiptSha256) {
    problems.push('ci-receipt.json is not byte-identical to the receipt this verification was given');
  }

  // Each archive: opened with the strict reader, and its inventory compared
  // with the reconstruction of the commit. No reconstruction, no comparison,
  // and an archive that cannot be compared is refused, never passed.
  const reconstruction = expected.reconstruction ?? null;
  if (reconstruction === null) problems.push(`no reconstruction of commit ${String(expected.sha).slice(0, 12)} was supplied; the package, source and evidence archives cannot be compared with the commit`);
  else if (Array.isArray(reconstruction.problems) && reconstruction.problems.length > 0) problems.push(...reconstruction.problems.map((problem) => `the reconstruction of commit ${String(expected.sha).slice(0, 12)} failed: ${problem}`));
  const compare = (name, actual, key) => {
    const expectedInventory = reconstruction?.[key] ?? null;
    if (!Array.isArray(expectedInventory)) {
      problems.push(`${name} cannot be compared: the ${key} of commit ${String(expected.sha).slice(0, 12)} was not reconstructed`);
      return;
    }
    problems.push(...inventoryDifferences(name, actual, expectedInventory));
  };

  const pkgName = `kauro-migration-core-${expected.coreVersion}.tgz`;
  const pkg = byName.get(pkgName);
  if (pkg !== undefined) {
    const read = readTarEntries(pkg.bytes, { label: pkgName });
    problems.push(...read.problems);
    if (read.problems.length === 0) {
      const manifestEntry = read.entries.get('package/package.json');
      if (manifestEntry === undefined) problems.push('the package tarball carries no package/package.json');
      else {
        let pkgJson = null;
        try {
          pkgJson = JSON.parse(manifestEntry.bytes.toString('utf8'));
        } catch (error) {
          problems.push(`the package tarball's package.json is not JSON: ${String(error.message)}`);
        }
        if (pkgJson !== null && typeof pkgJson === 'object') {
          if (pkgJson.name !== 'kauro-migration-core') problems.push(`the package tarball is ${String(pkgJson.name)}`);
          if (pkgJson.version !== expected.coreVersion) problems.push(`the package tarball is version ${String(pkgJson.version)}, not ${expected.coreVersion}`);
        }
        if (!read.entries.has('package/dist/src/index.js')) problems.push('the package tarball carries no dist/src/index.js');
        if (!read.entries.has('package/dist/src/index.d.ts')) problems.push('the package tarball carries no dist/src/index.d.ts');
      }
      for (const path of read.entries.keys()) if (!path.startsWith('package/')) problems.push(`the package tarball carries ${path} outside package/`);
      compare(pkgName, archiveInventory(read.entries), 'package');
    }
  }

  const sourceName = `source-${expected.sha}.tar.gz`;
  const source = byName.get(sourceName);
  if (source !== undefined) {
    const read = readTarEntries(source.bytes, { label: sourceName });
    problems.push(...read.problems);
    if (read.problems.length === 0) {
      const prefix = `kauro-migration-core-${expected.sha}/`;
      if (typeof read.global.comment === 'string' && read.global.comment !== expected.sha) problems.push(`${sourceName} was archived from commit ${read.global.comment.slice(0, 12)}, not ${String(expected.sha).slice(0, 12)}`);
      const outside = [...read.entries.keys()].filter((path) => path !== prefix.slice(0, -1) && !path.startsWith(prefix));
      if (outside.length > 0) problems.push(`${sourceName} is not rooted at ${prefix}: ${outside.slice(0, 3).join(', ')}`);
      const files = archiveInventory(read.entries, (path) => (path.startsWith(prefix) ? path.slice(prefix.length) : null));
      if (files.length === 0) problems.push(`${sourceName} carries no files under ${prefix}`);
      compare(sourceName, files, 'source');
    }
  }

  const evidence = byName.get('evidence.tar.gz');
  if (evidence !== undefined) {
    const read = readTarEntries(evidence.bytes, { label: 'evidence.tar.gz' });
    problems.push(...read.problems);
    if (read.problems.length === 0) {
      const files = archiveInventory(read.entries);
      const stray = files.filter((entry) => !entry.path.startsWith('qualification/evidence/') && !entry.path.startsWith('qualification/capacity/'));
      if (stray.length > 0) problems.push(`evidence.tar.gz carries files outside qualification/evidence and qualification/capacity: ${stray.slice(0, 3).map((entry) => entry.path).join(', ')}`);
      if (files.length === 0) problems.push('evidence.tar.gz carries no files');
      compare('evidence.tar.gz', files, 'evidence');
    }
  }
  return problems;
}

// ----------------------------------------------------------------- building

function run(command, args, options = {}) {
  // npm as a script under this node where it can be found, so a destination
  // with a space in it stays one argument; a shell only as the fallback.
  const npm = command === 'npm' ? npmInvocation() : { command, prefix: [], shell: false };
  const result = spawnSync(npm.command, [...npm.prefix, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: npm.shell, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${String(result.status)}: ${String(result.stderr ?? '').trim().slice(-400)}`);
  return result.stdout;
}

/**
 * The CycloneDX SBOM of the package, over the lockfile (D77).
 *
 * npm 11 names `metadata.component` after the directory it runs in, not after
 * package.json, so an SBOM run in a checkout called `mc-203-fix` is "about
 * mc-203-fix". The SBOM shipped is generated instead from a temporary directory
 * named as the package, holding copies of package.json and package-lock.json
 * only, with `--package-lock-only`.
 *
 * The cross-check is the installed tree (MCD-R3): `npm sbom` in the checkout
 * itself, without `--package-lock-only`, reads node_modules, refuses a missing or
 * invalid dependency on its own, and lists an extraneous one. The two must name
 * the same root (but for its name), the same components and the same dependency
 * graph; the descriptive metadata only an installed package.json carries, and
 * the serial number and timestamp npm draws per run, are not compared.
 */
export function generateSbom({ root = repoRoot } = {}) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (typeof pkg.name !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/u.test(pkg.name)) throw new Error(`package.json names ${JSON.stringify(pkg.name)}, not a directory-safe package name`);
  const args = ['sbom', '--sbom-format', 'cyclonedx', '--omit', 'dev'];
  const scratch = mkdtempSync(join(tmpdir(), 'kauro-sbom-'));
  try {
    const named = join(scratch, pkg.name);
    mkdirSync(named);
    copyFileSync(join(root, 'package.json'), join(named, 'package.json'));
    copyFileSync(join(root, 'package-lock.json'), join(named, 'package-lock.json'));
    const text = run('npm', [...args, '--package-lock-only=true'], { cwd: named });
    let installed;
    try {
      // Explicitly the installed tree (MCD-R3): an npmrc or an inherited
      // npm_config_package_lock_only would otherwise make this a second
      // reading of the lockfile, which cannot disagree with the first.
      const env = { ...process.env, npm_config_package_lock_only: 'false' };
      delete env.NPM_CONFIG_PACKAGE_LOCK_ONLY;
      installed = run('npm', [...args, '--package-lock-only=false'], { cwd: root, env });
    } catch (error) {
      throw new Error(`the installed tree does not describe the lockfile: ${String(error.message)}`);
    }
    const identity = (raw) => {
      const document = JSON.parse(raw);
      const component = document.metadata?.component ?? {};
      const pick = (entry) => ({ 'bom-ref': entry['bom-ref'] ?? null, name: entry.name ?? null, version: entry.version ?? null, purl: entry.purl ?? null, scope: entry.scope ?? null, hashes: entry.hashes ?? [] });
      return JSON.stringify({
        root: { 'bom-ref': component['bom-ref'] ?? null, version: component.version ?? null, purl: component.purl ?? null },
        components: (document.components ?? []).map(pick).sort((a, b) => (String(a['bom-ref']) < String(b['bom-ref']) ? -1 : 1)),
        dependencies: (document.dependencies ?? []).map((entry) => ({ ref: entry.ref, dependsOn: [...(entry.dependsOn ?? [])].sort() })).sort((a, b) => (String(a.ref) < String(b.ref) ? -1 : 1)),
      });
    };
    if (identity(text) !== identity(installed)) throw new Error('the SBOM generated from the lockfile and the installed tree in the checkout differ in their components or dependency graph');
    const component = JSON.parse(text).metadata?.component;
    if (component?.name !== pkg.name || component?.version !== pkg.version) throw new Error(`npm sbom named the package ${String(component?.name)}@${String(component?.version)}, not ${pkg.name}@${String(pkg.version)}`);
    return text;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * What the clean checkout says about itself, measured — the values every
 * dossier claim is compared against.
 */
export async function candidateFacts({ repository, tag }) {
  const live = liveCandidate();
  const measured = measureTree();
  const subject = await measureSubject();
  const producers = await measureProducers();
  const campaign = readCampaign();
  const problems = [...live.problems, ...producers.problems];
  if (live.treeClean !== true) problems.push('the working tree is not clean');
  if (campaign === null) problems.push('no campaign is sealed');
  // The commit, rebuilt from git alone: what every archive asset is compared
  // with. A checkout that cannot name or rebuild its commit has no facts.
  const reconstruction = live.sha === null ? null : await reconstructCandidate({ sha: live.sha, coreVersion: versions.coreVersion });
  if (reconstruction === null) problems.push('the checkout names no commit, so nothing can be reconstructed');
  else problems.push(...reconstruction.problems);
  return {
    repository: repository ?? live.repository ?? normaliseRepository(process.env.GITHUB_REPOSITORY ?? ''),
    sha: live.sha,
    gitTree: live.gitTree,
    tag: tag ?? `v${versions.coreVersion}`,
    coreVersion: versions.coreVersion,
    packageFormatVersion: versions.packageFormatVersion,
    codeDigest: measured.codeDigest,
    manifestDigest: measured.manifestDigest,
    subjectDigest: subject?.subjectDigest ?? null,
    campaignId: campaign?.campaignId ?? null,
    producers: producers.fingerprints,
    ...receiptCheckIdentity(readWorkflow()),
    reconstruction,
    problems,
  };
}

/**
 * Build the dossier into `out`, outside the tree, from this clean checkout.
 * The receipt is copied from where CI's artifact was downloaded to. The
 * delivery manifest is written after everything it lists; the sums last.
 */
export async function buildDossier({ out, receiptPath, repository, tag, now = () => new Date(), recordsDir = null }) {
  // Stand-in records are a rehearsal device: the candidate records are the
  // universe's and the gates' outputs, and a rehearsal has not run them. The
  // option is refused outside CONTROL_FLOW_TEST_ONLY, and a dossier built with
  // it is marked in its own manifest.
  const controlFlowTestOnly = recordsDir !== null;
  if (controlFlowTestOnly && process.env.KAURO_CONTROL_FLOW_TEST_ONLY !== '1') throw new Error('--records is CONTROL_FLOW_TEST_ONLY and KAURO_CONTROL_FLOW_TEST_ONLY is not 1');
  const facts = await candidateFacts({ repository, tag });
  if (facts.problems.length > 0) throw new Error(`the checkout cannot be dossiered:\n${facts.problems.map((p) => `  - ${p}`).join('\n')}`);
  const outDir = resolve(out);
  // By path segments, not by string prefix: a sibling directory whose name
  // begins with the repository's name is outside it.
  const inside = relative(repoRoot, outDir);
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) throw new Error(`the dossier is built outside the tree it describes; ${outDir} is inside ${repoRoot}`);
  if (!existsSync(receiptPath)) throw new Error(`no receipt at ${receiptPath}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const inventory = dossierInventory({ coreVersion: facts.coreVersion, sha: facts.sha });
  const assets = [];
  const record = (name) => {
    const bytes = readFileSync(join(outDir, name));
    assets.push({ name, role: inventory.find((entry) => entry.name === name)?.role ?? null, bytes: bytes.length, sha256: sha256(bytes) });
  };

  // The package, from this checkout, into the dossier directory.
  // tools/pack.mjs rather than a bare `npm pack`: the same file list, in a
  // container that is the same bytes on every host (see that file).
  const packedName = packPackage({ root: repoRoot, outDir }).filename;
  const packageName = `kauro-migration-core-${facts.coreVersion}.tgz`;
  if (packedName !== packageName) throw new Error(`npm pack wrote ${String(packedName)}, the inventory expects ${packageName}`);
  record(packageName);

  const sourceName = `source-${facts.sha}.tar.gz`;
  run('git', ['archive', '--format=tar.gz', `--prefix=kauro-migration-core-${facts.sha}/`, '-o', join(outDir, sourceName), facts.sha], { cwd: repoRoot });
  record(sourceName);

  writeFileSync(join(outDir, 'sbom.cdx.json'), generateSbom({ root: repoRoot }));
  record('sbom.cdx.json');

  const copies = [
    ['qualification/candidate/manifest.json', 'manifest.json'],
    ['qualification/candidate/provenance.json', 'provenance.json'],
    ['qualification/candidate/preflight.json', 'preflight.json'],
    ['qualification/candidate/universe.json', 'universe.json'],
    ['qualification/candidate/campaign.json', 'campaign.json'],
    ['migration-core-provenance.json', 'migration-core-provenance.json'],
  ];
  for (const [from, to] of copies) {
    const source = controlFlowTestOnly && to !== 'campaign.json' ? join(recordsDir, to) : join(repoRoot, ...from.split('/'));
    if (!existsSync(source)) throw new Error(`${controlFlowTestOnly ? source : from} is not ${controlFlowTestOnly ? 'in the records directory' : 'in the checkout'}`);
    copyFileSync(source, join(outDir, to));
    record(to);
  }
  copyFileSync(receiptPath, join(outDir, 'ci-receipt.json'));
  record('ci-receipt.json');

  writeFileSync(join(outDir, 'evidence.tar.gz'), writeTarGz([...filesUnder(repoRoot, 'qualification/evidence'), ...filesUnder(repoRoot, 'qualification/capacity')]));
  record('evidence.tar.gz');

  const builtAt = `${now().toISOString().slice(0, 19)}Z`;
  const manifest = buildDossierManifest({ ...facts, assets, builtAt, controlFlowTestOnly });
  writeFileSync(join(outDir, DOSSIER_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  record(DOSSIER_MANIFEST_NAME);

  const sums = assets
    .filter((asset) => asset.name !== SUMS_NAME)
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((asset) => `${asset.sha256}  ${asset.name}\n`)
    .join('');
  writeFileSync(join(outDir, SUMS_NAME), sums);

  const problems = verifyLocalDossier({ dir: outDir, facts: { ...facts, controlFlowTestOnly }, receiptPath });
  return { outDir, inventory, assets: assets.map(({ name, role, bytes, sha256: digest }) => ({ name, role, bytes, sha256: digest })), problems, controlFlowTestOnly };
}

/** Read every file in a directory as a dossier asset. Subdirectories are a problem, not ignored. */
export function readDossierDir(dir) {
  const assets = [];
  const problems = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      problems.push(`${name}/ is a directory; a dossier is flat`);
      continue;
    }
    assets.push({ name, bytes: readFileSync(full) });
  }
  return { assets, problems };
}

export function verifyLocalDossier({ dir, facts, receiptPath }) {
  const { assets, problems } = readDossierDir(dir);
  const receiptSha256 = receiptPath !== null && existsSync(receiptPath) ? sha256(readFileSync(receiptPath)) : null;
  const inventory = dossierInventory({ coreVersion: facts.coreVersion, sha: facts.sha });
  return [...problems, ...dossierProblems({ inventory, assets, expected: { ...facts, receiptSha256 } })];
}

// ------------------------------------------------------------------ remote

/**
 * A GitHub transport: `(path, accept) => Response`. The real one below; the
 * self-test injects one that serves a release from memory. Nothing in the
 * verification below knows which it has.
 */
export function githubTransport(token) {
  return async (path, accept = 'application/vnd.github+json') => {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        accept,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'kauro-release-dossier',
        ...(token === null || token === '' ? {} : { authorization: `Bearer ${token}` }),
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GET ${path} returned ${String(response.status)} ${response.statusText}`);
    return response;
  };
}

/**
 * Read a release and every asset through the transport; the asset list is
 * paginated and its length compared with what the release object said, and
 * every asset's bytes are compared with the size the API declared.
 */
export async function readRemoteRelease({ api, repository, tagName, releaseId = null }) {
  // By tag for a published release; by id for a draft, which GitHub does not
  // serve under its tag until it is published.
  const release = await (await api(releaseId === null ? `/repos/${repository}/releases/tags/${encodeURIComponent(tagName)}` : `/repos/${repository}/releases/${String(releaseId)}`)).json();
  const listed = [];
  for (let page = 1; ; page += 1) {
    const chunk = await (await api(`/repos/${repository}/releases/${String(release.id)}/assets?per_page=${String(PAGE)}&page=${String(page)}`)).json();
    if (!Array.isArray(chunk)) throw new Error('the asset list is not an array');
    listed.push(...chunk);
    if (chunk.length < PAGE) break;
  }
  const problems = [];
  const inline = Array.isArray(release.assets) ? release.assets.length : null;
  if (inline !== listed.length) problems.push(`the release object lists ${String(inline)} assets and the paginated list ${String(listed.length)}`);
  const assets = [];
  for (const asset of listed) {
    const bytes = Buffer.from(await (await api(`/repos/${repository}/releases/assets/${String(asset.id)}`, 'application/octet-stream')).arrayBuffer());
    if (typeof asset.size === 'number' && asset.size !== bytes.length) problems.push(`${String(asset.name)} downloaded as ${String(bytes.length)} bytes and the API declares ${String(asset.size)}`);
    assets.push({ name: String(asset.name), bytes });
  }
  return { release, assets, problems };
}

/**
 * The two release conditions of the freeze, as the verdict records them.
 * Separate on purpose: a draft with a perfect dossier is `draft_ready`, not
 * frozen, and a published release with a foreign dossier is neither.
 *
 * @returns {Promise<{published: {value: boolean, observed: string}, assets: {value: boolean, observed: string}, draft: boolean}>}
 */
export async function verifyPublishedRelease({ api, repository, tagName, expectedSha, facts, receiptSha256, allowDraft = false, releaseId = null }) {
  let remote;
  try {
    remote = await readRemoteRelease({ api, repository, tagName, releaseId: allowDraft ? releaseId : null });
  } catch (error) {
    const observed = `the release could not be read: ${String(error.message)}`;
    return { published: { value: false, observed }, assets: { value: false, observed }, draft: null };
  }
  const { release, assets } = remote;
  const publishedProblems = [];
  if (release.tag_name !== tagName) publishedProblems.push(`the release is on ${String(release.tag_name)}, not ${tagName}`);
  if (release.draft !== false) publishedProblems.push(release.draft === true ? 'the release is a draft' : 'the API did not say whether the release is a draft');
  if (release.prerelease === true) publishedProblems.push('the release is marked a prerelease');
  if (release.immutable !== true) publishedProblems.push(release.immutable === false ? 'the release is not immutable' : 'the API did not report immutability; not verified');
  const inventory = dossierInventory({ coreVersion: facts.coreVersion, sha: expectedSha });
  const assetProblems = [...remote.problems, ...dossierProblems({ inventory, assets, expected: { ...facts, sha: expectedSha, tag: tagName, receiptSha256 } })];
  const draftReady = release.draft === true && allowDraft && assetProblems.length === 0;
  return {
    published: {
      value: publishedProblems.length === 0,
      observed: publishedProblems.length === 0 ? `${tagName} is published, immutable, on this tag (release ${String(release.id)})` : publishedProblems.join('; '),
    },
    assets: {
      value: assetProblems.length === 0,
      observed:
        assetProblems.length === 0
          ? `${String(assets.length)} assets downloaded, hashed against ${SUMS_NAME}, matched to inventory ${DOSSIER_INVENTORY_VERSION}, records validated against their closed schemas with flags derived from facts, archives opened and compared entry by entry with the reconstruction of ${expectedSha.slice(0, 12)}`
          : `${String(assetProblems.length)} problem(s): ${assetProblems.slice(0, 6).join('; ')}${assetProblems.length > 6 ? '; …' : ''}`,
    },
    draft: release.draft === true,
    draftReady,
    problems: { published: publishedProblems, assets: assetProblems },
  };
}

// --------------------------------------------------------------------- cli

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const valueOf = (name) => {
    const at = args.indexOf(name);
    if (at === -1) return null;
    const value = args[at + 1];
    if (value === undefined || value.startsWith('--')) {
      process.stderr.write(`${name} needs a value\n`);
      process.exit(64);
    }
    return value;
  };
  const controlFlow = process.env.KAURO_CONTROL_FLOW_TEST_ONLY === '1';
  const mode = ['--build', '--verify', '--verify-remote'].filter((flag) => args.includes(flag));
  if (mode.length !== 1) {
    process.stderr.write('usage: node tools/release-dossier.mjs (--build --out <dir> | --verify <dir> | --verify-remote) --receipt <path> [--tag <tag>] [--repository <owner/name>] [--allow-draft]\n');
    process.exit(64);
  }
  const receiptPath = valueOf('--receipt');
  const tag = valueOf('--tag');
  const repository = valueOf('--repository');
  try {
    if (mode[0] === '--build') {
      const out = valueOf('--out');
      if (out === null || receiptPath === null) throw new Error('--build needs --out <dir> and --receipt <path>');
      const built = await buildDossier({ out, receiptPath, repository, tag, recordsDir: valueOf('--records') });
      process.stdout.write(`${JSON.stringify({ dossier: built.outDir, inventoryVersion: DOSSIER_INVENTORY_VERSION, assets: built.assets, problems: built.problems }, null, 2)}\n`);
      process.exit(built.problems.length === 0 ? 0 : 1);
    }
    if (mode[0] === '--verify') {
      const dir = valueOf('--verify');
      const facts = await candidateFacts({ repository, tag });
      if (facts.problems.length > 0) throw new Error(facts.problems.join('; '));
      const problems = verifyLocalDossier({ dir: resolve(dir), facts: { ...facts, controlFlowTestOnly: controlFlow }, receiptPath });
      process.stdout.write(`${JSON.stringify({ dossier: resolve(dir), sha: facts.sha, problems, ok: problems.length === 0 }, null, 2)}\n`);
      process.exit(problems.length === 0 ? 0 : 1);
    }
    const facts = await candidateFacts({ repository, tag });
    if (facts.problems.length > 0) throw new Error(facts.problems.join('; '));
    const token = githubToken();
    if (token === null) throw new Error('no GitHub token is available');
    const receiptSha256 = receiptPath !== null && existsSync(receiptPath) ? sha256(readFileSync(receiptPath)) : null;
    const result = await verifyPublishedRelease({ api: githubTransport(token), repository: facts.repository, tagName: facts.tag, expectedSha: facts.sha, facts: { ...facts, controlFlowTestOnly: controlFlow }, receiptSha256, allowDraft: args.includes('--allow-draft'), releaseId: valueOf('--release-id') });
    const report = { repository: facts.repository, tag: facts.tag, sha: facts.sha, draft: result.draft, draft_ready: result.draftReady === true, release_published_immutable: result.published, release_assets_verified: result.assets, problems: result.problems };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    // Preparation never says frozen. It says whether the draft is ready.
    process.exit(result.assets.value && (result.draftReady === true || result.published.value) ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${String(error.message)}\n`);
    process.exit(1);
  }
}
