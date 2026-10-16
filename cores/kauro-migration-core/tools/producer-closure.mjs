#!/usr/bin/env node
/**
 * What each producer of evidence actually depends on, by file, and one
 * fingerprint over exactly that.
 *
 * ---- the defect this replaces ----
 *
 * Evidence was bound to a single digest over the whole execution subject, and
 * the subject was class-granular: `tools/capacity.mjs` and `tools/sabotage.mjs`
 * were both SEMANTIC_HARNESS, so a one-line fix to how sabotage cleans up after
 * itself moved the digest the capacity measurements were bound to, and seven
 * hours of measurement were retaken over an engine, a set of contracts and a set
 * of oracles that were byte for byte the same. That happened three times on one
 * front. The rule the binding implements — "producer, validator or runtime
 * changes force a new campaign" — is producer-granular; the tool that enforced
 * it was not.
 *
 * ---- what this is ----
 *
 * A declared registry of producers, each with an entry file and the inputs it
 * reads that are not imports, and a tracer that walks the entry file's import
 * graph — static `import … from`, `await import('…')`, and
 * `new URL('…', import.meta.url)` — resolving every relative specifier to a
 * tracked file. An import into `dist/` is an import of the whole engine: `dist/`
 * is built from `src/`, so every file under `src/` plus the files that decide
 * how it is built join the closure.
 *
 * The closure is the set of tracked files reached. The **fingerprint** is a
 * digest over their paths and their content digests, sorted. A producer records
 * its fingerprint when it starts and when it ends; a gate compares the recorded
 * fingerprint against the one it computes for the same producer over the tree
 * it is judging. If they agree, nothing the measurement depended on has moved,
 * whatever else in the tree has.
 *
 * ---- what it deliberately does not do ----
 *
 * It does not guess. A specifier it cannot resolve to a tracked file is
 * recorded as unresolved and makes the fingerprint refuse to compute, because a
 * closure with a hole in it is a closure that would accept a change it cannot
 * see. It does not follow `node_modules`: the dependency closure is fingerprinted
 * separately by the lockfile, which every producer's closure includes. And it is
 * not a build system; it is a reader of one repository's import graph, and its
 * whole vocabulary is the three import shapes above.
 *
 *   node tools/producer-closure.mjs                 every producer, closure size and fingerprint
 *   node tools/producer-closure.mjs <producer>      that producer's files
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { measureTree, repoRoot } from './candidate-provenance.mjs';
import { SUBJECT_CLASSES, classifyPath } from './invalidation-policy.mjs';

export const PRODUCER_CLOSURE_VERSION = '1.0.0';

/**
 * The producers, by the repository path each is invoked as.
 *
 * `inputs` are files a producer reads that no import statement names: the
 * oracle it is judged against, the corpus it feeds the engine, the profiles
 * that declare its scale, the allowlist it consults before writing. A prefix
 * ending in `/` names every tracked file under it.
 *
 * `tools/universe.mjs` runs every gate there is, so its closure is declared as
 * the whole subject rather than traced: tracing it would reach the same set by
 * a longer road, and a declaration cannot silently lose a leg.
 */
export const PRODUCERS = Object.freeze({
  'tools/capacity.mjs': Object.freeze({
    kind: 'CAPACITY',
    inputs: Object.freeze(['qualification/capacity/profiles.json']),
  }),
  'qualification/hubspot/run-target-qualification.mjs': Object.freeze({
    kind: 'VENDOR',
    inputs: Object.freeze(['qualification/oracles.mjs', 'qualification/authorized-instances.json', 'qualification/hubspot/EXPECTED_TRUTH.md']),
  }),
  'qualification/hubspot/run-import-qualification.mjs': Object.freeze({
    kind: 'VENDOR',
    inputs: Object.freeze([
      'qualification/oracles.mjs',
      'qualification/authorized-instances.json',
      'qualification/hubspot/EXPECTED_TRUTH.md',
      'qualification/hubspot/corpus/',
    ]),
  }),
  'qualification/salesforce/run-target-qualification.mjs': Object.freeze({
    kind: 'VENDOR',
    inputs: Object.freeze(['qualification/oracles.mjs', 'qualification/authorized-instances.json', 'qualification/salesforce/EXPECTED_TRUTH.md']),
  }),
  'qualification/salesforce/run-dataloader-qualification.mjs': Object.freeze({
    kind: 'VENDOR',
    inputs: Object.freeze([
      'qualification/oracles.mjs',
      'qualification/authorized-instances.json',
      'qualification/salesforce/EXPECTED_TRUTH.md',
      'qualification/salesforce/dataloader-launcher/',
    ]),
  }),
  'qualification/salesforce/run-ocr-qualification.mjs': Object.freeze({
    kind: 'VENDOR',
    inputs: Object.freeze([
      'qualification/oracles.mjs',
      'qualification/authorized-instances.json',
      'qualification/salesforce/EXPECTED_TRUTH.md',
      'qualification/salesforce/dataloader-launcher/',
    ]),
  }),
  'tools/universe.mjs': Object.freeze({ kind: 'UNIVERSE', wholeSubject: true, inputs: Object.freeze([]) }),
});

/** What every closure carries because the engine is built from it. */
const ENGINE_PREFIXES = Object.freeze(['src/']);
const ENGINE_FILES = Object.freeze(['package.json', 'package-lock.json', 'tsconfig.json']);

const IMPORT_PATTERNS = [
  // a static import, default or named or bare, with a quoted specifier
  /\bimport\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gu,
  // a re-export with a quoted specifier
  /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gu,
  // a dynamic import with a quoted specifier, possibly across lines
  /\bimport\(\s*['"]([^'"]+)['"]\s*,?\s*\)/gu,
  // a URL built against import.meta.url, whose first argument is the specifier
  /new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/gu,
];


/**
 * Source with its comments removed, so a specifier quoted in prose is not read
 * as an import. Block comments and line comments; string contents are left
 * alone, which is enough because a relative specifier never contains two
 * slashes in a row and a URL inside a string is never a relative import.
 */
function stripComments(source) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (quote !== null) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? source.length : close + 2;
      continue;
    }
    if (c === '/' && next === '/') {
      const eol = source.indexOf('\n', i);
      i = eol === -1 ? source.length : eol;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function toPosix(path) {
  return path.split(sep).join('/');
}

/**
 * Resolve one specifier from one file to a repository-relative POSIX path, or
 * null where it is not a relative import of something in this repository.
 */
function resolveSpecifier(fromFile, specifier, { bareIsRelative = false } = {}) {
  // A URL built against import.meta.url resolves a bare name against the
  // importing file's directory, exactly as a dot-slash prefix would; an import
  // specifier does not. The two shapes therefore get different rules, and a
  // bare name in the URL shape was the hole the first version of this tracer
  // had: capacity.mjs loads evidence-schema.mjs, capacity-profiles.mjs and
  // qualification-attestation.mjs that way, and all three were missing from its
  // closure.
  // Only a file is an import. `new URL('..', import.meta.url)` is how these
  // modules find the repository root, and '.' its own directory; neither names
  // anything to read, and treating them as imports produced an empty path that
  // no tree could contain.
  if (bareIsRelative && !/.(?:mjs|cjs|js|ts|json)$/u.test(specifier)) return null;
  const relativeShape = specifier.startsWith('./') || specifier.startsWith('../');
  const bareShape = bareIsRelative && !relativeShape && !/^[a-z][a-z0-9+.-]*:/iu.test(specifier) && !specifier.startsWith('/');
  if (!relativeShape && !bareShape) return null;
  const absolute = resolve(repoRoot, dirname(fromFile), specifier);
  const rel = toPosix(relative(repoRoot, absolute));
  if (rel.startsWith('..')) return null;
  return rel;
}

/**
 * Trace one producer's closure over the tree's tracked records.
 *
 * @param {string} producer repository path of the entry file
 * @param {ReadonlyArray<{path: string, sha256: string, bytes: number}>} records from `measureTree()`
 * @returns {{files: string[], unresolved: string[], engineIncluded: boolean}}
 */
export function traceClosure(producer, records) {
  const declared = PRODUCERS[producer];
  if (declared === undefined) throw new Error(`${producer} is not a declared producer; see PRODUCERS in tools/producer-closure.mjs`);
  const tracked = new Map(records.map((entry) => [entry.path, entry]));

  if (declared.wholeSubject === true) {
    // The subject, not the tree. This returned every tracked path, which
    // includes the records the universe itself writes and the campaign seal,
    // so sealing moved the universe's fingerprint before anything had run and
    // the universe would have moved its own by writing its report. Evidence,
    // generated records and prose are outputs of the subject, never inputs.
    const files = [...tracked.keys()].filter((path) => SUBJECT_CLASSES.includes(classifyPath(path))).sort();
    return { files, unresolved: [], engineIncluded: true };
  }

  const files = new Set();
  const unresolved = [];
  let engineIncluded = false;
  const queue = [producer];

  const addPrefix = (prefix) => {
    for (const path of tracked.keys()) if (path.startsWith(prefix)) files.add(path);
  };

  while (queue.length > 0) {
    const current = queue.pop();
    if (files.has(current)) continue;
    if (!tracked.has(current)) {
      unresolved.push(current);
      continue;
    }
    files.add(current);
    if (!/\.(?:mjs|cjs|js|ts)$/u.test(current)) continue;
    // Comments stripped first. The tracer read its own source — it is in every
    // closure, through campaign.mjs — and took the example specifiers in its
    // doc comments for imports, so every producer came back unresolved on
    // the example names in them. A specifier inside a comment is not a dependency.
    const text = stripComments(readFileSync(join(repoRoot, ...current.split('/')), 'utf8'));
    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const target = resolveSpecifier(current, match[1], { bareIsRelative: pattern === IMPORT_PATTERNS[3] });
        if (target === null) continue;
        if (target.startsWith('dist/')) {
          if (!engineIncluded) {
            engineIncluded = true;
            for (const prefix of ENGINE_PREFIXES) addPrefix(prefix);
            for (const file of ENGINE_FILES) if (tracked.has(file)) files.add(file);
          }
          continue;
        }
        queue.push(target);
      }
    }
  }

  for (const input of declared.inputs) {
    if (input.endsWith('/')) addPrefix(input);
    else if (tracked.has(input)) files.add(input);
    else unresolved.push(input);
  }

  return { files: [...files].sort(), unresolved, engineIncluded };
}

/**
 * The fingerprint of a producer over the current tree.
 *
 * @returns {{producer: string, fingerprint: string|null, files: number, unresolved: string[], closure: Array<{path: string, sha256: string}>}}
 */
export function fingerprintProducer(producer, records) {
  const traced = traceClosure(producer, records);
  const byPath = new Map(records.map((entry) => [entry.path, entry.sha256]));
  const closure = traced.files.map((path) => ({ path, sha256: byPath.get(path) }));
  if (traced.unresolved.length > 0) {
    return { producer, fingerprint: null, files: closure.length, unresolved: traced.unresolved, closure };
  }
  const canonical = JSON.stringify({ version: PRODUCER_CLOSURE_VERSION, producer, closure });
  return {
    producer,
    fingerprint: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    files: closure.length,
    unresolved: [],
    closure,
  };
}

/**
 * Every producer's fingerprint over the current tree, measured once.
 *
 * @returns {Promise<{fingerprints: Record<string, string|null>, details: Record<string, object>, problems: string[]}>}
 */
export async function measureProducers() {
  const measured = measureTree();
  if (measured.records === null) return { fingerprints: {}, details: {}, problems: measured.problems };
  const fingerprints = {};
  const details = {};
  const problems = [];
  for (const producer of Object.keys(PRODUCERS)) {
    const result = fingerprintProducer(producer, measured.records);
    fingerprints[producer] = result.fingerprint;
    details[producer] = { files: result.files, unresolved: result.unresolved, kind: PRODUCERS[producer].kind };
    if (result.fingerprint === null) {
      problems.push(`${producer} imports ${result.unresolved.join(', ')}, which resolve to nothing tracked; a closure with a hole in it is refused`);
    }
  }
  return { fingerprints, details, problems };
}

/**
 * Which files of a producer's closure differ between two closures.
 *
 * @param {Array<{path: string, sha256: string}>} before
 * @param {Array<{path: string, sha256: string}>} after
 */
export function closureDiff(before, after) {
  const was = new Map(before.map((entry) => [entry.path, entry.sha256]));
  const now = new Map(after.map((entry) => [entry.path, entry.sha256]));
  const changed = [];
  const added = [];
  const removed = [];
  for (const [path, digest] of now) {
    if (!was.has(path)) added.push(path);
    else if (was.get(path) !== digest) changed.push(path);
  }
  for (const path of was.keys()) if (!now.has(path)) removed.push(path);
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
}

/**
 * May evidence recorded under one fingerprint stand for another?
 *
 * The fingerprint is the claim "nothing this measurement read has moved". When
 * it has not moved, the evidence is reusable as it is. When it has, the evidence
 * is about bytes that are no longer the producer's, and it survives only through
 * an explicit transitive-equivalence record (S092) that
 *
 *   - names this producer and this exact pair of fingerprints, so it cannot be
 *     carried from one change to another;
 *   - lists every file that differs between the two closures (changed, added and
 *     removed), computed here from the closures and compared with the list, so a
 *     record cannot cover a change it does not name;
 *   - states the argument, in words, for why each of those files does not reach
 *     what was measured.
 *
 * A blanket statement ("only the scorer changed") is none of these. A change to a
 * file that is NOT in the producer's closure never reaches this function: the
 * fingerprint does not move, and that is what makes a scorer-only change free.
 *
 * @param {{producer: string, recorded: {fingerprint: string|null, closure: Array<{path: string, sha256: string}>}, current: {fingerprint: string|null, closure: Array<{path: string, sha256: string}>}, equivalence: null | {producer: string, from: string, to: string, changed: string[], added: string[], removed: string[], argument: string}}} input
 * @returns {string[]} why reuse is refused, empty when it is allowed
 */
export function evidenceReuseProblems({ producer, recorded, current, equivalence }) {
  if (recorded.fingerprint === null || current.fingerprint === null) {
    return [`${producer}: a closure with a hole in it has no fingerprint, so nothing recorded under it can be reused`];
  }
  if (recorded.fingerprint === current.fingerprint) return [];
  if (equivalence === null || equivalence === undefined) {
    return [`${producer}: the fingerprint moved (${recorded.fingerprint.slice(0, 12)} to ${current.fingerprint.slice(0, 12)}) and there is no equivalence record saying why the recorded evidence still holds`];
  }
  const problems = [];
  if (equivalence.producer !== producer) problems.push(`the equivalence record is for ${String(equivalence.producer)}, not ${producer}`);
  if (equivalence.from !== recorded.fingerprint) problems.push('the equivalence record does not start at the fingerprint the evidence was recorded under');
  if (equivalence.to !== current.fingerprint) problems.push('the equivalence record does not end at the fingerprint of this tree');
  const difference = closureDiff(recorded.closure, current.closure);
  for (const kind of ['changed', 'added', 'removed']) {
    const named = [...(Array.isArray(equivalence[kind]) ? equivalence[kind] : [])].sort();
    if (JSON.stringify(named) !== JSON.stringify(difference[kind])) {
      problems.push(`the equivalence record names ${String(named.length)} ${kind} file(s) and the closures differ in ${String(difference[kind].length)}${difference[kind].length > 0 ? `: ${difference[kind].join(', ')}` : ''}`);
    }
  }
  if (difference.changed.length + difference.added.length + difference.removed.length === 0) {
    problems.push('the closures are the same and the fingerprints still differ; nothing can be argued equivalent');
  }
  if (typeof equivalence.argument !== 'string' || equivalence.argument.trim().length < 40) {
    problems.push('the equivalence record gives no argument (at least a sentence) for why the changed files do not reach what was measured');
  }
  return problems;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const wanted = process.argv[2] ?? null;
  const measured = measureTree();
  if (measured.records === null) {
    process.stderr.write(`the tree could not be measured:\n${measured.problems.map((problem) => `  - ${problem}`).join('\n')}\n`);
    process.exit(1);
  }
  if (wanted !== null) {
    const result = fingerprintProducer(wanted, measured.records);
    for (const entry of result.closure) process.stdout.write(`${entry.sha256.slice(0, 12)}  ${entry.path}\n`);
    process.stdout.write(`\n${result.producer}: ${String(result.files)} files, fingerprint ${String(result.fingerprint)}\n`);
    if (result.unresolved.length > 0) process.stdout.write(`unresolved: ${result.unresolved.join(', ')}\n`);
    process.exit(result.fingerprint === null ? 1 : 0);
  }
  let failed = false;
  for (const producer of Object.keys(PRODUCERS)) {
    const result = fingerprintProducer(producer, measured.records);
    process.stdout.write(`${String(result.fingerprint ?? 'UNRESOLVED').slice(0, 16).padEnd(17)} ${String(result.files).padStart(4)} files  ${producer}\n`);
    if (result.fingerprint === null) failed = true;
  }
  process.exit(failed ? 1 : 0);
}
