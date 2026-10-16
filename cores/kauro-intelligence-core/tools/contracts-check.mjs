#!/usr/bin/env node
/**
 * The vendored Migration Core is the release it says it is, and this core's
 * declared ranges contain what it actually declares.
 *
 * Checks, in this order: vendor/MANIFEST.json names the tarball and its
 * digest; the tarball on disk hashes to that digest; the lockfile resolves
 * the package vendor/MANIFEST.json names to that file; the installed package's version and
 * exported versions are inside SUPPORTED_MIGRATION_CORE; every name this core
 * imports from the package exists. Exit 1 with every problem on the first
 * that fails to hold.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const problems = [];
const manifest = JSON.parse(readFileSync(join(root, 'vendor', 'MANIFEST.json'), 'utf8'));
const tarball = join(root, manifest.file);
if (!existsSync(tarball)) problems.push(`${manifest.file} is not in the tree`);
else {
  const bytes = readFileSync(tarball);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== manifest.sha256) problems.push(`${manifest.file} hashes ${digest.slice(0, 16)}, the manifest says ${String(manifest.sha256).slice(0, 16)}`);
  if (bytes.length !== manifest.bytes) problems.push(`${manifest.file} is ${String(bytes.length)} bytes, the manifest says ${String(manifest.bytes)}`);
}
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const locked = lock.packages?.[`node_modules/${manifest.name}`];
if (locked === undefined) problems.push(`the lockfile does not resolve ${manifest.name}`);
else if (locked.resolved !== manifest.file && locked.resolved !== `file:${manifest.file}` && !String(locked.resolved).endsWith(manifest.file.split('/').pop())) problems.push(`the lockfile resolves ${manifest.name} to ${String(locked.resolved)}, not ${manifest.file}`);
if (locked !== undefined && locked.version !== manifest.version) problems.push(`the lockfile has ${manifest.name} ${String(locked.version)}, the manifest ${manifest.version}`);

const installed = JSON.parse(readFileSync(join(root, 'node_modules', manifest.name, 'package.json'), 'utf8'));
if (installed.name !== manifest.name) problems.push(`installed package is named ${String(installed.name)}, the manifest ${manifest.name}`);
if (installed.version !== manifest.version) problems.push(`installed ${manifest.name} is ${String(installed.version)}, the manifest ${manifest.version}`);

const versions = await import(new URL('../dist/src/contracts/versions.js', import.meta.url).href).catch(() => null);
if (versions === null) problems.push('dist/src/contracts/versions.js is not built; run npm run build first');
else {
  const vendored = versions.vendoredCompatibilityProblems();
  problems.push(...vendored.map((problem) => `vendored: ${problem}`));
  if (versions.VENDORED_MIGRATION_CORE.coreVersion !== manifest.version) problems.push(`the package exports CORE_VERSION ${versions.VENDORED_MIGRATION_CORE.coreVersion}, the manifest ${manifest.version}`);
}

// Every name imported from the package exists on its public entry.
const mc = await import(manifest.name);
const specifier = manifest.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const importPattern = new RegExp(`import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*'${specifier}'`, 'gu');
const used = new Set();
const walk = (text) => {
  for (const match of text.matchAll(importPattern)) {
    for (const name of match[1].split(',')) {
      const clean = name.replace(/\btype\b/u, '').trim().split(/\s+as\s+/u)[0];
      if (clean !== '') used.add(clean);
    }
  }
};
import { readdirSync, statSync } from 'node:fs';
const files = [];
const collect = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) collect(path);
    else if (entry.endsWith('.ts')) files.push(path);
  }
};
collect(join(root, 'src'));
for (const file of files) walk(readFileSync(file, 'utf8'));
// Type-only names: erased at runtime, declared by the package's index.d.ts. LoadedConfig and RunResult type the product adapter's reading of a run (effectsFromMigrationRun, D3-CFG-3).
const types = new Set(['CandidateSetV1', 'HashedCandidateSet', 'HashedSourceProfile', 'HashedTargetContract', 'SourceProfileV1', 'TargetMode', 'AttestationAuthority', 'TargetAttestation', 'TargetContract', 'LoadedConfig', 'RunResult']);
for (const name of used) {
  if (types.has(name)) continue;
  if (!(name in mc)) problems.push(`src imports ${name} from ${manifest.name} and the package does not export it`);
}

const report = { gate: 'CONTRACTS-01', vendored: { file: manifest.file, version: manifest.version, sha256: manifest.sha256 }, imported: [...used].sort(), problems, passed: problems.length === 0 };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.stderr.write(`CONTRACTS-01 = ${problems.length === 0 ? 'PASS' : 'FALSE'}\n`);
process.exit(problems.length === 0 ? 0 : 1);
