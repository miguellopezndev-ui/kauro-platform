#!/usr/bin/env node
/**
 * Seals a directory of evidence: MANIFEST.json with the sha256 and size of
 * every file under it (itself excluded), sorted by path, plus one digest over
 * the whole list so a dossier can be named by a single hash. Verify mode
 * recomputes and reports every file that changed, disappeared or appeared.
 *
 *   node tools/evidence-manifest.mjs <dir>              write <dir>/MANIFEST.json
 *   node tools/evidence-manifest.mjs --verify <dir>     recompute; exit 1 on any mismatch
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const MANIFEST = 'MANIFEST.json';

export function manifestEntries(dir) {
  const entries = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        const rel = relative(dir, path).replace(/\\/gu, '/');
        if (rel === MANIFEST) continue;
        const bytes = readFileSync(path);
        entries.push({ path: rel, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
      }
    }
  };
  walk(dir);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

export function buildManifest(dir) {
  const files = manifestEntries(dir);
  const digest = createHash('sha256').update(JSON.stringify(files.map((entry) => [entry.path, entry.sha256, entry.bytes]))).digest('hex');
  return { artifactKind: 'KAURO_EVIDENCE_MANIFEST', algorithm: 'sha256', createdAt: new Date().toISOString(), fileCount: files.length, totalBytes: files.reduce((sum, entry) => sum + entry.bytes, 0), digest, files };
}

/** Every difference between the manifest on disk and the files on disk. */
export function verifyManifest(dir) {
  const path = join(dir, MANIFEST);
  if (!existsSync(path)) return { ok: false, problems: [`no ${MANIFEST} in ${dir}`], digest: null };
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const current = buildManifest(dir);
  const recorded = new Map((manifest.files ?? []).map((entry) => [entry.path, entry]));
  const problems = [];
  for (const entry of current.files) {
    const was = recorded.get(entry.path);
    if (was === undefined) problems.push(`added: ${entry.path}`);
    else if (was.sha256 !== entry.sha256 || was.bytes !== entry.bytes) problems.push(`changed: ${entry.path} (${String(was.sha256).slice(0, 12)} → ${entry.sha256.slice(0, 12)})`);
  }
  for (const entry of recorded.keys()) if (!current.files.some((candidate) => candidate.path === entry)) problems.push(`missing: ${entry}`);
  if (manifest.digest !== current.digest) problems.push(`digest ${String(manifest.digest)} recorded, ${current.digest} recomputed`);
  return { ok: problems.length === 0, problems, digest: current.digest, fileCount: current.fileCount };
}

const args = process.argv.slice(2);
const verify = args.includes('--verify');
const target = args.find((value) => value !== '--verify');
if (target === undefined) {
  process.stderr.write('usage: evidence-manifest.mjs [--verify] <dir>\n');
  process.exit(2);
}
const dir = resolve(target);
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  process.stderr.write(`${dir} is not a directory\n`);
  process.exit(2);
}
if (verify) {
  const result = verifyManifest(dir);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stderr.write(`EVIDENCE MANIFEST ${dir} = ${result.ok ? `INTACT (${String(result.fileCount)} files, digest ${String(result.digest).slice(0, 16)}…)` : `MISMATCH: ${result.problems.join('; ')}`}\n`);
  process.exit(result.ok ? 0 : 1);
}
const manifest = buildManifest(dir);
writeFileSync(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ manifest: join(dir, MANIFEST), fileCount: manifest.fileCount, totalBytes: manifest.totalBytes, digest: manifest.digest }, null, 2)}\n`);
process.stderr.write(`EVIDENCE MANIFEST written: ${String(manifest.fileCount)} files, digest ${manifest.digest.slice(0, 16)}…\n`);
