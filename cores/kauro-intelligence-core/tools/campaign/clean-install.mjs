// The clean install of a campaign stage (B04-CAMPAIGN, D4-CAMP-5): the packed Intelligence Core (packed here, or the tarball given) and
// the vendored Migration Core release installed from bytes in a fresh directory, with tools/campaign and the corpus binders copied
// beside them. The runner's stage and preflight's scorer-validity rerun (validity v4) run from there and import the package by name.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageDigestOfTarball } from './package-digest.mjs';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const shell = process.platform === 'win32';
const npm = (args, cwd) => spawnSync('npm', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell });

/** Packs the core and installs the tarball with the vendored Migration Core in a clean directory; the stage code is staged beside them. */
export function packAndInstall({ work, tarball: given = null }) {
  if (!existsSync(join(repo, 'dist', 'src', 'index.js'))) throw new Error('dist/src is not built: run `npm run build` first');
  const manifest = JSON.parse(readFileSync(join(repo, 'vendor', 'MANIFEST.json'), 'utf8'));
  let tarball = given;
  if (tarball === null) {
    const packed = npm(['pack', '--silent', '--pack-destination', work], repo);
    if (packed.status !== 0) throw new Error(`npm pack exited ${String(packed.status)}: ${packed.stderr}`);
    const name = readdirSync(work).find((entry) => entry.endsWith('.tgz'));
    if (name === undefined) throw new Error('npm pack produced no tarball');
    tarball = join(work, name);
  }
  const project = join(work, 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'kauro-ic-campaign-clean', private: true, type: 'module' }));
  const installed = npm(['install', '--silent', '--no-audit', '--no-fund', '--ignore-scripts', tarball, join(repo, manifest.file)], project);
  if (installed.status !== 0) throw new Error(`npm install exited ${String(installed.status)}: ${String(installed.stderr).slice(-400)}`);
  const packageDir = join(project, 'node_modules', 'kauro-intelligence-core');
  if (!existsSync(join(packageDir, 'dist', 'src', 'index.js'))) throw new Error('the packed core carries no dist/src/index.js');
  // The stage code is copied beside the install and imports the package by name: no path into the package's dist, no link to it.
  cpSync(join(repo, 'tools', 'campaign'), join(project, 'tools', 'campaign'), { recursive: true });
  mkdirSync(join(project, 'tools', 'corpus'), { recursive: true });
  // bind.mjs imports attest.mjs (multi-file fixtures, D4-CORP-6): the clean project carries both.
  for (const file of ['bind.mjs', 'attest.mjs']) copyFileSync(join(repo, 'tools', 'corpus', file), join(project, 'tools', 'corpus', file));
  const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  // packageDigest: the content digest validity v4 binds (S044); tarballSha256: the bytes of this one tarball, as packed here.
  return { project, tarball, tarballSha256: digest, packageDigest: packageDigestOfTarball(tarball) };
}

