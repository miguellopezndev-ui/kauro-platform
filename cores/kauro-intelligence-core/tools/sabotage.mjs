#!/usr/bin/env node
/**
 * Sabotage: each material gate is broken in turn and the suite must kill it.
 *
 * Copies of the tree are made under tmp/sabotage-tree-<k> (one per worker, see
 * Jobs below), one mutation is applied to a source file in a copy, the copy
 * is built and its tests run, and the outcome is classified: KILLED when the suite fails on an assertion,
 * SURVIVED when it passes, DID_NOT_COMPILE when the build fails, INFRA_ERROR
 * when the runner itself failed or the run timed out. Only KILLED counts; a
 * mutation that did not compile, timed out or could not run is not a kill. A
 * healthy baseline must pass first or nothing here means anything. Nothing
 * under the real tree is touched.
 *
 * Jobs: --jobs N (default min(4, os.availableParallelism())) runs N mutations
 * at once, each worker in its own copy, built once with node_modules linked.
 * Concurrency changes only the wall clock, never the meaning: every mutation
 * still runs the whole suite, the baseline must pass in every copy before that
 * copy takes a mutation, a worker restores the pristine bytes before applying
 * each mutation, results are collected and the report written in inventory
 * order (byte-for-byte deterministic apart from timings), and the value used
 * is recorded as "jobs". A run that exceeds RUN_TIMEOUT_MS has its whole
 * process tree killed (taskkill /T on Windows, the process group elsewhere).
 * Every copy is removed at the end, on failure and on a signal too.
 *
 * Three modes, three files, never confused:
 *
 *   node tools/sabotage.mjs --shard k/n    QUALIFICATION-SHARD — mutation number p of
 *                                          the inventory (0-based, inventory order)
 *                                          when p mod n = k-1; writes
 *                                          tmp/sabotage-shard-k-of-n.json, which never
 *                                          qualifies alone (qualifies:false).
 *                                          tools/sabotage-merge.mjs turns all n of them
 *                                          into the one QUALIFICATION report and
 *                                          refuses a missing, repeated or foreign
 *                                          shard. Each mutation still runs the whole
 *                                          suite on the exact commit and must be
 *                                          killed; the shard exits 0 only when every
 *                                          mutation of its slice is. Not combinable
 *                                          with --only.
 *
 *   node tools/sabotage.mjs                QUALIFICATION — the whole inventory;
 *                                          writes tmp/sabotage-report.json,
 *                                          exit 0 only when every id is killed.
 *   node tools/sabotage.mjs --only a,b     DIAGNOSTIC — the ids named, for a
 *                                          developer; writes
 *                                          tmp/sabotage-diagnostic.json with
 *                                          qualifies:false and passed:false,
 *                                          exit 0 when the selection is killed.
 *                                          An unknown or empty selection is
 *                                          exit 2, not an empty PASS.
 *
 * The qualification report binds itself to what it measured: the commit and
 * tree it ran on and whether the tree was clean, the digests of the inventory
 * files, of this runner and the test driver, and of every production file
 * before mutation; and its counts come from unique reached ids, so a partial
 * or edited record set cannot add up to the inventory.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SABOTAGE_GATE, gitSubject, loadInventory, producerHashes, qualifies, recount, sha256File } from './lib/verify-sabotage-report.mjs';
import { SHARD_MODE, inventoryDigest, parseShard, selectShard } from './lib/sabotage-shards.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const copyOf = (k) => join(root, 'tmp', `sabotage-tree-${String(k)}`);
// A build-and-test that has not finished in thirty minutes is broken infrastructure, not a kill.
// Concurrent suites on a four-vCPU runner must not be mistaken for a hang.
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

const args = process.argv.slice(2);
const selected = [];
let jobs = Math.min(4, availableParallelism());
let shard = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--only') {
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      process.stderr.write('--only needs one or more mutation ids (comma-separated)\n');
      process.exit(2);
    }
    selected.push(...value.split(',').map((id) => id.trim()).filter((id) => id !== ''));
    i += 1;
  } else if (args[i] === '--jobs') {
    const value = args[i + 1];
    if (value === undefined || !/^[1-9][0-9]{0,2}$/u.test(value)) {
      process.stderr.write('--jobs needs a positive integer\n');
      process.exit(2);
    }
    jobs = Number(value);
    i += 1;
  } else if (args[i] === '--shard') {
    shard = parseShard(args[i + 1]);
    if (shard === null) {
      process.stderr.write('--shard needs k/n with 1 <= k <= n (for example 3/12)\n');
      process.exit(2);
    }
    i += 1;
  } else {
    process.stderr.write(`unknown argument ${args[i]}\n`);
    process.exit(2);
  }
}
if (shard !== null && args.includes('--only')) {
  process.stderr.write('--shard and --only cannot be combined: a shard is a slice of the qualification run, --only is a developer diagnostic\n');
  process.exit(2);
}
const mode = args.includes('--only') ? 'DIAGNOSTIC' : shard !== null ? SHARD_MODE : 'QUALIFICATION';

let inventory;
try {
  inventory = await loadInventory(root);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
const MUTATIONS = inventory.mutations;
if (MUTATIONS.length === 0) {
  process.stderr.write('the inventory is empty; an empty inventory qualifies nothing\n');
  process.exit(2);
}
if (mode === 'DIAGNOSTIC') {
  const known = new Set(MUTATIONS.map((mutation) => mutation.id));
  const unknown = selected.filter((id) => !known.has(id));
  if (selected.length === 0 || unknown.length > 0) {
    process.stderr.write(`--only names ${selected.length === 0 ? 'no mutation' : `unknown mutation(s) ${unknown.join(', ')}`}; the inventory has: ${[...known].join(', ')}\n`);
    process.exit(2);
  }
}
if (shard !== null && shard.count > MUTATIONS.length) {
  process.stderr.write(`--shard ${String(shard.index)}/${String(shard.count)}: ${String(shard.count)} shards over ${String(MUTATIONS.length)} mutations would leave a shard empty\n`);
  process.exit(2);
}
const chosen = mode === 'DIAGNOSTIC' ? MUTATIONS.filter((mutation) => selected.includes(mutation.id)) : mode === SHARD_MODE ? selectShard(MUTATIONS, shard) : MUTATIONS;

function run(command, cmdArgs, options = {}) {
  return spawnSync(command, cmdArgs, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: process.platform === 'win32' && command === 'npm', ...options });
}

function classify(result) {
  if (result.error?.code === 'ETIMEDOUT' || (result.error !== undefined && result.signal !== null)) return { outcome: 'INFRA_ERROR', detail: `TIMEOUT after ${String(RUN_TIMEOUT_MS)}ms`, timedOut: true };
  if (result.error) return { outcome: 'INFRA_ERROR', detail: String(result.error.message) };
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (/build exited|error TS\d+/u.test(out)) return { outcome: 'DID_NOT_COMPILE', detail: (out.match(/error TS\d+[^\n]*/u) ?? ['tsc failed'])[0] };
  const fail = out.match(/ℹ fail (\d+)/u);
  const pass = out.match(/ℹ pass (\d+)/u);
  if (fail === null || pass === null) return { outcome: 'INFRA_ERROR', detail: 'no test summary in the output' };
  if (Number(fail[1]) > 0) return { outcome: 'KILLED', detail: `${fail[1]} of ${String(Number(fail[1]) + Number(pass[1]))} tests failed` };
  return { outcome: 'SURVIVED', detail: `${pass[1]} tests passed` };
}

// Kill the whole tree of a run: the runner spawns node, tsc and the test processes.
function killTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

// One build-and-test in a copy, with a timeout that kills the process tree. Shaped like a spawnSync result for classify().
function suite(cwd) {
  return new Promise((resolvePromise) => {
    const out = [];
    const err = [];
    let timedOut = false;
    let done = false;
    const child = spawn(process.execPath, ['tools/run-tests.mjs'], { cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, RUN_TIMEOUT_MS);
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => finish({ error, signal: null }));
    child.on('close', (status, signal) => {
      if (timedOut) finish({ error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), signal: 'SIGKILL' });
      else finish({ status, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

async function timed(fn) {
  const started = Date.now();
  const value = await fn();
  return { ...value, durationMs: Date.now() - started };
}

// What the report binds to, read before anything is copied or built.
const startedAt = new Date().toISOString();
const subject = gitSubject(root);
const producers = producerHashes(root);
const productionFiles = [...new Set(MUTATIONS.map((mutation) => mutation.file))].sort().map((file) => ({ file, sha256: sha256File(join(root, file)) }));
const reportPath = join(root, 'tmp', mode === 'QUALIFICATION' ? 'sabotage-report.json' : mode === SHARD_MODE ? `sabotage-shard-${String(shard.index)}-of-${String(shard.count)}.json` : 'sabotage-diagnostic.json');
mkdirSync(join(root, 'tmp'), { recursive: true });
// A stale qualification report (or shard report) must not outlive the start of a new run.
if (mode !== 'DIAGNOSTIC') rmSync(reportPath, { force: true });

const workers = Math.min(jobs, chosen.length);
const copies = Array.from({ length: workers }, (_, k) => copyOf(k));
function removeCopy(dir) {
  // The junction is removed as a link first, never followed into the real node_modules.
  try {
    rmSync(join(dir, 'node_modules'), { recursive: false, force: true });
  } catch {
    // a real directory or nothing there; the recursive removal below handles it
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
const cleanup = () => {
  for (const dir of copies) removeCopy(dir);
};
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(130));

function prepare(copy) {
  removeCopy(copy);
  mkdirSync(copy, { recursive: true });
  for (const entry of ['src', 'test', 'tools', 'vendor', 'package.json', 'package-lock.json', 'tsconfig.json', '.npmrc']) cpSync(join(root, entry), join(copy, entry), { recursive: true });
  // Main's design checks read the release documents as test input.
  if (existsSync(join(root, 'docs'))) cpSync(join(root, 'docs'), join(copy, 'docs'), { recursive: true });
  // node_modules by junction/symlink: the same dependencies, no reinstall.
  run(process.platform === 'win32' ? 'cmd' : 'ln', process.platform === 'win32' ? ['/c', 'mklink', '/J', join(copy, 'node_modules'), join(root, 'node_modules')] : ['-s', join(root, 'node_modules'), join(copy, 'node_modules')]);
  if (!existsSync(join(copy, 'node_modules', 'typescript'))) {
    process.stderr.write('could not link node_modules into the sabotage copy\n');
    process.exit(2);
  }
}
for (const copy of copies) prepare(copy);

// The baseline runs first, in every copy, before any copy takes a mutation.
const baselines = await Promise.all(copies.map((copy) => timed(async () => classify(await suite(copy)))));
const failedBaseline = baselines.find((entry) => entry.outcome !== 'SURVIVED');
if (failedBaseline !== undefined) {
  process.stderr.write(`the baseline does not pass (${failedBaseline.outcome}: ${failedBaseline.detail}); a kill against a broken baseline proves nothing\n`);
  process.exit(1);
}
// The report carries the first copy's baseline; every copy's passed.
const baseline = baselines[0];

const results = new Array(chosen.length);
let next = 0;
async function worker(copy) {
  while (next < chosen.length) {
    const index = next;
    next += 1;
    const mutation = chosen[index];
    const path = join(copy, mutation.file);
    const original = readFileSync(join(root, mutation.file), 'utf8');
    const record = { id: mutation.id, inventoryFile: mutation.inventoryFile, file: mutation.file, gate: mutation.gate };
    if (!original.includes(mutation.from)) {
      results[index] = { ...record, outcome: 'NOT_REACHED', detail: 'the text to mutate is not in the file; the mutation is stale', durationMs: 0 };
      process.stderr.write(`  ${'NOT_REACHED'.padEnd(15)} ${mutation.id.padEnd(36)} stale\n`);
      continue;
    }
    // Pristine bytes first, then the mutation; restored after, so a copy is never left mutated.
    writeFileSync(path, original);
    writeFileSync(path, original.replace(mutation.from, mutation.to));
    const outcome = await timed(async () => classify(await suite(copy)));
    writeFileSync(path, original);
    results[index] = { ...record, ...outcome };
    process.stderr.write(`  ${outcome.outcome.padEnd(15)} ${mutation.id.padEnd(36)} ${outcome.detail} (${String(outcome.durationMs)}ms)\n`);
  }
}
await Promise.all(copies.map((copy) => worker(copy)));
cleanup();

// Counts over unique reached ids of the whole inventory, in both modes: a
// diagnostic over one id therefore reports the other ids as not reached.
// A shard counts over its own slice and never qualifies on its own: only the merge of all shards does.
const recomputed = recount(results, (mode === SHARD_MODE ? chosen : MUTATIONS).map((mutation) => mutation.id));
const counts = recomputed.counts;
const passed = qualifies(mode === SHARD_MODE ? 'QUALIFICATION' : mode, baseline, counts, recomputed.missing);
const selectionKilled = chosen.length > 0 && chosen.every((mutation) => results.find((result) => result.id === mutation.id)?.outcome === 'KILLED');
const report = {
  gate: SABOTAGE_GATE,
  mode,
  // A diagnostic never qualifies, whatever it killed; a consumer that wants qualification reads this field, not passed.
  qualifies: mode === SHARD_MODE ? false : passed,
  ...(mode === SHARD_MODE ? { shard } : {}),
  subject,
  node: process.version,
  startedAt,
  finishedAt: new Date().toISOString(),
  inventory: { files: inventory.files, ids: MUTATIONS.map((mutation) => ({ id: mutation.id, inventoryFile: mutation.inventoryFile, file: mutation.file, gate: mutation.gate })) },
  ...(mode === SHARD_MODE ? { inventoryDigest: inventoryDigest(inventory.files, MUTATIONS), selection: { ids: chosen.map((mutation) => mutation.id) } } : {}),
  producers,
  productionFiles,
  jobs,
  baseline,
  ...(mode === 'DIAGNOSTIC' ? { selection: { requested: selected, allKilled: selectionKilled } } : {}),
  counts,
  mutations: results,
  passed,
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (mode === SHARD_MODE) {
  process.stderr.write(`\n${SABOTAGE_GATE} SHARD ${String(shard.index)}/${String(shard.count)} = ${passed ? 'PASS' : 'FALSE'}: ${String(counts.killed)} killed of ${String(chosen.length)} (survived ${String(counts.survived)}, did not compile ${String(counts.didNotCompile)}, infra ${String(counts.infraError)}, not reached ${String(counts.notReached)}); does not qualify alone, written to ${reportPath}${subject.dirty ? '; the tree was dirty' : ''}\n`);
  process.exit(passed ? 0 : 1);
}
if (mode === 'QUALIFICATION') {
  process.stderr.write(`\n${SABOTAGE_GATE} = ${passed ? 'PASS' : 'FALSE'}: ${String(counts.killed)} killed of ${String(MUTATIONS.length)} (survived ${String(counts.survived)}, did not compile ${String(counts.didNotCompile)}, infra ${String(counts.infraError)}, not reached ${String(counts.notReached)})${subject.dirty ? '; the tree was dirty' : ''}\n`);
  process.exit(passed ? 0 : 1);
}
process.stderr.write(`\n${SABOTAGE_GATE} DIAGNOSTIC (does not qualify): ${selectionKilled ? 'selection killed' : 'selection not killed'} — ${String(chosen.length)} of ${String(MUTATIONS.length)} run, written to tmp/sabotage-diagnostic.json\n`);
process.exit(selectionKilled ? 0 : 1);
