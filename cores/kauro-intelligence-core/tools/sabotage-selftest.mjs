#!/usr/bin/env node
/**
 * The sabotage runner, tested on its negatives.
 *
 * The audit found that `--only <unknown id>` exited 0 with an empty PASS and
 * that an empty diagnostic could stand in for the whole inventory. This
 * self-test runs the real runner in a disposable copy of the tree and proves
 * the opposite now holds: an unknown or empty selection is refused with exit
 * 2 and writes nothing; a valid selection writes a DIAGNOSTIC file, not the
 * qualification report, and that file is refused by the qualification
 * verifier; and the counting predicate ignores duplicates, strangers and
 * anything that is not a KILLED record of a reached inventory id. It never
 * runs the full inventory — one mutation, once.
 *
 *   node tools/sabotage-selftest.mjs      prints { cases, ok }, exit 0 when every case holds
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyTree, removeTree } from './lib/tree-copy.mjs';
import { currentContext, loadInventory, qualifies, recount, verifySabotageReport } from './lib/verify-sabotage-report.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dest = join(root, 'tmp', 'sabotage-selftest-tree');
const cases = [];
const check = (id, held, detail) => {
  cases.push({ id, ok: held === true, detail });
  process.stderr.write(`  ${held === true ? 'HOLDS ' : 'BROKEN'} ${id.padEnd(44)} ${detail}\n`);
};
const runner = (cwd, args) => spawnSync(process.execPath, ['tools/sabotage.mjs', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60 * 60 * 1000 });
const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);

process.stderr.write('\nSABOTAGE SELF-TEST\n\n');
const statusBefore = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout;
let copy = null;
try {
  copy = copyTree(root, dest, 'SELFTEST');
  const { mutations } = await loadInventory(copy.dest);
  const ids = mutations.map((mutation) => mutation.id);
  const reportPath = join(copy.dest, 'tmp', 'sabotage-report.json');
  const diagnosticPath = join(copy.dest, 'tmp', 'sabotage-diagnostic.json');

  // 1. An unknown id: exit 2, an explicit error, no file of either kind.
  const unknown = runner(copy.dest, ['--only', 'AUDIT_NO_SUCH_MUTATION']);
  check('only_unknown_id_is_refused', unknown.status === 2 && /unknown mutation/u.test(unknown.stderr) && !existsSync(reportPath) && !existsSync(diagnosticPath), `exit ${String(unknown.status)}; report ${String(existsSync(reportPath))}, diagnostic ${String(existsSync(diagnosticPath))}`);

  // 2. A mix of known and unknown ids is still refused: no partial acceptance.
  const mixed = runner(copy.dest, ['--only', `${ids[0]},AUDIT_NO_SUCH_MUTATION`]);
  check('only_mixed_selection_is_refused', mixed.status === 2 && !existsSync(reportPath) && !existsSync(diagnosticPath), `exit ${String(mixed.status)}`);

  // 3. An empty selection: exit 2.
  const empty = runner(copy.dest, ['--only', '']);
  const bare = runner(copy.dest, ['--only']);
  check('only_empty_selection_is_refused', empty.status === 2 && bare.status === 2 && !existsSync(reportPath) && !existsSync(diagnosticPath), `exit ${String(empty.status)} / ${String(bare.status)}`);

  // 4. A valid id: a DIAGNOSTIC file that says so, and no qualification report.
  const one = runner(copy.dest, ['--only', ids[0]]);
  const diagnostic = readJson(diagnosticPath);
  check('only_valid_id_writes_diagnostic_not_report', one.status === 0 && diagnostic !== null && !existsSync(reportPath), `exit ${String(one.status)}; diagnostic ${String(diagnostic !== null)}, report ${String(existsSync(reportPath))}`);
  check('diagnostic_says_it_does_not_qualify', diagnostic?.mode === 'DIAGNOSTIC' && diagnostic?.qualifies === false && diagnostic?.passed === false && diagnostic?.selection?.allKilled === true, `mode ${String(diagnostic?.mode)}, qualifies ${String(diagnostic?.qualifies)}, passed ${String(diagnostic?.passed)}, selection killed ${String(diagnostic?.selection?.allKilled)}`);
  check('diagnostic_counts_name_the_unreached_rest', diagnostic?.counts?.inventory === ids.length && diagnostic?.counts?.reached === 1 && diagnostic?.counts?.killed === 1 && diagnostic?.counts?.notReached === ids.length - 1, JSON.stringify(diagnostic?.counts ?? null));

  // 5. The diagnostic, offered to the qualification verifier of its own clean tree, is refused.
  const verdict = verifySabotageReport(diagnostic, await currentContext(copy.dest));
  check('diagnostic_refused_by_qualification_verifier', verdict.ok === false && verdict.problems.some((problem) => /mode is DIAGNOSTIC/u.test(problem)) && verdict.problems.some((problem) => /has no record/u.test(problem)), verdict.problems.slice(0, 3).join('; '));

  // 6. The counting predicate, on records alone.
  const killedAll = ids.map((id) => ({ id, outcome: 'KILLED' }));
  const full = recount(killedAll, ids);
  check('predicate_holds_on_complete_kill', qualifies('QUALIFICATION', { outcome: 'SURVIVED' }, full.counts, full.missing) === true && full.counts.killed === ids.length, JSON.stringify(full.counts));
  const duplicated = recount([...killedAll.slice(0, -1), killedAll[0]], ids);
  check('predicate_counts_duplicate_records_once', duplicated.counts.killed === ids.length - 1 && duplicated.missing.length === 1 && duplicated.problems.some((problem) => /more than once/u.test(problem)) && qualifies('QUALIFICATION', { outcome: 'SURVIVED' }, duplicated.counts, duplicated.missing) === false, `killed ${String(duplicated.counts.killed)}, missing ${duplicated.missing.join(',')}`);
  const stranger = recount([...killedAll.slice(0, -1), { id: 'NOT_IN_INVENTORY', outcome: 'KILLED' }], ids);
  check('predicate_ignores_kills_outside_inventory', stranger.counts.killed === ids.length - 1 && stranger.problems.some((problem) => /not in the inventory/u.test(problem)) && qualifies('QUALIFICATION', { outcome: 'SURVIVED' }, stranger.counts, stranger.missing) === false, `killed ${String(stranger.counts.killed)}`);
  for (const outcome of ['SURVIVED', 'DID_NOT_COMPILE', 'INFRA_ERROR', 'NOT_REACHED']) {
    const one = recount([...killedAll.slice(0, -1), { id: ids[ids.length - 1], outcome }], ids);
    check(`predicate_rejects_one_${outcome.toLowerCase()}`, qualifies('QUALIFICATION', { outcome: 'SURVIVED' }, one.counts, one.missing) === false && one.counts.killed === ids.length - 1, JSON.stringify(one.counts));
  }
  check('predicate_rejects_diagnostic_mode', qualifies('DIAGNOSTIC', { outcome: 'SURVIVED' }, full.counts, full.missing) === false, 'complete kill in DIAGNOSTIC mode does not qualify');
  check('predicate_rejects_broken_baseline', qualifies('QUALIFICATION', { outcome: 'KILLED' }, full.counts, full.missing) === false && qualifies('QUALIFICATION', null, full.counts, full.missing) === false, 'baseline KILLED or absent does not qualify');
  check('predicate_rejects_empty_inventory', qualifies('QUALIFICATION', { outcome: 'SURVIVED' }, recount([], []).counts, []) === false, 'zero of zero does not qualify');

  // 7. The real tree is as it was: the runner worked on the copy and on the copy's own copy.
  const statusAfter = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout;
  check('real_tree_untouched', statusAfter === statusBefore, 'git status --porcelain unchanged by the self-test');
} catch (error) {
  check('selftest_ran_to_completion', false, error instanceof Error ? error.message : String(error));
} finally {
  const removed = copy === null ? !existsSync(dest) : removeTree(dest);
  check('temporary_copy_removed', removed, dest);
}
const ok = cases.length > 0 && cases.every((entry) => entry.ok);
process.stdout.write(`${JSON.stringify({ artifactKind: 'INTELLIGENCE_CORE_SABOTAGE_SELFTEST', subjectLabel: 'SELFTEST', cases, ok }, null, 2)}\n`);
process.stderr.write(`\nSABOTAGE SELF-TEST = ${ok ? 'PASS' : 'FALSE'} (${String(cases.filter((entry) => entry.ok).length)} of ${String(cases.length)} hold)\n\n`);
process.exit(ok ? 0 : 1);
