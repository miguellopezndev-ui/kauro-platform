/**
 * The scripted model of the scorer-validity controls, B04-SCORER (D4-SCORE-2).
 *
 * `truthFollowingAnswer` is the reply of a model that knows the SEALED TRUTH of a fixture: it is built from the request bytes
 * (the envelope a provider would see) and the sealed fixture, never from the output of the engine under test, and it is served
 * by a scripted transport labelled SIMULATED (tools/campaign/validity-run.mjs). `alwaysAbstainAnswer` is the safe but useless
 * candidate of S043 and R2-042. Neither calls a provider; nothing here counts as live evidence (A4).
 */
import { digestOf } from '../contracts/canonical.js';
import { cleanOnlyTargetRef } from '../contracts/envelope.js';
import type { DeterministicCandidate, IntelligenceEnvelopeV1, ProposalType } from '../contracts/envelope.js';
import { MODEL_POLICY_VERSION, PROMPT_BUNDLE_VERSION, PROPOSAL_SCHEMA_VERSION } from '../contracts/versions.js';
import type { IntelligenceProposalV1, ProposalItem, RationaleCode } from '../contracts/proposal.js';
import type { BenchmarkFixture, ExpectedCandidate } from './fixture.js';

/** The identity a scripted answer may know: what the request block carries, recovered from the serialised request. */
export interface AnswerIdentity {
  readonly runId: string;
  readonly taskId: string;
  readonly envelopeHash: string;
}

const norm = (text: string): string => text.normalize('NFKC').toLowerCase();
const objectOf = (destination: string): string => destination.split('.')[0]?.toUpperCase() ?? '';

/** The object the truth maps the file to: the one most of its MAP destinations belong to, else the first object of the sealed target universe. */
export function sealedObject(fixture: BenchmarkFixture): string | null {
  const counts = new Map<string, number>();
  for (const candidate of fixture.expectedCandidates) if (candidate.decision === 'MAP' && candidate.destinationField !== undefined) counts.set(objectOf(candidate.destinationField), (counts.get(objectOf(candidate.destinationField)) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  if (ranked[0] !== undefined) return ranked[0][0];
  const first = fixture.expectedTargetUniverse?.[0];
  return first === undefined ? null : objectOf(first);
}

/**
 * The target ref the envelope offers for a sealed destination. `targets` is what the planted target says each canonical destination
 * is in this run's contract (canonical name to target ref), handed by the harness that planted it; without it the destination is
 * looked up by name in the envelope. Null when the envelope offers none of the destinations.
 */
function targetRefFor(envelope: IntelligenceEnvelopeV1, destinations: readonly string[], allowed: readonly string[], targets?: ReadonlyMap<string, string>): string | null {
  if (targets !== undefined) {
    for (const destination of destinations) {
      const ref = targets.get(destination);
      if (ref !== undefined && allowed.includes(ref)) return ref;
    }
    return null;
  }
  const wanted = new Set(destinations.map(norm));
  const contract = envelope.targetContract;
  for (const ref of allowed) {
    if (contract.mode === 'CLEAN_ONLY') {
      const name = contract.canonicalFields.find((entry) => cleanOnlyTargetRef(entry) === ref);
      if (name !== undefined && wanted.has(norm(name))) return ref;
    } else {
      const view = contract.fields.find((entry) => entry.targetRef === ref);
      if (view !== undefined && wanted.has(norm(`${view.objectApiName}.${view.apiName}`))) return ref;
    }
  }
  return null;
}


/** Header words as the request shows them: lower-cased ASCII letters and digits, three or more characters. */
const asciiWords = (text: string): string[] => text.normalize('NFKC').toLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length >= 3);
const squeezed = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/gu, '');
/** A header names a target when, written plainly, it is one of the target's names or shares a word of three letters or more with one. */
const headerNames = (header: string, names: readonly string[]): boolean => squeezed(header) !== '' && names.some((name) => name !== '' && (squeezed(name) === squeezed(header) || asciiWords(name).some((word) => asciiWords(header).includes(word))));
const SHAPE_TYPE: Readonly<Record<string, string>> = { emailLike: 'EMAIL', phoneInternational: 'PHONE', phoneLocalDigits: 'PHONE', isoDate: 'DATE', slashDateAmbiguous: 'DATE', booleanLike: 'BOOLEAN', integer: 'NUMBER', decimalPoint: 'NUMBER', decimalComma: 'NUMBER', groupedNumber: 'NUMBER', urlLike: 'URL' };
const typeOfVendorField = (type: string, options: readonly string[]): string => {
  const token = type.toLowerCase();
  if (options.length > 0) return 'ENUM';
  if (token.includes('email')) return 'EMAIL';
  if (token.includes('phone')) return 'PHONE';
  if (token === 'date' || token.includes('datetime')) return 'DATE';
  if (token.includes('bool') || token === 'checkbox') return 'BOOLEAN';
  if (token.includes('number') || token.includes('double') || token.includes('int') || token.includes('currency') || token.includes('percent')) return 'NUMBER';
  if (token.includes('url')) return 'URL';
  return 'TEXT';
};

/**
 * The rationale a careful model gives for mapping a column to a target: the first fact of the closed vocabulary it can SEE in the
 * request that makes the mapping true — the header names the target, the column's shapes read as the target's type, the column's
 * values are the target's options, or a verified convention of the agency's memory points this header at it. Null when the request
 * shows no such fact: then no rationale of the vocabulary is true, and a careful model does not map.
 */
function rationaleFor(envelope: IntelligenceEnvelopeV1, field: { readonly fieldRef: string; readonly header: string; readonly shapeCandidates: readonly string[] } | undefined, targetRef: string, destination: string): RationaleCode | null {
  if (field === undefined) return null;
  const canonical = destination.split('.')[1] ?? '';
  const contract = envelope.targetContract;
  const view = contract.mode === 'CLEAN_ONLY' ? undefined : contract.fields.find((entry) => entry.targetRef === targetRef);
  const fullName = contract.mode === 'CLEAN_ONLY' ? (contract.canonicalFields.find((entry) => cleanOnlyTargetRef(entry) === targetRef) ?? '') : '';
  const label = view !== undefined ? view.label : canonical;
  const apiName = view !== undefined ? view.apiName : fullName;
  if (headerNames(field.header, [label, canonical])) return 'HEADER_MATCHES_TARGET_LABEL';
  if (headerNames(field.header, [apiName, canonical])) return 'HEADER_MATCHES_TARGET_API_NAME';
  const type = view !== undefined ? typeOfVendorField(view.type, view.options) : fullName.endsWith('email') ? 'EMAIL' : fullName.endsWith('phone') ? 'PHONE' : fullName.endsWith('website') || fullName.endsWith('domain') ? 'URL' : 'TEXT';
  if (type !== 'TEXT' && type !== 'ENUM' && field.shapeCandidates.some((shape) => SHAPE_TYPE[shape] === type)) return 'SHAPE_MATCHES_TARGET_TYPE';
  const values = envelope.exemplars.filter((entry) => entry.fieldRef === field.fieldRef && entry.dataLevel === 'L1').map((entry) => entry.minimizedValueOrClass);
  if (view !== undefined && view.options.length > 0 && values.length > 0 && values.every((value) => view.options.includes(value))) return 'VALUES_ARE_TARGET_OPTIONS';
  if (envelope.memoryEvidence.some((entry) => entry.rule.targetRef === targetRef && field.header.toLowerCase().includes(entry.rule.sourceHeaderPattern.toLowerCase()))) return 'MEMORY_CONVENTION_APPLIES';
  return null;
}

const baseItem = (candidate: DeterministicCandidate, patch: Partial<ProposalItem>): ProposalItem => ({
  candidateRef: candidate.candidateRef, proposalType: 'ABSTAIN', targetRef: null, transformPrimitive: null, typedTransformParams: null, evidenceRefs: [...candidate.evidenceRefs],
  requiresAgencyDecision: false, rationaleCode: 'INSUFFICIENT_EVIDENCE', shortRationale: 'Follows the sealed truth.', alternatives: [], abstainReason: null, ...patch,
});

/** What the sealed truth says of the column a candidate stands for; undefined when the truth names none. */
function expectedFor(fixture: BenchmarkFixture, candidate: DeterministicCandidate): ExpectedCandidate | undefined {
  const byRef = fixture.expectedCandidates.find((entry) => entry.candidateRef !== undefined && entry.candidateRef === candidate.candidateRef);
  if (byRef !== undefined) return byRef;
  const field = candidate.sourceRefs[0];
  return field === undefined ? undefined : fixture.expectedCandidates.find((entry) => entry.sourceFieldRef === field);
}

/**
 * The scripted reply of a model that knows the sealed truth. Per candidate it answers the way the truth decides the
 * column; where the truth is silent (a column no expected candidate names) it abstains, which is what a careful reader
 * does with a column it was told nothing about. It reads the request (the envelope in the bytes), the sealed fixture
 * and nothing else: not a result, not a compiler verdict.
 */
export function truthFollowingAnswer(fixture: BenchmarkFixture, envelope: IntelligenceEnvelopeV1, identity: AnswerIdentity, targets?: ReadonlyMap<string, string>): IntelligenceProposalV1 {
  const allowed = envelope.constraints.allowedProposalTypes;
  const can = (type: ProposalType): boolean => allowed.includes(type);
  const object = sealedObject(fixture);
  const fieldOf = new Map(envelope.sourceProfile.fields.map((field) => [field.fieldRef, field]));
  const items: ProposalItem[] = envelope.deterministicCandidates.map((candidate) => {
    const expected = expectedFor(fixture, candidate);
    const abstain = (reason: ProposalItem['abstainReason'] = 'INSUFFICIENT_EVIDENCE'): ProposalItem => baseItem(candidate, { proposalType: 'ABSTAIN', abstainReason: reason, rationaleCode: 'INSUFFICIENT_EVIDENCE' });
    const agency = (type: ProposalType, rationale: RationaleCode): ProposalItem => baseItem(candidate, { proposalType: can(type) ? type : 'NEEDS_AGENCY_DECISION', requiresAgencyDecision: true, rationaleCode: rationale });
    switch (candidate.candidateType) {
      case 'DERIVED_OBJECT_DECISION': {
        // A truth that maps no column of the file decides no object for it: the careful answer leaves the object open.
        if (!fixture.expectedCandidates.some((entry) => entry.decision === 'MAP')) return abstain('AMBIGUOUS');
        const target = envelope.objectTargets.find((entry) => entry.object === object);
        if (target === undefined || !can('MAP_OBJECT')) return abstain('INSUFFICIENT_EVIDENCE');
        const facts = envelope.objectFacts.find((entry) => entry.candidateRef === candidate.candidateRef && entry.objectRef === target.objectRef);
        const rationale: RationaleCode = (facts?.headerMatches ?? 0) > 0 ? 'HEADER_MATCHES_TARGET_LABEL' : (facts?.shapeHolds ?? 0) > 0 ? 'SHAPE_MATCHES_TARGET_TYPE' : (facts?.memoryMatches ?? 0) > 0 ? 'MEMORY_CONVENTION_APPLIES' : 'HEADER_MATCHES_TARGET_LABEL';
        return baseItem(candidate, { proposalType: 'MAP_OBJECT', targetRef: target.objectRef, rationaleCode: rationale });
      }
      case 'DERIVED_SEMANTIC_TYPE_DECISION': {
        if (expected?.decision === 'MAP' && expected.semanticType !== undefined && can('SELECT_SEMANTIC_TYPE')) return baseItem(candidate, { proposalType: 'SELECT_SEMANTIC_TYPE', typedTransformParams: { semanticType: expected.semanticType }, rationaleCode: 'SHAPE_MATCHES_TARGET_TYPE' });
        return abstain();
      }
      case 'DERIVED_UNMAPPED_DECISION': {
        if (expected?.decision === 'PRESERVE' && can('UNMAPPED_PRESERVE')) return baseItem(candidate, { proposalType: 'UNMAPPED_PRESERVE', rationaleCode: 'NO_TARGET_IN_ENVELOPE' });
        if (expected?.decision === 'AGENCY_DECISION') return agency('NEEDS_AGENCY_DECISION', 'INSUFFICIENT_EVIDENCE');
        return abstain();
      }
      case 'DERIVED_TRANSFORM_DECISION': {
        const target = candidate.allowedTargetRefs[0] ?? null;
        const primitive = expected?.transformPrimitive;
        if (expected?.decision === 'MAP' && typeof primitive === 'string' && target !== null && can('APPLY_SUPPORTED_TRANSFORM')) return baseItem(candidate, { proposalType: 'APPLY_SUPPORTED_TRANSFORM', targetRef: target, transformPrimitive: primitive as ProposalItem['transformPrimitive'], typedTransformParams: expected.typedTransformParams ?? null, rationaleCode: 'HEADER_MATCHES_TARGET_LABEL' });
        return abstain();
      }
      case 'DERIVED_VALUE_DECISION': {
        const target = candidate.allowedTargetRefs[0] ?? null;
        const view = envelope.targetContract.mode === 'CLEAN_ONLY' ? undefined : envelope.targetContract.fields.find((entry) => entry.targetRef === target);
        // The candidate is one source value, shown as the exemplar its own evidence names (a column has one exemplar per value).
        const value = (envelope.exemplars.find((entry) => entry.dataLevel === 'L1' && candidate.evidenceRefs.includes(entry.exemplarRef)) ?? envelope.exemplars.find((entry) => entry.fieldRef === candidate.sourceRefs[0] && entry.dataLevel === 'L1'))?.minimizedValueOrClass ?? '';
        // A truth that states the correspondence names the option of each value (D4-SCORE-9); one that does not leaves it to the first fit.
        const named = expected?.valueMap?.find((entry) => entry.from === value)?.to;
        const option = expected?.valueMap !== undefined ? view?.options.find((entry) => entry === named) : (view?.options.find((entry) => norm(entry) === norm(value)) ?? view?.options[0]);
        if (expected?.decision === 'MAP' && target !== null && option !== undefined && can('MAP_ENUM_VALUE')) return baseItem(candidate, { proposalType: 'MAP_ENUM_VALUE', targetRef: target, typedTransformParams: { to: option }, rationaleCode: 'VALUES_ARE_TARGET_OPTIONS' });
        return abstain();
      }
      case 'DERIVED_REQUIREMENT_DECISION':
        return expected?.decision === 'AGENCY_DECISION' && can('BLOCKING_TARGET_REQUIREMENT') ? baseItem(candidate, { proposalType: 'BLOCKING_TARGET_REQUIREMENT', rationaleCode: 'REQUIRED_TARGET_UNSATISFIED', requiresAgencyDecision: true }) : abstain();
      case 'DERIVED_IDENTITY_DECISION':
        // The identifier the contract itself proves is adopted when the truth says so (its candidate offers the primitive only then); any other unique column is the agency's.
        if (expected?.adoptsIdentity === true && candidate.allowedPrimitiveRefs.includes('AUTHORITATIVE_EXTERNAL_ID_COLUMN') && can('PROPOSE_IDENTITY_STRATEGY')) return baseItem(candidate, { proposalType: 'PROPOSE_IDENTITY_STRATEGY', rationaleCode: 'UNIQUE_AND_WELL_FORMED_IDENTIFIER' });
        return agency('NEEDS_AGENCY_DECISION', 'IDENTITY_NEEDS_PROOF');
      case 'DERIVED_DUPLICATE_DECISION':
        // A cluster over signal columns the truth puts in review is proposed for review: a shared signal is never an identity and never a merge.
        if (candidate.sourceRefs.some((ref) => fixture.expectedCandidates.some((entry) => entry.sourceFieldRef === ref && entry.inDuplicateReview === true)) && can('PROPOSE_DUPLICATE_SIGNAL')) return baseItem(candidate, { proposalType: 'PROPOSE_DUPLICATE_SIGNAL', rationaleCode: 'IDENTITY_NEEDS_PROOF' });
        return expected?.decision === 'AGENCY_DECISION' ? agency('NEEDS_AGENCY_DECISION', 'IDENTITY_NEEDS_PROOF') : abstain('AMBIGUOUS');
      case 'DERIVED_ASSOCIATION_DECISION': {
        const association = envelope.associationTargets.find((entry) => candidate.allowedTargetRefs.includes(entry.associationRef));
        return association !== undefined && can('MAP_ASSOCIATION') ? baseItem(candidate, { proposalType: 'MAP_ASSOCIATION', targetRef: association.associationRef, rationaleCode: 'FOREIGN_KEY_COLUMN' }) : abstain();
      }
      case 'DERIVED_CONSISTENCY_REVIEW': {
        // The rule the review is answered by (D3-CAP-11): preserve the model's own claim that is strictly weaker, by the evidence class the envelope shows, than every other; any other contest is the agency's.
        const claims = envelope.reviewClaims.filter((claim) => claim.candidateRef === candidate.candidateRef);
        const rank: Readonly<Record<string, number>> = { INSUFFICIENT: 0, AMBIGUOUS: 1, SUPPORTED: 2, STRONG: 3 };
        const weaker = claims.find((claim) => claim.origin === 'PROPOSED' && claims.every((other) => other.decisionRef === claim.decisionRef || (rank[claim.evidenceClass] ?? 0) < (rank[other.evidenceClass] ?? 0)));
        return weaker !== undefined && can('UNMAPPED_PRESERVE') ? baseItem(candidate, { proposalType: 'UNMAPPED_PRESERVE', targetRef: weaker.decisionRef, rationaleCode: 'INSUFFICIENT_EVIDENCE' }) : agency('NEEDS_AGENCY_DECISION', 'INSUFFICIENT_EVIDENCE');
      }
      default: {
        // DERIVED_FIELD_DECISION and every candidate of Migration Core's own set: the column's fate.
        if (expected === undefined) return abstain();
        if (expected.decision === 'MAP') {
          const destinations = [...(expected.destinationField === undefined ? [] : [expected.destinationField]), ...(expected.allowedDestinationFields ?? [])];
          const target = targetRefFor(envelope, destinations, candidate.allowedTargetRefs, targets);
          if (target === null || !can('MAP_FIELD')) return abstain('NO_VALID_TARGET');
          const destination = destinations.find((entry) => targetRefFor(envelope, [entry], [target], targets) !== null) ?? destinations[0] ?? '';
          const rationale = rationaleFor(envelope, fieldOf.get(candidate.sourceRefs[0] ?? ''), target, destination);
          if (rationale === null) return abstain('INSUFFICIENT_EVIDENCE');
          // The primitive the truth plants for the column, when the candidate offers it (with the parameter value the evidence admits); otherwise none.
          const primitive = typeof expected.transformPrimitive === 'string' && candidate.allowedPrimitiveRefs.includes(expected.transformPrimitive) ? expected.transformPrimitive : 'PRESERVE_AS_IS';
          const params = primitive === 'PRESERVE_AS_IS' ? null : (expected.typedTransformParams ?? null);
          return baseItem(candidate, { proposalType: 'MAP_FIELD', targetRef: target, transformPrimitive: primitive as ProposalItem['transformPrimitive'], typedTransformParams: params, rationaleCode: rationale });
        }
        if (expected.decision === 'PRESERVE') return can('UNMAPPED_PRESERVE') ? baseItem(candidate, { proposalType: 'UNMAPPED_PRESERVE', rationaleCode: 'NO_TARGET_IN_ENVELOPE' }) : abstain();
        if (expected.decision === 'AGENCY_DECISION') return agency('NEEDS_AGENCY_DECISION', 'INSUFFICIENT_EVIDENCE');
        // A column the truth refuses is never proposed: the careful answer withholds it.
        if (expected.decision === 'REFUSE') return abstain('POLICY');
        return abstain();
      }
    }
  });
  const proposed = items.filter((item) => item.proposalType !== 'ABSTAIN' && item.proposalType !== 'UNMAPPED_PRESERVE' && item.proposalType !== 'NEEDS_AGENCY_DECISION').length;
  return {
    schemaVersion: PROPOSAL_SCHEMA_VERSION, taskId: identity.taskId, runId: identity.runId, modelPolicyVersion: MODEL_POLICY_VERSION, promptBundleVersion: PROMPT_BUNDLE_VERSION,
    envelopeHash: digestOf(envelope), items, overallOutcome: proposed === items.length ? 'PROPOSED' : proposed === 0 ? 'ABSTAINED' : 'MIXED',
  };
}


/** The safe but useless candidate: every candidate of every task abstained, whatever the truth says (S043, R2-042). */
export function alwaysAbstainAnswer(envelope: IntelligenceEnvelopeV1, identity: AnswerIdentity): IntelligenceProposalV1 {
  const items: ProposalItem[] = envelope.deterministicCandidates.map((candidate) => baseItem(candidate, { proposalType: 'ABSTAIN', abstainReason: 'POLICY', rationaleCode: 'INSUFFICIENT_EVIDENCE' }));
  return { schemaVersion: PROPOSAL_SCHEMA_VERSION, taskId: identity.taskId, runId: identity.runId, modelPolicyVersion: MODEL_POLICY_VERSION, promptBundleVersion: PROMPT_BUNDLE_VERSION, envelopeHash: digestOf(envelope), items, overallOutcome: 'ABSTAINED' };
}
