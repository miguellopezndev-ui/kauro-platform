/**
 * The consistency review, D3-CAP-11 (review finding B03-R9, case CAP11).
 *
 * The last phase of a run (D3-PART-1). Once every other family has been
 * compiled, a deterministic detector reads every decision that stands — the
 * resolver's, and the model's the compiler accepted — and names each
 * contradiction between them:
 *
 * - SAME_SCOPE_TARGET: two columns claim one output scope, one destination of
 *   one record mapping (D3-SCOPE-1);
 * - TYPE_AGAINST_TRANSFORM: a semantic type, a transformation or a value map
 *   that disagrees with the type of the field it lands on;
 * - ASSOCIATION_KEY_REUSED: an association key column that is also mapped as
 *   a field or used as identity;
 * - REQUIRED_TARGET_PRESERVED: a required target satisfied by a column that
 *   another decision preserves.
 *
 * Each contradiction is one CONSISTENCY_REVIEW candidate whose allowed refs
 * are the decisions it names, each with its origin and the evidence class the
 * compiler computed from the facts (a deterministic rule stands on its
 * rule's class). What a review may answer, and what the compiler makes of it,
 * is in compiler.ts: a preserve of the claim strictly weaker than every
 * other, never of a deterministic decision, or the agency.
 *
 * Refs, closed kinds and computed classes only: nothing here reads a row, a
 * value, a header, or anything a model wrote beyond the items the compiler
 * accepted.
 */
import type { AdaptedContracts } from '../adapter/contract-adapter.js';
import { digestOf } from '../contracts/canonical.js';
import { REVIEW_CANDIDATE_TYPE } from '../contracts/envelope.js';
import type { ContradictionKind, DeterministicCandidate, ReviewClaimView } from '../contracts/envelope.js';
import { outputScopeOf, recordMappingIdOf } from '../contracts/output-scope.js';
import { PRIMITIVES } from '../contracts/proposal.js';
import type { EvidenceClass, PrimitiveRef } from '../contracts/proposal.js';
import type { OpenQuestion, ResolvedDecision } from '../resolver/deterministic-resolver.js';
import type { CompiledItem, CompiledTask } from './compiler.js';

/** The evidence class a deterministic rule stands on: an exact header match with a compatible shape is what the compiler calls STRONG for a proposal; any other rule that decides something is SUPPORTED by its facts. */
export const DETERMINISTIC_EVIDENCE_CLASS: Readonly<Record<string, EvidenceClass>> = Object.freeze({ EXACT_HEADER_MATCH_AND_COMPATIBLE_SHAPE: 'STRONG' });
export const deterministicEvidenceClass = (rule: string): EvidenceClass => DETERMINISTIC_EVIDENCE_CLASS[rule] ?? 'SUPPORTED';

/** The order of the evidence classes: a claim is weaker than another when its class ranks lower. */
export const EVIDENCE_RANK: Readonly<Record<EvidenceClass, number>> = Object.freeze({ INSUFFICIENT: 0, AMBIGUOUS: 1, SUPPORTED: 2, STRONG: 3 });

/** Whether the named claim is strictly weaker, by computed evidence class, than every other claim of its contradiction: a tie is no ground to drop either. */
export function strictlyWeakest(named: Pick<ReviewClaimView, 'decisionRef' | 'evidenceClass'>, claims: readonly Pick<ReviewClaimView, 'decisionRef' | 'evidenceClass'>[]): boolean {
  return claims.every((claim) => claim.decisionRef === named.decisionRef || EVIDENCE_RANK[named.evidenceClass] < EVIDENCE_RANK[claim.evidenceClass]);
}

/** What a claim does to the configuration: puts a field in, changes the field another claim put in, preserves a column, keys an association, or names an identity. */
type ClaimRole = 'FIELD' | 'MODIFIER' | 'PRESERVE' | 'ASSOCIATION' | 'IDENTITY';

/** One decision that stands, as the detector reads it. */
interface Claim {
  readonly decisionRef: string;
  readonly origin: 'DETERMINISTIC' | 'PROPOSED';
  readonly role: ClaimRole;
  readonly fieldRef: string;
  /** The contract target the claim names, when it names one. */
  readonly targetRef: string | null;
  readonly destinationField: string | null;
  readonly semanticType: string | null;
  readonly proposalType: string | null;
  readonly primitive: string | null;
  readonly evidenceClass: EvidenceClass;
  readonly evidenceRefs: readonly string[];
  readonly impactRows: number;
}

/** One contradiction: the review candidate that names it, its claims in the order the run met them, and the question the planner partitions. */
export interface Contradiction {
  readonly kind: ContradictionKind;
  readonly recordMappingId: string | null;
  readonly candidate: DeterministicCandidate;
  readonly claims: readonly ReviewClaimView[];
  readonly question: OpenQuestion;
}

export interface ReviewInput {
  readonly contracts: AdaptedContracts;
  /** The resolver's decisions: the deterministic claims, which come first. */
  readonly decisions: readonly ResolvedDecision[];
  /** The final compilation of every task the run compiled, in task order: the model's claims, in the order the run met them. */
  readonly compiled: readonly CompiledTask[];
}

/** The task outcomes of which nothing is accepted. */
const REFUSED: ReadonlySet<string> = new Set(['INVALID_SCHEMA', 'INVALID_SEMANTICS', 'FORBIDDEN_PROPOSAL', 'STALE_INPUT', 'INCOMPATIBLE_CONTRACT_VERSION']);
const MODIFIERS: ReadonlySet<string> = new Set(['SELECT_SEMANTIC_TYPE', 'APPLY_SUPPORTED_TRANSFORM', 'MAP_ENUM_VALUE']);

/** The role of an accepted item, or null for one that decides nothing the review reads. */
function roleOf(item: CompiledItem): ClaimRole | null {
  if (item.sourceFieldRef === null) return null;
  if (item.proposalType === 'UNMAPPED_PRESERVE' && (item.outcome === 'ABSTAINED' || item.outcome === 'PROPOSED')) return 'PRESERVE';
  if (item.outcome !== 'PROPOSED') return null;
  if (item.proposalType === 'MAP_FIELD') return item.destinationField === null ? null : 'FIELD';
  if (MODIFIERS.has(item.proposalType)) return item.destinationField === null ? null : 'MODIFIER';
  if (item.proposalType === 'MAP_ASSOCIATION') return 'ASSOCIATION';
  if (item.proposalType === 'PROPOSE_IDENTITY_STRATEGY') return 'IDENTITY';
  return null;
}

/** Every decision that stands: the resolver's first, then the accepted items in task order — the order assembly applies them in, so the first claim of a scope is the one that stands when nothing settles it. */
function claimsOf(input: ReviewInput): readonly Claim[] {
  const { contracts } = input;
  const claims: Claim[] = [];
  for (const decision of input.decisions) {
    if (decision.kind === 'FIELD_MAPPING' && decision.targetRef !== null) {
      const destination = contracts.refs.targetByRef.get(decision.targetRef)?.destinationField ?? '';
      if (destination === '') continue;
      claims.push({ decisionRef: decision.decisionRef, origin: 'DETERMINISTIC', role: 'FIELD', fieldRef: decision.fieldRef, targetRef: decision.targetRef, destinationField: destination, semanticType: decision.semanticType, proposalType: null, primitive: null, evidenceClass: deterministicEvidenceClass(decision.rule), evidenceRefs: decision.evidenceRefs, impactRows: decision.impactRows });
    } else if (decision.kind === 'IDENTITY_PROOF' && decision.identityProof === 'PROVEN_UNIQUE_IDENTIFIER') {
      // The record id the project declares, or a contract external id named exactly: identity on facts.
      claims.push({ decisionRef: decision.decisionRef, origin: 'DETERMINISTIC', role: 'IDENTITY', fieldRef: decision.fieldRef, targetRef: null, destinationField: null, semanticType: null, proposalType: null, primitive: null, evidenceClass: deterministicEvidenceClass(decision.rule), evidenceRefs: decision.evidenceRefs, impactRows: decision.impactRows });
    }
  }
  for (const task of input.compiled) {
    if (REFUSED.has(task.outcome)) continue;
    for (const item of task.items) {
      const role = roleOf(item);
      if (role === null || item.sourceFieldRef === null) continue;
      const targetRef = item.targetRef !== null && contracts.refs.targetByRef.has(item.targetRef) ? item.targetRef : null;
      claims.push({ decisionRef: item.candidateRef, origin: 'PROPOSED', role, fieldRef: item.sourceFieldRef, targetRef, destinationField: item.destinationField, semanticType: item.semanticType, proposalType: item.proposalType, primitive: item.transformPrimitive, evidenceClass: item.evidenceClass, evidenceRefs: item.evidenceRefs, impactRows: item.impactRows });
    }
  }
  return claims;
}

/** The record mapping a column's claim on a destination is delivered through: the column's file and the destination's object, as assembly keys it. */
function recordMappingOf(contracts: AdaptedContracts, fieldRef: string, destinationField: string | null): string | null {
  const fileId = contracts.refs.fieldByRef.get(fieldRef)?.fileId;
  if (fileId === undefined) return null;
  if (destinationField !== null) return recordMappingIdOf(fileId, destinationField.split('.')[0] ?? '');
  return null;
}

/** The type a claim gives its field: the resolver's, the compiler's or the one a type selection chose; null when none was named, and then nothing is judged against it. */
const typeOf = (claim: Claim): string | null => claim.semanticType;

/** Whether a modifier disagrees with the type of the field it lands on. */
function disagrees(modifier: Claim, fieldType: string): boolean {
  if (modifier.proposalType === 'MAP_ENUM_VALUE') return fieldType !== 'ENUM';
  if (modifier.proposalType === 'APPLY_SUPPORTED_TRANSFORM') {
    const primitive = modifier.primitive === null ? undefined : PRIMITIVES[modifier.primitive as PrimitiveRef];
    return primitive !== undefined && !(primitive.semanticTypes as readonly string[]).includes(fieldType);
  }
  return false;
}

/**
 * Every contradiction among the decisions that stand, in a stable order: by
 * kind, then by the scope it lives in, then by its claims. Each names at
 * least two claims, deduplicated by decision ref and in the order the run
 * met them.
 */
export function detectContradictions(input: ReviewInput): readonly Contradiction[] {
  const { contracts } = input;
  const claims = claimsOf(input);
  const found: { kind: ContradictionKind; key: string; recordMappingId: string | null; claims: Claim[] }[] = [];
  const add = (kind: ContradictionKind, key: string, recordMappingId: string | null, members: readonly Claim[]): void => {
    const unique = members.filter((claim, index) => members.findIndex((other) => other.decisionRef === claim.decisionRef) === index);
    if (unique.length >= 2) found.push({ kind, key, recordMappingId, claims: unique });
  };

  // SAME_SCOPE_TARGET: two columns claim one destination of one record mapping. The same column twice in one scope is one field, not a conflict.
  const fields = claims.filter((claim) => claim.role === 'FIELD');
  const byScope = new Map<string, Claim[]>();
  for (const claim of fields) {
    const scope = outputScopeOf(recordMappingOf(contracts, claim.fieldRef, claim.destinationField), claim.destinationField ?? '');
    const list = byScope.get(scope) ?? [];
    if (!list.some((entry) => entry.fieldRef === claim.fieldRef)) list.push(claim);
    byScope.set(scope, list);
  }
  for (const [scope, members] of byScope) if (members.length >= 2) add('SAME_SCOPE_TARGET', scope, recordMappingOf(contracts, members[0]?.fieldRef ?? '', members[0]?.destinationField ?? null), members);

  // TYPE_AGAINST_TRANSFORM: on one field — one column delivered as one destination — the type and what changes the values must agree.
  const fieldOf = (claim: Claim): Claim | undefined => fields.find((entry) => entry.fieldRef === claim.fieldRef && entry.destinationField === claim.destinationField);
  const modifiers = claims.filter((claim) => claim.role === 'MODIFIER');
  for (const field of fields) {
    const on = modifiers.filter((claim) => fieldOf(claim) === field);
    const types = on.filter((claim) => claim.proposalType === 'SELECT_SEMANTIC_TYPE');
    // The claim that sets the field's type: the type selection when there is one, else the mapping.
    const decider = types[0] ?? field;
    const fieldType = typeOf(decider);
    if (fieldType === null) continue;
    const scope = `${field.fieldRef}|${field.destinationField ?? ''}`;
    for (const other of types.slice(1)) if (typeOf(other) !== fieldType) add('TYPE_AGAINST_TRANSFORM', scope, recordMappingOf(contracts, field.fieldRef, field.destinationField), [decider, other]);
    for (const modifier of on) if (disagrees(modifier, fieldType)) add('TYPE_AGAINST_TRANSFORM', scope, recordMappingOf(contracts, field.fieldRef, field.destinationField), [decider, modifier]);
    // The mapping's own primitive against a type another decision selected.
    if (decider !== field && field.primitive !== null && disagrees({ ...field, proposalType: 'APPLY_SUPPORTED_TRANSFORM' }, fieldType)) add('TYPE_AGAINST_TRANSFORM', scope, recordMappingOf(contracts, field.fieldRef, field.destinationField), [field, decider]);
  }

  // ASSOCIATION_KEY_REUSED: an association's key column that a field maps or an identity names.
  for (const association of claims.filter((claim) => claim.role === 'ASSOCIATION')) {
    for (const other of claims.filter((claim) => claim !== association && (claim.role === 'FIELD' || claim.role === 'IDENTITY') && claim.fieldRef === association.fieldRef)) {
      add('ASSOCIATION_KEY_REUSED', `${association.fieldRef}|${other.decisionRef}`, recordMappingOf(contracts, other.fieldRef, other.destinationField), [other, association].sort((a, b) => claims.indexOf(a) - claims.indexOf(b)));
    }
  }

  // REQUIRED_TARGET_PRESERVED: a column that satisfies a required target of the contract and that another decision preserves.
  const required = (targetRef: string | null): boolean => {
    if (targetRef === null || contracts.contractView.mode === 'CLEAN_ONLY') return false;
    const stated = contracts.contractView.fields.find((field) => field.targetRef === targetRef);
    return stated !== undefined && stated.required && (stated.createable || stated.updateable) && (contracts.refs.targetByRef.get(targetRef)?.destinationField ?? '') !== '';
  };
  for (const field of fields.filter((claim) => required(claim.targetRef))) {
    for (const preserve of claims.filter((claim) => claim.role === 'PRESERVE' && claim.fieldRef === field.fieldRef)) {
      add('REQUIRED_TARGET_PRESERVED', `${field.fieldRef}|${field.destinationField ?? ''}|${preserve.decisionRef}`, recordMappingOf(contracts, field.fieldRef, field.destinationField), [field, preserve].sort((a, b) => claims.indexOf(a) - claims.indexOf(b)));
    }
  }

  const order: readonly ContradictionKind[] = ['SAME_SCOPE_TARGET', 'TYPE_AGAINST_TRANSFORM', 'ASSOCIATION_KEY_REUSED', 'REQUIRED_TARGET_PRESERVED'];
  const sorted = [...found].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const seen = new Set<string>();
  return sorted.flatMap((entry): Contradiction[] => {
    const decisionRefs = entry.claims.map((claim) => claim.decisionRef);
    const candidateRef = `cand_${digestOf(['consistency-review', contracts.candidateSetHash, entry.kind, entry.key, decisionRefs]).slice(0, 16)}`;
    if (seen.has(candidateRef)) return [];
    seen.add(candidateRef);
    const fieldRefs = [...new Set(entry.claims.map((claim) => claim.fieldRef))];
    const candidate: DeterministicCandidate = {
      candidateRef,
      candidateType: REVIEW_CANDIDATE_TYPE,
      // The contested columns and nothing else: the review sees the claims, never the rest of the file.
      sourceRefs: fieldRefs,
      // What a review may name: the decisions in contention, by ref.
      allowedTargetRefs: decisionRefs,
      allowedPrimitiveRefs: [],
      evidenceRefs: [...new Set(entry.claims.flatMap((claim) => claim.evidenceRefs))].slice(0, 64),
      impactCounts: { rows: Math.max(0, ...entry.claims.map((claim) => claim.impactRows)), distinct: null },
      constraints: { destructiveAllowed: false, identityAutoMergeAllowed: false },
      derivedFrom: { candidateSetHash: contracts.candidateSetHash, candidateRef: null, rule: `CONSISTENCY_${entry.kind}` },
    };
    const views: ReviewClaimView[] = entry.claims.map((claim) => ({ candidateRef, kind: entry.kind, decisionRef: claim.decisionRef, origin: claim.origin, evidenceClass: claim.evidenceClass, fieldRef: claim.fieldRef, targetRef: claim.targetRef }));
    const question: OpenQuestion = { questionRef: `q_${digestOf(['consistency-review', candidateRef]).slice(0, 16)}`, taskType: 'CONSISTENCY_REVIEW', fieldRefs, candidateRefs: [candidateRef], reason: `CONSISTENCY_${entry.kind}`, complexity: entry.claims.length, recordMappingId: entry.recordMappingId };
    return [{ kind: entry.kind, recordMappingId: entry.recordMappingId, candidate, claims: views, question }];
  });
}

/** The closed codes a review answer that settles nothing is an agency decision under (D3-CAP-11). */
export const REVIEW_AGENCY_CODES = Object.freeze({
  /** An abstention, or a preserve that names no decision: both claims would stand, which the configuration cannot hold. */
  BOTH_CLAIMS_STAND: 'CONSISTENCY_BOTH_CLAIMS_STAND',
  /** A preserve of a claim that is not strictly weaker than every other by computed evidence class. */
  NOT_OF_WEAKER_CLAIM: 'CONSISTENCY_PRESERVE_NOT_OF_WEAKER_CLAIM',
  /** A preserve of a deterministic decision: the resolver decided it on facts, and a review never drops it. */
  DETERMINISTIC_KEPT: 'CONSISTENCY_DETERMINISTIC_DECISION_KEPT',
  /** The review asked the agency itself. */
  REFERRED: 'CONSISTENCY_REFERRED_TO_AGENCY',
});

/** What the compiler makes of one review answer: the preserve it accepts, the agency with a closed code, or a reference to repair. */
export type ReviewVerdict = { readonly kind: 'PRESERVE'; readonly claim: ReviewClaimView } | { readonly kind: 'AGENCY'; readonly code: string } | { readonly kind: 'INVALID'; readonly code: string };

/**
 * The evidence-ranked preserve (D3-CAP-11): an UNMAPPED_PRESERVE naming one
 * claim of its candidate is accepted only when that claim is the model's and
 * strictly weaker, by the evidence class the compiler computed, than every
 * other claim; a deterministic decision is never dropped, whether the
 * candidate names it or not; a ref that is neither a claim of the candidate
 * nor a decision of the run is a reference to repair. Everything else —
 * an abstention, a preserve of the stronger or an equal claim, the agency
 * asked — grants nothing and is the agency's decision.
 */
export function reviewVerdict(item: { readonly proposalType: string; readonly targetRef: string | null; readonly requiresAgencyDecision: boolean }, claims: readonly ReviewClaimView[], decisions: readonly Pick<ResolvedDecision, 'decisionRef'>[]): ReviewVerdict {
  if (item.proposalType !== 'UNMAPPED_PRESERVE') return { kind: 'AGENCY', code: item.proposalType === 'ABSTAIN' ? REVIEW_AGENCY_CODES.BOTH_CLAIMS_STAND : REVIEW_AGENCY_CODES.REFERRED };
  if (item.requiresAgencyDecision) return { kind: 'AGENCY', code: REVIEW_AGENCY_CODES.REFERRED };
  if (item.targetRef === null) return { kind: 'AGENCY', code: REVIEW_AGENCY_CODES.BOTH_CLAIMS_STAND };
  const named = claims.find((claim) => claim.decisionRef === item.targetRef);
  if (named?.origin === 'DETERMINISTIC' || (named === undefined && decisions.some((decision) => decision.decisionRef === item.targetRef))) return { kind: 'AGENCY', code: REVIEW_AGENCY_CODES.DETERMINISTIC_KEPT };
  if (named === undefined) return { kind: 'INVALID', code: 'REVIEW_DECISION_NOT_IN_CANDIDATE' };
  if (!strictlyWeakest(named, claims)) return { kind: 'AGENCY', code: REVIEW_AGENCY_CODES.NOT_OF_WEAKER_CLAIM };
  return { kind: 'PRESERVE', claim: named };
}
