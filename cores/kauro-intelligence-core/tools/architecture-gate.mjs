#!/usr/bin/env node
/**
 * INTELLIGENCE_CORE_ARCHITECTURE_CLOSED, computed from evidence.
 *
 * Every fact below is executed or measured in this checkout; none is read
 * from a constant or from a file somebody left behind. The flag is TRUE only
 * when every fact is true, and a fact that could not be measured is false,
 * never skipped. RELEASE_CANDIDATE and V1_FROZEN are FALSE by construction in
 * IC-1: they need the real provider qualification of IC-2 and the independent
 * freeze of IC-3.
 *
 * The gate binds its verdict to a subject: the commit and tree of a clean
 * checkout. A dirty tree is refused up front — nothing measured on bytes that
 * are not the commit's can be attributed to the commit — and the refusal is
 * itself the first fact. A sabotage report on disk, however recent, is not
 * evidence about this subject until it has been verified against it. By
 * default this gate executes tools/sabotage.mjs itself and verifies the report
 * it just produced against the inventory, the producers and the records
 * (tools/lib/verify-sabotage-report.mjs). With --sabotage-report <path> it
 * does not run sabotage but reuses that one report — and only after the same
 * verifier has accepted it against this exact subject: QUALIFICATION mode, this
 * commit and tree on a clean checkout (and, under GitHub Actions, GITHUB_SHA),
 * the inventory bytes, the runner and driver hashes and every production file
 * hash recomputed here, every id killed, counts recomputed from the records.
 * That is how CI runs the inventory in shards (tools/sabotage-merge.mjs builds
 * the report) without running it twice; a report that does not verify makes
 * sabotage_all_killed false, exactly as a failed run would. There is
 * deliberately no --skip-sabotage: a flag that lowered the gate would be a
 * hole, not a convenience; the only reuse is of a verified report.
 *
 *   node tools/architecture-gate.mjs [--out <path outside the tree>] [--sabotage-report <path>]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { currentContext, sha256File, verifySabotageReport } from './lib/verify-sabotage-report.mjs';
import { consumerObservation } from './lib/consumer-observation.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const suppliedSabotage = args.includes('--sabotage-report') ? args[args.indexOf('--sabotage-report') + 1] : null;
for (const arg of args) {
  if (arg !== '--out' && arg !== out && arg !== '--sabotage-report' && arg !== suppliedSabotage) {
    process.stderr.write(`unknown argument ${arg}; the gate takes only --out <path> and --sabotage-report <path>\n`);
    process.exit(2);
  }
}
if ((args.includes('--out') && (out === undefined || out === null || out.startsWith('--'))) || (args.includes('--sabotage-report') && (suppliedSabotage === undefined || suppliedSabotage === null || suppliedSabotage.startsWith('--')))) {
  process.stderr.write('--out and --sabotage-report each need a path\n');
  process.exit(2);
}
const facts = [];
const fact = (name, value, by, detail) => facts.push({ name, value: value === true, by, detail });
const run = (command, cmdArgs, options = {}) => spawnSync(command, cmdArgs, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: process.platform === 'win32' && command === 'npm', ...options });
const PROBES = ['egress_binding', 'budget_per_request_ceiling', 'run_transitions_closed', 'classifier_email_not_safe', 'compiler_target_outside_envelope'];
/** The facts in the order they are decided; a refusal fills the rest with NOT_EVALUATED so the shape never changes. */
const FACT_NAMES = ['subject_bound', 'typechecks_strict', 'frozen_contracts_verified', 'tests_pass', 'components_exported', 'no_stub_or_io_on_production_path', 'budget_bounds_as_canon', 'model_policy_pinned', ...PROBES.map((name) => `probe_${name}`), 'sabotage_all_killed', 'sabotage_report_bound_to_subject', 'public_consumer_compiles_and_runs', 'consumer_report_bound', 'documents_present'];

// Producers and dependencies: what decided, byte for byte.
const PRODUCERS = ['tools/architecture-gate.mjs', 'tools/sabotage.mjs', 'tools/run-tests.mjs', 'tools/contracts-check.mjs', 'tools/consumer-check.mjs', 'tools/behavioural-probes.mjs', 'tools/lib/verify-sabotage-report.mjs', 'package-lock.json', 'tsconfig.json', 'vendor/MANIFEST.json'];
const producers = {};
for (const producer of PRODUCERS) producers[producer] = existsSync(join(root, producer)) ? sha256File(join(root, producer)) : null;
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const dependencyClosure = Object.entries(lock.packages ?? {}).filter(([path]) => path !== '').map(([path, entry]) => ({ name: path.replace(/^.*node_modules\//u, ''), version: String(entry.version ?? ''), resolved: entry.resolved ?? null, integrity: entry.integrity ?? null })).sort((a, b) => a.name.localeCompare(b.name));

// 0. The subject. Nothing else is decided on an unbound one.
const current = await currentContext(root);
const subject = { commit: current.subject.commit, tree: current.subject.tree, dirty: current.subject.dirty };
fact('subject_bound', current.subject.resolved && !current.subject.dirty, 'MEASURED', !current.subject.resolved ? 'no git subject: HEAD, HEAD^{tree} or status did not resolve' : current.subject.dirty ? `the tree is dirty: ${current.subject.dirtyPaths.slice(0, 6).join(' | ')}` : `commit ${current.subject.commit} tree ${current.subject.tree}, clean`);

let sabotageEvidence = null;
let consumerEvidence = null;
if (facts[0].value) {
  // 1. Build and typecheck, strict.
  const build = run(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.json')]);
  fact('typechecks_strict', build.status === 0, 'EXECUTED', build.status === 0 ? 'tsc -p tsconfig.json exit 0 under strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess' : (build.stdout || build.stderr).trim().slice(0, 300));

  // 2. The frozen Migration Core contracts, checked.
  const contracts = run(process.execPath, ['tools/contracts-check.mjs']);
  fact('frozen_contracts_verified', contracts.status === 0, 'EXECUTED', contracts.status === 0 ? 'CONTRACTS-01 PASS: tarball digest, lockfile, exported versions inside declared ranges, every imported name present' : (contracts.stderr || contracts.stdout).trim().slice(-300));

  // 3. The suite, with its counts read off the run.
  const tests = run(process.execPath, ['tools/run-tests.mjs']);
  const total = Number((tests.stdout.match(/ℹ tests (\d+)/u) ?? [])[1] ?? 0);
  const failed = Number((tests.stdout.match(/ℹ fail (\d+)/u) ?? [])[1] ?? -1);
  fact('tests_pass', tests.status === 0 && failed === 0 && total > 0, 'EXECUTED', `${String(total)} tests, ${String(failed)} failed, exit ${String(tests.status)}`);

  // 4. Every component the canon names exists and is exported through the public entry:
  // read off the built module, not off the text of index.ts, so a re-export through
  // `export *` counts and a name that is only mentioned in a comment does not.
  const entry = build.status === 0 ? await import(pathToFileURL(join(root, 'dist', 'src', 'index.js')).href).catch(() => ({})) : {};
  const REQUIRED_EXPORTS = ['createIntelligenceCore', 'adaptContracts', 'resolveDeterministically', 'planTasks', 'buildEnvelope', 'decideEgress', 'assertEgressBinds', 'classifyValue', 'minimize', 'resolveMemory', 'memoryCandidateFrom', 'promoteCandidate', 'MODEL_POLICY_V1', 'PROMPT_BUNDLE_V1', 'scriptedGateway', 'replayGateway', 'transportGateway', 'buildProviderRequest', 'parseProviderResponse', 'parseProposal', 'compileProposal', 'RunLedger', 'VirtualClock', 'BUDGET_LIMITS', 'RUN_TRANSITIONS', 'ENVELOPE_SCHEMA', 'PROPOSAL_SCHEMA', 'proposalJsonSchema', 'compatibilityMatrix', 'sealExpectedTruth', 'scoreFixture', 'benchmarkReport', 'IntelligenceError'];
  const missingExports = REQUIRED_EXPORTS.filter((name) => !(name in entry));
  // The second declared entry point, read off the built module through the package name (B04 D4-CAMP-5): what a campaign needs and nothing deeper is importable.
  const BENCHMARK_EXPORTS = ['verifyCorpus', 'scoreFixture', 'benchmarkReport', 'bindRun', 'qualifyThreeRuns', 'CampaignAdmission', 'bedrockGateway', 'signV4', 'toBedrockBody', 'vertexGateway', 'selectFromPilot', 'candidatePolicyOf', 'SONNET_5_5_US', 'OPUS_5_5_US', 'createIntelligenceCore'];
  const benchmarkEntry = build.status === 0 ? await import('kauro-intelligence-core/benchmark').catch(() => ({})) : {};
  missingExports.push(...BENCHMARK_EXPORTS.filter((name) => !(name in benchmarkEntry)).map((name) => `benchmark:${name}`));
  const deepImport = build.status === 0 ? await import('kauro-intelligence-core/dist/src/benchmark/scorer.js').then(() => 'IMPORTED', (error) => error.code) : 'NOT_BUILT';
  if (deepImport !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') missingExports.push(`a deep path import answered ${String(deepImport)}`);
  fact('components_exported', missingExports.length === 0, 'MEASURED', missingExports.length === 0 ? `${String(REQUIRED_EXPORTS.length)} component names present on the built public entry` : `missing ${missingExports.join(', ')}`);

  // 5. No TODO, stub or placeholder on the production path; no provider SDK, no network call, no filesystem write in src.
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts')) files.push(path);
    }
  };
  walk(join(root, 'src'));
  const offenders = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const rel = file.slice(root.length + 1).replace(/\\/gu, '/');
    // A marker is a comment that says work is missing; the same letters inside a
    // string are data (ISO 4217 lists XXX as "no currency").
    if (/(?:\/\/|\/\*|^\s*\*)\s*[^\n]*?\b(TODO|FIXME|XXX|HACK)\b/mu.test(text)) offenders.push(`${rel}: TODO/FIXME marker`);
    if (/\bnot implemented\b|throw new Error\('stub/iu.test(text)) offenders.push(`${rel}: stub`);
    if (/from '@anthropic-ai|from '@google-cloud|from 'openai'|require\('https'\)|from 'node:https'|from 'node:http'|fetch\(/u.test(text)) offenders.push(`${rel}: provider SDK or network call in the core`);
    if (/from 'node:fs'|writeFileSync|readFileSync/u.test(text)) offenders.push(`${rel}: filesystem access in the core`);
    if (/from 'node:child_process'/u.test(text)) offenders.push(`${rel}: child process in the core`);
  }
  fact('no_stub_or_io_on_production_path', offenders.length === 0, 'MEASURED', offenders.length === 0 ? `${String(files.length)} source files: no TODO, stub, SDK, network, filesystem or shell` : offenders.slice(0, 8).join('; '));

  // 6. Bounds as the canon fixes them, read off the built constant the ledger enforces, not off the source text.
  const bounds = [['MAX_SEMANTIC_TASKS_PER_AUDIT', 32], ['MAX_SEMANTIC_ATTEMPTS_PER_TASK', 2], ['MAX_TRANSPORT_RETRIES_PER_REQUEST', 2], ['MAX_INPUT_TOKENS_PER_REQUEST', 200_000], ['MAX_OUTPUT_TOKENS_PER_REQUEST', 8_192], ['MAX_TOTAL_BILLED_INPUT_TOKENS_PER_AUDIT', 2_000_000], ['MAX_TOTAL_BILLED_OUTPUT_TOKENS_PER_AUDIT', 131_072], ['MAX_INTELLIGENCE_WALL_CLOCK_MS', 20 * 60 * 1000]];
  const limits = entry.BUDGET_LIMITS ?? {};
  const wrongBounds = bounds.filter(([name, value]) => limits[name] !== value);
  const extraBounds = Object.keys(limits).filter((name) => !bounds.some(([known]) => known === name));
  fact('budget_bounds_as_canon', wrongBounds.length === 0 && extraBounds.length === 0 && Object.isFrozen(limits), 'MEASURED', wrongBounds.length === 0 && extraBounds.length === 0 ? 'eight bounds of canon §61 on the built BUDGET_LIMITS, frozen, no ninth' : `differ: ${[...wrongBounds.map(([name]) => name), ...extraBounds].join(', ')}`);

  // 7. Model policy pinned as decided, read off the built policy object the gateway sends.
  const policy = entry.MODEL_POLICY_V1 ?? {};
  const pins = [['platform', 'AWS_BEDROCK_MANAGED_MODEL'], ['primaryModel', 'claude-sonnet-5-5'], ['location', 'US_MULTI_REGION'], ['effort', 'HIGH'], ['tools', 'NONE'], ['web', 'OFF'], ['computer', 'OFF'], ['modelMemory', 'OFF'], ['requestResponseLogging', 'OFF'], ['promptCache', 'OFF'], ['customerBatch', 'OFF'], ['automaticFailover', 'OFF'], ['secondaryModel', 'NONE']];
  const missingPins = pins.filter(([name, value]) => policy[name] !== value);
  fact('model_policy_pinned', missingPins.length === 0 && Object.isFrozen(policy), 'MEASURED', missingPins.length === 0 ? `canon §52 policy pinned on the built MODEL_POLICY_V1 (${String(pins.length)} pins); secondary NONE` : `missing ${missingPins.map(([name]) => name).join(', ')}`);

  // 8. Behavioural probes on the built public entry: refusals exercised, not names counted.
  const probeRun = run(process.execPath, ['tools/behavioural-probes.mjs']);
  let probeReport = null;
  try {
    probeReport = JSON.parse(probeRun.stdout);
  } catch {
    probeReport = null;
  }
  for (const name of PROBES) {
    const result = probeReport?.probes?.find((entry) => entry.name === name) ?? null;
    fact(`probe_${name}`, result?.ok === true && probeRun.status === 0, 'EXECUTED', result === null ? `no result: ${(probeRun.stderr || probeRun.stdout).trim().slice(-200)}` : result.detail);
  }

  // 9. Sabotage: executed here (default), or a supplied report — then verified either way: subject, inventory bytes, producers, production files, records, recomputed counts.
  const sabotage = suppliedSabotage === null ? run(process.execPath, ['tools/sabotage.mjs']) : null;
  const reportPath = suppliedSabotage === null ? join(root, 'tmp', 'sabotage-report.json') : resolve(suppliedSabotage);
  let sabotageReport = null;
  try {
    sabotageReport = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    sabotageReport = null;
  }
  const verdict = verifySabotageReport(sabotageReport, await currentContext(root));
  // Under GitHub Actions the report must also name the commit the workflow was started for.
  if (suppliedSabotage !== null && process.env.GITHUB_ACTIONS === 'true' && sabotageReport?.subject?.commit !== process.env.GITHUB_SHA) verdict.problems.push(`the supplied report's subject ${String(sabotageReport?.subject?.commit)} is not GITHUB_SHA ${String(process.env.GITHUB_SHA)}`);
  verdict.ok = verdict.problems.length === 0;
  const counts = verdict.recomputed;
  const origin = suppliedSabotage === null ? 'EXECUTED_HERE' : 'SUPPLIED_AND_VERIFIED';
  sabotageEvidence = sabotageReport === null ? null : { origin, reportSha256: sha256File(reportPath), mode: sabotageReport.mode, subject: sabotageReport.subject, ...(sabotageReport.merged === undefined ? {} : { mergedFrom: { shards: sabotageReport.merged.shards, inventoryDigest: sabotageReport.merged.inventoryDigest } }), counts, problems: verdict.problems };
  fact('sabotage_all_killed', (sabotage === null || sabotage.status === 0) && verdict.ok, sabotage === null ? 'VERIFIED' : 'EXECUTED', sabotageReport === null ? `no sabotage report${sabotage === null ? ` at ${reportPath}` : `: ${sabotage.stderr.trim().slice(-200)}`}` : `${String(counts?.killed)} killed of ${String(counts?.inventory)} (recomputed from ${String(sabotageReport.mutations?.length ?? 0)} records); survived ${String(counts?.survived)}, did not compile ${String(counts?.didNotCompile)}, infra ${String(counts?.infraError)}, not reached ${String(counts?.notReached)}; ${sabotage === null ? `supplied report ${sha256File(reportPath).slice(0, 12)}${sabotageReport.merged === undefined ? '' : ` merged from ${String(sabotageReport.merged.shards)} shards`}, not run here` : `runner exit ${String(sabotage.status)}`}`);
  fact('sabotage_report_bound_to_subject', verdict.ok, 'MEASURED', verdict.ok ? `QUALIFICATION report on commit ${String(sabotageReport.subject?.commit)}, clean; inventory ${sabotageReport.inventory.files.map((entry) => `${entry.file}=${entry.sha256.slice(0, 12)}`).join(',')}; producers and production files hash as in the tree` : verdict.problems.slice(0, 6).join('; '));

  // 10. The public consumer, from the packed tarball, in a TypeScript strict project outside the tree;
  // the tarball it consumed is identified by digest, packed again here from the same bytes.
  const consumer = run(process.execPath, ['tools/consumer-check.mjs']);
  fact('public_consumer_compiles_and_runs', consumer.status === 0, 'EXECUTED', consumer.status === 0 ? consumer.stdout.trim().split('\n').slice(-1)[0] : (consumer.stderr || consumer.stdout).trim().slice(-300));
  consumerEvidence = bindConsumer(consumer);
  fact('consumer_report_bound', consumerEvidence.bound, 'MEASURED', consumerEvidence.detail);

  // 11. Documentation present.
  const docs = ['docs/REQUIREMENTS_MAP.md', 'docs/THREAT_MODEL.md', 'docs/COMPATIBILITY_MATRIX.md', 'docs/IC2_READINESS.md', 'docs/ADR/README.md', 'docs/authorities/REGISTRY.md'];
  const missingDocs = docs.filter((doc) => !existsSync(join(root, doc)));
  fact('documents_present', missingDocs.length === 0, 'MEASURED', missingDocs.length === 0 ? docs.length + ' documents' : `missing ${missingDocs.join(', ')}`);
}
for (const name of FACT_NAMES) if (!facts.some((entry) => entry.name === name)) fact(name, false, 'NOT_EVALUATED', 'not evaluated: the subject is not bound');

/**
 * The consumer's own line, parsed for what it says; the packed tarball and
 * the vendored Migration Core tarball, hashed here. When the consumer prints
 * digests of its own they must agree with the ones computed here.
 */
function bindConsumer(consumer) {
  const observed = consumerObservation(consumer.stdout);
  const packDir = join(tmpdir(), `kauro-ic-gate-pack-${String(process.pid)}`);
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });
  let tarballSha256 = null;
  let tarballName = null;
  try {
    const packed = run('npm', ['pack', '--silent', '--pack-destination', packDir]);
    tarballName = packed.status === 0 ? readdirSync(packDir).find((name) => name.endsWith('.tgz')) ?? null : null;
    tarballSha256 = tarballName === null ? null : sha256File(join(packDir, tarballName));
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
  const manifest = JSON.parse(readFileSync(join(root, 'vendor', 'MANIFEST.json'), 'utf8'));
  const mcTarballSha256 = existsSync(join(root, manifest.file)) ? sha256File(join(root, manifest.file)) : null;
  const problems = [];
  if (consumer.status !== 0) problems.push(`consumer exit ${String(consumer.status)}`);
  if (observed === null) problems.push('the consumer printed no observation');
  if (tarballSha256 === null) problems.push('npm pack produced no tarball to hash');
  if (mcTarballSha256 !== manifest.sha256) problems.push('the vendored Migration Core tarball does not hash as its manifest says');
  if (observed !== null && observed.mcCore !== manifest.version) problems.push(`the consumer ran Migration Core ${String(observed.mcCore)}, the manifest says ${manifest.version}`);
  const printed = observed === null ? {} : Object.fromEntries(Object.entries(observed).filter(([key]) => /sha256/iu.test(key)));
  for (const [key, value] of Object.entries(printed)) {
    if (/mc|migration/iu.test(key) ? value !== mcTarballSha256 : value !== tarballSha256) problems.push(`the consumer reports ${key}=${String(value).slice(0, 12)}, the gate hashes ${String((/mc|migration/iu.test(key) ? mcTarballSha256 : tarballSha256) ?? '').slice(0, 12)}`);
  }
  const bound = problems.length === 0;
  return { bound, tarball: tarballName, tarballSha256, migrationCoreTarball: manifest.file, migrationCoreTarballSha256: mcTarballSha256, observed, consumerPrintedDigests: printed, detail: bound ? `tarball ${String(tarballName)} sha256 ${String(tarballSha256).slice(0, 16)}…; Migration Core ${manifest.version} sha256 ${String(mcTarballSha256).slice(0, 16)}…; consumer observed ${JSON.stringify(observed)}` : problems.join('; ') };
}

const closed = facts.length === FACT_NAMES.length && facts.every((entry) => entry.value === true);
const report = {
  artifactKind: 'INTELLIGENCE_CORE_ARCHITECTURE_GATE',
  gate: 'INTELLIGENCE-ARCHITECTURE-01',
  decidedAt: `${new Date().toISOString().slice(0, 19)}Z`,
  subject,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  producers,
  dependencyClosure,
  sabotage: sabotageEvidence,
  consumer: consumerEvidence === null ? null : { tarball: consumerEvidence.tarball, tarballSha256: consumerEvidence.tarballSha256, migrationCoreTarball: consumerEvidence.migrationCoreTarball, migrationCoreTarballSha256: consumerEvidence.migrationCoreTarballSha256, observed: consumerEvidence.observed },
  facts,
  INTELLIGENCE_CORE_ARCHITECTURE_CLOSED: closed ? 'TRUE' : 'FALSE',
  INTELLIGENCE_CORE_RELEASE_CANDIDATE: 'FALSE',
  INTELLIGENCE_CORE_V1_FROZEN: 'FALSE',
  note: 'RELEASE_CANDIDATE and V1_FROZEN are FALSE by construction in IC-1: they need OPUS-Q1, AI-BUDGET-01 and the independent freeze of IC-2/IC-3. Sabotage evidence is executed by this gate, or reused only as a report verified against this exact subject (--sabotage-report); it is never trusted from disk unverified.',
};
const width = Math.max(...facts.map((entry) => entry.name.length));
process.stderr.write('\nINTELLIGENCE-ARCHITECTURE-01\n\n');
for (const entry of facts) process.stderr.write(`  ${entry.name.padEnd(width)}  ${String(entry.value).padEnd(6)} [${entry.by}] ${entry.detail}\n`);
process.stderr.write(`\nINTELLIGENCE_CORE_ARCHITECTURE_CLOSED = ${report.INTELLIGENCE_CORE_ARCHITECTURE_CLOSED} (subject ${String(subject.commit)}${subject.dirty ? ', dirty' : ''})\n\n`);
if (out !== null) {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(closed ? 0 : 1);
