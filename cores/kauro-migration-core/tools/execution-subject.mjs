#!/usr/bin/env node
/**
 * The execution subject: what a piece of evidence is evidence about.
 *
 * A vendor gate, a capacity run or an offline universe measures the behaviour
 * of a subject, and the subject is more than `src/`. It is the runtime and the
 * harness that drove it, the oracle it was judged against, the fixtures and
 * corpora it was fed, the contracts it serialised, the dependencies it linked,
 * the configuration it read and the workflow that will run it again. MC-2 bound
 * evidence to a *code* digest over `src/`, `tools/`, `spec/` and the lockfile,
 * which left the oracles and the corpora out — a runner could change what it
 * expected without the binding moving — and it bound capacity evidence by a
 * stamping tool rather than by the producer (MC-2 items 1 and 30).
 *
 * This module measures the subject once, as a manifest of per-class digests
 * (see `tools/invalidation-policy.mjs` for the classes) plus the closed
 * dependency set from the lockfile and every version the tree declares, and
 * names it by one digest. A producer captures that digest when it starts and
 * again when it finishes; the gate recomputes it over the candidate. Three
 * things follow:
 *
 *   - a document edit does not move it, so an editorial correction does not
 *     invalidate a campaign;
 *   - a change to a runner, an oracle, a mapper, a contract, the engine or a
 *     dependency does move it, so evidence taken before that change is refused;
 *   - a change that lands while a producer is running is caught by the producer
 *     itself, because the end capture disagrees with the start capture.
 *
 * The environment (node, platform, CPU count, memory) is recorded beside the
 * subject and is deliberately not part of the digest: the gate runs in CI on a
 * different machine from the one that produced the evidence, and what the gate
 * asks is whether the *inputs* were the same, not whether the hardware was.
 * The hardware is in the evidence, where a reader can see it.
 *
 *   node tools/execution-subject.mjs           print the subject manifest
 *   node tools/execution-subject.mjs --digest  print only the digest
 */
import { readFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import { DIGEST_SERIALISATION_VERSION, digestRecords, measureTree, repoRoot } from './candidate-provenance.mjs';
import { CHANGE_CLASSES, SUBJECT_CLASSES, classifyPath } from './invalidation-policy.mjs';
import { readVersions } from './versions.mjs';

export const SUBJECT_VERSION = '1.0.0';

/**
 * The dependency closure the lockfile pins: every package, its version and its
 * integrity, sorted. A lockfile digest alone says the file changed; this says
 * which packages did, and it is what a reader compares two subjects by.
 */
export function dependencyClosure() {
  const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));
  const packages = lock.packages ?? {};
  const closure = [];
  for (const [path, entry] of Object.entries(packages)) {
    if (path === '') continue;
    closure.push({
      path,
      version: String(entry.version ?? ''),
      integrity: String(entry.integrity ?? ''),
      dev: entry.dev === true,
    });
  }
  closure.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { lockfileVersion: lock.lockfileVersion ?? null, packages: closure };
}

function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/**
 * Canonical JSON with sorted keys, so the digest does not depend on insertion order.
 */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('a subject cannot hold a non-finite number');
  return JSON.stringify(value);
}

/**
 * Measure the subject of this tree.
 *
 * @returns {Promise<{subject: object|null, subjectDigest: string|null, problems: string[]}>}
 */
export async function measureSubject() {
  const measured = measureTree();
  if (measured.records === null) return { subject: null, subjectDigest: null, problems: measured.problems };
  const byClass = Object.fromEntries(CHANGE_CLASSES.map((name) => [name, []]));
  for (const record of measured.records) byClass[classifyPath(record.path)].push(record);

  const classes = {};
  for (const name of CHANGE_CLASSES) {
    const records = byClass[name];
    classes[name] = {
      files: records.length,
      bytes: records.reduce((total, entry) => total + entry.bytes, 0),
      digest: records.length === 0 ? null : digestRecords('manifest', records),
      inSubject: SUBJECT_CLASSES.includes(name),
    };
  }

  let versions;
  try {
    versions = await readVersions();
  } catch (error) {
    return {
      subject: null,
      subjectDigest: null,
      problems: [`the declared versions could not be read (is dist/ built?): ${String(error && error.message ? error.message : error)}`],
    };
  }

  const dependencies = dependencyClosure();
  const subject = {
    subjectVersion: SUBJECT_VERSION,
    digestSerialisationVersion: DIGEST_SERIALISATION_VERSION,
    // Kept for continuity with MC-2's binding, and because it is still the
    // answer to "which engine": the subject is a superset of it.
    codeDigest: measured.codeDigest,
    // Every class, so a reader can see what the tree holds — including the
    // classes deliberately left out of the digest, which are the interesting
    // ones when two subjects agree and two trees do not.
    classes,
    subjectFileCount: SUBJECT_CLASSES.reduce((total, name) => total + classes[name].files, 0),
    dependencies: {
      lockfileVersion: dependencies.lockfileVersion,
      packageCount: dependencies.packages.length,
      closureDigest: sha256(canonical(dependencies.packages)),
      packages: dependencies.packages,
    },
    versions,
  };
  const subjectDigest = sha256(canonical(subjectValue(subject)));
  return { subject, subjectDigest, problems: [] };
}

/**
 * The part of a measured subject the digest is taken over.
 *
 * This existed only as a comment before, and the comment was wrong. The digest
 * was `sha256(canonical(subject))` over the whole census — every class,
 * EVIDENCE and GENERATED and EDITORIAL included — which contradicted the two
 * guarantees this module is for and broke the campaign it is the foundation of:
 *
 *   - a document edit *did* move the subject digest, so correcting a sentence
 *     in a README invalidated every measurement of the campaign;
 *   - worse, a producer *writing its own evidence* moved it. The first vendor
 *     gate of a campaign would run, write `qualification/evidence/…json`, and
 *     the second would refuse to start because the tree no longer matched the
 *     campaign it was sealed under. Only one producer per campaign could ever
 *     run, and the way that failure presents — "re-seal the campaign, or check
 *     out the sealed tree" — reads as an operator mistake rather than as this.
 *
 * So the digest is taken over the subject classes and nothing else. The rule is
 * mechanical and a reader can reapply it to a printed subject without knowing
 * anything this file knows: keep the class entries whose `inSubject` is true,
 * drop the rest, and hash what is left with the versions, the code digest and
 * the dependency closure.
 *
 * @param {object} subject as returned by `measureSubject()`
 * @returns {object} the value `subjectDigest` is computed over
 */
export function subjectValue(subject) {
  const classes = {};
  for (const [name, entry] of Object.entries(subject.classes)) {
    if (entry.inSubject !== true) continue;
    classes[name] = { files: entry.files, bytes: entry.bytes, digest: entry.digest };
  }
  return {
    subjectVersion: subject.subjectVersion,
    digestSerialisationVersion: subject.digestSerialisationVersion,
    codeDigest: subject.codeDigest,
    classes,
    subjectFileCount: subject.subjectFileCount,
    dependencies: subject.dependencies,
    versions: subject.versions,
  };
}

/** The environment a producer ran in. Recorded beside a capture, never digested into the subject. */
export function environmentRecord(extra = {}) {
  return {
    node: process.version,
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    ...extra,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { subject, subjectDigest, problems } = await measureSubject();
  if (subject === null) {
    process.stderr.write(`the subject could not be measured:\n${problems.map((problem) => `  - ${problem}`).join('\n')}\n`);
    process.exit(1);
  }
  if (process.argv.includes('--digest')) {
    process.stdout.write(`${subjectDigest}\n`);
  } else {
    const { packages, ...dependencies } = subject.dependencies;
    process.stdout.write(`${JSON.stringify({ subjectDigest, ...subject, dependencies: { ...dependencies, packagesOmitted: packages.length } }, null, 2)}\n`);
  }
}
