#!/usr/bin/env node
/**
 * The gate receipt: what one run decided about one commit, composed from the
 * run's own artifacts and verified before it is written. CI and the chain
 * rehearsal both build it here, so the receipt a reader downloads from CI has
 * the shape the rehearsal proved a consumer can check, and neither needs jq.
 *
 * The receipt embeds the architecture verdict and the sabotage qualification
 * report verbatim and then checks that both name the receipt's own commit and
 * tree, that both were produced on a clean tree, that every job succeeded,
 * that the verdict is TRUE on every fact, and that the sabotage records add
 * up to the sabotage counts. A receipt that fails its own verification is
 * still written — a reader should see why — but the process exits 1.
 *
 *   node tools/compose-receipt.mjs --verdict <architecture-gate.json> --sabotage <sabotage-report.json>
 *                                  --needs <json or path> --out <receipt.json> [--subject-label CI]
 *   Identity comes from GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_REF, GITHUB_WORKFLOW, GITHUB_RUN_ID,
 *   GITHUB_RUN_ATTEMPT, GITHUB_EVENT_NAME, and the tree from `git rev-parse HEAD^{tree}` in cwd.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { qualifies, recount } from './lib/verify-sabotage-report.mjs';

export const RECEIPT_KIND = 'INTELLIGENCE_CORE_CI_RECEIPT';
export const REQUIRED_JOBS = Object.freeze(['gate', 'sabotage', 'architecture', 'dependencies']);
const SHA = /^[0-9a-f]{40}$/u;

export function composeReceipt(input) {
  return {
    artifactKind: RECEIPT_KIND,
    subjectLabel: input.subjectLabel,
    repository: input.repository,
    commit: input.commit,
    tree: input.tree,
    ref: input.ref,
    workflow: input.workflow,
    runId: input.runId,
    runAttempt: input.runAttempt,
    event: input.event,
    jobs: input.jobs,
    architecture: input.architecture,
    sabotage: input.sabotage,
  };
}

/** Every problem with a receipt against the subject its reader expects; ok only with none. */
export function verifyReceipt(receipt, expected) {
  const problems = [];
  if (receipt === null || typeof receipt !== 'object') return { ok: false, problems: ['no receipt'] };
  if (receipt.artifactKind !== RECEIPT_KIND) problems.push(`artifactKind is ${String(receipt.artifactKind)}`);
  if (typeof receipt.subjectLabel !== 'string' || receipt.subjectLabel === '') problems.push('no subjectLabel');
  if (!SHA.test(String(receipt.commit))) problems.push('commit is not a sha');
  if (!SHA.test(String(receipt.tree))) problems.push('tree is not a sha');
  if (expected?.commit !== undefined && receipt.commit !== expected.commit) problems.push(`receipt commit ${String(receipt.commit)} is not the expected ${String(expected.commit)}`);
  if (expected?.tree !== undefined && receipt.tree !== expected.tree) problems.push(`receipt tree ${String(receipt.tree)} is not the expected ${String(expected.tree)}`);
  if (expected?.subjectLabel !== undefined && receipt.subjectLabel !== expected.subjectLabel) problems.push(`subjectLabel ${String(receipt.subjectLabel)} is not ${String(expected.subjectLabel)}`);

  const jobs = receipt.jobs ?? {};
  for (const job of REQUIRED_JOBS) if (jobs[job] !== 'success') problems.push(`job ${job} is ${String(jobs[job])}`);
  for (const [job, result] of Object.entries(jobs)) if (result !== 'success') problems.push(`job ${job} did not succeed (${String(result)})`);

  const verdict = receipt.architecture;
  if (verdict === null || typeof verdict !== 'object') problems.push('no architecture verdict embedded');
  else {
    if (verdict.artifactKind !== 'INTELLIGENCE_CORE_ARCHITECTURE_GATE') problems.push(`the embedded verdict is ${String(verdict.artifactKind)}`);
    if (verdict.subject?.commit !== receipt.commit) problems.push(`the verdict names commit ${String(verdict.subject?.commit)}, the receipt ${String(receipt.commit)}`);
    if (verdict.subject?.tree !== receipt.tree) problems.push(`the verdict names tree ${String(verdict.subject?.tree)}, the receipt ${String(receipt.tree)}`);
    if (verdict.subject?.dirty !== false) problems.push('the verdict was decided on a dirty tree');
    if (verdict.INTELLIGENCE_CORE_ARCHITECTURE_CLOSED !== 'TRUE') problems.push(`INTELLIGENCE_CORE_ARCHITECTURE_CLOSED is ${String(verdict.INTELLIGENCE_CORE_ARCHITECTURE_CLOSED)}`);
    const facts = Array.isArray(verdict.facts) ? verdict.facts : [];
    if (facts.length === 0) problems.push('the verdict has no facts');
    for (const fact of facts) if (fact.value !== true) problems.push(`fact ${String(fact.name)} is ${String(fact.value)}`);
    if (verdict.sabotage?.subject?.commit !== receipt.commit) problems.push('the sabotage the verdict executed names another commit');
  }

  const sabotage = receipt.sabotage;
  if (sabotage === null || typeof sabotage !== 'object') problems.push('no sabotage report embedded');
  else {
    if (sabotage.mode !== 'QUALIFICATION') problems.push(`the embedded sabotage report is ${String(sabotage.mode)}`);
    if (sabotage.subject?.commit !== receipt.commit) problems.push(`the sabotage report names commit ${String(sabotage.subject?.commit)}, the receipt ${String(receipt.commit)}`);
    if (sabotage.subject?.tree !== receipt.tree) problems.push(`the sabotage report names tree ${String(sabotage.subject?.tree)}, the receipt ${String(receipt.tree)}`);
    if (sabotage.subject?.dirty !== false) problems.push('the sabotage report was produced on a dirty tree');
    const ids = Array.isArray(sabotage.inventory?.ids) ? sabotage.inventory.ids.map((entry) => entry.id) : [];
    const recomputed = recount(Array.isArray(sabotage.mutations) ? sabotage.mutations : [], ids);
    problems.push(...recomputed.problems);
    for (const key of Object.keys(recomputed.counts)) if (sabotage.counts?.[key] !== recomputed.counts[key]) problems.push(`sabotage counts.${key} says ${String(sabotage.counts?.[key])}, the records say ${String(recomputed.counts[key])}`);
    if (!qualifies(sabotage.mode, sabotage.baseline, recomputed.counts, recomputed.missing)) problems.push('the sabotage records do not qualify');
    if (sabotage.passed !== true) problems.push('the sabotage report does not say passed');
  }
  return { ok: problems.length === 0, problems };
}

const readJsonArg = (value) => {
  if (value === undefined) return null;
  const text = existsSync(value) ? readFileSync(value, 'utf8') : value;
  return JSON.parse(text);
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const out = arg('--out');
  if (out === undefined || arg('--verdict') === undefined || arg('--sabotage') === undefined || arg('--needs') === undefined) {
    process.stderr.write('usage: compose-receipt.mjs --verdict <path> --sabotage <path> --needs <json|path> --out <path> [--subject-label CI]\n');
    process.exit(2);
  }
  const env = process.env;
  const treeResult = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' });
  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  const needs = readJsonArg(arg('--needs'));
  // GitHub's `needs` context nests the result; a plain {job: result} map is accepted as well.
  const jobs = Object.fromEntries(Object.entries(needs ?? {}).map(([job, value]) => [job, typeof value === 'string' ? value : value?.result]));
  const commit = env.GITHUB_SHA ?? (headResult.status === 0 ? headResult.stdout.trim() : null);
  if (headResult.status === 0 && headResult.stdout.trim() !== commit) {
    process.stderr.write(`GITHUB_SHA ${String(commit)} is not the checked-out HEAD ${headResult.stdout.trim()}; the receipt would name a commit it did not measure\n`);
    process.exit(1);
  }
  const receipt = composeReceipt({
    subjectLabel: arg('--subject-label') ?? 'CI',
    repository: env.GITHUB_REPOSITORY ?? null,
    commit,
    tree: treeResult.status === 0 ? treeResult.stdout.trim() : null,
    ref: env.GITHUB_REF ?? null,
    workflow: env.GITHUB_WORKFLOW ?? null,
    runId: env.GITHUB_RUN_ID === undefined ? null : Number(env.GITHUB_RUN_ID),
    runAttempt: env.GITHUB_RUN_ATTEMPT === undefined ? null : Number(env.GITHUB_RUN_ATTEMPT),
    event: env.GITHUB_EVENT_NAME ?? null,
    jobs,
    architecture: readJsonArg(arg('--verdict')),
    sabotage: readJsonArg(arg('--sabotage')),
  });
  const verdict = verifyReceipt(receipt, { commit: receipt.commit, tree: receipt.tree });
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ receipt: resolve(out), commit: receipt.commit, tree: receipt.tree, jobs, verified: verdict.ok, problems: verdict.problems }, null, 2)}\n`);
  if (!verdict.ok) process.stderr.write(`::error::the receipt does not verify: ${verdict.problems.join('; ')}\n`);
  process.exit(verdict.ok ? 0 : 1);
}
