#!/usr/bin/env node
/**
 * The offline release universe — one command, one report.
 *
 * Everything this repository can check about itself without asking a vendor
 * anything, run in one place and recorded in one machine-readable file.
 *
 * It exists because the pieces already existed and nothing ran them together.
 * `npm run gate` omits sabotage, the provenance check, the architecture gate,
 * the dependency audit and the assertion that the committed acceptance packages
 * and generated specification files are byte-identical to what this platform
 * produces. Each of those was a separate CI step or a separate script, and a
 * person asking "did the offline universe pass" had to assemble the answer from
 * five places and hope they had not forgotten one. Forgetting one is exactly how
 * a gate becomes decorative.
 *
 * The "provenance" step runs the before-preflight mode of the provenance check
 * (D76): the preflight is computed from this report, so a step of this report
 * cannot require it. Every other artifact and digest is still checked.
 *
 * The report is the point. RELEASE-CANDIDATE-01 reads it rather than re-running
 * everything, and it reads the steps rather than a verdict: a report that says
 * PASS while carrying a failed step is a report the gate refuses.
 *
 * No step is softened to a warning, and a step that did not run is not a step
 * that passed — `--quick` skips the slow ones and records them as `ok: false`
 * with the reason, so a quick run can never be mistaken for the real one.
 *
 *   node tools/universe.mjs                      everything
 *   node tools/universe.mjs --quick              skip sabotage and the architecture gate
 *   node tools/universe.mjs --report <path>      where to write the report
 *
 * The report says which code it was produced against, measured before the first
 * step runs, and a report may only be written where writing it cannot change
 * that answer. Both are checked below rather than remembered.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
// One implementation of what a candidate is, imported rather than restated.
//
// The digest below has to be the same number `tools/candidate-provenance.mjs`
// computes and the same number RELEASE-CANDIDATE-01 compares it against, byte
// for byte, or the comparison is between two guesses. A second implementation
// of one definition is one implementation and one guess, and the guess is the
// one that reads TRUE on the day the definition changes under it: the exclusion
// rule, the serialisation and the code roots are all versioned data here, and a
// copy of them in this file would keep answering with last month's rule.
import {
  DIGEST_SERIALISATION_VERSION,
  EXCLUDED_DIRECTORIES,
  EXCLUDED_PATHS,
  EXCLUSION_RULE_VERSION,
  measureTree,
} from './candidate-provenance.mjs';
// The normative step list, declared apart from the runner that runs it, so the
// gate can require a report to hold exactly these and this file can assert it
// is about to run exactly these. Two readings of one list; neither is the other's
// copy.
import { UNIVERSE_SCHEMA_VERSION, UNIVERSE_STEP_IDS, universeReportProblems } from './universe-inventory.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const quick = args.includes('--quick');
const reportIndex = args.indexOf('--report');
const reportPath =
  reportIndex === -1 ? join(repoRoot, 'qualification', 'candidate', 'universe.json') : resolve(args[reportIndex + 1]);

// 1.1.0 added `candidate`, and narrowed `scope`: it is derived from what
// actually ran rather than from the flag that asked.
//
// 1.2.0 makes a step say more than whether it was ok. Each one now records the
// exit status the command actually returned, a closed `status` token, the
// SHA-256 of its whole output and the path of the log holding that output —
// because a report that keeps the last six lines of a failure is a report that
// makes the next run necessary rather than the fix, and because a step whose
// output nobody kept cannot be re-read after the fact. The step list itself is
// declared in `tools/universe-inventory.mjs` and asserted here before anything
// runs, so a report missing a step, carrying one twice, or carrying one nobody
// declared is impossible rather than merely refused later.
const SCHEMA_VERSION = UNIVERSE_SCHEMA_VERSION;

/**
 * A report may only be written where writing it cannot move the digests it
 * records. Nothing else about the path is this tool's business.
 *
 * This is the fixed point that has already cost this repository two rounds. The
 * report names the digest of a file set; the report is a file; if it is a member
 * of that set, writing it changes the answer it has just recorded, and there is
 * no order of operations in which both the report and the manifest are right.
 * Exclusion rule 1.2.0 answers it for the one path this tool writes by default —
 * `qualification/candidate/universe.json` is excluded exactly as the preflight
 * is — and `--report` can point anywhere at all, so the rule is applied to the
 * path in hand rather than to the path somebody remembered.
 *
 * The set is taken from the exclusion rule itself, so it cannot fall out of step
 * with it: outside the repository, under an excluded directory, or one of the
 * excluded paths. A report written anywhere else is either a file nobody will
 * commit — in which case it belongs in `tmp/` or the runner's temp directory —
 * or a file somebody will commit, which is the loop again.
 *
 * The code digest is the binding that does not depend on this exclusion being
 * remembered: nothing under `qualification/` is in the code set. That is why a
 * report under `src/` or `tools/` is refused twice over here, and it is the only
 * reason the durable half of the binding survives an edit to the exclusion rule.
 *
 * @param {string} absolutePath the resolved report path
 * @returns {string|null} why the path is refused, or null
 */
function measuredSetProblem(absolutePath) {
  const rel = relative(repoRoot, absolutePath);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null; // outside the measured tree entirely
  const posix = rel.split(sep).join('/');
  if (EXCLUDED_PATHS.includes(posix)) return null;
  if (EXCLUDED_DIRECTORIES.some((dir) => posix === dir || posix.startsWith(`${dir}/`))) return null;
  return (
    `refusing to write the report to ${posix}: exclusion rule ${EXCLUSION_RULE_VERSION} measures that path, so writing the ` +
    `report would change the digests the report states. Write it outside the repository, under one of ` +
    `${EXCLUDED_DIRECTORIES.join(', ')}, or to one of ${EXCLUDED_PATHS.join(', ')}.`
  );
}

const pathProblem = measuredSetProblem(reportPath);
if (pathProblem !== null) {
  process.stderr.write(`${pathProblem}\n`);
  process.exit(1);
}

/**
 * Which code this run is about, measured now — before the build, before the
 * first step, before anything here can have changed a file.
 *
 * Measured at the end it would be a different claim and a weaker one: the steps
 * below rebuild the acceptance packages and regenerate the specification files,
 * and a report that hashed the tree afterwards would name whatever those left
 * behind rather than the engine the suite actually ran against. Taken first, a
 * step that moves a tracked source file cannot be papered over — the report goes
 * on naming the code the run started with, and RELEASE-CANDIDATE-01 re-measures
 * the tree from outside and refuses the report when the two disagree.
 *
 * Refused rather than recorded as null. An unbound report is not evidence about
 * a candidate, and writing one would leave a file the gate has to interpret; the
 * build below is refused on the same grounds.
 */
/**
 * The steps this run is about to take, against the inventory the gate reads.
 *
 * Asserted before anything runs, and in both directions. A step added here and
 * not to `tools/universe-inventory.mjs` would produce a report the gate refuses
 * after an hour of work; a step removed here and left in the inventory would
 * produce a report the gate refuses for the same reason. Neither is a thing to
 * discover at the end.
 */
function assertInventory() {
  const declared = [...UNIVERSE_STEP_IDS];
  const running = STEPS.map((step) => step.id);
  const missing = declared.filter((id) => !running.includes(id));
  const extra = running.filter((id) => !declared.includes(id));
  const duplicated = running.filter((id, index) => running.indexOf(id) !== index);
  const problems = [];
  if (missing.length > 0) problems.push(`the inventory declares ${missing.join(', ')} and this runner does not run them`);
  if (extra.length > 0) problems.push(`this runner runs ${extra.join(', ')} and the inventory does not declare them`);
  if (duplicated.length > 0) problems.push(`this runner runs ${duplicated.join(', ')} more than once`);
  if (running.join('\n') !== declared.join('\n') && problems.length === 0) {
    problems.push(`the runner's order ${running.join(', ')} is not the inventory's ${declared.join(', ')}`);
  }
  if (problems.length > 0) {
    process.stderr.write(
      `the universe and its inventory disagree:\n${problems.map((problem) => `  - ${problem}`).join('\n')}\n` +
        'Add or remove the step in tools/universe-inventory.mjs and here, in the same change.\n',
    );
    process.exit(1);
  }
}

const candidate = measureTree();
if (candidate.records === null) {
  process.stderr.write(
    `the tree could not be measured, so no report could say which code it was produced against:\n${candidate.problems
      .map((problem) => `  - ${problem}`)
      .join('\n')}\n`,
  );
  process.exit(1);
}

/**
 * The universe, in the order the roadmap names it.
 *
 * `slow` marks a step `--quick` may skip. Nothing else may be skipped, and a
 * skipped step is recorded as not having passed.
 */
const STEPS = [
  { id: 'typecheck', label: 'the types are what the code says they are', command: ['npm', ['run', '--silent', 'typecheck']] },
  { id: 'contract-lint', label: 'every reason code is declared and used', command: ['npm', ['run', '--silent', 'lint']] },
  { id: 'spec-drift', label: 'the generated specification files match the code', command: ['npm', ['run', '--silent', 'spec:check']] },
  {
    id: 'evidence-rules',
    label: 'EVIDENCE-RULES-01, every rule a gate reads a record through, proved to fire',
    command: [process.execPath, [join(repoRoot, 'tools', 'evidence-selftest.mjs')]],
  },
  { id: 'constitution', label: 'CORE-CONSTITUTION-01, the support envelope', command: ['npm', ['run', '--silent', 'constitution']] },
  { id: 'target-contract', label: 'TARGET-CONTRACT-01, destination match authority', command: ['npm', ['run', '--silent', 'target-contract']] },
  { id: 'tests', label: 'unit, integration, golden, property, metamorphic and tamper', command: ['npm', ['run', '--silent', 'test']] },
  { id: 'source-backed', label: 'verification against authorities the package cannot reach', command: ['npm', ['run', '--silent', 'strong']] },
  { id: 'adversarial', label: 'FINAL-ADV-01', command: ['npm', ['run', '--silent', 'adversarial']] },
  { id: 'determinism', label: 'the same inputs produce the same bytes', command: ['npm', ['run', '--silent', 'determinism']] },
  { id: 'acceptance', label: 'the acceptance packages rebuild', command: ['npm', ['run', '--silent', 'acceptance']] },
  {
    id: 'artifacts-reproducible',
    label: 'the committed acceptance packages and specs are byte-identical to what this platform produces',
    // Asks whether regenerating CHANGED anything, not whether the tree is clean.
    //
    // The first version was CI's own step, `git diff --exit-code -- acceptance
    // spec`, which is exactly right in CI and wrong everywhere else: on a
    // working tree with deliberate uncommitted edits to `spec/`, it fails every
    // time and reports "not reproducible" for a tree that reproduces perfectly.
    // A check that cannot pass while somebody is working is a check they stop
    // reading.
    //
    // So the comparison is against the state before the regeneration in this
    // run, taken above, rather than against the index. A path that differed
    // beforehand and differs identically afterwards is somebody's work in
    // progress; a path the regeneration moved is the defect this is for.
    inline: () => {
      const before = new Map(pathDigests(['acceptance', 'spec']));
      const rebuild = spawnSync('npm', ['run', '--silent', 'acceptance'], {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        maxBuffer: 256 * 1024 * 1024,
      });
      if (rebuild.status !== 0) {
        return { ok: false, detail: `the acceptance packages could not be rebuilt: ${(rebuild.stderr ?? '').trim().slice(-200)}` };
      }
      const regen = spawnSync('npm', ['run', '--silent', 'spec:gen'], {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        maxBuffer: 64 * 1024 * 1024,
      });
      if (regen.status !== 0) {
        return { ok: false, detail: `the specification files could not be regenerated: ${(regen.stderr ?? '').trim().slice(-200)}` };
      }
      const after = new Map(pathDigests(['acceptance', 'spec']));
      const moved = [];
      for (const [path, digest] of after) {
        if (before.get(path) !== digest) moved.push(path);
      }
      for (const path of before.keys()) {
        if (!after.has(path)) moved.push(`${path} (removed)`);
      }
      return {
        ok: moved.length === 0,
        detail:
          moved.length === 0
            ? `${String(after.size)} committed artifacts regenerate to the same bytes on this platform`
            : `regenerating moved ${moved.slice(0, 8).join(', ')}`,
      };
    },
  },
  // Before-preflight mode: the preflight is computed from this universe, so it
  // cannot be required by a step of it (D76). The final check is plain
  // `provenance:check`, run by the release after the preflight exists.
  { id: 'provenance', label: 'the provenance record still describes this tree (before the preflight)', command: [process.execPath, [join(repoRoot, 'tools', 'provenance.mjs'), '--check', '--before-preflight']] },
  { id: 'drift', label: 'no document contradicts an executable constant', command: [process.execPath, [join(repoRoot, 'tools', 'drift-gate.mjs')]] },
  { id: 'dependency-audit', label: 'no dependency advisory at moderate or above', command: ['npm', ['audit', '--audit-level=moderate']] },
  {
    id: 'dependency-budget',
    label: 'the runtime dependency budget',
    // Checked in this process rather than in a child. The child ran
    // `node -e "... if (n > 4) process.exit(1)"` through a shell, and on Windows
    // the shell read the `>` as a redirect: every run created an empty file
    // called `4)process.exit(1)` in the repository root and the comparison never
    // happened. A check that silently stops being a check while leaving litter
    // behind is worse than no check.
    inline: () => {
      const declared = Object.keys(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).dependencies ?? {});
      return {
        ok: declared.length <= 4,
        detail: `${String(declared.length)} runtime dependencies against a ceiling of 4: ${declared.join(', ')}`,
      };
    },
  },
  { id: 'architecture', label: 'ARCHITECTURE-01', slow: true, command: ['npm', ['run', '--silent', 'architecture']] },
  { id: 'sabotage', label: 'every mutation is killed by the suite', slow: true, command: ['npm', ['run', '--silent', 'sabotage']] },
  {
    id: 'sabotage-left-no-trace',
    label: 'the working tree is unchanged after sabotage, tracked and untracked alike',
    slow: true,
    /**
     * `git diff --exit-code` was what stood here, and it answers a narrower
     * question than the step's name.
     *
     * It compares tracked files against the index and says nothing about a file
     * sabotage created, a file it deleted and staged, or a mode change. The
     * harness copies the tree into `tmp/sabotage-tree` and rewrites source files
     * in place; an interrupted run has twice left something behind, and once it
     * was a mutation that shipped. So the check is over everything git can see —
     * `--porcelain=v2 --untracked-files=all`, which reports untracked files,
     * staged deletions and mode changes that a plain diff does not — plus an
     * explicit inventory of what the harness is allowed to leave in `tmp/`.
     */
    inline: () => {
      const status = spawnSync('git', ['status', '--porcelain=v2', '--untracked-files=all'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      if (status.status !== 0) {
        return { ok: false, detail: `git status could not be read: ${(status.stderr ?? '').trim()}` };
      }
      const entries = (status.stdout ?? '').split('\n').filter((line) => line.trim() !== '');
      // The report and its logs are written by this run, after the step, so a
      // report already in the tree from a previous run is not sabotage's trace.
      const reportRelative = relative(repoRoot, reportPath).split(sep).join('/');
      const dirty = entries.filter((line) => {
        const path = line.startsWith('? ') ? line.slice(2) : line.split(' ').slice(8).join(' ');
        return path !== reportRelative && !path.startsWith('tmp/');
      });
      // What sabotage left under `tmp/`: what is there now, minus what was there
      // before it ran.
      //
      // This was an allowlist — `['sabotage-tree']`, plus anything beginning
      // "test" — and an allowlist answers the wrong question. `tmp/` is
      // git-ignored, so nothing under it appears in the status above, and the
      // steps that run *before* sabotage put their own working directories
      // there: the architecture gate keeps its derivations in
      // `tmp/architecture-gate` for the whole run and does not remove the root.
      // So a clean run reported "tmp/ holds architecture-gate, which the
      // sabotage inventory does not declare" — a step being blamed for a
      // directory another step made, in a check whose entire subject is which
      // step left what.
      //
      // A difference needs no inventory and cannot go stale: whatever appears
      // under `tmp/` between the two readings is sabotage's, and whatever was
      // already there is somebody else's problem and not this one's.
      const strays = temporaryEntries().filter((entry) => !temporaryBeforeSabotage.includes(entry));
      const problems = [];
      if (dirty.length > 0) {
        problems.push(
          `git reports ${String(dirty.length)} paths changed after sabotage: ${dirty.slice(0, 10).join(' | ')}`,
        );
      }
      if (strays.length > 0) {
        problems.push(`tmp/ holds ${strays.join(', ')}, which the sabotage inventory does not declare`);
      }
      return problems.length === 0
        ? { ok: true, detail: 'no tracked change, no untracked file, no mode change, and nothing undeclared under tmp/' }
        : { ok: false, detail: problems.join('; ') };
    },
  },
];

/**
 * What `tmp/` holds right now, by name.
 *
 * Read twice — once before the sabotage step and once after it — so the trace
 * check can subtract. An absent `tmp/` is an empty list rather than an error:
 * on a clean checkout nothing has made one yet.
 */
function temporaryEntries() {
  try {
    return readdirSync(join(repoRoot, 'tmp'), { withFileTypes: true }).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** The reading taken before sabotage runs. Filled in by the runner below. */
let temporaryBeforeSabotage = [];

// The build has to happen first and is not one of the checks: nothing below can
// be believed against a stale dist.
const build = spawnSync('npm', ['run', '--silent', 'build'], {
  cwd: repoRoot,
  encoding: 'utf8',
  shell: process.platform === 'win32',
  maxBuffer: 64 * 1024 * 1024,
});
if (build.status !== 0) {
  process.stderr.write(`the build failed, so nothing below would mean anything:\n${build.stdout ?? ''}${build.stderr ?? ''}\n`);
  process.exit(1);
}

/**
 * Sabotage rewrites source files in place, so it may only run on a quiet tree.
 *
 * Each mutation is applied by editing the real file, rebuilding, running the
 * suite and putting the file back. That is a sound design and it has one
 * consequence nothing else here has: while it runs, the working tree is
 * intermittently wrong. Anything that reads the tree during a sabotage run reads
 * a lie, and anything that stages the tree stages a mutation.
 *
 * This has already happened once and it cost a shipped defect: a commit captured
 * `run-migration.ts` mid-mutation and shipped real row loss — three rows read,
 * two accounted for. The harness had restored the file by the time anyone
 * looked, so the tree seemed fine and only a clean checkout showed it.
 *
 * So the run is refused unless the tree is clean. The refusal is the point: an
 * unexplained modification is either work in flight, which must be committed
 * first, or a mutation left behind by an interrupted run, which must be
 * understood before anything else happens.
 */
/** Every file under these roots, with the digest of its bytes right now. */
function pathDigests(roots) {
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path, name);
      else out.push([name, createHash('sha256').update(readFileSync(path)).digest('hex')]);
    }
  };
  for (const root of roots) walk(join(repoRoot, root), root);
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function treeIsQuiet() {
  const status = spawnSync('git', ['status', '--porcelain', '-uall'], { cwd: repoRoot, encoding: 'utf8' });
  const dirty = (status.stdout ?? '').split('\n').filter((line) => line.trim() !== '');
  return { quiet: dirty.length === 0, dirty };
}

// Asserted here rather than beside its definition, because `STEPS` is declared
// below the measurement and a function cannot read a `const` before it exists.
assertInventory();

/**
 * Where a step's whole output goes.
 *
 * Outside the measured tree, under the report's own directory, so a report and
 * the logs it names travel together and neither changes a digest the report
 * states. The report carries the digest of each log's bytes, so a log edited
 * afterwards stops matching the report that names it.
 *
 * This exists because the report used to keep the last six lines of a failing
 * step, capped at six hundred characters. A failing test suite prints its
 * failures and then a summary; the six lines kept were the summary. An operator
 * reading the report learnt that something failed and had to re-run the step —
 * which for `sabotage` is thirty-five minutes — to find out what.
 */
const logRoot = join(dirname(reportPath), 'universe-logs');
mkdirSync(logRoot, { recursive: true });

function writeStepLog(id, output) {
  const path = join(logRoot, `${id}.log`);
  writeFileSync(path, output);
  return {
    logPath: relative(dirname(reportPath), path).split(sep).join('/'),
    outputSha256: createHash('sha256').update(Buffer.from(output, 'utf8')).digest('hex'),
    outputBytes: Buffer.byteLength(output, 'utf8'),
    outputLines: output.split('\n').length,
  };
}

/** A step nobody ran, recorded as the thing it is rather than as a step that passed. */
function notRun(step, status, detail) {
  return {
    id: step.id,
    label: step.label,
    ok: false,
    status,
    skipped: true,
    exitStatus: null,
    detail,
    durationMs: 0,
    ...writeStepLog(step.id, `${detail}\n`),
  };
}

const results = [];
for (const step of STEPS) {
  if (quick && step.slow === true) {
    results.push(notRun(step, 'skipped', 'not run: --quick'));
    process.stderr.write(`  skipped  ${step.id}\n`);
    continue;
  }
  if (step.id === 'sabotage') {
    // What tmp/ held before sabotage ran, so the trace check can subtract rather
    // than consult a list of names that goes stale the moment a step is added.
    temporaryBeforeSabotage = temporaryEntries();
    const { quiet, dirty } = treeIsQuiet();
    if (!quiet) {
      results.push(
        notRun(
          step,
          'not-run',
          `not run: the working tree is not clean, and sabotage rewrites source files in place. ` +
            `${String(dirty.length)} paths are modified, starting with ${dirty.slice(0, 3).map((line) => line.slice(3)).join(', ')}. ` +
            `Commit or stash them, then run this again.`,
        ),
      );
      process.stderr.write(`  REFUSED  ${step.id}  the tree is not clean\n`);
      continue;
    }
  }
  if (typeof step.inline === 'function') {
    const started = process.hrtime.bigint();
    let outcome;
    try {
      outcome = step.inline();
    } catch (error) {
      outcome = { ok: false, detail: String(error && error.stack ? error.stack : error) };
    }
    const durationMs = Math.round(Number(process.hrtime.bigint() - started) / 1_000_000);
    results.push({
      id: step.id,
      label: step.label,
      ok: outcome.ok,
      status: outcome.ok ? 'ok' : 'failed',
      skipped: false,
      exitStatus: outcome.ok ? 0 : 1,
      detail: outcome.detail,
      durationMs,
      ...writeStepLog(step.id, `${String(outcome.detail)}\n`),
    });
    process.stderr.write(`  ${outcome.ok ? 'pass   ' : 'FAIL   '} ${step.id}  ${String(durationMs)} ms\n`);
    continue;
  }
  const started = process.hrtime.bigint();
  const result = spawnSync(step.command[0], step.command[1], {
    cwd: repoRoot,
    encoding: 'utf8',
    // A shell only where one is needed. `npm` and `git` on Windows resolve
    // through it; `process.execPath` is `C:\Program Files\nodejs\node.exe`, and
    // handing that to a shell splits it at the space. The drift step reported
    // "'C:\Program' is not recognized" and was scored as a failure of the thing
    // it checks rather than as a step that never ran.
    shell: process.platform === 'win32' && step.command[0] !== process.execPath,
    maxBuffer: 256 * 1024 * 1024,
  });
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  // The exit status the command returned, kept apart from the verdict. A step
  // that could not be spawned at all has no status, and that is a different
  // thing from a step that ran and returned non-zero.
  const spawnProblem = result.error === undefined ? null : String(result.error.message);
  const ok = spawnProblem === null && result.status === 0;
  const log = writeStepLog(step.id, spawnProblem === null ? output : `${output}\n${spawnProblem}\n`);
  results.push({
    id: step.id,
    label: step.label,
    ok,
    status: ok ? 'ok' : 'failed',
    skipped: false,
    exitStatus: result.status,
    signal: result.signal ?? null,
    spawnProblem,
    // A pointer, not a transcript: the whole output is in the log this names,
    // and the digest beside it is what makes the log the one this step wrote.
    detail: ok
      ? lastLine(output)
      : `exit ${String(result.status)}${spawnProblem === null ? '' : ` (${spawnProblem})`}, ${String(log.outputLines)} lines in ${log.logPath}: ` +
        output.trim().split('\n').slice(-6).join(' | ').slice(0, 600),
    durationMs: Math.round(durationMs),
    ...log,
  });
  process.stderr.write(`  ${ok ? 'pass   ' : 'FAIL   '} ${step.id}  ${String(Math.round(durationMs))} ms\n`);
}

function lastLine(text) {
  const lines = text.trim().split('\n').filter((line) => line.trim() !== '');
  return (lines.at(-1) ?? '').slice(0, 240);
}

const failed = results.filter((entry) => entry.ok !== true);
/**
 * FULL means every declared step ran. It is read off the results, not off the
 * flag that asked for them.
 *
 * `quick ? 'QUICK' : 'FULL'` was the previous line, and it recorded an
 * intention. Two runs it would have called FULL did not run everything: the one
 * where sabotage was refused because the working tree was not clean, and any
 * future skip that is not `--quick`'s. The gate qualifies a candidate only on a
 * FULL report, so the word has to mean "nothing was skipped" rather than "the
 * skip flag was absent" — otherwise the one way a step can silently not run is
 * the one way it never gets noticed.
 *
 * A skipped step is already recorded as `ok: false` with its reason, so a quick
 * run fails the gate on its steps as well as on its scope. The two are
 * deliberately not one check: the scope says what kind of run this was, and the
 * steps say what happened in it.
 */
const scope = results.some((entry) => entry.skipped === true) ? 'QUICK' : 'FULL';
const report = {
  schemaVersion: SCHEMA_VERSION,
  gate: 'OFFLINE-UNIVERSE',
  scope,
  platform: `${process.platform} ${process.arch}`,
  node: process.version,
  // Which code produced this report, measured before the first step ran.
  //
  // Both digests, because they answer different questions and the gate asks
  // both. The manifest digest says which candidate this tree is; the code digest
  // says which engine the steps ran against, and it is the one that cannot chase
  // its own tail — no report written under `qualification/` is in the code set,
  // so recording it cannot change it. The serialisation and exclusion versions
  // travel with them because a digest without the rule that produced it is a
  // number nobody can recompute.
  candidate: {
    manifestDigest: candidate.manifestDigest,
    codeDigest: candidate.codeDigest,
    codeFileCount: candidate.codeRecords.length,
    fileCount: candidate.records.length,
    digestSerialisationVersion: DIGEST_SERIALISATION_VERSION,
    exclusionRuleVersion: EXCLUSION_RULE_VERSION,
  },
  steps: results,
  // Derived from the candidate, never fixed by a document. The roadmap is
  // explicit that counts are read off the run.
  passed: failed.length === 0,
};

// The report is validated by the same reader the gate uses, before it is
// written. A report this tool produces that the gate would refuse for a
// structural reason is a bug here, and finding it at the gate — after the
// universe has spent an hour — is finding it in the wrong place.
const structural = universeReportProblems(report).filter(
  // A failing step is a true finding rather than a structural one: the report
  // is allowed to record a failure, and the gate is what refuses it.
  (problem) => !/^step "[^"]+" is not ok/u.test(problem) && !/^step "[^"]+" records exit status/u.test(problem) && !/^step "[^"]+" was skipped/u.test(problem) && !/^the report is scope/u.test(problem),
);
if (structural.length > 0) {
  process.stderr.write(
    `the report this run produced is not the shape the gate reads:\n${structural.map((problem) => `  - ${problem}`).join('\n')}\n`,
  );
  process.exit(1);
}

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

process.stderr.write(
  `\nOFFLINE-UNIVERSE = ${failed.length === 0 ? 'PASS' : 'FAIL'} (${String(results.length - failed.length)}/${String(results.length)})\n` +
    // The binding on stderr as well as in the file, because the person deciding
    // whether to commit a report is the person who has to know which tree it
    // describes, and reading it back out of the JSON is a step they will skip.
    `scope ${scope}, code ${candidate.codeDigest.slice(0, 16)}, candidate ${candidate.manifestDigest.slice(0, 16)}\n` +
    `report: ${reportPath}\n`,
);
if (failed.length > 0) {
  for (const entry of failed) process.stderr.write(`  ${entry.id}: ${entry.detail}\n`);
}
process.exit(failed.length === 0 ? 0 : 1);
