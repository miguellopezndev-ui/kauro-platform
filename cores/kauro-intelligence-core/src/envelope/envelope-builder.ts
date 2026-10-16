/**
 * Minimizer, Envelope Builder and Egress decision, canon §16–§21.
 *
 * The minimizer turns what the host supplied into exemplars a task may see:
 * L0 structural facts always; L1 low-cardinality safe values only after the
 * classifier passed them; L2 masked shapes only when the task materially
 * needs one and the value is neither personal, secret nor sensitive; never
 * L3 or L4. Every value of a column is classified before any is selected —
 * a clean sample never authorises the column — and selection among what
 * passed is by class: one exemplar per shape class, rare and ambiguous
 * shapes included, never the first N.
 *
 * Every other text channel of the envelope — headers, file ids, target
 * labels, api names, options, memory patterns, repair codes — goes through
 * the same classifier; what fails travels as a token keyed by the run's
 * egress secret, never as text, and the class is recorded against the ref.
 *
 * The egress decision is reproducible and bound: it names the envelope hash,
 * the classes it saw and the levels it allowed, it re-reads the envelope's
 * text channels and exemplar values rather than trusting the builder, and it carries a token
 * derived from a secret only the kernel holds, so a caller cannot forge
 * EGRESS_ALLOWED and the gateway path refuses an envelope whose hash is not
 * the one the decision was taken over.
 */
import { createHmac } from 'node:crypto';

import type { AdaptedContracts } from '../adapter/contract-adapter.js';
import { classifyMetadataText, classifyValue, fieldMayNamePeople, fieldNamesPeople, maskShape, optionListNamesPeople, vocabularyHomonym } from '../classifier/data-classifier.js';
import type { Classification, MetadataKind } from '../classifier/data-classifier.js';
import { digestOf } from '../contracts/canonical.js';
import { ASSOCIATION_CANDIDATE_TYPE, VALUE_CANDIDATE_TYPE, associationRefOf, envelopeHash, envelopeProblems } from '../contracts/envelope.js';
import type { AssociationTargetView, BudgetSnapshot, CleanOnlyContractView, DataClass, DeterministicCandidate, Exemplar, IntelligenceEnvelopeV1, MemoryEvidenceItem, ObjectFactView, ObjectTargetView, ProposalType, RepairContext, ReviewClaimView, SourceFieldFact, SourceProfileView, TargetContractView, TaskType } from '../contracts/envelope.js';
import { IntelligenceError } from '../contracts/errors.js';
import { PRIMITIVE_REFS } from '../contracts/proposal.js';
import { paramValueInDomain } from '../compiler/parameter-evidence.js';
import type { TaskRecord } from '../contracts/run.js';
import { ENVELOPE_SCHEMA_VERSION } from '../contracts/versions.js';
import { DERIVED_CANDIDATE_TYPES, objectFactsOf, supportedObjects } from '../resolver/deterministic-resolver.js';
import type { ResolvedDecision } from '../resolver/deterministic-resolver.js';
import { associationOptionOf, offeredRelationshipTypes } from '../resolver/identity-families.js';

/**
 * 1.1.0: metadata is classified like values and masked when it fails; a
 * column is classified whole before any exemplar is chosen. 1.2.0: a mask
 * folds every script; mask tokens are keyed by the run's egress secret;
 * only redacted options vouch for a value; the egress decision re-reads
 * exemplar values. Data policy 1.3.0 (round 3, R2-PC-01): an option travels
 * only when it is provably an enumeration token — a single word no
 * vocabulary knows is a proper noun under any label — and Georgian is a
 * caseless script; the masking rules did not change. Data policy 1.4.0
 * (round 4, R2R-PC-01..03): a two- or three-letter upper-case token is a
 * code only when the closed ISO 3166/4217 lists know it, a digit-bearing
 * token is a code only in capitals or as a vocabulary word beside a number
 * and a user handle is not, and a vocabulary word that is also a surname is
 * the surname in a list that holds a name or under a label that may name
 * people; the masking rules did not change. Data policy 1.5.0 (revision 009,
 * R-IC-PRIVACY): a token that carries a digit is a code only when every
 * letter run of it is known — a single Latin letter, a closed compact prefix
 * or a vocabulary word — and a handle otherwise, POTENTIAL_PII on every
 * channel; neither capitals, nor a digit majority, nor two-to-three capitals
 * before a separator, nor an attested option list authorises one. Masking
 * policy 1.3.0 (revision 009): a mask token is keyed by the run's egress
 * secret bound to the agency, the client, the project revision and the
 * profile, so equal text in equal scope shares a token and any change of
 * scope or key separates the references; the tokens' shape did not change.
 * Data policy 1.5.1 (revision 009b, after the independent review): a hump of
 * one letter inside a camel run is not a symbol (nG1, wU99, yN1 are handles)
 * and no length keeps a handle from the rule (a ninety-seven-character
 * handle is a handle, never free text); the masking rules did not change.
 * Data policy 1.6.0 (WO-IC-PRIVACY-20260915-01, the consolidation of 009):
 * on the LABEL and IDENTIFIER channels no shape admits a token on its own —
 * not an acronym of two to six capitals (SMITH was structural in capitals
 * and a name in title case), not a snake, kebab, dotted, camel or Pascal
 * join (OkonkwoNdebele, Okonkwo_Ndebele), not the vendor suffix
 * (Okonkwo__c) and not the identifier grammar (Okonkwo was an identifier in
 * every case): a piece is known by the closed lists, or as a lower-case word
 * on the IDENTIFIER channel only, or as a word in capitals inside a compound
 * constant; a title-case piece outside every vocabulary is a proper noun and
 * POTENTIAL_PII, a bare word in capitals outside every list is UNKNOWN. The
 * OPTION channel, classifyValue and the masking rules did not change.
 * Data policy 1.7.0 (the privacy repair of B03): case admits nothing on the
 * IDENTIFIER channel either — a lower-case word is known only as a word or a
 * concatenation of words of the vocabulary (lifecyclestage), a piece in
 * capitals only as a word of the code vocabulary (INVALID_SCHEMA); a value
 * joined by underscores around an unknown piece (ondriel_vaskemar,
 * pelsira__c) or a proper noun joined into a compound (Pelsira__c) is
 * personal, not UNKNOWN, so its column is withheld and its task still
 * leaves; and a value its target lists among options refused as people is a
 * person. Masking policy 1.4.0: the attempt is part of the scope an opaque
 * reference is keyed to, so unrelated attempts never share one.
 */
export const MASKING_POLICY_VERSION = '1.4.0';
export const DATA_POLICY_VERSION = '1.7.0';
export const MAX_EXEMPLARS_PER_FIELD = 6;

export type EgressDecisionKind = 'EGRESS_ALLOWED' | 'EGRESS_BLOCKED_POLICY' | 'EGRESS_BLOCKED_SECRET' | 'EGRESS_BLOCKED_UNKNOWN' | 'EGRESS_BLOCKED_BUDGET';

export interface EgressDecision {
  readonly decision: EgressDecisionKind;
  readonly envelopeHash: string;
  readonly taskId: string;
  readonly maxDataLevel: 'L0' | 'L1' | 'L2';
  readonly classesSeen: readonly DataClass[];
  readonly blockedReasons: readonly string[];
  /** HMAC over the decision's fields with the run's egress secret; verified by the gateway path. */
  readonly token: string;
}

/** Values the host extracted for low-cardinality columns; the only path a value has into this core. */
export type CategoricalSummaries = ReadonlyMap<string, readonly string[]>;

export interface MinimizationReport {
  readonly exemplars: readonly Exemplar[];
  readonly classesSeen: readonly DataClass[];
  /** What did not travel and why: fieldRef is the ref of the channel — a field, a target, a memory entry — never its text. */
  readonly blocked: readonly { fieldRef: string; dataClass: DataClass; reason: string }[];
  readonly maxDataLevel: 'L0' | 'L1' | 'L2';
}

const TASK_ALLOWED_TYPES: Readonly<Record<TaskType, readonly ProposalType[]>> = {
  // B03-CAP-STRUCTURE: the object of a tied file is the model's to propose among the object refs the support envelope delivers, on facts the compiler checks (D3-CAP-01); a field's target inside its record mapping (D3-CAP-02); the type of a column mapped on facts (D3-CAP-03); the preservation of a column no target can hold, where exclusion is only the agency's (D3-CAP-09).
  OBJECT_MAPPING: ['MAP_OBJECT', 'NEEDS_AGENCY_DECISION', 'ABSTAIN'],
  FIELD_MAPPING: ['MAP_FIELD', 'UNMAPPED_PRESERVE', 'NEEDS_AGENCY_DECISION', 'ABSTAIN'],
  SEMANTIC_TYPE: ['SELECT_SEMANTIC_TYPE', 'NEEDS_AGENCY_DECISION', 'ABSTAIN'],
  // D3-CAP-04, D3-CAP-05, D3-CAP-10: a transformation, a value map and a requirement are answered, asked to the agency or abstained from; none of them preserves a column, which its own field-level family decides.
  TRANSFORMATION_SELECTION: ['APPLY_SUPPORTED_TRANSFORM', 'NEEDS_AGENCY_DECISION', 'ABSTAIN'],
  VALUE_MAP: ['MAP_ENUM_VALUE', 'NEEDS_AGENCY_DECISION', 'ABSTAIN'],
  IDENTITY_STRATEGY: ['PROPOSE_IDENTITY_STRATEGY', 'NEEDS_AGENCY_DECISION', 'ABSTAIN'],
  DUPLICATE_SIGNAL_STRATEGY: ['PROPOSE_DUPLICATE_SIGNAL', 'NEEDS_AGENCY_DECISION', 'ABSTAIN'],
  ASSOCIATION_MAPPING: ['MAP_ASSOCIATION', 'NEEDS_AGENCY_DECISION', 'ABSTAIN'],
  UNMAPPED_HANDLING: ['UNMAPPED_PRESERVE', 'NEEDS_AGENCY_DECISION', 'ABSTAIN'],
  TARGET_REQUIREMENT: ['MAP_FIELD', 'BLOCKING_TARGET_REQUIREMENT', 'NEEDS_AGENCY_DECISION', 'ABSTAIN'],
  // D3-CAP-11: a review preserves one named decision, asks the agency or abstains; it never maps.
  CONSISTENCY_REVIEW: ['UNMAPPED_PRESERVE', 'NEEDS_AGENCY_DECISION', 'ABSTAIN'],
  // D3-CAP-12: a repair round has no permissions of its own; it carries those of the task it repairs (allowedProposalTypesOf). Without that task, it may only ask the agency or abstain.
  SEMANTIC_REPAIR: ['NEEDS_AGENCY_DECISION', 'ABSTAIN'],
};

/**
 * The proposal types a task's envelope allows. A repair round carries
 * exactly the permissions of the task it repairs (D3-CAP-12) — the same set,
 * never a wider one — so an answer outside the original set is refused as
 * FORBIDDEN by the compiler, which checks against the envelope.
 */
export function allowedProposalTypesOf(taskType: TaskType, repairOf?: TaskType): readonly ProposalType[] {
  if (taskType !== 'SEMANTIC_REPAIR') return TASK_ALLOWED_TYPES[taskType];
  return repairOf === undefined || repairOf === 'SEMANTIC_REPAIR' ? TASK_ALLOWED_TYPES.SEMANTIC_REPAIR : TASK_ALLOWED_TYPES[repairOf];
}

/** Whether the task materially needs a masked shape; a mapping decides on facts, a value map or type decision may need a shape. */
const TASK_NEEDS_L2: ReadonlySet<TaskType> = new Set<TaskType>(['VALUE_MAP', 'SEMANTIC_TYPE', 'TRANSFORMATION_SELECTION', 'SEMANTIC_REPAIR']);

/**
 * The class of one option of a target field. Every option goes through the
 * OPTION channel of the classifier, where only a provable enumeration token
 * passes; a field whose label or api name says its values are people — an
 * owner, an assignee, a manager — holds names whatever they look like, and
 * no option of it passes at all. The label is a restriction on top of the
 * channel, never a permission: a label the person-field vocabulary does not
 * know (Comercial, Sales Rep, Менеджер) leaves the channel's verdict as it
 * is (R2-PC-01, R2-PC-06). One tie-break sits on top (R2R-PC-03): a word
 * that is at once enumeration vocabulary and a surname — Klein, Petit,
 * Price, Campos — is the surname when the list it stands in holds a name
 * the channel refused or the label over it may name people, and the word
 * only in a list of words under a label that does not.
 */
function classifyOption(field: { readonly label: string; readonly apiName: string; readonly options: readonly string[] }, option: string): Classification {
  const read = classifyMetadataText(option, 'OPTION');
  if (fieldNamesPeople(field.label, field.apiName)) return { dataClass: 'POTENTIAL_PII', reason: 'option of a field whose label names people', instructionLike: read.instructionLike };
  if (read.dataClass === 'SAFE_STRUCTURAL_METADATA' && vocabularyHomonym(option) && (fieldMayNamePeople(field.label, field.apiName) || listNamesPeople(field.options))) return { dataClass: 'POTENTIAL_PII', reason: 'vocabulary word that is also a family name, in a list that holds a name or under a label that may name people', instructionLike: read.instructionLike };
  return read;
}

/** Whether an option list names people, read once per list: the verdict is a property of the list, not of the option asked about. */
const listVerdicts = new WeakMap<readonly string[], boolean>();
function listNamesPeople(options: readonly string[]): boolean {
  const seen = listVerdicts.get(options);
  if (seen !== undefined) return seen;
  const verdict = optionListNamesPeople(options);
  listVerdicts.set(options, verdict);
  return verdict;
}

const vouches = (classification: Classification): boolean => classification.dataClass === 'SAFE_STRUCTURAL_METADATA' && !classification.instructionLike;

/**
 * The option lists of every target a field's candidates may name, redacted:
 * only an option that would itself travel in the target view is an authority
 * a value can be safe by. An option the OPTION channel refuses — a person's
 * name in an owner picklist — is dropped from the envelope and must not
 * vouch for the identical source value on its way there.
 */
function targetOptionsFor(fieldRef: string, contracts: AdaptedContracts, candidates: readonly DeterministicCandidate[]): readonly string[] {
  if (contracts.contractView.mode === 'CLEAN_ONLY') return [];
  const targetRefs = new Set(candidates.filter((candidate) => candidate.sourceRefs.includes(fieldRef)).flatMap((candidate) => candidate.allowedTargetRefs));
  return contracts.contractView.fields.filter((field) => targetRefs.has(field.targetRef)).flatMap((field) => field.options.filter((option) => vouches(classifyOption(field, option))));
}

/**
 * The options of the same targets the OPTION channel refused as people (data
 * policy 1.7.0): a value equal to one of them is that person, whatever the
 * value channel would make of its shape alone, and its column is withheld
 * whole. The option list tells the minimizer what it tells the redaction.
 */
function personalOptionsFor(fieldRef: string, contracts: AdaptedContracts, candidates: readonly DeterministicCandidate[]): readonly string[] {
  if (contracts.contractView.mode === 'CLEAN_ONLY') return [];
  const targetRefs = new Set(candidates.filter((candidate) => candidate.sourceRefs.includes(fieldRef)).flatMap((candidate) => candidate.allowedTargetRefs));
  return contracts.contractView.fields.filter((field) => targetRefs.has(field.targetRef)).flatMap((field) => field.options.filter((option) => classifyOption(field, option).dataClass === 'POTENTIAL_PII'));
}

/** The ref of the L1 exemplar of one value of a column: what a value candidate names its value by (D3-CAP-05). */
export const l1ExemplarRef = (fieldRef: string, value: string): string => `ex_${digestOf([fieldRef, 'L1', value]).slice(0, 16)}`;

/**
 * The values of a column that stand as value candidates of a VALUE_MAP
 * (D3-CAP-05): the host's summary of the column, each value read by the
 * classifier against the redacted options of the ENUM target the column is
 * mapped to, as the minimizer reads it for that task. Only a value the
 * classifier passes as L1 exists here, and only when every value of the
 * column does: one personal, unknown, secret, free-text or instruction-like
 * value and the column gives no candidate at all — a clean part never
 * authorises the column. Null when there is nothing to offer.
 */
export function valueCandidateValues(field: SourceFieldFact, contracts: AdaptedContracts, targetRef: string, summaries: CategoricalSummaries): readonly string[] | null {
  if (contracts.contractView.mode === 'CLEAN_ONLY') return null;
  const target = contracts.contractView.fields.find((entry) => entry.targetRef === targetRef);
  if (target === undefined || target.options.length === 0) return null;
  const locator = contracts.refs.fieldByRef.get(field.fieldRef)?.locator ?? '';
  const values = [...new Set(summaries.get(locator) ?? summaries.get(field.fieldRef) ?? [])];
  if (values.length === 0) return null;
  const context = { header: field.header, distinctCount: field.distinctCount, rowCount: field.rowCount, shapeCandidates: field.shapeCandidates, targetOptions: target.options.filter((option) => vouches(classifyOption(target, option))), personalOptions: target.options.filter((option) => classifyOption(target, option).dataClass === 'POTENTIAL_PII') };
  const l1 = values.filter((value) => {
    const read = classifyValue(value, context);
    return read.dataClass === 'SAFE_LOW_CARDINALITY_SEMANTICS' && !read.instructionLike;
  });
  // The whole column or nothing.
  return l1.length === values.length ? l1 : null;
}

export function minimize(task: TaskRecord, contracts: AdaptedContracts, candidates: readonly DeterministicCandidate[], summaries: CategoricalSummaries): MinimizationReport {
  const exemplars: Exemplar[] = [];
  const classes = new Set<DataClass>();
  const blocked: { fieldRef: string; dataClass: DataClass; reason: string }[] = [];
  let maxLevel: 'L0' | 'L1' | 'L2' = 'L0';
  const fieldRefs = new Set(candidates.flatMap((candidate) => candidate.sourceRefs));
  for (const field of contracts.profileView.fields) {
    if (!fieldRefs.has(field.fieldRef)) continue;
    const locator = contracts.refs.fieldByRef.get(field.fieldRef)?.locator ?? '';
    const values = summaries.get(locator) ?? summaries.get(field.fieldRef) ?? [];
    const targetOptions = targetOptionsFor(field.fieldRef, contracts, candidates);
    const personalOptions = personalOptionsFor(field.fieldRef, contracts, candidates);
    // Every value is classified before anything is selected or cut: the
    // column authorises itself or nothing from it travels. A clean first N
    // says nothing about the value that would have been the N+1th.
    const classified = values.map((value) => ({ value, shape: maskShape(value), classification: classifyValue(value, { header: field.header, distinctCount: field.distinctCount, rowCount: field.rowCount, shapeCandidates: field.shapeCandidates, targetOptions, personalOptions }) }));
    for (const entry of classified) classes.add(entry.classification.dataClass);
    // A field with a secret or restricted value among its values gives no
    // exemplar at all, not even its safe ones: a column that holds a token
    // once is a column nobody reasons about until somebody has looked. The
    // same for a personal or unclassifiable value: L3 and UNKNOWN close the
    // column, whichever position they held in the list.
    const contaminated = classified.some((entry) => entry.classification.dataClass === 'POTENTIAL_SECRET' || entry.classification.dataClass === 'SENSITIVE_OR_RESTRICTED');
    const personal = classified.some((entry) => entry.classification.dataClass === 'POTENTIAL_PII' || entry.classification.dataClass === 'UNKNOWN');
    if (contaminated || personal) {
      const failing = [...new Set(classified.map((entry) => entry.classification.dataClass))].filter((dataClass) => dataClass === 'POTENTIAL_SECRET' || dataClass === 'SENSITIVE_OR_RESTRICTED' || dataClass === 'POTENTIAL_PII' || dataClass === 'UNKNOWN').sort();
      for (const dataClass of failing) blocked.push({ fieldRef: field.fieldRef, dataClass, reason: contaminated ? 'the field holds a secret or restricted value; nothing from it travels' : 'the field holds a personal or unclassifiable value; nothing from it travels' });
      continue;
    }
    // A column the task asks value questions about (VALUE_MAP, D3-CAP-05)
    // shows every value it authorised, one L1 exemplar each: the value a
    // candidate stands for travels as that exemplar and nowhere else, and
    // the candidate names it by the exemplar's ref.
    const members = new Set<string>();
    if (candidates.some((candidate) => candidate.candidateType === VALUE_CANDIDATE_TYPE && candidate.sourceRefs.includes(field.fieldRef))) {
      for (const entry of classified) {
        if (entry.classification.dataClass !== 'SAFE_LOW_CARDINALITY_SEMANTICS' || entry.classification.instructionLike || members.has(entry.value)) continue;
        members.add(entry.value);
        exemplars.push({ exemplarRef: l1ExemplarRef(field.fieldRef, entry.value), dataLevel: 'L1', fieldRef: field.fieldRef, minimizedValueOrClass: entry.value.slice(0, 64), selectionReasonCode: 'ENUM_MEMBER', maskingPolicyVersion: MASKING_POLICY_VERSION, dataClass: 'SAFE_LOW_CARDINALITY_SEMANTICS' });
        if (maxLevel === 'L0') maxLevel = 'L1';
      }
    }
    // Deterministic selection by class among what passed: one exemplar per
    // masked shape, rarest first, then the low-cardinality vocabulary itself.
    const byShape = new Map<string, { value: string; count: number; classification: Classification }>();
    for (const entry of classified) {
      if (members.has(entry.value)) continue;
      const seen = byShape.get(entry.shape);
      if (seen === undefined) byShape.set(entry.shape, { value: entry.value, count: 1, classification: entry.classification });
      else seen.count += 1;
    }
    const ordered = [...byShape.entries()].sort((a, b) => a[1].count - b[1].count || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_EXEMPLARS_PER_FIELD);
    for (const [shape, { value, count, classification }] of ordered) {
      const reason = count === 1 ? 'RARE_VALUE' : 'SHAPE_CLASS_REPRESENTATIVE';
      if (classification.dataClass === 'SAFE_LOW_CARDINALITY_SEMANTICS' && !classification.instructionLike) {
        exemplars.push({ exemplarRef: `ex_${digestOf([field.fieldRef, 'L1', value]).slice(0, 16)}`, dataLevel: 'L1', fieldRef: field.fieldRef, minimizedValueOrClass: value.slice(0, 64), selectionReasonCode: reason, maskingPolicyVersion: MASKING_POLICY_VERSION, dataClass: 'SAFE_LOW_CARDINALITY_SEMANTICS' });
        if (maxLevel === 'L0') maxLevel = 'L1';
        continue;
      }
      if (classification.dataClass === 'FREE_TEXT' && TASK_NEEDS_L2.has(task.taskType) && !classification.instructionLike) {
        exemplars.push({ exemplarRef: `ex_${digestOf([field.fieldRef, 'L2', shape]).slice(0, 16)}`, dataLevel: 'L2', fieldRef: field.fieldRef, minimizedValueOrClass: shape, selectionReasonCode: 'AMBIGUOUS_SHAPE', maskingPolicyVersion: MASKING_POLICY_VERSION, dataClass: 'SAFE_STRUCTURAL_METADATA' });
        maxLevel = 'L2';
        continue;
      }
      // Free text a mapping does not need, or anything instruction-like:
      // never a value, never a shape. The shape *class name* from the
      // profile is L0 and already in the field facts.
      blocked.push({ fieldRef: field.fieldRef, dataClass: classification.dataClass, reason: classification.instructionLike ? 'reads as an instruction' : classification.reason });
    }
  }
  return { exemplars, classesSeen: [...classes].sort(), blocked, maxDataLevel: maxLevel };
}

/** The channels of metadata text an envelope carries, by the prefix their blocked entries use. */
const METADATA_CHANNEL = /^(?:header|file id|sheet|instance id|object api name|api name|target label|target type|target option|memory pattern|memory type|repair code|repair value): /u;

/** The scope an opaque reference is bound to: the tenant the host authenticated, the AuditAttempt the run is, and the project revision it is about. Read into the mask key only; none of it travels. */
export interface ReferenceScope {
  readonly tenant: { readonly agencyId: string; readonly clientId: string };
  readonly attemptId: string;
  readonly projectRevisionId: string;
  readonly projectRevisionHash: string;
}

/**
 * The key mask tokens are derived under: the run's egress secret bound to
 * the agency, the client, the attempt, the project revision and the profile
 * hash. The profile hash travels in the envelope; the tenant, the attempt and
 * the revision are folded into the HMAC and never written anywhere; the
 * secret never leaves the kernel. So a reader of the bytes cannot check a
 * guessed header against a token, equal texts of one attempt share a token —
 * every task, every repair round and every redelivery of the attempt — and a
 * token of one agency, client, attempt, revision or key is never the token
 * of another (R2-030): two unrelated attempts over the same value expose no
 * shared identity, keyed or not.
 */
function maskKey(egressSecret: Buffer, profileHash: string, scope: ReferenceScope): Buffer {
  return createHmac('sha256', egressSecret).update(digestOf(['mask', MASKING_POLICY_VERSION, profileHash, scope.tenant.agencyId, scope.tenant.clientId, scope.attemptId, scope.projectRevisionId, scope.projectRevisionHash])).digest();
}

/** A scope with every member present and non-blank; a reference cannot be issued in a scope that names nothing. */
function assertScope(scope: ReferenceScope | undefined): ReferenceScope {
  const blank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';
  if (scope === undefined || scope.tenant === undefined || blank(scope.tenant.agencyId) || blank(scope.tenant.clientId) || blank(scope.attemptId) || blank(scope.projectRevisionId) || blank(scope.projectRevisionHash)) throw new IntelligenceError('CONTRACT_VIOLATION', 'opaque references need the tenant, the attempt and the project revision they are scoped to');
  return scope;
}

/**
 * A token for text that may not travel: an HMAC of the text under the mask
 * key, so equal texts of one profile share a token within a run and nothing
 * else does, and no dictionary can be verified against the bytes. Spelled in
 * letters only, so no token can ever look like a number the classifier has
 * an opinion about.
 */
function maskToken(prefix: string, key: Buffer, text: string): string {
  const letters = createHmac('sha256', key).update(text, 'utf8').digest('hex').slice(0, 12).replace(/[0-9a-f]/gu, (digit) => 'ghijklmnopqrstuv'[Number.parseInt(digit, 16)] ?? 'g');
  return `${prefix}_${letters}`;
}

export interface RedactedViews {
  readonly profileView: SourceProfileView;
  readonly contractView: TargetContractView | CleanOnlyContractView;
  readonly memoryEvidence: readonly MemoryEvidenceItem[];
  readonly repairContext: RepairContext | null;
  readonly classesSeen: readonly DataClass[];
  readonly blocked: readonly { fieldRef: string; dataClass: DataClass; reason: string }[];
}

/**
 * Every text channel of the envelope, classified by the one classifier and
 * masked or dropped when it fails. The views are restricted to what the
 * task names before anything is classified, so a field outside the task
 * neither travels nor counts.
 */
export function redactMetadata(input: { contracts: AdaptedContracts; candidates: readonly DeterministicCandidate[]; memoryEvidence: readonly MemoryEvidenceItem[]; repairContext: RepairContext | null; egressSecret: Buffer; scope: ReferenceScope; reviewClaims?: readonly ReviewClaimView[] }): RedactedViews {
  const { contracts, candidates } = input;
  const key = maskKey(input.egressSecret, contracts.profileHash, assertScope(input.scope));
  const classes = new Set<DataClass>();
  const blocked: { fieldRef: string; dataClass: DataClass; reason: string }[] = [];
  const record = (classification: Classification, ref: string, channel: string): boolean => {
    classes.add(classification.dataClass);
    if (vouches(classification)) return true;
    blocked.push({ fieldRef: ref, dataClass: classification.dataClass, reason: `${channel}: ${classification.reason}` });
    return false;
  };
  const passes = (text: string, kind: MetadataKind, ref: string, channel: string): boolean => record(classifyMetadataText(text, kind), ref, channel);
  const fieldRefs = new Set(candidates.flatMap((candidate) => candidate.sourceRefs));
  const profileView: SourceProfileView = {
    ...contracts.profileView,
    fields: contracts.profileView.fields
      .filter((field) => fieldRefs.has(field.fieldRef))
      .map((field) => ({
        ...field,
        header: passes(field.header, 'LABEL', field.fieldRef, 'header') ? field.header : maskToken('hdr', key, field.header),
        fileId: passes(field.fileId, 'IDENTIFIER', field.fieldRef, 'file id') ? field.fileId : maskToken('file', key, field.fileId),
        sheet: field.sheet === null || passes(field.sheet, 'IDENTIFIER', field.fieldRef, 'sheet') ? field.sheet : maskToken('sheet', key, field.sheet),
      })),
  };
  // A review candidate's refs are decisions; the targets its claims name are the ones its view carries (D3-CAP-11).
  const allowedTargets = new Set([...candidates.flatMap((candidate) => candidate.allowedTargetRefs), ...(input.reviewClaims ?? []).flatMap((claim) => (claim.targetRef === null ? [] : [claim.targetRef]))]);
  // CLEAN_ONLY names Migration Core's own canonical fields — constants of the
  // frozen peer, not a channel from anyone's data plane.
  const contractView: TargetContractView | CleanOnlyContractView =
    contracts.contractView.mode === 'CLEAN_ONLY'
      ? contracts.contractView
      : {
          ...contracts.contractView,
          instanceId: passes(contracts.contractView.instanceId, 'IDENTIFIER', 'target', 'instance id') ? contracts.contractView.instanceId : maskToken('inst', key, contracts.contractView.instanceId),
          fields: contracts.contractView.fields
            .filter((field) => allowedTargets.has(field.targetRef))
            .map((field) => ({
              ...field,
              objectApiName: passes(field.objectApiName, 'IDENTIFIER', field.targetRef, 'object api name') ? field.objectApiName : maskToken('obj', key, field.objectApiName),
              apiName: passes(field.apiName, 'IDENTIFIER', field.targetRef, 'api name') ? field.apiName : maskToken('api', key, field.apiName),
              label: passes(field.label, 'LABEL', field.targetRef, 'target label') ? field.label : maskToken('lbl', key, field.label),
              type: passes(field.type, 'IDENTIFIER', field.targetRef, 'target type') ? field.type : maskToken('type', key, field.type),
              // A failing option is dropped, not masked: a token in the list
              // would be a value the model could pick and the compiler accept.
              options: field.options.filter((option) => record(classifyOption(field, option), field.targetRef, 'target option')),
            })),
        };
  const memoryEvidence = input.memoryEvidence.map((item) => ({
    ...item,
    rule: {
      ...item.rule,
      // The same token as a header of the same text, so an exact-match pattern still meets its header.
      sourceHeaderPattern: passes(item.rule.sourceHeaderPattern, 'LABEL', item.memoryId, 'memory pattern') ? item.rule.sourceHeaderPattern : maskToken('hdr', key, item.rule.sourceHeaderPattern),
      semanticType: item.rule.semanticType === null || passes(item.rule.semanticType, 'IDENTIFIER', item.memoryId, 'memory type') ? item.rule.semanticType : null,
    },
  }));
  const repairContext: RepairContext | null =
    input.repairContext === null
      ? null
      : {
          ...input.repairContext,
          validationCodes: input.repairContext.validationCodes.map((code) => (passes(code, 'IDENTIFIER', 'repair', 'repair code') ? code : maskToken('code', key, code))),
          allowedValues: input.repairContext.allowedValues.filter((value) => passes(value, 'OPTION', 'repair', 'repair value')),
        };
  return { profileView, contractView, memoryEvidence, repairContext, classesSeen: [...classes].sort(), blocked };
}

/** The metadata text an envelope actually carries, channel by channel, each read the way the builder should have read it, for the egress decision to re-read. */
function textChannels(envelope: IntelligenceEnvelopeV1): readonly (() => Classification)[] {
  const channels: (() => Classification)[] = [];
  const channel = (text: string, kind: MetadataKind): void => { channels.push(() => classifyMetadataText(text, kind)); };
  for (const field of envelope.sourceProfile.fields) {
    channel(field.header, 'LABEL');
    channel(field.fileId, 'IDENTIFIER');
    if (field.sheet !== null) channel(field.sheet, 'IDENTIFIER');
  }
  if (envelope.targetContract.mode !== 'CLEAN_ONLY') {
    channel(envelope.targetContract.instanceId, 'IDENTIFIER');
    for (const field of envelope.targetContract.fields) {
      channel(field.objectApiName, 'IDENTIFIER');
      channel(field.apiName, 'IDENTIFIER');
      channel(field.label, 'LABEL');
      channel(field.type, 'IDENTIFIER');
      for (const option of field.options) channels.push(() => classifyOption(field, option));
    }
  }
  for (const item of envelope.memoryEvidence) {
    channel(item.rule.sourceHeaderPattern, 'LABEL');
    if (item.rule.semanticType !== null) channel(item.rule.semanticType, 'IDENTIFIER');
  }
  if (envelope.repairContext !== null) {
    for (const code of envelope.repairContext.validationCodes) channel(code, 'IDENTIFIER');
    for (const value of envelope.repairContext.allowedValues) channel(value, 'OPTION');
  }
  return channels;
}

/** The redacted options the envelope itself carries: the only authority a re-read value may be safe by. */
function envelopeOptions(envelope: IntelligenceEnvelopeV1): readonly string[] {
  return envelope.targetContract.mode === 'CLEAN_ONLY' ? [] : envelope.targetContract.fields.flatMap((field) => field.options);
}

/**
 * Whether an exemplar reads as what it claims with no header, no report and
 * no column to vouch for it. An L1 value must classify as safe semantics on
 * its own — closed vocabulary, ISO code or one of the envelope's redacted
 * options — under the hard rules: a given name, a proper noun, a caseless-
 * script token, an email, a phone, an id or a card fails here whatever the
 * minimizer said. An L2 shape must be its own mask: a shape that still
 * carries a letter of any script or a digit is a value.
 */
function exemplarReadsSafe(exemplar: Exemplar, options: readonly string[]): boolean {
  const text = exemplar.minimizedValueOrClass;
  if (exemplar.dataLevel === 'L1') {
    const classification = classifyValue(text, { header: '', distinctCount: 1, rowCount: 1, shapeCandidates: [], targetOptions: options });
    return classification.dataClass === 'SAFE_LOW_CARDINALITY_SEMANTICS' && !classification.instructionLike;
  }
  if (exemplar.dataLevel === 'L2') return text !== '' && maskShape(text) === text;
  return false;
}

export interface BuildEnvelopeInput {
  readonly task: TaskRecord;
  readonly contracts: AdaptedContracts;
  readonly candidates: readonly DeterministicCandidate[];
  readonly memoryEvidence: readonly MemoryEvidenceItem[];
  readonly summaries: CategoricalSummaries;
  readonly projectRevisionId: string;
  readonly projectRevisionHash: string;
  readonly supportEnvelopeVersion: string;
  readonly budgetSnapshot: BudgetSnapshot;
  readonly repairContext: RepairContext | null;
  readonly egressSecret: Buffer;
  /** The tenant the host authenticated: with the attempt, the revision and the profile, the scope every opaque reference of this envelope is bound to. */
  readonly tenant: { readonly agencyId: string; readonly clientId: string };
  /** The host's AuditAttempt identity: references are equal within one attempt and never across two (masking policy 1.4.0). */
  readonly attemptId: string;
  /** The resolver's decisions, from which the association channel reads the run's record mappings (D3-CAP-08); without them no association is offered. */
  readonly decisions?: readonly ResolvedDecision[];
  /** The task a SEMANTIC_REPAIR round repairs: its permissions are the round's (D3-CAP-12). */
  readonly repairOf?: TaskType;
  /** The claims of the CONSISTENCY_REVIEW candidates the task carries (D3-CAP-11): refs and closed codes. */
  readonly reviewClaims?: readonly ReviewClaimView[];
}

/**
 * The association channel of an ASSOCIATION_MAPPING envelope (D3-CAP-08):
 * for each association candidate, the options it may name — each an
 * association ref with its key column's field ref, its relationship, the
 * owner's side, the target's object, the target record mapping's opaque ref
 * and its declared record id column's field ref. Refs and closed codes only;
 * the columns they name are in the profile view, read by the classifier like
 * every header. Empty for a task that has no association candidate.
 */
function associationChannel(contracts: AdaptedContracts, candidates: readonly DeterministicCandidate[], decisions: readonly ResolvedDecision[]): readonly AssociationTargetView[] {
  const targets: AssociationTargetView[] = [];
  for (const candidate of candidates) {
    if (candidate.candidateType !== ASSOCIATION_CANDIDATE_TYPE) continue;
    const keyFieldRef = candidate.sourceRefs[0] ?? '';
    for (const associationRef of candidate.allowedTargetRefs) {
      const option = associationOptionOf(contracts, decisions, keyFieldRef, associationRef);
      if (option === undefined || option.status !== 'OFFERED' || option.targetIdFieldRef === null) continue;
      targets.push({ associationRef: option.associationRef, keyFieldRef: option.keyFieldRef, relationshipType: option.relationshipType, ownerSide: option.ownerSide, targetObject: option.targetObject, targetRecordRef: option.targetRecordRef, targetIdFieldRef: option.targetIdFieldRef });
    }
  }
  return targets;
}

/**
 * Whether the association channel of an envelope is what the channel may be
 * (D3-CAP-08), re-read by the egress decision rather than trusted: every
 * member a ref or a closed code, every association ref the one its own
 * members derive.
 */
function associationChannelProblems(envelope: IntelligenceEnvelopeV1): readonly string[] {
  const problems: string[] = [];
  for (const target of envelope.associationTargets) {
    for (const [member, value] of Object.entries(target)) if (typeof value !== 'string' || !/^(?:[a-z][a-z0-9]*_[0-9a-f]{8,32}|[A-Z][A-Z_]*)$/u.test(value)) problems.push(`association channel ${member} is neither a ref nor a closed code`);
    if (target.associationRef !== associationRefOf(target.keyFieldRef, target.relationshipType, target.targetRecordRef)) problems.push('an association ref is not the one its members derive');
  }
  return problems;
}

export interface BuiltEnvelope {
  readonly envelope: IntelligenceEnvelopeV1;
  readonly hash: string;
  readonly minimization: MinimizationReport;
  readonly egress: EgressDecision;
}

function egressToken(secret: Buffer, decision: Omit<EgressDecision, 'token'>): string {
  return createHmac('sha256', secret).update(digestOf(decision)).digest('hex');
}

/**
 * The object channel of an OBJECT_MAPPING envelope (D3-CAP-01): the objects
 * its candidates may name — refs and canonical names, constants of the frozen
 * peer — and, per candidate and object, the file-level facts counted over the
 * candidate's own columns, memory read as the envelope carries it (its
 * patterns against the headers as the envelope carries them). Counts and
 * refs only; empty for a task that has no object candidate.
 */
function objectChannel(contracts: AdaptedContracts, candidates: readonly DeterministicCandidate[], redacted: RedactedViews): { readonly objectTargets: readonly ObjectTargetView[]; readonly objectFacts: readonly ObjectFactView[] } {
  const objectCandidates = candidates.filter((candidate) => candidate.candidateType === DERIVED_CANDIDATE_TYPES.OBJECT);
  if (objectCandidates.length === 0) return { objectTargets: [], objectFacts: [] };
  const offered = new Set(objectCandidates.flatMap((candidate) => candidate.allowedTargetRefs));
  const objectTargets = supportedObjects(contracts).filter((target) => offered.has(target.objectRef)).map((target) => ({ objectRef: target.objectRef, object: target.object }));
  const headers = new Map(redacted.profileView.fields.map((field) => [field.fieldRef, field.header]));
  const memory = { evidence: redacted.memoryEvidence, headerOf: (fieldRef: string): string => headers.get(fieldRef) ?? '' };
  const objectFacts = objectCandidates.flatMap((candidate) => objectFactsOf(contracts, candidate.sourceRefs, memory).filter((fact) => candidate.allowedTargetRefs.includes(fact.objectRef)).map((fact) => ({ candidateRef: candidate.candidateRef, objectRef: fact.objectRef, headerMatches: fact.headerMatches, shapeHolds: fact.shapeHolds, memoryMatches: fact.memoryMatches })));
  return { objectTargets, objectFacts };
}

export function buildEnvelope(input: BuildEnvelopeInput): BuiltEnvelope {
  const { task, contracts, candidates } = input;
  const values = minimize(task, contracts, candidates, input.summaries);
  const reviewClaims = input.reviewClaims ?? [];
  const redacted = redactMetadata({ contracts, candidates, memoryEvidence: input.memoryEvidence, repairContext: input.repairContext, egressSecret: input.egressSecret, scope: { tenant: input.tenant, attemptId: input.attemptId, projectRevisionId: input.projectRevisionId, projectRevisionHash: input.projectRevisionHash }, reviewClaims });
  const minimization: MinimizationReport = { exemplars: values.exemplars, classesSeen: [...new Set([...values.classesSeen, ...redacted.classesSeen])].sort(), blocked: [...values.blocked, ...redacted.blocked], maxDataLevel: values.maxDataLevel };
  const allowedTargets = [...new Set(candidates.flatMap((candidate) => candidate.allowedTargetRefs))].sort();
  const { objectTargets, objectFacts } = objectChannel(contracts, candidates, redacted);
  const associationTargets = associationChannel(contracts, candidates, input.decisions ?? []);
  const envelope: IntelligenceEnvelopeV1 = {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    taskId: task.taskId,
    taskType: task.taskType,
    projectRevisionId: input.projectRevisionId,
    projectRevisionHash: input.projectRevisionHash,
    supportEnvelopeVersion: input.supportEnvelopeVersion,
    vendorContractVersion: contracts.contractView.mode === 'CLEAN_ONLY' ? null : contracts.contractView.targetContractVersion,
    sourceProfileHash: contracts.profileHash,
    candidateSetHash: contracts.candidateSetHash,
    targetContractHash: contracts.targetContractHash,
    sourceProfile: redacted.profileView,
    targetContract: redacted.contractView,
    deterministicCandidates: candidates,
    objectTargets,
    objectFacts,
    associationTargets,
    reviewClaims,
    memoryEvidence: redacted.memoryEvidence,
    exemplars: minimization.exemplars,
    constraints: {
      allowedProposalTypes: allowedProposalTypesOf(task.taskType, input.repairOf),
      allowedTargetIds: allowedTargets,
      supportedTransformPrimitives: PRIMITIVE_REFS.filter((primitive) => primitive !== 'CLEAR_VALUE'),
      // The contract's: the relationships Migration Core's adapter supports between objects the support envelope delivers (D3-CAP-08).
      allowedAssociationTypes: [...offeredRelationshipTypes(contracts)],
      destructiveAllowed: false,
      identityAutoMergeAllowed: false,
      maxItems: Math.max(1, candidates.length * 2),
      maxRationaleLength: 240,
      dataPolicyVersion: DATA_POLICY_VERSION,
    },
    budgetSnapshot: input.budgetSnapshot,
    repairContext: redacted.repairContext,
  };
  const problems = envelopeProblems(envelope);
  if (problems.length > 0) throw new IntelligenceError('INVALID_SCHEMA', `the envelope this core built is not valid: ${problems.map((problem) => `${problem.pointer} ${problem.message}`).join('; ')}`, { problems });
  const hash = envelopeHash(envelope);
  const egress = decideEgress({ envelope, hash, minimization, budget: input.budgetSnapshot, secret: input.egressSecret });
  return { envelope, hash, minimization, egress };
}

export function decideEgress(input: { envelope: IntelligenceEnvelopeV1; hash: string; minimization: MinimizationReport; budget: BudgetSnapshot; secret: Buffer }): EgressDecision {
  const reasons: string[] = [];
  let decision: EgressDecisionKind = 'EGRESS_ALLOWED';
  const classes = input.minimization.classesSeen;
  if (input.envelope.exemplars.some((exemplar) => exemplar.dataClass !== 'SAFE_STRUCTURAL_METADATA' && exemplar.dataClass !== 'SAFE_LOW_CARDINALITY_SEMANTICS')) {
    decision = 'EGRESS_BLOCKED_POLICY';
    reasons.push('an exemplar carries a class the envelope may not carry');
  }
  // The builder's redaction is re-read on the envelope itself, not trusted:
  // metadata text that still fails the classifier is a policy block whatever
  // the report says, which is what makes a skipped or altered redaction die.
  if (textChannels(input.envelope).some((read) => !vouches(read()))) {
    decision = 'EGRESS_BLOCKED_POLICY';
    reasons.push('metadata text that failed classification is in the envelope');
  }
  // The values are re-read too, not only the text around them: an exemplar
  // is a value that left the data plane, and it must pass the hard rules
  // against the envelope's own redacted options, with no header, report or
  // option list the builder saw to speak for it.
  if (input.envelope.exemplars.some((exemplar) => !exemplarReadsSafe(exemplar, envelopeOptions(input.envelope)))) {
    decision = 'EGRESS_BLOCKED_POLICY';
    reasons.push('an exemplar value fails the hard rules on re-read');
  }
  // The parameter values a candidate offers (D3-CAP-04) are a channel of
  // their own, re-read here too: each must sit inside its closed domain — a
  // decimal separator, one of Migration Core's date formats, an ISO 3166
  // country — whatever the resolver thought it declared.
  if (input.envelope.deterministicCandidates.some((candidate) => Object.entries(candidate.allowedParamValues ?? {}).some(([param, values]) => values.some((value) => !paramValueInDomain(param, value))))) {
    decision = 'EGRESS_BLOCKED_POLICY';
    reasons.push('a parameter value outside its closed domain is in the envelope');
  }
  // The association channel carries refs and closed codes and nothing else (D3-CAP-08): re-read, not trusted.
  if (associationChannelProblems(input.envelope).length > 0) {
    decision = 'EGRESS_BLOCKED_POLICY';
    reasons.push('the association channel carries something other than refs and closed codes');
  }
  if (classes.includes('POTENTIAL_SECRET')) {
    // A secret was *seen* in a value or a header. The minimizer did not pass
    // it, but a field whose content includes a secret is not one to reason
    // about at all until somebody has looked.
    decision = 'EGRESS_BLOCKED_SECRET';
    reasons.push('a secret shape was seen among the values or headers of this task');
  }
  if (classes.includes('UNKNOWN') && input.minimization.blocked.some((entry) => entry.dataClass === 'UNKNOWN' && !METADATA_CHANNEL.test(entry.reason))) {
    // UNKNOWN in a value fails closed for the task; unknown metadata was
    // replaced by a token and is reported, not sent.
    decision = decision === 'EGRESS_ALLOWED' ? 'EGRESS_BLOCKED_UNKNOWN' : decision;
    reasons.push('a value could not be classified');
  }
  if (input.budget.remainingTasks <= 0 || input.budget.remainingBilledInputTokens <= 0 || input.budget.remainingBilledOutputTokens <= 0) {
    decision = decision === 'EGRESS_ALLOWED' ? 'EGRESS_BLOCKED_BUDGET' : decision;
    reasons.push('no budget remains for this task');
  }
  const body: Omit<EgressDecision, 'token'> = { decision, envelopeHash: input.hash, taskId: input.envelope.taskId, maxDataLevel: input.minimization.maxDataLevel, classesSeen: classes, blockedReasons: reasons };
  return { ...body, token: egressToken(input.secret, body) };
}

/** The gateway path calls this with the envelope it is about to send; a mismatch is a contract violation, not a warning. */
export function assertEgressBinds(decision: EgressDecision, envelope: IntelligenceEnvelopeV1, secret: Buffer): void {
  const { token, ...body } = decision;
  if (egressToken(secret, body) !== token) throw new IntelligenceError('EGRESS_BLOCKED', 'the egress decision was not issued by this run', { taskId: envelope.taskId });
  if (decision.decision !== 'EGRESS_ALLOWED') throw new IntelligenceError('EGRESS_BLOCKED', `egress is ${decision.decision}: ${decision.blockedReasons.join('; ')}`, { taskId: envelope.taskId });
  const hash = envelopeHash(envelope);
  if (hash !== decision.envelopeHash) throw new IntelligenceError('EGRESS_BLOCKED', 'the envelope changed after its egress decision', { taskId: envelope.taskId, decided: decision.envelopeHash, actual: hash });
}
