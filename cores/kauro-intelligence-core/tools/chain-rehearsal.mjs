#!/usr/bin/env node
/**
 * A small rehearsal of the whole chain, on a subject that says so.
 *
 * Everything CI does to a commit, done here to a disposable copy of the tree
 * with a git subject of its own: install (node_modules linked, offline) and
 * build → typecheck → frozen contracts → tests → sabotage self-test and
 * architecture self-test → sabotage (full) → npm pack and the public consumer
 * → the architecture gate with --out → the receipt, composed by the same code
 * CI uses → a consumer of that receipt that checks the embedded verdict names
 * the rehearsal subject. The label (REHEARSAL, or anything containing it) is
 * on every file written, so nothing here can pass for CI evidence.
 *
 *   node tools/chain-rehearsal.mjs --out <dir outside the tree> [--subject-label REHEARSAL]
 *                                  [--inject-failure sabotage-partial]
 *
 * --inject-failure sabotage-partial removes one record from the sabotage
 * report after the run, as a truncated artifact would; the sabotage job's
 * verify step must refuse it, the chain must exit non-zero with the reason,
 * and the copy must be gone afterwards. Like a `needs` chain, the jobs after
 * the injected failure are recorded as skipped, so the failure path stays
 * short. npm audit needs the network and is not executed here; the offline
 * runtime-dependency budget is.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeReceipt, verifyReceipt } from './compose-receipt.mjs';
import { copyTree, removeTree } from './lib/tree-copy.mjs';
import { currentContext, gitSubject, sha256File, verifySabotageReport } from './lib/verify-sabotage-report.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const label = arg('--subject-label') ?? 'REHEARSAL';
const outDir = arg('--out');
const inject = arg('--inject-failure') ?? null;
if (outDir === undefined) {
  process.stderr.write('usage: chain-rehearsal.mjs --out <dir outside the tree> [--subject-label REHEARSAL] [--inject-failure sabotage-partial]\n');
  process.exit(2);
}
if (!/REHEARSAL/u.test(label)) {
  process.stderr.write(`the subject label must contain REHEARSAL, got ${label}; a rehearsal never passes for anything else\n`);
  process.exit(2);
}
if (inject !== null && inject !== 'sabotage-partial') {
  process.stderr.write(`unknown failure to inject: ${inject}; known: sabotage-partial\n`);
  process.exit(2);
}
const out = resolve(outDir);
const insideTree = !isAbsolute(relative(root, out)) && !relative(root, out).startsWith('..');
if (insideTree) {
  process.stderr.write(`--out ${out} is inside the tree; the evidence of a rehearsal lives outside its subject\n`);
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const dest = join(root, 'tmp', 'chain-rehearsal-tree');

const steps = [];
const jobs = { gate: 'pending', sabotage: 'pending', architecture: 'pending', dependencies: 'pending' };
const producerOutputs = {};
let failure = null;
const run = (cwd, command, cmdArgs, options = {}) => spawnSync(command, cmdArgs, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: process.platform === 'win32' && command === 'npm', timeout: 15 * 60 * 1000, ...options });
/** One step of one job; a failing step fails its job and, after the first, stops the chain. */
const step = async (job, id, body) => {
  if (failure !== null) {
    steps.push({ job, id, ok: false, result: 'skipped', durationMs: 0, detail: `skipped after ${failure.id}` });
    if (jobs[job] === 'pending') jobs[job] = 'skipped';
    return null;
  }
  const started = Date.now();
  let outcome;
  try {
    outcome = await body();
  } catch (error) {
    outcome = { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  const record = { job, id, ok: outcome.ok === true, result: outcome.ok === true ? 'success' : 'failure', durationMs: Date.now() - started, detail: outcome.detail ?? '' };
  steps.push(record);
  process.stderr.write(`  ${record.result.padEnd(8)} ${job.padEnd(13)} ${id.padEnd(30)} ${String(record.durationMs).padStart(7)}ms  ${record.detail.slice(0, 110)}\n`);
  if (!record.ok) {
    jobs[job] = 'failure';
    failure = { job, id, reason: record.detail };
  }
  return outcome.value ?? null;
};
const closeJob = (job) => {
  if (jobs[job] === 'pending') jobs[job] = 'success';
};
const exitOf = (result) => (result.error ? `error ${result.error.message}` : `exit ${String(result.status)}`);
const treeClean = (cwd) => {
  const subject = gitSubject(cwd);
  return { ok: subject.resolved && !subject.dirty, detail: subject.dirty ? `dirty: ${subject.dirtyPaths.join(' | ')}` : 'clean' };
};

process.stderr.write(`\nCHAIN REHEARSAL (${label})\n\n`);
const startedAt = new Date().toISOString();
const sourceSubject = gitSubject(root);
let copy = null;
let receipt = null;
let receiptVerdict = null;
let cleanup = { removed: false, path: dest };
try {
  // Job gate: install and build → typecheck → contracts → tests → consumer → clean tree.
  copy = await step('gate', 'copy-and-link', () => {
    const made = copyTree(root, dest, label);
    return { ok: true, value: made, detail: `subject ${made.commit} (copy of ${String(sourceSubject.commit)}${sourceSubject.dirty ? ', source tree dirty' : ''})` };
  });
  await step('gate', 'install-offline', () => {
    const lock = JSON.parse(readFileSync(join(copy.dest, 'package-lock.json'), 'utf8'));
    const wanted = lock.packages?.['node_modules/typescript']?.version;
    const installed = JSON.parse(readFileSync(join(copy.dest, 'node_modules', 'typescript', 'package.json'), 'utf8')).version;
    return { ok: wanted !== undefined && wanted === installed, detail: `node_modules linked, no network; typescript ${String(installed)} as the lockfile (${String(wanted)}); lockfile sha256 ${sha256File(join(copy.dest, 'package-lock.json')).slice(0, 16)}` };
  });
  await step('gate', 'build', () => {
    const result = run(copy.dest, process.execPath, [join(copy.dest, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json']);
    return { ok: result.status === 0, detail: result.status === 0 ? 'tsc exit 0' : (result.stdout || result.stderr).trim().slice(0, 300) };
  });
  await step('gate', 'typecheck', () => {
    const result = run(copy.dest, process.execPath, [join(copy.dest, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json', '--noEmit']);
    return { ok: result.status === 0, detail: `tsc --noEmit ${exitOf(result)}` };
  });
  await step('gate', 'contracts-check', () => {
    const result = run(copy.dest, process.execPath, ['tools/contracts-check.mjs']);
    return { ok: result.status === 0, detail: `CONTRACTS-01 ${exitOf(result)}` };
  });
  await step('gate', 'tests', () => {
    const result = run(copy.dest, process.execPath, ['tools/run-tests.mjs']);
    const total = (result.stdout.match(/ℹ tests (\d+)/u) ?? [])[1];
    const failed = (result.stdout.match(/ℹ fail (\d+)/u) ?? [])[1];
    return { ok: result.status === 0 && failed === '0', detail: `${String(total)} tests, ${String(failed)} failed, ${exitOf(result)}` };
  });
  await step('gate', 'pack-and-consumer-check', () => {
    const packDir = join(tmpdir(), `kauro-ic-rehearsal-pack-${String(process.pid)}`);
    rmSync(packDir, { recursive: true, force: true });
    mkdirSync(packDir, { recursive: true });
    try {
      const packed = run(copy.dest, 'npm', ['pack', '--silent', '--pack-destination', packDir]);
      const tarball = packed.status === 0 ? readdirSync(packDir).find((name) => name.endsWith('.tgz')) ?? null : null;
      const tarballSha256 = tarball === null ? null : sha256File(join(packDir, tarball));
      const consumer = run(copy.dest, process.execPath, ['tools/consumer-check.mjs']);
      producerOutputs.consumerCheck = { tarball, tarballSha256, stdout: consumer.stdout.trim().split('\n').slice(-1)[0] ?? '' };
      return { ok: tarball !== null && consumer.status === 0, detail: `${String(tarball)} sha256 ${String(tarballSha256).slice(0, 16)}; consumer ${exitOf(consumer)}` };
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });
  await step('gate', 'tree-clean', () => treeClean(copy.dest));
  closeJob('gate');

  // Job sabotage: the two self-tests, the full inventory, the report verified, the tree clean.
  await step('sabotage', 'sabotage-selftest', () => {
    const result = run(copy.dest, process.execPath, ['tools/sabotage-selftest.mjs']);
    return { ok: result.status === 0, detail: `${exitOf(result)}; ${(result.stderr.match(/SABOTAGE SELF-TEST = [^\n]*/u) ?? [''])[0]}` };
  });
  await step('sabotage', 'architecture-selftest', () => {
    const result = run(copy.dest, process.execPath, ['tools/architecture-selftest.mjs']);
    return { ok: result.status === 0, detail: `${exitOf(result)}; ${(result.stderr.match(/ARCHITECTURE SELF-TEST = [^\n]*/u) ?? [''])[0]}` };
  });
  const sabotageReportPath = copy === null ? null : join(copy.dest, 'tmp', 'sabotage-report.json');
  await step('sabotage', 'sabotage-full', () => {
    const result = run(copy.dest, process.execPath, ['tools/sabotage.mjs']);
    return { ok: result.status === 0 && existsSync(sabotageReportPath), detail: `${exitOf(result)}; ${(result.stderr.match(/INTELLIGENCE-SABOTAGE-01 = [^\n]*/u) ?? [''])[0]}` };
  });
  if (inject === 'sabotage-partial') {
    await step('sabotage', 'inject-sabotage-partial', () => {
      const report = JSON.parse(readFileSync(sabotageReportPath, 'utf8'));
      const dropped = report.mutations.pop();
      writeFileSync(sabotageReportPath, `${JSON.stringify(report, null, 2)}\n`);
      return { ok: true, detail: `INJECTED: record ${String(dropped?.id)} removed from the report after the run; counts and passed left as they were` };
    });
  }
  const sabotageReport = await step('sabotage', 'verify-sabotage-report', async () => {
    const report = JSON.parse(readFileSync(sabotageReportPath, 'utf8'));
    producerOutputs.sabotageReport = report;
    const verdict = verifySabotageReport(report, await currentContext(copy.dest));
    return { ok: verdict.ok, value: report, detail: verdict.ok ? `QUALIFICATION on ${report.subject.commit}, ${String(verdict.recomputed.killed)} of ${String(verdict.recomputed.inventory)} recomputed` : `REFUSED: ${verdict.problems.slice(0, 4).join('; ')}` };
  });
  await step('sabotage', 'tree-clean', () => treeClean(copy.dest));
  closeJob('sabotage');

  // Job architecture: the gate with --out, and its verdict bound to the rehearsal subject.
  const verdictPath = copy === null ? null : join(copy.dest, 'tmp', 'architecture-gate.rehearsal.json');
  const verdict = await step('architecture', 'architecture-gate', () => {
    const result = run(copy.dest, process.execPath, ['tools/architecture-gate.mjs', '--out', verdictPath]);
    const report = existsSync(verdictPath) ? JSON.parse(readFileSync(verdictPath, 'utf8')) : null;
    producerOutputs.architectureGate = report;
    return { ok: result.status === 0 && report?.INTELLIGENCE_CORE_ARCHITECTURE_CLOSED === 'TRUE', value: report, detail: `${exitOf(result)}; CLOSED ${String(report?.INTELLIGENCE_CORE_ARCHITECTURE_CLOSED)}; ${String(report?.facts?.filter((entry) => entry.value !== true).map((entry) => entry.name).join(',') || 'all facts true')}` };
  });
  await step('architecture', 'verdict-bound-to-subject', () => ({ ok: verdict?.subject?.commit === copy.commit && verdict?.subject?.tree === copy.tree && verdict?.subject?.dirty === false, detail: `verdict subject ${String(verdict?.subject?.commit)} dirty ${String(verdict?.subject?.dirty)}` }));
  await step('architecture', 'tree-clean', () => treeClean(copy.dest));
  closeJob('architecture');

  // Job dependencies: the offline half of the CI job; npm audit needs the network and is not run.
  await step('dependencies', 'runtime-dependency-budget', () => {
    const pkg = JSON.parse(readFileSync(join(copy.dest, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(copy.dest, 'package-lock.json'), 'utf8'));
    const runtime = Object.keys(pkg.dependencies ?? {});
    const names = Object.keys(lock.packages).filter((key) => key !== '').map((key) => key.replace(/^node_modules\//u, ''));
    const vendored = JSON.parse(readFileSync(join(copy.dest, 'vendor', 'MANIFEST.json'), 'utf8'));
    const allowed = new Set(['typescript', '@types/node', 'undici-types', vendored.name, 'fflate', 'libphonenumber-js']);
    const extra = names.filter((name) => !allowed.has(name));
    const ok = runtime.length === 0 && pkg.peerDependencies?.[vendored.name] === vendored.version && extra.length === 0;
    return { ok, detail: ok ? `no runtime dependencies; peer ${vendored.name} ${vendored.version}; lockfile ${names.sort().join(', ')}; npm audit NOT EXECUTED (network)` : `runtime ${runtime.join(',')}; extra ${extra.join(',')}` };
  });
  closeJob('dependencies');

  // The receipt, composed as CI composes it, then consumed.
  await step('receipt', 'compose-receipt', () => {
    receipt = composeReceipt({
      subjectLabel: label,
      repository: `${label}:${root}`,
      commit: copy.commit,
      tree: copy.tree,
      ref: `refs/heads/${label}`,
      workflow: `intelligence gate (${label})`,
      runId: label,
      runAttempt: label,
      event: label,
      jobs: { ...jobs },
      architecture: verdict,
      sabotage: sabotageReport,
    });
    return { ok: receipt.architecture !== null && receipt.sabotage !== null, detail: `receipt for ${receipt.commit}, jobs ${JSON.stringify(receipt.jobs)}` };
  });
  await step('receipt', 'consume-receipt', () => {
    receiptVerdict = verifyReceipt(receipt, { commit: copy.commit, tree: copy.tree, subjectLabel: label });
    return { ok: receiptVerdict.ok, detail: receiptVerdict.ok ? 'the embedded verdict and sabotage report name the rehearsal subject; every job succeeded; every fact true' : `REFUSED: ${receiptVerdict.problems.slice(0, 4).join('; ')}` };
  });
} catch (error) {
  failure = failure ?? { job: 'chain', id: 'unexpected', reason: error instanceof Error ? error.stack ?? error.message : String(error) };
  steps.push({ job: 'chain', id: 'unexpected', ok: false, result: 'failure', durationMs: 0, detail: failure.reason });
} finally {
  const removed = copy === null ? !existsSync(dest) : removeTree(dest);
  cleanup = { removed: removed && !existsSync(dest), path: dest };
  process.stderr.write(`  ${cleanup.removed ? 'success ' : 'failure '} cleanup       temporary copy removed          ${dest}\n`);
}
for (const job of Object.keys(jobs)) if (jobs[job] === 'pending') jobs[job] = 'skipped';

const ok = failure === null && receiptVerdict?.ok === true && cleanup.removed && (inject === null);
const summary = {
  artifactKind: 'INTELLIGENCE_CORE_CHAIN_REHEARSAL',
  subjectLabel: label,
  rehearsalSubject: copy === null ? null : { commit: copy.commit, tree: copy.tree },
  sourceTree: { path: root, commit: sourceSubject.commit, tree: sourceSubject.tree, dirty: sourceSubject.dirty },
  node: process.version,
  startedAt,
  finishedAt: new Date().toISOString(),
  injectedFailure: inject,
  jobs,
  steps,
  notExecuted: ['npm audit (network)'],
  producerOutputs,
  receiptVerification: receiptVerdict,
  cleanup,
  failure,
  ok,
};
writeFileSync(join(out, 'chain-rehearsal.json'), `${JSON.stringify(summary, null, 2)}\n`);
if (receipt !== null) writeFileSync(join(out, 'ic1-receipt.rehearsal.json'), `${JSON.stringify({ ...receipt, subjectLabel: label }, null, 2)}\n`);
process.stderr.write(`\nCHAIN REHEARSAL (${label}) = ${ok ? 'PASS' : 'FALSE'}${failure === null ? '' : `: ${failure.job}/${failure.id} — ${failure.reason.slice(0, 200)}`}${inject === null ? '' : ' (a failure was injected; FALSE is the expected verdict)'}; copy removed ${String(cleanup.removed)}; written to ${out}\n\n`);
process.stdout.write(`${JSON.stringify({ subjectLabel: label, ok, jobs, failure, cleanup, out }, null, 2)}\n`);
process.exit(ok ? 0 : 1);
