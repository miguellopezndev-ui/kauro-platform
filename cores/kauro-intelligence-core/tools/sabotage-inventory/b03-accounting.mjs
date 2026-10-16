/**
 * Sabotage inventory — the B03-ACCOUNTING lot: the expected candidate set
 * and its exact accounting (D3-ACC-1, D3-ACC-2), omission refused as
 * CANDIDATE_NOT_ANSWERED (D3-ACC-3), one output scope for every claim
 * (D3-SCOPE-1) and the partition under the task cap and the per-request
 * bound (D3-PART-1). Each mutation sits in the code it guards; the tests of
 * test/b03-accounting.test.ts kill them. Same shape as core.mjs; ids are
 * unique across the directory.
 */
export const MUTATIONS = [
  { id: 'accounting-original-type-unrouted', file: 'src/planner/candidate-accounting.ts', from: "  DUPLICATE_CLUSTER: (): TaskType => 'DUPLICATE_SIGNAL_STRATEGY',\n", to: '', gate: "a Migration Core duplicate cluster has no route: it is accounted as an unsupported type, not as the duplicate-signal family's pending question" },
  { id: 'accounting-type-text-carried', file: 'src/planner/candidate-accounting.ts', from: 'candidateType: family === null ? UNROUTED_TYPE : candidate.candidateType, family };', to: 'candidateType: candidate.candidateType, family };', gate: 'an original of a type outside the closed vocabulary carries its own text into the public accounting' },
  { id: 'accounting-check-removed', file: 'src/api/intelligence-core.ts', from: 'if (accountingProblems.length > 0) {', to: 'if (accountingProblems.length < 0) {', gate: 'the finalizer drafts over a disposition list that repeats a candidate: a candidate set that lists one candidate twice reaches PROPOSAL_READY' },
  { id: 'accounting-miss-not-detected', file: 'src/planner/candidate-accounting.ts', from: '    if (times === 0) problems.push(`MISSING_DISPOSITION:${ref}`);\n', to: '', gate: 'the accounting check accepts a disposition list that leaves an expected candidate out' },
  { id: 'accounting-pending-cap-dropped', file: 'src/planner/candidate-accounting.ts', from: "    } else if (pending !== undefined) decided = ['PENDING_CAP', pending];", to: '    }', gate: 'a candidate beyond the task cap or the request bound is not PENDING_CAP by its ref: the plan drops it into an unplanned question' },
  { id: 'accounting-coverage-always-complete', file: 'src/planner/candidate-accounting.ts', from: 'complete: pendingCandidates === 0 && unresolvedCandidates === 0 && !input.expected.truncated,', to: 'complete: true,', gate: 'a draft with pending and unresolved candidates presents itself as complete' },
  { id: 'claims-keyed-by-target-alone', file: 'src/compiler/compiler.ts', from: "const claimScope = outputScopeOf(sourceFieldRef === null ? null : (recordMappingOfField.get(sourceFieldRef) ?? null), destinationField === null || destinationField === '' ? item.targetRef : destinationField);", to: 'const claimScope = item.targetRef;', gate: "the compiler claims a target once per proposal again: the second Contact file's model mapping to contact.email is DUPLICATE_TARGET_WITHOUT_RESOLUTION (B03-R5)" },
  { id: 'omission-preserved-again', file: 'src/compiler/compiler.ts', from: "outcome: 'INVALID_SEMANTICS', codes: ['CANDIDATE_NOT_ANSWERED']", to: "outcome: 'ABSTAINED', codes: ['CANDIDATE_NOT_ANSWERED']", gate: 'a candidate an answer leaves out is preserved as if answered, never repaired and never refused' },
  { id: 'partition-ignores-request-estimate', file: 'src/planner/task-planner.ts', from: 'const fits = (batch: readonly OpenQuestion[]): boolean => estimate === undefined || estimate(batch) <= bound;', to: 'const fits = (batch: readonly OpenQuestion[]): boolean => batch.length >= 0;', gate: 'the planner batches by complexity alone: a question whose envelope cannot fit one request is sent above the per-request bound' },
  { id: 'request-estimate-omits-targets', file: 'src/planner/candidate-accounting.ts', from: 'const cost = (view === undefined ? 0 : wireBytes(view) + 4 * MASK_ROOM + 1) + 2 * (wireBytes(targetRef) + 1);', to: 'const cost = 2 * (wireBytes(targetRef) + 1);', gate: "the request-size estimate leaves the targets' views and options out: requests above the per-request bound are planned as if they fit" },
];
