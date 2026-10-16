#!/usr/bin/env node
/**
 * The published release asset, checked by its bytes and by installing them.
 *
 * `test/integration/public-consumer.test.ts` packs the checkout and installs
 * that local file, so it cannot see a mismatch in the asset a consumer will
 * actually download: a different tarball with the same name and the same
 * `package.json` version would pass it untouched. This tool is the other half.
 * After publication it
 *
 *   1. downloads the release asset `kauro-migration-core-<version>.tgz` and the
 *      release's `SHA256SUMS` through tools/github-api.mjs;
 *   2. requires sha256(asset) to equal the digest `SHA256SUMS` lists for it;
 *   3. opens the tarball with the dossier's strict reader (bounded, no traversal,
 *      no links, no duplicates);
 *   4. requires sha256(asset) to equal the tarball that tools/pack.mjs
 *      reconstructs from the commit the tag points at, and every entry to equal
 *      the reconstruction's entry;
 *   5. only then installs those exact bytes with tools/consumer-check.mjs
 *      --tarball, and compares every installed file with its tar entry.
 *
 * Steps 2 to 4 come before the install on purpose: a tarball that is not the
 * commit's is refused before its installation can count as evidence. A version
 * string is never the test (D73): the package.json inside a hidden-byte forgery
 * says the same version as the real one.
 *
 *   node tools/published-asset-check.mjs --repo <owner/name> --tag <vX.Y.Z> [--out <path>]
 *   node tools/published-asset-check.mjs --asset-url <release asset URL> --sha256 <hex> [--out <path>]
 *   node tools/published-asset-check.mjs --self-test
 *
 * The second form is the operator's: the URL is the one a consumer would use
 * (https://github.com/OWNER/NAME/releases/download/vX.Y.Z/kauro-migration-core-X.Y.Z.tgz)
 * and the digest is the one the operator read from the dossier before publishing.
 * The repository and tag come from the URL; the bytes fetched from the URL, the
 * bytes the API serves for the asset, SHA256SUMS, the operator's digest and the
 * reconstruction of the tag must all be the same bytes before anything installs.
 *
 * The real run needs GITHUB_TOKEN (or GH_TOKEN), a local clone that holds the tag's
 * commit, and this repository's node_modules; it writes
 * qualification/evidence/published-asset.json. `--self-test` runs against a
 * release served from memory and is what `npm test` runs (SIMULATED evidence).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { github } from './github-api.mjs';
import { SUMS_NAME, inventoryDifferences, archiveInventory, parseSums, readTarEntries, reconstructCandidate, sha256 } from './release-dossier.mjs';
import { packPackage, writeTarGz } from './pack.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MEMBER_MTIME = 499162500;

/**
 * The repository and tag a release asset URL names, or null when it is not the
 * URL of this product's package asset.
 */
export function parseAssetUrl(url) {
  const match = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/releases\/download\/(v\d+\.\d+\.\d+)\/(kauro-migration-core-(\d+\.\d+\.\d+)\.tgz)$/u.exec(String(url));
  if (match === null || `v${match[4]}` !== match[2]) return null;
  return { repository: match[1], tag: match[2], name: match[3] };
}

export const PUBLISHED_ASSET_GATE ='PUBLISHED-ASSET-01';
export const PUBLISHED_ASSET_EVIDENCE_PATH = 'qualification/evidence/published-asset.json';

const nowUtc = () => `${new Date().toISOString().slice(0, 19)}Z`;

/** `package/dist/x.js` becomes `dist/x.js`: the path npm installs the entry at. */
const installedPathOf = (tarPath) => (tarPath.startsWith('package/') ? tarPath.slice('package/'.length) : tarPath);

/**
 * Install the tarball's bytes with consumer-check and report the files that ended
 * up in node_modules/kauro-migration-core.
 *
 * @returns {Promise<{ok: boolean, problems: string[], files: Array<{path: string, bytes: number, sha256: string}>}>}
 */
export async function installWithConsumerCheck({ tarballPath, work }) {
  const report = join(work, 'consumer-check.json');
  const run = spawnSync(process.execPath, [join(repoRoot, 'tools', 'consumer-check.mjs'), '--tarball', tarballPath, '--out', report], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 900_000,
  });
  if (!existsSync(report)) {
    return { ok: false, problems: [`consumer-check wrote no report (exit ${String(run.status)}): ${String(run.stderr ?? '').trim().slice(-300)}`], files: [] };
  }
  const parsed = JSON.parse(readFileSync(report, 'utf8'));
  const files = Array.isArray(parsed.installed?.files) ? parsed.installed.files : [];
  const problems = [...(Array.isArray(parsed.problems) ? parsed.problems : [])];
  if (files.length === 0) problems.push('consumer-check reported no installed files, so nothing can be compared with the tarball');
  return { ok: parsed.ok === true && problems.length === 0, problems, files };
}

/**
 * The check. Everything that touches a network, a clone or npm is injected, so the
 * self-test drives exactly this function with a release served from memory.
 *
 * @param {{
 *   api: {get: (path: string) => Promise<any>, bytes: (path: string) => Promise<Buffer>},
 *   repository: string, tag: string,
 *   reconstruct: (input: {sha: string, coreVersion: string}) => Promise<{packageSha256?: string|null, package: Array<{path: string, bytes: number, sha256: string}>|null, problems: string[]}>,
 *   install: (input: {tarballPath: string, work: string}) => Promise<{ok: boolean, problems: string[], files: Array<{path: string, bytes: number, sha256: string}>}>,
 *   work: string,
 *   assetUrl?: string|null, expectedSha256?: string|null, fetchUrl?: ((url: string) => Promise<Buffer>)|null,
 * }} input
 */
export async function checkPublishedAsset({ api, repository, tag, reconstruct, install, work, assetUrl = null, expectedSha256 = null, fetchUrl = null }) {
  const checks = [];
  const problems = [];
  const record = (id, ok, expected, observed) => {
    checks.push({ id, ok, expected, observed });
    if (!ok) problems.push(`${id}: ${observed}`);
    return ok;
  };
  const evidence = { gate: PUBLISHED_ASSET_GATE, observedAt: nowUtc(), repository, tag, commit: null, release: null, asset: null, dossierSum: null, reconstruction: null, install: null, installed: false, checks, problems, result: 'FAIL' };
  const refuse = () => {
    evidence.result = 'FAIL';
    return evidence;
  };

  const coreVersion = tag.replace(/^v/u, '');
  const assetName = `kauro-migration-core-${coreVersion}.tgz`;

  // The release and its two assets.
  let release;
  try {
    release = await api.get(`/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`);
  } catch (error) {
    record('release.readable', false, `release ${tag} of ${repository} is readable`, String(error.message));
    return refuse();
  }
  evidence.release = { id: release.id, tag: release.tag_name, draft: release.draft === true, prerelease: release.prerelease === true, immutable: release.immutable ?? null };
  const listed = Array.isArray(release.assets) ? release.assets : [];
  const assetEntry = listed.find((entry) => entry.name === assetName);
  const sumsEntry = listed.find((entry) => entry.name === SUMS_NAME);
  if (!record('release.carriesTheAsset', assetEntry !== undefined, `the release lists ${assetName}`, assetEntry === undefined ? `${assetName} is not among: ${listed.map((entry) => entry.name).join(', ') || '(none)'}` : 'listed')) return refuse();
  if (!record('release.carriesTheSums', sumsEntry !== undefined, `the release lists ${SUMS_NAME}`, sumsEntry === undefined ? `${SUMS_NAME} is not listed` : 'listed')) return refuse();

  // The commit the tag points at.
  try {
    const commit = await api.get(`/repos/${repository}/commits/${encodeURIComponent(tag)}`);
    evidence.commit = String(commit.sha);
  } catch (error) {
    record('tag.resolves', false, `${tag} resolves to a commit`, String(error.message));
    return refuse();
  }

  // The bytes, downloaded. Nothing below reads the local checkout's own pack.
  const asset = await api.bytes(`/repos/${repository}/releases/assets/${String(assetEntry.id)}`);
  const sumsBytes = await api.bytes(`/repos/${repository}/releases/assets/${String(sumsEntry.id)}`);
  const assetSha256 = sha256(asset);
  evidence.asset = { name: assetName, bytes: asset.length, sha256: assetSha256 };
  if (typeof assetEntry.size === 'number') record('asset.sizeAsDeclared', assetEntry.size === asset.length, 'the download is as long as the API declares', `${String(asset.length)} bytes downloaded, ${String(assetEntry.size)} declared`);

  // 0. The operator's own digest, and the URL a consumer would download from.
  if (expectedSha256 !== null) {
    record('asset.sha256EqualsOperatorDigest', assetSha256 === String(expectedSha256).toLowerCase(), 'sha256(asset) equals the digest the operator supplied', `asset ${assetSha256}, operator ${String(expectedSha256)}`);
  }
  if (assetUrl !== null && fetchUrl !== null) {
    let fetched = null;
    try {
      fetched = await fetchUrl(assetUrl);
    } catch (error) {
      record('asset.urlDownloads', false, `${assetUrl} downloads`, String(error.message));
    }
    if (fetched !== null) {
      evidence.assetUrl = { url: assetUrl, bytes: fetched.length, sha256: sha256(fetched) };
      record('asset.urlBytesEqualApiBytes', sha256(fetched) === assetSha256, 'the bytes downloaded from the URL are the bytes the API serves for the asset', `url ${sha256(fetched)}, api ${assetSha256}`);
    }
  }

  // 1. The dossier's own sum.
  const sums = parseSums(sumsBytes.toString('utf8'));
  record('sums.wellFormed', sums.problems.length === 0, `${SUMS_NAME} parses without a problem`, sums.problems.join('; ') || 'clean');
  const dossierSum = sums.entries.get(assetName) ?? null;
  evidence.dossierSum = dossierSum;
  record('sums.namesTheAsset', dossierSum !== null, `${SUMS_NAME} lists ${assetName}`, dossierSum === null ? `${assetName} is not listed` : dossierSum);
  record('asset.sha256EqualsDossierSum', dossierSum !== null && dossierSum === assetSha256, 'sha256(asset) equals the digest the dossier lists', `asset ${assetSha256}, dossier ${String(dossierSum)}`);

  // 2. The strict reader.
  const tarball = readTarEntries(asset, { label: assetName });
  record('asset.opensAsATarball', tarball.problems.length === 0, `${assetName} is a well-formed gzip'd tar`, tarball.problems.slice(0, 3).join('; ') || 'opened');
  const inventory = tarball.problems.length === 0 ? archiveInventory(tarball.entries) : null;

  // 3. The reconstruction of the commit.
  let reconstruction;
  try {
    reconstruction = await reconstruct({ sha: evidence.commit, coreVersion });
  } catch (error) {
    reconstruction = { packageSha256: null, package: null, problems: [String(error.message)] };
  }
  evidence.reconstruction = { sha256: reconstruction.packageSha256 ?? null, entries: reconstruction.package === null ? null : reconstruction.package.length };
  record('reconstruction.made', reconstruction.package !== null && reconstruction.problems.length === 0 && typeof reconstruction.packageSha256 === 'string', `tools/pack.mjs reconstructs ${tag} from its commit`, reconstruction.problems.join('; ') || 'reconstructed');
  record('asset.sha256EqualsReconstruction', typeof reconstruction.packageSha256 === 'string' && reconstruction.packageSha256 === assetSha256, 'sha256(asset) equals the tarball reconstructed from the commit', `asset ${assetSha256}, reconstruction ${String(reconstruction.packageSha256)}`);
  if (inventory !== null && reconstruction.package !== null) {
    const differences = inventoryDifferences(assetName, inventory, reconstruction.package);
    record('asset.entriesEqualReconstruction', differences.length === 0, 'every entry of the asset equals the reconstruction\'s entry, byte for byte', differences.slice(0, 4).join('; ') || `${String(inventory.length)} entries equal`);
  }

  // Refused here means refused before the install: a tarball that is not the
  // commit's does not get to count as installed.
  if (problems.length > 0) return refuse();

  // 4. The install, of those bytes.
  const tarballPath = join(work, assetName);
  mkdirSync(work, { recursive: true });
  writeFileSync(tarballPath, asset);
  const installed = await install({ tarballPath, work });
  evidence.installed = true;
  record('install.consumerCheckPasses', installed.ok === true, 'tools/consumer-check.mjs --tarball passes on the downloaded bytes', installed.problems.join('; ') || 'passed');
  const expectedFiles = new Map(inventory.map((entry) => [installedPathOf(entry.path), entry]));
  const installedFiles = new Map(installed.files.map((entry) => [entry.path, entry]));
  const differences = [];
  for (const [path, entry] of expectedFiles) {
    const found = installedFiles.get(path);
    if (found === undefined) differences.push(`${path} is in the tarball and was not installed`);
    else if (found.sha256 !== entry.sha256 || found.bytes !== entry.bytes) differences.push(`${path} installed as ${found.sha256.slice(0, 16)} (${String(found.bytes)} bytes), the tar entry is ${entry.sha256.slice(0, 16)} (${String(entry.bytes)} bytes)`);
  }
  for (const path of installedFiles.keys()) if (!expectedFiles.has(path)) differences.push(`${path} was installed and is not in the tarball`);
  record('install.filesEqualTarEntries', differences.length === 0, 'every installed file equals its tar entry and nothing else was installed', differences.slice(0, 4).join('; ') || `${String(expectedFiles.size)} files equal`);
  evidence.install = { filesCompared: expectedFiles.size, differences: differences.length };

  evidence.result = problems.length === 0 ? 'PASS' : 'FAIL';
  return evidence;
}

// ---------------------------------------------------------------- self-test

function fakeRelease({ repository, tag, sha, assets }) {
  const listed = assets.map((entry, index) => ({ id: index + 1, name: entry.name, size: entry.bytes.length }));
  return {
    async get(path) {
      if (path === `/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`) return { id: 7, tag_name: tag, draft: false, prerelease: false, immutable: true, assets: listed };
      if (path === `/repos/${repository}/commits/${encodeURIComponent(tag)}`) return { sha };
      throw new Error(`GET ${path} returned 404`);
    },
    async bytes(path) {
      const match = /\/releases\/assets\/(\d+)$/u.exec(path);
      const entry = match === null ? undefined : assets[Number(match[1]) - 1];
      if (entry === undefined) throw new Error(`GET ${path} returned 404`);
      return entry.bytes;
    },
  };
}

/** One byte of one packed `dist` file changed. Same version, valid gzip, valid tar. */
function withOneHiddenByte(genuine) {
  const read = readTarEntries(genuine, { label: 'the genuine tarball' });
  if (read.problems.length > 0) throw new Error(read.problems[0]);
  const files = [];
  let changed = null;
  for (const [path, entry] of read.entries) {
    if (entry.type !== 'file') continue;
    let bytes = entry.bytes;
    if (changed === null && path.startsWith('package/dist/') && path.endsWith('.js') && bytes.length > 200) {
      bytes = Buffer.from(bytes);
      const at = bytes.findIndex((value, index) => index > 100 && value >= 0x61 && value <= 0x79);
      bytes[at] += 1;
      changed = { path, offset: at };
    }
    files.push({ path, bytes });
  }
  if (changed === null) throw new Error('the genuine tarball has no packed dist file to change a byte in');
  return { bytes: writeTarGz(files, { mtime: MEMBER_MTIME }), changed };
}

export async function selfTest() {
  const cases = [];
  const add = (id, ok, expected, observed) => cases.push({ id, ok, expected, observed });
  const work = mkdtempSync(join(tmpdir(), 'kauro-published-asset-'));
  try {
    const repository = 'owner/kauro-migration-core';
    const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
    const tag = `v${version}`;
    const sha = 'a'.repeat(40);
    const name = `kauro-migration-core-${version}.tgz`;

    // The genuine tarball: this checkout, packed by tools/pack.mjs.
    const packed = packPackage({ root: repoRoot, outDir: join(work, 'genuine') });
    const genuine = readFileSync(packed.path);
    const genuineInventory = archiveInventory(readTarEntries(genuine, { label: name }).entries);
    const reconstruct = async () => ({ packageSha256: packed.sha256, package: genuineInventory, problems: [] });
    const sumsFor = (bytes) => Buffer.from(`${sha256(bytes)}  ${name}\n`, 'utf8');

    // An install that faithfully lays the tarball's entries down, and counts its calls.
    const installer = (mutate = (files) => files) => {
      const calls = [];
      return {
        calls,
        install: async ({ tarballPath }) => {
          calls.push(tarballPath);
          const entries = readTarEntries(readFileSync(tarballPath), { label: 'the installed tarball' }).entries;
          const files = archiveInventory(entries).map((entry) => ({ path: installedPathOf(entry.path), bytes: entry.bytes, sha256: entry.sha256 }));
          return { ok: true, problems: [], files: mutate(files) };
        },
      };
    };
    const run = async (assetBytes, sumsBytes, hooks, extraAssets = []) => {
      const assets = [{ name, bytes: assetBytes }, { name: SUMS_NAME, bytes: sumsBytes }, ...extraAssets];
      return checkPublishedAsset({ api: fakeRelease({ repository, tag, sha, assets }), repository, tag, reconstruct, install: hooks.install, work: join(work, `run-${String(cases.length)}`) });
    };
    const failedChecks = (result) => result.checks.filter((entry) => !entry.ok).map((entry) => entry.id);

    // 1. The genuine asset is accepted, and is installed once.
    {
      const hooks = installer();
      const result = await run(genuine, sumsFor(genuine), hooks);
      add('genuine.assetIsAccepted', result.result === 'PASS' && hooks.calls.length === 1 && result.checks.length >= 12, 'the genuine asset passes every check and is installed exactly once', `${result.result}, ${String(hooks.calls.length)} install(s), failed: ${failedChecks(result).join(', ') || 'none'}`);
    }

    // 2 and 3. One hidden byte, same version, valid gzip and tar.
    const forged = withOneHiddenByte(genuine);
    const forgedPackageVersion = JSON.parse(readTarEntries(forged.bytes, { label: 'forged' }).entries.get('package/package.json').bytes.toString('utf8')).version;
    const forgedIsWellFormed = readTarEntries(forged.bytes, { label: 'forged' }).problems.length === 0;
    {
      const hooks = installer();
      const result = await run(forged.bytes, sumsFor(genuine), hooks);
      const failed = failedChecks(result);
      add('hiddenByte.sameVersionRefusedBeforeInstall', forgedPackageVersion === version && forgedIsWellFormed && result.result === 'FAIL' && failed.includes('asset.sha256EqualsDossierSum') && failed.includes('asset.sha256EqualsReconstruction') && hooks.calls.length === 0 && result.installed === false, `a tarball with one byte of ${forged.changed.path} changed and the same package version ${version} is refused by the digests and never installed`, `version ${String(forgedPackageVersion)}, well formed ${String(forgedIsWellFormed)}, ${result.result}, failed: ${failed.join(', ')}, installs: ${String(hooks.calls.length)}`);
    }
    {
      const hooks = installer();
      const result = await run(forged.bytes, sumsFor(forged.bytes), hooks);
      const failed = failedChecks(result);
      const named = result.checks.find((entry) => entry.id === 'asset.entriesEqualReconstruction');
      add('hiddenByte.sumsRewrittenStillRefusedBeforeInstall', result.result === 'FAIL' && !failed.includes('asset.sha256EqualsDossierSum') && failed.includes('asset.sha256EqualsReconstruction') && named?.ok === false && String(named.observed).includes(forged.changed.path) && hooks.calls.length === 0, 'when the dossier sum was rewritten to match the forgery, the reconstruction still refuses it, names the entry, and nothing is installed', `${result.result}, failed: ${failed.join(', ')}, entries: ${String(named?.observed).slice(0, 120)}, installs: ${String(hooks.calls.length)}`);
    }

    // 4. The installed files must be the tar entries.
    {
      const hooks = installer((files) => files.map((file, index) => (index === 0 ? { ...file, sha256: 'f'.repeat(64) } : file)));
      const result = await run(genuine, sumsFor(genuine), hooks);
      const failed = failedChecks(result);
      add('install.filesMustEqualTarEntries', result.result === 'FAIL' && failed.length === 1 && failed[0] === 'install.filesEqualTarEntries', 'an installation whose files are not the tar entries fails on that comparison alone', `${result.result}, failed: ${failed.join(', ') || 'none'}`);
    }

    // 5. The version text is not the test. The forgery and the genuine asset say the
    // same version; only the bytes tell them apart.
    {
      const genuineVersion = JSON.parse(readTarEntries(genuine, { label: 'genuine' }).entries.get('package/package.json').bytes.toString('utf8')).version;
      const hooks = installer();
      const result = await run(forged.bytes, sumsFor(forged.bytes), hooks);
      add('version.textAloneIsNotTheCheck', genuineVersion === forgedPackageVersion && result.result === 'FAIL' && hooks.calls.length === 0, 'the forged asset carries the genuine asset\'s version text and is refused anyway', `versions ${genuineVersion} and ${String(forgedPackageVersion)}, ${result.result}`);
    }

    // The operator's digest and URL.
    const assetUrl = `https://github.com/${repository}/releases/download/${tag}/${name}`;
    const withOperator = async (assetBytes, operatorDigest, urlBytes, hooks) =>
      checkPublishedAsset({
        api: fakeRelease({ repository, tag, sha, assets: [{ name, bytes: assetBytes }, { name: SUMS_NAME, bytes: sumsFor(assetBytes) }] }),
        repository, tag, reconstruct, install: hooks.install, work: join(work, `operator-${String(cases.length)}`),
        assetUrl, expectedSha256: operatorDigest, fetchUrl: async () => urlBytes,
      });
    {
      const hooks = installer();
      const result = await withOperator(genuine, sha256(genuine), genuine, hooks);
      add('operator.digestAndUrlAccepted', result.result === 'PASS' && hooks.calls.length === 1 && result.assetUrl?.url === assetUrl && result.checks.some((entry) => entry.id === 'asset.sha256EqualsOperatorDigest' && entry.ok), 'the genuine asset, with the operator digest and the URL bytes, passes and records the URL', `${result.result}, failed: ${failedChecks(result).join(', ') || 'none'}`);
    }
    {
      const hooks = installer();
      const result = await withOperator(genuine, 'e'.repeat(64), genuine, hooks);
      add('operator.wrongDigestRefusedBeforeInstall', result.result === 'FAIL' && failedChecks(result).includes('asset.sha256EqualsOperatorDigest') && hooks.calls.length === 0, 'an asset whose digest is not the operator digest is refused and never installed', `${result.result}, failed: ${failedChecks(result).join(', ')}, installs: ${String(hooks.calls.length)}`);
    }
    {
      const hooks = installer();
      const result = await withOperator(genuine, sha256(genuine), forged.bytes, hooks);
      add('operator.urlServingOtherBytesRefusedBeforeInstall', result.result === 'FAIL' && failedChecks(result).includes('asset.urlBytesEqualApiBytes') && hooks.calls.length === 0, 'a URL that serves other bytes than the API does is refused and never installed', `${result.result}, failed: ${failedChecks(result).join(', ')}`);
    }
    add('operator.urlMustBeThePackageAsset', parseAssetUrl(assetUrl)?.tag === tag && parseAssetUrl(assetUrl)?.repository === repository && parseAssetUrl(`https://example.com/${repository}/releases/download/${tag}/${name}`) === null && parseAssetUrl(`https://github.com/${repository}/releases/download/v9.9.9/${name}`) === null, 'only a github.com release-download URL of kauro-migration-core-VERSION.tgz under the same tag is accepted', 'parsed');

    // The ways the release itself can be wrong.
    {
      const hooks = installer();
      const result = await checkPublishedAsset({ api: fakeRelease({ repository, tag, sha, assets: [{ name: SUMS_NAME, bytes: sumsFor(genuine) }] }), repository, tag, reconstruct, install: hooks.install, work: join(work, 'missing') });
      add('release.assetMissingIsRefused', result.result === 'FAIL' && failedChecks(result).includes('release.carriesTheAsset') && hooks.calls.length === 0, 'a release without the package asset is refused', failedChecks(result).join(', '));
    }
    {
      const hooks = installer();
      const result = await run(genuine, Buffer.from(`${'0'.repeat(64)}  other.tgz\n`, 'utf8'), hooks);
      add('sums.missingEntryIsRefused', result.result === 'FAIL' && failedChecks(result).includes('sums.namesTheAsset') && hooks.calls.length === 0, 'SHA256SUMS that does not list the asset refuses it', failedChecks(result).join(', '));
    }
    {
      const hooks = installer();
      const notATar = gzipSync(Buffer.from('this is a valid gzip stream that is not a tar archive', 'utf8'));
      const result = await run(notATar, sumsFor(notATar), hooks);
      add('asset.notATarIsRefused', result.result === 'FAIL' && failedChecks(result).includes('asset.opensAsATarball') && hooks.calls.length === 0, 'bytes that are not a tarball are refused before any install, even with a matching sum', failedChecks(result).join(', '));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return cases;
}

// --------------------------------------------------------------------- cli

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const at = args.indexOf(flag);
    return at === -1 ? null : args[at + 1] ?? null;
  };
  if (args.includes('--self-test')) {
    const cases = await selfTest();
    const failures = cases.filter((entry) => !entry.ok);
    process.stdout.write(`${PUBLISHED_ASSET_GATE} self-test: ${String(cases.length)} cases\n\n`);
    for (const entry of cases) process.stdout.write(`  ${entry.ok ? 'ok   ' : 'FALSE'} ${entry.id}\n`);
    for (const entry of failures) process.stdout.write(`\n  ${entry.id}\n    expected: ${entry.expected}\n    observed: ${entry.observed}\n`);
    process.stdout.write(`\n${PUBLISHED_ASSET_GATE} self-test = ${failures.length === 0 ? 'PASS' : 'FALSE'}\n\n`);
    process.stdout.write(`${JSON.stringify({ gate: PUBLISHED_ASSET_GATE, mode: 'SELF_TEST_SIMULATED', checksRun: cases.length, failures: failures.length, passed: failures.length === 0, cases: cases.map((entry) => ({ id: entry.id, ok: entry.ok })) }, null, 2)}\n`);
    process.exit(failures.length === 0 ? 0 : 1);
  }
  const assetUrlArg = valueOf('--asset-url');
  const sha256Arg = valueOf('--sha256');
  let repository = valueOf('--repo');
  let tag = valueOf('--tag');
  if (assetUrlArg !== null) {
    const parsed = parseAssetUrl(assetUrlArg);
    if (parsed === null || sha256Arg === null || !/^[0-9a-f]{64}$/iu.test(sha256Arg)) {
      process.stderr.write('usage: node tools/published-asset-check.mjs --asset-url https://github.com/OWNER/NAME/releases/download/vX.Y.Z/kauro-migration-core-X.Y.Z.tgz --sha256 <64 hex> [--out <path>]\n');
      process.exit(64);
    }
    repository = parsed.repository;
    tag = parsed.tag;
  }
  if (repository === null || tag === null || !/^[^/\s]+\/[^/\s]+$/u.test(repository) || !/^v\d+\.\d+\.\d+$/u.test(tag)) {
    process.stderr.write('usage: node tools/published-asset-check.mjs --repo <owner/name> --tag <vX.Y.Z> [--out <path>]\n       node tools/published-asset-check.mjs --self-test\n');
    process.exit(64);
  }
  const out = resolve(repoRoot, valueOf('--out') ?? PUBLISHED_ASSET_EVIDENCE_PATH);
  const work = mkdtempSync(join(tmpdir(), 'kauro-published-asset-'));
  let evidence;
  try {
    evidence = await checkPublishedAsset({
      api: github(),
      repository,
      tag,
      work,
      install: installWithConsumerCheck,
      assetUrl: assetUrlArg,
      expectedSha256: sha256Arg,
      fetchUrl: async (url) => {
        const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new Error(`GET ${url} returned ${String(response.status)}`);
        return Buffer.from(await response.arrayBuffer());
      },
      reconstruct: async ({ sha, coreVersion }) => reconstructCandidate({ sha, coreVersion }),
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  for (const entry of evidence.checks) process.stdout.write(`  ${entry.ok ? 'ok   ' : 'FALSE'} ${entry.id}${entry.ok ? '' : `: ${String(entry.observed).slice(0, 200)}`}\n`);
  process.stdout.write(`\n${PUBLISHED_ASSET_GATE} = ${evidence.result}; wrote ${out}\n`);
  process.exit(evidence.result === 'PASS' ? 0 : 1);
}
