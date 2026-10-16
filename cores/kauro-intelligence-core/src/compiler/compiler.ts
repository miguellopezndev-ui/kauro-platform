/**
 * Parser and Proposal Compiler, canon §30–§35.
 *
 * The parser proves shape: closed schema, exact enums, bounded sizes, no
 * normalisation of an authoritative id to make an invalid output fit. The
 * compiler proves truth, in the mandatory order — schema → task/run/envelope
 * identity and refs → TargetContract → primitives and parameters →
 * support envelope → authority → cross-item consistency — and hands what
 * survives to the host's full-dataset validation port. The evidence class is
 * derived from the evidence refs, never read from the model. Every refusal
 * is one of the explicit outcomes; there is no best-effort plan.
 */
import type { AdaptedContracts } from '../adapter/contract-adapter.js';
import { digestOf } from '../contracts/canonical.js';
import { ASSOCIATION_CANDIDATE_TYPE, DUPLICATE_CANDIDATE_TYPE, IDENTITY_CANDIDATE_TYPE, REQUIREMENT_CANDIDATE_TYPE, REVIEW_CANDIDATE_TYPE, VALUE_CANDIDATE_TYPE } from '../contracts/envelope.js';
import type { DeterministicCandidate, IntelligenceEnvelopeV1, ProposalType, SourceFieldFact } from '../contracts/envelope.js';
import type { TaskOutcome } from '../contracts/errors.js';
import { outputScopeOf } from '../contracts/output-scope.js';
import { PRIMITIVES, PRIMITIVE_PARAM_DOMAINS, PROPOSAL_SCHEMA, proposalShapeProblems } from '../contracts/proposal.js';
import type { EvidenceClass, IntelligenceProposalV1, ProposalItem, RationaleCode } from '../contracts/proposal.js';
import { closedProblemCode, parseJsonBounded } from '../contracts/schema.js';
import type { SchemaProblem } from '../contracts/schema.js';
import { MODEL_POLICY_VERSION, PROMPT_BUNDLE_VERSION } from '../contracts/versions.js';
import { DERIVED_CANDIDATE_TYPES, TYPE_OF_SHAPE, objectDecides, objectFactsOf, plausibleTargetsOf, supportedObjects, targetSemanticOf } from '../resolver/deterministic-resolver.js';
import type { ObjectFact, ResolvedDecision } from '../resolver/deterministic-resolver.js';
import { NO_LOCALE, PARAMETERISED_PRIMITIVES, evidencedValues } from './parameter-evidence.js';
import type { DeclaredLocale } from './parameter-evidence.js';
import { OBJECT_OF_TOKEN, associationOptionOf, objectsNamedBy } from '../resolver/identity-families.js';
import type { AssociationOption } from '../resolver/identity-families.js';
import { reviewVerdict } from './consistency.js';

// ------------------------------------------------------------------- parser

/**
 * The parse: `problems` for a developer reading a local failure (their
 * messages may quote the answer), `codes` for the record — each problem's
 * closed code and closed pointer, nothing the model wrote (D3-PRIV-1).
 */
export type ParseResult = { readonly ok: true; readonly proposal: IntelligenceProposalV1 } | { readonly ok: false; readonly outcome: 'INVALID_SCHEMA'; readonly problems: readonly SchemaProblem[]; readonly codes: readonly string[] };

/**
 * A model's answer, read by the strict reader first — a repeated member name
 * anywhere is DUPLICATE_KEY before any member is read, so last-member-wins
 * grants nothing (D3-PARSE-1, R2-038) — then by the closed schema.
 */
export function parseProposal(content: string): ParseResult {
  const parsed = parseJsonBounded(content);
  const refused = (problems: readonly SchemaProblem[]): ParseResult => ({ ok: false, outcome: 'INVALID_SCHEMA', problems, codes: [...new Set(problems.map((problem) => closedProblemCode(problem, PROPOSAL_SCHEMA)))] });
  if (parsed.problems.length > 0) return refused(parsed.problems);
  const problems = proposalShapeProblems(parsed.value);
  if (problems.length > 0) return refused(problems);
  return { ok: true, proposal: parsed.value as IntelligenceProposalV1 };
}

/** The parameter names this build's catalogue knows, as the compiler spells them in a code: a code built from one of them is closed; one built from a name the model invented is not. */
const KNOWN_PARAM_CODES: ReadonlySet<string> = new Set([...Object.keys(PRIMITIVE_PARAM_DOMAINS), 'semanticType'].map((name) => name.toUpperCase()));

/**
 * A compiler code as it is recorded: the compiler names an unknown parameter
 * by the name the proposal gave it, so the repair round can point at it (the
 * envelope builder masks it there); the record keeps the closed part only —
 * UNKNOWN_PARAM, or PARAM_OUT_OF_DOMAIN — unless the name is one the
 * catalogue knows (D3-PRIV-1, S036).
 */
export function recordedCompilerCode(code: string): string {
  for (const prefix of ['UNKNOWN_PARAM', 'PARAM_OUT_OF_DOMAIN']) {
    if (!code.startsWith(`${prefix}_`)) continue;
    return KNOWN_PARAM_CODES.has(code.slice(prefix.length + 1)) ? code : prefix;
  }
  return code;
}

// ----------------------------------------------------------------- compiler

export interface CompiledItem {
  readonly candidateRef: string;
  readonly proposalType: ProposalType;
  readonly outcome: TaskOutcome;
  readonly codes: readonly string[];
  readonly targetRef: string | null;
  readonly destinationField: string | null;
  readonly sourceFieldRef: string | null;
  readonly semanticType: string | null;
  readonly transformPrimitive: string | null;
  readonly typedTransformParams: Readonly<Record<string, string>> | null;
  readonly evidenceClass: EvidenceClass;
  /** The evidence refs the proposal cited and the envelope knows; an oracle checks them, not a class alone. */
  readonly evidenceRefs: readonly string[];
  readonly requiresAgencyDecision: boolean;
  readonly rationaleCode: string;
  readonly impactRows: number;
  /** The canonical object an accepted MAP_OBJECT decides for its file (D3-CAP-01); null for any other item. */
  readonly object: string | null;
}

export interface CompiledTask {
  readonly taskId: string;
  readonly envelopeHash: string;
  readonly proposalDigest: string;
  readonly outcome: TaskOutcome;
  readonly codes: readonly string[];
  readonly items: readonly CompiledItem[];
  /** Codes the model may repair once: schema and reference problems, not authority problems. */
  readonly repairable: boolean;
}

export interface CompileInput {
  readonly envelope: IntelligenceEnvelopeV1;
  readonly envelopeHash: string;
  readonly proposal: IntelligenceProposalV1;
  readonly runId: string;
  readonly contracts: AdaptedContracts;
  readonly decisions: readonly ResolvedDecision[];
  /** The project's declared locale as the run read it: the only evidence for a date format or a phone region (D3-CAP-04). None when absent. */
  readonly locale?: DeclaredLocale;
  /** The output scopes earlier tasks of the run claimed with an accepted mapping: a requirement they satisfy is not unsatisfied (D3-CAP-10). */
  readonly priorClaims?: ReadonlySet<string>;
}

/** Proposal types that change a field another decision mapped — a transformation's parameters, a value map — rather than claim a destination (D3-CAP-04, D3-CAP-05). */
const FIELD_MODIFIERS: ReadonlySet<ProposalType> = new Set<ProposalType>(['APPLY_SUPPORTED_TRANSFORM', 'MAP_ENUM_VALUE']);

/** The L1 value a value candidate stands for: the exemplar of its column its evidence names, or null when the envelope never carried one (D3-CAP-05). */
function valueOfCandidate(candidate: DeterministicCandidate | undefined, envelope: IntelligenceEnvelopeV1): string | null {
  if (candidate === undefined || candidate.candidateType !== VALUE_CANDIDATE_TYPE) return null;
  return envelope.exemplars.find((exemplar) => exemplar.dataLevel === 'L1' && exemplar.fieldRef === candidate.sourceRefs[0] && candidate.evidenceRefs.includes(exemplar.exemplarRef))?.minimizedValueOrClass ?? null;
}

const SEMANTIC_OF_TARGET_TYPE = (type: string, options: readonly string[]): string => {
  const token = type.toLowerCase();
  if (options.length > 0) return 'ENUM';
  if (token.includes('email')) return 'EMAIL';
  if (token.includes('phone')) return 'PHONE';
  if (token === 'date') return 'DATE';
  if (token.includes('datetime') || token === 'timestamp') return 'DATETIME';
  if (token.includes('bool') || token === 'checkbox') return 'BOOLEAN';
  if (token.includes('number') || token.includes('double') || token.includes('int') || token.includes('currency') || token.includes('percent')) return 'NUMBER';
  if (token.includes('url')) return 'URL';
  return 'TEXT';
};

const SHAPE_SEMANTIC: Readonly<Record<string, string>> = { emailLike: 'EMAIL', phoneInternational: 'PHONE', phoneLocalDigits: 'PHONE', isoDate: 'DATE', slashDateAmbiguous: 'DATE', booleanLike: 'BOOLEAN', integer: 'NUMBER', decimalPoint: 'NUMBER', decimalComma: 'NUMBER', groupedNumber: 'NUMBER', urlLike: 'URL' };

const normaliseText = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/gu, '');
const tokensOf = (text: string): string[] => text.normalize('NFKC').toLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length >= 3);
/** A header names a target when it equals one of the target's names or shares a token of three or more characters with one. */
const namesMatch = (header: string, names: readonly (string | undefined)[]): boolean => {
  if (header === '') return false;
  const headerTokens = tokensOf(header);
  // A CLEAN_ONLY ref carries no vendor label or api name; only real strings take part in the match.
  return names.some((name) => typeof name === 'string' && name !== '' && (normaliseText(name) === normaliseText(header) || tokensOf(name).some((token) => headerTokens.includes(token))));
};

/**
 * The proposal types each derived candidate of the identity families admits
 * (D3-CAP-06..08): an identity candidate is adopted, put to the agency or
 * left; a duplicate candidate is proposed for review, put to the agency or
 * left — never an identity; an association candidate is mapped to one of its
 * associations, put to the agency or left. Any other answer to one of them is
 * FORBIDDEN, whatever the task's permissions let through.
 */
const ANSWERS_OF_CANDIDATE: Readonly<Record<string, readonly ProposalType[]>> = Object.freeze({
  [IDENTITY_CANDIDATE_TYPE]: ['PROPOSE_IDENTITY_STRATEGY', 'NEEDS_AGENCY_DECISION', 'ABSTAIN'],
  [DUPLICATE_CANDIDATE_TYPE]: ['PROPOSE_DUPLICATE_SIGNAL', 'NEEDS_AGENCY_DECISION', 'ABSTAIN'],
  [ASSOCIATION_CANDIDATE_TYPE]: ['MAP_ASSOCIATION', 'NEEDS_AGENCY_DECISION', 'ABSTAIN'],
});

/**
 * What each rationale code is: a claim that supports authority — a fact
 * that, holding, lets a proposal stand as PROPOSED — or a claim that defers
 * it — a limit the model reports, which holding or not never makes a
 * mapping true. Every code of the closed vocabulary is here; a code that is
 * missing does not compile.
 */
const RATIONALE_KIND: Readonly<Record<RationaleCode, 'SUPPORTS' | 'DEFERS'>> = Object.freeze({
  HEADER_MATCHES_TARGET_LABEL: 'SUPPORTS',
  HEADER_MATCHES_TARGET_API_NAME: 'SUPPORTS',
  SHAPE_MATCHES_TARGET_TYPE: 'SUPPORTS',
  MEMORY_CONVENTION_APPLIES: 'SUPPORTS',
  VALUES_ARE_TARGET_OPTIONS: 'SUPPORTS',
  UNIQUE_AND_WELL_FORMED_IDENTIFIER: 'SUPPORTS',
  FOREIGN_KEY_COLUMN: 'DEFERS',
  NO_TARGET_IN_ENVELOPE: 'DEFERS',
  AMBIGUOUS_BETWEEN_TARGETS: 'DEFERS',
  VALUE_NOT_IN_TARGET_OPTIONS: 'DEFERS',
  REQUIRED_TARGET_UNSATISFIED: 'DEFERS',
  DESTRUCTIVE_NEEDS_AGENCY: 'DEFERS',
  IDENTITY_NEEDS_PROOF: 'DEFERS',
  INSUFFICIENT_EVIDENCE: 'DEFERS',
  OUT_OF_SUPPORT_ENVELOPE: 'DEFERS',
});

/**
 * What a claim is for one item: the kind the vocabulary gives it, except for
 * the two claims that are the very ground of an identity-family answer while
 * they only defer a mapping — a foreign key supports an association, the key
 * naming the target's object being exactly what makes one (D3-CAP-08); and an
 * identity that needs proof supports a review group, records sharing a
 * signal Migration Core reported and nothing proving them one being exactly
 * what the agency reviews, and what nothing merges (D3-CAP-07).
 */
function kindOf(item: ProposalItem): 'SUPPORTS' | 'DEFERS' {
  if (item.proposalType === 'MAP_ASSOCIATION' && item.rationaleCode === 'FOREIGN_KEY_COLUMN') return 'SUPPORTS';
  if (item.proposalType === 'PROPOSE_DUPLICATE_SIGNAL' && item.rationaleCode === 'IDENTITY_NEEDS_PROOF') return 'SUPPORTS';
  return RATIONALE_KIND[item.rationaleCode];
}

/**
 * The facts the envelope, the contracts and the deterministic decisions hold
 * about one item's source field and chosen target, canon §28, §30–§31. A
 * rationale code is a claim the model makes; each of these is what would
 * make one of the fifteen claims true, computed here from the profile, the
 * target, the exemplars and the resolver's decisions — never read back from
 * the proposal.
 */
interface ItemFacts {
  /** The source header and the target's label (or the canonical name it is delivered as) share a normalised token, or are one name. */
  readonly headerMatchesLabel: boolean;
  /** The source header and the target's api name (or the canonical name it is delivered as) share a normalised token, or are one name. */
  readonly headerMatchesApiName: boolean;
  /** Either of the two name facts. */
  readonly headerMatchesTarget: boolean;
  /** One of the field's shape candidates maps to the target's semantic type. */
  readonly shapeMatchesTarget: boolean;
  /** The field has classified values in the envelope and every one is a target option. */
  readonly valuesAreTargetOptions: boolean;
  /** The field has classified values in the envelope and at least one is outside the options of the target named, or of an allowed target when none is named. */
  readonly valuesOutsideTargetOptions: boolean;
  /** The profile says unique among non-empty and populated on every row. */
  readonly uniqueAndPopulated: boolean;
  /** A verified memory rule names this header pattern and this target. */
  readonly memoryApplies: boolean;
  /** The header names a canonical object other than the one the field's file holds. */
  readonly headerNamesAnotherObject: boolean;
  /** The item names no target and no target the envelope let the candidate name is evidenced for the field by name, shape or values. */
  readonly noTargetEvidenced: boolean;
  /** The envelope let the candidate name more than one target, and every alternative the item lists is one of them. */
  readonly severalTargetsOffered: boolean;
  /** A required, writable target of the object is neither decided deterministically nor named by an item of this proposal. */
  readonly requiredTargetUnsatisfied: boolean;
  /** The item names a primitive the catalogue marks destructive. */
  readonly destructivePrimitive: boolean;
  /** The resolver classified the field as a unique column without authority: an identity signal or unique but unproven. */
  readonly identityUnproven: boolean;
  /** The target named, or a contract field the header names, is outside the support envelope: no destination field delivers it. */
  readonly outsideSupportEnvelope: boolean;
  /** SELECT_SEMANTIC_TYPE: the chosen type is the one the column's dominant full-data shape reads its values as (D3-CAP-03). */
  readonly chosenTypeShaped: boolean;
  /** The candidate stands for duplicate clusters Migration Core reported, over signal columns the envelope carries (D3-CAP-07). */
  readonly duplicateSignalShared: boolean;
  /** The association named is one the run knows, and the key column's header names its target's object (D3-CAP-08). */
  readonly keyNamesAssociationTarget: boolean;
}

interface FactContext {
  readonly envelope: IntelligenceEnvelopeV1;
  readonly contracts: AdaptedContracts;
  readonly candidate: DeterministicCandidate | undefined;
  readonly field: SourceFieldFact | undefined;
  readonly decisions: readonly ResolvedDecision[];
  /** Every target the other items of the proposal name, for the required-target fact. */
  readonly targetsNamedByProposal: ReadonlySet<string>;
  /** The association a MAP_ASSOCIATION item names, in the run's universe; undefined for every other item. */
  readonly association?: AssociationOption | undefined;
}

/**
 * The facts of a MAP_OBJECT (D3-CAP-01): the object facts of the file the
 * candidate covers, counted by this core over the file's own columns — never
 * read back from the envelope or the proposal. A claim holds only when its
 * own count is there AND the chosen object's facts strictly outweigh every
 * other object's: a header that names two objects equally decides nothing.
 */
function objectItemFacts(item: ProposalItem, context: FactContext, facts: readonly ObjectFact[]): ItemFacts {
  const chosen = facts.find((fact) => fact.objectRef === item.targetRef);
  const decides = chosen !== undefined && objectDecides(facts, chosen.object);
  const header = chosen !== undefined && decides && chosen.headerMatches > 0;
  const shape = chosen !== undefined && decides && chosen.shapeHolds > 0;
  const memory = chosen !== undefined && decides && chosen.memoryMatches > 0;
  const allowed = context.candidate?.allowedTargetRefs ?? [];
  return { headerMatchesLabel: header, headerMatchesApiName: header, headerMatchesTarget: header, shapeMatchesTarget: shape, valuesAreTargetOptions: false, valuesOutsideTargetOptions: false, uniqueAndPopulated: false, memoryApplies: memory, headerNamesAnotherObject: false, noTargetEvidenced: false, severalTargetsOffered: allowed.length >= 2 && item.alternatives.every((alternative) => allowed.includes(alternative.targetRef)) && !facts.some((fact) => objectDecides(facts, fact.object)), requiredTargetUnsatisfied: false, destructivePrimitive: item.transformPrimitive !== null && (PRIMITIVES[item.transformPrimitive]?.destructive ?? false), identityUnproven: false, outsideSupportEnvelope: chosen === undefined, chosenTypeShaped: false, duplicateSignalShared: false, keyNamesAssociationTarget: false };
}

function itemFacts(item: ProposalItem, context: FactContext): ItemFacts {
  const { envelope, contracts, candidate, field, decisions } = context;
  const vendorFields = envelope.targetContract.mode === 'CLEAN_ONLY' ? null : envelope.targetContract.fields;
  const targetInfo = item.targetRef === null ? undefined : contracts.refs.targetByRef.get(item.targetRef);
  const targetField = item.targetRef === null || vendorFields === null ? undefined : vendorFields.find((entry) => entry.targetRef === item.targetRef);
  const header = field?.header ?? '';
  const canonicalName = targetInfo === undefined ? '' : (targetInfo.destinationField.split('.')[1] ?? '');
  const labelNames = targetInfo === undefined ? [] : [targetInfo.label, canonicalName];
  const apiNames = targetInfo === undefined ? [] : [targetInfo.apiName, canonicalName];
  const headerMatchesLabel = namesMatch(header, labelNames);
  const headerMatchesApiName = namesMatch(header, apiNames);
  const headerMatchesTarget = headerMatchesLabel || headerMatchesApiName;
  const semanticOfRef = (targetRef: string): string | null => {
    const info = contracts.refs.targetByRef.get(targetRef);
    const view = vendorFields?.find((entry) => entry.targetRef === targetRef);
    if (view !== undefined) return SEMANTIC_OF_TARGET_TYPE(view.type, view.options);
    if (info === undefined) return null;
    return SEMANTIC_OF_TARGET_TYPE(info.destinationField.endsWith('email') ? 'email' : info.destinationField.endsWith('phone') ? 'phone' : info.destinationField.endsWith('website') || info.destinationField.endsWith('domain') ? 'url' : 'text', []);
  };
  const shapeMatches = (targetRef: string): boolean => {
    const semantic = semanticOfRef(targetRef);
    return field !== undefined && semantic !== null && semantic !== 'TEXT' && semantic !== 'ENUM' && field.shapeCandidates.some((shape) => SHAPE_SEMANTIC[shape] === semantic);
  };
  const shapeMatchesTarget = item.targetRef !== null && shapeMatches(item.targetRef);
  const values = field === undefined ? [] : envelope.exemplars.filter((exemplar) => exemplar.fieldRef === field.fieldRef && exemplar.dataLevel === 'L1').map((exemplar) => exemplar.minimizedValueOrClass);
  const optionsOf = (targetRef: string): readonly string[] => vendorFields?.find((entry) => entry.targetRef === targetRef)?.options ?? [];
  const valuesInOptions = (targetRef: string): boolean => optionsOf(targetRef).length > 0 && values.length > 0 && values.every((value) => optionsOf(targetRef).includes(value));
  // A value map (D3-CAP-05) claims one pair: the value its candidate stands for, carried in the envelope, onto an option of the target as the envelope lists it.
  const mappedValue = item.proposalType === 'MAP_ENUM_VALUE' ? valueOfCandidate(candidate, envelope) : null;
  const valuesAreTargetOptions = item.proposalType === 'MAP_ENUM_VALUE' ? targetField !== undefined && mappedValue !== null && targetField.options.includes(item.typedTransformParams?.['to'] ?? '') : targetField !== undefined && valuesInOptions(targetField.targetRef);
  const consideredTargets = item.targetRef !== null ? [item.targetRef] : [...(candidate?.allowedTargetRefs ?? [])];
  const valuesOutsideTargetOptions = values.length > 0 && consideredTargets.some((targetRef) => optionsOf(targetRef).length > 0 && values.some((value) => !optionsOf(targetRef).includes(value)));
  const uniqueAndPopulated = field !== undefined && field.uniqueAmongNonEmpty === true && field.nonEmptyCount > 0 && field.nonEmptyCount === field.rowCount;
  const memoryApplies = envelope.memoryEvidence.some((entry) => entry.rule.targetRef !== null && entry.rule.targetRef === item.targetRef && field !== undefined && field.header.toLowerCase().includes(entry.rule.sourceHeaderPattern.toLowerCase()));
  // The object the field's file holds, as the resolver recorded it on the field's decisions (`${fileId}-${object}`).
  const recordId = field === undefined ? null : (decisions.find((decision) => decision.fieldRef === field.fieldRef && decision.recordId !== null)?.recordId ?? null);
  const fileObject = recordId === null ? null : recordId.slice(recordId.lastIndexOf('-') + 1).toUpperCase();
  const headerNamesAnotherObject = tokensOf(header).some((token) => {
    const object = OBJECT_OF_TOKEN[token];
    return object !== undefined && object !== fileObject;
  });
  const namesOfRef = (targetRef: string): string[] => {
    const info = contracts.refs.targetByRef.get(targetRef);
    return info === undefined ? [] : [info.label, info.apiName, info.destinationField.split('.')[1] ?? ''];
  };
  const evidencedFor = (targetRef: string): boolean => namesMatch(header, namesOfRef(targetRef)) || shapeMatches(targetRef) || valuesInOptions(targetRef);
  const allowed = candidate?.allowedTargetRefs ?? [];
  const noTargetEvidenced = item.targetRef === null && !allowed.some(evidencedFor);
  const severalTargetsOffered = allowed.length >= 2 && item.alternatives.every((alternative) => allowed.includes(alternative.targetRef));
  const objectOfTarget = (targetRef: string): string | null => contracts.refs.targetByRef.get(targetRef)?.objectApiName ?? null;
  const objectsInPlay = new Set([...consideredTargets.map(objectOfTarget)].filter((object): object is string => object !== null));
  const decidedTargets = new Set(decisions.filter((decision) => decision.kind === 'FIELD_MAPPING' && decision.targetRef !== null).map((decision) => decision.targetRef));
  const requiredTargetUnsatisfied = vendorFields !== null && vendorFields.some((entry) => entry.required && (entry.createable || entry.updateable) && objectsInPlay.has(entry.objectApiName) && (contracts.refs.targetByRef.get(entry.targetRef)?.destinationField ?? '') !== '' && !decidedTargets.has(entry.targetRef) && !context.targetsNamedByProposal.has(entry.targetRef));
  const destructivePrimitive = item.transformPrimitive !== null && (PRIMITIVES[item.transformPrimitive]?.destructive ?? false);
  const proof = field === undefined ? null : (decisions.find((decision) => decision.kind === 'IDENTITY_PROOF' && decision.fieldRef === field.fieldRef)?.identityProof ?? null);
  const identityUnproven = proof === 'IDENTITY_SIGNAL' || proof === 'UNIQUE_BUT_UNPROVEN';
  const outsideSupportEnvelope = item.targetRef !== null ? targetInfo !== undefined && targetInfo.destinationField === '' : [...contracts.refs.targetByRef.values()].some((info) => info.destinationField === '' && namesMatch(header, [info.label, info.apiName]));
  const chosenType = item.proposalType === 'SELECT_SEMANTIC_TYPE' ? (item.typedTransformParams?.['semanticType'] ?? null) : null;
  const dominant = field?.shapeCandidates[0];
  const chosenTypeShaped = chosenType !== null && chosenType !== 'TEXT' && field !== undefined && (TYPE_OF_SHAPE[dominant ?? ''] === chosenType || (chosenType === 'IDENTIFIER' && field.shapeCandidates.includes('leadingZeroDigits')));
  // A column no target can hold (D3-CAP-09): NO_TARGET_IN_ENVELOPE is the resolver's own plausibility rule computed again here — no writable, unclaimed target of the record mapping's object reads the column — not the empty list the candidate carries.
  const unmappedColumn = candidate?.candidateType === DERIVED_CANDIDATE_TYPES.UNMAPPED;
  const noPlausibleTarget = unmappedColumn && field !== undefined && fileObject !== null && recordId !== null && plausibleTargetsOf(contracts, field, fileObject, (entry) => decisions.some((decision) => decision.kind === 'FIELD_MAPPING' && decision.recordId === recordId && decision.destinationField === entry.destinationField)).length === 0;
  const duplicateSignalShared = candidate !== undefined && candidate.candidateType === DUPLICATE_CANDIDATE_TYPE && (candidate.impactCounts.distinct ?? 0) >= 1 && candidate.sourceRefs.length > 0 && candidate.sourceRefs.every((ref) => envelope.sourceProfile.fields.some((entry) => entry.fieldRef === ref));
  // The key column's own header, as the profile recorded it: the envelope may carry it masked, and the fact is about the column, not about what travelled.
  const keyHeader = field === undefined ? '' : (contracts.refs.fieldByRef.get(field.fieldRef)?.header ?? '');
  const keyNamesAssociationTarget = context.association !== undefined && objectsNamedBy(keyHeader).has(context.association.targetObject);
  return { headerMatchesLabel, headerMatchesApiName, headerMatchesTarget, shapeMatchesTarget, valuesAreTargetOptions, valuesOutsideTargetOptions, uniqueAndPopulated, memoryApplies, headerNamesAnotherObject, noTargetEvidenced: unmappedColumn ? item.targetRef === null && noPlausibleTarget : noTargetEvidenced, severalTargetsOffered, requiredTargetUnsatisfied, destructivePrimitive, identityUnproven, outsideSupportEnvelope, chosenTypeShaped, duplicateSignalShared, keyNamesAssociationTarget };
}

/** The fact each rationale code claims. Every code of the closed vocabulary has one; there is no code this compiler cannot check. */
function claimHolds(item: ProposalItem, facts: ItemFacts): boolean {
  switch (item.rationaleCode) {
    case 'HEADER_MATCHES_TARGET_LABEL':
      return facts.headerMatchesLabel;
    case 'HEADER_MATCHES_TARGET_API_NAME':
      return facts.headerMatchesApiName;
    case 'SHAPE_MATCHES_TARGET_TYPE':
      return item.proposalType === 'SELECT_SEMANTIC_TYPE' ? facts.chosenTypeShaped : facts.shapeMatchesTarget;
    case 'VALUES_ARE_TARGET_OPTIONS':
      return facts.valuesAreTargetOptions;
    case 'UNIQUE_AND_WELL_FORMED_IDENTIFIER':
      return facts.uniqueAndPopulated;
    case 'MEMORY_CONVENTION_APPLIES':
      return facts.memoryApplies;
    case 'FOREIGN_KEY_COLUMN':
      return item.proposalType === 'MAP_ASSOCIATION' ? facts.keyNamesAssociationTarget : facts.headerNamesAnotherObject;
    case 'NO_TARGET_IN_ENVELOPE':
      return facts.noTargetEvidenced;
    case 'AMBIGUOUS_BETWEEN_TARGETS':
      return facts.severalTargetsOffered;
    case 'VALUE_NOT_IN_TARGET_OPTIONS':
      return facts.valuesOutsideTargetOptions;
    case 'REQUIRED_TARGET_UNSATISFIED':
      return facts.requiredTargetUnsatisfied;
    case 'DESTRUCTIVE_NEEDS_AGENCY':
      return facts.destructivePrimitive;
    case 'IDENTITY_NEEDS_PROOF':
      return item.proposalType === 'PROPOSE_DUPLICATE_SIGNAL' ? facts.duplicateSignalShared : facts.identityUnproven;
    case 'INSUFFICIENT_EVIDENCE':
      // The claim of having nothing is true when this compiler finds nothing either.
      return !(facts.headerMatchesTarget || facts.shapeMatchesTarget || facts.valuesAreTargetOptions || facts.memoryApplies || facts.uniqueAndPopulated || facts.chosenTypeShaped);
    case 'OUT_OF_SUPPORT_ENVELOPE':
      return facts.outsideSupportEnvelope;
  }
}

/**
 * The evidence class from accepted refs and computed facts — auditable rules,
 * no self-declaration: the rationale code selects which fact is claimed, the
 * facts decide whether it holds. A claim the facts contradict is INSUFFICIENT
 * and the item is refused as RATIONALE_NOT_SUPPORTED_BY_FACTS. A claim that
 * holds but defers — a limit the model reports, not a fact that makes the
 * mapping true — is AMBIGUOUS, and an AMBIGUOUS item is never PROPOSED
 * (canon §28: no authority without evidence).
 */
function evidenceClassOf(item: ProposalItem, knownEvidence: ReadonlySet<string>, facts: ItemFacts, preserveDecision = false): { readonly evidenceClass: EvidenceClass; readonly unsupportedClaim: boolean } {
  const accepted = item.evidenceRefs.filter((ref) => knownEvidence.has(ref));
  if (accepted.length === 0) return { evidenceClass: 'INSUFFICIENT', unsupportedClaim: false };
  const holds = claimHolds(item, facts);
  if (holds === false) return { evidenceClass: 'INSUFFICIENT', unsupportedClaim: true };
  // Preserving a column no target can hold is the decision UNMAPPED_HANDLING asks for, and the fact that no target can hold it is what supports it (D3-CAP-09).
  if (preserveDecision) return { evidenceClass: 'SUPPORTED', unsupportedClaim: false };
  if (kindOf(item) === 'DEFERS') return { evidenceClass: 'AMBIGUOUS', unsupportedClaim: false };
  if (facts.headerMatchesTarget && (facts.memoryApplies || facts.shapeMatchesTarget)) return { evidenceClass: 'STRONG', unsupportedClaim: false };
  return { evidenceClass: 'SUPPORTED', unsupportedClaim: false };
}

/** The semantic types a SELECT_SEMANTIC_TYPE may name: Migration Core's own vocabulary. */
const SEMANTIC_TYPE_VOCABULARY: readonly string[] = ['TEXT', 'EMAIL', 'PHONE', 'DATE', 'DATETIME', 'NUMBER', 'IDENTIFIER', 'BOOLEAN', 'ENUM', 'URL'];

/**
 * Whether the column's full-data shapes read its values as the type (D3-CAP-03):
 * TEXT reads nothing into a value and is always open; any other type must be
 * the one the dominant shape reads — a minority shape does not choose the
 * type of the column it is the minority of — or IDENTIFIER, where digits with
 * a leading zero are present, since only an identifier keeps them whole.
 */
function typeReadByShapes(field: SourceFieldFact | undefined, type: string): boolean {
  if (type === 'TEXT') return true;
  if (field === undefined) return false;
  return TYPE_OF_SHAPE[field.shapeCandidates[0] ?? ''] === type || (type === 'IDENTIFIER' && field.shapeCandidates.includes('leadingZeroDigits'));
}

/** Whether a destination of the given type takes a value read as the chosen type: its own type, anything but an ENUM into a text field, and plain text into anything but an ENUM. */
const destinationAccepts = (destination: string | null, type: string): boolean => destination !== null && (type === destination || (destination === 'TEXT' && type !== 'ENUM') || (type === 'TEXT' && destination !== 'ENUM'));

/** The canonical object of a record mapping id (`${fileId}-${object}`), upper-cased as the destinations name it. */
const objectOfRecordMapping = (recordId: string | null | undefined): string | null => (recordId === null || recordId === undefined ? null : recordId.slice(recordId.lastIndexOf('-') + 1).toUpperCase());

export function compileProposal(input: CompileInput): CompiledTask {
  const { envelope, proposal, contracts } = input;
  const codes: string[] = [];
  const digest = digestOf(proposal);
  const refuse = (outcome: TaskOutcome, reason: string, repairable = false): CompiledTask => ({ taskId: envelope.taskId, envelopeHash: input.envelopeHash, proposalDigest: digest, outcome, codes: [...codes, reason], items: [], repairable });

  // 1. Identity: this task, this run, this envelope, this policy and bundle.
  if (proposal.taskId !== envelope.taskId) return refuse('STALE_INPUT', 'TASK_ID_MISMATCH');
  if (proposal.runId !== input.runId) return refuse('STALE_INPUT', 'RUN_ID_MISMATCH');
  if (proposal.envelopeHash !== input.envelopeHash) return refuse('STALE_INPUT', 'ENVELOPE_HASH_MISMATCH');
  if (proposal.modelPolicyVersion !== MODEL_POLICY_VERSION || proposal.promptBundleVersion !== PROMPT_BUNDLE_VERSION) return refuse('INCOMPATIBLE_CONTRACT_VERSION', 'POLICY_OR_BUNDLE_VERSION_MISMATCH');
  if (proposal.items.length > envelope.constraints.maxItems) return refuse('INVALID_SEMANTICS', 'TOO_MANY_ITEMS', true);

  const candidatesByRef = new Map(envelope.deterministicCandidates.map((candidate) => [candidate.candidateRef, candidate]));
  const knownEvidence = new Set([...envelope.deterministicCandidates.flatMap((candidate) => candidate.evidenceRefs), ...envelope.sourceProfile.fields.flatMap((field) => field.evidenceRefs)]);
  const targetFields = envelope.targetContract.mode === 'CLEAN_ONLY' ? null : new Map(envelope.targetContract.fields.map((field) => [field.targetRef, field]));
  const fieldsByRef = new Map(envelope.sourceProfile.fields.map((field) => [field.fieldRef, field]));
  const items: CompiledItem[] = [];
  const targetsNamedByProposal = new Set(proposal.items.map((item) => item.targetRef).filter((ref): ref is string => ref !== null));
  // The record mapping of each source field, as the resolver recorded it: the scope a claim lives in with its destination (D3-SCOPE-1).
  const recordMappingOfField = new Map(input.decisions.filter((decision) => decision.kind === 'IDENTITY_PROOF').map((decision) => [decision.fieldRef, decision.recordId]));
  const claimedTargets = new Map<string, string>(); // output scope → the candidate that claimed it first
  const seenCandidates = new Set<string>();
  const locale = input.locale ?? NO_LOCALE;
  // The full-data shapes of a column, from the frozen profile — never from the envelope — are what a parameter's evidence is read on (D3-CAP-04).
  const frozenFields = new Map(contracts.profileView.fields.map((field) => [field.fieldRef, field]));
  // The destination each column has by the resolver's own mapping: what a transformation parameterises.
  const mappingOfField = new Map(input.decisions.filter((decision) => decision.kind === 'FIELD_MAPPING' && decision.targetRef !== null).map((decision) => [decision.fieldRef, decision]));
  // The output scopes a requirement may already be satisfied in (D3-CAP-10): the resolver's mappings, earlier tasks' accepted mappings, and this proposal's own.
  const scopeOf = (sourceRef: string | undefined, targetRef: string | null): string | null => {
    const destination = targetRef === null ? '' : (contracts.refs.targetByRef.get(targetRef)?.destinationField ?? '');
    return sourceRef === undefined || destination === '' ? null : outputScopeOf(recordMappingOfField.get(sourceRef) ?? null, destination);
  };
  const satisfiedScopes = new Set([...input.decisions.filter((decision) => decision.kind === 'FIELD_MAPPING').map((decision) => scopeOf(decision.fieldRef, decision.targetRef)), ...proposal.items.filter((entry) => entry.proposalType === 'MAP_FIELD').map((entry) => scopeOf(candidatesByRef.get(entry.candidateRef)?.sourceRefs[0], entry.targetRef)), ...(input.priorClaims ?? [])].filter((scope): scope is string => scope !== null));
  const vendorTargets = contracts.contractView.mode === 'CLEAN_ONLY' ? null : new Map(contracts.contractView.fields.map((field) => [field.targetRef, field]));
  let anyRepairable = false;
  // The objects the support envelope delivers, by the refs a MAP_OBJECT names them with, and the file-level facts of each object candidate, counted here over its own columns (D3-CAP-01).
  const objectOfRef = new Map(supportedObjects(contracts).map((entry) => [entry.objectRef, entry.object]));
  const objectFacts = new Map<string, readonly ObjectFact[]>();
  const objectFactsFor = (candidate: DeterministicCandidate): readonly ObjectFact[] => {
    const known = objectFacts.get(candidate.candidateRef);
    if (known !== undefined) return known;
    const facts = objectFactsOf(contracts, candidate.sourceRefs, { evidence: envelope.memoryEvidence, headerOf: (fieldRef) => fieldsByRef.get(fieldRef)?.header ?? '' });
    objectFacts.set(candidate.candidateRef, facts);
    return facts;
  };

  for (const item of proposal.items) {
    const itemCodes: string[] = [];
    let outcome: TaskOutcome = 'PROPOSED';
    let repairable = false;
    const fail = (code: string, kind: TaskOutcome, canRepair = false): void => {
      itemCodes.push(code);
      if (outcome === 'PROPOSED' || kind === 'FORBIDDEN_PROPOSAL') outcome = kind;
      if (canRepair) repairable = true;
    };
    const candidate = candidatesByRef.get(item.candidateRef);
    // A CONSISTENCY_REVIEW candidate names decisions, not targets (D3-CAP-11): its answer is judged by the evidence-ranked preserve below, not by the mapping rules.
    const review = candidate?.candidateType === REVIEW_CANDIDATE_TYPE;
    // 2. References: the candidate, the target, the evidence — all from the envelope.
    if (candidate === undefined) fail('UNKNOWN_CANDIDATE_REF', 'INVALID_SEMANTICS', true);
    if (seenCandidates.has(item.candidateRef)) fail('DUPLICATE_CANDIDATE_ITEM', 'INVALID_SEMANTICS', true);
    seenCandidates.add(item.candidateRef);
    if (!envelope.constraints.allowedProposalTypes.includes(item.proposalType)) fail('PROPOSAL_TYPE_NOT_ALLOWED_FOR_TASK', 'FORBIDDEN_PROPOSAL');
    for (const evidenceRef of item.evidenceRefs) if (!knownEvidence.has(evidenceRef)) fail('INVENTED_EVIDENCE_REF', 'INVALID_SEMANTICS', true);
    const reviewClaims = review ? (envelope.reviewClaims ?? []).filter((claim) => claim.candidateRef === item.candidateRef) : [];
    const sourceFieldRef = (review ? reviewClaims.find((claim) => claim.decisionRef === item.targetRef)?.fieldRef : undefined) ?? candidate?.sourceRefs[0] ?? null;
    const field = sourceFieldRef === null ? undefined : fieldsByRef.get(sourceFieldRef);
    // An association names an association ref, never a contract field: it is checked against the run's associations below (D3-CAP-08); an object is checked by its own rule above (D3-CAP-01).
    const needsTarget = item.proposalType === 'MAP_FIELD' || item.proposalType === 'MAP_ENUM_VALUE' || item.proposalType === 'APPLY_SUPPORTED_TRANSFORM';
    const modifier = FIELD_MODIFIERS.has(item.proposalType);
    let requirementTarget: string | null = null;
    let destinationField: string | null = null;
    let semanticType: string | null = null;
    let object: string | null = null;
    let typeTargetRef: string | null = null;
    if (item.proposalType === 'MAP_OBJECT') {
      // 3. The object (D3-CAP-01): one the support envelope delivers, named by its object ref, offered to this file — and one file in one record mapping: an answer that names another file's candidate instead of an object puts two files in one record mapping, and an answer about more than one file, or not about a file at all, collapses the scope of the file.
      if (item.targetRef === null) fail('TARGET_REQUIRED_FOR_MAPPING', 'INVALID_SEMANTICS', true);
      else if (candidatesByRef.has(item.targetRef)) fail('OBJECT_SCOPE_COLLAPSE', 'FORBIDDEN_PROPOSAL');
      else if (!objectOfRef.has(item.targetRef)) fail('OBJECT_OUTSIDE_SUPPORT_ENVELOPE', 'FORBIDDEN_PROPOSAL');
      else {
        const offeredObject = envelope.constraints.allowedTargetIds.includes(item.targetRef);
        if (!offeredObject) fail('TARGET_OUTSIDE_ENVELOPE', 'FORBIDDEN_PROPOSAL');
        else if (candidate !== undefined && !candidate.allowedTargetRefs.includes(item.targetRef)) fail('TARGET_NOT_ALLOWED_FOR_CANDIDATE', 'INVALID_SEMANTICS', true);
        object = objectOfRef.get(item.targetRef) ?? null;
      }
      const files = new Set((candidate?.sourceRefs ?? []).map((fieldRef) => contracts.refs.fieldByRef.get(fieldRef)?.fileId));
      if (candidate !== undefined && (candidate.candidateType !== DERIVED_CANDIDATE_TYPES.OBJECT || files.size !== 1)) fail('OBJECT_SCOPE_COLLAPSE', 'FORBIDDEN_PROPOSAL');
    } else if (needsTarget && !review) {
      if (item.targetRef === null) fail('TARGET_REQUIRED_FOR_MAPPING', 'INVALID_SEMANTICS', true);
      else {
        // 3. TargetContract: the target exists in the exact contract, the candidate may name it, it is writable, the type is compatible.
        if (!envelope.constraints.allowedTargetIds.includes(item.targetRef)) fail('TARGET_OUTSIDE_ENVELOPE', 'FORBIDDEN_PROPOSAL');
        else if (candidate !== undefined && !candidate.allowedTargetRefs.includes(item.targetRef)) fail('TARGET_NOT_ALLOWED_FOR_CANDIDATE', 'INVALID_SEMANTICS', true);
        const targetInfo = contracts.refs.targetByRef.get(item.targetRef);
        destinationField = targetInfo?.destinationField ?? null;
        if (targetInfo === undefined) fail('TARGET_NOT_IN_CONTRACT', 'FORBIDDEN_PROPOSAL');
        // 5. Support envelope: a vendor field Migration Core cannot deliver has no destination field.
        else if (destinationField === '') fail('TARGET_OUTSIDE_SUPPORT_ENVELOPE', 'FORBIDDEN_PROPOSAL');
        // A field's destination is a field of its own record mapping's object: a target of another object is outside the scope the mapping may write (D3-CAP-02).
        const recordObject = sourceFieldRef === null ? null : objectOfRecordMapping(recordMappingOfField.get(sourceFieldRef));
        if ((item.proposalType === 'MAP_FIELD' || item.proposalType === 'MAP_ENUM_VALUE') && recordObject !== null && destinationField !== null && destinationField !== '' && (destinationField.split('.')[0] ?? '').toUpperCase() !== recordObject) fail('TARGET_OF_ANOTHER_OBJECT', 'FORBIDDEN_PROPOSAL');
        // Writable by the whole attested contract, whether or not the envelope's view carried the target.
        const contractField = contracts.contractView.mode === 'CLEAN_ONLY' ? undefined : contracts.contractView.fields.find((entry) => entry.targetRef === item.targetRef);
        if (contractField !== undefined && !contractField.createable && !contractField.updateable) fail('TARGET_NOT_WRITABLE', 'FORBIDDEN_PROPOSAL');
        if (targetFields !== null) {
          const targetField = targetFields.get(item.targetRef);
          if (targetField === undefined) fail('TARGET_NOT_IN_CONTRACT_VIEW', 'INVALID_SEMANTICS', true);
          else {
            const targetSemantic = SEMANTIC_OF_TARGET_TYPE(targetField.type, targetField.options);
            const shape = field?.shapeCandidates[0];
            const sourceSemantic = shape === undefined ? null : (SHAPE_SEMANTIC[shape] ?? null);
            if (sourceSemantic !== null && targetSemantic !== 'TEXT' && targetSemantic !== 'ENUM' && sourceSemantic !== targetSemantic) fail('TYPE_INCOMPATIBLE', 'INVALID_SEMANTICS', true);
            semanticType = targetSemantic === 'ENUM' ? 'ENUM' : (sourceSemantic ?? targetSemantic);
            if (item.proposalType === 'MAP_ENUM_VALUE') {
              const to = item.typedTransformParams?.['to'];
              if (to === undefined || !targetField.options.includes(to)) fail('ENUM_VALUE_NOT_IN_TARGET_OPTIONS', 'INVALID_SEMANTICS', true);
            }
          }
        } else if (item.proposalType === 'MAP_ENUM_VALUE') fail('CLEAN_ONLY_HAS_NO_ENUM_AUTHORITY', 'FORBIDDEN_PROPOSAL');
        else {
          // CLEAN_ONLY (D3-CAP-03/04): the canonical field types the destination as the vendor contract would, and the column's full-data shape refines a text destination, so the primitives the candidate offered by that shape apply to a field typed by it.
          const targetSemantic = targetSemanticOf(contracts, item.targetRef) ?? 'TEXT';
          const shape = field?.shapeCandidates[0];
          const sourceSemantic = shape === undefined ? null : (SHAPE_SEMANTIC[shape] ?? null);
          if (sourceSemantic !== null && targetSemantic !== 'TEXT' && targetSemantic !== 'ENUM' && sourceSemantic !== targetSemantic) fail('TYPE_INCOMPATIBLE', 'INVALID_SEMANTICS', true);
          semanticType = sourceSemantic ?? targetSemantic;
        }
        // 7. Consistency within the task: one claim per output scope — one destination of one record mapping — or an explicit decision. Two record mappings may name one target (IC-08).
        const claimScope = outputScopeOf(sourceFieldRef === null ? null : (recordMappingOfField.get(sourceFieldRef) ?? null), destinationField === null || destinationField === '' ? item.targetRef : destinationField);
        // A transformation or a value map claims nothing: it changes the field that holds the destination.
        const previous = claimedTargets.get(claimScope);
        if (!modifier && previous !== undefined && previous !== item.candidateRef && !item.requiresAgencyDecision) fail('DUPLICATE_TARGET_WITHOUT_RESOLUTION', 'INVALID_SEMANTICS', true);
        if (!modifier) claimedTargets.set(claimScope, item.candidateRef);
      }
    } else if (item.targetRef !== null && item.proposalType !== 'SELECT_SEMANTIC_TYPE' && item.proposalType !== 'BLOCKING_TARGET_REQUIREMENT' && item.proposalType !== 'MAP_ASSOCIATION' && !review) fail('TARGET_ON_NON_MAPPING_ITEM', 'INVALID_SEMANTICS', true);
    // 3b. Associations (D3-CAP-08): the ref names one association of the run's universe for the candidate's key column — a relationship the shape and the contract support, toward a record mapping that declares its record id — and one the envelope offered. Each refusal by name; cardinality is Migration Core's to report.
    let association: AssociationOption | undefined;
    if (item.proposalType === 'MAP_ASSOCIATION') {
      if (candidate === undefined || candidate.candidateType !== ASSOCIATION_CANDIDATE_TYPE) fail('PROPOSAL_TYPE_NOT_ALLOWED_FOR_CANDIDATE', 'FORBIDDEN_PROPOSAL');
      else if (item.targetRef === null) fail('TARGET_REQUIRED_FOR_MAPPING', 'INVALID_SEMANTICS', true);
      else {
        association = associationOptionOf(contracts, input.decisions, candidate.sourceRefs[0] ?? '', item.targetRef);
        if (association === undefined) fail('ASSOCIATION_OUTSIDE_ENVELOPE', 'FORBIDDEN_PROPOSAL');
        else if (association.status === 'RELATIONSHIP_NOT_SUPPORTED') fail('RELATIONSHIP_NOT_SUPPORTED', 'FORBIDDEN_PROPOSAL');
        else if (association.status === 'ASSOCIATION_ENDPOINT_UNDECLARED') fail('ASSOCIATION_ENDPOINT_UNDECLARED', 'FORBIDDEN_PROPOSAL');
        else if (!candidate.allowedTargetRefs.includes(item.targetRef) || !envelope.constraints.allowedTargetIds.includes(item.targetRef) || !envelope.associationTargets.some((target) => target.associationRef === item.targetRef)) fail('ASSOCIATION_OUTSIDE_ENVELOPE', 'FORBIDDEN_PROPOSAL');
        else if (!envelope.constraints.allowedAssociationTypes.includes(association.relationshipType)) fail('RELATIONSHIP_NOT_SUPPORTED', 'FORBIDDEN_PROPOSAL');
      }
    }
    // A transformation (D3-CAP-04) parameterises the destination the resolver mapped its column to, under that mapping's semantic type, and names its primitive.
    if (item.proposalType === 'APPLY_SUPPORTED_TRANSFORM') {
      const mapping = sourceFieldRef === null ? undefined : mappingOfField.get(sourceFieldRef);
      if (mapping === undefined || mapping.targetRef !== item.targetRef) fail('TRANSFORM_WITHOUT_MAPPING', 'INVALID_SEMANTICS', true);
      else semanticType = mapping.semanticType;
      if (item.transformPrimitive === null) fail('PRIMITIVE_REQUIRED', 'INVALID_SEMANTICS', true);
    }
    // A value map (D3-CAP-05) maps the value its candidate stands for, which the envelope carried as an exemplar; its only parameter is the `to`.
    if (item.proposalType === 'MAP_ENUM_VALUE') {
      if (candidate !== undefined && valueOfCandidate(candidate, envelope) === null) fail('VALUE_NOT_IN_ENVELOPE', 'INVALID_SEMANTICS', true);
      if (item.transformPrimitive === null) for (const name of Object.keys(item.typedTransformParams ?? {})) if (!(PRIMITIVES.MAP_ENUM_VALUE.params as readonly string[]).includes(name)) fail(`UNKNOWN_PARAM_${name.toUpperCase()}`, 'INVALID_SEMANTICS', true);
    }
    // A blocking requirement (D3-CAP-10) names a target the contract requires — not nillable, not defaulted, writable, deliverable — that no decision satisfies; a rule the contract does not state stays unknown.
    if (item.proposalType === 'BLOCKING_TARGET_REQUIREMENT') {
      requirementTarget = item.targetRef ?? (candidate?.candidateType === REQUIREMENT_CANDIDATE_TYPE ? (candidate.allowedTargetRefs[0] ?? null) : null);
      if (requirementTarget === null) fail('REQUIREMENT_WITHOUT_TARGET', 'INVALID_SEMANTICS', true);
      else if (!envelope.constraints.allowedTargetIds.includes(requirementTarget)) fail('TARGET_OUTSIDE_ENVELOPE', 'FORBIDDEN_PROPOSAL');
      else {
        const stated = vendorTargets?.get(requirementTarget);
        const destination = contracts.refs.targetByRef.get(requirementTarget)?.destinationField ?? '';
        if (stated === undefined || !stated.required || !(stated.createable || stated.updateable) || destination === '') fail('REQUIREMENT_NOT_IN_CONTRACT', 'INVALID_SEMANTICS', true);
        else {
          destinationField = destination;
          const scope = scopeOf(sourceFieldRef ?? undefined, requirementTarget);
          if (scope !== null && satisfiedScopes.has(scope)) fail('REQUIREMENT_HAS_MAPPING', 'INVALID_SEMANTICS', true);
        }
      }
    }
    if (item.proposalType === 'SELECT_SEMANTIC_TYPE') {
      const chosen = item.typedTransformParams?.['semanticType'];
      if (chosen === undefined || !SEMANTIC_TYPE_VOCABULARY.includes(chosen)) fail('SEMANTIC_TYPE_NOT_IN_VOCABULARY', 'INVALID_SEMANTICS', true);
      else semanticType = chosen;
      // The destination the type is for (D3-CAP-03): the column's mapping decided on facts in this run, which its type candidate names. A type for a column with no destination would be applied to nothing.
      const mapping = candidate?.candidateType === DERIVED_CANDIDATE_TYPES.SEMANTIC_TYPE && sourceFieldRef !== null ? input.decisions.find((decision) => decision.kind === 'FIELD_MAPPING' && decision.fieldRef === sourceFieldRef && decision.targetRef !== null) : undefined;
      if (mapping === undefined || mapping.targetRef === null) fail('SEMANTIC_TYPE_WITHOUT_DESTINATION', 'INVALID_SEMANTICS', true);
      else {
        typeTargetRef = mapping.targetRef;
        destinationField = contracts.refs.targetByRef.get(mapping.targetRef)?.destinationField ?? mapping.destinationField;
        if (item.targetRef !== null && item.targetRef !== mapping.targetRef) fail('TARGET_NOT_ALLOWED_FOR_CANDIDATE', 'INVALID_SEMANTICS', true);
        if (semanticType !== null && !typeReadByShapes(field, semanticType)) fail('SEMANTIC_TYPE_CONTRADICTS_SHAPE', 'INVALID_SEMANTICS', true);
        if (semanticType !== null && !destinationAccepts(targetSemanticOf(contracts, mapping.targetRef), semanticType)) fail('SEMANTIC_TYPE_INCOMPATIBLE_WITH_TARGET', 'INVALID_SEMANTICS', true);
      }
    }
    // 4. Primitives and parameters: closed catalogue, closed domains, the semantic type it applies to.
    if (item.transformPrimitive !== null) {
      const primitive = PRIMITIVES[item.transformPrimitive];
      if (!envelope.constraints.supportedTransformPrimitives.includes(item.transformPrimitive)) fail('PRIMITIVE_NOT_SUPPORTED', 'FORBIDDEN_PROPOSAL');
      // The candidate's own allowlist is a second, narrower catalogue: a primitive the envelope supports but this candidate does not carry is outside what the task offered.
      if (candidate !== undefined && !candidate.allowedPrimitiveRefs.includes(item.transformPrimitive)) fail('PRIMITIVE_NOT_ALLOWED_FOR_CANDIDATE', 'FORBIDDEN_PROPOSAL');
      if (primitive.destructive) fail('DESTRUCTIVE_PRIMITIVE_BY_MODEL', 'FORBIDDEN_PROPOSAL');
      const params = item.typedTransformParams ?? {};
      for (const name of Object.keys(params)) {
        if (!(primitive.params as readonly string[]).includes(name) && !(item.proposalType === 'SELECT_SEMANTIC_TYPE' && name === 'semanticType')) fail(`UNKNOWN_PARAM_${name.toUpperCase()}`, 'INVALID_SEMANTICS', true);
        const domain = PRIMITIVE_PARAM_DOMAINS[name];
        const value = params[name] ?? '';
        if (domain !== undefined && !domain.test(value)) fail(`PARAM_OUT_OF_DOMAIN_${name.toUpperCase()}`, 'INVALID_SEMANTICS', true);
      }
      // Evidence (D3-CAP-04): the parameter a primitive needs is named, with a value the facts admit — a decimal separator the column's full-data shapes show, a date format or a region the project declares. A value inside its domain is not yet evidence, and nothing the model writes is.
      const parameterised = PARAMETERISED_PRIMITIVES[item.transformPrimitive];
      if (parameterised !== undefined) {
        const value = params[parameterised.param];
        const shapes = sourceFieldRef === null ? [] : (frozenFields.get(sourceFieldRef)?.shapeCandidates ?? []);
        if (value === undefined) fail('PARAM_REQUIRED', 'INVALID_SEMANTICS', true);
        if (value !== undefined && !evidencedValues(item.transformPrimitive, shapes, locale).includes(value)) fail('PARAM_NOT_EVIDENCED', 'INVALID_SEMANTICS', true);
      }
      if (semanticType !== null && !(primitive.semanticTypes as readonly string[]).includes(semanticType)) fail('PRIMITIVE_DOES_NOT_APPLY_TO_TYPE', 'INVALID_SEMANTICS', true);
    } else if (item.typedTransformParams !== null && item.proposalType !== 'SELECT_SEMANTIC_TYPE' && item.proposalType !== 'MAP_ENUM_VALUE') fail('PARAMS_WITHOUT_PRIMITIVE', 'INVALID_SEMANTICS', true);
    // 6. Authority: identity is never proven by the model; destructive and merge-like proposals need the agency.
    // A candidate of the identity families takes its own family's answers and no other: a duplicate signal offered as an identity is the one refusal named for what it is (D3-CAP-07).
    const ownAnswers = candidate === undefined ? undefined : ANSWERS_OF_CANDIDATE[candidate.candidateType];
    if (ownAnswers !== undefined && !ownAnswers.includes(item.proposalType)) fail(candidate?.candidateType === DUPLICATE_CANDIDATE_TYPE && item.proposalType === 'PROPOSE_IDENTITY_STRATEGY' ? 'DUPLICATE_SIGNAL_IS_NOT_AUTHORITY' : 'PROPOSAL_TYPE_NOT_ALLOWED_FOR_CANDIDATE', 'FORBIDDEN_PROPOSAL');
    // Identity (D3-CAP-06): adopted without the agency only on PROVEN_UNIQUE_IDENTIFIER — the contract's external id named exactly, unique and populated on every row; an email, a phone, a name or an undeclared id is the agency's to decide. Only an identity candidate's strategy is ever assembled.
    if (item.proposalType === 'PROPOSE_IDENTITY_STRATEGY' && !item.requiresAgencyDecision) {
      const proof = input.decisions.find((decision) => decision.kind === 'IDENTITY_PROOF' && decision.fieldRef === sourceFieldRef)?.identityProof ?? 'NO_EVIDENCE';
      if (proof !== 'PROVEN_UNIQUE_IDENTIFIER') fail('IDENTITY_WITHOUT_PROOF_NEEDS_AGENCY', 'FORBIDDEN_PROPOSAL');
    }
    // Duplicate signals (D3-CAP-07) are review-only by construction: a proposal names the candidate and the fact, and nothing a merge could be read from — no primitive, no parameter, no claim that the signal identifies.
    if (item.proposalType === 'PROPOSE_DUPLICATE_SIGNAL') {
      if (candidate === undefined || candidate.candidateType !== DUPLICATE_CANDIDATE_TYPE) fail('PROPOSAL_TYPE_NOT_ALLOWED_FOR_CANDIDATE', 'FORBIDDEN_PROPOSAL');
      if (item.transformPrimitive !== null || item.typedTransformParams !== null || item.rationaleCode === 'UNIQUE_AND_WELL_FORMED_IDENTIFIER') fail('DUPLICATE_SIGNAL_IS_NOT_AUTHORITY', 'FORBIDDEN_PROPOSAL');
    }
    if (item.proposalType === 'NEEDS_AGENCY_DECISION' && !item.requiresAgencyDecision) fail('AGENCY_ITEM_MUST_REQUIRE_AGENCY', 'INVALID_SEMANTICS', true);
    if (item.shortRationale !== null && item.shortRationale.length > envelope.constraints.maxRationaleLength) fail('RATIONALE_TOO_LONG', 'INVALID_SEMANTICS', true);
    if (item.shortRationale !== null && /[{}<>;`]|=>|\bfunction\b|\bselect\b.*\bfrom\b/iu.test(item.shortRationale)) fail('RATIONALE_LOOKS_LIKE_CODE', 'FORBIDDEN_PROPOSAL');
    if (item.proposalType === 'ABSTAIN' && item.abstainReason === null) fail('ABSTAIN_WITHOUT_REASON', 'INVALID_SEMANTICS', true);
    // A column no target can hold (D3-CAP-09): an answer that asks the agency about it asks for its exclusion, which no proposal type makes — named, and the column stays preserved meanwhile.
    const unmappedColumn = candidate?.candidateType === DERIVED_CANDIDATE_TYPES.UNMAPPED;
    if (unmappedColumn && (item.proposalType === 'NEEDS_AGENCY_DECISION' || item.requiresAgencyDecision)) itemCodes.unshift('EXCLUSION_REQUIRES_AGENCY_DECISION');
    if (review) {
      // The evidence-ranked preserve (D3-CAP-11): the preserve of the claim strictly weaker than every other, never of a deterministic decision, is the only answer that changes anything; a ref that names no decision is repaired once; every other answer is the agency's decision and grants nothing.
      const verdict = reviewVerdict(item, reviewClaims, input.decisions);
      if (verdict.kind === 'INVALID') fail(verdict.code, 'INVALID_SEMANTICS', true);
      else if (verdict.kind === 'AGENCY' && outcome === 'PROPOSED') {
        itemCodes.push(verdict.code);
        outcome = 'REQUIRES_AGENCY_DECISION';
      }
      if (repairable) anyRepairable = true;
      items.push({ candidateRef: item.candidateRef, proposalType: item.proposalType, outcome, codes: itemCodes, targetRef: item.targetRef, destinationField: null, sourceFieldRef, semanticType: null, transformPrimitive: null, typedTransformParams: null, evidenceClass: verdict.kind === 'PRESERVE' && outcome === 'PROPOSED' ? 'SUPPORTED' : 'AMBIGUOUS', evidenceRefs: item.evidenceRefs.filter((ref) => knownEvidence.has(ref)), requiresAgencyDecision: item.requiresAgencyDecision, rationaleCode: item.rationaleCode, impactRows: candidate?.impactCounts.rows ?? 0, object: null });
      continue;
    }
    if ((item.proposalType === 'NEEDS_AGENCY_DECISION' || item.requiresAgencyDecision) && outcome === 'PROPOSED') outcome = 'REQUIRES_AGENCY_DECISION';
    const context: FactContext = { envelope, contracts, candidate, field, decisions: input.decisions, targetsNamedByProposal, association };
    // The facts behind the claim: an object's file-level facts for a MAP_OBJECT, the destination's for a type, the target's for anything else.
    const facts = item.proposalType === 'MAP_OBJECT' && candidate !== undefined ? objectItemFacts(item, context, objectFactsFor(candidate)) : itemFacts(typeTargetRef === null ? item : { ...item, targetRef: typeTargetRef }, context);
    // Preserving such a column is the decision itself, PROPOSED on the computed fact that no target can hold it; anywhere else, or without that fact, a preserve abstains and the column is preserved all the same.
    const preserveDecision = unmappedColumn && item.proposalType === 'UNMAPPED_PRESERVE' && item.rationaleCode === 'NO_TARGET_IN_ENVELOPE' && facts.noTargetEvidenced;
    if ((item.proposalType === 'ABSTAIN' || (item.proposalType === 'UNMAPPED_PRESERVE' && !preserveDecision)) && outcome === 'PROPOSED') outcome = 'ABSTAINED';
    if (item.proposalType === 'BLOCKING_TARGET_REQUIREMENT' && outcome === 'PROPOSED') outcome = 'REQUIRES_AGENCY_DECISION';
    const { evidenceClass, unsupportedClaim } = evidenceClassOf(item, knownEvidence, facts, preserveDecision);
    if (outcome === 'PROPOSED' && evidenceClass === 'INSUFFICIENT') {
      // A proposal standing on its own needs a fact behind its claim; a claim the facts contradict is refused by name.
      fail(unsupportedClaim ? 'RATIONALE_NOT_SUPPORTED_BY_FACTS' : 'INSUFFICIENT_EVIDENCE_FOR_PROPOSAL', 'INVALID_SEMANTICS', true);
    }
    if (outcome === 'PROPOSED' && evidenceClass === 'AMBIGUOUS') {
      // The claim holds but decides nothing — a foreign key, an ambiguity, a missing proof, insufficient evidence: the agency decides, the model does not (canon §28).
      fail('AMBIGUOUS_EVIDENCE_NEEDS_AGENCY', 'REQUIRES_AGENCY_DECISION');
    }
    if (repairable) anyRepairable = true;
    items.push({ candidateRef: item.candidateRef, proposalType: item.proposalType, outcome, codes: itemCodes, targetRef: item.proposalType === 'BLOCKING_TARGET_REQUIREMENT' ? requirementTarget : (typeTargetRef ?? item.targetRef), destinationField: destinationField === '' ? null : destinationField, sourceFieldRef, semanticType, transformPrimitive: item.transformPrimitive, typedTransformParams: item.typedTransformParams, evidenceClass, evidenceRefs: item.evidenceRefs.filter((ref) => knownEvidence.has(ref)), requiresAgencyDecision: item.requiresAgencyDecision, rationaleCode: item.rationaleCode, impactRows: candidate?.impactCounts.rows ?? 0, object: outcome === 'PROPOSED' ? object : null });
  }
  // Every candidate of the envelope must be answered. One the proposal leaves
  // out is not an answer, and it is never preserved as if it were one: the
  // omission is INVALID_SEMANTICS CANDIDATE_NOT_ANSWERED, repairable once like
  // an unknown ref, and final after the repair (D3-ACC-3, R2-037).
  for (const candidate of envelope.deterministicCandidates) {
    if (!seenCandidates.has(candidate.candidateRef)) {
      anyRepairable = true;
      items.push({ candidateRef: candidate.candidateRef, proposalType: 'ABSTAIN', outcome: 'INVALID_SEMANTICS', codes: ['CANDIDATE_NOT_ANSWERED'], targetRef: null, destinationField: null, sourceFieldRef: candidate.sourceRefs[0] ?? null, semanticType: null, transformPrimitive: null, typedTransformParams: null, evidenceClass: 'INSUFFICIENT', evidenceRefs: [], requiresAgencyDecision: false, rationaleCode: 'INSUFFICIENT_EVIDENCE', impactRows: candidate.impactCounts.rows, object: null });
    }
  }
  // 8. A value map is complete over its column or it is no value map (D3-CAP-05): the envelope carried every value the full-data profile counts in the column, and every value candidate of it is answered — mapped, left to Migration Core's invalid-value flag, or the agency's. A column mapped in part is refused whole, never applied in part.
  for (const column of new Set(items.filter((item) => item.proposalType === 'MAP_ENUM_VALUE' && item.sourceFieldRef !== null).map((item) => item.sourceFieldRef as string))) {
    const counted = fieldsByRef.get(column)?.distinctCount ?? null;
    const shown = new Set(envelope.exemplars.filter((exemplar) => exemplar.fieldRef === column && exemplar.dataLevel === 'L1').map((exemplar) => exemplar.minimizedValueOrClass));
    const unanswered = envelope.deterministicCandidates.some((candidate) => candidate.candidateType === VALUE_CANDIDATE_TYPE && candidate.sourceRefs[0] === column && !seenCandidates.has(candidate.candidateRef));
    if (!unanswered && counted !== null && shown.size === counted) continue;
    if (unanswered) anyRepairable = true;
    items.forEach((item, index) => {
      if (item.proposalType !== 'MAP_ENUM_VALUE' || item.sourceFieldRef !== column) return;
      items[index] = { ...item, outcome: item.outcome === 'FORBIDDEN_PROPOSAL' ? item.outcome : 'INVALID_SEMANTICS', codes: [...item.codes, 'VALUE_MAP_INCOMPLETE'] };
    });
  }
  const forbidden = items.some((item) => item.outcome === 'FORBIDDEN_PROPOSAL');
  const invalid = items.some((item) => item.outcome === 'INVALID_SEMANTICS');
  const outcome: TaskOutcome = forbidden ? 'FORBIDDEN_PROPOSAL' : invalid ? 'INVALID_SEMANTICS' : items.every((item) => item.outcome === 'ABSTAINED') ? 'ABSTAINED' : items.some((item) => item.outcome === 'REQUIRES_AGENCY_DECISION') ? 'REQUIRES_AGENCY_DECISION' : 'PROPOSED';
  return { taskId: envelope.taskId, envelopeHash: input.envelopeHash, proposalDigest: digest, outcome, codes: [...codes, ...items.flatMap((item) => item.codes)], items, repairable: !forbidden && invalid && anyRepairable };
}
