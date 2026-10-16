#!/usr/bin/env node
/**
 * The architecture gate's verifier, tested on the evidence it must refuse.
 *
 * The audit found that the gate accepted `report.passed === true` without
 * asking whose report it was, whether it was complete, or whether anything in
 * it added up. This self-test builds a report that would be accepted for a
 * disposable copy of the tree and then breaks it one way at a time — a record
 * deleted, counts edited, the subject changed, an inventory file changed after
 * the run, a producer changed, `passed` flipped over a SURVIVED record, a
 * report from another commit, a diagnostic dressed as qualification — and
 * proves each one is refused by tools/lib/verify-sabotage-report.mjs. It then
 * runs the real gate end to end in the copy twice, with the sabotage runner
 * replaced by a stub that writes a synthetic report: once consistent, once
 * partial with passed:true, and proves the sabotage facts flip. A dirty copy
 * proves subject_bound is false and nothing else is evaluated. The full
 * inventory is never run here.
 *
 *   node tools/architecture-selftest.mjs      prints { cases, ok }, exit 0 when every case holds
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyTree, git, removeTree } from './lib/tree-copy.mjs';
import { SABOTAGE_GATE, currentContext, recount, sha256File, verifySabotageReport } from './lib/verify-sabotage-report.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dest = join(root, 'tmp', 'architecture-selftest-tree');
const cases = [];
const check = (id, held, detail) => {
  cases.push({ id, ok: held === true, detail });
  process.stderr.write(`  ${held === true ? 'HOLDS ' : 'BROKEN'} ${id.padEnd(46)} ${detail}\n`);
};
const refused = (id, verdict, pattern) => check(id, verdict.ok === false && verdict.problems.some((problem) => pattern.test(problem)), verdict.ok ? 'ACCEPTED' : verdict.problems.filter((problem) => pattern.test(problem)).slice(0, 2).join('; ') || verdict.problems.slice(0, 2).join('; '));
const clone = (value) => JSON.parse(JSON.stringify(value));

/** A report the verifier would accept for `current`, every inventory id KILLED. */
function acceptableReport(current) {
  const ids = current.inventory.mutations.map((mutation) => mutation.id);
  const mutations = current.inventory.mutations.map((mutation) => ({ id: mutation.id, inventoryFile: mutation.inventoryFile, file: mutation.file, gate: mutation.gate, outcome: 'KILLED', detail: '1 of N tests failed', durationMs: 1 }));
  const { counts } = recount(mutations, ids);
  return {
    gate: SABOTAGE_GATE,
    mode: 'QUALIFICATION',
    qualifies: true,
    subject: { commit: current.subject.commit, tree: current.subject.tree, dirty: false, dirtyPaths: [], resolved: true },
    node: process.version,
    inventory: { files: clone(current.inventory.files), ids: current.inventory.mutations.map((mutation) => ({ id: mutation.id, inventoryFile: mutation.inventoryFile, file: mutation.file, gate: mutation.gate })) },
    producers: clone(current.producers),
    productionFiles: [...new Set(current.inventory.mutations.map((mutation) => mutation.file))].sort().map((file) => ({ file, sha256: sha256File(join(current.root, file)) })),
    baseline: { outcome: 'SURVIVED', detail: 'N tests passed', durationMs: 1 },
    counts,
    mutations,
    passed: true,
  };
}

/**
 * A stand-in for tools/sabotage.mjs inside the copy: writes the synthetic
 * report the case asks for and exits 0 either way, so the gate cannot lean
 * on the producer's exit code. Committed into the copy so the copy stays a
 * clean subject.
 */
const STUB = `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SABOTAGE_GATE, currentContext, recount, sha256File } from './lib/verify-sabotage-report.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const current = await currentContext(root);
const ids = current.inventory.mutations.map((m) => m.id);
let mutations = current.inventory.mutations.map((m) => ({ id: m.id, inventoryFile: m.inventoryFile, file: m.file, gate: m.gate, outcome: 'KILLED', detail: 'stub', durationMs: 1 }));
const counts = recount(mutations, ids).counts;
if (process.env.SELFTEST_SABOTAGE_STUB === 'partial') mutations = mutations.slice(1);
const report = { gate: SABOTAGE_GATE, mode: 'QUALIFICATION', qualifies: true, subject: { commit: current.subject.commit, tree: current.subject.tree, dirty: false }, node: process.version, inventory: { files: current.inventory.files, ids: current.inventory.mutations.map((m) => ({ id: m.id, inventoryFile: m.inventoryFile, file: m.file, gate: m.gate })) }, producers: current.producers, productionFiles: [...new Set(current.inventory.mutations.map((m) => m.file))].sort().map((file) => ({ file, sha256: sha256File(join(root, file)) })), baseline: { outcome: 'SURVIVED', detail: 'stub', durationMs: 1 }, counts, mutations, passed: true };
mkdirSync(join(root, 'tmp'), { recursive: true });
writeFileSync(join(root, 'tmp', 'sabotage-report.json'), JSON.stringify(report, null, 2) + '\\n');
process.stdout.write(JSON.stringify(report) + '\\n');
process.exit(0);
`;

const gate = (cwd, env = {}, extra = []) => {
  const result = spawnSync(process.execPath, ['tools/architecture-gate.mjs', '--out', join(cwd, 'tmp', 'gate-out.json'), ...extra], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60 * 60 * 1000, env: { ...process.env, ...env } });
  let report = null;
  try {
    report = JSON.parse(readFileSync(join(cwd, 'tmp', 'gate-out.json'), 'utf8'));
  } catch {
    report = null;
  }
  const value = (name) => report?.facts?.find((entry) => entry.name === name)?.value ?? null;
  const by = (name) => report?.facts?.find((entry) => entry.name === name)?.by ?? null;
  return { status: result.status, report, value, by, stderr: result.stderr };
};

process.stderr.write('\nARCHITECTURE SELF-TEST\n\n');
const statusBefore = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout;
let copy = null;
try {
  copy = copyTree(root, dest, 'SELFTEST');
  const current = await currentContext(copy.dest);
  const good = acceptableReport(current);
  const ids = current.inventory.mutations.map((mutation) => mutation.id);

  // 0. The acceptable report is accepted: the refusals below are not a verifier that refuses everything.
  const accepted = verifySabotageReport(good, current);
  check('consistent_report_accepted', accepted.ok === true && accepted.recomputed.killed === ids.length, accepted.ok ? `${String(ids.length)} of ${String(ids.length)} recomputed` : accepted.problems.slice(0, 3).join('; '));

  // 1. A record deleted, counts left as they were: partial.
  const partial = clone(good);
  partial.mutations.pop();
  refused('partial_records_refused', verifySabotageReport(partial, current), /has no record|counts\.killed says/u);

  // 1b. A record deleted and the counts made to agree with the deletion: still not the inventory.
  const partialHonest = clone(partial);
  partialHonest.counts = recount(partialHonest.mutations, ids).counts;
  refused('partial_records_with_matching_counts_refused', verifySabotageReport(partialHonest, current), /has no record|does not qualify/u);

  // 2. Counts edited over intact records.
  const edited = clone(good);
  edited.counts.killed += 1;
  edited.counts.inventory += 1;
  refused('edited_counts_refused', verifySabotageReport(edited, current), /counts\.(killed|inventory) says/u);

  // 3. The subject sha changed.
  const foreign = clone(good);
  foreign.subject.commit = 'b6fcbaf0eed6802cfd1d2b7354920bf3059550e2';
  refused('subject_sha_changed_refused', verifySabotageReport(foreign, current), /subject commit/u);
  const foreignTree = clone(good);
  foreignTree.subject.tree = '0'.repeat(40);
  refused('subject_tree_changed_refused', verifySabotageReport(foreignTree, current), /subject tree/u);

  // 4. Dirty when produced.
  const producedDirty = clone(good);
  producedDirty.subject.dirty = true;
  refused('report_produced_on_dirty_tree_refused', verifySabotageReport(producedDirty, current), /produced on a dirty tree/u);

  // 5. passed flipped to true while a record says SURVIVED.
  const flipped = clone(good);
  flipped.mutations[0].outcome = 'SURVIVED';
  refused('passed_flipped_over_survived_record_refused', verifySabotageReport(flipped, current), /record .* is SURVIVED|counts\.survived says|passed is true/u);
  // 5b. …and with the counts made honest too, passed:true is still a lie.
  const flippedHonest = clone(flipped);
  flippedHonest.counts = recount(flippedHonest.mutations, ids).counts;
  refused('passed_flipped_with_honest_counts_refused', verifySabotageReport(flippedHonest, current), /passed is true, the records say false/u);

  // 6. Outcomes that are not kills, each alone.
  for (const outcome of ['DID_NOT_COMPILE', 'INFRA_ERROR', 'NOT_REACHED']) {
    const one = clone(good);
    one.mutations[1].outcome = outcome;
    one.counts = recount(one.mutations, ids).counts;
    one.passed = false;
    refused(`one_${outcome.toLowerCase()}_refused`, verifySabotageReport(one, current), new RegExp(`is ${outcome}|does not qualify`, 'u'));
  }

  // 7. A diagnostic dressed as qualification: mode is the tell, and the missing records.
  const diagnostic = clone(good);
  diagnostic.mode = 'DIAGNOSTIC';
  diagnostic.qualifies = false;
  diagnostic.passed = false;
  refused('diagnostic_mode_refused', verifySabotageReport(diagnostic, current), /mode is DIAGNOSTIC/u);

  // 8. Duplicate records padding a missing one.
  const padded = clone(good);
  padded.mutations[padded.mutations.length - 1] = clone(padded.mutations[0]);
  refused('duplicate_records_refused', verifySabotageReport(padded, current), /appears more than once|has no record/u);

  // 9. A record for an id the inventory does not know.
  const stranger = clone(good);
  stranger.mutations.push({ ...clone(stranger.mutations[0]), id: 'NOT_IN_INVENTORY' });
  refused('record_outside_inventory_refused', verifySabotageReport(stranger, current), /not in the inventory/u);

  // 10. An inventory file changed after the run: the tree now disagrees with the report.
  const inventoryFile = join(copy.dest, 'tools', 'sabotage-inventory', current.inventory.files[0].file);
  appendFileSync(inventoryFile, '\n// changed after the run\n');
  refused('inventory_changed_after_run_refused', verifySabotageReport(good, await currentContext(copy.dest)), /inventory file .* changed after the run/u);
  git(copy.dest, ['checkout', '--', 'tools/sabotage-inventory']);

  // 10b. A mutation added to the inventory after the run: the report no longer covers it.
  appendFileSync(inventoryFile, "\nMUTATIONS.push({ id: 'selftest-added-after-run', file: 'src/index.ts', from: 'export', to: 'export', gate: 'selftest' });\n");
  refused('inventory_id_added_after_run_refused', verifySabotageReport(good, await currentContext(copy.dest)), /inventory ids|has no record/u);
  git(copy.dest, ['checkout', '--', 'tools/sabotage-inventory']);

  // 11. A producer changed after the run.
  appendFileSync(join(copy.dest, 'tools', 'run-tests.mjs'), '\n// changed after the run\n');
  refused('producer_changed_after_run_refused', verifySabotageReport(good, await currentContext(copy.dest)), /producer tools\/run-tests\.mjs hashes/u);
  git(copy.dest, ['checkout', '--', 'tools/run-tests.mjs']);

  // 12. A production file changed after the run, tree still the report's? No: the tree changes too. Both are named.
  appendFileSync(join(copy.dest, current.inventory.mutations[0].file), '\n// changed after the run\n');
  refused('production_file_changed_after_run_refused', verifySabotageReport(good, await currentContext(copy.dest)), /production file .* changed after the run|the current tree is dirty/u);
  git(copy.dest, ['checkout', '--', current.inventory.mutations[0].file]);

  // 13. The current tree is dirty: subject not bound, report refused even if it was fine when produced.
  writeFileSync(join(copy.dest, 'docs', 'SELFTEST_DIRTY.md'), 'dirty on purpose\n');
  const dirtyContext = await currentContext(copy.dest);
  refused('current_tree_dirty_refused', verifySabotageReport(good, dirtyContext), /current tree is dirty/u);
  check('dirty_tree_subject_reads_dirty', dirtyContext.subject.dirty === true && dirtyContext.subject.dirtyPaths.some((path) => /SELFTEST_DIRTY/u.test(path)), dirtyContext.subject.dirtyPaths.join(' | '));
  // …and the gate itself, end to end, refuses up front: subject_bound false, nothing else evaluated.
  const dirtyGate = gate(copy.dest);
  check('gate_refuses_dirty_tree_up_front', dirtyGate.status === 1 && dirtyGate.value('subject_bound') === false && dirtyGate.report?.INTELLIGENCE_CORE_ARCHITECTURE_CLOSED === 'FALSE' && dirtyGate.report?.subject?.dirty === true && dirtyGate.report?.facts?.filter((entry) => entry.name !== 'subject_bound').every((entry) => entry.value === false && entry.by === 'NOT_EVALUATED'), `exit ${String(dirtyGate.status)}; subject_bound ${String(dirtyGate.value('subject_bound'))}; ${String(dirtyGate.report?.facts?.length)} facts`);
  rmSync(join(copy.dest, 'docs', 'SELFTEST_DIRTY.md'));

  // 14. From another commit: the copy moves on by one commit and the old report no longer names HEAD.
  writeFileSync(join(copy.dest, 'docs', 'SELFTEST_NEXT.md'), 'a later commit\n');
  git(copy.dest, ['add', '-A']);
  git(copy.dest, ['commit', '-q', '-m', 'SELFTEST later commit']);
  refused('report_from_another_commit_refused', verifySabotageReport(good, await currentContext(copy.dest)), /subject commit .* is not the current HEAD/u);
  git(copy.dest, ['reset', '-q', '--hard', 'HEAD~1']);
  const back = await currentContext(copy.dest);
  check('copy_back_on_original_subject', back.subject.commit === copy.commit && verifySabotageReport(good, back).ok === true, back.subject.commit);

  // 15. The gate end to end, with the runner replaced by a stub committed into the copy.
  writeFileSync(join(copy.dest, 'tools', 'sabotage.mjs'), STUB);
  git(copy.dest, ['add', '-A']);
  git(copy.dest, ['commit', '-q', '-m', 'SELFTEST stub sabotage producer']);
  const stubSubject = git(copy.dest, ['rev-parse', 'HEAD']);
  const consistent = gate(copy.dest, { SELFTEST_SABOTAGE_STUB: 'consistent' });
  check('gate_accepts_consistent_stub_report', consistent.value('sabotage_all_killed') === true && consistent.value('sabotage_report_bound_to_subject') === true && consistent.value('subject_bound') === true && consistent.report?.subject?.commit === stubSubject && consistent.report?.sabotage?.subject?.commit === stubSubject, `sabotage_all_killed ${String(consistent.value('sabotage_all_killed'))}, bound ${String(consistent.value('sabotage_report_bound_to_subject'))}, CLOSED ${String(consistent.report?.INTELLIGENCE_CORE_ARCHITECTURE_CLOSED)}, exit ${String(consistent.status)}`);
  check('gate_records_producers_and_closure', Array.isArray(consistent.report?.dependencyClosure) && consistent.report.dependencyClosure.some((entry) => entry.name === 'typescript') && typeof consistent.report?.producers?.['tools/architecture-gate.mjs'] === 'string' && typeof consistent.report?.consumer?.tarballSha256 === 'string' && consistent.report?.consumer?.migrationCoreTarballSha256 === JSON.parse(readFileSync(join(root, 'vendor', 'MANIFEST.json'), 'utf8')).sha256, `closure ${String(consistent.report?.dependencyClosure?.length)} packages; tarball ${String(consistent.report?.consumer?.tarballSha256).slice(0, 12)}`);
  check('gate_probes_executed', ['egress_binding', 'budget_per_request_ceiling', 'run_transitions_closed', 'classifier_email_not_safe', 'compiler_target_outside_envelope'].every((name) => consistent.value(`probe_${name}`) === true && consistent.by(`probe_${name}`) === 'EXECUTED'), consistent.report?.facts?.filter((entry) => entry.name.startsWith('probe_')).map((entry) => `${entry.name}=${String(entry.value)}`).join(' '));
  const partialGate = gate(copy.dest, { SELFTEST_SABOTAGE_STUB: 'partial' });
  check('gate_refuses_partial_stub_report_with_passed_true', partialGate.status === 1 && partialGate.value('sabotage_all_killed') === false && partialGate.value('sabotage_report_bound_to_subject') === false && partialGate.report?.INTELLIGENCE_CORE_ARCHITECTURE_CLOSED === 'FALSE' && /has no record|counts\.killed says/u.test(partialGate.report?.facts?.find((entry) => entry.name === 'sabotage_report_bound_to_subject')?.detail ?? ''), `exit ${String(partialGate.status)}; sabotage_all_killed ${String(partialGate.value('sabotage_all_killed'))}; ${String(partialGate.report?.facts?.find((entry) => entry.name === 'sabotage_report_bound_to_subject')?.detail).slice(0, 120)}`);
  // 15b. A supplied report (how CI reuses the merged shards): verified like a produced one, and not re-run.
  const suppliedPath = join(copy.dest, 'tmp', 'supplied-sabotage-report.json');
  const produceStub = (mode) => {
    spawnSync(process.execPath, ['tools/sabotage.mjs'], { cwd: copy.dest, env: { ...process.env, SELFTEST_SABOTAGE_STUB: mode } });
    renameSync(join(copy.dest, 'tmp', 'sabotage-report.json'), suppliedPath);
  };
  produceStub('consistent');
  // Under GitHub Actions the gate also requires the supplied report to name GITHUB_SHA. The copy's subject is a commit
  // made here, never the workflow's, so the environment is set explicitly: the copy as the workflow's commit (accepted),
  // and the inherited workflow commit (refused). Inheriting it silently made this case fail only in CI.
  const asWorkflowOf = (sha) => ({ GITHUB_ACTIONS: 'true', GITHUB_SHA: sha });
  const supplied = gate(copy.dest, asWorkflowOf(stubSubject), ['--sabotage-report', suppliedPath]);
  check('gate_accepts_supplied_verified_report_without_running_sabotage', supplied.value('sabotage_all_killed') === true && supplied.by('sabotage_all_killed') === 'VERIFIED' && supplied.value('sabotage_report_bound_to_subject') === true && supplied.report?.sabotage?.origin === 'SUPPLIED_AND_VERIFIED' && !existsSync(join(copy.dest, 'tmp', 'sabotage-report.json')) && supplied.report?.INTELLIGENCE_CORE_ARCHITECTURE_CLOSED === 'TRUE', `sabotage_all_killed ${String(supplied.value('sabotage_all_killed'))} by ${String(supplied.by('sabotage_all_killed'))}, origin ${String(supplied.report?.sabotage?.origin)}, CLOSED ${String(supplied.report?.INTELLIGENCE_CORE_ARCHITECTURE_CLOSED)}, runner output present ${String(existsSync(join(copy.dest, 'tmp', 'sabotage-report.json')))}`);
  const otherWorkflow = gate(copy.dest, asWorkflowOf('0'.repeat(40)), ['--sabotage-report', suppliedPath]);
  check('gate_refuses_supplied_report_of_another_workflow_commit', otherWorkflow.status === 1 && otherWorkflow.value('sabotage_all_killed') === false && /is not GITHUB_SHA 0{40}/u.test(otherWorkflow.report?.facts?.find((entry) => entry.name === 'sabotage_report_bound_to_subject')?.detail ?? ''), `exit ${String(otherWorkflow.status)}; ${String(otherWorkflow.report?.facts?.find((entry) => entry.name === 'sabotage_report_bound_to_subject')?.detail).slice(0, 120)}`);
  produceStub('partial');
  const suppliedPartial = gate(copy.dest, asWorkflowOf(stubSubject), ['--sabotage-report', suppliedPath]);
  check('gate_refuses_supplied_partial_report', suppliedPartial.status === 1 && suppliedPartial.value('sabotage_all_killed') === false && suppliedPartial.value('sabotage_report_bound_to_subject') === false && suppliedPartial.report?.INTELLIGENCE_CORE_ARCHITECTURE_CLOSED === 'FALSE', `exit ${String(suppliedPartial.status)}; sabotage_all_killed ${String(suppliedPartial.value('sabotage_all_killed'))}`);
  check('gate_refuses_supplied_report_flag_without_a_path', spawnSync(process.execPath, ['tools/architecture-gate.mjs', '--sabotage-report'], { cwd: copy.dest, encoding: 'utf8' }).status === 2, '--sabotage-report needs a path');
  check('gate_rejects_unknown_flags', spawnSync(process.execPath, ['tools/architecture-gate.mjs', '--skip-sabotage'], { cwd: copy.dest, encoding: 'utf8' }).status === 2, '--skip-sabotage is not an option of the gate');

  // 16. The real tree is as it was.
  const statusAfter = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout;
  check('real_tree_untouched', statusAfter === statusBefore, 'git status --porcelain unchanged by the self-test');
} catch (error) {
  check('selftest_ran_to_completion', false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  const removed = copy === null ? !existsSync(dest) : removeTree(dest);
  check('temporary_copy_removed', removed, dest);
}
const ok = cases.length > 0 && cases.every((entry) => entry.ok);
process.stdout.write(`${JSON.stringify({ artifactKind: 'INTELLIGENCE_CORE_ARCHITECTURE_SELFTEST', subjectLabel: 'SELFTEST', cases, ok }, null, 2)}\n`);
process.stderr.write(`\nARCHITECTURE SELF-TEST = ${ok ? 'PASS' : 'FALSE'} (${String(cases.filter((entry) => entry.ok).length)} of ${String(cases.length)} hold)\n\n`);
process.exit(ok ? 0 : 1);
