#!/usr/bin/env node
/**
 * The candidate's provenance, in three layers, and the one serialisation they
 * all agree on.
 *
 * There is a paradox at the centre of this, and pretending there is not is how
 * provenance records become fiction. A file inside a tree cannot state the hash
 * of the tree that contains it: writing the hash down changes the tree, which
 * changes the hash. Neither can it state the commit it belongs to, because the
 * commit does not exist until the file is in it, and a rebase changes the commit
 * again afterwards. The V1 record dealt with this by declining to name a commit
 * at all and saying so — honest, and not enough for a candidate, because the
 * whole question about a candidate is *which* candidate.
 *
 * So: three layers, each verifiable on its own.
 *
 *   1. A committed manifest. It hashes a closed set of files, chosen by an
 *      explicit, versioned exclusion rule, and carries a digest over that list.
 *      The manifest excludes itself, the provenance that names it and the
 *      preflight that names both, which is what breaks the circularity — the set
 *      it describes does not change when the description is written. Any
 *      checkout can recompute it.
 *
 *   2. A committed preflight, written by RELEASE-CANDIDATE-01, recording that
 *      every fact obtainable from inside the tree is true and the tree is clean.
 *      It is a decision record, not a report: names, values and digests only, so
 *      it is byte-identical on every platform that reaches the same verdict.
 *
 *   3. A receipt, written by a final CI job after its required jobs are green,
 *      which ties the merged commit, its git tree and the observed check
 *      conclusions to the manifest digest. It lives **outside** the measured
 *      tree, because a receipt committed into the tree cannot name the SHA of
 *      the commit containing it — see tools/receipt-verify.mjs.
 *
 * The evidence files name the code digest. That is what makes evidence belong to
 * a candidate rather than float free: a measurement taken against different code
 * names a different digest, and the gate refuses it.
 *
 * ## Why the serialisation lives here and is exported
 *
 * It was written twice. This file defined the digest over lines
 * `<path> <sha256> <bytes>`; `computeManifestDigest()` in the gate rebuilt the
 * same idea beside it, over the manifest's own stored table rather than over the
 * tree, skipping any entry whose file was missing. Two implementations of one
 * definition is one implementation and one guess, and the guess decided whether
 * the gate passed. There is now a single exported serialiser, versioned because
 * the version is part of what a digest means, and both the producer and every
 * verifier call it. `SERIALISATION_GOLDEN` pins its exact bytes against a fixed
 * vector, so editing either side without meaning to fails immediately rather
 * than silently redefining what a candidate is.
 *
 *   node tools/candidate-provenance.mjs            write both files
 *   node tools/candidate-provenance.mjs --check     verify without writing
 *
 * There is no `--stamp`. There was: it wrote the current code digest into every
 * file under `qualification/capacity`, so a measurement taken against different
 * code became current by running a program. A gate that can be made to pass by
 * running a stamping tool is the gate this front exists in order not to build,
 * and restricting it to one directory narrowed the blast radius of the idea
 * rather than fixing it. A measurement is bound by its producer, at the moment
 * it produced it — see `qualification/campaign.mjs`, where a producer captures
 * the execution subject at start and re-checks it at end.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const MANIFEST_SCHEMA_VERSION = '1.1.0';
export const PROVENANCE_SCHEMA_VERSION = '1.2.0';

const candidateDir = join(repoRoot, 'qualification', 'candidate');
const manifestPath = join(candidateDir, 'manifest.json');
const provenancePath = join(candidateDir, 'provenance.json');

/**
 * The exclusion rule, versioned because it is part of what the digest means.
 *
 * A digest over "the files" is meaningless unless "the files" is a set somebody
 * can reconstruct. Changing this list changes every digest, which is why it is
 * data with a version rather than a condition buried in a walk.
 *
 * The three candidate files exclude themselves: the manifest cannot hash its own
 * bytes; the provenance names the manifest digest, so hashing it would make the
 * digest depend on itself; and the preflight names both. `ci-receipt.json` stays
 * listed even though the gate now refuses to find one in the tree, because the
 * exclusion is what makes that refusal safe to state — the digest does not move
 * depending on whether somebody committed one.
 *
 * 1.1.0 added `preflight.json`. The version moved with it, which is the only
 * reason the version is here.
 *
 * 1.2.0 added `universe.json`, closing a fixed point the 1.1.0 bump left open
 * and which was found by execution rather than by reading. The offline universe
 * writes its report to `qualification/candidate/universe.json`; the gate
 * requires that report to be bound to the candidate's digest; and the report was
 * a member of the manifest's own file set. So: run the universe, and the digest
 * it records is the digest of a tree that did not yet contain the report just
 * written. Regenerate the manifest afterwards and the report's recorded digest
 * is stale. Regenerate the manifest first and writing the report makes
 * `verifyManifest()` say `qualification/candidate/universe.json hashes X, the
 * manifest says Y`. There was no order in which both facts could be true.
 *
 * It is the same paradox as the preflight's, for the same reason — a file that
 * names the digest of the set it belongs to — so it gets the same answer. The
 * durable half of the answer is in the gate: the universe report is bound on the
 * CODE digest as well, and nothing under `qualification/` is in the code set, so
 * that binding cannot chase its own tail even if this exclusion were removed.
 * That is how the evidence binding was fixed when it chased its own tail, and it
 * is the shape to reach for the next time this recurs.
 */
export const EXCLUSION_RULE_VERSION = '1.4.0';
// 1.4.0 removed `bench` from this list. The directory holds scratch output —
// bench/out, bench/capacity, bench/campaign — none of it tracked, so excluding
// it removed nothing from a listing of tracked files except the three
// launchers that are tracked: bench/campaign.sh, bench/prepare-universe.sh and
// its self-test. Those decide which capacity legs run and in what order and
// regenerate the records the universe checks, and they were outside the
// manifest, the subject and the universe's binding. An executable that is not
// measured can change without anything noticing, which is the defect MCR-03
// is about.
export const EXCLUDED_DIRECTORIES = ['.git', 'node_modules', 'dist', 'tmp', 'coverage'];
export const EXCLUDED_PATHS = [
  'qualification/candidate/manifest.json',
  'qualification/candidate/provenance.json',
  'qualification/candidate/preflight.json',
  'qualification/candidate/universe.json',
  'qualification/candidate/ci-receipt.json',
  // The release provenance record, for the reason the four above it are here
  // and one more.
  //
  // `tools/provenance.mjs` vouches for the bytes of the candidate manifest —
  // that is the point of it — and the manifest covered the release record in
  // return. Two files each hashing the other has no fixed point: write the
  // manifest first and the record it hashes is the previous one; write the
  // record first and the manifest it lists is the previous one. Exactly one of
  // `candidate-provenance --check` and `provenance:check` could pass, whichever
  // was written last, and both are required.
  //
  // It is a cycle this front introduced. The generator at the MC-2 head wrote
  // `migration-core-v1-provenance.json` and vouched for no manifest at all, so
  // there was nothing to close the loop; adding the manifest to its inventory —
  // which is right, a release record that does not say what the candidate is
  // says very little — closed it.
  'migration-core-provenance.json',
  // And its rendering, written by the same generator in the same breath. Leaving
  // the Markdown in the digest left the loop exactly where it was: the record
  // hashes the manifest, the manifest covers the record's Markdown, and the two
  // still could not both be current.
  //
  // Neither file goes unchecked by being outside the digest. `provenance:check`
  // regenerates both and compares them byte for byte, and DRIFT-01 reads the
  // record's own claims about every artifact it vouches for.
  'docs/release/MIGRATION_CORE_PROVENANCE.md',
];

// ---------------------------------------------------------------------------
// Paths, portably and inside the repository
// ---------------------------------------------------------------------------

/**
 * A repository-relative POSIX path, resolved to a real path on this platform.
 *
 * `path.split('/').join('\\')` was the previous idiom and it is wrong twice: on
 * POSIX it produces a filename containing literal backslashes, so a file that is
 * present is reported absent; and it never asked whether the result was still
 * inside the repository, so a manifest entry reading `../../etc/passwd` would
 * have been hashed and reported as part of the candidate.
 *
 * So the components are joined by the platform and the result is checked. This
 * throws rather than returning null: every caller here is deciding what a
 * candidate is, and a path it cannot resolve is not a thing to shrug at.
 *
 * @param {string} posixPath repository-relative, `/`-separated
 * @returns {string} an absolute path inside `repoRoot`
 */
export function repoPath(posixPath) {
  if (typeof posixPath !== 'string' || posixPath === '') {
    throw new Error(`not a repository path: ${JSON.stringify(posixPath)}`);
  }
  if (posixPath.includes('\\')) {
    throw new Error(`repository paths are POSIX and must not contain a backslash: ${posixPath}`);
  }
  if (isAbsolute(posixPath) || /^[A-Za-z]:/u.test(posixPath)) {
    throw new Error(`repository paths are relative to the repository root: ${posixPath}`);
  }
  const parts = posixPath.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`repository paths carry no empty, "." or ".." component: ${posixPath}`);
  }
  const resolved = resolve(repoRoot, join(...parts));
  // Containment, checked on the boundary rather than by prefix alone: without
  // the separator, a sibling directory named `kauro-mc2-scratch` would pass a
  // `startsWith('.../kauro-mc2')` test.
  if (resolved !== repoRoot && !resolved.startsWith(repoRoot + sep)) {
    throw new Error(`${posixPath} resolves to ${resolved}, which is outside ${repoRoot}`);
  }
  return resolved;
}

/** The inverse: an absolute path as the repository-relative POSIX path used everywhere here. */
export function repoRelativePosix(absolutePath) {
  return relative(repoRoot, absolutePath).split(sep).join('/');
}

// ---------------------------------------------------------------------------
// The one canonical serialisation
// ---------------------------------------------------------------------------

/**
 * The version of the byte format below. It is not the manifest's schema version:
 * the schema can gain a field without changing a digest, and this cannot change
 * at all without changing every digest in the repository.
 *
 * 2.0.0 replaced `<path> <sha256> <bytes>` joined by newlines. That form was not
 * injective. A path may contain a space on every platform and a newline on
 * POSIX, so two different file sets could serialise to the same bytes — the
 * separator was also legal inside a field. Length-prefixing the path fixes it:
 * a reader consumes exactly as many bytes as the record declares, so no content
 * can be mistaken for structure.
 */
export const DIGEST_SERIALISATION_VERSION = '2.0.0';
const SERIALISATION_MAGIC = 'kauro-candidate-digest';

/**
 * Records sorted the one way that does not depend on a language's idea of order.
 *
 * `Array.prototype.sort()` on strings compares UTF-16 code units, which differs
 * from UTF-8 byte order above the basic plane. Both are deterministic; only one
 * is the order the bytes are actually in.
 */
export function sortByPathBytes(items, pathOf = (item) => item) {
  return items
    .map((item) => ({ item, key: Buffer.from(pathOf(item), 'utf8') }))
    .sort((a, b) => Buffer.compare(a.key, b.key))
    .map((entry) => entry.item);
}

function sortRecords(records) {
  return sortByPathBytes(records, (record) => record.path);
}

/**
 * Serialise a set of `{path, sha256, bytes}` records to the exact bytes a digest
 * is taken over.
 *
 *   <magic>/<version> <kind>\n
 *   <record count>\n
 *   <sha256 hex> <bytes> <path byte length> <path bytes>\n   (per record, sorted)
 *
 * `kind` is domain separation. The manifest digest and the code digest are taken
 * over overlapping sets of the same records, and two different questions must
 * not be able to produce the same answer by coincidence.
 *
 * @param {'manifest'|'code'} kind
 * @param {Array<{path: string, sha256: string, bytes: number}>} records
 * @returns {Buffer}
 */
export function serialiseDigestRecords(kind, records) {
  if (kind !== 'manifest' && kind !== 'code') throw new Error(`unknown digest kind ${String(kind)}`);
  const sorted = sortRecords(records);
  const parts = [Buffer.from(`${SERIALISATION_MAGIC}/${DIGEST_SERIALISATION_VERSION} ${kind}\n${String(sorted.length)}\n`, 'utf8')];
  for (const record of sorted) {
    if (!/^[0-9a-f]{64}$/u.test(String(record.sha256))) {
      throw new Error(`${String(record.path)} carries ${String(record.sha256)}, which is not a lowercase sha256`);
    }
    if (!Number.isSafeInteger(record.bytes) || record.bytes < 0) {
      throw new Error(`${String(record.path)} carries ${String(record.bytes)} bytes, which is not a count`);
    }
    const path = Buffer.from(record.path, 'utf8');
    parts.push(Buffer.from(`${record.sha256} ${String(record.bytes)} ${String(path.length)} `, 'utf8'), path, Buffer.from('\n', 'utf8'));
  }
  return Buffer.concat(parts);
}

/** The digest over those bytes. The only way a digest is produced in this repository. */
export function digestRecords(kind, records) {
  return createHash('sha256').update(serialiseDigestRecords(kind, records)).digest('hex');
}

/** Prose for the manifest, generated from the constants rather than restated beside them. */
export function digestOverDescription() {
  return (
    `${SERIALISATION_MAGIC}/${DIGEST_SERIALISATION_VERSION}: a header line "<magic>/<version> <kind>", ` +
    'a line carrying the record count, then one record per file as ' +
    '"<sha256> <bytes> <path byte length> <path bytes>" terminated by a newline, ' +
    'sorted by the UTF-8 bytes of the path. The path is length-prefixed, so no path content can be read as structure.'
  );
}

/**
 * The golden. Fixed bytes, an independent vector, and a digest written down.
 *
 * Everything else in this repository refuses a constant a machine could compute,
 * and this is the one place that rule inverts: a golden that recomputes itself
 * agrees with whatever the code now does, which is exactly the failure it exists
 * to catch. The digest below was computed once, from the vector below, and
 * pinned. If either the serialiser or this vector is edited, `assertSerialisationGolden()`
 * throws and every tool that touches a candidate stops.
 *
 * The vector is chosen to be load-bearing rather than pretty. It carries a path
 * with a space in it and a path with a multi-byte character, so a change to the
 * separator or to the length prefix cannot pass; and its insertion order is not
 * its sorted order, so a change to the ordering cannot pass either.
 */
export const SERIALISATION_GOLDEN = {
  records: [
    { path: 'tools/zeta.mjs', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', bytes: 0 },
    // Written as an escape rather than as the character, so this file stays pure
    // ASCII and no editor or transcoding step can move the golden by accident.
    { path: 'docs/a\u00f1o.md', sha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb', bytes: 1 },
    { path: 'a b/c.txt', sha256: '3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d', bytes: 2 },
  ],
  manifest: {
    bytes:
      'kauro-candidate-digest/2.0.0 manifest\n' +
      '3\n' +
      '3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d 2 9 a b/c.txt\n' +
      'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb 1 12 docs/a\u00f1o.md\n' +
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 0 14 tools/zeta.mjs\n',
    byteLength: 287,
    digest: '80295ff457a4b9b259b860816320e343c628ab77bbb6a5178536d258ca955b64',
  },
  code: {
    byteLength: 283,
    digest: 'c5bfdfb6b7af36e9de1871fb5013e3fd85b5ab8e9e8fd62f36b73e41e8eff0fa',
  },
};

/**
 * Fail closed on the golden. Called by the producer and by every verifier before
 * either is allowed to state a digest.
 *
 * @returns {string[]} the problems found, empty when the serialisation is intact
 */
export function serialisationGoldenProblems() {
  const problems = [];
  try {
    const manifestBytes = serialiseDigestRecords('manifest', SERIALISATION_GOLDEN.records);
    const expected = Buffer.from(SERIALISATION_GOLDEN.manifest.bytes, 'utf8');
    if (manifestBytes.length !== SERIALISATION_GOLDEN.manifest.byteLength) {
      problems.push(
        `the golden vector serialises to ${String(manifestBytes.length)} bytes, and ${String(SERIALISATION_GOLDEN.manifest.byteLength)} are pinned`,
      );
    }
    if (!manifestBytes.equals(expected)) {
      problems.push(`the golden vector does not serialise to the pinned bytes: ${JSON.stringify(manifestBytes.toString('utf8').slice(0, 200))}`);
    }
    const manifestDigest = digestRecords('manifest', SERIALISATION_GOLDEN.records);
    if (manifestDigest !== SERIALISATION_GOLDEN.manifest.digest) {
      problems.push(`the golden vector digests to ${manifestDigest}, and ${SERIALISATION_GOLDEN.manifest.digest} is pinned`);
    }
    const codeBytes = serialiseDigestRecords('code', SERIALISATION_GOLDEN.records);
    if (codeBytes.length !== SERIALISATION_GOLDEN.code.byteLength) {
      problems.push(`the golden vector serialises to ${String(codeBytes.length)} code bytes, and ${String(SERIALISATION_GOLDEN.code.byteLength)} are pinned`);
    }
    const codeDigest = digestRecords('code', SERIALISATION_GOLDEN.records);
    if (codeDigest !== SERIALISATION_GOLDEN.code.digest) {
      problems.push(`the golden vector digests to ${codeDigest} under kind "code", and ${SERIALISATION_GOLDEN.code.digest} is pinned`);
    }
    if (manifestDigest === codeDigest) {
      problems.push('the manifest and code kinds digest identically, so the two questions are not separated');
    }
  } catch (error) {
    problems.push(`the serialiser threw on the golden vector: ${String(error && error.message ? error.message : error)}`);
  }
  return problems;
}

/** The same, as a refusal. Producers call this; they have nothing to report to. */
export function assertSerialisationGolden() {
  const problems = serialisationGoldenProblems();
  if (problems.length === 0) return;
  throw new Error(
    `the candidate digest serialisation no longer matches its golden, so no digest here means what it says.\n` +
      `${problems.map((problem) => `  - ${problem}`).join('\n')}\n` +
      `Either revert the change to serialiseDigestRecords(), or — if the format was meant to change — raise ` +
      `DIGEST_SERIALISATION_VERSION, recompute SERIALISATION_GOLDEN from the vector, and regenerate every candidate artifact.`,
  );
}

// ---------------------------------------------------------------------------
// The measured set
// ---------------------------------------------------------------------------

/**
 * The tracked files the exclusion rule admits, as repository-relative POSIX
 * paths, in the canonical order.
 *
 * git is the authority on what is in the candidate, not a directory walk: a walk
 * sees whatever happens to be lying about, and what is committed is the only
 * thing another checkout would see.
 */
export function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const paths = output
    .split('\0')
    .filter((path) => path !== '')
    .filter((path) => !EXCLUDED_DIRECTORIES.some((dir) => path === dir || path.startsWith(`${dir}/`)))
    .filter((path) => !EXCLUDED_PATHS.includes(path));
  return sortByPathBytes(paths);
}

function digestOf(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * The digest of everything that decides how the engine behaves.
 *
 * This exists because the first attempt at binding evidence to a candidate
 * chased its own tail. Evidence was stamped with the manifest digest; stamping
 * changed the evidence files; the manifest hashes the evidence files, so the
 * digest changed; and the stamp was stale again the moment it was written. Three
 * rounds produced three different digests and would have produced a fourth.
 *
 * The mistake was asking the wrong question. What a measurement has to say is
 * not "which tree was I part of" — it was not part of the tree when it ran — but
 * "which code did I run against". That is a smaller set, and crucially one the
 * evidence is not a member of: source, tools, the generated specification and
 * the lockfile. Nothing under `qualification/` or `docs/` is in it, so writing a
 * measurement down cannot change it, and the fixed point disappears.
 *
 * The manifest still covers everything, evidence included. The two answer
 * different questions and both are worth having: the code digest says what
 * produced a measurement, and the manifest digest says what the candidate is.
 */
export const CODE_ROOTS = ['src', 'tools', 'spec'];
export const CODE_FILES = ['package.json', 'package-lock.json', 'tsconfig.json'];

export function codeRecords(records) {
  return records.filter((entry) => CODE_FILES.includes(entry.path) || CODE_ROOTS.some((root) => entry.path.startsWith(`${root}/`)));
}

/**
 * Hash the tree. Returns the records and both digests, or the problems that
 * stopped it — never a digest computed over a set it could not fully read.
 */
export function measureTree() {
  const problems = serialisationGoldenProblems();
  if (problems.length > 0) return { records: null, manifestDigest: null, codeDigest: null, problems };
  const records = [];
  let paths;
  try {
    paths = trackedFiles();
  } catch (error) {
    return {
      records: null,
      manifestDigest: null,
      codeDigest: null,
      problems: [`git could not list the tracked files: ${String(error && error.message ? error.message : error)}`],
    };
  }
  for (const path of paths) {
    let full;
    try {
      full = repoPath(path);
    } catch (error) {
      problems.push(String(error && error.message ? error.message : error));
      continue;
    }
    if (!existsSync(full)) {
      // Tracked and not on disk. The producer used to skip these silently, which
      // meant a deleted file quietly shrank the candidate instead of failing it.
      problems.push(`${path} is tracked by git and not present in the working tree`);
      continue;
    }
    records.push({ path, sha256: digestOf(full), bytes: statSync(full).size });
  }
  if (problems.length > 0) return { records: null, manifestDigest: null, codeDigest: null, problems };
  const code = codeRecords(records);
  return {
    records,
    codeRecords: code,
    manifestDigest: digestRecords('manifest', records),
    codeDigest: digestRecords('code', code),
    problems: [],
  };
}

export function buildManifest() {
  const measured = measureTree();
  if (measured.records === null) {
    throw new Error(`the tree could not be measured:\n${measured.problems.map((problem) => `  - ${problem}`).join('\n')}`);
  }
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    artifactKind: 'MIGRATION_CORE_CANDIDATE_MANIFEST',
    codeDigest: measured.codeDigest,
    codeFileCount: measured.codeRecords.length,
    digestSerialisationVersion: DIGEST_SERIALISATION_VERSION,
    exclusionRuleVersion: EXCLUSION_RULE_VERSION,
    exclusion: { directories: EXCLUDED_DIRECTORIES, paths: EXCLUDED_PATHS },
    digestOver: digestOverDescription(),
    fileCount: measured.records.length,
    totalBytes: measured.records.reduce((total, entry) => total + entry.bytes, 0),
    manifestDigest: measured.manifestDigest,
    files: measured.records,
  };
}

/**
 * Verify a manifest against the tree it claims to describe.
 *
 * Every problem is collected. The previous verifier stopped caring once it had
 * two digests to compare, which meant a manifest could disagree with the tree in
 * a dozen places and report one line about it.
 *
 * Three independent questions are asked, and a manifest has to answer all three:
 *
 *   - does the manifest's own stored table hash to the digest it states?
 *   - does the tree hash to that same digest?
 *   - is the manifest's file set exactly the tracked set the exclusion rule
 *     admits — nothing added to the tree and left out, nothing named and gone?
 *
 * The third is the one the old verifier could not ask at all, because it only
 * ever walked the manifest. A file added to the tree and omitted from the
 * manifest was invisible to it.
 *
 * @returns {{manifest: object|null, storedTableDigest: string|null, treeDigest: string|null, codeDigest: string|null, problems: string[]}}
 */
export function verifyManifest(manifest) {
  const problems = serialisationGoldenProblems();
  if (problems.length > 0) return { manifest: null, records: null, storedTableDigest: null, treeDigest: null, codeDigest: null, problems };
  if (manifest === null || typeof manifest !== 'object') {
    return { manifest: null, records: null, storedTableDigest: null, treeDigest: null, codeDigest: null, problems: ['there is no readable manifest to verify'] };
  }
  if (manifest.digestSerialisationVersion !== DIGEST_SERIALISATION_VERSION) {
    problems.push(
      `the manifest was written under digest serialisation ${String(manifest.digestSerialisationVersion)} and this is ${DIGEST_SERIALISATION_VERSION}; ` +
        'regenerate it — a digest from another serialisation is not comparable with one from this',
    );
  }
  if (manifest.exclusionRuleVersion !== EXCLUSION_RULE_VERSION) {
    problems.push(`the manifest was written under exclusion rule ${String(manifest.exclusionRuleVersion)} and this is ${EXCLUSION_RULE_VERSION}`);
  }
  const entries = Array.isArray(manifest.files) ? manifest.files : [];
  if (entries.length === 0) problems.push('the manifest names no files');

  let storedTableDigest = null;
  try {
    storedTableDigest = digestRecords('manifest', entries);
  } catch (error) {
    problems.push(`the manifest's own table cannot be serialised: ${String(error && error.message ? error.message : error)}`);
  }
  if (storedTableDigest !== null && storedTableDigest !== manifest.manifestDigest) {
    problems.push(
      `the manifest states digest ${String(manifest.manifestDigest).slice(0, 16)} and its own table serialises to ${storedTableDigest.slice(0, 16)}`,
    );
  }
  if (Number(manifest.fileCount) !== entries.length) {
    problems.push(`the manifest states ${String(manifest.fileCount)} files and carries ${String(entries.length)}`);
  }

  const measured = measureTree();
  if (measured.records === null) {
    problems.push(...measured.problems);
    return { manifest, records: null, storedTableDigest, treeDigest: null, codeDigest: null, problems };
  }

  // Per-file disagreement, both ways, named individually. A count is not a
  // finding; the path is what somebody has to go and look at.
  const declared = new Map(entries.map((entry) => [entry.path, entry]));
  const actual = new Map(measured.records.map((entry) => [entry.path, entry]));
  for (const [path, entry] of declared) {
    const observed = actual.get(path);
    if (observed === undefined) {
      problems.push(`${path} is named by the manifest and is not in the tracked set the exclusion rule admits`);
      continue;
    }
    if (observed.sha256 !== entry.sha256) {
      problems.push(`${path} hashes ${observed.sha256.slice(0, 12)}, the manifest says ${String(entry.sha256).slice(0, 12)}`);
    }
    if (observed.bytes !== entry.bytes) {
      problems.push(`${path} is ${String(observed.bytes)} bytes, the manifest says ${String(entry.bytes)}`);
    }
  }
  for (const path of actual.keys()) {
    if (!declared.has(path)) problems.push(`${path} is in the tracked set and the manifest does not name it`);
  }

  if (measured.manifestDigest !== manifest.manifestDigest) {
    problems.push(`the tree serialises to ${measured.manifestDigest.slice(0, 16)} and the manifest states ${String(manifest.manifestDigest).slice(0, 16)}`);
  }
  if (measured.codeDigest !== manifest.codeDigest) {
    problems.push(`the code serialises to ${measured.codeDigest.slice(0, 16)} and the manifest states ${String(manifest.codeDigest).slice(0, 16)}`);
  }
  if (Number(manifest.codeFileCount) !== measured.codeRecords.length) {
    problems.push(`the manifest states ${String(manifest.codeFileCount)} code files and the tree has ${String(measured.codeRecords.length)}`);
  }

  // The measured records travel with the verdict. Callers that need to hash a
  // subset of the tree — the gate hashes the corpus a vendor binding names —
  // would otherwise walk and hash every tracked file a second time to ask a
  // question this walk already answered, and two walks are two chances to
  // disagree about what the tracked set is.
  return {
    manifest,
    records: measured.records,
    storedTableDigest,
    treeDigest: measured.manifestDigest,
    codeDigest: measured.codeDigest,
    problems,
  };
}

// ---------------------------------------------------------------------------
// Instances, pseudonymously
// ---------------------------------------------------------------------------

/**
 * A vendor instance, named by the digest of its identifier rather than by the
 * identifier. A provenance record is a public artifact and a portal id is
 * somebody's account.
 *
 * Exported so the gate and the producer cannot drift into two spellings of the
 * same pseudonym, which would read as two instances.
 */
export function pseudonymousInstance(rawIdentifier) {
  return `i_${createHash('sha256').update(String(rawIdentifier)).digest('hex').slice(0, 16)}`;
}

export const PSEUDONYMOUS_INSTANCE_PATTERN = /^i_[0-9a-f]{16}$/u;

/**
 * The binding a vendor runner writes into its evidence, versioned.
 *
 * Bound on the **code** digest and never the manifest digest: the evidence is
 * itself in the manifest, so binding it to the manifest digest is the fixed
 * point this file exists to avoid.
 */
export const VENDOR_BINDING_VERSION = '1.0.0';

/**
 * Who is allowed to have written a vendor binding.
 *
 * Stated as a rule rather than a list of filenames, so adding a runner does not
 * require editing a gate. A vendor binding must name a program that exists,
 * under the vendor's own qualification directory — the runner that talked to the
 * real portal or org. Nothing under `tools/` qualifies, and that is the point: a
 * generic stamping tool must not be able to make historical vendor evidence
 * current.
 *
 * What this checked before was the path prefix and `existsSync`, and that was
 * demonstrated to be satisfied by `qualification/hubspot/README.md` and by the
 * directory `qualification/hubspot/corpus`. A README is prose and a directory is
 * a directory; neither talks to a portal, and a rule that accepts them is a rule
 * about a string. So the target must also be a file and must be a program —
 * every runner in this repository is an `.mjs`, and the extensions are listed
 * rather than inferred so that adding a `.py` runner is a decision somebody
 * makes here rather than a side effect.
 *
 * This is one lock. The other is at the point where `--stamp` writes, below; it
 * refuses to write a binding into vendor evidence at all, and it is checked
 * against the resolved path of every file it is about to touch rather than
 * against the spelling of a directory constant — which is what made the previous
 * version of that refusal unreachable.
 */
export const VENDOR_RUNNER_ROOTS = ['qualification/hubspot/', 'qualification/salesforce/'];
export const VENDOR_RUNNER_EXTENSIONS = ['.mjs', '.js'];

export function vendorRunnerProblems(writtenBy) {
  if (typeof writtenBy !== 'string' || writtenBy === '') return ['names no writtenBy, so nothing says which runner produced it'];
  if (!VENDOR_RUNNER_ROOTS.some((root) => writtenBy.startsWith(root))) {
    return [`names writtenBy ${writtenBy}, which is not a vendor runner under ${VENDOR_RUNNER_ROOTS.join(' or ')}`];
  }
  let full;
  try {
    full = repoPath(writtenBy);
  } catch (error) {
    return [`names writtenBy ${writtenBy}, which is not a repository path: ${String(error && error.message ? error.message : error)}`];
  }
  if (!existsSync(full)) return [`names writtenBy ${writtenBy}, and no such file is in the tree`];
  if (!statSync(full).isFile()) return [`names writtenBy ${writtenBy}, which is a directory and not a runner`];
  if (!VENDOR_RUNNER_EXTENSIONS.some((extension) => writtenBy.endsWith(extension))) {
    return [
      `names writtenBy ${writtenBy}, which is not a program (${VENDOR_RUNNER_EXTENSIONS.join(' or ')}). ` +
        'A measurement is bound by the runner that took it; prose beside a runner did not talk to the portal.',
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// The provenance record
// ---------------------------------------------------------------------------

const versionSource = readFileSync(join(repoRoot, 'src', 'version.ts'), 'utf8');
const coreVersion = (versionSource.match(/CORE_VERSION\s*=\s*'([^']+)'/u) ?? [])[1] ?? 'unknown';
const packageFormatVersion = (versionSource.match(/PACKAGE_FORMAT_VERSION\s*=\s*'([^']+)'/u) ?? [])[1] ?? 'unknown';
const sourceRegistryVersion = (versionSource.match(/SOURCE_REGISTRY_VERSION\s*=\s*'([^']+)'/u) ?? [])[1] ?? 'unknown';
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

export const versions = { coreVersion, packageFormatVersion, sourceRegistryVersion, packageVersion: packageJson.version };

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function capacityEvidence() {
  const root = join(repoRoot, 'qualification', 'capacity');
  const found = [];
  if (!existsSync(root)) return found;
  for (const name of readdirSync(root)) {
    if (!name.endsWith('.json') || name === 'profiles.json') continue;
    const evidence = readJson(join(root, name));
    if (evidence === null || typeof evidence.mode !== 'string') continue;
    found.push({
      path: `qualification/capacity/${name}`,
      mode: evidence.mode,
      profile: evidence.profile ?? null,
      sourceRows: evidence.sourceRows ?? null,
      result: evidence.result ?? null,
      sha256: digestOf(join(root, name)),
    });
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function vendorEvidence() {
  const root = join(repoRoot, 'qualification', 'evidence');
  const found = [];
  if (!existsSync(root)) return found;
  for (const name of readdirSync(root).sort()) {
    const full = join(root, name);
    if (!statSync(full).isFile()) continue;
    const evidence = name.endsWith('.json') ? readJson(full) : null;
    const raw = evidence ? (evidence.instanceId ?? evidence.orgId ?? evidence.portalId) : undefined;
    found.push({
      path: `qualification/evidence/${name}`,
      gate: evidence?.gate ?? null,
      instance: raw === undefined ? null : pseudonymousInstance(raw),
      boundTo: typeof evidence?.candidate?.codeDigest === 'string' ? evidence.candidate.codeDigest : null,
      writtenBy: typeof evidence?.candidate?.writtenBy === 'string' ? evidence.candidate.writtenBy : null,
      result: evidence?.result ?? null,
      sha256: digestOf(full),
    });
  }
  return found;
}

export function buildProvenance(manifest) {
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    artifactKind: 'MIGRATION_CORE_CANDIDATE_PROVENANCE',
    generator: 'tools/candidate-provenance.mjs',
    coreVersion,
    packageVersion: packageJson.version,
    packageFormatVersion,
    sourceRegistryVersion,
    // Layer one. The commit is deliberately absent here and supplied by the
    // receipt: see the note at the top of this file for why a file inside a tree
    // cannot name the tree.
    manifestDigest: manifest.manifestDigest,
    codeDigest: manifest.codeDigest,
    manifestFileCount: manifest.fileCount,
    digestSerialisationVersion: DIGEST_SERIALISATION_VERSION,
    exclusionRuleVersion: manifest.exclusionRuleVersion,
    // There is deliberately no `runtime` here, and 1.2.0 is the version that
    // removed it.
    //
    // It recorded `node: process.version` and `platform: "win32 x64"`, and
    // `--check` is a byte-exact comparison of the committed record against a
    // freshly built one. So the committed file could satisfy exactly one
    // platform: regenerated on Windows it failed on every ubuntu runner for
    // ever, regenerated in CI it failed for every developer on Windows, and on
    // either it failed the day `node-version: '24'` resolved to a different
    // patch release — a value neither this repository nor anybody working in it
    // controls. There was no value of the artifact that satisfied the check.
    // That is not a stale artifact needing regeneration; it is a check that
    // cannot be satisfied, and a check that cannot be satisfied gets deleted by
    // whoever is holding the pager.
    //
    // The preflight's own comment already stated the rule and this record broke
    // it: a record compared byte for byte across platforms may carry nothing
    // that differs between them for reasons that are not the verdict. The node
    // version and the platform are exactly that. Where the platform matters —
    // the cross-platform fact — it is the CI matrix's to make and the receipt
    // carries it, read back from GitHub rather than written down here.
    dependencies: {
      runtime: packageJson.dependencies ?? {},
      development: packageJson.devDependencies ?? {},
      lockfileSha256: existsSync(join(repoRoot, 'package-lock.json')) ? digestOf(join(repoRoot, 'package-lock.json')) : null,
    },
    authorities: [
      'KAURO_PRODUCT_CONSTITUTION_V1',
      'KAURO_MIGRATION_CORE_CANONICO_V1',
      'KAURO_MIGRATION_CORE_HOJA_DE_RUTA_CIERRE_V1',
      'KAURO_CUALIFICACION_INTEGRAL_CANONICO_V1',
    ],
    researchSnapshot: {
      sourceRegistryVersion,
      note: 'docs/SOURCE_REGISTRY.md carries the per-section review dates and what each fact is based on.',
    },
    capacityEvidence: capacityEvidence(),
    vendorEvidence: vendorEvidence(),
    supersedes: 'migration-core-v1-provenance.json',
    knownExclusions: [
      'No tag or release is created by this record. It identifies a candidate, and publishing one is a separate decision.',
      'The full-stack CAPACITY-FOUNDING traversal named by KAURO_CUALIFICACION_INTEGRAL_CANONICO_V1 section 83 — upload authorization, object storage read-back, malware preflight, outbox — is not Migration Core’s and is not discharged here. What is discharged is the Migration-Core-shaped subset: a million representative source rows end to end in each mode, inside the founding budgets.',
      'No external signature. A provenance signed with a key the same process generated would attest that the process ran, which nobody doubts. The post-merge receipt is written by CI, which is a different party.',
      'No commit SHA and no git tree hash. Neither can be stated from inside the tree that contains this file; both are the receipt’s, and tools/receipt-verify.mjs is what checks them.',
      'No runtime. This record is compared byte for byte across platforms, so the node version and the operating system it happened to be generated on cannot be in it: they differ between checkouts for reasons that are not the verdict, and a comparison that fails for reasons nobody can act on is a comparison somebody deletes. The platform claim belongs to the CI matrix and is carried by the receipt.',
      'No freeze flag. This record used to carry MIGRATION_CORE_IMPLEMENTATION_FROZEN as a boolean literal, which made the flag a sentence in a file this same tree produces — and the architecture gate read it back as a fact. It is computed instead, outside the tree, by tools/freeze-verdict.mjs, from the merged commit, the external CI receipt, the branch protection actually in force, the tag, and the release assets as downloaded.',
    ],
    freezeDecision: {
      decidedBy: 'tools/freeze-verdict.mjs',
      outsideTree: true,
      note:
        'A flag written here would be this tree describing itself as finished. The verdict is derived from the merged SHA, ' +
        'the external receipt, the ruleset, the tag and the downloaded release assets, and is published as a release asset beside them.',
    },
  };
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

/** What a command line this tool does not understand exits with. EX_USAGE. */
const USAGE_EXIT = 64;

const STAMP_IS_GONE = [
  '',
  '--stamp is gone. It wrote this candidate’s code digest onto measurements taken against other code, so a',
  'measurement became current by running a program — which makes a gate passable by running a tool.',
  'Evidence is bound by its producer at the moment it produced it: qualification/campaign.mjs captures the',
  'execution subject at the start of a run and re-checks it at the end, and the gate compares that capture',
  'against the campaign this candidate was sealed under.',
  '',
].join('\n');

function main(args) {
  const known = new Set(['--check']);
  const unknown = args.filter((arg) => !known.has(arg));
  if (unknown.length > 0) {
    process.stderr.write(
      `unknown option ${unknown.join(', ')}\n` +
        'usage: node tools/candidate-provenance.mjs [--check]\n' +
        (unknown.includes('--stamp') ? STAMP_IS_GONE : ''),
    );
    return USAGE_EXIT;
  }
  const checkOnly = args.includes('--check');

  assertSerialisationGolden();

  const manifest = buildManifest();
  const provenance = buildProvenance(manifest);
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  const provenanceJson = `${JSON.stringify(provenance, null, 2)}\n`;

  if (checkOnly) {
    const sameManifest = existsSync(manifestPath) && readFileSync(manifestPath, 'utf8') === manifestJson;
    const sameProvenance = existsSync(provenancePath) && readFileSync(provenancePath, 'utf8') === provenanceJson;
    if (sameManifest && sameProvenance) {
      process.stdout.write(`candidate provenance is current: ${manifest.manifestDigest}\n`);
      return 0;
    }
    process.stdout.write(
      `candidate provenance is out of date${sameManifest ? '' : ' (manifest)'}${sameProvenance ? '' : ' (provenance)'}; ` +
        'run "node tools/candidate-provenance.mjs"\n',
    );
    return 1;
  }

  mkdirSync(candidateDir, { recursive: true });
  writeFileSync(manifestPath, manifestJson);
  writeFileSync(provenancePath, provenanceJson);
  process.stdout.write(
    `wrote ${relative(repoRoot, manifestPath)} and ${relative(repoRoot, provenancePath)}\n` +
      `candidate ${manifest.manifestDigest}\n` +
      `${String(manifest.fileCount)} files, ${String(manifest.totalBytes)} bytes, ` +
      `exclusion rule ${manifest.exclusionRuleVersion}, digest serialisation ${DIGEST_SERIALISATION_VERSION}\n`,
  );
  return 0;
}

// Only when run, never when imported. The gate and the receipt verifier import
// the serialiser from here, and a module that writes files on import would make
// every verifier a producer.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
