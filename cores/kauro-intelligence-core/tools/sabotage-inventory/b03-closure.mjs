/**
 * Sabotage inventory — the B03-INTEGRATION lot: the closed design met across
 * all twelve capability families at once (S036, S095, R2-037; D3-ACC-2,
 * D3-CFG-3, D3-GRANT-1, D3-PART-1). Each mutation breaks, in the merged code,
 * one rule that only a run over the combined scenario checks end to end: a
 * family left unplanned, the accounting and the effect checks bypassed
 * together, and the tasks a stop by the grant leaves unstarted. The tests of
 * test/b03-closure.test.ts must kill each. Same shape as core.mjs; ids are
 * unique across the directory.
 */
export const MUTATIONS = [
  // S095, D3-PART-1, D3-GRANT-1: what the admission cannot hold is pending by name, never by omission.
  { id: 'closure-unstarted-tasks-left-silent', file: 'src/api/intelligence-core.ts', from: 'if (stoppedBy !== undefined && !ledger.view().cancelled', to: 'if (false as boolean && stoppedBy !== undefined && !ledger.view().cancelled', gate: 'a stop by the grant leaves the planned tasks after it with no outcome on the result or the record: they do not end BUDGET_EXHAUSTED' },
  { id: 'closure-unstarted-tasks-unrecorded', file: 'src/api/intelligence-core.ts', from: "        ledger.recordTaskOutcome({ taskId: task.taskId, outcome: 'BUDGET_EXHAUSTED', attempt: 0, codes: [...stoppedBy.codes], envelopeHash: null, proposalDigest: null });\n", to: '', gate: 'the tasks a stop never started end BUDGET_EXHAUSTED on the result only: a redelivery finds nothing on the record' },
  { id: 'closure-unstarted-tasks-cause-dropped', file: 'src/api/intelligence-core.ts', from: 'envelopeHash: null, proposalDigest: null, codes: [...stoppedBy.codes] });', to: "envelopeHash: null, proposalDigest: null, codes: ['BUDGET_EXHAUSTED'] });", gate: 'the tasks a stop never started do not name the grant that stopped the run' },
  { id: 'closure-budget-stop-not-pending', file: 'src/planner/candidate-accounting.ts', from: "    return ['PENDING_BUDGET', 'BUDGET_EXHAUSTED'];", to: "    return ['FAILED', 'BUDGET_EXHAUSTED'];", gate: 'the candidates of a task the grant could not admit are FAILED, not PENDING_BUDGET: the pending scope is no longer named and the draft reads as a failure, not as an incomplete coverage' },
  // R2-037, D3-ACC-2: a family nobody plans is not a family the run closed.
  { id: 'closure-duplicate-family-unplanned', file: 'src/resolver/identity-families.ts', from: "questions.push({ questionRef: `q_${digestOf(['duplicate', scopeFiles]).slice(0, 16)}`, taskType: 'DUPLICATE_SIGNAL_STRATEGY',", to: "void ({ questionRef: `q_${digestOf(['duplicate', scopeFiles]).slice(0, 16)}`, taskType: 'DUPLICATE_SIGNAL_STRATEGY',", gate: 'the duplicate clusters Migration Core reported wait for a family no task asks: no DUPLICATE_SIGNAL_STRATEGY question is planned' },
  // R2-037, D3-ACC-1, D3-CFG-3: the accounting check and the coverage check, bypassed together.
  { id: 'closure-accounting-and-effects-bypassed', file: 'src/api/intelligence-core.ts', from: 'const accountingProblems = candidateAccountingProblems(expected, accounted.dispositions);', to: 'const accountingProblems: string[] = [];\n    Object.assign(assembled, { fragmentDecisions: [] });\n    void candidateAccountingProblems;', gate: 'the finalizer neither checks the disposition list nor meets any decision with its fragment and its reported effect: a draft is made over a run whose families the accounting and the receipt never confirmed' },
];
