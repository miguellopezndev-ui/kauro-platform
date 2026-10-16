/**
 * IntelligenceEnvelopeV1 — the input to one model task, canon §9–§15, §20.
 *
 * The envelope is the minimal view a task needs, structurally separate from
 * instructions, immutable once hashed. It carries facts from the frozen
 * profile, the deterministic candidates the task may choose among, memory
 * evidence, classified exemplars, closed constraints and a budget snapshot.
 * It never carries rows, files, raw personal data or secrets; the classifier
 * and minimizer decide what an exemplar may be, and the egress decision
 * refuses an envelope they did not pass.
 */
import { CANONICAL_OBJECTS, RELATIONSHIP_TYPES } from 'kauro-migration-core';

import { digestOf } from './canonical.js';
import { CONTRACT_HASH_PATTERN, HEX64_PATTERN, IDENTIFIER_PATTERN, INSTANT_PATTERN, REF_PATTERN, VERSION_PATTERN, s, validate } from './schema.js';
import type { Schema, SchemaProblem } from './schema.js';
import type { EvidenceClass } from './proposal.js';
import { ENVELOPE_SCHEMA_VERSION } from './versions.js';

export const TASK_TYPES = Object.freeze([
  'OBJECT_MAPPING',
  'FIELD_MAPPING',
  'SEMANTIC_TYPE',
  'TRANSFORMATION_SELECTION',
  'VALUE_MAP',
  'IDENTITY_STRATEGY',
  'DUPLICATE_SIGNAL_STRATEGY',
  'ASSOCIATION_MAPPING',
  'UNMAPPED_HANDLING',
  'TARGET_REQUIREMENT',
  'CONSISTENCY_REVIEW',
  'SEMANTIC_REPAIR',
] as const);
export type TaskType = (typeof TASK_TYPES)[number];

export const PROPOSAL_TYPES = Object.freeze([
  'MAP_OBJECT',
  'MAP_FIELD',
  'SELECT_SEMANTIC_TYPE',
  'APPLY_SUPPORTED_TRANSFORM',
  'MAP_ENUM_VALUE',
  'PROPOSE_IDENTITY_STRATEGY',
  'PROPOSE_DUPLICATE_SIGNAL',
  'MAP_ASSOCIATION',
  'UNMAPPED_PRESERVE',
  'BLOCKING_TARGET_REQUIREMENT',
  'NEEDS_AGENCY_DECISION',
  'ABSTAIN',
] as const);
export type ProposalType = (typeof PROPOSAL_TYPES)[number];

export const DATA_LEVELS = Object.freeze(['L0', 'L1', 'L2'] as const);
export type DataLevel = (typeof DATA_LEVELS)[number];

export const DATA_CLASSES = Object.freeze([
  'SAFE_STRUCTURAL_METADATA',
  'SAFE_LOW_CARDINALITY_SEMANTICS',
  'POTENTIAL_PII',
  'POTENTIAL_SECRET',
  'SENSITIVE_OR_RESTRICTED',
  'FREE_TEXT',
  'UNKNOWN',
] as const);
export type DataClass = (typeof DATA_CLASSES)[number];

export const EXEMPLAR_SELECTION_REASONS = Object.freeze(['SHAPE_CLASS_REPRESENTATIVE', 'RARE_VALUE', 'AMBIGUOUS_SHAPE', 'ENUM_MEMBER', 'OUTLIER_LENGTH'] as const);
export type ExemplarSelectionReason = (typeof EXEMPLAR_SELECTION_REASONS)[number];

/** A fact about a source field, as the profile states it — never recomputed here. */
export interface SourceFieldFact {
  readonly fieldRef: string;
  readonly fileId: string;
  readonly sheet: string | null;
  readonly header: string;
  readonly rowCount: number;
  readonly nonEmptyCount: number;
  readonly distinctCount: number | null;
  readonly uniqueAmongNonEmpty: boolean | null;
  readonly shapeCandidates: readonly string[];
  readonly lengthMin: number | null;
  readonly lengthMax: number | null;
  readonly evidenceRefs: readonly string[];
}

export interface SourceProfileView {
  readonly sourceProfileVersion: string;
  readonly profileHash: string;
  readonly bundleId: string;
  /** Data rows across the whole bundle, from the profile's totals: the coverage a full validation must reach. */
  readonly dataRowCount: number;
  readonly fields: readonly SourceFieldFact[];
}

export interface TargetFieldView {
  readonly targetRef: string;
  readonly objectApiName: string;
  readonly apiName: string;
  readonly label: string;
  readonly type: string;
  readonly createable: boolean;
  readonly updateable: boolean;
  readonly required: boolean;
  readonly unique: boolean;
  readonly options: readonly string[];
}

export interface TargetContractView {
  readonly targetContractVersion: string;
  readonly contractHash: string;
  readonly mode: 'HUBSPOT' | 'SALESFORCE';
  readonly instanceId: string;
  readonly fields: readonly TargetFieldView[];
  readonly relationshipTypes: readonly string[];
}

/** CLEAN_ONLY addresses no vendor: its output contract is Migration Core's own. */
export interface CleanOnlyContractView {
  readonly mode: 'CLEAN_ONLY';
  readonly canonicalFields: readonly string[];
  readonly relationshipTypes: readonly string[];
}

export interface DeterministicCandidate {
  readonly candidateRef: string;
  readonly candidateType: string;
  readonly sourceRefs: readonly string[];
  readonly allowedTargetRefs: readonly string[];
  readonly allowedPrimitiveRefs: readonly string[];
  /**
   * For a candidate that offers a primitive with a parameter
   * (NORMALISE_NUMBER, PARSE_DATE_ISO, PARSE_PHONE_E164), the values each
   * parameter may take by the evidence the resolver found — a separator by
   * the full-data shapes, a date format or a region by the project's
   * declared locale evidence — each from its closed domain; an empty list
   * when nothing evidences one (D3-CAP-04). Absent on every other candidate.
   */
  readonly allowedParamValues?: Readonly<Record<string, readonly string[]>>;
  readonly evidenceRefs: readonly string[];
  readonly impactCounts: { readonly rows: number; readonly distinct: number | null };
  readonly constraints: { readonly destructiveAllowed: false; readonly identityAutoMergeAllowed: false };
  /** How this candidate relates to Migration Core's set: the set's own ref, or the ref it was derived from by the resolver. */
  readonly derivedFrom: { readonly candidateSetHash: string; readonly candidateRef: string | null; readonly rule: string };
}

/**
 * The candidate types the resolver derives for the value-level families:
 * the parameter a mapped column's destination needs (TRANSFORMATION_SELECTION,
 * D3-CAP-04), one source value of an ENUM column (VALUE_MAP, D3-CAP-05) and
 * one plausible column for a required target no decision satisfies
 * (TARGET_REQUIREMENT, D3-CAP-10).
 */
export const TRANSFORM_CANDIDATE_TYPE = 'DERIVED_TRANSFORM_DECISION';
export const VALUE_CANDIDATE_TYPE = 'DERIVED_VALUE_DECISION';
export const REQUIREMENT_CANDIDATE_TYPE = 'DERIVED_REQUIREMENT_DECISION';

/**
 * The candidate types the resolver derives for the identity families
 * (B03-CAP-IDENTITY): one identity column of a record mapping
 * (IDENTITY_STRATEGY, D3-CAP-06), the duplicate clusters Migration Core
 * reported over a set of files (DUPLICATE_SIGNAL_STRATEGY, D3-CAP-07), and
 * one key column naming another object (ASSOCIATION_MAPPING, D3-CAP-08).
 */
export const IDENTITY_CANDIDATE_TYPE = 'DERIVED_IDENTITY_DECISION';
export const DUPLICATE_CANDIDATE_TYPE = 'DERIVED_DUPLICATE_DECISION';
export const ASSOCIATION_CANDIDATE_TYPE = 'DERIVED_ASSOCIATION_DECISION';

/**
 * One association an ASSOCIATION_MAPPING candidate may name (D3-CAP-08):
 * refs and closed codes only, no text. The key column and the target's
 * declared record id column travel as field refs of the profile view, whose
 * headers the classifier reads like any other; the target record mapping
 * travels as the opaque ref of its record mapping id; the association ref is
 * derived from the three, so the envelope proves every one of its options.
 */
export interface AssociationTargetView {
  readonly associationRef: string;
  readonly keyFieldRef: string;
  readonly relationshipType: string;
  /** Which end of the relationship the rows carrying the key sit on. */
  readonly ownerSide: 'FROM' | 'TO';
  readonly targetObject: string;
  readonly targetRecordRef: string;
  /** The target record mapping's declared record id column: the endpoint the key's values name. */
  readonly targetIdFieldRef: string;
}

export interface MemoryEvidenceItem {
  readonly memoryId: string;
  readonly scope: 'CLIENT' | 'AGENCY' | 'GLOBAL';
  readonly knowledgeType: string;
  readonly rule: { readonly sourceHeaderPattern: string; readonly targetRef: string | null; readonly semanticType: string | null };
  readonly verificationOutcome: string;
  readonly weight: number;
  readonly status: 'ACTIVE';
}

export interface Exemplar {
  readonly exemplarRef: string;
  readonly dataLevel: DataLevel;
  readonly fieldRef: string;
  readonly minimizedValueOrClass: string;
  readonly selectionReasonCode: ExemplarSelectionReason;
  readonly maskingPolicyVersion: string;
  readonly dataClass: DataClass;
}

/**
 * The canonical objects an object ref can stand for (D3-CAP-01): Migration
 * Core's own object vocabulary, constants of the frozen peer and never a
 * channel of anybody's data plane.
 */
export const OBJECT_NAMES = Object.freeze(['CONTACT', 'COMPANY', 'DEAL', 'LEAD'] as const);

/** One object the support envelope delivers, as an OBJECT_MAPPING candidate may name it: its ref and its canonical name. */
export interface ObjectTargetView {
  readonly objectRef: string;
  readonly object: string;
}

/**
 * The file-level facts of one object for one OBJECT_MAPPING candidate
 * (D3-CAP-01), counted over the candidate's own columns by this core: how many
 * headers name a field of the object, how many columns have a full-data shape
 * a writable field of the object can hold, and how many verified memory
 * entries point a header of the file at a field of the object. Counts only:
 * no header, value or name of the file travels in them.
 */
export interface ObjectFactView {
  readonly candidateRef: string;
  readonly objectRef: string;
  readonly headerMatches: number;
  readonly shapeHolds: number;
  readonly memoryMatches: number;
}

/**
 * The contradictions the consistency review names (D3-CAP-11): two claims in
 * one output scope; a semantic type, a transformation or a value map that
 * disagrees with the type of the field it lands on; an association key also
 * mapped as a field or used as identity; a required target satisfied by a
 * column another decision preserves.
 */
export const CONTRADICTION_KINDS = Object.freeze(['SAME_SCOPE_TARGET', 'TYPE_AGAINST_TRANSFORM', 'ASSOCIATION_KEY_REUSED', 'REQUIRED_TARGET_PRESERVED'] as const);
export type ContradictionKind = (typeof CONTRADICTION_KINDS)[number];

/** The candidate type of a CONSISTENCY_REVIEW candidate: one contradiction, naming its claims by decision ref. */
export const REVIEW_CANDIDATE_TYPE = 'DERIVED_CONSISTENCY_REVIEW';

/** Where a claim a review names came from: the resolver's facts, or the model's proposal the compiler accepted. */
export const CLAIM_ORIGINS = Object.freeze(['DETERMINISTIC', 'PROPOSED'] as const);

/**
 * One claim of a review candidate (D3-CAP-11): the decision by its ref, its
 * origin and the evidence class the compiler computed from the facts, the
 * column it reads and the contract target it claims (null for a claim that
 * names none: a preserve, an identity, an association). Refs and closed codes
 * only; the review's only answer that changes anything names one of these
 * decisions.
 */
export interface ReviewClaimView {
  readonly candidateRef: string;
  readonly kind: ContradictionKind;
  readonly decisionRef: string;
  readonly origin: (typeof CLAIM_ORIGINS)[number];
  readonly evidenceClass: EvidenceClass;
  readonly fieldRef: string;
  readonly targetRef: string | null;
}

export interface EnvelopeConstraints {
  readonly allowedProposalTypes: readonly ProposalType[];
  readonly allowedTargetIds: readonly string[];
  readonly supportedTransformPrimitives: readonly string[];
  readonly allowedAssociationTypes: readonly string[];
  readonly destructiveAllowed: false;
  readonly identityAutoMergeAllowed: false;
  readonly maxItems: number;
  readonly maxRationaleLength: number;
  readonly dataPolicyVersion: string;
}

export interface BudgetSnapshot {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly remainingBilledInputTokens: number;
  readonly remainingBilledOutputTokens: number;
  readonly remainingTasks: number;
  readonly deadlineAt: string;
}

export interface RepairContext {
  readonly previousProposalDigest: string;
  readonly validationCodes: readonly string[];
  readonly allowedValues: readonly string[];
  readonly allowedTargetRefs: readonly string[];
}

export interface IntelligenceEnvelopeV1 {
  readonly schemaVersion: string;
  readonly taskId: string;
  readonly taskType: TaskType;
  readonly projectRevisionId: string;
  readonly projectRevisionHash: string;
  readonly supportEnvelopeVersion: string;
  readonly vendorContractVersion: string | null;
  readonly sourceProfileHash: string;
  readonly candidateSetHash: string;
  readonly targetContractHash: string | null;
  readonly sourceProfile: SourceProfileView;
  readonly targetContract: TargetContractView | CleanOnlyContractView;
  readonly deterministicCandidates: readonly DeterministicCandidate[];
  /** The objects the task's candidates may name by object ref (OBJECT_MAPPING, D3-CAP-01); empty for every other task. */
  readonly objectTargets: readonly ObjectTargetView[];
  /** The file-level facts per object candidate and object; empty for every other task. */
  readonly objectFacts: readonly ObjectFactView[];
  /** The associations the task's candidates may name by association ref (ASSOCIATION_MAPPING, D3-CAP-08); empty for every other task. */
  readonly associationTargets: readonly AssociationTargetView[];
  /** The claims each CONSISTENCY_REVIEW candidate names (D3-CAP-11); empty for every other task. */
  readonly reviewClaims: readonly ReviewClaimView[];
  readonly memoryEvidence: readonly MemoryEvidenceItem[];
  readonly exemplars: readonly Exemplar[];
  readonly constraints: EnvelopeConstraints;
  readonly budgetSnapshot: BudgetSnapshot;
  readonly repairContext: RepairContext | null;
}

const ref = s.string({ pattern: REF_PATTERN, maxLength: 64 });
const hex64 = s.string({ pattern: HEX64_PATTERN });
const contractHash = s.string({ pattern: CONTRACT_HASH_PATTERN });
const identifier = s.string({ pattern: IDENTIFIER_PATTERN });
const shortText = s.string({ maxLength: 256 });
const counter = s.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });

const fieldFactSchema = s.object({
  fieldRef: ref,
  fileId: identifier,
  sheet: s.nullable(identifier),
  header: s.string({ maxLength: 512 }),
  rowCount: counter,
  nonEmptyCount: counter,
  distinctCount: s.nullable(counter),
  uniqueAmongNonEmpty: s.nullable(s.boolean()),
  shapeCandidates: s.array(identifier, { maxItems: 16, unique: true }),
  lengthMin: s.nullable(counter),
  lengthMax: s.nullable(counter),
  evidenceRefs: s.array(ref, { maxItems: 32, unique: true }),
});

const targetFieldSchema = s.object({
  targetRef: ref,
  objectApiName: identifier,
  apiName: identifier,
  label: shortText,
  type: identifier,
  createable: s.boolean(),
  updateable: s.boolean(),
  required: s.boolean(),
  unique: s.boolean(),
  options: s.array(s.string({ maxLength: 256 }), { maxItems: 2048 }),
});

const targetContractSchema = s.oneOf([
  s.object({
    targetContractVersion: s.string({ pattern: VERSION_PATTERN }),
    contractHash: contractHash,
    mode: s.enumOf(['HUBSPOT', 'SALESFORCE']),
    instanceId: identifier,
    fields: s.array(targetFieldSchema, { maxItems: 4096 }),
    relationshipTypes: s.array(identifier, { maxItems: 16, unique: true }),
  }),
  s.object({
    mode: s.literal('CLEAN_ONLY'),
    canonicalFields: s.array(identifier, { maxItems: 512, unique: true }),
    relationshipTypes: s.array(identifier, { maxItems: 16, unique: true }),
  }),
]);

const candidateSchema = s.object(
  {
    candidateRef: ref,
    candidateType: identifier,
    sourceRefs: s.array(ref, { maxItems: 64, unique: true }),
    allowedTargetRefs: s.array(ref, { maxItems: 512, unique: true }),
    allowedPrimitiveRefs: s.array(identifier, { maxItems: 32, unique: true }),
    allowedParamValues: s.record(s.array(s.string({ maxLength: 32 }), { maxItems: 16, unique: true }), { keyPattern: /^[a-zA-Z][a-zA-Z0-9]{0,31}$/u, maxKeys: 4 }),
    evidenceRefs: s.array(ref, { maxItems: 64, unique: true }),
    impactCounts: s.object({ rows: counter, distinct: s.nullable(counter) }),
    constraints: s.object({ destructiveAllowed: s.literal(false), identityAutoMergeAllowed: s.literal(false) }),
    derivedFrom: s.object({ candidateSetHash: contractHash, candidateRef: s.nullable(ref), rule: identifier }),
  },
  ['allowedParamValues'],
);

const memoryEvidenceSchema = s.object({
  memoryId: ref,
  scope: s.enumOf(['CLIENT', 'AGENCY', 'GLOBAL']),
  knowledgeType: identifier,
  rule: s.object({ sourceHeaderPattern: s.string({ maxLength: 256 }), targetRef: s.nullable(ref), semanticType: s.nullable(identifier) }),
  verificationOutcome: identifier,
  weight: s.number({ min: 0, max: 1 }),
  status: s.literal('ACTIVE'),
});

const exemplarSchema = s.object({
  exemplarRef: ref,
  dataLevel: s.enumOf([...DATA_LEVELS]),
  fieldRef: ref,
  minimizedValueOrClass: s.string({ maxLength: 128 }),
  selectionReasonCode: s.enumOf([...EXEMPLAR_SELECTION_REASONS]),
  maskingPolicyVersion: s.string({ pattern: VERSION_PATTERN }),
  dataClass: s.enumOf(['SAFE_STRUCTURAL_METADATA', 'SAFE_LOW_CARDINALITY_SEMANTICS']),
});

export const ENVELOPE_SCHEMA: Schema = s.object({
  schemaVersion: s.literal(ENVELOPE_SCHEMA_VERSION),
  taskId: ref,
  taskType: s.enumOf([...TASK_TYPES]),
  projectRevisionId: identifier,
  projectRevisionHash: hex64,
  supportEnvelopeVersion: s.string({ pattern: VERSION_PATTERN }),
  vendorContractVersion: s.nullable(s.string({ pattern: VERSION_PATTERN })),
  sourceProfileHash: contractHash,
  candidateSetHash: contractHash,
  targetContractHash: s.nullable(contractHash),
  sourceProfile: s.object({
    sourceProfileVersion: s.string({ pattern: VERSION_PATTERN }),
    profileHash: contractHash,
    bundleId: identifier,
    dataRowCount: counter,
    fields: s.array(fieldFactSchema, { maxItems: 4096 }),
  }),
  targetContract: targetContractSchema,
  deterministicCandidates: s.array(candidateSchema, { maxItems: 512 }),
  objectTargets: s.array(s.object({ objectRef: ref, object: s.enumOf([...OBJECT_NAMES]) }), { maxItems: OBJECT_NAMES.length }),
  objectFacts: s.array(s.object({ candidateRef: ref, objectRef: ref, headerMatches: counter, shapeHolds: counter, memoryMatches: counter }), { maxItems: 512 * OBJECT_NAMES.length }),
  associationTargets: s.array(
    s.object({ associationRef: ref, keyFieldRef: ref, relationshipType: s.enumOf([...RELATIONSHIP_TYPES]), ownerSide: s.enumOf(['FROM', 'TO']), targetObject: s.enumOf([...CANONICAL_OBJECTS]), targetRecordRef: ref, targetIdFieldRef: ref }),
    { maxItems: 512 },
  ),
  // The compiler's evidence classes (EVIDENCE_CLASSES of proposal.ts, which reads this module), spelled out.
  reviewClaims: s.array(s.object({ candidateRef: ref, kind: s.enumOf([...CONTRADICTION_KINDS]), decisionRef: ref, origin: s.enumOf([...CLAIM_ORIGINS]), evidenceClass: s.enumOf(['STRONG', 'SUPPORTED', 'AMBIGUOUS', 'INSUFFICIENT']), fieldRef: ref, targetRef: s.nullable(ref) }), { maxItems: 512 }),
  memoryEvidence: s.array(memoryEvidenceSchema, { maxItems: 64 }),
  exemplars: s.array(exemplarSchema, { maxItems: 256 }),
  constraints: s.object({
    allowedProposalTypes: s.array(s.enumOf([...PROPOSAL_TYPES]), { minItems: 1, unique: true }),
    allowedTargetIds: s.array(ref, { maxItems: 4096, unique: true }),
    supportedTransformPrimitives: s.array(identifier, { maxItems: 64, unique: true }),
    allowedAssociationTypes: s.array(identifier, { maxItems: 16, unique: true }),
    destructiveAllowed: s.literal(false),
    identityAutoMergeAllowed: s.literal(false),
    maxItems: s.integer({ min: 1, max: 512 }),
    maxRationaleLength: s.integer({ min: 16, max: 512 }),
    dataPolicyVersion: s.string({ pattern: VERSION_PATTERN }),
  }),
  budgetSnapshot: s.object({
    maxInputTokens: s.integer({ min: 1 }),
    maxOutputTokens: s.integer({ min: 1 }),
    remainingBilledInputTokens: counter,
    remainingBilledOutputTokens: counter,
    remainingTasks: counter,
    deadlineAt: s.string({ pattern: INSTANT_PATTERN }),
  }),
  repairContext: s.nullable(
    s.object({
      previousProposalDigest: hex64,
      validationCodes: s.array(identifier, { minItems: 1, maxItems: 64 }),
      allowedValues: s.array(s.string({ maxLength: 256 }), { maxItems: 2048 }),
      allowedTargetRefs: s.array(ref, { maxItems: 512 }),
    }),
  ),
});

/** Structural problems plus the referential ones a schema cannot state. */
export function envelopeProblems(envelope: unknown): readonly SchemaProblem[] {
  const problems = [...validate(envelope, ENVELOPE_SCHEMA)];
  if (problems.length > 0) return problems;
  const value = envelope as IntelligenceEnvelopeV1;
  const fieldRefs = new Set(value.sourceProfile.fields.map((field) => field.fieldRef));
  // An object ref is a target an OBJECT_MAPPING candidate may name, beside the contract's fields, when the envelope says which object it is (D3-CAP-01).
  const objectRefs = new Set(value.objectTargets.map((target) => target.objectRef));
  // An association ref is a target an ASSOCIATION_MAPPING candidate may name, beside the contract's fields, when the envelope says which association it is (D3-CAP-08).
  const associationRefs = new Set(value.associationTargets.map((target) => target.associationRef));
  const targetRefs = new Set([...(value.targetContract.mode === 'CLEAN_ONLY' ? value.targetContract.canonicalFields.map((name) => cleanOnlyTargetRef(name)) : value.targetContract.fields.map((field) => field.targetRef)), ...objectRefs, ...associationRefs]);
  value.objectTargets.forEach((target, index) => {
    if (target.objectRef !== objectRefOf(value.targetContract.mode, target.object)) problems.push({ pointer: `/objectTargets/${String(index)}/objectRef`, message: 'is not the ref of its object in this mode' });
  });
  value.associationTargets.forEach((target, index) => {
    const at = `/associationTargets/${String(index)}`;
    if (target.associationRef !== associationRefOf(target.keyFieldRef, target.relationshipType, target.targetRecordRef)) problems.push({ pointer: `${at}/associationRef`, message: 'is not the ref of its key column, relationship and target record mapping' });
    if (!fieldRefs.has(target.keyFieldRef)) problems.push({ pointer: `${at}/keyFieldRef`, message: 'names a field the profile view does not carry' });
    if (!fieldRefs.has(target.targetIdFieldRef)) problems.push({ pointer: `${at}/targetIdFieldRef`, message: 'names a field the profile view does not carry' });
    if (!value.constraints.allowedAssociationTypes.includes(target.relationshipType)) problems.push({ pointer: `${at}/relationshipType`, message: 'outside constraints.allowedAssociationTypes' });
  });
  // A review candidate names decisions, not targets (D3-CAP-11): the decisions of its own claims, and nothing else.
  const decisionsOf = new Map<string, Set<string>>();
  for (const claim of value.reviewClaims) decisionsOf.set(claim.candidateRef, (decisionsOf.get(claim.candidateRef) ?? new Set()).add(claim.decisionRef));
  const candidateRefs = new Set<string>();
  value.deterministicCandidates.forEach((candidate, index) => {
    if (candidateRefs.has(candidate.candidateRef)) problems.push({ pointer: `/deterministicCandidates/${String(index)}/candidateRef`, message: 'duplicate candidateRef' });
    candidateRefs.add(candidate.candidateRef);
    if (candidate.derivedFrom.candidateSetHash !== value.candidateSetHash) problems.push({ pointer: `/deterministicCandidates/${String(index)}/derivedFrom`, message: 'derived from another candidate set' });
    candidate.sourceRefs.forEach((sourceRef, at) => {
      if (!fieldRefs.has(sourceRef)) problems.push({ pointer: `/deterministicCandidates/${String(index)}/sourceRefs/${String(at)}`, message: 'names a field the profile view does not carry' });
    });
    const review = candidate.candidateType === REVIEW_CANDIDATE_TYPE;
    candidate.allowedTargetRefs.forEach((targetRef, at) => {
      if (review ? !(decisionsOf.get(candidate.candidateRef)?.has(targetRef) ?? false) : !targetRefs.has(targetRef)) problems.push({ pointer: `/deterministicCandidates/${String(index)}/allowedTargetRefs/${String(at)}`, message: review ? 'names a decision its review claims do not carry' : 'names a target the contract view does not carry' });
      if (!value.constraints.allowedTargetIds.includes(targetRef)) problems.push({ pointer: `/deterministicCandidates/${String(index)}/allowedTargetRefs/${String(at)}`, message: 'outside constraints.allowedTargetIds' });
    });
  });
  value.objectFacts.forEach((fact, index) => {
    if (!candidateRefs.has(fact.candidateRef)) problems.push({ pointer: `/objectFacts/${String(index)}/candidateRef`, message: 'names a candidate the envelope does not carry' });
    if (!objectRefs.has(fact.objectRef)) problems.push({ pointer: `/objectFacts/${String(index)}/objectRef`, message: 'names an object the envelope does not offer' });
  });
  const claimed = new Set<string>();
  value.reviewClaims.forEach((claim, index) => {
    if (!candidateRefs.has(claim.candidateRef) || value.deterministicCandidates.find((candidate) => candidate.candidateRef === claim.candidateRef)?.candidateType !== REVIEW_CANDIDATE_TYPE) problems.push({ pointer: `/reviewClaims/${String(index)}/candidateRef`, message: 'names no review candidate the envelope carries' });
    if (!fieldRefs.has(claim.fieldRef)) problems.push({ pointer: `/reviewClaims/${String(index)}/fieldRef`, message: 'names a field the profile view does not carry' });
    if (claim.targetRef !== null && !targetRefs.has(claim.targetRef)) problems.push({ pointer: `/reviewClaims/${String(index)}/targetRef`, message: 'names a target the contract view does not carry' });
    if (claimed.has(`${claim.candidateRef}|${claim.decisionRef}`)) problems.push({ pointer: `/reviewClaims/${String(index)}/decisionRef`, message: 'the candidate names this decision twice' });
    claimed.add(`${claim.candidateRef}|${claim.decisionRef}`);
  });
  value.exemplars.forEach((exemplar, index) => {
    if (!fieldRefs.has(exemplar.fieldRef)) problems.push({ pointer: `/exemplars/${String(index)}/fieldRef`, message: 'names a field the profile view does not carry' });
  });
  const decisionRefs = new Set(value.reviewClaims.map((claim) => claim.decisionRef));
  value.constraints.allowedTargetIds.forEach((targetRef, index) => {
    if (!targetRefs.has(targetRef) && !decisionRefs.has(targetRef)) problems.push({ pointer: `/constraints/allowedTargetIds/${String(index)}`, message: 'names a target the contract view does not carry' });
  });
  if (value.targetContract.mode === 'CLEAN_ONLY') {
    if (value.targetContractHash !== null) problems.push({ pointer: '/targetContractHash', message: 'CLEAN_ONLY addresses no vendor instance and carries no target contract hash' });
    if (value.vendorContractVersion !== null) problems.push({ pointer: '/vendorContractVersion', message: 'CLEAN_ONLY carries no vendor contract version' });
  } else {
    if (value.targetContractHash !== value.targetContract.contractHash) problems.push({ pointer: '/targetContractHash', message: 'does not match the contract view' });
    if (value.vendorContractVersion !== value.targetContract.targetContractVersion) problems.push({ pointer: '/vendorContractVersion', message: 'does not match the contract view' });
  }
  if (value.sourceProfileHash !== value.sourceProfile.profileHash) problems.push({ pointer: '/sourceProfileHash', message: 'does not match the profile view' });
  if (value.taskType === 'SEMANTIC_REPAIR' && value.repairContext === null) problems.push({ pointer: '/repairContext', message: 'a repair task carries its repair context' });
  if (value.taskType !== 'SEMANTIC_REPAIR' && value.repairContext !== null) problems.push({ pointer: '/repairContext', message: 'only a repair task carries a repair context' });
  return problems;
}

export function cleanOnlyTargetRef(canonicalField: string): string {
  // A CLEAN_ONLY target is a canonical field of Migration Core's own output
  // contract; its ref is derived from the name so it is stable and closed.
  return `tgt_${digestOf(`CLEAN_ONLY:${canonicalField}`).slice(0, 16)}`;
}

/**
 * The ref an object of the support envelope is named by (D3-CAP-01):
 * derived from the mode and the canonical object alone, so it is stable,
 * closed and carries no text of anybody's data.
 */
export function objectRefOf(mode: string, object: string): string {
  return `obj_${digestOf(`${mode}:${object}`).slice(0, 16)}`;
}

/**
 * The opaque ref a record mapping travels by (D3-CAP-08): derived from its id
 * — the file's Migration Core id, a digest of its bytes, and the canonical
 * object — never from a path or a name the file was given.
 */
export function recordRefOf(recordMappingId: string): string {
  return `rec_${digestOf(`record-mapping:${recordMappingId}`).slice(0, 16)}`;
}

/** The ref of one association (D3-CAP-08): its key column, its relationship and its target record mapping, by their refs. */
export function associationRefOf(keyFieldRef: string, relationshipType: string, targetRecordRef: string): string {
  return `assoc_${digestOf(['association', keyFieldRef, relationshipType, targetRecordRef]).slice(0, 16)}`;
}

export function envelopeHash(envelope: IntelligenceEnvelopeV1): string {
  return digestOf(envelope);
}
