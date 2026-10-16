/**
 * What a sabotage report must prove before anybody believes it.
 *
 * The runner writes a report; the architecture gate consumes one. Between
 * them stands this module, so the same predicate decides in both places and
 * a self-test can call it without a ten-minute run. A report is accepted only
 * when it is a QUALIFICATION run of this exact subject (commit and tree, and
 * the tree was clean), produced by the runner and test driver that are in the
 * tree now, over the inventory files that are in the tree now, with every
 * inventory id reached and killed, and with counts that agree with its own
 * per-mutation records. Nothing is read off `passed`; `passed` is recomputed
 * and a report whose own flag disagrees is refused as edited.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SABOTAGE_GATE = 'INTELLIGENCE-SABOTAGE-01';
export const OUTCOMES = Object.freeze(['KILLED', 'SURVIVED', 'DID_NOT_COMPILE', 'INFRA_ERROR', 'NOT_REACHED']);
/** The producers whose bytes a sabotage report binds itself to. */
export const SABOTAGE_PRODUCERS = Object.freeze(['tools/sabotage.mjs', 'tools/run-tests.mjs', 'tools/lib/verify-sabotage-report.mjs', 'tools/lib/sabotage-shards.mjs']);

export function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(path) {
  return sha256Of(readFileSync(path));
}

/** The git identity of a checkout; unresolved fields are null and an unresolved subject is dirty by construction. */
export function gitSubject(root) {
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  const commit = git(['rev-parse', 'HEAD']);
  const tree = git(['rev-parse', 'HEAD^{tree}']);
  const status = git(['status', '--porcelain']);
  const dirtyPaths = status === null ? [] : status.split('\n').filter((line) => line !== '');
  const resolved = commit !== null && tree !== null && status !== null;
  return { commit, tree, dirty: !resolved || dirtyPaths.length > 0, dirtyPaths, resolved };
}

/** Every inventory file under tools/sabotage-inventory with its digest, and every mutation it declares. */
export async function loadInventory(root) {
  const dir = join(root, 'tools', 'sabotage-inventory');
  const files = [];
  const mutations = [];
  const ids = new Set();
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.mjs')).sort()) {
    const path = join(dir, name);
    files.push({ file: name, sha256: sha256File(path) });
    // The cache-busting query lets one process reload an inventory file it has already imported.
    const module = await import(`${pathToFileURL(path).href}?sha=${files[files.length - 1].sha256}`);
    if (!Array.isArray(module.MUTATIONS)) throw new Error(`${name} does not export MUTATIONS`);
    for (const mutation of module.MUTATIONS) {
      if (typeof mutation.id !== 'string' || mutation.id === '') throw new Error(`${name} declares a mutation without an id`);
      if (ids.has(mutation.id)) throw new Error(`duplicate mutation id ${mutation.id}`);
      ids.add(mutation.id);
      mutations.push({ ...mutation, inventoryFile: name });
    }
  }
  return { files, mutations };
}

export function producerHashes(root, producers = SABOTAGE_PRODUCERS) {
  const hashes = {};
  for (const producer of producers) hashes[producer] = existsSync(join(root, producer)) ? sha256File(join(root, producer)) : null;
  return hashes;
}

/** Everything the verifier compares a report against, read off the tree as it is now. */
export async function currentContext(root) {
  const inventory = await loadInventory(root);
  return { root, subject: gitSubject(root), inventory, producers: producerHashes(root) };
}

/**
 * Counts from the per-mutation records alone, over unique ids: a record
 * repeated twice counts once, an id the records never mention is not reached,
 * and an id outside the inventory is a problem, not a kill.
 */
export function recount(records, inventoryIds) {
  const byId = new Map();
  const problems = [];
  const inventory = new Set(inventoryIds);
  for (const record of records) {
    if (typeof record?.id !== 'string') {
      problems.push('a mutation record has no id');
      continue;
    }
    if (!inventory.has(record.id)) problems.push(`record ${record.id} is not in the inventory`);
    if (!OUTCOMES.includes(record.outcome)) problems.push(`record ${record.id} has outcome ${String(record.outcome)}`);
    if (byId.has(record.id)) problems.push(`record ${record.id} appears more than once`);
    else byId.set(record.id, record.outcome);
  }
  const count = (outcome) => [...byId].filter(([id, value]) => inventory.has(id) && value === outcome).length;
  const reached = [...byId].filter(([id, value]) => inventory.has(id) && value !== 'NOT_REACHED').length;
  const missing = [...inventory].filter((id) => !byId.has(id));
  return {
    counts: { inventory: inventory.size, reached, killed: count('KILLED'), survived: count('SURVIVED'), didNotCompile: count('DID_NOT_COMPILE'), infraError: count('INFRA_ERROR'), notReached: count('NOT_REACHED') + missing.length },
    missing,
    problems,
  };
}

/** The qualification predicate, from recomputed counts only. */
export function qualifies(mode, baseline, counts, missing) {
  return mode === 'QUALIFICATION' && baseline?.outcome === 'SURVIVED' && missing.length === 0 && counts.inventory > 0 && counts.reached === counts.inventory && counts.killed === counts.inventory && counts.survived === 0 && counts.didNotCompile === 0 && counts.infraError === 0 && counts.notReached === 0;
}

const sameSet = (a, b) => a.length === b.length && a.every((value) => b.includes(value));

/**
 * The verdict on a report against the tree it claims to be about. Returns
 * every problem found, not the first, so a refused report explains itself;
 * `ok` is true only with none.
 */
export function verifySabotageReport(report, current) {
  const problems = [];
  if (report === null || typeof report !== 'object') return { ok: false, problems: ['no report'], recomputed: null };
  if (report.gate !== SABOTAGE_GATE) problems.push(`gate is ${String(report.gate)}, not ${SABOTAGE_GATE}`);
  if (report.mode !== 'QUALIFICATION') problems.push(`mode is ${String(report.mode)}; only a QUALIFICATION run qualifies`);

  // Subject: this commit, this tree, and clean when it ran.
  const subject = report.subject ?? {};
  if (!current.subject.resolved) problems.push('the current checkout has no resolvable git subject');
  if (typeof subject.commit !== 'string' || subject.commit !== current.subject.commit) problems.push(`subject commit ${String(subject.commit)} is not the current HEAD ${String(current.subject.commit)}`);
  if (typeof subject.tree !== 'string' || subject.tree !== current.subject.tree) problems.push(`subject tree ${String(subject.tree)} is not the current tree ${String(current.subject.tree)}`);
  if (subject.dirty !== false) problems.push('the report was produced on a dirty tree');
  if (current.subject.dirty) problems.push('the current tree is dirty');

  // Producers: the runner and driver in the tree now are the ones that ran.
  const producers = report.producers ?? {};
  for (const producer of SABOTAGE_PRODUCERS) {
    if (producers[producer] !== current.producers[producer] || current.producers[producer] === null) problems.push(`producer ${producer} hashes ${String(current.producers[producer])} now, the report says ${String(producers[producer])}`);
  }

  // Inventory: the same files with the same bytes, and the same ids.
  const files = Array.isArray(report.inventory?.files) ? report.inventory.files : [];
  const currentFiles = current.inventory.files;
  if (!sameSet(files.map((entry) => entry.file), currentFiles.map((entry) => entry.file))) problems.push(`inventory files ${files.map((entry) => entry.file).join(',')} differ from ${currentFiles.map((entry) => entry.file).join(',')}`);
  for (const entry of currentFiles) {
    const reported = files.find((candidate) => candidate.file === entry.file);
    if (reported !== undefined && reported.sha256 !== entry.sha256) problems.push(`inventory file ${entry.file} changed after the run`);
  }
  const ids = Array.isArray(report.inventory?.ids) ? report.inventory.ids : [];
  const currentIds = current.inventory.mutations.map((mutation) => mutation.id);
  if (!sameSet(ids.map((entry) => entry.id), currentIds)) problems.push(`the report lists ${String(ids.length)} inventory ids, the inventory has ${String(currentIds.length)}, or they differ`);
  for (const mutation of current.inventory.mutations) {
    const reported = ids.find((entry) => entry.id === mutation.id);
    if (reported !== undefined && (reported.inventoryFile !== mutation.inventoryFile || reported.file !== mutation.file)) problems.push(`inventory id ${mutation.id} is declared elsewhere now`);
  }

  // Production files: the bytes mutated are the bytes in the tree now.
  const production = Array.isArray(report.productionFiles) ? report.productionFiles : [];
  const mutatedFiles = [...new Set(current.inventory.mutations.map((mutation) => mutation.file))];
  if (!sameSet(production.map((entry) => entry.file), mutatedFiles)) problems.push('the production files recorded differ from the files the inventory mutates');
  for (const entry of production) {
    const path = join(current.root, entry.file);
    if (!existsSync(path)) problems.push(`production file ${entry.file} is not in the tree`);
    else if (sha256File(path) !== entry.sha256) problems.push(`production file ${entry.file} changed after the run`);
  }

  // Records and counts: recomputed, never read.
  if (report.baseline?.outcome !== 'SURVIVED') problems.push(`baseline is ${String(report.baseline?.outcome)}, a kill against it proves nothing`);
  const records = Array.isArray(report.mutations) ? report.mutations : [];
  const recomputed = recount(records, currentIds);
  problems.push(...recomputed.problems);
  for (const id of recomputed.missing) problems.push(`inventory id ${id} has no record`);
  for (const record of records) {
    const mutation = current.inventory.mutations.find((entry) => entry.id === record.id);
    if (mutation !== undefined && record.file !== mutation.file) problems.push(`record ${record.id} names ${String(record.file)}, the inventory names ${mutation.file}`);
    if (record.outcome !== 'KILLED') problems.push(`record ${String(record.id)} is ${String(record.outcome)}`);
  }
  const reportedCounts = report.counts ?? {};
  for (const key of Object.keys(recomputed.counts)) {
    if (reportedCounts[key] !== recomputed.counts[key]) problems.push(`counts.${key} says ${String(reportedCounts[key])}, the records say ${String(recomputed.counts[key])}`);
  }
  const passed = qualifies(report.mode, report.baseline, recomputed.counts, recomputed.missing);
  if (report.passed !== passed) problems.push(`passed is ${String(report.passed)}, the records say ${String(passed)}`);
  if (!passed) problems.push('the recomputed predicate does not qualify');
  return { ok: problems.length === 0, problems, recomputed: recomputed.counts };
}
