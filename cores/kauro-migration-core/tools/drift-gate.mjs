#!/usr/bin/env node
/**
 * DRIFT-01 — no document contradicts an executable constant.
 *
 * MC-1 changed the package layout, the resource contract and the shape of the
 * import files, and eighteen separate claims across the README, the contract,
 * the decisions log, the gate notes and the release provenance went on
 * describing the engine that existed before it. Every one of them was true when
 * it was written. That is the whole problem: nothing was lying, and the
 * repository still said things about itself that were not so.
 *
 * A person cannot be the check. This is the check.
 *
 * Each rule below takes a constant the code actually uses and looks for a
 * document that disagrees with it. The constants are imported, never copied —
 * a rule that hard-coded `2.0.0` would pass on the day the format became 3.0.0,
 * which is precisely the day it needs to fail.
 *
 *   node tools/drift-gate.mjs
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The one place repository paths are turned into real paths, shared with the
// producer and the gate. See the note on `repoPath` for why this file used to
// get it wrong and what that cost.
import { repoPath, repoRelativePosix, serialisationGoldenProblems } from './candidate-provenance.mjs';
import { unitFieldProblems } from './evidence-schema.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

const version = await import(new URL('../dist/src/version.js', import.meta.url).href);
const layout = await import(new URL('../dist/src/artifacts/layout.js', import.meta.url).href);
const resource = await import(new URL('../dist/src/domain/resource-profile.js', import.meta.url).href);

const problems = [];
const checks = [];

function check(id, ok, detail) {
  checks.push({ id, ok, detail });
  if (!ok) problems.push(`${id}: ${detail}`);
  return ok;
}

function read(posixPath) {
  const path = repoPath(posixPath);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/**
 * Every tracked Markdown file, which is where a claim about the engine lives.
 *
 * From `git ls-files`, so the set is what the repository actually carries
 * rather than what a directory walk happened to reach. The walk that stood here
 * skipped `acceptance/` outright — and `acceptance/README.md` states row
 * counts, relationship counts and check counts about the committed packages,
 * every one of which can go stale, while the generated `audit.md` in each
 * package is the document an operator reads. A gate that exempts the generated
 * documents from the drift rules is a gate that does not check the documents
 * most likely to drift.
 */
function documents() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((path) => path !== '' && path.endsWith('.md'))
    .map((path) => repoPath(path));
}

const docs = documents().map((path) => ({ path, relative: repoRelativePosix(path), text: readFileSync(path, 'utf8') }));

/**
 * Which documents make current claims, decided rather than detected.
 *
 * The exemption used to be a regular expression: a document containing
 * "historical" or "superseded" anywhere in its first forty lines was exempt
 * from every rule about current claims. That is neither necessary nor
 * sufficient in either direction. `docs/work/MC1_EXECUTION_STATE.md` is the
 * record of a finished front and was checked as current because it happens to
 * use neither word; and any current document that quotes a superseded figure in
 * order to correct it — which is the form this repository requires of a
 * correction — exempted itself from every rule by doing so.
 *
 * A status is a decision about a document, so `docs/work/DOCUMENT_LIFECYCLE.json`
 * records it as one, with who decided, when, and what supersedes it. A tracked
 * document the record does not list is CURRENT: the default is to be checked,
 * and adding a document cannot quietly exempt it.
 */
const LIFECYCLE_PATH = 'docs/work/DOCUMENT_LIFECYCLE.json';
const lifecycle = existsSync(repoPath(LIFECYCLE_PATH)) ? JSON.parse(readFileSync(repoPath(LIFECYCLE_PATH), 'utf8')) : null;
const lifecycleByPath = new Map((lifecycle?.documents ?? []).map((entry) => [entry.path, entry]));

check(
  'the-document-lifecycle-is-declared',
  lifecycle !== null && Array.isArray(lifecycle.documents),
  `${LIFECYCLE_PATH} is missing or carries no documents, so no document's status is recorded`,
);

// Every rule the record itself has to satisfy, so a status cannot be a word
// somebody typed: the path must be a tracked document, the status must be one
// the record declares, a superseded document must name what superseded it, and
// the decision must carry a date and an authority.
{
  const problems = [];
  const tracked = new Set(docs.map((doc) => doc.relative));
  for (const entry of lifecycle?.documents ?? []) {
    if (!tracked.has(entry.path)) problems.push(`${String(entry.path)} is listed and is not a tracked document`);
    if (!(lifecycle.statuses ?? []).includes(entry.status)) problems.push(`${String(entry.path)} has status ${String(entry.status)}`);
    if (entry.status === 'SUPERSEDED' && (typeof entry.supersededBy !== 'string' || entry.supersededBy === '')) {
      problems.push(`${String(entry.path)} is superseded and names nothing that superseded it`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(entry.decidedOn))) problems.push(`${String(entry.path)} records no decision date`);
    if (typeof entry.authority !== 'string' || entry.authority === '') problems.push(`${String(entry.path)} names no authority for its status`);
    if (typeof entry.reason !== 'string' || entry.reason.length < 20) problems.push(`${String(entry.path)} gives no reason for its status`);
  }
  check('every-declared-lifecycle-entry-is-well-formed', problems.length === 0, problems.join('; '));
}

const current = docs.filter((doc) => {
  const entry = lifecycleByPath.get(doc.relative);
  return entry === undefined || entry.status === 'CURRENT' || entry.status === 'GENERATED';
});

// --------------------------------------------------------------- the versions

const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
check(
  'core-version-agrees',
  packageJson.version === version.CORE_VERSION,
  `package.json is ${String(packageJson.version)} and src/version.ts is ${String(version.CORE_VERSION)}`,
);

const registryDoc = read('docs/SOURCE_REGISTRY.md') ?? '';
const documentedRegistry = (registryDoc.match(/Registry version:\s*\*\*([0-9]{4}-[0-9]{2}-[0-9]{2})\*\*/u) ?? [])[1] ?? null;
check(
  'source-registry-version-agrees',
  documentedRegistry === version.SOURCE_REGISTRY_VERSION,
  `docs/SOURCE_REGISTRY.md says ${String(documentedRegistry)} and src/version.ts says ${String(version.SOURCE_REGISTRY_VERSION)}; ` +
    'the review policy in that document requires the two to move in the same commit',
);

// ----------------------------------------------------------------- the layout
//
// The four areas are the safeguard: everything under 01_IMPORT is meant to be
// imported and nothing outside it is. A document still describing the flat
// 1.1.0 tree tells an operator to import a file that would put Kauro's
// bookkeeping into their CRM.

const AREAS = [layout.IMPORT_AREA, layout.EXCEPTIONS_AREA, layout.TRACEABILITY_AREA, layout.DOCUMENTATION_AREA];
const readme = read('README.md') ?? '';
check(
  'readme-describes-the-current-layout',
  AREAS.every((area) => readme.includes(area)),
  `README.md does not name ${AREAS.filter((area) => !readme.includes(area)).join(', ')}`,
);

const flatLayout = current.filter((doc) => /(^|[^0-9_])import\/(hubspot|salesforce|clean-only)\//u.test(doc.text));
check(
  'no-current-document-describes-the-flat-layout',
  flatLayout.length === 0,
  `${flatLayout.map((doc) => doc.relative).join(', ')} still describe import/<target>/ rather than ${layout.IMPORT_AREA}/<target>/`,
);

/**
 * A trace key inside the import area is the specific mistake package format
 * 2.0.0 exists to prevent, so no current document may describe one.
 *
 * The first version of this rule fired on every sentence that mentioned both,
 * which meant it fired hardest on the two documents that say the trace key is
 * *gone* from the import area — the sentences most worth keeping. A rule that
 * flags the correction along with the error is a rule somebody turns off, and a
 * gate that is off is worse than one that was never written.
 *
 * So the window is read for what it asserts. A mention accompanied by a denial
 * is a document saying the right thing, and only a mention that stands as a
 * plain claim of presence is drift.
 */
const DENIAL = /\b(gone|not|never|no|none|without|removed|instead|rather than|cannot|beyond|outside|refus\w*)\b/iu;
// The window crosses line breaks on purpose. Prose wraps, and the first version
// of this stopped at the newline — so "the Kauro trace key is" ended one line and
// "not among them" began the next, and the rule read the claim without its verb.
const traceKeyInImport = current.filter((doc) => {
  const windows = [...doc.text.matchAll(new RegExp(`${layout.IMPORT_AREA}([\\s\\S]{0,240})`, 'giu'))];
  return windows.some((match) => {
    const window = match[1];
    if (!/\b(kauro[ _]?trace[ _]?key|trace[ _]?key)\b/iu.test(window)) return false;
    return !DENIAL.test(window);
  });
});
check(
  'no-current-document-puts-a-trace-key-in-the-import-area',
  traceKeyInImport.length === 0,
  `${traceKeyInImport.map((doc) => doc.relative).join(', ')} describe a trace key inside ${layout.IMPORT_AREA} without denying it is there`,
);

// ---------------------------------------------------------------- the budgets

const profilesPath = join(repoRoot, 'qualification', 'capacity', 'profiles.json');
if (existsSync(profilesPath)) {
  const manifest = JSON.parse(readFileSync(profilesPath, 'utf8'));
  const declared = manifest.limits ?? {};
  const expected = {
    hardMemoryBytes: resource.HARD_MEMORY_LIMIT_BYTES,
    memoryBudgetBytes: resource.MEMORY_BUDGET_BYTES,
    hardScratchBytes: resource.HARD_SCRATCH_LIMIT_BYTES,
    scratchBudgetBytes: resource.SCRATCH_BUDGET_BYTES,
    wallClockMs: resource.WALL_CLOCK_LIMIT_MS,
  };
  const wrong = Object.entries(expected).filter(([key, value]) => Number(declared[key]) !== value);
  check(
    'capacity-profiles-declare-the-real-limits',
    wrong.length === 0,
    wrong.map(([key, value]) => `${key} declared ${String(declared[key])}, code says ${String(value)}`).join('; '),
  );
} else {
  check('capacity-profiles-declare-the-real-limits', false, 'qualification/capacity/profiles.json is missing');
}

/**
 * Machine fields are bytes, and a name is how a reader knows which.
 *
 * `peakMb` computed as `bytes / 1024 / 1024` is mebibytes wearing the name of
 * megabytes. The evidence that shipped with V1 did exactly that and was then
 * compared against a budget written the other way. Any machine-readable
 * evidence this repository generates now must name its units honestly, and a
 * field whose name ends in a display unit is refused.
 */
// Every spelling of every unit, at every depth, in every generated record.
//
// The rule was `/"[A-Za-z_][A-Za-z0-9_]*(Mb|Kb|Gb)"\s*:/` over two directories.
// It knew three suffixes in one casing — so `peakMB`, `peakMiB`, `peak_mib`,
// `sizeGiB` and `bytesKB` all passed — and it never looked at the vendor
// evidence or at the acceptance index, which are generated records too. The
// shared reader in `tools/evidence-schema.mjs` walks a parsed record and reports
// every key at every depth whose name ends in a display unit, and it is the same
// function RELEASE-CANDIDATE-01 applies to a capacity record, so the two cannot
// disagree about what a unit-named field is.
const generatedEvidence = [];
for (const dir of ['qualification/capacity', 'qualification/candidate', 'qualification/evidence', 'acceptance']) {
  const root = repoPath(dir);
  if (!existsSync(root)) continue;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.json')) generatedEvidence.push(path);
    }
  };
  walk(root);
}
const ambiguous = [];
for (const path of generatedEvidence) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    ambiguous.push(`${repoRelativePosix(path)} is not readable JSON, so nothing can say how its numbers are denominated`);
    continue;
  }
  for (const problem of unitFieldProblems(parsed)) ambiguous.push(`${repoRelativePosix(path)} ${problem}`);
}
check(
  'generated-records-are-denominated-in-bytes',
  ambiguous.length === 0,
  `${String(ambiguous.length)} fields named for a display unit: ${ambiguous.join('; ')}`,
);

// ------------------------------------------------------------- counted claims
//
// A number a document states about the repository has to be a number the
// repository can produce. These are the ones that went stale under MC-1.

const sabotageSource = read('tools/sabotage.mjs') ?? '';
const mutationCount = new Set([...sabotageSource.matchAll(/id:\s*'(M\d+)'/gu)].map((match) => match[1])).size;
// A superseded figure standing beside its replacement is a correction, which is
// the form this repository requires of a historical number — so a line carrying
// both the stale count and the real one is not drift, it is the record of the
// drift having been fixed. Only a stale count standing alone is a claim.
/** Words that mark a sentence as describing a state the tree has left behind. */
const HISTORICAL_MARKER =
  /\b(was|were|used to|then|previously|earlier|older|historical|history|before|no longer|had been|at the time|MC-1|MC-2|superseded|stale)\b/iu;

const claimedMutations = current
  .flatMap((doc) =>
    doc.text.split('\n').flatMap((line, index) =>
      [...line.matchAll(/(\d+)\s+(?:of\s+\d+\s+)?(?:sabotage\s+)?mutations\b/giu)]
        .map((match) => ({
          doc: doc.relative,
          line: index + 1,
          claimed: Number(match[1]),
          corrected: line.includes(String(mutationCount)),
          historical: HISTORICAL_MARKER.test(line),
        })),
    ),
  )
  .filter((entry) => entry.claimed !== mutationCount && entry.claimed > 20 && !entry.corrected && !entry.historical);

/**
 * A sentence about the past is not a current claim.
 *
 * This rule is named for current documents, and it read every line of them.
 * So the paragraph explaining that an older run covered 83 of the 83 mutations
 * that existed then was reported as a document miscounting the corpus, and the
 * only ways to satisfy it were to delete the history or to write a number that
 * was never true. Both are worse than the defect it exists to catch.
 *
 * The exemption is narrow: the marker has to be on the same line as the count,
 * so a present-tense claim two paragraphs below a historical note is still
 * caught, and a line that quotes the current count is already exempt.
 */
check(
  'no-current-document-miscounts-the-mutations',
  claimedMutations.length === 0,
  `${claimedMutations.map((entry) => `${entry.doc} says ${String(entry.claimed)}`).join(', ')}; tools/sabotage.mjs declares ${String(mutationCount)}`,
);

// ------------------------------------------------------------------ provenance

// The current record, not the V1 one. `migration-core-v1-provenance.json` was
// generated by a generator that no longer exists, and it carried the claims
// MC-3 repaired: three gate states written as literals, an evidence list that
// silently dropped what it could not find, and a "does not claim" section that
// had stopped being true. It is deleted rather than kept, because a generated
// record whose generator changed is not evidence of anything except the old
// generator; the release it described is recorded in
// docs/release/CLOSING_REPORT_MIGRATION_CORE_V1.md and in the v1.0.x tags.
const provenance = existsSync(join(repoRoot, 'migration-core-provenance.json'))
  ? JSON.parse(readFileSync(join(repoRoot, 'migration-core-provenance.json'), 'utf8'))
  : null;
/**
 * A path in a record is a POSIX path, and only the platform knows what that is
 * here.
 *
 * This loop used to build the real path with `path.split('/').join('\\')`. On
 * Windows it worked and nobody looked further. On Linux — which is where three
 * of the four CI legs run — it produced a single filename containing literal
 * backslashes, `existsSync` said no, and the rule reported every file the
 * provenance vouches for as absent. A rule that fails that way on the platform
 * it mostly runs on is a rule whose failures get explained away.
 *
 * Worse, it never asked where the result landed. A record naming
 * `../../../etc/hosts` would have been resolved, read and hashed. `repoPath`
 * joins with the platform's separator and refuses anything that leaves the
 * repository, so both halves are fixed in the one place that has to be right.
 */
if (provenance === null) {
  // A rule that disappears is a rule that passed.
  //
  // This was `if (provenance !== null)` with no else, so deleting the release
  // provenance record removed the only rule that hashes the artifacts the
  // release vouches for, and DRIFT-01 reported PASS over a shorter list that
  // nobody counts.
  check(
    'provenance-vouches-for-the-bytes-that-are-here',
    false,
    'migration-core-provenance.json is absent, so nothing vouches for the bytes this release names',
  );
} else {
  const evidencePaths = provenance.evidence ?? [];
  const stale = [];
  for (const entry of evidencePaths) {
    const path = typeof entry === 'string' ? entry : entry.path;
    const recorded = typeof entry === 'string' ? null : entry.sha256;
    // An entry the record marks absent is one it already reports as absent;
    // re-reporting it here would say the same thing twice and hide the entries
    // that are present and no longer hash as recorded.
    if (recorded === null || (typeof entry === 'object' && entry.present === false)) continue;
    let full;
    try {
      full = repoPath(path);
    } catch (error) {
      stale.push(`${String(path)} is not a path inside the repository: ${String(error && error.message ? error.message : error)}`);
      continue;
    }
    if (!existsSync(full)) {
      stale.push(`${path} is named by the provenance and absent`);
      continue;
    }
    const actual = createHash('sha256').update(readFileSync(full)).digest('hex');
    if (actual !== recorded) stale.push(`${path} hashes ${actual.slice(0, 12)}, provenance says ${String(recorded).slice(0, 12)}`);
  }
  check('provenance-vouches-for-the-bytes-that-are-here', stale.length === 0, stale.join('; '));
}

/**
 * The digest serialisation still means what it was pinned to mean.
 *
 * DRIFT-01's subject is a document contradicting an executable constant, and the
 * canonical serialisation is the most load-bearing constant in the repository:
 * every candidate digest, every evidence binding and the receipt all rest on it.
 * A change to it that nobody noticed would silently redefine what a candidate
 * is, which is precisely the class of drift this gate exists for.
 */
const goldenProblems = serialisationGoldenProblems();
check(
  'the-candidate-digest-serialisation-matches-its-golden',
  goldenProblems.length === 0,
  goldenProblems.join('; '),
);

// --------------------------------------------------------------------------

const width = Math.max(...checks.map((entry) => entry.id.length));
process.stderr.write('\nDRIFT-01\n\n');
for (const entry of checks) {
  process.stderr.write(`  ${entry.id.padEnd(width)}  ${entry.ok ? 'pass' : 'FAIL'}${entry.ok ? '' : `  ${entry.detail}`}\n`);
}
process.stderr.write(`\nDRIFT-01 = ${problems.length === 0 ? 'PASS' : 'FAIL'} over ${String(checks.length)} rules, ${String(docs.length)} documents\n\n`);
process.stdout.write(`${JSON.stringify({ gate: 'DRIFT-01', checks, documents: docs.length, passed: problems.length === 0 }, null, 2)}\n`);
process.exit(problems.length === 0 ? 0 : 1);
