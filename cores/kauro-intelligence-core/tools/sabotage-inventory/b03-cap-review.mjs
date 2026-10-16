/**
 * Sabotage inventory — the B03-CAP-REVIEW lot: the consistency review over
 * every compiled decision (D3-CAP-11) and the semantic repair that keeps the
 * original task's permissions (D3-CAP-12). The mandate's four — the review
 * allowed to map, the stronger claim preserved, the repair set widened, a
 * third attempt allowed — then the guards beside them: a deterministic
 * decision dropped by a review, the review's preserve not applied in
 * assembly, and the two feedback channels widened (the review carrying every
 * column of the contested file, the repair offering refs the task never
 * allowed). Each mutation sits in the code it guards; the tests of
 * test/b03-cap-review.test.ts kill them. Same shape as core.mjs; ids are
 * unique across the directory.
 */
export const MUTATIONS = [
  // D3-CAP-11: a review preserves one named decision, asks the agency or abstains; it never maps.
  { id: 'review-allowed-to-map', file: 'src/envelope/envelope-builder.ts', from: "  CONSISTENCY_REVIEW: ['UNMAPPED_PRESERVE', 'NEEDS_AGENCY_DECISION', 'ABSTAIN'],", to: "  CONSISTENCY_REVIEW: ['UNMAPPED_PRESERVE', 'NEEDS_AGENCY_DECISION', 'ABSTAIN', 'MAP_FIELD'],", gate: 'a CONSISTENCY_REVIEW envelope offers MAP_FIELD: the review may map where it may only preserve a named decision or ask the agency (D3-CAP-11)' },
  // D3-CAP-11: only the claim strictly weaker by computed evidence class may be preserved.
  { id: 'review-stronger-claim-preserved', file: 'src/compiler/consistency.ts', from: 'EVIDENCE_RANK[named.evidenceClass] < EVIDENCE_RANK[claim.evidenceClass]', to: 'EVIDENCE_RANK[named.evidenceClass] > EVIDENCE_RANK[claim.evidenceClass]', gate: 'a review that preserves the stronger claim is accepted and the evidenced preserve of the weaker one is refused: Migration Core receives the weaker mapping of contact.email (D3-CAP-11)' },
  // D3-CAP-12: a repair round carries exactly the permissions of the task it repairs.
  { id: 'repair-set-widened', file: 'src/envelope/envelope-builder.ts', from: ' : TASK_ALLOWED_TYPES[repairOf];', to: " : [...new Set<ProposalType>([...TASK_ALLOWED_TYPES[repairOf], 'MAP_FIELD', 'SELECT_SEMANTIC_TYPE', 'MAP_ENUM_VALUE', 'UNMAPPED_PRESERVE'])];", gate: "a repair round offers proposal types the repaired task never had, and an answer outside the original set compiles instead of FORBIDDEN (D3-CAP-12)" },
  // D3-CAP-12: never more than two semantic attempts per task.
  { id: 'repair-third-attempt', file: 'src/contracts/run.ts', from: '  MAX_SEMANTIC_ATTEMPTS_PER_TASK: 2,', to: '  MAX_SEMANTIC_ATTEMPTS_PER_TASK: 3,', gate: 'a second invalid answer is not final: the task is repaired again and a third request leaves (D3-CAP-12)' },
  // D3-CAP-11: a deterministic decision is never dropped by a review.
  { id: 'review-deterministic-decision-dropped', file: 'src/compiler/consistency.ts', from: "  if (named?.origin === 'DETERMINISTIC' || (named === undefined && decisions.some((decision) => decision.decisionRef === item.targetRef))) return { kind: 'AGENCY', code: REVIEW_AGENCY_CODES.DETERMINISTIC_KEPT };\n", to: '', gate: 'a review answer that names a deterministic decision is no agency decision: it is repaired and fails the run instead of leaving the contradiction to the agency (D3-CAP-11)' },
  // D3-CAP-11 effect: the dropped fragment leaves the configuration and its column joins the leftovers.
  { id: 'review-preserve-not-applied', file: 'src/api/intelligence-core.ts', from: '      // A claim the review preserved as the weaker one puts nothing in: its column is a leftover, preserved by the review\'s decision, and the other claim of the scope stands.\n      const droppedBy = review.dropped.get(item.candidateRef);', to: '      const droppedBy = undefined as CompiledItem | undefined;', gate: "an accepted review preserve changes nothing in assembly: the earlier claim is delivered, the other is left to the agency and the weaker column is not the review's leftover (D3-CAP-11)" },
  // The review channel (privacy): the contested columns and no other.
  { id: 'review-view-widened', file: 'src/compiler/consistency.ts', from: '      sourceRefs: fieldRefs,', to: "      sourceRefs: [...contracts.refs.fieldByRef.keys()].filter((ref) => contracts.refs.fieldByRef.get(ref)?.fileId === contracts.refs.fieldByRef.get(fieldRefs[0] ?? '')?.fileId),", gate: 'a CONSISTENCY_REVIEW envelope carries every column of the contested file, headers and values, beside the claims it reviews' },
  // The repair feedback channel (privacy): the refs the repaired task allowed and nothing else.
  { id: 'repair-refs-widened', file: 'src/api/intelligence-core.ts', from: 'validationCodes: [...new Set(compiled.codes)].slice(0, 64), allowedValues: [], allowedTargetRefs: [...built.envelope.constraints.allowedTargetIds] };', to: 'validationCodes: [...new Set(compiled.codes)].slice(0, 64), allowedValues: [], allowedTargetRefs: [...contracts.refs.targetByRef.keys()] };', gate: "a repair round's context offers every target of the contract, beyond the refs the repaired task allowed (D3-CAP-12)" },
];
