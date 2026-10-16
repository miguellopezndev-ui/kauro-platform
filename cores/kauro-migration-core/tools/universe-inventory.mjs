/**
 * The steps an offline universe must have run, stated apart from the tool that
 * runs them.
 *
 * `tools/release-candidate-gate.mjs` used to accept a universe report by asking
 * whether any recorded step had failed (MC-2 item 7). A report with no steps,
 * with a step missing, with a step recorded twice or with a step marked skipped
 * had no failed step, and passed. The gate now asks whether the report holds
 * exactly this inventory, once each, in this order, each `ok`, none skipped —
 * and `tools/universe.mjs` asserts at start-up that the steps it is about to run
 * are exactly this list, so the two cannot drift apart without one of them
 * saying so.
 *
 * Adding a step means adding it here and to the universe in the same change.
 */
export const UNIVERSE_SCHEMA_VERSION = '1.2.0';

export const UNIVERSE_STEP_IDS = Object.freeze([
  'typecheck',
  'contract-lint',
  'spec-drift',
  'evidence-rules',
  'constitution',
  'target-contract',
  'tests',
  'source-backed',
  'adversarial',
  'determinism',
  'acceptance',
  'artifacts-reproducible',
  'provenance',
  'drift',
  'dependency-audit',
  'dependency-budget',
  'architecture',
  'sabotage',
  'sabotage-left-no-trace',
]);

/** The statuses a step record may carry. Anything else is a report this reader does not understand. */
export const UNIVERSE_STEP_STATUSES = Object.freeze(['ok', 'failed', 'skipped', 'not-run']);

/**
 * Everything wrong with a universe report, against this inventory.
 *
 * @param {object|null} report the parsed `qualification/candidate/universe.json`
 * @returns {string[]}
 */
export function universeReportProblems(report) {
  const problems = [];
  if (report === null || typeof report !== 'object') return ['the universe report is not an object'];
  if (report.schemaVersion !== UNIVERSE_SCHEMA_VERSION) {
    problems.push(`the report is schema ${String(report.schemaVersion)} and this reader validates ${UNIVERSE_SCHEMA_VERSION}`);
  }
  if (report.scope !== 'FULL') problems.push(`the report is scope ${String(report.scope)}, and only a FULL run qualifies a candidate`);
  const steps = Array.isArray(report.steps) ? report.steps : null;
  if (steps === null || steps.length === 0) {
    problems.push('the report records no steps at all');
    return problems;
  }
  const seen = new Map();
  for (const [index, step] of steps.entries()) {
    if (step === null || typeof step !== 'object' || typeof step.id !== 'string') {
      problems.push(`step ${String(index)} has no id`);
      continue;
    }
    seen.set(step.id, (seen.get(step.id) ?? 0) + 1);
    if (!UNIVERSE_STEP_IDS.includes(step.id)) problems.push(`step "${step.id}" is not in the normative inventory`);
    if (!UNIVERSE_STEP_STATUSES.includes(step.status)) problems.push(`step "${step.id}" has status ${String(step.status)}, which is not one this reader knows`);
    if (step.ok !== true) problems.push(`step "${step.id}" is not ok: ${String(step.detail ?? '').slice(0, 200)}`);
    if (step.skipped === true || step.status === 'skipped' || step.status === 'not-run') problems.push(`step "${step.id}" was skipped`);
    if (typeof step.exitStatus !== 'number' || step.exitStatus !== 0) problems.push(`step "${step.id}" records exit status ${String(step.exitStatus)}`);
    if (typeof step.outputSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(step.outputSha256)) {
      problems.push(`step "${step.id}" records no digest of its full output`);
    }
    if (typeof step.logPath !== 'string' || step.logPath === '') problems.push(`step "${step.id}" names no log file holding its full output`);
  }
  for (const id of UNIVERSE_STEP_IDS) {
    const count = seen.get(id) ?? 0;
    if (count === 0) problems.push(`step "${id}" is missing from the report`);
    else if (count > 1) problems.push(`step "${id}" appears ${String(count)} times`);
  }
  const order = steps.map((step) => step.id).filter((id) => UNIVERSE_STEP_IDS.includes(id));
  const expected = UNIVERSE_STEP_IDS.filter((id) => order.includes(id));
  if (order.join('\n') !== expected.join('\n')) problems.push('the steps are not in the inventory order');
  return problems;
}
