/**
 * Sabotage inventory — the B03-PLAN-COMPILER lot: the plan compiler turns the
 * agency's selection into a configuration or a closed rejection (D3-PLAN-1,
 * review finding B03-R1). Each mutation sits in the code it guards: a
 * candidate the selection omits is rejected, never preserved for the agency;
 * one it decides twice is rejected, never accepted; a deterministic fragment
 * needs the audit's DecisionEvidence; a choice stays inside the candidate's
 * primitive intersection; the expected set must be the one this input has;
 * and one selection has one digest, with no clock or counter in it. The tests
 * of test/b03-plan-compiler.test.ts kill them. Same shape as core.mjs; ids
 * are unique across the directory.
 */
export const MUTATIONS = [
  { id: 'plan-omitted-candidate-preserved', file: 'src/compiler/plan-compiler.ts', from: "for (const ref of [...expectedRefs].sort(compare)) if (!byRef.has(ref)) reject('MISSING_CANDIDATE', ref);", to: 'for (const ref of [...expectedRefs].sort(compare)) if (!byRef.has(ref)) void ref;', gate: 'a candidate the agency never decided is left out of the plan without a word: the omission is preserved instead of rejected as MISSING_CANDIDATE' },
  { id: 'plan-duplicate-candidate-accepted', file: 'src/compiler/plan-compiler.ts', from: "else if ((byRef.get(ref) ?? []).length > 1) reject('DUPLICATE_CANDIDATE', ref);", to: 'else if ((byRef.get(ref) ?? []).length > 1) void ref;', gate: 'a candidate decided twice compiles: the repeat is accepted instead of rejected as DUPLICATE_CANDIDATE' },
  { id: 'plan-evidence-not-required', file: 'src/compiler/plan-compiler.ts', from: 'if (proof === undefined || (decision !== undefined && (decision.rule !== rule || (kind !== undefined && proof.fragmentKind !== kind)))) {', to: 'if (Boolean(proof) && false) {', gate: 'a deterministic fragment compiles with no DecisionEvidence, evidence of another rule or evidence of another revision: EVIDENCE_MISSING is never raised' },
  { id: 'plan-digest-time-dependent', file: 'src/compiler/plan-compiler.ts', from: 'configurationRef: `cfg_${digestOf({ ...fragments, profile: contracts.profileHash }).slice(0, 16)}`', to: 'configurationRef: `cfg_${digestOf({ ...fragments, profile: contracts.profileHash, at: String(process.hrtime.bigint()) }).slice(0, 16)}`', gate: 'the same selection compiles to a different configuration digest on every call: the host\'s idempotency key names a new plan each time' },
  { id: 'plan-primitive-intersection-not-checked', file: 'src/compiler/plan-compiler.ts', from: '!candidate.allowedPrimitiveRefs.includes(named) || ', to: '', gate: 'a mapping names a primitive the candidate does not allow and compiles: PRIMITIVE_OUTSIDE_INTERSECTION is never raised for a primitive in the catalogue' },
  { id: 'plan-stale-expected-set-accepted', file: 'src/compiler/plan-compiler.ts', from: 'if (expected.expectedSetHash !== recomputed.expectedSetHash) throw', to: 'if (expected.expectedSetHash === undefined) throw', gate: 'a selection over the expected set of another profile compiles against this one instead of failing as STALE_INPUT' },
];
