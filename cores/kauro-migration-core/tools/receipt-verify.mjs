#!/usr/bin/env node
/**
 * RECEIPT-01 — the layer that can name the commit, because it is not in it.
 *
 * A `ci-receipt.json` committed into the tree cannot truthfully name the SHA of
 * the commit containing it. Writing the SHA changes the file, which changes the
 * tree, which changes the commit, which changes the SHA. The repository shipped
 * exactly that file and the gate read it, so the gate's cross-platform fact was
 * settled by a value nobody could have computed honestly. There is no way to fix
 * a receipt in the tree; there is only moving it out.
 *
 * ## The refutation this file was rewritten under, stated before the design
 *
 * Moving the receipt out of the tree was not enough, and the way it was not
 * enough was demonstrated by execution rather than argued. An adversary wrote a
 * receipt offline, in about thirty lines, with no network and no GitHub: `sha`
 * and `gitTree` from `git rev-parse`, `repository` from the origin remote, the
 * digests from `measureTree()`, the versions from `src/version.ts`, the required
 * job list from this file's own workflow reader, and a single invented check run
 * named "anything at all". `receiptProblems()` returned zero problems and
 * `cross_platform_reproducibility_passed` was TRUE.
 *
 * Every field of that receipt was computable from the tree, because every field
 * was *compared against the tree*. A file this repository can write is not
 * evidence about this repository. That is the whole finding, and the fix is not
 * a stricter comparison against the tree — a stricter comparison would still be
 * a comparison against something the forger already holds.
 *
 * ## What the receipt is now
 *
 * The receipt is a **cache**. The authority is GitHub, read live, by run id:
 *
 *   - `GET /repos/{repo}/actions/runs/{runId}` — the run's own record of which
 *     commit it ran on, which workflow file it ran, and which attempt this was;
 *   - `GET /repos/{repo}/actions/runs/{runId}/jobs` — every job of that run, its
 *     conclusion, its head SHA and the runner labels GitHub dispatched it to;
 *   - `GET /repos/{repo}/commits/{sha}` — the tree hash of that commit as GitHub
 *     records it, compared against the tree hash this checkout computes;
 *   - `GET /repos/{repo}/commits/{sha}/check-runs` — every check run on the
 *     commit, so a job that ran and failed cannot be hidden by not being named.
 *
 * Nothing is believed because the file says it. The file must AGREE with what
 * GitHub reports, field for field, and where it disagrees the receipt is about a
 * different candidate. A forger would need to make api.github.com say that the
 * run exists, ran on this commit, and concluded green — which is the thing the
 * fact is about.
 *
 * Where the API cannot be reached — no token, a network failure, a 404 — the
 * fact is FALSE and says which call failed. It does not fall back to the file.
 * Falling back to the file is the forgery, restored.
 *
 * ## What "required" means, and why it is not a list here
 *
 * A hand-maintained list of job names drifts from the workflow the moment
 * somebody adds a job, and drifts silently — the receipt goes on passing while
 * proving less. So the required set is derived from `.github/workflows/ci.yml`.
 *
 * Deriving it was also the second refutation. The old reader was a line reader
 * whose own comment claimed it "fails closed on anything it does not recognise
 * rather than guessing", and it did not: `  alpha:  # runs first` was silently
 * dropped because the regex required the line to end at the colon, a quoted key
 * `  "beta":` was silently dropped, and a column-0 line inside a block scalar
 * ended the whole jobs block. Each of those narrowed the required set — one of
 * them to nothing — and reported no problem while doing it. A reader that can
 * quietly require less is a reader that decides the verdict.
 *
 * So the reader now refuses every line under `jobs:` it cannot classify, tracks
 * block scalars rather than being confused by them, and is cross-checked against
 * a second, independent reading of the same file: the receipt job's `needs:`
 * list. The set of jobs the reader found and the set the receipt job waits for
 * must be equal. A job hidden from the reader is still named in `needs`, and the
 * disagreement is the failure. Hiding it from both means editing what CI
 * actually waits for, which is a real weakening, visible in the diff of the
 * workflow, which is where it belongs.
 *
 * ## What the fact's name asserts
 *
 * `cross_platform_reproducibility_passed`. The previous revision required only
 * that each job *id* declared in the workflow had `result: success` somewhere in
 * the receipt — and `core-gate` is one id whether its matrix has four legs, one
 * leg, or one leg on ubuntu only. Deleting `windows-latest` from the matrix left
 * the required set unchanged and the fact still TRUE. A fact named for two
 * platforms that no longer mentions a platform is not a strengthened check; it
 * is a deleted one.
 *
 * The matrix is now expanded: every declared leg of every job, by the name the
 * workflow itself builds out of `${{ matrix.* }}`, must appear among the jobs
 * GitHub reports for the run, must be `success`, must carry the commit's SHA,
 * and must carry the runner label the workflow asked for. On top of that, a
 * floor the matrix cannot shrink below: the legs that passed must span at least
 * two operating-system families. That floor is not a measurement and not a
 * constant the repository could compute — it is what the word "cross" in the
 * fact's name means, and it is stated here so that shrinking the matrix fails
 * the fact instead of quietly redefining it.
 *
 *   node tools/receipt-verify.mjs --emit --out <path outside the repo> \
 *        --check-runs <json from the GitHub API>
 *   node tools/receipt-verify.mjs --receipt <path>
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DIGEST_SERIALISATION_VERSION,
  EXCLUSION_RULE_VERSION,
  measureTree,
  repoPath,
  repoRoot,
  versions,
} from './candidate-provenance.mjs';

export const RECEIPT_SCHEMA_VERSION = '1.1.0';
export const RECEIPT_ARTIFACT_KIND = 'MIGRATION_CORE_CI_RECEIPT';

/** The path a receipt must never be written to, stated once so both halves agree. */
export const IN_TREE_RECEIPT_PATH = 'qualification/candidate/ci-receipt.json';

export const WORKFLOW_PATH = '.github/workflows/ci.yml';

/**
 * The floor under the fact's own name.
 *
 * Not a measurement, not a limit, and deliberately not derived from the
 * workflow: a matrix reduced to one operating system would derive a requirement
 * of one operating system and go on calling itself cross-platform. Two families
 * is what "cross" asserts. Widening the matrix raises what must be green;
 * narrowing it below this fails the fact rather than redefining it.
 */
export const MINIMUM_OS_FAMILIES = 2;

/** The API is read with a deadline, because a hung request is not a passing check. */
const API_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// The workflow, read for what it requires
// ---------------------------------------------------------------------------

/**
 * A job key under `jobs:`. Quoted and unquoted, with an optional trailing
 * comment — all three are valid YAML and the previous reader dropped two of them
 * without saying so.
 */
const JOB_KEY = /^ {2}(?:"([A-Za-z0-9_][A-Za-z0-9_.-]*)"|'([A-Za-z0-9_][A-Za-z0-9_.-]*)'|([A-Za-z0-9_][A-Za-z0-9_.-]*)):\s*(?:#.*)?$/u;

/**
 * A key introducing a block scalar (`run: |`, `description: >-`). Everything
 * more indented than such a key is content, not structure — including a `#`,
 * including a line that looks like a job key, and including a shell heredoc.
 */
const BLOCK_SCALAR = /:\s*[|>][-+]?[0-9]*\s*(?:#.*)?$/u;

function unquote(text) {
  return String(text).trim().replace(/^(['"])(.*)\1$/u, '$2');
}

/**
 * Split a YAML flow sequence `[a, b, 'c']` into its items. Only the flat form
 * this workflow uses; anything else is refused by the caller rather than guessed.
 */
function flowSequence(text) {
  return text
    .split(',')
    .map((item) => unquote(item))
    .filter((item) => item !== '');
}

/**
 * The jobs the workflow declares, with everything the receipt needs to know
 * about each: its name template, its `runs-on`, its `needs`, and its matrix.
 *
 * This is a line reader rather than a YAML parser, because adding a dependency
 * to satisfy a gate is how a two-dependency budget becomes a five-dependency
 * budget. What was wrong with the previous one was not that it was a line reader
 * — it was that it treated "I do not recognise this line" as "this line does not
 * matter". Every unclassified line under `jobs:` is now a problem, and a problem
 * is a refusal.
 *
 * @returns {{jobs: object[], jobIds: string[], receiptJobId: string|null, receiptJobName: string|null, problems: string[]}}
 */
export function readWorkflowJobs(text) {
  const problems = [];
  const lines = text.split('\n').map((line) => line.replace(/\r$/u, ''));
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/u.test(line));
  if (jobsIndex === -1) {
    problems.push(`${WORKFLOW_PATH} has no top-level "jobs:" block`);
    return { jobs: [], jobIds: [], receiptJobId: null, receiptJobName: null, problems };
  }

  const jobs = [];
  let current = null;
  let scalarIndent = null;
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const where = `${WORKFLOW_PATH}:${String(index + 1)}`;
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;

    // Block scalars first: their content is data. A heredoc body under `run: |`
    // may legally contain anything at all, and the previous reader let one line
    // of it end the jobs block and take the rest of the required jobs with it.
    if (scalarIndent !== null) {
      if (indent > scalarIndent) continue;
      scalarIndent = null;
    }
    if (/^\s*#/u.test(line)) continue;
    if (line.slice(0, indent).includes('\t')) {
      problems.push(`${where} indents with a tab, which YAML forbids; this reader will not guess what it means`);
      break;
    }
    if (indent === 0) {
      if (/^[A-Za-z_][A-Za-z0-9_.-]*:/u.test(line)) break; // a new top-level key ends the jobs block
      problems.push(
        `${where} is at column 0 inside the "jobs:" block and is not a top-level key: ${JSON.stringify(line.slice(0, 80))}. ` +
          'A line this reader cannot classify may be hiding a job, and a hidden job is a job the receipt stops requiring.',
      );
      break;
    }
    if (indent === 2) {
      const match = JOB_KEY.exec(line);
      if (match === null) {
        problems.push(
          `${where} is at job-key depth and this reader cannot classify it: ${JSON.stringify(line.slice(0, 80))}. ` +
            'Refusing rather than skipping: a skipped job key is a required job silently removed.',
        );
        current = null;
      } else {
        current = { id: match[1] ?? match[2] ?? match[3], name: null, runsOn: null, needs: null, matrix: null, lines: [] };
        jobs.push(current);
      }
    } else if (indent >= 4) {
      if (current === null) {
        problems.push(`${where} is indented under "jobs:" but no job key has been read, so nothing owns it`);
      } else {
        current.lines.push({ text: line, indent, number: index + 1 });
      }
    } else {
      problems.push(`${where} is indented ${String(indent)} under "jobs:", which is neither a job key nor a job's body`);
      current = null;
    }
    if (BLOCK_SCALAR.test(line)) scalarIndent = indent;
  }

  for (const job of jobs) parseJobBody(job, problems);
  if (jobs.length === 0) problems.push(`${WORKFLOW_PATH} declares no jobs this reader can see`);

  const jobIds = jobs.map((job) => job.id);
  const duplicate = jobIds.find((id, position) => jobIds.indexOf(id) !== position);
  if (duplicate !== undefined) problems.push(`${WORKFLOW_PATH} declares the job "${duplicate}" more than once`);

  const receiptJobId = jobIds.includes('receipt') ? 'receipt' : null;
  if (receiptJobId === null) {
    problems.push(`${WORKFLOW_PATH} declares no "receipt" job. A final gate absent from the workflow that claims to prove it is not a gate.`);
  }
  const receiptJob = jobs.find((job) => job.id === receiptJobId) ?? null;

  // The second, independent reading of the same file. `needs` is what the
  // workflow engine actually waits for, and it is not the list this reader
  // built; if the two disagree, one of them is wrong and neither may be used.
  if (receiptJob !== null) {
    if (receiptJob.needs === null) {
      problems.push(`${WORKFLOW_PATH} job "receipt" declares no "needs", so it does not wait for anything and proves nothing`);
    } else {
      const required = jobIds.filter((id) => id !== receiptJobId);
      for (const id of required) {
        if (!receiptJob.needs.includes(id)) {
          problems.push(
            `${WORKFLOW_PATH} declares job "${id}" and the receipt job does not wait for it. ` +
              'The receipt would be written while that job was still running, or after it had failed.',
          );
        }
      }
      for (const id of receiptJob.needs) {
        if (!required.includes(id)) {
          problems.push(
            `${WORKFLOW_PATH} job "receipt" waits for "${id}", which this reader did not find among the declared jobs. ` +
              'Two readings of the same file disagree, so neither may decide what the receipt must prove.',
          );
        }
      }
    }
  }

  return { jobs, jobIds, receiptJobId, receiptJobName: receiptJob === null ? null : (receiptJob.name ?? receiptJob.id), problems };
}

/**
 * The parts of a job's body the receipt depends on. Anything not recognised here
 * is a step, an `env`, a `permissions` — body this reader has no question about
 * — so unlike the structural pass above it does not refuse what it skips. What
 * it does refuse is a shape it half-understands: a name interpolating a matrix
 * key the matrix does not declare, or a matrix using `include`/`exclude`, which
 * this reader does not model and must not pretend to.
 */
function parseJobBody(job, problems) {
  const lines = job.lines;
  for (let index = 0; index < lines.length; index += 1) {
    const { text, indent } = lines[index];
    if (indent !== 4) continue;
    const key = /^ {4}([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/u.exec(text);
    if (key === null) continue;
    const [, field, value] = key;
    if (field === 'name' && job.name === null) job.name = unquote(value);
    else if (field === 'runs-on' && job.runsOn === null) job.runsOn = unquote(value);
    else if (field === 'needs') {
      const inline = /^\[(.*)\]$/u.exec(value);
      if (inline !== null) job.needs = flowSequence(inline[1]);
      else if (value === '') job.needs = blockSequence(lines, index + 1, indent);
      else job.needs = [unquote(value)];
    } else if (field === 'strategy') {
      const matrixIndex = lines.findIndex((entry, position) => position > index && entry.indent === 6 && /^ {6}matrix:\s*$/u.test(entry.text));
      if (matrixIndex !== -1) job.matrix = parseMatrix(job, lines, matrixIndex + 1, problems);
    }
  }
  if (job.runsOn === null) {
    problems.push(`${WORKFLOW_PATH} job "${job.id}" declares no "runs-on", so nothing says which platform it ran on`);
  }
  for (const [field, value] of [
    ['name', job.name],
    ['runs-on', job.runsOn],
  ]) {
    if (typeof value !== 'string') continue;
    for (const match of value.matchAll(/\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/gu)) {
      if (job.matrix === null || !(match[1] in job.matrix)) {
        problems.push(`${WORKFLOW_PATH} job "${job.id}" interpolates matrix.${match[1]} into its ${field} and no such matrix dimension was read`);
      }
    }
  }
  delete job.lines;
}

/** A YAML block sequence (`- item` lines) following a key at `keyIndent`. */
function blockSequence(lines, from, keyIndent) {
  const items = [];
  for (let index = from; index < lines.length; index += 1) {
    const { text, indent } = lines[index];
    if (indent <= keyIndent) break;
    const item = /^\s*-\s+(.+?)\s*$/u.exec(text);
    if (item === null) break;
    items.push(unquote(item[1]));
  }
  return items;
}

/** `matrix:` as a map of dimension to values. Only the shapes this workflow uses. */
function parseMatrix(job, lines, from, problems) {
  const matrix = {};
  for (let index = from; index < lines.length; index += 1) {
    const { text, indent, number } = lines[index];
    if (indent <= 6) break;
    if (indent !== 8) continue;
    const key = /^ {8}([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/u.exec(text);
    if (key === null) {
      problems.push(`${WORKFLOW_PATH}:${String(number)} is inside job "${job.id}"'s matrix and this reader cannot classify it`);
      continue;
    }
    const [, dimension, value] = key;
    if (dimension === 'include' || dimension === 'exclude') {
      problems.push(
        `${WORKFLOW_PATH} job "${job.id}" uses matrix ${dimension}, which this reader does not model. ` +
          'It would have to guess which legs actually run, and a guess about which platforms were tested is the fact itself.',
      );
      continue;
    }
    const inline = /^\[(.*)\]$/u.exec(value);
    if (inline !== null) matrix[dimension] = flowSequence(inline[1]);
    else if (value === '') matrix[dimension] = blockSequence(lines, index + 1, indent);
    else matrix[dimension] = [unquote(value)];
  }
  return Object.keys(matrix).length === 0 ? null : matrix;
}

export function readWorkflow() {
  const path = repoPath(WORKFLOW_PATH);
  if (!existsSync(path)) {
    return { jobs: [], jobIds: [], receiptJobId: null, receiptJobName: null, problems: [`${WORKFLOW_PATH} is not in the tree`] };
  }
  return readWorkflowJobs(readFileSync(path, 'utf8'));
}

/** The jobs whose conclusion the receipt has to carry: every job but the receipt's own. */
export function requiredJobIds(workflow) {
  return workflow.jobIds.filter((id) => id !== workflow.receiptJobId);
}

function substituteMatrix(text, values) {
  return String(text).replace(/\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/gu, (whole, key) => (key in values ? values[key] : whole));
}

/**
 * Every leg the workflow declares, by the name GitHub will report for it.
 *
 * A matrix job is not one job. `core-gate` with `os: [ubuntu-latest,
 * windows-latest]` and `node: ['22','24']` is four runs on two operating
 * systems, and the whole content of `cross_platform_reproducibility_passed` is
 * that all four were green. Expanding the matrix here is what makes deleting a
 * platform from the workflow change what the receipt has to prove.
 *
 * The order is the workflow's declaration order, nested by dimension order, so
 * the same file always produces the same list.
 *
 * @returns {Array<{jobId: string, name: string, runsOn: string, values: object}>}
 */
export function requiredJobLegs(workflow) {
  const legs = [];
  for (const job of workflow.jobs) {
    if (job.id === workflow.receiptJobId) continue;
    const dimensions = job.matrix === null ? [] : Object.entries(job.matrix);
    let combinations = [{}];
    for (const [dimension, values] of dimensions) {
      const next = [];
      for (const combination of combinations) {
        for (const value of values) next.push({ ...combination, [dimension]: value });
      }
      combinations = next;
    }
    for (const values of combinations) {
      legs.push({
        jobId: job.id,
        name: substituteMatrix(job.name ?? job.id, values),
        runsOn: substituteMatrix(job.runsOn ?? '', values),
        values,
      });
    }
  }
  return legs;
}

/** A check run or job GitHub has not finished, as `concluded()` spells it. */
const NOT_CONCLUDED = / \(not concluded\)$/u;

/**
 * What identifies the receipt job's own check run, from the workflow: the
 * receipt job's name and the names of the legs that must have run beside it.
 */
export function receiptCheckIdentity(workflow) {
  return { receiptJobName: workflow.receiptJobName ?? null, requiredCheckNames: requiredJobLegs(workflow).map((leg) => leg.name) };
}

/**
 * The receipt job's own check run, as the receipt caches it, or null (D77).
 *
 * The receipt is written by its own job, inside the run it describes, so that
 * job's check run is necessarily unfinished in it. A name is not an identity:
 * any integration can create a check run on a commit and call it anything. The
 * entry is the receipt job's only if it is GitHub Actions', in the one check
 * suite every required leg recorded in the receipt ran in, on the receipt's
 * commit, unfinished — and only if exactly one entry is all of that. Anything
 * else carrying the name is an ordinary check run.
 */
export function receiptOwnCheckRun(receipt, { receiptJobName, requiredCheckNames } = {}) {
  const runs = Array.isArray(receipt?.checkRuns) ? receipt.checkRuns.filter((run) => run !== null && typeof run === 'object') : [];
  if (typeof receiptJobName !== 'string' || receiptJobName === '' || !Array.isArray(requiredCheckNames) || requiredCheckNames.length === 0) return null;
  // App identity first (MCD-R2): only GitHub Actions check runs say which suite
  // the legs ran in; another app's check run with a leg's name is an ordinary one.
  const suites = new Set(runs.filter((run) => run.app === 'github-actions' && requiredCheckNames.includes(run.name)).map((run) => run.checkSuiteId ?? null));
  if (suites.size !== 1) return null;
  const [suite] = suites;
  if (suite === null) return null;
  const candidates = runs.filter(
    (run) =>
      run.name === receiptJobName &&
      run.app === 'github-actions' &&
      run.checkSuiteId === suite &&
      run.headSha === receipt.sha &&
      typeof run.conclusion === 'string' &&
      NOT_CONCLUDED.test(run.conclusion),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

/** The required legs that needed more than one attempt, by check-run identity. */
function legRerunNames(checkRuns, legNames) {
  const actions = checkRuns.filter((run) => run !== null && typeof run === 'object' && run.app === 'github-actions' && legNames.includes(run.name));
  const suites = new Set(actions.map((run) => run.checkSuiteId ?? null));
  if (suites.size !== 1 || suites.has(null)) return [];
  return [...new Set(actions.filter((run) => run.conclusion !== 'success').map((run) => run.name))].sort();
}

/**
 * The receipt job's own job in the observed run: the one job carrying its name
 * in the receipt's attempt. Its id is its check run's id.
 */
function observedReceiptJob(receipt, workflow, observation) {
  if (workflow.receiptJobName === null) return { job: null, problems: [] };
  const matching = (observation.jobs ?? []).filter((job) => job.name === workflow.receiptJobName && String(job.runAttempt) === String(receipt.runAttempt));
  if (matching.length === 1 && matching[0].jobId !== null && matching[0].jobId !== undefined) return { job: matching[0], problems: [] };
  if (matching.length === 0) return { job: null, problems: [] };
  return {
    job: null,
    problems: [`GitHub reports ${String(matching.length)} jobs named "${workflow.receiptJobName}" in attempt ${String(receipt.runAttempt)} of run ${String(receipt.runId)}, so the receipt job's own check run cannot be identified`],
  };
}

/**
 * The operating-system family a runner label belongs to.
 *
 * Coarse on purpose: `ubuntu-latest`, `ubuntu-24.04` and a self-hosted `linux`
 * label are one platform for the purpose of this fact, and counting them as
 * three would let a matrix of three ubuntu versions satisfy a floor about
 * platforms. An unrecognised label is its own family rather than being folded
 * into a known one, so a new platform reads as new.
 */
export function osFamilyOf(label) {
  const text = String(label).toLowerCase();
  if (text.includes('windows')) return 'windows';
  if (text.includes('ubuntu') || text.includes('linux') || text.includes('debian')) return 'linux';
  if (text.includes('macos') || text.includes('mac-')) return 'macos';
  return `unrecognised:${text}`;
}

// ---------------------------------------------------------------------------
// The live candidate
// ---------------------------------------------------------------------------

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
}

/**
 * What this checkout actually is, measured here rather than taken from a file.
 *
 * `repository` comes from the origin remote and is normalised to `owner/name`,
 * so an https URL, an ssh URL and a `.git` suffix all reduce to the same string
 * a receipt written by GitHub Actions carries.
 */
export function liveCandidate() {
  const problems = [];
  let sha = null;
  let gitTree = null;
  let repository = null;
  try {
    sha = git(['rev-parse', 'HEAD']);
    gitTree = git(['rev-parse', 'HEAD^{tree}']);
  } catch (error) {
    problems.push(`git could not describe this checkout: ${String(error && error.message ? error.message : error)}`);
  }
  if (process.env.GITHUB_REPOSITORY !== undefined && process.env.GITHUB_REPOSITORY !== '') {
    repository = process.env.GITHUB_REPOSITORY;
  } else {
    try {
      repository = normaliseRepository(git(['config', '--get', 'remote.origin.url']));
    } catch {
      repository = null;
    }
  }
  const measured = measureTree();
  problems.push(...measured.problems);
  let treeClean = null;
  try {
    treeClean = git(['status', '--porcelain', '-uall']) === '';
  } catch {
    treeClean = null;
  }
  return {
    sha,
    gitTree,
    repository,
    manifestDigest: measured.manifestDigest,
    codeDigest: measured.codeDigest,
    treeClean,
    problems,
  };
}

export function normaliseRepository(url) {
  if (typeof url !== 'string' || url === '') return null;
  const trimmed = url.trim().replace(/\.git$/u, '');
  const match = /(?:[:/])([^:/]+\/[^:/]+)$/u.exec(trimmed);
  return match === null ? null : match[1];
}

// ---------------------------------------------------------------------------
// Verifying a receipt
// ---------------------------------------------------------------------------

const HEX40 = /^[0-9a-f]{40}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;

/**
 * Everything about a receipt that can be settled without leaving this machine.
 *
 * Necessary, and nowhere near sufficient — the comment is here because the
 * previous revision treated it as sufficient. Every comparison below is against
 * something this checkout computes, so anything that can read the checkout can
 * satisfy all of them at once. What they establish is that the receipt is about
 * *this* candidate; not that it is about anything that ever happened.
 *
 * @param {object|null} receipt
 * @param {ReturnType<typeof liveCandidate>} live
 * @param {ReturnType<typeof readWorkflow>} workflow
 * @returns {string[]}
 */
export function receiptShapeProblems(receipt, live, workflow) {
  const problems = [...workflow.problems, ...live.problems];
  if (receipt === null || typeof receipt !== 'object') {
    problems.push('there is no readable receipt');
    return problems;
  }

  // The tree has to be clean before any digest here means anything. Without
  // this, `gitTree` describes the committed bytes while `manifestDigest` was
  // measured over the working tree, and the receipt states two identities for
  // two different byte sets with nothing comparing them. Demonstrated on a real
  // checkout: treeClean false, zero problems reported.
  if (live.treeClean !== true) {
    problems.push(
      live.treeClean === null
        ? 'git could not say whether the working tree is clean, so the manifest digest cannot be attributed to any commit'
        : 'the working tree is dirty, so the manifest digest was measured over bytes no commit contains while gitTree names a commit',
    );
  }

  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    problems.push(`the receipt is schema ${String(receipt.schemaVersion)} and this verifier reads ${RECEIPT_SCHEMA_VERSION}`);
  }
  if (receipt.artifactKind !== RECEIPT_ARTIFACT_KIND) {
    problems.push(`the receipt is a ${String(receipt.artifactKind)}, not a ${RECEIPT_ARTIFACT_KIND}`);
  }
  if (receipt.digestSerialisationVersion !== DIGEST_SERIALISATION_VERSION) {
    problems.push(
      `the receipt was written under digest serialisation ${String(receipt.digestSerialisationVersion)} and this is ${DIGEST_SERIALISATION_VERSION}`,
    );
  }
  if (receipt.exclusionRuleVersion !== EXCLUSION_RULE_VERSION) {
    problems.push(`the receipt was written under exclusion rule ${String(receipt.exclusionRuleVersion)} and this is ${EXCLUSION_RULE_VERSION}`);
  }

  // The four identities. A comparison that is skipped when the live side is
  // unknown is a comparison an unreadable checkout turns off, so an unknown live
  // side is a problem in its own right rather than a reason to say nothing.
  if (live.sha === null) problems.push('this checkout could not name its own commit, so nothing here can be compared with the receipt');
  if (live.repository === null) problems.push('this checkout could not name its own repository, so the receipt cannot be attributed to it');
  if (!HEX40.test(String(receipt.sha))) {
    problems.push(`the receipt's sha ${String(receipt.sha)} is not a commit id`);
  } else if (live.sha !== null && receipt.sha !== live.sha) {
    problems.push(`the receipt names commit ${String(receipt.sha).slice(0, 12)} and this checkout is at ${String(live.sha).slice(0, 12)}`);
  }
  if (!HEX40.test(String(receipt.gitTree))) {
    problems.push(`the receipt's gitTree ${String(receipt.gitTree)} is not a tree id`);
  } else if (live.gitTree !== null && receipt.gitTree !== live.gitTree) {
    problems.push(`the receipt names git tree ${String(receipt.gitTree).slice(0, 12)} and this checkout's tree is ${String(live.gitTree).slice(0, 12)}`);
  }
  if (typeof receipt.repository !== 'string' || receipt.repository === '') {
    problems.push('the receipt names no repository');
  } else if (live.repository !== null && receipt.repository !== live.repository) {
    problems.push(`the receipt is about ${receipt.repository} and this checkout is ${String(live.repository)}`);
  }
  if (!HEX64.test(String(receipt.manifestDigest))) {
    problems.push(`the receipt's manifestDigest ${String(receipt.manifestDigest)} is not a digest`);
  } else if (live.manifestDigest !== null && receipt.manifestDigest !== live.manifestDigest) {
    problems.push(
      `the receipt attests manifest ${String(receipt.manifestDigest).slice(0, 16)} and this tree serialises to ${String(live.manifestDigest).slice(0, 16)}`,
    );
  }
  if (!HEX64.test(String(receipt.codeDigest))) {
    problems.push(`the receipt's codeDigest ${String(receipt.codeDigest)} is not a digest`);
  } else if (live.codeDigest !== null && receipt.codeDigest !== live.codeDigest) {
    problems.push(
      `the receipt attests code ${String(receipt.codeDigest).slice(0, 16)} and this tree's code serialises to ${String(live.codeDigest).slice(0, 16)}`,
    );
  }

  for (const field of ['ref', 'eventName', 'workflow', 'runId', 'runAttempt']) {
    if (typeof receipt[field] !== 'string' || receipt[field] === '') problems.push(`the receipt carries no ${field}`);
  }
  if (typeof receipt.runId === 'string' && !/^[0-9]+$/u.test(receipt.runId)) {
    problems.push(`the receipt's runId ${receipt.runId} is not a workflow run id, so nothing can be read back from GitHub about it`);
  }
  for (const [field, expected] of Object.entries(versions)) {
    if (receipt.versions?.[field] !== expected) {
      problems.push(`the receipt records ${field} ${String(receipt.versions?.[field])} and this tree is ${String(expected)}`);
    }
  }

  // Required jobs: derived from the workflow, never listed here.
  const required = requiredJobIds(workflow);
  const reported = new Map((Array.isArray(receipt.requiredJobs) ? receipt.requiredJobs : []).map((entry) => [entry.name, entry.result]));
  for (const id of required) {
    const result = reported.get(id);
    if (result === undefined) problems.push(`the workflow declares job "${id}" and the receipt does not carry its conclusion`);
    else if (result !== 'success') problems.push(`job "${id}" concluded ${String(result)}`);
  }
  for (const id of reported.keys()) {
    if (!required.includes(id) && id !== workflow.receiptJobId) {
      problems.push(`the receipt carries job "${id}", which the workflow does not declare`);
    }
  }

  // Check runs, as the receipt caches them. Every one green and every one naming
  // this commit: an absent `headSha` used to skip the comparison entirely, so a
  // receipt could list check runs from any commit at all and the only surviving
  // requirement was the word "success".
  const runs = Array.isArray(receipt.checkRuns) ? receipt.checkRuns : null;
  if (runs === null || runs.length === 0) {
    problems.push('the receipt carries no check runs, so nothing says the commit was ever built');
  } else {
    const own = receiptOwnCheckRun(receipt, receiptCheckIdentity(workflow));
    for (const run of runs) {
      if (run === own) continue;
      if (run.conclusion !== 'success') problems.push(`check run "${String(run.name)}" is ${String(run.conclusion ?? 'without a conclusion')}`);
      if (!HEX40.test(String(run.headSha))) {
        problems.push(`check run "${String(run.name)}" carries head sha ${String(run.headSha)}, so nothing says which commit it ran on`);
      } else if (HEX40.test(String(receipt.sha)) && run.headSha !== receipt.sha) {
        problems.push(`check run "${String(run.name)}" ran on ${String(run.headSha).slice(0, 12)}, not on the receipt's ${String(receipt.sha).slice(0, 12)}`);
      }
    }
  }

  return problems;
}

/**
 * The effective final state of a job or a check run, over every attempt.
 *
 * A re-run produces two observations under one name, and the previous code
 * built `new Map(jobs.map((job) => [job.name, job]))` — so the last entry the
 * API happened to return won, and a red first attempt was erased by a green
 * second one with no record that it had existed. Worse, the erasure was
 * order-dependent: the same two observations in the other order produced the
 * opposite verdict, which is a check whose answer depends on how a list was
 * serialised.
 *
 * So observations are grouped by name and reduced deliberately. The **effective
 * final state** is the latest attempt's conclusion, which is the honest reading
 * of a re-run: a leg that failed and was re-run and passed did, in the end,
 * pass. The **history** is every attempt, kept, so a receipt can say that the
 * commit needed two attempts rather than presenting one. And the reduction is
 * permutation-invariant: the attempts are ordered by run attempt and then by
 * completion time before the latest is taken, so the API's ordering decides
 * nothing.
 *
 * @param {readonly object[]} observations
 * @param {(entry: object) => string} nameOf
 * @returns {Map<string, {latest: object, attempts: object[], everFailed: boolean}>}
 */
function byEffectiveState(observations, nameOf = (entry) => entry.name) {
  const grouped = new Map();
  for (const entry of observations) {
    const name = nameOf(entry);
    const list = grouped.get(name) ?? [];
    list.push(entry);
    grouped.set(name, list);
  }
  const effective = new Map();
  for (const [name, attempts] of grouped) {
    const ordered = [...attempts].sort((a, b) => {
      const attemptA = Number(a.runAttempt ?? 0);
      const attemptB = Number(b.runAttempt ?? 0);
      if (attemptA !== attemptB) return attemptA - attemptB;
      const timeA = String(a.completedAt ?? a.startedAt ?? '');
      const timeB = String(b.completedAt ?? b.startedAt ?? '');
      if (timeA !== timeB) return timeA < timeB ? -1 : 1;
      // A total order, so the reduction cannot depend on the API's ordering
      // even when two attempts carry the same times.
      return String(a.jobId ?? a.checkRunId ?? '') < String(b.jobId ?? b.checkRunId ?? '') ? -1 : 1;
    });
    const latest = ordered[ordered.length - 1];
    effective.set(name, {
      latest,
      attempts: ordered,
      everFailed: ordered.some((entry) => entry.conclusion !== 'success'),
    });
  }
  return effective;
}

/**
 * Everything only GitHub can settle, compared against the receipt.
 *
 * @param {object} receipt
 * @param {ReturnType<typeof readWorkflow>} workflow
 * @param {object|null} observation what `observeRun()` read back, or null
 * @param {{requireFinished?: boolean}} [options] `requireFinished` for every
 *   reader outside the run, after it (`--observe`, the freeze verdict): the run
 *   must have concluded success and so must the receipt job's own check run,
 *   which is what excuses that check run's being unfinished in the receipt
 *   (D77). Inside the run (`--emit`'s verifying step, the gate in CI) neither
 *   can have an answer yet, and the option is off.
 * @returns {string[]}
 */
export function receiptObservationProblems(receipt, workflow, observation, { requireFinished = false } = {}) {
  if (observation === null) {
    return [
      'nothing was read back from the GitHub API, so this receipt is a file and not evidence. A receipt forged offline ' +
        'reproduces every field a checkout can compute; only the run itself, read from GitHub by its run id, says the jobs ran.',
    ];
  }
  const problems = [...observation.problems];
  if (observation.run === null) return problems;

  // How complete the reading was, said before anything is concluded from it.
  // An absent collection, an empty one, one that could not be read and one that
  // was read short are four different states, and three of them used to be
  // indistinguishable from "no failures were found".
  for (const [what, status] of [
    ['the run’s jobs', observation.jobsStatus],
    ['the commit’s check runs', observation.checkRunsStatus],
  ]) {
    if (status === 'ABSENT') problems.push(`${what} were never read, so nothing was observed about them`);
    if (status === 'UNREADABLE') problems.push(`${what} could not be read, which is NOT_VERIFIED rather than nothing to report`);
    if (status === 'EMPTY') problems.push(`${what} came back empty, so nothing says the commit was ever built`);
  }

  const run = observation.run;
  if (run.headSha !== receipt.sha) {
    problems.push(
      `GitHub reports workflow run ${String(receipt.runId)} ran on commit ${String(run.headSha).slice(0, 12)} ` +
        `and the receipt claims ${String(receipt.sha).slice(0, 12)}`,
    );
  }
  if (run.repository !== receipt.repository) {
    problems.push(
      `GitHub reports workflow run ${String(receipt.runId)} belongs to ${String(run.repository)} and the receipt claims ${String(receipt.repository)}`,
    );
  }
  if (run.path !== WORKFLOW_PATH) {
    problems.push(`GitHub reports workflow run ${String(receipt.runId)} ran ${String(run.path)}, not ${WORKFLOW_PATH}`);
  }
  if (String(run.runAttempt) !== String(receipt.runAttempt)) {
    problems.push(
      `GitHub reports attempt ${String(run.runAttempt)} of run ${String(receipt.runId)} and the receipt records attempt ${String(receipt.runAttempt)}`,
    );
  }
  if (observation.commitTree !== receipt.gitTree) {
    problems.push(
      `GitHub reports commit ${String(receipt.sha).slice(0, 12)} carries tree ${String(observation.commitTree).slice(0, 12)} ` +
        `and the receipt claims ${String(receipt.gitTree).slice(0, 12)}`,
    );
  }

  const jobs = observation.jobs ?? [];
  const byName = byEffectiveState(jobs);
  if (workflow.receiptJobName !== null && !byName.has(workflow.receiptJobName)) {
    problems.push(
      `GitHub reports no job named "${workflow.receiptJobName}" in run ${String(receipt.runId)}, so this run is not the run that wrote the receipt`,
    );
  }

  // Every declared leg of every declared job, by the name the workflow builds.
  const families = new Set();
  const reruns = [];
  for (const leg of requiredJobLegs(workflow)) {
    const entry = byName.get(leg.name);
    if (entry === undefined) {
      problems.push(`the workflow declares the job leg "${leg.name}" and GitHub reports no such job in run ${String(receipt.runId)}`);
      continue;
    }
    const job = entry.latest;
    if (job.conclusion !== 'success') {
      problems.push(
        `GitHub reports job "${leg.name}" as ${String(job.conclusion ?? job.status ?? 'without a conclusion')} on its latest attempt ` +
          `(${String(entry.attempts.length)} attempt${entry.attempts.length === 1 ? '' : 's'} observed)`,
      );
      continue;
    }
    // The history, kept rather than smoothed. A leg that needed two attempts
    // did pass in the end, and the receipt says so rather than presenting one.
    if (entry.everFailed) {
      reruns.push(
        `${leg.name}: ${entry.attempts.map((attempt) => `attempt ${String(attempt.runAttempt ?? '?')} ${String(attempt.conclusion)}`).join(', ')}`,
      );
    }
    if (job.headSha !== receipt.sha) {
      problems.push(`GitHub reports job "${leg.name}" ran on ${String(job.headSha).slice(0, 12)}, not on ${String(receipt.sha).slice(0, 12)}`);
      continue;
    }
    // The platform, as GitHub dispatched it rather than as the job's name
    // spells it. A name is a string the workflow wrote; the labels are where the
    // run was actually placed.
    const labels = Array.isArray(job.labels) ? job.labels : [];
    if (leg.runsOn !== '' && !labels.includes(leg.runsOn)) {
      problems.push(`the workflow asks for job "${leg.name}" on ${leg.runsOn} and GitHub reports it ran on ${labels.join(', ') || 'no recorded label'}`);
      continue;
    }
    for (const label of labels) families.add(osFamilyOf(label));
  }
  if (families.size < MINIMUM_OS_FAMILIES) {
    problems.push(
      `the jobs that passed span ${String(families.size)} operating-system ${families.size === 1 ? 'family' : 'families'} ` +
        `(${[...families].sort().join(', ') || 'none'}), and a cross-platform fact asserts at least ${String(MINIMUM_OS_FAMILIES)}. ` +
        'Shrinking the matrix shrinks what this fact would otherwise mean, so the floor is stated rather than derived from the matrix.',
    );
  }
  // A receipt that omits a re-run is a receipt that presents a smoother history
  // than the one GitHub holds.
  const recordedReruns = Array.isArray(receipt.reruns) ? receipt.reruns : [];
  for (const rerun of reruns) {
    const jobName = rerun.slice(0, rerun.indexOf(':'));
    if (!recordedReruns.some((recorded) => String(recorded).startsWith(`${jobName}: `))) {
      problems.push(`GitHub reports a re-run the receipt does not record — ${rerun}`);
    }
  }

  // Check runs, re-read rather than believed, and by identity rather than by
  // name. The receipt is a cache of this list and has to agree with it in both
  // directions: a run GitHub reports and the receipt omits is a job hidden, and
  // one the receipt invents is a job that never happened.
  //
  // The receipt job's own check run is excused here, while unfinished, and only
  // it: identified by its job's id in this run and attempt (a job's id is its
  // check run's id), never by name. Any other check run carrying the name is an
  // ordinary one.
  const ownJob = observedReceiptJob(receipt, workflow, observation);
  problems.push(...ownJob.problems);
  const ownId = ownJob.job === null ? null : String(ownJob.job.jobId);
  const isOwn = (run) => ownId !== null && run !== null && typeof run === 'object' && run.app === 'github-actions' && String(run.checkRunId) === ownId;
  const cachedRuns = Array.isArray(receipt.checkRuns) ? receipt.checkRuns : [];
  const cachedOwn = cachedRuns.filter(isOwn);
  if (cachedOwn.length > 1) problems.push(`the receipt carries the receipt job's own check run ${String(ownId)} ${String(cachedOwn.length)} times`);
  for (const run of cachedOwn) {
    if (run.conclusion !== 'success' && !(typeof run.conclusion === 'string' && NOT_CONCLUDED.test(run.conclusion))) {
      problems.push(`the receipt records the receipt job's own check run as ${String(run.conclusion)}`);
    }
  }
  const cachedClaim = receiptOwnCheckRun(receipt, receiptCheckIdentity(workflow));
  if (cachedClaim !== null && !isOwn(cachedClaim)) {
    problems.push(`the receipt's unfinished "${String(cachedClaim.name)}" entry is check run ${String(cachedClaim.checkRunId)}, not the receipt job GitHub reports (${String(ownId)})`);
  }
  if (requireFinished) {
    if (run.status !== 'completed') {
      problems.push(`GitHub reports workflow run ${String(receipt.runId)} as ${String(run.status)}: it has not finished, so nothing outside it can say it concluded success`);
    } else if (run.conclusion !== 'success') {
      problems.push(`GitHub reports workflow run ${String(receipt.runId)} concluded ${String(run.conclusion)}`);
    }
    if (ownJob.job !== null) {
      if (ownJob.job.conclusion !== 'success') problems.push(`GitHub reports the receipt job "${String(ownJob.job.name)}" as ${String(ownJob.job.conclusion)}`);
      const ownRuns = (observation.checkRuns ?? []).filter(isOwn);
      if (ownRuns.length !== 1) {
        problems.push(`GitHub reports ${String(ownRuns.length)} check runs with the receipt job's id ${String(ownId)}; its own check run must be read, once, from outside`);
      } else {
        const ownRun = ownRuns[0];
        if (ownRun.conclusion !== 'success') problems.push(`GitHub reports the receipt job's own check run "${String(ownRun.name)}" as ${String(ownRun.conclusion)}`);
        if (ownRun.app !== 'github-actions') problems.push(`the receipt job's own check run ${String(ownId)} belongs to ${String(ownRun.app)}, not github-actions`);
        if (ownRun.headSha !== receipt.sha) problems.push(`the receipt job's own check run ran on ${String(ownRun.headSha).slice(0, 12)}, not on ${String(receipt.sha).slice(0, 12)}`);
      }
    }
  }
  // Every other check run, by its id (MCD-R2). Never grouped by name: a name is
  // a string anyone can give a check run, and grouping by it let one check run
  // stand in for another, or be excused as another's "earlier attempt". Each
  // check run GitHub reports must be in the receipt under the same id with the
  // same conclusion, must itself be success, and must be on this commit; each
  // check run the receipt carries must be one GitHub reports. Re-runs are the
  // jobs' business, read above from this run's own jobs.
  const idOf = (run) => (run !== null && typeof run === 'object' && run.checkRunId !== null && run.checkRunId !== undefined ? String(run.checkRunId) : null);
  const label = (run) => `check run "${String(run?.name)}" (${idOf(run) ?? 'no id'}, ${String(run?.app ?? 'no app')})`;
  const apiRuns = (observation.checkRuns ?? []).filter((run) => !isOwn(run));
  const receiptRuns = cachedRuns.filter((run) => !isOwn(run));
  const cachedById = new Map();
  for (const run of receiptRuns) {
    const id = idOf(run);
    if (id === null) continue;
    if (cachedById.has(id)) problems.push(`the receipt carries ${label(run)} twice`);
    cachedById.set(id, run);
  }
  const apiIds = new Set();
  if ((observation.checkRuns ?? []).length === 0) problems.push(`the GitHub API reports no check runs for commit ${String(receipt.sha).slice(0, 12)}`);
  for (const run of apiRuns) {
    const id = idOf(run);
    if (id !== null) apiIds.add(id);
    const cached = id === null ? undefined : cachedById.get(id);
    if (cached === undefined) problems.push(`GitHub reports ${label(run)} on this commit and the receipt does not carry it`);
    else {
      if (cached.name !== run.name) problems.push(`the receipt names check run ${id} "${String(cached.name)}" and GitHub names it "${String(run.name)}"`);
      if (cached.conclusion !== run.conclusion) problems.push(`the receipt records ${label(run)} as ${String(cached.conclusion)} and GitHub reports ${String(run.conclusion)}`);
    }
    if (run.conclusion !== 'success') problems.push(`GitHub reports ${label(run)} as ${String(run.conclusion)}`);
    if (run.headSha !== receipt.sha) problems.push(`GitHub reports ${label(run)} on ${String(run.headSha).slice(0, 12)}, not on ${String(receipt.sha).slice(0, 12)}`);
  }
  for (const run of receiptRuns) {
    const id = idOf(run);
    if (id === null || !apiIds.has(id)) {
      problems.push(`the receipt carries check run "${String(run.name)}" and GitHub reports no such run on this commit${id === null ? ' (it carries no id)' : ` (id ${id})`}`);
    }
  }
  return problems;
}

/**
 * A receipt, verified. Both halves, and neither is optional.
 *
 * @param {object|null} receipt
 * @param {ReturnType<typeof liveCandidate>} live
 * @param {ReturnType<typeof readWorkflow>} workflow
 * @param {object|null} observation what `observeRun()` read back from GitHub
 * @returns {string[]}
 */
export function receiptProblems(receipt, live, workflow, observation, options = {}) {
  const problems = receiptShapeProblems(receipt, live, workflow);
  if (receipt === null || typeof receipt !== 'object') return problems;
  problems.push(...receiptObservationProblems(receipt, workflow, observation, options));
  return problems;
}

// ---------------------------------------------------------------------------
// The GitHub API
// ---------------------------------------------------------------------------

async function api(path, token) {
  const url = `https://api.github.com${path}`;
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'kauro-receipt-verify' };
  if (token !== undefined && token !== null && token !== '') headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${String(response.status)} ${response.statusText}; a call that did not answer proves nothing`);
  }
  return response.json();
}

/**
 * A paginated collection, and how complete the reading of it was.
 *
 * Two defects lived in the previous four lines, and both of them made an
 * incomplete answer indistinguishable from a complete one.
 *
 * It stopped when a page came back short — which is right for a stable
 * collection and wrong for one GitHub is still writing to, and says nothing
 * about the `total_count` the API itself reports. A run whose jobs list was
 * truncated read as a run with fewer jobs, and a required leg that was simply
 * not on the pages fetched read as a leg GitHub never dispatched.
 *
 * And it asked for the default view. `GET /runs/{id}/jobs` returns the *latest*
 * attempt of each job unless `filter=all` is passed, and
 * `/commits/{sha}/check-runs` returns the latest run per name. On a re-run,
 * the default view is a green picture of a commit whose first attempt was red —
 * which is exactly the history a receipt exists to record.
 *
 * So every page is asked for with `filter=all`, and the count seen is compared
 * with the count declared. The result carries a status rather than only items:
 * COMPLETE, EMPTY, INCOMPLETE or CONTRADICTORY, and the caller reports each
 * differently because they mean different things.
 */
async function apiPages(path, token, collect, countOf) {
  const items = [];
  let declared = null;
  let pages = 0;
  const separator = path.includes('?') ? '&' : '?';
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await api(`${path}${separator}per_page=100&page=${String(page)}`, token);
    pages += 1;
    if (declared === null && countOf !== undefined) declared = countOf(body);
    const batch = collect(body);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  let status = 'COMPLETE';
  if (items.length === 0) status = 'EMPTY';
  else if (declared !== null && items.length < declared) status = 'INCOMPLETE';
  else if (declared !== null && items.length > declared) status = 'CONTRADICTORY';
  return { items, declared, seen: items.length, pages, status };
}

/** A page cap, so a paginator that never terminates fails rather than runs for ever. */
const MAX_PAGES = 50;

/** A check run's or job's conclusion, with "has not finished" never reading as success. */
function concluded(run) {
  return run.status === 'completed' ? run.conclusion : `${String(run.status)} (not concluded)`;
}

/**
 * The run, its jobs, the commit's tree and the commit's check runs, read from
 * GitHub.
 *
 * Fails closed in one direction only: every error becomes a problem and the
 * fields it could not read stay null. There is no path here that returns
 * something a caller could mistake for a successful observation, and the
 * completeness of each collection is carried beside it rather than assumed.
 *
 * @returns {{problems: string[], run: object|null, jobs: object[]|null, jobsStatus: string, checkRuns: object[]|null, checkRunsStatus: string, commitTree: string|null}}
 */
export async function observeRun({ repository, sha, runId, token }) {
  const problems = [];
  const observation = {
    problems,
    run: null,
    jobs: null,
    jobsStatus: 'ABSENT',
    checkRuns: null,
    checkRunsStatus: 'ABSENT',
    commitTree: null,
  };
  if (typeof repository !== 'string' || repository === '' || !HEX40.test(String(sha)) || !/^[0-9]+$/u.test(String(runId))) {
    problems.push('the receipt does not name a repository, a commit and a workflow run id, so there is nothing to read back from GitHub');
    return observation;
  }
  if (token === undefined || token === null || token === '') {
    problems.push(
      'no GitHub token is available, so the workflow run could not be read back. The fact is FALSE rather than falling back ' +
        'to the receipt file: a file is what the forgery was.',
    );
    return observation;
  }
  try {
    const run = await api(`/repos/${repository}/actions/runs/${String(runId)}`, token);
    observation.run = {
      headSha: run.head_sha ?? null,
      path: run.path ?? null,
      runAttempt: run.run_attempt ?? null,
      status: run.status ?? null,
      conclusion: run.conclusion ?? null,
      repository: run.repository?.full_name ?? null,
      event: run.event ?? null,
      workflowId: run.workflow_id ?? null,
    };
  } catch (error) {
    problems.push(`the workflow run could not be read: ${String(error && error.message ? error.message : error)}`);
    observation.jobsStatus = 'UNREADABLE';
    observation.checkRunsStatus = 'UNREADABLE';
    return observation;
  }
  try {
    // `filter=all` returns every attempt of every job, not the latest of each.
    const page = await apiPages(
      `/repos/${repository}/actions/runs/${String(runId)}/jobs?filter=all`,
      token,
      (body) =>
        (body.jobs ?? []).map((job) => ({
          jobId: job.id ?? null,
          name: job.name,
          conclusion: concluded(job),
          status: job.status,
          headSha: job.head_sha ?? null,
          runAttempt: job.run_attempt ?? null,
          startedAt: job.started_at ?? null,
          completedAt: job.completed_at ?? null,
          labels: Array.isArray(job.labels) ? job.labels : [],
        })),
      (body) => (typeof body.total_count === 'number' ? body.total_count : null),
    );
    observation.jobs = page.items;
    observation.jobsStatus = page.status;
    if (page.status === 'INCOMPLETE') {
      problems.push(`GitHub reports ${String(page.declared)} jobs for run ${String(runId)} and only ${String(page.seen)} could be read`);
    }
    if (page.status === 'CONTRADICTORY') {
      problems.push(`GitHub reports ${String(page.declared)} jobs for run ${String(runId)} and ${String(page.seen)} were read; the API contradicts itself`);
    }
  } catch (error) {
    problems.push(`the run's jobs could not be read: ${String(error && error.message ? error.message : error)}`);
    observation.jobsStatus = 'UNREADABLE';
  }
  try {
    const commit = await api(`/repos/${repository}/commits/${String(sha)}`, token);
    observation.commitTree = commit.commit?.tree?.sha ?? null;
    if (observation.commitTree === null) problems.push(`GitHub reported no tree hash for commit ${String(sha).slice(0, 12)}`);
  } catch (error) {
    problems.push(`the commit could not be read: ${String(error && error.message ? error.message : error)}`);
  }
  try {
    const page = await fetchCheckRunsPage(repository, sha, token);
    observation.checkRuns = page.items;
    observation.checkRunsStatus = page.status;
    if (page.status === 'INCOMPLETE') {
      problems.push(`GitHub reports ${String(page.declared)} check runs on ${String(sha).slice(0, 12)} and only ${String(page.seen)} could be read`);
    }
    if (page.status === 'CONTRADICTORY') {
      problems.push(`GitHub reports ${String(page.declared)} check runs on ${String(sha).slice(0, 12)} and ${String(page.seen)} were read`);
    }
  } catch (error) {
    problems.push(`the check runs could not be read: ${String(error && error.message ? error.message : error)}`);
    observation.checkRunsStatus = 'UNREADABLE';
  }
  return observation;
}

/**
 * Check runs for a commit, every one of them.
 *
 * `filter=all` rather than the default `latest`: the default returns one run per
 * name, so a re-run hides the attempt that failed, and the receipt would record
 * a green history that did not happen.
 */
async function fetchCheckRunsPage(repository, sha, token) {
  return apiPages(
    `/repos/${repository}/commits/${sha}/check-runs?filter=all`,
    token,
    (body) =>
      (body.check_runs ?? []).map((run) => ({
        checkRunId: run.id ?? null,
        name: run.name,
        conclusion: concluded(run),
        status: run.status,
        headSha: run.head_sha ?? null,
        startedAt: run.started_at ?? null,
        completedAt: run.completed_at ?? null,
        app: run.app?.slug ?? null,
        checkSuiteId: run.check_suite?.id ?? null,
      })),
    (body) => (typeof body.total_count === 'number' ? body.total_count : null),
  );
}

/** Fails closed: a network problem is not an absence of failures. */
export async function fetchCheckRuns(repository, sha, token) {
  const page = await fetchCheckRunsPage(repository, sha, token);
  if (page.status === 'INCOMPLETE' || page.status === 'CONTRADICTORY') {
    throw new Error(
      `GitHub reports ${String(page.declared)} check runs on ${String(sha).slice(0, 12)} and ${String(page.seen)} were read; ` +
        'an incomplete reading is not a complete one',
    );
  }
  return page.items;
}

/** The token this tool is allowed to use, by name. Never logged, never recorded. */
export function githubToken() {
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
  }
  // The environment, and nothing else.
  //
  // A previous revision fell back to `git credential fill`, which was wrong
  // three times over. It made the fail-closed path this whole file rests on —
  // no token, so the fact is FALSE, and it does not fall back to the file —
  // unreachable on any machine with a credential helper, so a fact designed to
  // be false off CI became true off CI on a person's own token. It ran whatever
  // `credential.helper` resolves to, which on Windows can be a graphical prompt:
  // a read-only verification tool opening an interactive authentication window.
  // And every caller inherited it without saying so.
  //
  // An operator who wants the verdict computed passes the token in, which is a
  // decision they can see themselves making.
  return null;
}

// ---------------------------------------------------------------------------
// Emitting
// ---------------------------------------------------------------------------

function requireEnv(name, problems) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    problems.push(`${name} is not set; a receipt is written by CI and cannot be fabricated by hand`);
    return null;
  }
  return value;
}

export function buildReceipt(live, workflow, needs, checkRuns) {
  const problems = [];
  const repository = requireEnv('GITHUB_REPOSITORY', problems);
  const sha = requireEnv('GITHUB_SHA', problems);
  const ref = requireEnv('GITHUB_REF', problems);
  const eventName = requireEnv('GITHUB_EVENT_NAME', problems);
  const workflowName = requireEnv('GITHUB_WORKFLOW', problems);
  const runId = requireEnv('GITHUB_RUN_ID', problems);
  const runAttempt = requireEnv('GITHUB_RUN_ATTEMPT', problems);
  if (live.sha !== null && sha !== null && live.sha !== sha) {
    problems.push(
      `GITHUB_SHA is ${sha.slice(0, 12)} and the checkout is at ${live.sha.slice(0, 12)}; ` +
        'the receipt must be written from the commit it attests, not from a different one',
    );
  }
  if (live.treeClean === false) {
    problems.push('the working tree is dirty, so the manifest digest is not the digest of the committed tree');
  }
  if (problems.length > 0) return { receipt: null, problems };
  return {
    receipt: {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      artifactKind: RECEIPT_ARTIFACT_KIND,
      generator: 'tools/receipt-verify.mjs --emit',
      repository,
      sha,
      gitTree: live.gitTree,
      ref,
      branch: process.env.GITHUB_REF_NAME ?? null,
      eventName,
      workflow: workflowName,
      runId,
      runNumber: process.env.GITHUB_RUN_NUMBER ?? null,
      runAttempt,
      manifestDigest: live.manifestDigest,
      codeDigest: live.codeDigest,
      digestSerialisationVersion: DIGEST_SERIALISATION_VERSION,
      exclusionRuleVersion: EXCLUSION_RULE_VERSION,
      versions: { ...versions },
      node: process.version,
      runnerOs: process.env.RUNNER_OS ?? null,
      requiredJobs: requiredJobIds(workflow).map((id) => ({ name: id, result: needs?.[id]?.result ?? null })),
      // The identity of each observation, not only its name. A re-run produces
      // two check runs under one name, and a receipt that carried only the name
      // could not say which of them it had cached — so a red attempt and a
      // green one were the same entry, and whichever the API returned last won.
      checkRuns: checkRuns
        .map((run) => ({
          checkRunId: run.checkRunId ?? null,
          name: run.name,
          conclusion: run.conclusion,
          headSha: run.headSha ?? null,
          startedAt: run.startedAt ?? null,
          completedAt: run.completedAt ?? null,
          app: run.app ?? null,
          checkSuiteId: run.checkSuiteId ?? null,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : String(a.checkRunId) < String(b.checkRunId) ? -1 : 1)),
      // Every name that needed more than one attempt, kept rather than
      // smoothed. A commit that went green on the second try did go green, and
      // a receipt that presented one attempt would be describing a history that
      // did not happen.
      //
      // By identity (MCD-R2): a re-run is an earlier attempt of a required leg,
      // a GitHub Actions check run in the one check suite the legs ran in. The
      // receipt job's own unfinished run is not one, and neither is any other
      // check run that merely failed; those are refused as themselves.
      reruns: legRerunNames(checkRuns, requiredJobLegs(workflow).map((leg) => leg.name))
        .map((name) => `${name}: an attempt did not conclude success`),
    },
    problems: [],
  };
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

/**
 * Exit codes, so a caller can tell why this refused without parsing prose.
 *
 * The gate and CI both branch on the outcome, and "non-zero" is not enough:
 * a malformed receipt, a receipt about another candidate and a GitHub the tool
 * could not reach are three different situations with three different actions.
 */
export const EXIT = Object.freeze({
  OK: 0,
  REFUSED: 1,
  USAGE: 64,
  RECEIPT_MISSING: 65,
  RECEIPT_MALFORMED: 66,
  RECEIPT_INCOMPATIBLE: 67,
  API_UNUSABLE: 69,
});

/**
 * A strict parser.
 *
 * `valueOf` took `args.indexOf(flag)` and the token after it, so `--receipt`
 * with nothing after it silently became "no receipt", `--receipt --emit`
 * silently took `--emit` as a path, an unknown option was ignored, and a
 * repeated one kept the first. Every one of those runs a different command from
 * the one that was typed, and the operator finds out from the verdict rather
 * than from the parser.
 */
const KNOWN_FLAGS = ['--receipt', '--out', '--check-runs'];
const KNOWN_SWITCHES = ['--emit', '--observe'];

export function parseArgs(args) {
  const flags = new Map();
  const switches = new Set();
  const problems = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (KNOWN_SWITCHES.includes(token)) {
      if (switches.has(token)) problems.push(`${token} is given more than once`);
      switches.add(token);
      continue;
    }
    if (KNOWN_FLAGS.includes(token)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        problems.push(`${token} needs a value`);
        continue;
      }
      if (flags.has(token)) problems.push(`${token} is given more than once`);
      flags.set(token, value);
      index += 1;
      continue;
    }
    problems.push(`unknown option ${token}`);
  }
  return { flags, switches, problems };
}

function report(problems, headline, code = EXIT.REFUSED) {
  if (problems.length === 0) {
    process.stderr.write(`\nRECEIPT-01 = PASS\n  ${headline}\n\n`);
    return EXIT.OK;
  }
  process.stderr.write(`\nRECEIPT-01 = FAIL\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.stderr.write(
    `\nA receipt attests one commit of one repository, and GitHub is the party that watched the jobs run. Every field above is ` +
      `compared against this checkout or against what the API reports, so a disagreement means the receipt is about a different ` +
      `candidate — not that the check is too strict.\n\n`,
  );
  // The machine-readable form beside the prose, so CI and the gate branch on a
  // structure rather than on a string. `--emit` used to parse a receipt with a
  // bare `JSON.parse` and let the exception out, so a truncated artifact ended
  // the job with a stack trace and no statement of what was wrong.
  process.stdout.write(`${JSON.stringify({ gate: 'RECEIPT-01', result: 'FAIL', exitCode: code, problems }, null, 2)}\n`);
  return code;
}

async function main(args) {
  const parsed = parseArgs(args);
  if (parsed.problems.length > 0) {
    process.stderr.write(
      `${parsed.problems.map((problem) => `  ${problem}\n`).join('')}\n` +
        'usage: node tools/receipt-verify.mjs [--receipt <path>]\n' +
        '       node tools/receipt-verify.mjs --emit --out <path outside the repository> [--check-runs <json>]\n' +
        '       node tools/receipt-verify.mjs --observe --receipt <path>\n',
    );
    return EXIT.USAGE;
  }
  const workflow = readWorkflow();
  const live = liveCandidate();

  if (existsSync(repoPath(IN_TREE_RECEIPT_PATH))) {
    return report(
      [
        `${IN_TREE_RECEIPT_PATH} exists. A receipt committed into the tree cannot name the SHA of the commit containing it: ` +
          'writing the SHA changes the file, the tree, the commit and the SHA. Delete it; the receipt is a CI artifact.',
      ],
      '',
      EXIT.RECEIPT_INCOMPATIBLE,
    );
  }

  if (parsed.switches.has('--emit')) {
    const out = parsed.flags.get('--out');
    if (out === undefined) return report(['--emit needs --out <path>'], '', EXIT.USAGE);
    const resolved = resolve(out);
    if (resolved === repoRoot || resolved.startsWith(repoRoot + sep)) {
      return report(
        [`--out ${resolved} is inside ${repoRoot}. The receipt is written outside the measured tree, which is the only reason it can name it.`],
        '',
        EXIT.USAGE,
      );
    }
    const checkRunsPath = parsed.flags.get('--check-runs');
    let checkRuns = null;
    if (checkRunsPath !== undefined) {
      // Guarded. This was a bare `JSON.parse(readFileSync(...))` followed by
      // `.map`, so an unreadable file, a truncated one, or a body shaped like
      // an API error ended the job with a stack trace rather than a statement.
      let body;
      try {
        body = JSON.parse(readFileSync(checkRunsPath, 'utf8'));
      } catch (error) {
        return report(
          [`${checkRunsPath} is not readable JSON: ${String(error && error.message ? error.message : error)}`],
          '',
          EXIT.RECEIPT_MALFORMED,
        );
      }
      const list = Array.isArray(body) ? body : Array.isArray(body.check_runs) ? body.check_runs : null;
      if (list === null) {
        return report(
          [`${checkRunsPath} carries neither an array of check runs nor a check_runs array; a body this reader cannot understand is not an observation`],
          '',
          EXIT.RECEIPT_MALFORMED,
        );
      }
      if (typeof body === 'object' && !Array.isArray(body) && typeof body.total_count === 'number' && list.length < body.total_count) {
        return report(
          [`${checkRunsPath} declares ${String(body.total_count)} check runs and carries ${String(list.length)}; an incomplete reading is NOT_VERIFIED`],
          '',
          EXIT.API_UNUSABLE,
        );
      }
      checkRuns = list.map((run) => ({
        checkRunId: run.id ?? null,
        name: run.name,
        conclusion: run.status === 'completed' ? run.conclusion : `${String(run.status)} (not concluded)`,
        headSha: run.head_sha ?? null,
        startedAt: run.started_at ?? null,
        completedAt: run.completed_at ?? null,
        app: run.app?.slug ?? null,
        checkSuiteId: run.check_suite?.id ?? null,
      }));
    } else if (live.repository !== null && live.sha !== null) {
      try {
        checkRuns = await fetchCheckRuns(live.repository, live.sha, githubToken());
      } catch (error) {
        return report([`the check runs could not be read from GitHub: ${String(error && error.message ? error.message : error)}`], '', EXIT.API_UNUSABLE);
      }
    }
    if (checkRuns === null || checkRuns.length === 0) {
      return report(['no check runs were supplied or could be read, and a receipt with no observed jobs proves nothing'], '', EXIT.API_UNUSABLE);
    }
    const needsJson = process.env.NEEDS_JSON;
    if (needsJson === undefined || needsJson === '') {
      return report(["NEEDS_JSON is not set; the receipt job must pass ${{ toJSON(needs) }} so each required job's conclusion is recorded"], '', EXIT.USAGE);
    }
    let needs;
    try {
      needs = JSON.parse(needsJson);
    } catch (error) {
      return report([`NEEDS_JSON is not readable JSON: ${String(error && error.message ? error.message : error)}`], '', EXIT.RECEIPT_MALFORMED);
    }
    const { receipt, problems } = buildReceipt(live, workflow, needs, checkRuns);
    if (receipt === null) return report(problems, '', EXIT.RECEIPT_INCOMPATIBLE);
    // Shape only, deliberately. This runs inside the run it is about: the run
    // has not concluded, this job's own check run is still in progress, and
    // asking GitHub whether the run finished green from inside it would be
    // asking a question that cannot yet have an answer. The observation is the
    // verifying step's, immediately after, and the gate's.
    const verification = receiptShapeProblems(receipt, live, workflow);
    if (verification.length > 0) return report(verification, '', EXIT.RECEIPT_INCOMPATIBLE);
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return report([], `wrote ${resolved} for ${receipt.repository}@${receipt.sha.slice(0, 12)}, manifest ${receipt.manifestDigest.slice(0, 16)}`);
  }

  // The external observer.
  //
  // `--emit` runs inside the run it describes, so it can only check the receipt's
  // shape: the run has not concluded and this job's own check run is still in
  // progress. Asking whether the run finished green from inside it is asking a
  // question that cannot yet have an answer — and a job that decided its own
  // conclusion would be attesting itself.
  //
  // `--observe` is the other half: it runs after the run has finished, from
  // outside it, reads the run back from GitHub by id, verifies the artifact
  // that was uploaded, and emits the final receipt. The two are deliberately
  // different programs run at different times by different actors.
  if (parsed.switches.has('--observe')) {
    const cached = parsed.flags.get('--receipt');
    if (cached === undefined) return report(['--observe needs --receipt <path to the provisional receipt>'], '', EXIT.USAGE);
    if (!existsSync(cached)) return report([`${cached} does not exist`], '', EXIT.RECEIPT_MISSING);
    let provisional;
    try {
      provisional = JSON.parse(readFileSync(cached, 'utf8'));
    } catch (error) {
      return report([`${cached} is not readable JSON: ${String(error && error.message ? error.message : error)}`], '', EXIT.RECEIPT_MALFORMED);
    }
    const observed = await observeRun({
      repository: provisional.repository,
      sha: provisional.sha,
      runId: provisional.runId,
      token: githubToken(),
    });
    // From outside, after the run: the run and the receipt job itself must have
    // concluded success (MCD-R1), which is what lets a reader excuse the receipt
    // job's own check run being unfinished in the receipt.
    const problems = receiptProblems(provisional, live, workflow, observed, { requireFinished: true });
    if (observed.jobsStatus === 'UNREADABLE' || observed.checkRunsStatus === 'UNREADABLE' || observed.jobsStatus === 'INCOMPLETE' || observed.checkRunsStatus === 'INCOMPLETE') {
      return report(problems.length > 0 ? problems : ['the GitHub API could not be read completely, which is NOT_VERIFIED'], '', EXIT.API_UNUSABLE);
    }
    if (problems.length > 0) return report(problems, '', EXIT.REFUSED);
    const out = parsed.flags.get('--out');
    if (out !== undefined) {
      const resolved = resolve(out);
      if (resolved === repoRoot || resolved.startsWith(repoRoot + sep)) {
        return report([`--out ${resolved} is inside ${repoRoot}; the final receipt is written outside the measured tree`], '', EXIT.USAGE);
      }
      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(
        resolved,
        `${JSON.stringify(
          {
            ...provisional,
            observedBy: 'tools/receipt-verify.mjs --observe',
            observedAt: `${new Date().toISOString().slice(0, 19)}Z`,
            observation: {
              jobs: observed.jobs,
              jobsStatus: observed.jobsStatus,
              checkRuns: observed.checkRuns,
              checkRunsStatus: observed.checkRunsStatus,
              commitTree: observed.commitTree,
              run: observed.run,
            },
          },
          null,
          2,
        )}\n`,
      );
    }
    return report(
      [],
      `run ${String(provisional.runId)} of ${String(provisional.repository)}@${String(provisional.sha).slice(0, 12)} observed from outside it: ` +
        `${String((observed.jobs ?? []).length)} jobs and ${String((observed.checkRuns ?? []).length)} check runs, every attempt read`,
    );
  }

  const receiptPath = parsed.flags.get('--receipt') ?? process.env.KAURO_RECEIPT_PATH ?? null;
  if (receiptPath === null) {
    return report(['no receipt: pass --receipt <path>, or set KAURO_RECEIPT_PATH, or use --emit inside CI'], '', EXIT.RECEIPT_MISSING);
  }
  if (!existsSync(receiptPath)) {
    return report([`${receiptPath} does not exist`], '', EXIT.RECEIPT_MISSING);
  }
  let receipt = null;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch (error) {
    return report([`${receiptPath} is not readable JSON: ${String(error && error.message ? error.message : error)}`], '', EXIT.RECEIPT_MALFORMED);
  }
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return report([`${receiptPath} is not a receipt object`], '', EXIT.RECEIPT_MALFORMED);
  }
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    return report(
      [`${receiptPath} is schema ${String(receipt.schemaVersion)} and this verifier reads ${RECEIPT_SCHEMA_VERSION}`],
      '',
      EXIT.RECEIPT_INCOMPATIBLE,
    );
  }
  // Unconditional. `--from-api` used to make this optional, and the default was
  // to trust the file — which is how a receipt written on a laptop verified.
  const observation = await observeRun({
    repository: receipt.repository,
    sha: receipt.sha,
    runId: receipt.runId,
    token: githubToken(),
  });
  const problems = receiptProblems(receipt, live, workflow, observation);
  const unusable =
    observation.jobsStatus === 'UNREADABLE' ||
    observation.checkRunsStatus === 'UNREADABLE' ||
    observation.jobsStatus === 'INCOMPLETE' ||
    observation.checkRunsStatus === 'INCOMPLETE';
  return report(
    problems,
    `receipt for ${String(receipt.repository)}@${String(receipt.sha).slice(0, 12)}, run ${String(receipt.runId)} attempt ` +
      `${String(receipt.runAttempt)}, ${String((observation.jobs ?? []).length)} jobs and ${String((observation.checkRuns ?? []).length)} ` +
      'check runs read from GitHub with every attempt, all green',
    unusable ? EXIT.API_UNUSABLE : EXIT.REFUSED,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
