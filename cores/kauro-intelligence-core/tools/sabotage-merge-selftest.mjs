#!/usr/bin/env node
/**
 * The sharded sabotage evidence, tested on what it must refuse.
 *
 * Synthetic shard reports are built for the inventory in this tree, merged,
 * and the merged report is given to the unchanged verifySabotageReport. Then
 * each way a set of shards can lie is tried and must be refused: a shard
 * missing, one twice, one of another commit or tree, a tampered record, a
 * record in the wrong shard or twice, a surviving mutation, a different
 * inventory, producer or shard count, a failed baseline, a dirty tree, and a
 * full QUALIFICATION report passed off as a shard. Nothing here runs a
 * mutation; it takes seconds and needs no copy of the tree (the subject is a
 * synthetic clean one, the production files are only hashed).
 *
 *   node tools/sabotage-merge-selftest.mjs      prints { cases, ok }, exit 0 when every case holds
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SABOTAGE_GATE, currentContext, recount, sha256File, verifySabotageReport } from './lib/verify-sabotage-report.mjs';
import { SHARD_MODE, inventoryDigest, mergeShardReports, parseShard, selectShard } from './lib/sabotage-shards.mjs';
import { anchorProblems } from './sabotage-anchors.mjs';
import { adoptReport, findReusableRun } from './sabotage-reuse.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cases = [];
const check = (id, held, detail) => {
  cases.push({ id, ok: held === true, detail });
  process.stderr.write(`  ${held === true ? 'HOLDS ' : 'BROKEN'} ${id.padEnd(48)} ${detail}\n`);
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

process.stderr.write('\nSABOTAGE MERGE SELF-TEST\n\n');
// The tree as it is, with a synthetic clean subject so the self-test runs in a developer's dirty checkout too.
const real = await currentContext(root);
const current = { ...real, subject: { commit: COMMIT, tree: TREE, dirty: false, dirtyPaths: [], resolved: true } };
const mutations = current.inventory.mutations;
const ids = mutations.map((mutation) => ({ id: mutation.id, inventoryFile: mutation.inventoryFile, file: mutation.file, gate: mutation.gate }));
const N = 7;

function shardReport(index, count) {
  const chosen = selectShard(mutations, { index, count });
  const records = chosen.map((mutation) => ({ id: mutation.id, inventoryFile: mutation.inventoryFile, file: mutation.file, gate: mutation.gate, outcome: 'KILLED', detail: '1 of N tests failed', durationMs: 1 }));
  return {
    gate: SABOTAGE_GATE,
    mode: SHARD_MODE,
    qualifies: false,
    shard: { index, count },
    subject: { commit: COMMIT, tree: TREE, dirty: false, dirtyPaths: [], resolved: true },
    node: process.version,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T01:00:00.000Z',
    inventory: { files: clone(current.inventory.files), ids: clone(ids) },
    inventoryDigest: inventoryDigest(current.inventory.files, ids),
    producers: clone(current.producers),
    productionFiles: [...new Set(mutations.map((mutation) => mutation.file))].sort().map((file) => ({ file, sha256: sha256File(join(root, file)) })),
    jobs: 4,
    baseline: { outcome: 'SURVIVED', detail: 'N tests passed', durationMs: 1 },
    selection: { ids: chosen.map((mutation) => mutation.id) },
    counts: recount(records, chosen.map((mutation) => mutation.id)).counts,
    mutations: records,
    passed: true,
  };
}
const shards = (count = N) => Array.from({ length: count }, (_, k) => shardReport(k + 1, count));
const refused = (id, reports, pattern, count = N) => {
  const result = mergeShardReports(reports, count, current);
  check(id, result.ok === false && result.report === null && result.problems.some((problem) => pattern.test(problem)), result.ok ? 'ACCEPTED' : result.problems.filter((problem) => pattern.test(problem)).slice(0, 2).join('; ') || `refused for another reason: ${result.problems.slice(0, 2).join('; ')}`);
};

// 0. The partition itself: disjoint, exhaustive, stable, balanced to one.
const partition = Array.from({ length: N }, (_, k) => selectShard(mutations, { index: k + 1, count: N }).map((mutation) => mutation.id));
const flat = partition.flat();
check('partition_is_exact_cover', flat.length === mutations.length && new Set(flat).size === mutations.length && mutations.every((mutation) => flat.includes(mutation.id)), `${String(N)} shards cover ${String(flat.length)} of ${String(mutations.length)} ids once each`);
check('partition_balanced_within_one', Math.max(...partition.map((part) => part.length)) - Math.min(...partition.map((part) => part.length)) <= 1, partition.map((part) => part.length).join(','));
check('shard_syntax_strict', parseShard('1/12')?.count === 12 && ['0/4', '5/4', '1/0', '1', 'a/b', '1/4x', '-1/4', '01/4'].every((text) => parseShard(text) === null), 'k/n with 1<=k<=n only');

// 1. Accepted: the honest shards merge into a report the unchanged verifier accepts.
const good = mergeShardReports(shards(), N, current);
const verdict = good.ok ? verifySabotageReport(good.report, current) : null;
check('honest_shards_merge', good.ok === true && verdict.ok === true && verdict.recomputed.killed === mutations.length, good.ok ? `${String(verdict.recomputed.killed)} of ${String(mutations.length)} recomputed; verifier problems ${verdict.problems.join('; ') || 'none'}` : good.problems.slice(0, 3).join('; '));
check('merged_report_is_inventory_ordered', good.ok && good.report.mutations.map((record) => record.id).join() === mutations.map((mutation) => mutation.id).join() && good.report.mode === 'QUALIFICATION' && good.report.merged.shards === N, 'records in inventory order, mode QUALIFICATION, provenance recorded');
const one = mergeShardReports(shards(1), 1, current);
check('single_shard_merges_too', one.ok === true && verifySabotageReport(one.report, current).ok === true, one.ok ? '1/1' : one.problems.slice(0, 2).join('; '));
check('shard_report_alone_does_not_qualify', verifySabotageReport(shardReport(1, N), current).ok === false && verifySabotageReport(shardReport(1, N), current).problems.some((problem) => /only a QUALIFICATION run qualifies/u.test(problem)), 'verifySabotageReport refuses mode QUALIFICATION-SHARD');

// 2. Presence.
refused('missing_shard_refused', shards().slice(1), /shard 1\/7 is missing/u);
refused('missing_last_shard_refused', shards().slice(0, -1), /shard 7\/7 is missing/u);
refused('no_shards_refused', [], /shard 1\/7 is missing/u);
const duplicated = shards();
duplicated[3] = clone(duplicated[2]);
refused('duplicated_shard_refused', duplicated, /shard 3\/7 appears more than once/u);
refused('duplicated_shard_leaves_one_missing', duplicated, /shard 4\/7 is missing/u);
const extra = [...shards(), clone(shards()[0])];
refused('extra_copy_of_a_shard_refused', extra, /appears more than once/u);
const fewerDeclared = shards(6);
refused('shards_of_another_count_refused', fewerDeclared, /is of 6, the merge expects 7|is missing/u);
refused('shard_index_out_of_range_refused', [...shards().slice(0, 6), { ...shardReport(7, N), shard: { index: 8, count: N } }], /outside 1\.\.7/u);
refused('unreadable_entry_refused', [...shards().slice(0, 6), null], /is not a report/u);
refused('more_shards_than_mutations_refused', shards(), /would leave a shard empty/u, mutations.length + 1);

// 3. Subject.
const foreignCommit = shards();
foreignCommit[2].subject.commit = 'c'.repeat(40);
refused('foreign_commit_shard_refused', foreignCommit, /shard 3\/7: commit c+ is not the checkout/u);
const foreignTree = shards();
foreignTree[5].subject.tree = 'd'.repeat(40);
refused('foreign_tree_shard_refused', foreignTree, /shard 6\/7: tree d+ is not the checkout/u);
const dirtyShard = shards();
dirtyShard[0].subject.dirty = true;
refused('dirty_tree_shard_refused', dirtyShard, /shard 1\/7: produced on a dirty tree/u);
const dirtyCheckout = mergeShardReports(shards(), N, { ...current, subject: { ...current.subject, dirty: true } });
check('dirty_checkout_refused', dirtyCheckout.ok === false && dirtyCheckout.problems.some((problem) => /merge runs in is dirty/u.test(problem)), dirtyCheckout.problems[0] ?? 'ACCEPTED');
const unresolvedCheckout = mergeShardReports(shards(), N, { ...current, subject: { ...current.subject, resolved: false } });
check('unresolved_checkout_refused', unresolvedCheckout.ok === false && unresolvedCheckout.problems.some((problem) => /no resolvable git subject/u.test(problem)), unresolvedCheckout.problems[0] ?? 'ACCEPTED');

// 4. Records.
const tamperedOutcome = shards();
tamperedOutcome[1].mutations[0].outcome = 'SURVIVED';
refused('survived_record_refused', tamperedOutcome, /record .* is SURVIVED/u);
const tamperedAndCounted = clone(tamperedOutcome);
tamperedAndCounted[1].counts = recount(tamperedAndCounted[1].mutations, tamperedAndCounted[1].selection.ids).counts;
tamperedAndCounted[1].passed = false;
refused('survived_record_with_matching_counts_refused', tamperedAndCounted, /record .* is SURVIVED/u);
const flippedBack = shards();
flippedBack[4].counts.killed -= 1;
refused('counts_disagreeing_with_records_refused', flippedBack, /shard 5\/7: counts\.killed says/u);
const tamperedId = shards();
tamperedId[0].mutations[0].id = 'FORGED_ID';
refused('forged_record_id_refused', tamperedId, /FORGED_ID is not in the inventory|record for .* is missing/u);
const swappedFile = shards();
swappedFile[2].mutations[0].file = 'src/other.ts';
refused('record_naming_another_file_refused', swappedFile, /shard 3\/7: record .* names/u);
const deletedRecord = shards();
deletedRecord[6].mutations.pop();
refused('deleted_record_refused', deletedRecord, /record for .* is missing|holds \d+ records/u);
const deletedAndCounted = clone(deletedRecord);
deletedAndCounted[6].counts = recount(deletedAndCounted[6].mutations, selectShard(mutations, { index: 7, count: N }).map((mutation) => mutation.id)).counts;
refused('deleted_record_with_matching_counts_refused', deletedAndCounted, /record for .* is missing|inventory id .* is in no shard/u);
const stray = shards();
stray[0].mutations.push(clone(stray[1].mutations[0]));
refused('record_of_another_shard_refused', stray, /shard 1\/7: record .* is not in the inventory|holds \d+ records/u);
const twice = shards();
twice[0].mutations.push(clone(twice[0].mutations[0]));
refused('record_twice_in_a_shard_refused', twice, /appears more than once/u);
const notReached = shards();
notReached[3].mutations[0] = { ...notReached[3].mutations[0], outcome: 'NOT_REACHED', detail: 'stale' };
refused('not_reached_record_refused', notReached, /is NOT_REACHED/u);
const emptyShardRecords = shards();
emptyShardRecords[2].mutations = [];
emptyShardRecords[2].counts = recount([], []).counts;
refused('shard_with_no_records_refused', emptyShardRecords, /record for .* is missing/u);

// 5. Provenance: the same inventory, producers and baseline everywhere.
const otherInventory = shards();
otherInventory[1].inventory.files[0].sha256 = '0'.repeat(64);
refused('other_inventory_bytes_refused', otherInventory, /shard 2\/7: inventory files differ/u);
const otherIds = shards();
otherIds[1].inventory.ids.pop();
refused('other_inventory_ids_refused', otherIds, /shard 2\/7: inventory ids differ/u);
const otherDigest = shards();
otherDigest[4].inventoryDigest = '1'.repeat(64);
refused('other_inventory_digest_refused', otherDigest, /shard 5\/7: inventory digest/u);
const otherProducer = shards();
otherProducer[0].producers['tools/sabotage.mjs'] = '2'.repeat(64);
refused('other_producer_hash_refused', otherProducer, /shard 1\/7: producer hashes differ/u);
const otherProduction = shards();
otherProduction[0].productionFiles.pop();
refused('other_production_files_refused', otherProduction, /production files recorded differ/u);
// Verify every shard's production hashes, not only shard 1's. The merged report carries shard 1's list
// and verifySabotageReport checks those against the checkout, so another shard's must be byte-identical to them.
const otherProductionHash = shards();
otherProductionHash[1].productionFiles[0].sha256 = '0'.repeat(64);
refused('other_production_hash_in_later_shard_refused', otherProductionHash, /shard 2\/7: production file hashes differ from shard 1/u);
const lastProductionHash = shards();
lastProductionHash[N - 1].productionFiles[lastProductionHash[N - 1].productionFiles.length - 1].sha256 = '3'.repeat(64);
refused('other_production_hash_in_last_shard_refused', lastProductionHash, /shard 7\/7: production file hashes differ from shard 1/u);
const brokenBaseline = shards();
brokenBaseline[3].baseline = { outcome: 'INFRA_ERROR', detail: 'x', durationMs: 1 };
refused('failed_baseline_refused', brokenBaseline, /shard 4\/7: baseline is INFRA_ERROR/u);
const wrongMode = shards();
wrongMode[0] = { ...clone(good.report), shard: { index: 1, count: N }, inventoryDigest: wrongMode[0].inventoryDigest };
refused('full_report_passed_off_as_shard_refused', wrongMode, /shard 1\/7: mode is QUALIFICATION, not QUALIFICATION-SHARD/u);
const diagnostic = shards();
diagnostic[2].mode = 'DIAGNOSTIC';
refused('diagnostic_report_as_shard_refused', diagnostic, /shard 3\/7: mode is DIAGNOSTIC/u);
const lyingPassed = shards();
lyingPassed[0].mutations[0].outcome = 'SURVIVED';
lyingPassed[0].counts = recount(lyingPassed[0].mutations, lyingPassed[0].selection.ids).counts;
refused('shard_claiming_passed_over_a_survivor_refused', lyingPassed, /shard 1\/7: passed is true/u);
const lyingQualifies = shards();
lyingQualifies[0].qualifies = true;
refused('shard_claiming_to_qualify_refused', lyingQualifies, /must say qualifies:false/u);
const otherGate = shards();
otherGate[0].gate = 'SOMETHING-ELSE';
refused('other_gate_refused', otherGate, /shard 1\/7: gate is SOMETHING-ELSE/u);

// 6. The merged report cannot be edited into acceptance afterwards.
const merged = good.report;
const editedMerged = clone(merged);
editedMerged.mutations[0].outcome = 'SURVIVED';
check('edited_merged_report_refused_by_verifier', verifySabotageReport(editedMerged, current).ok === false, verifySabotageReport(editedMerged, current).problems.slice(0, 1).join('; '));
const droppedMerged = clone(merged);
droppedMerged.mutations.pop();
check('truncated_merged_report_refused_by_verifier', verifySabotageReport(droppedMerged, current).ok === false, verifySabotageReport(droppedMerged, current).problems.slice(0, 1).join('; '));
const otherCommitMerged = clone(merged);
otherCommitMerged.subject.commit = 'e'.repeat(40);
check('other_commit_merged_report_refused_by_verifier', verifySabotageReport(otherCommitMerged, current).ok === false, verifySabotageReport(otherCommitMerged, current).problems.slice(0, 1).join('; '));

// 7. The command line: an empty directory and unknown flags are refusals, and nothing is left behind.
const scratch = mkdtempSync(join(tmpdir(), 'kauro-merge-selftest-'));
try {
  mkdirSync(join(scratch, 'none'));
  const out = join(scratch, 'out.json');
  writeFileSync(out, '{"stale":true}\n');
  const cli = (extra) => spawnSync(process.execPath, ['tools/sabotage-merge.mjs', ...extra], { cwd: root, encoding: 'utf8' });
  const empty = cli(['--shards', '3', '--dir', join(scratch, 'none'), '--out', out]);
  check('cli_refuses_an_empty_directory', empty.status === 1 && /shard 1\/3 is missing/u.test(empty.stderr), `exit ${String(empty.status)}`);
  check('cli_removes_a_stale_output_on_refusal', !existsSync(out), out);
  check('cli_refuses_unknown_flags', cli(['--skip', 'x']).status === 2 && cli(['--shards', '0', '--dir', scratch]).status === 2, 'exit 2 for an unknown flag and a zero shard count');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// 8. Anchors (tools/sabotage-anchors.mjs): the cheap check that runs before any shard. The tree's inventory holds;
// a moved text, a repeated text, a no-op mutation and a missing file are each refused without running a test.
{
  const read = (file) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : null);
  check('anchors_hold_on_the_tree', anchorProblems(mutations, read).length === 0, anchorProblems(mutations, read).slice(0, 2).join('; ') || 'clean');
  const one = { id: 'x', file: 'f.ts', from: 'a === b', to: 'true' };
  const fake = (text) => () => text;
  check('anchors_refuse_moved_text', anchorProblems([one], fake('a !== b')).some((p) => /stale anchor/u.test(p)), 'stale');
  check('anchors_refuse_repeated_text', anchorProblems([one], fake('a === b; a === b')).some((p) => /occurs 2 times/u.test(p)), 'repeated');
  check('anchors_refuse_noop_mutation', anchorProblems([{ ...one, to: 'a === b' }], fake('a === b')).some((p) => /changes nothing/u.test(p)), 'no-op');
  check('anchors_refuse_missing_file', anchorProblems([one], () => null).some((p) => /does not exist/u.test(p)), 'missing');
  check('anchors_refuse_empty_inventory', anchorProblems([], fake('')).some((p) => /no mutations/u.test(p)), 'empty mutations');
  check('anchors_refuse_no_inventory_files', anchorProblems(mutations, read, 0).some((p) => /no inventory files/u.test(p)), 'no files');
}

// 9. Workflow trust and request rules (.github/workflows/ci.yml, read as text).
{
  const yaml = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/gu, '\n');
  const block = (job) => {
    const lines = yaml.split('\n');
    const start = lines.indexOf(`  ${job}:`);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) if (/^ {2}[A-Za-z0-9_-]+:\s*$/u.test(lines[i]) || /^\S/u.test(lines[i])) { end = i; break; }
    return start < 0 ? '' : lines.slice(start, end).join('\n');
  };
  const shard = block('sabotage-shard');
  const runsOn = /^ {4}runs-on:(.*)$/mu.exec(shard)?.[1] ?? '';
  const policy = block('sabotage-runner-policy');
  check('workflow_self_hosted_only_for_trusted_code',
    /self-hosted/u.test(runsOn) && /github\.event_name == 'push'/u.test(policy) && /workflow_dispatch/u.test(policy) && /head\.repo\.full_name == github\.repository/u.test(policy) && /use workflow_dispatch/u.test(policy) && /exit 1/u.test(policy) && /needs: .*sabotage-runner-policy/u.test(shard),
    'runner eligibility must succeed before shards; ineligible requests fail without checking out PR code');
  check('workflow_sabotage_requested_by_label_carried',
    /contains\(github\.event\.pull_request\.labels\.\*\.name, 'run-sabotage'\)/u.test(shard),
    'label carried');
  const types = /^ {2}pull_request:\n {4}types: \[(.*)\]/mu.exec(yaml)?.[1] ?? '';
  check('workflow_no_labeled_trigger', types !== '' && !/labeled/u.test(types) && /opened/u.test(types) && /synchronize/u.test(types) && /reopened/u.test(types), types);
  const cheap = ['gate', 'dependencies', 'sabotage-anchors', 'sabotage-selftest', 'architecture-selftest', 'sabotage-request', 'sabotage-reuse', 'sabotage-runner-policy'];
  const hasIf = (job) => /^ {4}if:/mu.test(block(job));
  const skippable = cheap.filter(hasIf);
  check('workflow_cheap_jobs_never_skipped', skippable.length === 0, skippable.join(', ') || 'no conditional cheap job');
  // Required checks must execute even without a request and then fail explicitly.
  for (const job of ['sabotage', 'architecture']) {
    check(`workflow_${job}_always_reports`, /^ {4}if: always\(\)$/mu.test(block(job)) && /NOT REQUESTED/u.test(block(job)) && /exit 1/u.test(block(job)), 'always runs; NOT REQUESTED is a failure');
  }
  const shardPredicate = (/^ {4}if: >-\n([\s\S]*?)\n {4}[a-z-]+:/mu.exec(shard)?.[1] ?? '').replace(/\s+/gu, ' ').trim();
  check('workflow_shards_requested_unless_already_reused', shardPredicate.includes("needs.sabotage-reuse.outputs.reused != 'true'") && shardPredicate.includes("github.event_name == 'push'") && shardPredicate.includes('inputs.sabotage') && shardPredicate.includes("labels.*.name, 'run-sabotage'"), shardPredicate);
  const reuse = block('sabotage-reuse');
  check('workflow_failed_reuse_falls_back_to_shards',
    /id: fetch\n[\s\S]*?continue-on-error: true/u.test(reuse) && /id: adopt\n[\s\S]*?continue-on-error: true/u.test(reuse) && /reused: \$\{\{ steps\.adopt\.outputs\.reused == 'true' && 'true' \|\| 'false' \}\}/u.test(reuse),
    'reuse is decided before the shards and only a verified adoption sets reused');
  check('workflow_request_state_is_printed', /NOT REQUESTED/u.test(block('sabotage-request')) && /GITHUB_STEP_SUMMARY/u.test(block('sabotage-request')), 'sabotage-request');
}

// 10. Tree reuse (tools/sabotage-reuse.mjs), against recorded-shape API JSON: the same tree is reused; a different
// tree, a failed or cancelled run, another app, another check name, another repository, a fork pull request, a missing
// report artifact and any API error all run the shards.
{
  const REPO = 'o/r';
  const COMMIT = 'a'.repeat(40);
  const HEAD = 'b'.repeat(40);
  const TREE = 'c'.repeat(40);
  const NAME = 'sabotage (INTELLIGENCE-SABOTAGE-01)';
  const world = (patch = {}) => {
    const w = {
      pulls: [{ base: { repo: { full_name: REPO } }, head: { sha: HEAD, repo: { full_name: REPO } } }],
      headTree: TREE,
      checks: [{ name: NAME, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, head_sha: HEAD, details_url: `https://github.com/${REPO}/actions/runs/777/job/1` }],
      run: { repository: { full_name: REPO }, head_sha: HEAD, html_url: `https://github.com/${REPO}/actions/runs/777` },
      artifacts: [{ name: 'sabotage-report', expired: false }],
      fail: false,
      ...patch,
    };
    return async (path) => {
      if (w.fail) throw new Error('boom');
      if (path.startsWith(`/repos/${REPO}/commits/${COMMIT}/pulls`)) return w.pulls;
      if (path === `/repos/${REPO}/git/commits/${HEAD}`) return { tree: { sha: w.headTree } };
      if (path.startsWith(`/repos/${REPO}/commits/${HEAD}/check-runs`)) return { check_runs: w.checks };
      if (path === `/repos/${REPO}/actions/runs/777`) return w.run;
      if (path.startsWith(`/repos/${REPO}/actions/runs/777/artifacts`)) return { artifacts: w.artifacts };
      throw new Error(`unexpected ${path}`);
    };
  };
  const find = (patch) => findReusableRun({ repo: REPO, commit: COMMIT, tree: TREE, api: world(patch) });
  const good = await find();
  check('reuse_same_tree_is_reused', good.reusable === true && good.runId === '777' && good.commit === HEAD && /REUSED from .*runs\/777 \(tree c+\)/u.test(good.reason), good.reason);
  const check1 = (id, patch) => { const r = patch; return find(r).then((out) => check(id, out.reusable === false, out.reason)); };
  await check1('reuse_refuses_different_tree', { headTree: 'd'.repeat(40) });
  await check1('reuse_refuses_failed_run', { checks: [{ name: NAME, status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' }, head_sha: HEAD, details_url: `https://github.com/${REPO}/actions/runs/777/job/1` }] });
  await check1('reuse_refuses_cancelled_run', { checks: [{ name: NAME, status: 'completed', conclusion: 'cancelled', app: { slug: 'github-actions' }, head_sha: HEAD, details_url: `https://github.com/${REPO}/actions/runs/777/job/1` }] });
  await check1('reuse_refuses_skipped_run', { checks: [{ name: NAME, status: 'completed', conclusion: 'skipped', app: { slug: 'github-actions' }, head_sha: HEAD, details_url: `https://github.com/${REPO}/actions/runs/777/job/1` }] });
  await check1('reuse_refuses_other_app', { checks: [{ name: NAME, status: 'completed', conclusion: 'success', app: { slug: 'some-other-app' }, head_sha: HEAD, details_url: `https://github.com/${REPO}/actions/runs/777/job/1` }] });
  await check1('reuse_refuses_other_check_name', { checks: [{ name: 'architecture closure (INTELLIGENCE-ARCHITECTURE-01)', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, head_sha: HEAD, details_url: `https://github.com/${REPO}/actions/runs/777/job/1` }] });
  await check1('reuse_refuses_other_repository_run', { run: { repository: { full_name: 'x/y' }, head_sha: HEAD, html_url: 'https://github.com/x/y/actions/runs/777' } });
  await check1('reuse_refuses_run_on_another_commit', { run: { repository: { full_name: REPO }, head_sha: 'e'.repeat(40), html_url: 'u' } });
  await check1('reuse_refuses_fork_pull_request', { pulls: [{ base: { repo: { full_name: REPO } }, head: { sha: HEAD, repo: { full_name: 'fork/r' } } }] });
  await check1('reuse_refuses_no_pull_request', { pulls: [] });
  await check1('reuse_refuses_missing_or_expired_report', { artifacts: [{ name: 'sabotage-report', expired: true }] });
  await check1('reuse_refuses_on_api_error', { fail: true });
  // adopt: only a passed, clean QUALIFICATION of this very tree, from the named run's commit.
  const report = { mode: 'QUALIFICATION', passed: true, subject: { commit: HEAD, tree: TREE, dirty: false }, mutations: [] };
  const from = { runId: '777', runUrl: 'u', commit: HEAD };
  const adopted = adoptReport(report, { commit: COMMIT, tree: TREE }, from);
  check('reuse_adopt_resubjects_and_records_the_run', adopted.subject.commit === COMMIT && adopted.subject.tree === TREE && adopted.reusedFrom.runId === '777' && adopted.reusedFrom.commit === HEAD && report.subject.commit === HEAD, 'reusedFrom');
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  check('reuse_adopt_refuses_other_tree', throws(() => adoptReport(report, { commit: COMMIT, tree: 'd'.repeat(40) }, from)), 'tree');
  check('reuse_adopt_refuses_unpassed_or_dirty', throws(() => adoptReport({ ...report, passed: false }, { commit: COMMIT, tree: TREE }, from)) && throws(() => adoptReport({ ...report, subject: { ...report.subject, dirty: true } }, { commit: COMMIT, tree: TREE }, from)), 'passed/dirty');
  check('reuse_adopt_refuses_a_report_of_another_commit', throws(() => adoptReport(report, { commit: COMMIT, tree: TREE }, { ...from, commit: 'f'.repeat(40) })), 'run commit');
  // A pull request run checks out the synthetic merge commit S: the report names S, the run's head is H.
  const S = '1'.repeat(40);
  const mergeReport = { ...report, subject: { commit: S, tree: TREE, dirty: false } };
  const sInfo = { sha: S, tree: TREE, parents: ['2'.repeat(40), HEAD] };
  const viaMerge = adoptReport(mergeReport, { commit: COMMIT, tree: TREE }, from, sInfo);
  check('reuse_adopt_accepts_the_merge_commit_subject_by_tree', viaMerge.subject.commit === COMMIT && viaMerge.reusedFrom.commit === HEAD && viaMerge.reusedFrom.subjectCommit === S && viaMerge.reusedFrom.runId === '777', 'S and H in reusedFrom');
  check('reuse_adopt_refuses_merge_commit_not_verified', throws(() => adoptReport(mergeReport, { commit: COMMIT, tree: TREE }, from, null)), 'no S info');
  check('reuse_adopt_refuses_merge_commit_of_another_tree', throws(() => adoptReport(mergeReport, { commit: COMMIT, tree: TREE }, from, { ...sInfo, tree: 'd'.repeat(40) })), 'S tree');
  check('reuse_adopt_refuses_merge_commit_of_another_head', throws(() => adoptReport(mergeReport, { commit: COMMIT, tree: TREE }, from, { ...sInfo, parents: ['2'.repeat(40), '3'.repeat(40)] })), 'S parents');
  check('reuse_adopt_refuses_report_tree_differing_from_the_main_tree', throws(() => adoptReport({ ...mergeReport, subject: { ...mergeReport.subject, tree: 'd'.repeat(40) } }, { commit: COMMIT, tree: TREE }, from, { ...sInfo, tree: 'd'.repeat(40) })), 'report tree');
}

const ok = cases.length > 0 && cases.every((entry) => entry.ok);
process.stdout.write(`${JSON.stringify({ artifactKind: 'INTELLIGENCE_CORE_SABOTAGE_MERGE_SELFTEST', cases, ok }, null, 2)}\n`);
process.stderr.write(`\nSABOTAGE MERGE SELF-TEST = ${ok ? 'PASS' : 'FALSE'} (${String(cases.filter((entry) => entry.ok).length)} of ${String(cases.length)} hold)\n\n`);
process.exit(ok ? 0 : 1);
