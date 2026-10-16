#!/usr/bin/env node
/**
 * RELEASE-CANDIDATE-01 — the MC-2 gate.
 *
 * Answers one question: is the tree at this exact commit a release candidate?
 *
 * ARCHITECTURE-01 asks whether the bounded architecture is in the tree.
 * This asks whether that architecture has been shown to survive the real world —
 * the final offline universe, the two vendors as they are today, a million rows
 * in each mode inside the founding budgets, and evidence that belongs to this
 * candidate rather than to some earlier one. The two are separate jobs for the
 * same reason MC-1 kept them separate: conflating "the engine is correct" with
 * "the work is finished" destroys the signal in both directions.
 *
 * Every fact is obtained by executing something, measuring something,
 * instrumenting something, or verifying evidence against the artifact it
 * describes. None is read from a claim this repository makes about itself.
 *
 *   RELEASE_CANDIDATE=true in a document is not a fact. It is a sentence.
 *
 * That is the whole design constraint. A gate that reads a flag passes whenever
 * somebody writes the flag down, and the flag is exactly what is under dispute.
 * So where this gate reads a file, it reads a file that records a measurement,
 * checks the measurement against a limit stated in bytes, and checks that the
 * file describes the candidate in front of it — never that the file says PASS.
 *
 * Output is machine-readable on stdout and a table on stderr. It exits non-zero
 * when MIGRATION_CORE_RELEASE_CANDIDATE is not TRUE.
 *
 *   node tools/release-candidate-gate.mjs                 run the gate
 *   node tools/release-candidate-gate.mjs --json          machine output only
 *   node tools/release-candidate-gate.mjs --preflight     write the in-tree preflight
 *   node tools/release-candidate-gate.mjs --preflight --check   verify it without writing
 *   node tools/release-candidate-gate.mjs --self-test     prove the gate can say FALSE
 *
 * The provenance check this gate runs for the drift fact is the before-preflight
 * mode (`provenance.mjs --check --before-preflight`, D76): the preflight is being
 * computed, so it cannot be required by its own computation. Only the preflight
 * may be absent. The final check, plain `provenance:check`, still requires it.
 * The matrix fact `capacity_profiles_matrix_complete` expects every profile
 * profiles.json declares (`^Pd+$`), not a count written here.
 *
 * The receipt is not read from the tree. See tools/receipt-verify.mjs for why a
 * committed receipt cannot name its own commit; pass one with `--receipt <path>`
 * or in `KAURO_RECEIPT_PATH`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The manifest digest is computed in exactly one place, and this is a caller of
// it rather than a second implementation. It was a second implementation once:
// this file rebuilt the serialisation beside the producer's, over the manifest's
// own stored table instead of over the tree, silently skipping any entry whose
// file had gone. The two agreed on the day they were written and nowhere else.
import {
  DIGEST_SERIALISATION_VERSION,
  EXCLUSION_RULE_VERSION,
  PSEUDONYMOUS_INSTANCE_PATTERN,
  VENDOR_BINDING_VERSION,
  digestRecords,
  pseudonymousInstance,
  serialisationGoldenProblems,
  vendorRunnerProblems,
  verifyManifest,
  versions,
} from './candidate-provenance.mjs';
import {
  IN_TREE_RECEIPT_PATH,
  RECEIPT_SCHEMA_VERSION,
  WORKFLOW_PATH,
  githubToken,
  liveCandidate,
  observeRun,
  osFamilyOf,
  readWorkflow,
  receiptProblems,
  requiredJobLegs,
} from './receipt-verify.mjs';
// The shapes every record the gate consumes has to have, stated once, apart
// from the gate. A fact derived by reaching into an unvalidated object is a
// fact about whatever shape that object happened to have — which is how a
// facts map of booleans satisfied a filter looking for `{ value: false }`, and
// how a field named for a display unit passed a regular expression that only
// knew three spellings of one.
import {
  CAPACITY_STAGES,
  capacityEvidenceProblems,
  captureProblems,
  factsProblems,
  instantProblems,
  matrixEntryProblems,
  unitFieldProblems,
  universeReportProblems,
} from './evidence-schema.mjs';
import { UNIVERSE_SCHEMA_VERSION, UNIVERSE_STEP_IDS } from './universe-inventory.mjs';
import { measureProducers } from './producer-closure.mjs';
import { readVersions } from './versions.mjs';
import { VERSION_FLOORS, versionFloorProblems } from './version-floors.mjs';
import { VENDOR_ORACLES, oracleProblems } from '../qualification/oracles.mjs';
import { CAMPAIGN_PATH, readCampaign } from '../qualification/campaign.mjs';
import { measureSubject } from './execution-subject.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(repoRoot, 'dist', 'src');

const args = process.argv.slice(2);
const jsonOnly = args.includes('--json');
const selfTest = args.includes('--self-test');
const preflightMode = args.includes('--preflight');
const checkOnly = args.includes('--check');
let receiptPath = (() => {
  const index = args.indexOf('--receipt');
  if (index !== -1 && index + 1 < args.length) return args[index + 1];
  const fromEnv = process.env.KAURO_RECEIPT_PATH;
  return fromEnv === undefined || fromEnv === '' ? null : fromEnv;
})();

/**
 * The instant freshness is judged against.
 *
 * Passed in so that running the gate twice over unchanged artifacts reaches the
 * same verdict, and so that a replay years later says what it said then. The
 * clock is the default because a gate run by hand should not need a flag, and
 * the value used is reported in the JSON so a reader knows which it was.
 */
const nowInstant = (() => {
  const index = args.indexOf('--now');
  const supplied = index !== -1 && index + 1 < args.length ? args[index + 1] : null;
  if (supplied === null) return `${new Date().toISOString().slice(0, 19)}Z`;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(supplied)) {
    process.stderr.write(`--now ${supplied} is not an ISO-8601 UTC instant to the second\n`);
    process.exit(64);
  }
  return supplied;
})();

/**
 * Whether this file is being run or being read.
 *
 * It used to be only ever run: the module ran the gate and exited at import, so
 * nothing could import a rule and execute it. That is not a detail. The
 * adversarial verifier that refuted the previous revision had to *replicate*
 * every rule `vendorCapture()` applies in order to test it — and a verifier
 * checking its own copy of a rule is checking a copy. The rules are now
 * exported, and the command line only runs when this file is the entry point,
 * exactly as tools/candidate-provenance.mjs and tools/receipt-verify.mjs
 * already do it.
 */
const isEntryPoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint && !existsSync(dist)) {
  process.stderr.write('dist/src does not exist. Run "npm run build" first.\n');
  process.exit(1);
}

const LIMITS = existsSync(dist) ? (await import(new URL('../dist/src/domain/resource-profile.js', import.meta.url).href)).FOUNDING_V1 : null;

const CANDIDATE_MODES = ['HUBSPOT', 'SALESFORCE', 'CLEAN_ONLY'];

/**
 * The limits the sort declares, imported rather than restated.
 *
 * A ratio of scratch bytes to source bytes used to live here as the constant
 * `SCRATCH_AMPLIFICATION_CEILING = 60`. It was declared before the founding runs
 * and, correctly, never raised to meet a result — but it was the wrong shape of
 * threshold, and holding it honestly only made that clearer. The denominator is
 * raw source and the numerator is derived facts, records, lineage, edges and
 * encoded keys, counted cumulatively across run generation and every merge pass,
 * with the pass count growing as the runs grow. One unchanged algorithm measured
 * 52.6x at 2,006 rows and 154-173x at 1,000,000.
 *
 * A threshold a correct algorithm crosses by growing is not measuring what it
 * claims to. The replacement recomputes what the sort must have written from the
 * runs it actually produced, and pins the sort's own parameters against these —
 * so a configuration that writes seven times more than necessary is refused even
 * though its arithmetic is internally perfect.
 */
/**
 * Every spool configuration the engine declares, not just one.
 *
 * This was a list of one, and a list of one is a claim that the engine sorts
 * one way. It does not, and for a stated reason: a verification interleaves
 * several families and holds a run of each, so `src/verify/join.ts` declares
 * smaller runs than the engine uses for its own. A family that ran under that
 * configuration was reported as running under none, which is a true statement
 * about the list and a false one about the engine.
 *
 * They are imported rather than restated, so a configuration that changes in the
 * code changes here, and a family that ran under neither is still refused.
 */
const SPOOL_LIMITS = existsSync(dist)
  ? [
      (await import(new URL('../dist/src/run/spool.js', import.meta.url).href)).DEFAULT_SPOOL_LIMITS,
      (await import(new URL('../dist/src/verify/join.js', import.meta.url).href)).VERIFY_SPOOL_LIMITS,
    ]
  : null;
const { checkScratchRun } = await import(new URL('scratch-model.mjs', import.meta.url).href);

const facts = [];

/**
 * One derived fact.
 *
 * `derivation` is how the value was obtained, and the vocabulary is closed:
 *
 *   EXECUTED           something was run and its behaviour observed
 *   MEASURED           a quantity was read off a process or the operating system
 *   INSTRUMENTED       the code under test reported a count it was made to keep
 *   EVIDENCE_VERIFIED  a recorded measurement was checked against the artifact
 *                      it describes, and against a limit stated in bytes
 *
 * There is deliberately no EVIDENCE_READ. Reading is not a derivation.
 *
 * @param {string} name
 * @param {boolean|string} value
 * @param {'EXECUTED'|'MEASURED'|'INSTRUMENTED'|'EVIDENCE_VERIFIED'} derivation
 * @param {string} detail what was observed, or why the fact is false
 * @param {{schema?: string, digest?: string, source?: string}} [provenance]
 */
function fact(name, value, derivation, detail, provenance = {}) {
  facts.push({
    name,
    value,
    derivation,
    detail,
    schema: provenance.schema ?? null,
    digest: provenance.digest ?? null,
    source: provenance.source ?? null,
  });
  return value;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function digestOfFile(path) {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Runs a command and reports how it went, without letting a crash end the gate. */
function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    // A shell only where one is needed. `npm` on Windows is a shell script and
    // will not spawn without it; `process.execPath` is `C:\Program Files\...`,
    // and handing that to a shell splits it at the space — the drift step
    // reported "'C:\Program' is not recognized" and the gate scored a check
    // that had never run as a failure of the thing it checks.
    shell: process.platform === 'win32' && command !== process.execPath,
    ...options,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// --------------------------------------------------------------------------
// A. the architecture is still closed
// --------------------------------------------------------------------------
//
// Executed, not assumed. MC-1's gate is run as a child and its own conjunction
// read from its JSON — so a regression in the architecture fails this gate too,
// rather than this gate certifying a candidate whose foundation moved.
function architectureClosed() {
  const name = 'architecture_closed';
  const result = run(process.execPath, [join(repoRoot, 'tools', 'architecture-gate.mjs'), '--json']);
  let report = null;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    report = null;
  }
  if (report === null) {
    return fact(name, false, 'EXECUTED', `ARCHITECTURE-01 produced no readable report; exit ${String(result.status)}`);
  }
  // Validated before it is read.
  //
  // This used to name the false facts with
  // `.filter(([, entry]) => entry && entry.value === false)` over
  // `report.facts` — and `report.facts` was `name -> boolean`, so `entry.value`
  // was `undefined` on every entry and the list was always empty. The gate
  // reported "ARCHITECTURE-01 reports FALSE; false facts: none named", which is
  // the least useful sentence a failing gate can produce, and the shape bug was
  // invisible because the happy path never rendered it. The architecture gate
  // now emits `{value, by, observed}` and this refuses anything else rather
  // than reading a shape it was not given.
  const { problems: shape, entries } = factsProblems(report.facts, 'ARCHITECTURE-01');
  if (shape.length > 0) {
    return fact(name, false, 'EXECUTED', `ARCHITECTURE-01's report is not in the facts schema this gate reads: ${shape.join('; ')}`, {
      source: 'tools/architecture-gate.mjs',
      schema: 'ARCHITECTURE-01',
    });
  }
  const closed = report.MIGRATION_CORE_ARCHITECTURE_CLOSED === 'TRUE';
  const falseFacts = entries.filter((entry) => !entry.value && !entry.decidedElsewhere);
  return fact(
    name,
    closed,
    'EXECUTED',
    closed
      ? `ARCHITECTURE-01 ran here and reports closed over ${String(entries.length)} facts`
      : `ARCHITECTURE-01 reports ${String(report.MIGRATION_CORE_ARCHITECTURE_CLOSED)}; false facts: ${
          falseFacts.map((entry) => `${entry.name} (${String(entry.observed ?? 'no detail')})`).join('; ') || 'none — the closure condition is unsatisfied for another reason'
        }`,
    { source: 'tools/architecture-gate.mjs', schema: 'ARCHITECTURE-01' },
  );
}

// --------------------------------------------------------------------------
// B. the final offline universe
// --------------------------------------------------------------------------
//
// One command, run here, exit status believed. The count of what it ran is
// derived from its own report rather than asserted: the roadmap is explicit that
// test counts are read off the candidate and never fixed by a document, so a
// number here would be the wrong kind of claim even when it happened to be right.
/**
 * The universe is read, not re-run here.
 *
 * The first version of this gate ran `npm run universe` as a child, which was
 * the wrong shape twice over. It made the gate take hours, so nobody would run
 * it while working — and a gate that is inconvenient to run is a gate that gets
 * run once, at the end, when it is too late to act on. Worse, the universe
 * includes sabotage, and sabotage rewrites source files in place: running it
 * from inside a gate meant the gate mutated the tree it was judging. It did
 * exactly that here, and an interrupted run left a mutation behind in
 * `src/artifacts/audit.ts` that would have shipped an audit summary reporting
 * "0 rows disappeared" from a count that could not see disappearances.
 *
 * So the universe writes a report and this reads it — and reads the steps, not
 * the verdict. A report whose `passed` is true while a step is false is a report
 * this refuses, and a report that is not bound to this candidate is evidence
 * about some other tree.
 */
function offlineUniverse(reportPathOverride) {
  const name = 'offline_release_universe_passed';
  // The path is a parameter so the self-test can put a synthetic report in
  // front of this function without writing into the tree it is judging. Nothing
  // outside the self-test passes it: `collect()` reads the committed report.
  const reportPath = reportPathOverride ?? join(repoRoot, 'qualification', 'candidate', 'universe.json');
  const report = readJson(reportPath);
  if (report === null) {
    return fact(
      name,
      false,
      'EVIDENCE_VERIFIED',
      `no offline universe report at ${relative(repoRoot, reportPath)}; run "npm run universe" on a clean tree`,
    );
  }
  // Against a normative inventory, not against the report's own list.
  //
  // What stood here was `report.steps.filter(step => step.ok !== true)`: a
  // report with no steps had no failed step, and so did a report missing half
  // of them, a report with one step recorded twice, and a report whose steps
  // were all marked skipped. Each of those is a universe that did not run, and
  // each of them passed. `tools/universe-inventory.mjs` states the eighteen
  // steps, once, and `tools/universe.mjs` asserts at start-up that the steps it
  // is about to run are exactly those — so the two cannot drift apart without
  // one of them saying so.
  const problems = universeReportProblems(report);
  // The binding, in two digests, because one of them used to be a fixed point.
  //
  // `universe.json` lives in the tree and states the digest of the set it is a
  // member of, so writing it changed the digest it had just recorded. There was
  // no ordering that satisfied both this fact and `evidence_bound_to_exact_
  // candidate`: regenerate the manifest first and writing the report broke it;
  // write the report first and the digest it recorded was of a tree without the
  // report in it. Exclusion rule 1.2.0 excludes the file, exactly as it excludes
  // the preflight, which makes the manifest binding satisfiable at all.
  //
  // The code digest is the binding that does not depend on that exclusion being
  // remembered. Nothing under `qualification/` is in the code set, so a report
  // written into `qualification/candidate/` cannot move the digest it records —
  // the same move that broke the evidence binding when stamping evidence changed
  // the manifest the stamp named. Both are required: the manifest digest says
  // which candidate, the code digest says against which engine, and the second
  // one is the one that cannot chase its own tail.
  const { manifest, treeDigest, codeDigest } = candidateManifest();
  if (manifest !== null && report.candidate?.manifestDigest !== manifest.manifestDigest) {
    problems.push(
      `the report is bound to candidate ${String(report.candidate?.manifestDigest).slice(0, 16)} and this tree's manifest is ` +
        `${String(manifest.manifestDigest).slice(0, 16)}${treeDigest === manifest.manifestDigest ? '' : `, which itself disagrees with the tree's ${String(treeDigest).slice(0, 16)}`}`,
    );
  }
  if (codeDigest === null) {
    problems.push("this tree's code digest could not be measured, so nothing says which engine the universe ran against");
  } else if (report.candidate?.codeDigest !== codeDigest) {
    problems.push(
      `the report was produced against code ${String(report.candidate?.codeDigest).slice(0, 16)} and this tree's code is ` +
        `${codeDigest.slice(0, 16)}; tools/universe.mjs must record candidate.codeDigest at the moment it runs`,
    );
  }
  return fact(
    name,
    problems.length === 0,
    'EVIDENCE_VERIFIED',
    problems.length === 0
      ? `${String((report.steps ?? []).length)} checks, every one passed, on ${String(report.platform)} ${String(report.node)}`
      : problems.join('; '),
    { schema: report.schemaVersion ?? null, digest: digestOfFile(reportPath), source: relative(repoRoot, reportPath) },
  );
}

// --------------------------------------------------------------------------
// C. nothing the repository says about itself has drifted from what it is
// --------------------------------------------------------------------------
function documentDrift() {
  const name = 'spec_and_document_drift_absent';
  const checks = [
    { id: 'spec:check', command: ['npm', ['run', '--silent', 'spec:check']] },
    // Before-preflight mode (D76): this fact is part of the preflight, which
    // cannot be required by its own computation. Only the preflight may be
    // absent; the final check is plain `provenance:check`.
    { id: 'provenance:check', command: [process.execPath, [join(repoRoot, 'tools', 'provenance.mjs'), '--check', '--before-preflight']] },
    { id: 'drift', command: [process.execPath, [join(repoRoot, 'tools', 'drift-gate.mjs')]] },
  ];
  const failures = [];
  for (const check of checks) {
    const result = run(check.command[0], check.command[1]);
    if (!result.ok) {
      // Every diagnostic, and the log that holds the rest.
      //
      // This kept the last two lines, capped at two hundred characters. DRIFT-01
      // reports one line per rule it failed, so a run that found five
      // contradictions reported two of them and the operator fixed two and
      // re-ran; and where the failing tool printed a summary last, the two lines
      // kept were the summary and the blank line above it. A gate that truncates
      // its own diagnostics makes the next run necessary rather than the fix.
      const output = `${result.stdout}${result.stderr}`;
      const lines = output.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');
      const logPath = writeDiagnostics(`drift-${check.id.replace(/[^a-z0-9]+/giu, '-')}`, output);
      failures.push(
        `${check.id} (exit ${String(result.status)}, ${String(lines.length)} lines, full output at ${logPath}): ${lines.join(' | ')}`,
      );
    }
  }
  return fact(
    name,
    failures.length === 0,
    'EXECUTED',
    failures.length === 0
      ? 'the generated specification files, the provenance record and the executable constants all agree with the code'
      : failures.join('; '),
  );
}

/**
 * The full output of a failed child, kept where a reader can open it.
 *
 * Outside the tree, because a gate that writes into the tree it is judging
 * changes the candidate while deciding about it. The path is named in the
 * fact's detail, so the detail can carry every diagnostic without carrying
 * every byte.
 */
function writeDiagnostics(name, output) {
  try {
    const dir = join(tmpdir(), 'kauro-release-candidate-diagnostics');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${name}.log`);
    writeFileSync(path, output);
    return path;
  } catch {
    return 'nowhere: the diagnostics could not be written';
  }
}

// --------------------------------------------------------------------------
// D. the vendor research is of this candidate's date, not an older one
// --------------------------------------------------------------------------
/**
 * Three quantities, three checks, and none of them the others.
 *
 * What stood here treated one date as all three. `SOURCE_REGISTRY_VERSION` is
 * the day somebody last read the vendors' documentation; a vendor evidence
 * file's `observedAt` is the moment a runner talked to a live instance; and
 * freshness is a judgement about both, made against a clock. Collapsing them
 * had a concrete consequence the roadmap names: recapturing vendor evidence
 * appeared to require moving a date that lives inside the code digest, so a
 * recapture invalidated the candidate it was taken for.
 *
 * They are separated here:
 *
 *   - the **review date** is the code's and the document's, and they must agree
 *     and must not be in the future. Nothing about a vendor run moves it;
 *   - each **observation** is the runner's, must be a UTC instant, and must not
 *     be in the future — an observation dated after now was not observed;
 *   - **freshness** is campaign membership rather than an age in days. Every
 *     vendor observation belongs to the campaign this candidate was sealed
 *     under, and was made no later than the seal. An age threshold would be a
 *     number nobody could defend; "it was taken for this candidate" is the
 *     thing that actually has to be true.
 *
 * The clock is passed in (`--now`), so re-running the gate over the same
 * artifacts reaches the same verdict.
 */
function sourceRegistryCurrent(now) {
  const name = 'source_registry_current';
  let declared = null;
  try {
    const version = readFileSync(join(repoRoot, 'src', 'version.ts'), 'utf8');
    declared = (version.match(/SOURCE_REGISTRY_VERSION\s*=\s*'([^']+)'/u) ?? [])[1] ?? null;
  } catch {
    declared = null;
  }
  const document = existsSync(join(repoRoot, 'docs', 'SOURCE_REGISTRY.md'))
    ? readFileSync(join(repoRoot, 'docs', 'SOURCE_REGISTRY.md'), 'utf8')
    : '';
  const documented = (document.match(/Registry version:\s*\*\*([0-9]{4}-[0-9]{2}-[0-9]{2})\*\*/u) ?? [])[1] ?? null;

  const problems = [];
  if (declared === null) problems.push('src/version.ts declares no SOURCE_REGISTRY_VERSION');
  if (documented === null) problems.push('docs/SOURCE_REGISTRY.md states no registry version');
  if (declared !== null && documented !== null && declared !== documented) {
    problems.push(`src/version.ts says ${declared} and docs/SOURCE_REGISTRY.md says ${documented}; they move together or not at all`);
  }
  if (declared !== null && declared > now.slice(0, 10)) {
    problems.push(`the registry is dated ${declared}, which is after ${now.slice(0, 10)}; a review has not happened yet`);
  }

  const campaign = readCampaign();
  if (campaign === null) problems.push('no campaign is sealed, so no observation can be shown to belong to this candidate');

  const observations = [];
  for (const file of Object.keys(VENDOR_ORACLE_FILES)) {
    const path = join(repoRoot, 'qualification', 'evidence', file);
    const evidence = readJson(path);
    if (evidence === null) {
      problems.push(`${file} is missing or unreadable, so its observation date cannot be read`);
      continue;
    }
    const observedAt = evidence.observedAt;
    problems.push(...instantProblems(observedAt, { now, label: `${file} observedAt` }));
    if (typeof observedAt !== 'string') continue;
    observations.push({ file, observedAt });
    // Evidence is produced *after* the campaign is sealed. That is the whole
    // order: seal the inputs, then measure against them.
    //
    // This compared the two the other way round and refused evidence observed
    // after the seal — so every correctly ordered campaign failed, and the only
    // way to satisfy it would have been to seal after measuring, which is the
    // stamping defect this design exists to prevent. What is actually wrong is
    // evidence *older* than the seal: a measurement taken before the inputs
    // were fixed was not taken against them.
    if (campaign !== null && observedAt < campaign.sealedAt) {
      problems.push(
        `${file} was observed at ${observedAt}, before the campaign was sealed at ${String(campaign.sealedAt)}; ` +
          'a measurement taken before the inputs were sealed was not taken against them',
      );
    }
    // The registry against a declared window, not against same-day equality.
    //
    // The rule was `observedAt > declared`, which required the registry to have
    // been reviewed on or after the day of the qualification. That makes the
    // review date a ritual: it has to be bumped every time a campaign runs,
    // whether or not anybody looked at a vendor's documentation, and a date
    // that is edited to make a gate pass records nothing.
    //
    // What the rule is for is that a registry which has gone stale should not
    // silently justify fresh evidence. That is a window. Ninety days is the
    // declared one: the vendor facts here are API-level — which fields exist,
    // which are updateable, which enumerations are closed — and both vendors
    // move those on release cycles measured in months, not days.
    if (declared !== null) {
      const reviewed = Date.parse(`${declared}T00:00:00Z`);
      const seen = Date.parse(observedAt);
      const days = Number.isFinite(reviewed) && Number.isFinite(seen) ? (seen - reviewed) / 86_400_000 : null;
      if (days === null) {
        problems.push(`${file} cannot be dated against the registry: observed ${observedAt}, registry reviewed ${declared}`);
      } else if (days < 0) {
        problems.push(
          `${file} observed the vendor on ${observedAt.slice(0, 10)} and the registry claims a review on ${declared}, ` +
            'which is later; a registry cannot have been reviewed after the qualification it justifies',
        );
      } else if (days > REGISTRY_FRESHNESS_DAYS) {
        problems.push(
          `${file} observed the vendor on ${observedAt.slice(0, 10)} and the registry was last reviewed on ${declared}, ` +
            `${String(Math.floor(days))} days earlier; the declared window is ${String(REGISTRY_FRESHNESS_DAYS)} days, after which ` +
            'a registry is not evidence about a vendor as it is now',
        );
      }
    }
  }

  const newest = observations.map((entry) => entry.observedAt).sort().at(-1) ?? null;
  return fact(
    name,
    problems.length === 0,
    'EVIDENCE_VERIFIED',
    problems.length === 0
      ? `registry reviewed ${String(declared)}, ${String(observations.length)} vendor observations, newest ${String(newest)}, ` +
        `every one inside campaign ${String(campaign?.campaignId)} sealed ${String(campaign?.sealedAt)}, judged against ${now}`
      : problems.join('; '),
    { source: 'docs/SOURCE_REGISTRY.md', digest: digestOfFile(join(repoRoot, 'docs', 'SOURCE_REGISTRY.md')) },
  );
}

// --------------------------------------------------------------------------
// E. the two vendors, as they are, against this candidate
// --------------------------------------------------------------------------
//
// What this used to require was that `candidate.codeDigest` was *a string*. It
// never compared it with the code digest of the tree being gated, so evidence
// bound to any code at all — including code from months ago, including a digest
// somebody typed — satisfied it. `evidenceBound()` did compare digests, but only
// for the capacity evidence, so between the two of them nothing in the gate ever
// asked whether the vendor measurements had been taken against this engine. The
// failure the whole front exists to prevent was reachable by doing nothing.
//
// That was the first repair, and it was refuted. The refutation is the reason
// for everything below it, so it is written down before the design.
//
// An adversary replicated every rule the binding check applied and satisfied all
// of them from local data alone: the code digest from `measureTree()`, the core
// and package-format versions from `src/version.ts`, the instance by
// pseudonymising the portal id **already in the evidence file**, the capture
// time by copying the file's own, the corpus by inventing an id and sixty-four
// `f` characters — nothing ever compared it against a corpus that exists — and
// `writtenBy` by naming `qualification/hubspot/README.md`, which passed because
// the rule tested a path prefix and `existsSync`. Result: zero problems, on
// evidence that still records portal 51050101.
//
// So the whole binding was derivable from the tree, and a fact a script can turn
// true by reading the tree is the failure mode this front exists to prevent.
//
// ## What must a vendor evidence file carry that only a real vendor call
// ## could have produced?
//
// Nothing. That is the answer, and pretending otherwise is how the last version
// was built. Any string a vendor returned can be typed into a file afterwards;
// no amount of inspecting the file distinguishes a portal id that was observed
// from one that was invented. A committed artifact cannot be evidence that a
// call happened, for the same reason a committed receipt cannot name its own
// commit.
//
// What follows from that is that the gate has to make the call. So:
//
//   - the INSTANCE is observed here, at gate time, by asking the vendor who the
//     credential authenticates as — `GET /account-info/v3/details` for HubSpot,
//     the client-credentials token response for Salesforce — and pseudonymising
//     what came back. Every evidence file in the gate must name that instance.
//     No portal id is written down here, in either form: the expectation is
//     whatever the live credential answers, so this cannot be satisfied by
//     editing a constant, and it says plainly what it observed when it refuses.
//     Where no credential is present the fact is FALSE and names the variable it
//     needed. It does not fall back to the file; falling back to the file is the
//     forgery.
//
//   - the CORPUS digest must equal the digest of a corpus this repository
//     actually contains, computed with the same serialiser every other digest
//     here uses, over the tracked files under the path the binding names. Sixty
//     four `f` characters no longer passes, and neither does a corpus that was
//     edited after the run.
//
//   - `capturedAt` is required on the EVIDENCE, not merely on the binding. The
//     old rule compared the two only when the evidence carried one, so evidence
//     with no capture time at all — `hs-import.json` — satisfied it with any
//     well-formed instant.
//
//   - `writtenBy` must be a program under the vendor's own qualification
//     directory. See `vendorRunnerProblems`: a README and a directory both used
//     to pass.
//
// The other lock is at the point where `--stamp` writes, and it is now a lock
// rather than a comment: it resolves every path it is about to write and refuses
// anything under the vendor evidence or vendor runner directories. The previous
// spelling of it — `if (dir.startsWith('qualification/evidence'))` two lines
// under `const STAMPABLE = ['qualification/capacity']` — could never fire, and
// was counted in the summary as one of two independent locks. It was one lock
// and a dead branch.
const VENDOR_EVIDENCE_ROOT = join(repoRoot, 'qualification', 'evidence');
/**
 * How long a source-registry review stays current, in days.
 *
 * Declared rather than derived, for the reason `MINIMUM_OS_FAMILIES` is: a
 * window computed from the registry's own dates would be a window the registry
 * could widen by going stale.
 */
const REGISTRY_FRESHNESS_DAYS = 90;

const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const VENDOR_PROBE_TIMEOUT_MS = 30_000;

/** The five vendor evidence files, and the gate each belongs to. Read from the oracles, never listed twice. */
const VENDOR_ORACLE_FILES = {
  'hs-target-contract.json': 'hubspot',
  'hs-import.json': 'hubspot',
  'sf-target-contract.json': 'salesforce',
  'sf-dataloader.json': 'salesforce',
  'sf-ocr.json': 'salesforce',
};

/**
 * The vendors, and how each one is asked who the credential authenticates as.
 *
 * Read-only, and the response is reduced to a pseudonym before it is anywhere a
 * reader could see it. A portal id is somebody's account and this gate's output
 * is a public artifact; the raw identifier is never returned, never logged and
 * never written to the report.
 */
const VENDOR_PROBES = {
  hubspot: {
    label: 'HubSpot',
    credentials: ['HUBSPOT_TOKEN'],
    async observe(env) {
      const response = await fetch('https://api.hubapi.com/account-info/v3/details', {
        headers: { authorization: `Bearer ${env.HUBSPOT_TOKEN}`, accept: 'application/json' },
        signal: AbortSignal.timeout(VENDOR_PROBE_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`GET /account-info/v3/details returned ${String(response.status)} ${response.statusText}`);
      const body = await response.json();
      if (body.portalId === undefined || body.portalId === null) throw new Error('the account details carried no portalId');
      return { raw: String(body.portalId), note: `accountType ${String(body.accountType ?? 'not stated')}` };
    },
  },
  salesforce: {
    label: 'Salesforce',
    credentials: ['SF_CLIENT_ID', 'SF_CLIENT_SECRET', 'SF_LOGIN_URL'],
    async observe(env) {
      // The client-credentials grant, which is what the qualification credential
      // is. The response's `id` is the identity URL and carries the org id; the
      // access token is used for nothing here and is never recorded.
      const response = await fetch(`${env.SF_LOGIN_URL.replace(/\/+$/u, '')}/services/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.SF_CLIENT_ID, client_secret: env.SF_CLIENT_SECRET }),
        signal: AbortSignal.timeout(VENDOR_PROBE_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`POST /services/oauth2/token returned ${String(response.status)} ${response.statusText}`);
      const body = await response.json();
      const orgId = (String(body.id ?? '').match(/\/id\/([A-Za-z0-9]{15,18})\//u) ?? [])[1] ?? null;
      if (orgId === null) throw new Error('the token response carried no identity URL naming an organisation');
      return { raw: orgId, note: 'client credentials grant' };
    },
  },
};

/**
 * Who the vendor says this credential is, right now.
 *
 * @returns {Promise<{instance: string|null, note: string|null, problems: string[]}>}
 */
async function observeVendor(key) {
  const probe = VENDOR_PROBES[key];
  const missing = probe.credentials.filter((name) => process.env[name] === undefined || process.env[name] === '');
  if (missing.length > 0) {
    return {
      instance: null,
      note: null,
      problems: [
        `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set, so nothing asked ${probe.label} which instance this ` +
          'candidate was qualified against. The binding in a committed file is not an answer to that question: every field of it is ' +
          'derivable from the tree, which is how this fact was made TRUE on evidence about the wrong portal.',
      ],
    };
  }
  try {
    const observed = await probe.observe(process.env);
    return { instance: pseudonymousInstance(observed.raw), note: observed.note, problems: [] };
  } catch (error) {
    return {
      instance: null,
      note: null,
      problems: [`${probe.label} could not be asked which instance this credential authenticates to: ${String(error && error.message ? error.message : error)}`],
    };
  }
}

/**
 * The digest of a corpus the repository actually contains.
 *
 * Computed with the one serialiser every other digest here uses, over the
 * tracked records under the named path — so a corpus digest is a statement about
 * bytes in this tree rather than sixty-four characters somebody chose. The
 * records come from the manifest verification's own walk rather than a second
 * one, because two walks are two chances to disagree about what is tracked.
 *
 * @returns {{digest: string|null, files: number, problem: string|null}}
 */
function corpusDigest(id, records) {
  if (records === null) return { digest: null, files: 0, problem: 'the tracked set could not be measured, so no corpus digest can be computed' };
  if (typeof id !== 'string' || id === '' || id.includes('\\') || id.startsWith('/') || id.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    return { digest: null, files: 0, problem: `names corpus ${String(id)}, which is not a repository path to hash` };
  }
  const members = records.filter((entry) => entry.path === id || entry.path.startsWith(`${id}/`));
  if (members.length === 0) {
    return {
      digest: null,
      files: 0,
      problem: `names corpus ${id}, and no tracked file in this tree is under that path. A corpus digest that names nothing is a number.`,
    };
  }
  return { digest: digestRecords('manifest', members), files: members.length, problem: null };
}

/**
 * What a vendor runner must have recorded, checked field by field.
 *
 * ---- the refutation this shape exists under ----
 *
 * The previous binding was derivable from the tree. An adversary satisfied every
 * rule it applied without talking to a vendor: the code digest from
 * `measureTree()`, the versions from `src/version.ts`, the instance by
 * pseudonymising the portal id already in the evidence file, the capture time by
 * copying the file's own, the corpus by inventing an id and sixty-four `f`
 * characters, and `writtenBy` by naming a README. Zero problems, on evidence
 * about the wrong portal.
 *
 * Two things follow, and both are here. The instance is observed by this gate,
 * live, and the file must name what the vendor answered — that is the one
 * comparison a script reading the repository cannot satisfy. And what the
 * measurement was taken against is the **execution subject**, captured by the
 * producer at the start of its run and re-checked at the end: the runtime, the
 * harness, the oracle, the corpora, the contracts, the dependency closure and
 * the declared versions. The old code digest covered `src`, `tools`, `spec` and
 * the lockfile, so a runner could change what it expected — its own
 * `EXPECTED_TRUTH.md`, its own corpus — and the binding would not move.
 *
 * @param {string} file the evidence file's name, for the message
 * @param {object} evidence the parsed evidence
 * @param {{campaign: object|null, subjectDigest: string|null, now: string}} context
 * @returns {{problems: string[], instance: string|null, campaignId: string|null}}
 */
function vendorCapture(file, evidence, context) {
  const problems = [];

  // The capture: what this measurement is about, taken by the thing that took
  // the measurement.
  problems.push(
    ...captureProblems(evidence.capture, {
      campaignId: context.campaign?.campaignId ?? null,
      producerFingerprints: context.producerFingerprints,
      now: context.now,
      label: file,
    }),
  );
  const producer = evidence.capture?.producer;
  problems.push(...vendorRunnerProblems(producer).map((problem) => `${file} ${problem}`));
  if (typeof producer === 'string' && producer.startsWith('tools/')) {
    problems.push(
      `${file} was produced by ${producer}. Vendor evidence is taken by the runner that talked to the portal or the org, at the ` +
        'moment it took the measurement. A generic tool writing it later would only be recording that the tool ran.',
    );
  }

  // The stamped block MC-2 used. Its presence now is the defect, not the
  // binding: `--stamp` is gone, and a file still carrying what it wrote is a
  // file that was not re-produced.
  if (evidence.candidate !== undefined) {
    problems.push(
      `${file} carries a candidate block written by ${String(evidence.candidate.writtenBy)}. That was a stamp, and a stamp is not a ` +
        'measurement: re-run the producer.',
    );
  }

  // When the vendor was looked at, on the evidence itself.
  problems.push(...instantProblems(evidence.observedAt, { now: context.now, label: `${file} observedAt` }));

  // Which instance answered, as the runner observed it before it wrote anything.
  const observed = evidence.observedInstance ?? null;
  let instance = null;
  if (observed === null || typeof observed !== 'object') {
    problems.push(
      `${file} records no observedInstance. A qualification establishes which account it touched by asking the account, before it ` +
        'writes; a portal id typed into a file afterwards is indistinguishable from one that was invented.',
    );
  } else {
    if (typeof observed.instanceId !== 'string' || observed.instanceId.trim() === '') {
      problems.push(`${file} observed instance ${String(observed.instanceId)}, which is not an identifier`);
    } else {
      instance = pseudonymousInstance(observed.instanceId);
      if (observed.instancePseudonym !== instance) {
        problems.push(`${file} records pseudonym ${String(observed.instancePseudonym)} for an identifier that pseudonymises to ${instance}`);
      }
    }
    if (typeof observed.observedBy !== 'string' || observed.observedBy === '') {
      problems.push(`${file} does not say which call established the instance it names`);
    }
  }

  // The typed results, against the oracle that declares what this gate asks.
  const oracle = VENDOR_ORACLES[file];
  const cases = oracle === undefined ? null : evidence[oracle.casesField];
  problems.push(...oracleProblems(file, Array.isArray(cases) ? cases : []));
  if (Array.isArray(cases)) {
    for (const entry of cases) {
      if (entry === null || typeof entry !== 'object') continue;
      if (typeof entry.ok !== 'boolean') problems.push(`${file} case ${String(entry.id)} has no boolean ok`);
      // A typed pair, not prose. `SF-OCR-01` shipped a case whose `ok` was true
      // and whose English detail said the opposite, and the only check that
      // could have caught it was a regular expression over that English — which
      // is a check on the wording rather than on the result.
      if (!('expected' in entry)) problems.push(`${file} case ${String(entry.id)} records no expected value`);
      if (!('observed' in entry)) problems.push(`${file} case ${String(entry.id)} records no observed value`);
      if (entry.ok === true && 'expected' in entry && 'observed' in entry) {
        const expected = JSON.stringify(entry.expected);
        const seen = JSON.stringify(entry.observed);
        if (expected !== seen) {
          problems.push(`${file} case ${String(entry.id)} reports ok while its expected ${expected} and observed ${seen} differ`);
        }
      }
    }
    const failed = cases.filter((entry) => entry !== null && typeof entry === 'object' && entry.ok === false).map((entry) => String(entry.id));
    const declared = Array.isArray(evidence.failures) ? evidence.failures : null;
    if (declared === null) problems.push(`${file} carries no failures array`);
    else if (declared.length !== failed.length) {
      problems.push(`${file} declares ${String(declared.length)} failures and ${String(failed.length)} of its cases are not ok: ${failed.join(', ')}`);
    }
    const expectedResult = failed.length === 0 ? 'PASS' : 'FAIL';
    if (evidence.result !== expectedResult) {
      problems.push(`${file} records result ${String(evidence.result)} and its cases say ${expectedResult}`);
    }
  }

  return { problems, instance, campaignId: evidence.capture?.campaignId ?? null };
}

function vendorGate(name, files, label, observed, context) {
  // Where the evidence is read from. A parameter, so the self-test can build a
  // complete well-formed set outside the tree and break one thing in it — the
  // previous self-test mutated the committed files and put them back, and a
  // harness that edits the repository to test itself has left a mutation behind
  // here twice.
  const evidenceRoot = context.evidenceRoot ?? VENDOR_EVIDENCE_ROOT;
  const missing = files.filter((file) => !existsSync(join(evidenceRoot, file)));
  if (missing.length > 0) {
    return fact(name, false, 'EVIDENCE_VERIFIED', `no evidence at ${missing.join(', ')}`);
  }
  const problems = [];
  if (context.campaign === null) {
    problems.push(
      'no campaign is sealed, so nothing groups these measurements or says which subject they were taken against. ' +
        'Seal one with "node tools/seal-campaign.mjs" before producing evidence.',
    );
  }
  if (context.subjectDigest === null) {
    problems.push("this tree's execution subject could not be measured, so no capture can be compared against it");
  }
  problems.push(...observed.problems);
  const digests = [];
  const instances = new Map();
  const campaigns = new Set();
  for (const file of files) {
    const path = join(evidenceRoot, file);
    const evidence = readJson(path);
    digests.push(`${file}=${String(digestOfFile(path)).slice(0, 12)}`);
    if (evidence === null) {
      problems.push(`${file} is not readable JSON`);
      continue;
    }
    const checked = vendorCapture(file, evidence, context);
    problems.push(...checked.problems);
    if (checked.instance !== null) instances.set(file, checked.instance);
    if (checked.campaignId !== null) campaigns.add(checked.campaignId);
  }

  // The instance, against the vendor rather than against the tree.
  //
  // This is the one comparison a script reading the repository cannot satisfy,
  // and it is the reason the fact can be believed at all. `observed.instance` is
  // the pseudonym of whoever the live credential authenticates as; every file
  // has to be about that instance.
  if (observed.instance === null) {
    if (observed.problems.length === 0) {
      problems.push('the vendor observation names no instance and reports no problem, so nothing was actually asked of the vendor');
    }
  } else {
    for (const [file, instance] of instances) {
      if (instance !== observed.instance) {
        problems.push(
          `${file} is evidence about instance ${instance} and the credential in this environment authenticates to ${observed.instance}. ` +
            'A contract captured from one instance cannot authorise a run against another, so this is not qualification of either.',
        );
      }
    }
    if (instances.size !== files.length) {
      problems.push(
        `${String(instances.size)} of ${String(files.length)} files name an instance, so at least one is not tied to the instance the ` +
          'credential opens',
      );
    }
  }

  // One gate, one instance, one campaign. A TargetContract is the authority for
  // one exact instance, and evidence that mixes two instances is qualification
  // of neither; evidence that mixes two campaigns was taken against two
  // different subjects, whatever each file says about itself.
  const distinctInstances = new Set(instances.values());
  if (distinctInstances.size > 1) {
    problems.push(
      `${label} mixes instances: ${[...instances].map(([file, instance]) => `${file} is about ${instance}`).join(', ')}. ` +
        'A contract captured from one instance cannot authorise a run against another.',
    );
  }
  if (campaigns.size > 1) {
    problems.push(`${label} mixes campaigns: ${[...campaigns].join(', ')}`);
  }

  const instance = distinctInstances.size === 1 ? [...distinctInstances][0] : null;
  return fact(
    name,
    problems.length === 0,
    'EVIDENCE_VERIFIED',
    problems.length === 0
      ? `${label} against instance ${String(instance)}, which is the instance the live credential authenticates to ` +
        `(${String(observed.note)}); every case the oracle declares was asked and answered, every file captured the subject ` +
        `${String(context.subjectDigest).slice(0, 16)} at start and at end, in campaign ${[...campaigns][0] ?? 'none'}`
      : problems.join('; '),
    { source: files.join(','), digest: digests.join(' ') },
  );
}

// --------------------------------------------------------------------------
// F. attestation is required by default in the CRM modes
// --------------------------------------------------------------------------
//
// Executed against the code, not read from the schema. The question is what a
// run actually does when nobody says anything, and the only way to answer that
// is to start one and watch it refuse.
async function attestationDefault() {
  const name = 'crm_attestation_required_by_default';
  try {
    const { attestationPolicyFor, runMigration } = await import(new URL('../dist/src/run/run-migration.js', import.meta.url).href);
    const { loadConfig } = await import(new URL('../dist/src/mapping/load-config.js', import.meta.url).href);
    const observed = {};
    for (const mode of CANDIDATE_MODES) observed[mode] = attestationPolicyFor(mode);
    const derived =
      observed.HUBSPOT === 'REQUIRED' && observed.SALESFORCE === 'REQUIRED' && observed.CLEAN_ONLY === 'NOT_APPLICABLE';

    /**
     * Configuration may not widen, and the refusal comes before the source.
     *
     * Both halves are proved by one run, and the trick is the input directory:
     * it does not exist. If the run reached the bundle it would fail on the
     * missing directory, so a refusal that names the attestation policy instead
     * is a refusal that happened before a byte of source was interpreted. That
     * is the ordering the seam is for — a run must not read somebody's data and
     * then discover it had no business doing so.
     */
    const configPath = join(repoRoot, 'test', 'fixtures', 'acceptance', 'D-hubspot', 'config.json');
    const loaded = loadConfig(readFileSync(configPath, 'utf8'), configPath);
    let refusal = null;
    try {
      runMigration({
        inputRoot: join(repoRoot, 'tmp', 'release-candidate', 'no-such-bundle'),
        config: loaded.config,
        configHash: loaded.configHash,
        scratch: null,
        attestationPolicy: 'NOT_REQUIRED',
      });
    } catch (error) {
      refusal = error;
    }
    const code = refusal?.code ?? refusal?.reasonCode ?? null;
    const message = String(refusal?.message ?? '');
    const wideningRefused = refusal !== null && code === 'CONFIG_INVALID' && /attestation policy/iu.test(message);

    return fact(
      name,
      derived && wideningRefused,
      'EXECUTED',
      derived && wideningRefused
        ? 'HUBSPOT and SALESFORCE derive REQUIRED with nothing configured and CLEAN_ONLY derives NOT_APPLICABLE; ' +
            'a HUBSPOT run configured NOT_REQUIRED was refused as CONFIG_INVALID, and it was refused while pointed at a bundle ' +
            'that does not exist — so the refusal preceded reading the source rather than following it'
        : `derived ${JSON.stringify(observed)}; the widening run ${refusal === null ? 'was accepted' : `failed with ${String(code)}: ${message.slice(0, 160)}`}`,
    );
  } catch (error) {
    return fact(name, false, 'EXECUTED', `the policy could not be resolved: ${String(error && error.message ? error.message : error)}`);
  }
}

// --------------------------------------------------------------------------
// G. a million rows, in each mode, inside the founding budgets
// --------------------------------------------------------------------------
const capacityRoot = join(repoRoot, 'qualification', 'capacity');

function foundingEvidence() {
  const byMode = new Map();
  if (!existsSync(capacityRoot)) return byMode;
  for (const entry of readdirSync(capacityRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const path = join(capacityRoot, entry.name);
    const evidence = readJson(path);
    if (evidence === null || typeof evidence.mode !== 'string' || evidence.result === undefined) continue;
    byMode.set(evidence.mode, { ...evidence, path, digest: digestOfFile(path) });
  }
  return byMode;
}

/**
 * The founding evidence, read once per collection rather than once per process.
 *
 * It was a `const` computed at module load, which was fine while the gate ran
 * exactly once and then exited. The self-test has to mutate a byte of evidence
 * and watch a fact move, so the read has to be repeatable — and the manifest
 * memo has to be dropped with it, or the second run would answer from the first
 * run's hashes and the self-test would prove nothing.
 */
let founding = foundingEvidence();

function refresh() {
  founding = foundingEvidence();
  manifestCache = null;
}

function capacityFor(mode, context) {
  const name = `capacity_${mode.toLowerCase()}_1m_representative`;
  // The record is a parameter for the same reason the evidence root is: the
  // self-test proves the unit rule and the schema fire without editing a
  // committed measurement.
  const evidence = context.capacityOverride?.[mode] ?? founding.get(mode);
  if (evidence === undefined) {
    return fact(name, false, 'EVIDENCE_VERIFIED', `no founding evidence for ${mode} under qualification/capacity`);
  }
  // The whole record against its schema, before any value is read out of it.
  //
  // The unit rule used to be a regular expression over the top level of
  // `measured`: `/(^|[^a-z])(mb|mib|gb|gib|kb|kib)$/i`. It knew six spellings,
  // looked one level deep, and matched on the end of a key — so `peakMB`
  // survived it, so did `peak_mib`, and so did every nested block. What a
  // capacity record must never do is let a mebibyte be compared against a byte
  // budget, and a name is the only thing that says which a number is, so the
  // check is now over every key at every depth and over both spellings of every
  // unit. The rest of the schema is here for the same reason: this fact reads a
  // dozen numbers out of the record and each of them used to be read without
  // anything having said the record had them.
  const label = evidence.path === undefined ? `the ${mode} capacity record` : relative(repoRoot, evidence.path);
  const problems = capacityEvidenceProblems(evidence, {
    schemaVersion: context.versions.capacityEvidenceSchemaVersion,
    now: context.now,
    label,
  });
  problems.push(
    ...captureProblems(evidence.capture, {
      campaignId: context.campaign?.campaignId ?? null,
      producerFingerprints: context.producerFingerprints,
      now: context.now,
      label,
    }),
  );
  if (!(Number(evidence.sourceRows) >= 1_000_000)) problems.push(`${String(evidence.sourceRows)} source rows, which is under a million`);
  const measured = evidence.measured ?? {};
  const reconciliation = evidence.reconciliation ?? {};
  if (Number(reconciliation.rowsIngested) !== Number(evidence.sourceRows)) {
    problems.push(`ingested ${String(reconciliation.rowsIngested)} of ${String(evidence.sourceRows)}`);
  }
  return fact(
    name,
    problems.length === 0,
    'EVIDENCE_VERIFIED',
    problems.length === 0
      ? `${String(evidence.sourceRows)} source rows through ${String(evidence.profile)}, ` +
          `peak RSS ${String(measured.peakRssBytes)} bytes, peak scratch ${String(measured.peakScratchBytes)} bytes, ` +
          `${String(measured.wallClockMs)} ms, package ${String(measured.packageBytes)} bytes`
      : problems.join('; '),
    { schema: evidence.evidenceSchemaVersion ?? null, digest: evidence.digest ?? null, source: label },
  );
}

async function profileMatrixComplete(context) {
  const name = 'capacity_profiles_matrix_complete';
  const manifest = readJson(join(capacityRoot, 'profiles.json'));
  if (manifest === null) return fact(name, false, 'EVIDENCE_VERIFIED', 'qualification/capacity/profiles.json is not readable');
  const declaredProfiles = (manifest.profiles ?? []).filter((profile) => /^P\d+$/u.test(String(profile.id)));
  const declared = declaredProfiles.map((profile) => profile.id);
  const matrix = context.matrixOverride ?? readJson(join(capacityRoot, 'matrix.json'));
  if (matrix === null) {
    return fact(name, false, 'EVIDENCE_VERIFIED', 'no qualification/capacity/matrix.json; the complementary profiles have not been run at their declared scale');
  }
  const ran = new Map((matrix.results ?? []).map((entry) => [entry.profile, entry]));
  const problems = [];
  problems.push(...unitFieldProblems(matrix, 'matrix.json'));
  problems.push(
    ...captureProblems(matrix.capture, {
      campaignId: context.campaign?.campaignId ?? null,
      producerFingerprints: context.producerFingerprints,
      now: context.now,
      label: 'qualification/capacity/matrix.json',
    }),
  );
  if (matrix.evidenceSchemaVersion !== context.versions.capacityEvidenceSchemaVersion) {
    problems.push(
      `matrix.json is evidence schema ${String(matrix.evidenceSchemaVersion)} and the tree declares ${context.versions.capacityEvidenceSchemaVersion}`,
    );
  }
  if (matrix.candidate !== undefined) {
    problems.push(`matrix.json carries a candidate block written by ${String(matrix.candidate.writtenBy)}; that was a stamp, not a measurement`);
  }

  /**
   * At the founding rung, not at whatever rung was convenient.
   *
   * Each profile is sized as a share of the rung by its own `rowFactor`, so
   * "every profile ran at its declared scale" is true of a matrix taken at four
   * hundred rows as well as one taken at a million — the declared scale scales
   * with the rung, and comparing `sourceRows` against `declaredRows` cannot tell
   * the two apart. That comparison checks the generator agreed with its own
   * parameters; it says nothing about capacity.
   *
   * The matrix exists to exercise each dimension at founding scale, so the rung
   * is checked directly. P2 at rowFactor 0.1 still yields a hundred thousand
   * very wide rows and that is its declared scale — what is refused is a matrix
   * whose rung was lowered, not a profile whose share is small.
   */
  const FOUNDING_RUNG = 1_000_000;
  const rungs = (matrix.rungs ?? []).map((rung) => Number(rung));
  if (!rungs.some((rung) => rung >= FOUNDING_RUNG)) {
    problems.push(
      `the matrix was taken at ${rungs.length === 0 ? 'no stated rung' : rungs.join(', ')}, and a candidate's ` +
        `complementary profiles are exercised at the founding rung of ${String(FOUNDING_RUNG)}`,
    );
  }
  // The expected scale, computed here from the declared profile.
  //
  // What stood here was `entry.sourceRows >= (entry.declaredRows ?? entry.sourceRows)`.
  // Where the record carried no `declaredRows` — which is every record it was
  // ever run against — the comparison became `x >= x`, true for any number,
  // and the fact said "each run at its declared scale" on the strength of it.
  // A profile's scale is a function of the rung and its own parameters, so it
  // is recomputed from `profiles.json` by the same `planOf` the generator uses
  // and compared with what the run produced.
  const rung = (matrix.rungs ?? []).map((entry) => Number(entry)).filter((value) => Number.isFinite(value)).sort((a, b) => b - a)[0] ?? null;
  let planOf = null;
  try {
    ({ planOf } = await import(new URL('capacity-profiles.mjs', import.meta.url).href));
  } catch (error) {
    problems.push(`the capacity profile generator could not be loaded, so no declared scale can be computed: ${String(error && error.message ? error.message : error)}`);
  }
  for (const profile of declaredProfiles) {
    const id = String(profile.id);
    let planned = null;
    if (planOf !== null && rung !== null) {
      try {
        planned = planOf(profile, rung);
      } catch (error) {
        problems.push(`${id}: its declared parameters do not yield a plan at rung ${String(rung)}: ${String(error && error.message ? error.message : error)}`);
      }
    }
    problems.push(...matrixEntryProblems({ profileId: id, planned, produced: ran.get(id), rung: rung ?? 0 }));
  }
  for (const id of ran.keys()) {
    if (!declared.includes(String(id))) problems.push(`matrix.json records ${String(id)}, which profiles.json does not declare`);
  }
  return fact(
    name,
    problems.length === 0 && declared.length > 0,
    'EVIDENCE_VERIFIED',
    problems.length === 0 && declared.length > 0
      ? `${String(declared.length)} complementary profiles, each run at its declared scale and reconciled against its parameters`
      : `${problems.join('; ') || `${String(declared.length)} profiles declared, expected at least one`}`,
    { schema: matrix?.evidenceSchemaVersion ?? null, digest: digestOfFile(join(capacityRoot, 'matrix.json')), source: 'qualification/capacity/matrix.json' },
  );
}

/** One budget, across every founding mode, compared in bytes. */
function budgetFact(name, pick, limit, limitName) {
  if (founding.size === 0) return fact(name, false, 'EVIDENCE_VERIFIED', 'there is no founding evidence to check a budget against');
  const problems = [];
  const readings = [];
  for (const mode of CANDIDATE_MODES) {
    const evidence = founding.get(mode);
    if (evidence === undefined) {
      problems.push(`${mode} has no evidence`);
      continue;
    }
    const value = Number(pick(evidence.measured ?? {}));
    if (!Number.isFinite(value)) {
      problems.push(`${mode} does not record the quantity`);
      continue;
    }
    readings.push(`${mode} ${String(value)}`);
    if (value > limit) problems.push(`${mode} reached ${String(value)} against ${limitName} ${String(limit)}`);
  }
  return fact(
    name,
    problems.length === 0,
    'MEASURED',
    problems.length === 0 ? `${readings.join(', ')} — all inside ${limitName} ${String(limit)}` : problems.join('; '),
  );
}

/**
 * What the sort must have written, recomputed — not a ratio against the source.
 *
 * This was `scratch_amplification_explained`, and it failed a candidate whose
 * cumulative scratch bytes exceeded sixty times its raw source bytes. That
 * threshold came from nowhere canonical, and it cannot bound what it was asked
 * to bound. The denominator is raw source; the numerator is derived facts,
 * records, lineage, edges and encoded index keys. `bytesWritten` is cumulative
 * and counts run generation plus every merge pass, and the number of passes
 * grows with the number of runs. One unchanged algorithm measured 52.6x at
 * 2,006 rows and 154-173x at 1,000,000 — no change in complexity, no wasted
 * scratch, a ratio that nearly trebled. A threshold a correct algorithm crosses
 * by growing is not a threshold; it is a size limit wearing a proportionality
 * argument's clothes.
 *
 * What replaces it is the arithmetic of the sort itself. `tools/scratch-model.mjs`
 * replays the merge tree over the run sizes the sort actually produced and
 * states the traffic as an equality, and it pins the sort's own parameters
 * against the limits the engine declares — so a sort configured to write seven
 * times more than it must is refused even though it agrees with itself
 * perfectly.
 *
 * Three facts come out of it, and the conjunction of the three across every mode
 * is what this reports.
 */
function amplificationExplained() {
  const name = 'scratch_amplification_explained';
  if (founding.size === 0) return fact(name, false, 'INSTRUMENTED', 'there is no founding evidence to read an amplification from');
  const problems = [];
  const readings = [];
  for (const mode of CANDIDATE_MODES) {
    const evidence = founding.get(mode);
    if (evidence === undefined) {
      // `problems.push()` — with nothing in it. A mode with no evidence added
      // an `undefined` to the array, the array's length went up by one, and the
      // fact went FALSE with a detail that named nothing: the operator was told
      // scratch amplification was unexplained and given no mode to look at. A
      // missing mode is a real problem and it says which mode it is.
      problems.push(`${mode} has no founding evidence, so nothing says what its sort wrote`);
      continue;
    }
    const measured = evidence.measured ?? {};
    const outcome = checkScratchRun({
      usage: {
        bytesWritten: measured.scratchBytesWritten,
        peakBytes: measured.scratchPeakLiveBytes ?? measured.peakScratchBytes,
        bytes: measured.scratchLiveBytes ?? 0,
        quotaBytes: measured.scratchQuotaBytes,
        framingBytesPerLine: measured.scratchFramingBytesPerLine,
        byFamily: evidence.scratchFamilies ?? evidence.scratchByFamily ?? null,
      },
      // Both imported, never restated here. A budget or a spool limit that is
      // true in two files is one that will one day be true in one.
      quotaBytes: LIMITS.scratchBudgetBytes,
      spoolLimits: SPOOL_LIMITS,
      devicePeakBytes: measured.peakScratchBytes,
    });
    for (const entry of outcome.facts) {
      if (entry.value !== true) problems.push(`${mode} ${entry.name}: ${entry.detail}`);
    }
    if (outcome.facts.every((entry) => entry.value === true)) {
      readings.push(
        `${mode} wrote ${String(outcome.actualBytes)} bytes against ${String(outcome.expectedBytes)} the sort owes, over ${String(outcome.families.length)} families`,
      );
    }
  }
  return fact(
    name,
    problems.length === 0,
    'INSTRUMENTED',
    problems.length === 0
      ? `${readings.join('; ')} — every family's traffic is what replaying its merge tree says the sort must have written`
      : problems.join('; '),
  );
}

// --------------------------------------------------------------------------
// H. the same inputs produce the same bytes, and the bytes were verified
// --------------------------------------------------------------------------
function deterministicBytes() {
  const name = 'candidate_bytes_deterministic';
  const problems = [];
  const readings = [];
  for (const mode of CANDIDATE_MODES) {
    const evidence = founding.get(mode);
    if (evidence === undefined) {
      problems.push(`${mode} has no evidence`);
      continue;
    }
    const reproductions = evidence.reproductions ?? [];
    if (reproductions.length < 2) {
      problems.push(`${mode} records ${String(reproductions.length)} reproductions; two independent ones are required`);
      continue;
    }
    const digests = new Set(reproductions.map((entry) => String(entry.packageDigest)));
    if (digests.size !== 1 || digests.has('undefined') || digests.has('null')) {
      problems.push(`${mode} produced ${String(digests.size)} distinct package digests across reproductions`);
      continue;
    }
    readings.push(`${mode} ${[...digests][0].slice(0, 12)}`);
  }
  return fact(
    name,
    problems.length === 0,
    'MEASURED',
    problems.length === 0
      ? `two independent reproductions per mode, byte-identical: ${readings.join(', ')}`
      : problems.join('; '),
  );
}

function verifyAndAttest() {
  const name = 'package_verify_and_attest_passed';
  const problems = [];
  for (const mode of CANDIDATE_MODES) {
    const evidence = founding.get(mode);
    if (evidence === undefined) {
      problems.push(`${mode} has no evidence`);
      continue;
    }
    const verification = evidence.verification ?? {};
    if (verification.ok !== true) problems.push(`${mode} verification ${String(verification.ok)}`);
    if (!(Number(verification.checksRun) > 0)) problems.push(`${mode} ran no verifier checks`);
    if (Number(verification.problems ?? 1) !== 0) problems.push(`${mode} verification reported ${String(verification.problems)} problems`);
    if (verification.attestationOk !== true) problems.push(`${mode} was not strongly attested`);
  }
  return fact(
    name,
    problems.length === 0,
    'EVIDENCE_VERIFIED',
    problems.length === 0 ? 'every founding package verified from disk and was attested against its source' : problems.join('; '),
  );
}

// --------------------------------------------------------------------------
// I. the evidence belongs to this candidate
// --------------------------------------------------------------------------
//
// The answer to a problem that has no one-layer answer: a file inside a tree
// cannot name the hash of the tree that contains it, because writing the name
// changes the tree. So the committed layer hashes a closed, explicitly versioned
// set of files; a committed preflight records that every fact obtainable from
// inside the tree is true; and a receipt, written by CI outside the tree, ties
// the commit and its git tree to that digest without touching what was measured.
const manifestPath = join(repoRoot, 'qualification', 'candidate', 'manifest.json');

/**
 * The manifest, verified against the tree by the producer's own serialiser.
 *
 * This function used to build the digest a second time, here, and the second
 * time was not the first. `tools/candidate-provenance.mjs` joined a record's
 * fields with a space; this joined them with a NUL. The committed manifest
 * therefore recomputed to a different value in the gate than the producer had
 * written, every time, and the only reason that did not read as a permanent
 * failure is that the same function then compared its own arithmetic against
 * itself in several places. One definition written twice is one definition and
 * one guess, and the guess decided whether the gate passed.
 *
 * There is now one serialiser, versioned, pinned against a golden vector, and
 * this is a caller of it. See `serialiseDigestRecords` for the format and
 * `SERIALISATION_GOLDEN` for the bytes that hold it still.
 *
 * Memoised per collection, because it hashes every tracked file; cleared by
 * `refresh()` so the self-test can mutate a byte and watch the verdict move.
 */
let manifestCache = null;

function candidateManifest() {
  if (manifestCache !== null) return manifestCache;
  const manifest = readJson(manifestPath);
  if (manifest === null) {
    manifestCache = {
      manifest: null,
      storedTableDigest: null,
      treeDigest: null,
      codeDigest: null,
      problems: ['there is no qualification/candidate/manifest.json'],
    };
    return manifestCache;
  }
  manifestCache = verifyManifest(manifest);
  return manifestCache;
}

/**
 * Every measurement of this candidate belongs to one campaign, over one subject.
 *
 * This used to compare one field — `evidence.candidate.codeDigest` — against
 * the manifest's, for the three capacity files only. Two things were wrong with
 * that beyond its narrowness. The digest it compared was written by a stamping
 * tool rather than by the producer, so it recorded which code was in the tree
 * when somebody ran the tool. And the set it covered was `src`, `tools`, `spec`
 * and the lockfile, so a change to an oracle, a corpus or a fixture — the
 * things a vendor runner is measured *against* — moved nothing.
 *
 * What is required now is that every producer captured the same execution
 * subject at the start of its run and found it unchanged at the end, that the
 * subject is this tree's, and that every capture names the campaign this
 * candidate was sealed under. Evidence moved between candidates, campaigns or
 * instances fails on the verdict rather than on a hash.
 */
function evidenceBound(context) {
  const name = 'evidence_bound_to_exact_candidate';
  const { manifest, treeDigest, problems: manifestProblems } = candidateManifest();
  const problems = [...manifestProblems];
  if (manifest === null) return fact(name, false, 'EVIDENCE_VERIFIED', problems.join('; '));

  const campaign = context.campaign;
  if (campaign === null) {
    problems.push(`no campaign is sealed at ${CAMPAIGN_PATH}; seal one with "node tools/seal-campaign.mjs" before producing evidence`);
  } else {
    // Coverage is per producer. The campaign sealed a fingerprint for each
    // producer's closure; the tree is covered for a producer when the same
    // closure fingerprints the same today. A producer whose inputs moved is
    // named, and only its evidence is refused — the whole-subject comparison
    // this replaces refused everything whenever anything moved.
    const sealedProducers = campaign.producers ?? null;
    if (sealedProducers === null || typeof sealedProducers !== 'object' || Array.isArray(sealedProducers)) {
      problems.push(`the sealed campaign ${String(campaign.campaignId)} records no producer fingerprints; it was sealed under an older rule and must be re-sealed`);
    } else {
      for (const [producer, sealed] of Object.entries(sealedProducers)) {
        // The universe is sealed for the record, not for this binding: it
        // takes no capture, and `offline_release_universe_passed` binds its
        // report to this tree's manifest and code digests directly.
        if (sealed?.kind === 'UNIVERSE') continue;
        const current = context.producerFingerprints?.[producer] ?? null;
        if (current === null) problems.push(`${producer}'s closure cannot be fingerprinted in this tree`);
        else if (sealed?.fingerprint !== current) {
          problems.push(
            `${producer}'s inputs moved after the campaign was sealed: sealed ${String(sealed?.fingerprint).slice(0, 12)}, tree ${current.slice(0, 12)}`,
          );
        }
      }
    }
    problems.push(...instantProblems(campaign.sealedAt, { now: context.now, label: 'the campaign sealedAt' }));
  }

  // Every producer of this campaign, capacity and vendor alike. A file the
  // campaign expects and does not find is as much a problem as one that
  // disagrees: half a campaign is not a campaign.
  const produced = [];
  const expected = [...CANDIDATE_MODES.map((mode) => `capacity ${mode}`), ...Object.keys(VENDOR_ORACLE_FILES)];
  for (const mode of CANDIDATE_MODES) {
    const evidence = founding.get(mode);
    if (evidence === undefined) {
      problems.push(`there is no ${mode} founding capacity evidence`);
      continue;
    }
    const label = relative(repoRoot, evidence.path);
    const captured = captureProblems(evidence.capture, {
      campaignId: campaign?.campaignId ?? null,
      producerFingerprints: context.producerFingerprints,
      now: context.now,
      label,
    });
    problems.push(...captured);
    if (captured.length === 0) produced.push(`capacity ${mode}`);
  }
  const matrix = readJson(join(capacityRoot, 'matrix.json'));
  if (matrix === null) problems.push('there is no capacity matrix evidence');
  else problems.push(...captureProblems(matrix.capture, { campaignId: campaign?.campaignId ?? null, producerFingerprints: context.producerFingerprints, now: context.now, label: 'qualification/capacity/matrix.json' }));
  for (const file of Object.keys(VENDOR_ORACLE_FILES)) {
    const evidence = readJson(join(VENDOR_EVIDENCE_ROOT, file));
    if (evidence === null) {
      problems.push(`there is no ${file}`);
      continue;
    }
    const captured = captureProblems(evidence.capture, {
      campaignId: campaign?.campaignId ?? null,
      producerFingerprints: context.producerFingerprints,
      now: context.now,
      label: file,
    });
    problems.push(...captured);
    if (captured.length === 0) produced.push(file);
  }
  if (produced.length === 0) problems.push('nothing in this tree carries a producer capture at all');

  return fact(
    name,
    problems.length === 0,
    'EVIDENCE_VERIFIED',
    problems.length === 0
      ? `every file in the manifest hashes as recorded, the tracked set is exactly the manifest's, the tree serialises to ` +
        `${String(treeDigest).slice(0, 16)} under digest serialisation ${DIGEST_SERIALISATION_VERSION}, and all ${String(expected.length)} ` +
        `producers captured subject ${String(context.subjectDigest).slice(0, 16)} at start and at end in campaign ${String(campaign?.campaignId)}`
      : problems.join('; '),
    { schema: manifest.schemaVersion ?? null, digest: manifest.manifestDigest ?? null, source: 'qualification/candidate/manifest.json' },
  );
}

/**
 * The declared versions clear their floors.
 *
 * A floor is the one version constant a gate may hold: it states what the
 * canonical documents require of this release and compares with `>=`, so a
 * deliberate bump passes and an accidental downgrade fails. The architecture
 * gate used to assert two exact strings instead — `scratch_contract_version ===
 * '1.0.0'` and `package_format_version === '2.0.0'` — which fails a correct
 * tree the day either contract is deliberately versioned, and cannot tell a
 * downgrade from an upgrade.
 */
function versionsAtFloor(context) {
  const name = 'declared_versions_at_or_above_floor';
  const problems = versionFloorProblems(context.versions);
  return fact(
    name,
    problems.length === 0,
    'EXECUTED',
    problems.length === 0
      ? `${String(Object.keys(VERSION_FLOORS).length)} declared versions at or above their floors: ` +
        Object.entries(VERSION_FLOORS)
          .map(([key, floor]) => `${key} ${String(context.versions[key])} >= ${floor}`)
          .join(', ')
      : problems.join('; '),
    { source: 'tools/version-floors.mjs' },
  );
}

/**
 * The receipt, from outside the tree, checked against the tree.
 *
 * What this used to do was look up four job names in `ci-receipt.json`, a file
 * committed beside the manifest, and compare one digest. Both halves were wrong.
 *
 * A receipt inside the tree cannot name the commit that contains it — writing
 * the SHA changes the file, the tree, the commit and the SHA — so its `sha` was
 * a value nobody could have computed honestly, and nothing here checked it
 * against anything. And four names in a list say that four jobs called those
 * things concluded something; they do not say the jobs concluded it about this
 * commit, this tree or this repository. A receipt from another SHA passed.
 *
 * Moving the receipt out of the tree was the first repair, and it was refuted by
 * execution. Everything the verifier compared was compared against this
 * checkout, so a receipt assembled offline in about thirty lines — `git
 * rev-parse` for the sha and the tree, the origin remote for the repository,
 * `measureTree()` for the digests, `src/version.ts` for the versions, the
 * workflow reader for the job list, and one invented check run called "anything
 * at all" — produced zero problems and made this fact TRUE. `apiCheckRuns` was
 * hard-coded `null` at the only call site, so nothing outside the file was ever
 * consulted. Whoever set `KAURO_RECEIPT_PATH` decided the fact.
 *
 * So the receipt is now a cache and GitHub is the authority. The run is read
 * back by its own run id and must itself say it ran on this commit, ran this
 * workflow file, and concluded every declared matrix leg green on a runner
 * carrying the label the workflow asked for; the commit's tree hash comes from
 * GitHub too. The file must agree with all of it. Where the API cannot be
 * reached the fact is FALSE and names the call that failed — it does not fall
 * back to the file, because the file is what the forgery was.
 *
 * The observation is a parameter rather than something this function fetches,
 * so the self-test can put a synthetic one in front of it and prove each refusal
 * fires without a network. `collect()` passes the real one; there is no
 * environment variable and no flag that reaches this argument.
 */
async function crossPlatform(observation) {
  const name = 'cross_platform_reproducibility_passed';
  const committed = join(repoRoot, ...IN_TREE_RECEIPT_PATH.split('/'));
  if (existsSync(committed)) {
    return fact(
      name,
      false,
      'EVIDENCE_VERIFIED',
      `${IN_TREE_RECEIPT_PATH} is committed into the tree. A receipt inside the tree cannot name the SHA of the commit ` +
        'containing it: writing the SHA changes the file, the tree, the commit and the SHA. Delete it and take the receipt ' +
        'from the CI receipt job, which runs outside the measured tree.',
      { source: IN_TREE_RECEIPT_PATH },
    );
  }
  if (receiptPath === null) {
    return fact(
      name,
      false,
      'EVIDENCE_VERIFIED',
      'no receipt was supplied. It is written by the CI "receipt" job after every other job in the workflow is green, ' +
        'outside the measured tree; pass it with --receipt <path> or in KAURO_RECEIPT_PATH, and verify it with ' +
        'tools/receipt-verify.mjs.',
    );
  }
  const receipt = readJson(receiptPath);
  if (receipt === null) {
    return fact(name, false, 'EVIDENCE_VERIFIED', `${receiptPath} is not readable JSON`, { source: receiptPath });
  }
  const workflow = readWorkflow();
  const observed =
    observation === undefined
      ? await observeRun({ repository: receipt.repository, sha: receipt.sha, runId: receipt.runId, token: githubToken() })
      : observation;
  const problems = receiptProblems(receipt, liveCandidate(), workflow, observed);
  const legs = requiredJobLegs(workflow).length;
  return fact(
    name,
    problems.length === 0,
    'EVIDENCE_VERIFIED',
    problems.length === 0
      ? `receipt for ${String(receipt.repository)}@${String(receipt.sha).slice(0, 12)}, git tree ` +
        `${String(receipt.gitTree).slice(0, 12)}, manifest ${String(receipt.manifestDigest).slice(0, 16)} — each equal to what ` +
        `this checkout measures — and GitHub, asked about run ${String(receipt.runId)}, reports the same commit, the same tree, ` +
        `all ${String(legs)} declared job legs green on the runner labels the workflow asked for across ` +
        `${String(new Set((observed.jobs ?? []).flatMap((job) => (job.labels ?? []).map(osFamilyOf))).size)} operating-system families, ` +
        `and every one of ${String((observed.checkRuns ?? []).length)} check runs on that commit success`
      : problems.join('; '),
    { schema: receipt.schemaVersion ?? null, digest: receipt.manifestDigest ?? null, source: receiptPath },
  );
}

// --------------------------------------------------------------------------
// J. nothing in the tree is somebody's secret or somebody's customer
// --------------------------------------------------------------------------
//
// Executed over the tree rather than asserted. This is the check whose failure
// mode is unrecoverable — a secret in a commit is a secret published — so it
// looks for shapes, not for a list of names somebody remembered to update.
function noSecrets() {
  const name = 'secrets_and_customer_data_absent';
  const findings = [];
  const accountedFor = [];
  const SHAPES = [
    { id: 'hubspot token', pattern: /\bpat-(?:na|eu)[0-9]?-[0-9a-f]{8}-/iu },
    { id: 'salesforce session', pattern: /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._]{20,}/u },
    { id: 'private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/u },
    { id: 'bearer token', pattern: /\bBearer\s+[A-Za-z0-9._\-]{40,}/u },
    { id: 'aws key', pattern: /\bAKIA[0-9A-Z]{16}\b/u },
    { id: 'client secret assignment', pattern: /(client_secret|clientSecret|CLIENT_SECRET)\s*[=:]\s*['"][A-Za-z0-9._\-]{16,}['"]/u },
  ];
  const SKIP = new Set(['node_modules', '.git', 'dist', 'tmp', 'coverage']);
  // bench/ holds the tracked launchers and, beside them, untracked scratch
  // that can run to gigabytes. The launchers are scanned; the scratch is not.
  const SCRATCH = new Set(['out', 'capacity', 'campaign']);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      if (dir === join(repoRoot, 'bench') && SCRATCH.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      let text;
      try {
        if (statSync(path).size > 8 * 1024 * 1024) continue;
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      for (const shape of SHAPES) {
        for (const [index, line] of text.split('\n').entries()) {
          if (!shape.pattern.test(line)) continue;
          // A literal handed to the engine's own secret refusal is a fixture for
          // that refusal, not a leak — the repository proves it rejects these
          // shapes by writing one down and watching it be rejected. Exempting
          // them is necessary and is also exactly the kind of exemption that
          // hides a real secret, so nothing is skipped silently: each one is
          // counted and named in the result, where a reader can check it.
          if (/assertNoSecrets\(|refusal\(/u.test(line)) {
            accountedFor.push(`${relative(repoRoot, path)}:${String(index + 1)} ${shape.id}, handed to the engine's own refusal`);
            continue;
          }
          findings.push(`${relative(repoRoot, path)}:${String(index + 1)} matches ${shape.id}`);
        }
      }
    }
  };
  try {
    walk(repoRoot);
  } catch (error) {
    return fact(name, false, 'EXECUTED', `the tree could not be walked: ${String(error && error.message ? error.message : error)}`);
  }
  return fact(
    name,
    findings.length === 0,
    'EXECUTED',
    findings.length === 0
      ? `${String(SHAPES.length)} credential shapes searched for across the tracked tree; none found` +
        (accountedFor.length === 0
          ? ''
          : `. ${String(accountedFor.length)} accounted for as fixtures of the engine's own refusal: ${accountedFor.join('; ')}`)
      : findings.join('; '),
  );
}

function provenanceValid() {
  const name = 'candidate_provenance_valid';
  const provenancePath = join(repoRoot, 'qualification', 'candidate', 'provenance.json');
  const provenance = readJson(provenancePath);
  if (provenance === null) return fact(name, false, 'EVIDENCE_VERIFIED', 'no qualification/candidate/provenance.json');
  // Every problem the recomputation found, and not one line about it.
  //
  // This fact used to compare two stored digests and, if they matched, report
  // that the provenance was valid — while the recomputation sitting one call
  // away was holding a list of files that had changed under it. Comparing two
  // numbers a producer wrote is not verification; it is agreement between two
  // copies of the same sentence.
  const { manifest, storedTableDigest, treeDigest, problems: manifestProblems } = candidateManifest();
  const problems = [...manifestProblems];
  const goldenProblems = serialisationGoldenProblems();
  problems.push(...goldenProblems);
  if (manifest === null || provenance.manifestDigest !== manifest.manifestDigest) {
    problems.push(
      `the provenance names manifest ${String(provenance.manifestDigest).slice(0, 16)} and the manifest in this tree is ` +
        `${String(manifest && manifest.manifestDigest).slice(0, 16)}`,
    );
  }
  if (manifest !== null && provenance.codeDigest !== manifest.codeDigest) {
    problems.push(
      `the provenance names code ${String(provenance.codeDigest).slice(0, 16)} and the manifest names ${String(manifest.codeDigest).slice(0, 16)}`,
    );
  }
  if (treeDigest !== null && provenance.manifestDigest !== treeDigest) {
    problems.push(`the provenance names manifest ${String(provenance.manifestDigest).slice(0, 16)} and the tree serialises to ${treeDigest.slice(0, 16)}`);
  }
  if (storedTableDigest !== null && manifest !== null && storedTableDigest !== manifest.manifestDigest) {
    problems.push(`the manifest's own table serialises to ${storedTableDigest.slice(0, 16)} and the manifest states ${String(manifest.manifestDigest).slice(0, 16)}`);
  }
  if (provenance.digestSerialisationVersion !== DIGEST_SERIALISATION_VERSION) {
    problems.push(
      `the provenance was written under digest serialisation ${String(provenance.digestSerialisationVersion)} and this is ${DIGEST_SERIALISATION_VERSION}`,
    );
  }
  // Against the versions this tree computes, never against a literal.
  //
  // These two lines read `!== '2.0.0'` while `versions` — imported at the top of
  // this file, and used by `vendorCapture()` for the identical question — sat
  // three lines away computing the same constant from `src/version.ts`. The day
  // CORE_VERSION becomes 3.0.0, the vendor check follows the code and this one
  // fails a correct provenance record. The house rule is that no constant a
  // repository could compute is written down, and this file was breaking it
  // against its own import.
  if (provenance.coreVersion !== versions.coreVersion) {
    problems.push(`coreVersion is ${String(provenance.coreVersion)} and src/version.ts declares ${versions.coreVersion}`);
  }
  if (provenance.packageFormatVersion !== versions.packageFormatVersion) {
    problems.push(`packageFormatVersion is ${String(provenance.packageFormatVersion)} and src/version.ts declares ${versions.packageFormatVersion}`);
  }
  // `runtime` is deliberately not among these. It recorded the node version and
  // the platform the record was generated on, which made the byte-exact
  // `--check` unsatisfiable on any platform but the one that wrote it; see the
  // note in tools/candidate-provenance.mjs where it was removed.
  for (const field of ['authorities', 'researchSnapshot', 'dependencies', 'knownExclusions']) {
    if (provenance[field] === undefined) problems.push(`the provenance carries no ${field}`);
  }
  if (provenance.runtime !== undefined) {
    problems.push(
      'the provenance carries a runtime section. It records the node version and platform it was generated on, so a record ' +
        'compared byte for byte across the CI matrix can never be current on more than one of them at a time.',
    );
  }
  // A freeze flag written here would be this tree describing itself as
  // finished. MC-2's record carried `MIGRATION_CORE_IMPLEMENTATION_FROZEN` as a
  // boolean and the architecture gate read it back as a fact, which is a
  // sentence and a reader of the sentence, not evidence.
  if (provenance.MIGRATION_CORE_IMPLEMENTATION_FROZEN !== undefined) {
    problems.push(
      'the provenance carries MIGRATION_CORE_IMPLEMENTATION_FROZEN. A flag a tree writes about itself is not a fact about the tree; ' +
        'the freeze is derived outside it by tools/freeze-verdict.mjs from the merged commit, the external receipt, the protection in ' +
        'force, the tag and the downloaded release assets.',
    );
  }
  if (provenance.freezeDecision?.decidedBy !== 'tools/freeze-verdict.mjs' || provenance.freezeDecision?.outsideTree !== true) {
    problems.push('the provenance does not record that the freeze decision is made outside this tree');
  }
  // The one thing a provenance record must not be is self-signed. An attestation
  // whose key the same process generated proves that the process ran, which
  // nobody doubted.
  if (provenance.signature !== undefined && provenance.signature?.issuer === provenance.generator) {
    problems.push('the provenance is signed by its own generator, which is not an external attestation');
  }
  return fact(
    name,
    problems.length === 0,
    'EVIDENCE_VERIFIED',
    problems.length === 0
      ? `provenance schema ${String(provenance.schemaVersion)} names manifest ${String(provenance.manifestDigest).slice(0, 16)} at core ${versions.coreVersion}; ` +
        `the tree recomputes to the same digest under serialisation ${DIGEST_SERIALISATION_VERSION}, whose golden vector still holds`
      : problems.join('; '),
    { schema: provenance.schemaVersion ?? null, digest: digestOfFile(provenancePath), source: 'qualification/candidate/provenance.json' },
  );
}

// --------------------------------------------------------------------------

/**
 * What every fact in this run is judged against: the campaign, the subject, the
 * declared versions and the instant.
 *
 * Measured once per collection rather than once per fact, for the reason the
 * vendor observation is: several facts rest on each of these, and asking more
 * than once is more than one chance to get more than one answer to one
 * question. The instant is passed in (`--now`) so that a gate re-run over
 * unchanged artifacts reaches an unchanged verdict.
 */
async function gateContext() {
  const measured = await measureSubject();
  // Every producer's closure over this tree, fingerprinted once. This is what
  // each piece of evidence is compared against: the files its producer read,
  // not the whole subject. See tools/producer-closure.mjs for why.
  const producers = await measureProducers();
  let versions;
  try {
    versions = await readVersions();
  } catch {
    versions = {};
  }
  return {
    now: nowInstant,
    campaign: readCampaign(),
    subjectDigest: measured.subjectDigest,
    subjectProblems: [...measured.problems, ...producers.problems],
    producerFingerprints: producers.fingerprints,
    producerDetails: producers.details,
    versions,
  };
}

async function collect() {
  facts.length = 0;
  refresh();
  const context = await gateContext();
  // The two vendors are asked once, not once per fact: three facts rest on the
  // Salesforce answer and asking three times would be three chances to get three
  // answers to one question.
  const hubspot = await observeVendor('hubspot');
  const salesforce = await observeVendor('salesforce');
  architectureClosed();
  offlineUniverse();
  documentDrift();
  sourceRegistryCurrent(context.now);
  versionsAtFloor(context);
  vendorGate('hubspot_target_current', ['hs-target-contract.json', 'hs-import.json'], 'HSP-TARGET-01', hubspot, context);
  vendorGate('salesforce_target_current', ['sf-target-contract.json', 'sf-dataloader.json'], 'SF-TARGET-01', salesforce, context);
  vendorGate('salesforce_ocr_disposition_current', ['sf-ocr.json'], 'SF-OCR-01', salesforce, context);
  await attestationDefault();
  capacityFor('HUBSPOT', context);
  capacityFor('SALESFORCE', context);
  capacityFor('CLEAN_ONLY', context);
  await profileMatrixComplete(context);
  budgetFact('memory_budget_passed', (measured) => measured.peakRssBytes, LIMITS.memoryBudgetBytes, 'the memory budget');
  budgetFact('scratch_budget_passed', (measured) => measured.peakScratchBytes, LIMITS.scratchBudgetBytes, 'the scratch budget');
  amplificationExplained();
  budgetFact('wall_clock_passed', (measured) => measured.wallClockMs, LIMITS.wallClockLimitMs, 'the wall clock limit');
  deterministicBytes();
  verifyAndAttest();
  evidenceBound(context);
  await crossPlatform();
  noSecrets();
  provenanceValid();
  return facts.slice();
}

/**
 * The closure condition.
 *
 * Written out rather than folded into a loop, for the same reason ARCHITECTURE-01
 * writes its own out: adding a fact must not be able to change what the gate
 * means by accident, and a reader has to be able to see which way each one points.
 *
 * `implementation_frozen` is not here and must not be. MC-2 produces a
 * candidate; freezing it is MC-3's, and a gate that could set it would let the
 * front that builds the thing also declare it finished.
 */
const MUST_BE_TRUE = [
  'architecture_closed',
  'offline_release_universe_passed',
  'spec_and_document_drift_absent',
  'source_registry_current',
  'declared_versions_at_or_above_floor',
  'hubspot_target_current',
  'salesforce_target_current',
  'salesforce_ocr_disposition_current',
  'crm_attestation_required_by_default',
  'capacity_hubspot_1m_representative',
  'capacity_salesforce_1m_representative',
  'capacity_clean_only_1m_representative',
  'capacity_profiles_matrix_complete',
  'memory_budget_passed',
  'scratch_budget_passed',
  'scratch_amplification_explained',
  'wall_clock_passed',
  'candidate_bytes_deterministic',
  'package_verify_and_attest_passed',
  'evidence_bound_to_exact_candidate',
  'cross_platform_reproducibility_passed',
  'secrets_and_customer_data_absent',
  'candidate_provenance_valid',
];

function releaseCandidate(observed) {
  const value = (name) => observed.find((entry) => entry.name === name)?.value;
  return MUST_BE_TRUE.every((name) => value(name) === true);
}

/**
 * The preflight's facts: everything the tree can answer about itself.
 *
 * `cross_platform_reproducibility_passed` is the one that is excluded, and the
 * exclusion is the whole point of splitting the two records. That fact rests on
 * a receipt naming a commit, and a file inside the tree cannot name the commit
 * containing it. Asking the tree to attest it is what produced a committed
 * `ci-receipt.json` whose SHA nobody could have computed honestly.
 */
const RECEIPT_FACT = 'cross_platform_reproducibility_passed';
const PREFLIGHT_FACTS = MUST_BE_TRUE.filter((name) => name !== RECEIPT_FACT);

const PREFLIGHT_SCHEMA_VERSION = '1.0.0';
const preflightPath = join(repoRoot, 'qualification', 'candidate', 'preflight.json');

function gitOutput(gitArgs) {
  const result = run('git', gitArgs);
  return result.ok ? result.stdout : null;
}

/**
 * The paths git reports as changed, with an explicit set ignored.
 *
 * The porcelain format is two status characters, a space, then the path, so a
 * rename reads as "old -> new" and a path needing quoting reads quoted. Neither
 * matches an ignore entry, so both stay dirty. That is the right way round: the
 * only thing an unparsed line may do here is make the tree look less clean.
 */
function dirtyPaths(ignore = []) {
  const status = gitOutput(['status', '--porcelain', '-uall']);
  if (status === null) return null;
  return status
    .split('\n')
    .map((line) => line.replace(/\r$/u, ''))
    .filter((line) => line !== '')
    .map((line) => line.slice(3))
    .filter((path) => !ignore.includes(path));
}

function treeIsClean(ignore = []) {
  const dirty = dirtyPaths(ignore);
  return dirty === null ? null : dirty.length === 0;
}

/**
 * The preflight excludes itself from its own cleanliness check, for the same
 * reason the manifest excludes itself from its own digest: writing the record
 * changes the tree, so a record that required the tree to be unchanged could
 * never be updated without an intervening commit.
 */
const PREFLIGHT_TREE_CLEAN_EXCLUDES = ['qualification/candidate/preflight.json'];

/**
 * The preflight record: names, values and digests. No details, no timings, no
 * platform string.
 *
 * That is not terseness. A record CI compares byte for byte across ubuntu and
 * windows can carry nothing that differs between them for reasons that are not
 * the verdict — one wall-clock figure or one `win32 x64` in a detail and the
 * comparison starts failing for reasons nobody has to act on, which is how a
 * comparison gets deleted. The details are on stderr, where a reader wants them
 * and no machine compares them.
 */
function buildPreflight(observed) {
  const { manifest } = candidateManifest();
  return {
    schemaVersion: PREFLIGHT_SCHEMA_VERSION,
    artifactKind: 'MIGRATION_CORE_CANDIDATE_PREFLIGHT',
    gate: 'RELEASE-CANDIDATE-01',
    digestSerialisationVersion: DIGEST_SERIALISATION_VERSION,
    manifestDigest: manifest === null ? null : manifest.manifestDigest,
    codeDigest: manifest === null ? null : manifest.codeDigest,
    versions: { ...versions },
    treeClean: treeIsClean(PREFLIGHT_TREE_CLEAN_EXCLUDES),
    treeCleanExcludes: PREFLIGHT_TREE_CLEAN_EXCLUDES,
    // The receipt fact is named, and named as not decided here, so a reader of
    // the preflight alone cannot mistake it for the whole condition.
    decidedElsewhere: [{ fact: RECEIPT_FACT, by: 'tools/receipt-verify.mjs, from a receipt written outside this tree' }],
    facts: Object.fromEntries(
      PREFLIGHT_FACTS.map((name) => {
        const entry = observed.find((candidate) => candidate.name === name);
        return [name, { value: entry?.value ?? null, by: entry?.derivation ?? null }];
      }),
    ),
    MIGRATION_CORE_CANDIDATE_PREFLIGHT: PREFLIGHT_FACTS.every((name) => observed.find((entry) => entry.name === name)?.value === true)
      ? 'TRUE'
      : 'FALSE',
  };
}

function reportFacts(observed) {
  const width = Math.max(...observed.map((entry) => entry.name.length));
  for (const entry of observed) {
    process.stderr.write(`  ${entry.name.padEnd(width)}  ${String(entry.value).padEnd(6)} [${entry.derivation}] ${entry.detail}\n`);
  }
}

// --------------------------------------------------------------------------
// The preflight, in the tree
// --------------------------------------------------------------------------

async function runPreflight() {
  const observed = await collect();
  const record = buildPreflight(observed);
  const json = `${JSON.stringify(record, null, 2)}\n`;
  const failed = PREFLIGHT_FACTS.filter((name) => observed.find((entry) => entry.name === name)?.value !== true);

  process.stderr.write('\nRELEASE-CANDIDATE-01 preflight\n\n');
  reportFacts(observed.filter((entry) => PREFLIGHT_FACTS.includes(entry.name)));

  if (checkOnly) {
    if (!existsSync(preflightPath)) {
      process.stderr.write(
        `\n${relative(repoRoot, preflightPath)} is not in the tree. Run "node tools/release-candidate-gate.mjs --preflight" ` +
          'on a clean tree and commit the result.\n\n',
      );
      return 1;
    }
    const committed = readFileSync(preflightPath, 'utf8');
    if (committed !== json) {
      process.stderr.write(
        `\n${relative(repoRoot, preflightPath)} is not what this platform computes.\n` +
          'The preflight carries names, values and digests only, so a difference is a difference of verdict — not of formatting,\n' +
          'timing or platform. Re-run "node tools/release-candidate-gate.mjs --preflight" and read the diff.\n\n',
      );
      return 1;
    }
    if (record.MIGRATION_CORE_CANDIDATE_PREFLIGHT !== 'TRUE') {
      process.stderr.write(`\nthe preflight is FALSE: ${failed.join(', ')}\n\n`);
      return 1;
    }
    process.stderr.write(`\nMIGRATION_CORE_CANDIDATE_PREFLIGHT=TRUE, byte-identical to the committed record\n\n`);
    return 0;
  }

  if (record.treeClean !== true) {
    process.stderr.write(
      '\nthe working tree is not clean, so the manifest digest is not the digest of any commit.\n' +
        'Commit or stash first; a preflight taken over uncommitted bytes names a candidate nobody else can check out.\n\n',
    );
    return 1;
  }
  if (failed.length > 0) {
    process.stderr.write(
      `\nrefusing to write ${relative(repoRoot, preflightPath)}: ${String(failed.length)} facts are false — ${failed.join(', ')}\n` +
        'A preflight is a record that the tree is ready. Writing one that says otherwise would make the record the thing that\n' +
        'has to be checked, which is the failure this gate exists to refuse.\n\n',
    );
    return 1;
  }
  mkdirSync(join(repoRoot, 'qualification', 'candidate'), { recursive: true });
  writeFileSync(preflightPath, json);
  process.stderr.write(
    `\nwrote ${relative(repoRoot, preflightPath)}\n` +
      `MIGRATION_CORE_CANDIDATE_PREFLIGHT=TRUE over ${String(PREFLIGHT_FACTS.length)} facts, manifest ${String(record.manifestDigest).slice(0, 16)}\n\n`,
  );
  return 0;
}

// --------------------------------------------------------------------------
// The self-test: proving each of these can say FALSE
// --------------------------------------------------------------------------
//
// A gate that cannot say FALSE is not a gate, and every fact below is one this
// repository has actually shipped a way of passing dishonestly. So each scenario
// breaks exactly one thing, and then four things are required of the result:
//
//   1. the owning fact is FALSE;
//   2. its detail carries a phrase that only the injected defect could produce —
//      a digest or an instance this scenario invented, never a generic word;
//   3. that phrase is absent from the same fact's detail before the injection,
//      so it is the mutation and not the tree's pre-existing state that produced
//      it;
//   4. the closure consults the fact: with every other fact true and this one
//      false, `release_candidate` is FALSE, and with all of them true it is TRUE.
//
// The fourth is what stops a fact from being observed, reported and then not
// counted, which is how `implementation_frozen` came to be able to fail the
// architecture gate at the moment the architecture became correct.
//
// Afterwards the tree is put back and the restoration is checked rather than
// assumed — by digest, per file, and by `git status --porcelain -uall`. A
// sabotage run left a mutation behind in this repository twice, and the first
// time it shipped real row loss to main.

const SENTINEL_DIGEST = `${'0'.repeat(63)}1`;
const SENTINEL_SHA = `${'0'.repeat(39)}1`;

/**
 * Every defect this self-test exists to prove the gate catches. Absence is failure.
 *
 * The vendor half of this list grew when the evidence model did. MC-2's
 * scenarios were about a binding — a stale digest, an invented corpus, a README
 * as the writer — and the binding is gone; what replaced it is a producer's
 * capture of the execution subject, a campaign, an observed instance and typed
 * results against a declared oracle. Each of those is a way a vendor gate can
 * be satisfied by a file rather than by a run, so each of them is here.
 */
const REQUIRED_SCENARIOS = [
  'a mutated evidence byte',
  'a mutated manifest digest',
  'a capture whose producer read other inputs',
  'inputs that moved while the producer ran',
  'evidence from another campaign',
  'a capture written by a tool',
  'a stamped candidate block',
  'a mixed instance',
  'evidence about another instance',
  'a case the oracle declares and nobody asked',
  'a case recorded twice',
  'a case that reports ok and disagrees with itself',
  'an observation dated after the gate ran',
  'a universe missing a step',
  'a universe with a step recorded twice',
  'a capacity record denominated in mebibytes',
  'a matrix profile below its declared scale',
  'a receipt from another SHA',
  'a red required check',
  'a missing required check',
  'a receipt nothing was asked about',
  'a check run GitHub never saw',
  'one platform, called cross-platform',
  'a run GitHub puts on another commit',
];

function evidenceFile(name) {
  return join(repoRoot, 'qualification', 'evidence', name);
}

/** Runs one fact function in isolation and returns the entry it produced. */
async function observeFact(produce) {
  facts.length = 0;
  refresh();
  await produce();
  const entry = facts[facts.length - 1] ?? null;
  facts.length = 0;
  return entry;
}

// ---------------------------------------------------------------------------
// Synthetic evidence, outside the tree
// ---------------------------------------------------------------------------
//
// The vendor scenarios used to mutate the committed evidence files and put them
// back. That worked, and it was the wrong mechanism: this repository has twice
// had a mutation left behind by an interrupted run, and once shipped one. It
// also meant the scenarios could only test defects the *committed* evidence was
// close enough to exhibit, so the control case depended on whatever state the
// tree happened to be in.
//
// A complete, well-formed set of vendor evidence is built here instead, in a
// temporary directory, and the scenarios break that. Nothing under
// `qualification/evidence` is touched by any of them.

/** A capture that satisfies every rule, so a scenario can break exactly one. */
function selfTestCapture(context, overrides = {}) {
  const producer = overrides.producer ?? 'qualification/hubspot/run-import-qualification.mjs';
  // Bound by the producer's closure fingerprint over this tree, which is what
  // the reader compares; the whole-subject digests travel for the record.
  const fingerprint = context.producerFingerprints?.[producer] ?? SENTINEL_DIGEST;
  return {
    captureVersion: '2.0.0',
    producer,
    producerFingerprint: fingerprint,
    producerFingerprintAtEnd: fingerprint,
    campaignId: context.campaign?.campaignId ?? 'c_0000000000000000',
    subjectDigestAtStart: context.subjectDigest ?? SENTINEL_DIGEST,
    subjectDigestAtEnd: context.subjectDigest ?? SENTINEL_DIGEST,
    startedAt: '2026-09-08T00:00:00Z',
    endedAt: '2026-09-08T00:10:00Z',
    valid: true,
    invalidation: null,
    environment: { node: process.version, platform: process.platform },
    ...overrides,
  };
}

const SELF_TEST_INSTANCE = 'self-test-not-a-real-instance';

/** One well-formed vendor evidence file, complete against its own oracle. */
function selfTestEvidence(file, context, overrides = {}) {
  const oracle = VENDOR_ORACLES[file];
  const producer = file.startsWith('hs-')
    ? file.includes('target')
      ? 'qualification/hubspot/run-target-qualification.mjs'
      : 'qualification/hubspot/run-import-qualification.mjs'
    : file === 'sf-ocr.json'
      ? 'qualification/salesforce/run-ocr-qualification.mjs'
      : file.includes('target')
        ? 'qualification/salesforce/run-target-qualification.mjs'
        : 'qualification/salesforce/run-dataloader-qualification.mjs';
  const entries =
    oracle.kind === 'IDS'
      ? oracle.ids.map((id) => ({ id, ok: true, expected: true, observed: true, detail: null }))
      : [
          ...oracle.families.map((family, index) => ({ id: `${family}selfTest${String(index)}`, ok: true, expected: true, observed: true, detail: null })),
          ...(oracle.routeFamilies[0] === undefined ? [] : [{ id: `${oracle.routeFamilies[0]}selfTest`, ok: true, expected: true, observed: true, detail: null }]),
          ...Array.from({ length: Math.max(0, oracle.minimumChecks - oracle.families.length - (oracle.routeFamilies[0] === undefined ? 0 : 1)) }, (unused, index) => ({
            id: `${oracle.families[0]}filler${String(index)}`,
            ok: true,
            expected: true,
            observed: true,
            detail: null,
          })),
        ];
  return {
    gate: oracle.gate,
    observedAt: '2026-09-08T00:05:00Z',
    observedInstance: {
      vendor: file.startsWith('hs-') ? 'hubspot' : 'salesforce',
      instanceId: SELF_TEST_INSTANCE,
      instancePseudonym: pseudonymousInstance(SELF_TEST_INSTANCE),
      observedBy: 'a synthetic observation, supplied by the self-test',
      detail: null,
    },
    capture: selfTestCapture(context, { producer }),
    [oracle.casesField]: entries,
    ...(oracle.kind === 'FAMILIES' ? { checksRun: entries.length } : {}),
    failures: [],
    result: 'PASS',
    ...overrides,
  };
}

/**
 * A directory of well-formed vendor evidence, with one file mutated.
 *
 * @param {object} context the gate context the scenario runs under
 * @param {(files: Record<string, object>) => void} mutate breaks exactly one thing
 * @returns {{root: string, dir: string}}
 */
function selfTestEvidenceRoot(context, mutate) {
  const files = {};
  for (const file of Object.keys(VENDOR_ORACLES)) files[file] = selfTestEvidence(file, context);
  mutate(files);
  const dir = mkdtempSync(join(tmpdir(), 'kauro-self-test-evidence-'));
  for (const [file, evidence] of Object.entries(files)) {
    writeFileSync(join(dir, file), `${JSON.stringify(evidence, null, 2)}\n`);
  }
  return { root: dir, dir };
}

/** The vendor observation a scenario runs against: the instance the synthetic evidence names. */
function selfTestObservation(instance = SELF_TEST_INSTANCE) {
  return {
    instance: pseudonymousInstance(instance),
    note: 'a synthetic observation, supplied by the self-test',
    problems: [],
  };
}

const HUBSPOT_FILES = ['hs-target-contract.json', 'hs-import.json'];

/**
 * A receipt and the GitHub observation that agrees with it.
 *
 * Both, together, because they are two halves of one claim: the file caches what
 * GitHub reported, and a scenario that corrupts one without the other tests the
 * disagreement rather than the rule it means to test.
 */
function writeTempReceipt(mutate) {
  const live = liveCandidate();
  const workflow = readWorkflow();
  const legs = requiredJobLegs(workflow);
  const receiptJobName = workflow.receiptJobName ?? 'release receipt (RECEIPT-01)';
  // Identified as the API identifies them: the observer matches the receipt to GitHub by check-run id (MCD-R2).
  const checkRuns = legs.map((leg, index) => ({ checkRunId: `check-${String(index)}`, name: leg.name, conclusion: 'success', headSha: live.sha, app: 'github-actions', checkSuiteId: 'suite-1' }));
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    artifactKind: 'MIGRATION_CORE_CI_RECEIPT',
    generator: 'tools/receipt-verify.mjs --emit',
    repository: live.repository,
    sha: live.sha,
    gitTree: live.gitTree,
    ref: 'refs/heads/self-test',
    branch: 'self-test',
    eventName: 'push',
    workflow: 'core gate',
    runId: '1',
    runNumber: '1',
    runAttempt: '1',
    manifestDigest: live.manifestDigest,
    codeDigest: live.codeDigest,
    digestSerialisationVersion: DIGEST_SERIALISATION_VERSION,
    exclusionRuleVersion: EXCLUSION_RULE_VERSION,
    versions: { ...versions },
    node: process.version,
    runnerOs: null,
    requiredJobs: workflow.jobIds.filter((id) => id !== workflow.receiptJobId).map((id) => ({ name: id, result: 'success' })),
    checkRuns: [...checkRuns].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
  const observation = {
    problems: [],
    run: { headSha: live.sha, path: WORKFLOW_PATH, runAttempt: 1, status: 'in_progress', conclusion: null, repository: live.repository },
    commitTree: live.gitTree,
    jobs: [
      ...legs.map((leg) => ({ name: leg.name, conclusion: 'success', status: 'completed', headSha: live.sha, labels: [leg.runsOn], jobId: `${leg.name}-1`, runAttempt: 1 })),
      { name: receiptJobName, conclusion: 'in_progress (not concluded)', status: 'in_progress', headSha: live.sha, labels: ['ubuntu-latest'], jobId: 'receipt-1', runAttempt: 1 },
    ],
    checkRuns: checkRuns.map((run) => ({ ...run, status: 'completed' })),
  };
  const note = mutate(receipt, { live, workflow, observation });
  const dir = mkdtempSync(join(tmpdir(), 'kauro-self-test-receipt-'));
  const path = join(dir, 'ci-receipt.json');
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return { path, dir, receipt, observation, note };
}

/** A universe report that satisfies the inventory, written outside the tree. */
function selfTestUniverse(mutate) {
  const { manifest, codeDigest } = candidateManifest();
  const steps = UNIVERSE_STEP_IDS.map((id) => ({
    id,
    label: id,
    ok: true,
    status: 'ok',
    skipped: false,
    exitStatus: 0,
    outputSha256: sha256(Buffer.from(id, 'utf8')),
    logPath: `self-test/${id}.log`,
    durationMs: 1,
    detail: 'a synthetic step, supplied by the self-test',
  }));
  const report = {
    schemaVersion: UNIVERSE_SCHEMA_VERSION,
    gate: 'OFFLINE-UNIVERSE',
    scope: 'FULL',
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    candidate: {
      manifestDigest: manifest?.manifestDigest ?? SENTINEL_DIGEST,
      codeDigest: codeDigest ?? SENTINEL_DIGEST,
      digestSerialisationVersion: DIGEST_SERIALISATION_VERSION,
      exclusionRuleVersion: EXCLUSION_RULE_VERSION,
    },
    steps,
    passed: true,
  };
  const note = mutate(report);
  const dir = mkdtempSync(join(tmpdir(), 'kauro-self-test-universe-'));
  const path = join(dir, 'universe.json');
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return { path, dir, report, note };
}

/** A founding capacity record that satisfies its schema, written outside the tree. */
function selfTestCapacity(context, mode, mutate) {
  const stages = CAPACITY_STAGES.map((stage) => ({
    stage,
    wallMs: 1000,
    peakRssBytes: 1_000_000_000,
    peakRssBytesReason: null,
    maxRssDeltaBytes: 1_000,
    maxRssDeltaBytesReason: null,
    scratchLiveBytesAtEnd: 0,
    scratchLiveBytesAtEndReason: null,
    scratchPeakLiveBytesSoFar: 1_000_000,
    scratchPeakLiveBytesReason: null,
    scratchSampledBytesAtEnd: 0,
    scratchSampledBytesAtEndReason: null,
  }));
  const record = {
    evidenceSchemaVersion: context.versions.capacityEvidenceSchemaVersion,
    gate: 'CAPACITY-FOUNDING',
    scope: 'FOUNDING',
    mode,
    profile: `FOUNDING-${mode}-1M`,
    sourceRows: 1_003_000,
    observedAt: '2026-09-08T00:20:00Z',
    result: 'PASS',
    capture: selfTestCapture(context, { producer: 'tools/capacity.mjs' }),
    measured: {
      peakRssBytes: 1_643_139_072,
      peakScratchBytes: 10_698_607_520,
      scratchPeakLiveBytes: 10_878_563_080,
      scratchBytesWritten: 47_919_956_831,
      sourceBytes: 300_010_838,
      packageBytes: 1_607_222_375,
      wallClockMs: 962_040,
      maxRssUnit: 'KiB, converted at 1024 on this platform and node major',
    },
    stages,
    reproductions: [
      { packageDigest: 'a'.repeat(64), wallClockMs: 962_040, stages },
      { packageDigest: 'a'.repeat(64), wallClockMs: 938_182, stages },
    ],
    reconciliation: { equationHolds: true, rowsIngested: 1_003_000 },
    verification: { ok: true, checksRun: 55, problems: [], attestationOk: true },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuCount: 12,
      totalMemoryBytes: 14_893_805_568,
      samplingIntervalMs: 50,
      maxRssCalibration: 'measured at start of campaign',
    },
  };
  const note = mutate(record);
  return { record, note };
}

function selfTestScenarios(context) {
  // The file to mutate is taken from the manifest rather than from the
  // directory. A file on disk that the manifest does not name would produce a
  // different finding — a true one, and not the one this scenario is about.
  const { manifest } = candidateManifest();
  const posix =
    (manifest?.files ?? [])
      .map((entry) => entry.path)
      .filter((path) => path.startsWith('qualification/capacity/') && path.endsWith('.json') && !path.endsWith('/profiles.json'))
      .sort()
      .find((path) => existsSync(join(repoRoot, ...path.split('/')))) ?? null;
  const scenarios = [];

  if (posix !== null) {
    const path = join(repoRoot, ...posix.split('/'));
    scenarios.push({
      id: 'a mutated evidence byte',
      fact: 'evidence_bound_to_exact_candidate',
      produce: () => evidenceBound(context),
      files: [path],
      apply: () => {
        // One byte. The evidence stays valid JSON and keeps every number it
        // recorded, so nothing but the manifest's own hash can notice.
        writeFileSync(path, `${readFileSync(path, 'utf8')} `);
        return `${posix} hashes ${String(digestOfFile(path)).slice(0, 12)}`;
      },
    });
  }

  scenarios.push({
    id: 'a mutated manifest digest',
    fact: 'candidate_provenance_valid',
    produce: () => provenanceValid(),
    files: [manifestPath],
    apply: () => {
      const mutated = readJson(manifestPath);
      mutated.manifestDigest = SENTINEL_DIGEST;
      writeFileSync(manifestPath, `${JSON.stringify(mutated, null, 2)}\n`);
      return SENTINEL_DIGEST.slice(0, 16);
    },
  });

  // ---------------------------------------------------------------- vendor
  //
  // Each of these builds a complete, well-formed set of synthetic evidence
  // outside the tree and breaks exactly one thing in it. The control — the same
  // set with nothing broken — must produce no problems at all, or the scenario
  // would "fail" because the shape is unsatisfiable rather than because of what
  // it injected.

  const vendorScenario = (id, expect, mutate) => ({
    id,
    fact: 'hubspot_target_current',
    evidence: mutate,
    expect,
  });

  scenarios.push(
    vendorScenario('a capture whose producer read other inputs', 'something the measurement depended on has moved', (files) => {
      files['hs-import.json'].capture.producerFingerprint = SENTINEL_DIGEST;
      files['hs-import.json'].capture.producerFingerprintAtEnd = SENTINEL_DIGEST;
    }),
  );

  scenarios.push(
    vendorScenario('inputs that moved while the producer ran', "saw its producer's inputs change while it ran", (files) => {
      files['hs-import.json'].capture.producerFingerprintAtEnd = SENTINEL_DIGEST;
      files['hs-import.json'].capture.valid = false;
      files['hs-import.json'].capture.invalidation = 'PRODUCER_INPUTS_CHANGED_DURING_RUN';
    }),
  );

  scenarios.push(
    vendorScenario('evidence from another campaign', 'was produced in campaign c_1111111111111111', (files) => {
      files['hs-import.json'].capture.campaignId = 'c_1111111111111111';
    }),
  );

  scenarios.push(
    vendorScenario('a capture written by a tool', 'was produced by tools/candidate-provenance.mjs', (files) => {
      files['hs-import.json'].capture.producer = 'tools/candidate-provenance.mjs';
    }),
  );

  scenarios.push(
    vendorScenario('a stamped candidate block', 'carries a candidate block written by tools/candidate-provenance.mjs', (files) => {
      files['hs-import.json'].candidate = { writtenBy: 'tools/candidate-provenance.mjs', codeDigest: SENTINEL_DIGEST };
    }),
  );

  scenarios.push(
    vendorScenario('a mixed instance', 'mixes instances', (files) => {
      const other = 'self-test-a-different-portal';
      files['hs-target-contract.json'].observedInstance.instanceId = other;
      files['hs-target-contract.json'].observedInstance.instancePseudonym = pseudonymousInstance(other);
    }),
  );

  scenarios.push({
    id: 'evidence about another instance',
    fact: 'hubspot_target_current',
    // Both files moved to one other portal, together, so they agree with each
    // other. What is wrong is only that neither is the instance the credential
    // opens — which is the thing this scenario exists to prove gets refused.
    evidence: (files) => {
      const other = 'self-test-a-different-portal';
      for (const file of HUBSPOT_FILES) {
        files[file].observedInstance.instanceId = other;
        files[file].observedInstance.instancePseudonym = pseudonymousInstance(other);
      }
    },
    expect: `is evidence about instance ${pseudonymousInstance('self-test-a-different-portal')}`,
  });

  scenarios.push(
    vendorScenario('a case the oracle declares and nobody asked', 'is missing the declared cases I1.contacts', (files) => {
      files['hs-import.json'].cases = files['hs-import.json'].cases.filter((entry) => entry.id !== 'I1.contacts');
    }),
  );

  scenarios.push(
    vendorScenario('a case recorded twice', 'records I1.contacts 2 times', (files) => {
      const duplicated = files['hs-import.json'].cases.find((entry) => entry.id === 'I1.contacts');
      files['hs-import.json'].cases.push({ ...duplicated });
    }),
  );

  scenarios.push(
    // The SF-OCR shape, as a rule rather than as a regular expression over
    // English: a case that reports ok while the two values it compared differ.
    vendorScenario('a case that reports ok and disagrees with itself', 'reports ok while its expected', (files) => {
      const entry = files['hs-import.json'].cases.find((candidate) => candidate.id === 'I3.definedEnumerationValue');
      entry.expected = 'ACCEPTED';
      entry.observed = 'REJECTED';
    }),
  );

  scenarios.push(
    vendorScenario('an observation dated after the gate ran', 'is in the future relative to', (files) => {
      files['hs-import.json'].observedAt = '2099-01-01T00:00:00Z';
    }),
  );

  // -------------------------------------------------------------- universe

  scenarios.push({
    id: 'a universe missing a step',
    fact: 'offline_release_universe_passed',
    universe: (report) => {
      report.steps = report.steps.filter((step) => step.id !== 'sabotage');
      return 'sabotage';
    },
    expect: 'step "sabotage" is missing from the report',
  });

  scenarios.push({
    id: 'a universe with a step recorded twice',
    fact: 'offline_release_universe_passed',
    universe: (report) => {
      report.steps.push({ ...report.steps[0] });
    },
    expect: 'appears 2 times',
  });

  // -------------------------------------------------------------- capacity

  scenarios.push({
    id: 'a capacity record denominated in mebibytes',
    fact: 'capacity_hubspot_1m_representative',
    capacity: (record) => {
      record.measured.peakMB = 1_567;
    },
    expect: 'denominated in a display unit rather than bytes',
  });

  scenarios.push({
    id: 'a matrix profile below its declared scale',
    fact: 'capacity_profiles_matrix_complete',
    matrix: (matrix) => {
      const entry = (matrix.results ?? [])[0];
      if (entry === undefined) return null;
      entry.sourceRows = Math.max(1, Math.floor(Number(entry.sourceRows) / 2));
      return entry.profile;
    },
    expect: 'source rows and the declared profile at rung',
  });

  // --------------------------------------------------------------- receipt

  scenarios.push({
    id: 'a receipt from another SHA',
    fact: RECEIPT_FACT,
    produce: (observation) => crossPlatform(observation),
    files: [],
    receipt: (receipt) => {
      receipt.sha = SENTINEL_SHA;
      for (const run of receipt.checkRuns) run.headSha = SENTINEL_SHA;
    },
    expect: `names commit ${SENTINEL_SHA.slice(0, 12)}`,
  });

  scenarios.push({
    id: 'a red required check',
    fact: RECEIPT_FACT,
    produce: (observation) => crossPlatform(observation),
    files: [],
    receipt: (receipt, { observation }) => {
      receipt.checkRuns.push({ checkRunId: 'check-red', name: 'a check that failed', conclusion: 'failure', headSha: receipt.sha, app: 'github-actions', checkSuiteId: 'suite-1' });
      observation.checkRuns.push({
        name: 'a check that failed',
        conclusion: 'failure',
        status: 'completed',
        headSha: receipt.sha,
        checkRunId: 'check-red',
        app: 'github-actions',
        checkSuiteId: 'suite-1',
      });
    },
    expect: 'check run "a check that failed" is failure',
  });

  scenarios.push({
    id: 'a missing required check',
    fact: RECEIPT_FACT,
    produce: (observation) => crossPlatform(observation),
    files: [],
    receipt: (receipt, { workflow }) => {
      const dropped = workflow.jobIds.find((id) => id !== workflow.receiptJobId);
      receipt.requiredJobs = receipt.requiredJobs.filter((entry) => entry.name !== dropped);
      return dropped;
    },
    expect: null,
  });

  scenarios.push({
    // A receipt with nothing wrong with it, and no GitHub. This is the forgery
    // the verifier executed: every field computable from the tree, and the fact
    // was TRUE. It must now be FALSE for the reason that the file is a file.
    id: 'a receipt nothing was asked about',
    fact: RECEIPT_FACT,
    produce: (observation) => crossPlatform(observation),
    files: [],
    receipt: () => {},
    observation: () => null,
    expect: 'nothing was read back from the GitHub API',
  });

  scenarios.push({
    id: 'a check run GitHub never saw',
    fact: RECEIPT_FACT,
    produce: (observation) => crossPlatform(observation),
    files: [],
    receipt: (receipt) => {
      receipt.checkRuns.push({ name: 'anything at all', conclusion: 'success', headSha: receipt.sha });
    },
    expect: 'the receipt carries check run "anything at all" and GitHub reports no such run on this commit',
  });

  scenarios.push({
    id: 'one platform, called cross-platform',
    fact: RECEIPT_FACT,
    produce: (observation) => crossPlatform(observation),
    files: [],
    receipt: (receipt, { observation }) => {
      for (const job of observation.jobs) job.labels = ['ubuntu-latest'];
    },
    expect: 'operating-system family',
  });

  scenarios.push({
    id: 'a run GitHub puts on another commit',
    fact: RECEIPT_FACT,
    produce: (observation) => crossPlatform(observation),
    files: [],
    receipt: (receipt, { observation }) => {
      observation.run.headSha = SENTINEL_SHA;
    },
    expect: `ran on commit ${SENTINEL_SHA.slice(0, 12)}`,
  });

  return scenarios;
}

/**
 * The closure consults this fact.
 *
 * Everything else true, this one false: FALSE. Everything true: TRUE. Two calls,
 * and between them they say both that the fact is counted and that the condition
 * is satisfiable — a `mustBeTrue` naming a fact that never exists would fail the
 * second and would otherwise look like rigour.
 */
function closureConsults(name) {
  const allTrue = MUST_BE_TRUE.map((factName) => ({ name: factName, value: true }));
  const oneFalse = MUST_BE_TRUE.map((factName) => ({ name: factName, value: factName !== name }));
  return releaseCandidate(allTrue) === true && releaseCandidate(oneFalse) === false;
}

/**
 * The self-test, one scenario at a time.
 *
 * Four kinds of scenario, and the difference is where the defect is injected:
 *
 *   `files` + `apply`   mutates a committed file and puts it back. Two
 *                       scenarios use it, because the defect they inject is
 *                       *about* the committed bytes: a byte added to a
 *                       measurement, and a manifest that names the wrong digest.
 *   `evidence`          builds a complete, well-formed vendor evidence set
 *                       outside the tree and breaks one thing in it.
 *   `universe`/`capacity`/`matrix`  the same, for the records those facts read.
 *   `receipt`           builds a receipt and the GitHub observation that agrees
 *                       with it, and breaks one side.
 *
 * Every kind is held to the same four requirements: the owning fact goes FALSE,
 * its detail carries a phrase only the injected defect could produce, that
 * phrase is absent from the same fact's detail before the injection, and the
 * closure condition consults the fact.
 */
async function runSelfTest() {
  process.stderr.write('\nRELEASE-CANDIDATE-01 self-test\n\n');

  const cleanBefore = treeIsClean();
  if (cleanBefore !== true) {
    process.stderr.write(
      'refusing to run: the working tree is not clean.\n' +
        'Two scenarios mutate a real file and put it back. Starting from a dirty tree makes "put it back" unverifiable, and a\n' +
        'mutation left behind by an interrupted run has shipped from this repository before.\n\n',
    );
    return 1;
  }

  const baseContext = await gateContext();
  const scenarios = selfTestScenarios(baseContext);
  const failures = [];
  // A scenario that quietly did not get built is a defect nobody proved the gate
  // catches, reported as a pass. So the set is named, and a missing one is a
  // failure of the self-test rather than a shorter run.
  for (const id of REQUIRED_SCENARIOS) {
    if (!scenarios.some((scenario) => scenario.id === id)) {
      failures.push(`the scenario "${id}" could not be built, so nothing here proves the gate catches it`);
    }
  }
  const passes = [];
  // Every committed file any scenario touches, hashed before anything runs.
  const touched = new Map();
  for (const scenario of scenarios) {
    for (const path of scenario.files ?? []) {
      if (!touched.has(path)) touched.set(path, { bytes: readFileSync(path), digest: digestOfFile(path) });
    }
  }
  const temporaryDirectories = [];
  const savedReceiptPath = receiptPath;

  /**
   * One reading of the fact a scenario owns, under a context and a mutation.
   *
   * The control passes an identity mutation, so the "before" reading is taken
   * through exactly the same path as the "after" one. Without that, a scenario
   * whose shape is unsatisfiable would look like one whose injection worked.
   */
  const readFact = async (scenario, mutate) => {
    if (scenario.evidence !== undefined) {
      const built = selfTestEvidenceRoot(baseContext, mutate ?? (() => {}));
      temporaryDirectories.push(built.dir);
      const context = { ...baseContext, evidenceRoot: built.root };
      return observeFact(() => vendorGate('hubspot_target_current', HUBSPOT_FILES, 'HSP-TARGET-01', selfTestObservation(), context));
    }
    if (scenario.universe !== undefined) {
      const built = selfTestUniverse(mutate ?? (() => {}));
      temporaryDirectories.push(built.dir);
      return observeFact(() => offlineUniverse(built.path));
    }
    if (scenario.capacity !== undefined) {
      const records = {};
      for (const mode of CANDIDATE_MODES) records[mode] = selfTestCapacity(baseContext, mode, mode === 'HUBSPOT' ? mutate ?? (() => {}) : () => {}).record;
      return observeFact(() => capacityFor('HUBSPOT', { ...baseContext, capacityOverride: records }));
    }
    if (scenario.matrix !== undefined) {
      const matrix = readJson(join(capacityRoot, 'matrix.json'));
      if (matrix === null) return null;
      const copy = JSON.parse(JSON.stringify(matrix));
      // The committed matrix is MC-2's and carries no capture, so the control
      // would fail for a reason that is not this scenario's. It is given one.
      copy.capture = selfTestCapture(baseContext, { producer: 'tools/capacity.mjs' });
      copy.evidenceSchemaVersion = baseContext.versions.capacityEvidenceSchemaVersion;
      delete copy.candidate;
      const note = (mutate ?? (() => {}))(copy);
      return { entry: await observeFact(() => profileMatrixComplete({ ...baseContext, matrixOverride: copy })), note };
    }
    return null;
  };

  try {
    for (const scenario of scenarios) {
      // A scenario that throws proved nothing, and it must not be able to take
      // the rest of the run with it.
      try {
        let expected = scenario.expect ?? null;
        let before = null;
        let after = null;
        let restored = null;

        if (scenario.receipt !== undefined) {
          const controlBefore = writeTempReceipt(() => {});
          temporaryDirectories.push(controlBefore.dir);
          receiptPath = controlBefore.path;
          before = await observeFact(() => scenario.produce(controlBefore.observation));
          if (before === null || before.value !== true) {
            failures.push(`${scenario.id}: a well-formed receipt was refused — ${String(before && before.detail)}`);
            receiptPath = savedReceiptPath;
            continue;
          }
          const broken = writeTempReceipt(scenario.receipt);
          temporaryDirectories.push(broken.dir);
          if (expected === null) expected = `the workflow declares job "${String(broken.note)}" and the receipt does not carry its conclusion`;
          receiptPath = broken.path;
          // A scenario may take the observation away entirely, which is the
          // forged-receipt case: the file is perfect and nobody asked GitHub.
          const observation = scenario.observation === undefined ? broken.observation : scenario.observation();
          after = await observeFact(() => scenario.produce(observation));
          receiptPath = controlBefore.path;
          restored = await observeFact(() => scenario.produce(controlBefore.observation));
          receiptPath = savedReceiptPath;
        } else if (scenario.evidence !== undefined || scenario.universe !== undefined || scenario.capacity !== undefined || scenario.matrix !== undefined) {
          const mutate = scenario.evidence ?? scenario.universe ?? scenario.capacity ?? scenario.matrix;
          const controlResult = await readFact(scenario, () => {});
          before = scenario.matrix === undefined ? controlResult : controlResult?.entry ?? null;
          if (before === null || before.value !== true) {
            failures.push(`${scenario.id}: the control was refused, so nothing this scenario injects can be the reason — ${String(before && before.detail)}`);
            continue;
          }
          const brokenResult = await readFact(scenario, mutate);
          after = scenario.matrix === undefined ? brokenResult : brokenResult?.entry ?? null;
          // Nothing was written into the tree, so "restored" is the control read
          // a second time: the fact has to be unchanged by the scenario having
          // run at all.
          const restoredResult = await readFact(scenario, () => {});
          restored = scenario.matrix === undefined ? restoredResult : restoredResult?.entry ?? null;
        } else {
          before = await observeFact(scenario.produce);
          expected = scenario.apply();
          after = await observeFact(scenario.produce);
          for (const path of scenario.files ?? []) writeFileSync(path, touched.get(path).bytes);
          restored = await observeFact(scenario.produce);
        }

        const problems = [];
        if (expected === null) problems.push('the scenario declared no phrase its injection would produce');
        if (after === null || after.name !== scenario.fact) problems.push(`the scenario produced ${String(after && after.name)}, not ${scenario.fact}`);
        if (after !== null && after.value !== false) problems.push(`${scenario.fact} stayed ${String(after.value)}`);
        if (after !== null && expected !== null && !after.detail.includes(expected)) {
          problems.push(`${scenario.fact} did not say "${expected}"; it said ${after.detail.slice(0, 240)}`);
        }
        if (before !== null && expected !== null && before.detail.includes(expected)) {
          problems.push(`"${expected}" was already in the detail before the injection, so it proves nothing`);
        }
        if (!closureConsults(scenario.fact)) problems.push(`release_candidate does not consult ${scenario.fact}`);
        if (before !== null && restored !== null && (restored.value !== before.value || restored.detail !== before.detail)) {
          problems.push(`${scenario.fact} did not return to what it said before: ${restored.detail.slice(0, 200)}`);
        }
        if (problems.length === 0) {
          passes.push(scenario);
          process.stderr.write(`  ${scenario.id.padEnd(46)}  ${scenario.fact} -> FALSE, and release_candidate -> FALSE\n`);
        } else {
          failures.push(`${scenario.id}: ${problems.join('; ')}`);
          process.stderr.write(`  ${scenario.id.padEnd(46)}  FAILED: ${problems.join('; ')}\n`);
        }
      } catch (error) {
        failures.push(`${scenario.id} threw: ${String(error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error)}`);
      }
    }
  } finally {
    receiptPath = savedReceiptPath;
    for (const [path, saved] of touched) {
      try {
        writeFileSync(path, saved.bytes);
      } catch (error) {
        failures.push(`${relative(repoRoot, path)} could not be restored: ${String(error && error.message ? error.message : error)}`);
      }
    }
    for (const dir of temporaryDirectories) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A temporary directory outside the repository. Its survival is untidy,
        // not a correctness problem, and reporting it would drown the result.
      }
    }
  }

  // The provenance modes (D76). The preflight is computed while the provenance
  // check runs, so that check has a before-preflight mode that excuses exactly
  // the preflight. What must hold: the mode never writes, the final check names
  // the preflight when it is absent, and the mode does not.
  {
    const provenanceTool = join(repoRoot, 'tools', 'provenance.mjs');
    const alone = run(process.execPath, [provenanceTool, '--before-preflight']);
    if (alone.status !== 2) failures.push(`provenance --before-preflight without --check exited ${String(alone.status)}, not 2; the mode must never write the record`);
    if (!existsSync(join(repoRoot, 'qualification', 'candidate', 'preflight.json'))) {
      const final = run(process.execPath, [provenanceTool, '--check']);
      const early = run(process.execPath, [provenanceTool, '--check', '--before-preflight']);
      if (final.ok || !`${final.stderr}`.includes('qualification/candidate/preflight.json')) {
        failures.push('provenance --check passed or did not name the preflight while the preflight is absent; the final check must require it');
      }
      if (`${early.stderr}`.includes('qualification/candidate/preflight.json')) {
        failures.push('provenance --check --before-preflight still required the preflight');
      }
      process.stderr.write('  provenance modes: the final check requires the preflight, the before-preflight mode excuses only it\n');
    } else {
      process.stderr.write('  provenance modes: preflight present, absence cases not exercised\n');
    }
  }

  // Restoration, checked rather than assumed — twice, and by two different
  // authorities. The digests catch a file put back wrongly; git catches a file
  // this test never knew it touched.
  const notRestored = [];
  for (const [path, saved] of touched) {
    const now = digestOfFile(path);
    if (now !== saved.digest) notRestored.push(`${relative(repoRoot, path)} is ${String(now).slice(0, 12)} and was ${String(saved.digest).slice(0, 12)}`);
  }
  const cleanAfter = treeIsClean();
  if (cleanAfter !== true) notRestored.push(`git reports the tree dirty: ${String(gitOutput(['status', '--porcelain', '-uall'])).trim().slice(0, 400)}`);

  process.stderr.write(`\n  ${String(touched.size)} files mutated and restored, verified by digest and by git\n`);
  if (notRestored.length > 0) {
    process.stderr.write(`\nTHE TREE WAS NOT RESTORED:\n${notRestored.map((problem) => `  - ${problem}`).join('\n')}\n`);
    process.stderr.write('Restore it with "git checkout --" on the paths above before doing anything else.\n\n');
    return 1;
  }
  if (failures.length > 0) {
    process.stderr.write(`\nSELF-TEST = FAIL over ${String(scenarios.length)} scenarios\n${failures.map((f) => `  - ${f}`).join('\n')}\n\n`);
    return 1;
  }
  process.stderr.write(
    `\nSELF-TEST = PASS: ${String(passes.length)} scenarios, each turning its own fact FALSE and release_candidate FALSE, ` +
      'and the tree restored\n\n',
  );
  return 0;
}

// --------------------------------------------------------------------------

async function runGate() {
  const observed = await collect();
  const isCandidate = releaseCandidate(observed);

  // Frozen is not reported here at all any more, and its absence is the point.
  //
  // This used to read `MIGRATION_CORE_IMPLEMENTATION_FROZEN` out of
  // `qualification/candidate/provenance.json` — a file this same tree writes —
  // and report it as a fact with derivation EVIDENCE_VERIFIED. Nothing was
  // verified: a boolean somebody wrote was read back and printed. The freeze is
  // decided by `tools/freeze-verdict.mjs`, outside the tree, from the merged
  // commit, the external CI receipt, the branch protection actually in force,
  // the annotated tag and the release assets as downloaded; this gate names
  // where that happens and says nothing about the answer.
  const reported = [
    ...observed,
    {
      name: 'implementation_frozen',
      value: null,
      derivation: 'DECIDED_ELSEWHERE',
      detail:
        'not decided here and not readable from this tree: tools/freeze-verdict.mjs derives it from the merged SHA, the external ' +
        'CI receipt, the protection in force on main, the annotated tag and the downloaded release assets',
      schema: null,
      digest: null,
      source: 'tools/freeze-verdict.mjs',
    },
    {
      name: 'release_candidate',
      value: isCandidate,
      derivation: 'EXECUTED',
      detail: 'the material conjunction of every fact above, computed here',
      schema: null,
      digest: null,
      source: null,
    },
  ];

  const report = {
    gate: 'RELEASE-CANDIDATE-01',
    coreVersion: JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version,
    digestSerialisationVersion: DIGEST_SERIALISATION_VERSION,
    limits: {
      hardMemoryLimitBytes: LIMITS.hardMemoryLimitBytes,
      memoryBudgetBytes: LIMITS.memoryBudgetBytes,
      hardScratchLimitBytes: LIMITS.hardScratchLimitBytes,
      scratchBudgetBytes: LIMITS.scratchBudgetBytes,
      wallClockLimitMs: LIMITS.wallClockLimitMs,
    },
    // The sort's declared parameters, reported so a reader can see what the
    // traffic was checked against. There is no ratio here any more; see the note
    // on SPOOL_LIMITS for why a constant one could not do this job.
    spoolLimits: SPOOL_LIMITS,
    facts: Object.fromEntries(
      reported.map((entry) => [
        entry.name,
        { value: entry.value, by: entry.derivation, observed: entry.detail, schema: entry.schema, digest: entry.digest, source: entry.source },
      ]),
    ),
    // The instant every freshness judgement in this run was made against, so a
    // reader can re-run the gate over the same artifacts and expect the same
    // verdict.
    judgedAt: nowInstant,
    MIGRATION_CORE_RELEASE_CANDIDATE: isCandidate ? 'TRUE' : 'FALSE',
    MIGRATION_CORE_IMPLEMENTATION_FROZEN: 'DECIDED_ELSEWHERE',
  };

  if (!jsonOnly) {
    process.stderr.write(`\nRELEASE-CANDIDATE-01\n\n`);
    reportFacts(reported);
    process.stderr.write(`\nMIGRATION_CORE_RELEASE_CANDIDATE=${report.MIGRATION_CORE_RELEASE_CANDIDATE}\n`);
    process.stderr.write(
      `MIGRATION_CORE_IMPLEMENTATION_FROZEN=${report.MIGRATION_CORE_IMPLEMENTATION_FROZEN} (tools/freeze-verdict.mjs, outside this tree)\n\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return isCandidate ? 0 : 1;
}

// The rules, exported so an adversary can execute them rather than reimplement
// them. Everything below decides a fact; nothing below writes a file.
export { collect, corpusDigest, crossPlatform, observeVendor, offlineUniverse, provenanceValid, releaseCandidate, vendorCapture, vendorGate };

// --------------------------------------------------------------------------

if (isEntryPoint) {
  // The serialisation is checked before any mode runs. Every digest below rests
  // on it, and a gate that reported a verdict computed with a serialiser that
  // had quietly changed would be reporting about a candidate that does not
  // exist.
  const goldenProblems = serialisationGoldenProblems();
  if (goldenProblems.length > 0) {
    process.stderr.write(`\nthe candidate digest serialisation no longer matches its golden:\n`);
    for (const problem of goldenProblems) process.stderr.write(`  - ${problem}\n`);
    process.stderr.write('\nNo digest this gate computes means what it says until that is resolved.\n\n');
    process.exit(1);
  }

  if (selfTest) process.exit(await runSelfTest());
  if (preflightMode) process.exit(await runPreflight());
  process.exit(await runGate());
}
