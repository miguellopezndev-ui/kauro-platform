/**
 * The Deterministic Resolver, canon §22–§24: everything decidable from the
 * frozen profile and the target contract is decided here, without a model.
 * Exact header matches, exact enum equality, identity proof classification,
 * no-op detection and preservation defaults become decisions; what is left —
 * a material semantic question — becomes an open question the planner turns
 * into a task. Nothing here reads a row, and a suggestion is never a proof.
 *
 * The resolver does not rewrite Migration Core's candidate set. It derives
 * decision candidates from it under named rules, each carrying the set's
 * hash and the candidate it came from, so the two are never confused.
 *
 * The structural families (B03-CAP-STRUCTURE): a file whose headers tie
 * between objects is an OBJECT_MAPPING question over the object refs the
 * support envelope delivers, and its columns wait for the answer — a second
 * resolution with the decided object (`decidedObjects`) resolves them
 * (D3-CAP-01); a column with plausible targets of its record mapping's
 * object is a FIELD_MAPPING question (D3-CAP-02); a column mapped on facts
 * whose full-data shapes read as more than one type is a SEMANTIC_TYPE
 * question, and keeps its destination's own type until it is answered
 * (D3-CAP-03); a column no target of its record mapping can hold is an
 * UNMAPPED_HANDLING question, carrying the unmapped material Migration Core
 * reported on it (D3-CAP-09).
 */
import { CANONICAL_FIELDS, SEMANTIC_TYPES } from 'kauro-migration-core';

import type { AdaptedContracts } from '../adapter/contract-adapter.js';
import { PARAMETERISED_PRIMITIVES, allowedParamValuesOf, declaredLocale } from '../compiler/parameter-evidence.js';
import { digestOf } from '../contracts/canonical.js';
import { REQUIREMENT_CANDIDATE_TYPE, TRANSFORM_CANDIDATE_TYPE, VALUE_CANDIDATE_TYPE, cleanOnlyTargetRef, objectRefOf } from '../contracts/envelope.js';
import type { DeterministicCandidate, MemoryEvidenceItem, SourceFieldFact, TaskType } from '../contracts/envelope.js';
import { outputScopeOf, recordMappingIdOf } from '../contracts/output-scope.js';
import type { LocaleEvidence } from '../contracts/proposal.js';
import { l1ExemplarRef, valueCandidateValues } from '../envelope/envelope-builder.js';
import type { CategoricalSummaries } from '../envelope/envelope-builder.js';
import { externalIdAuthorityOf, identityFamilies } from './identity-families.js';
import type { DuplicateClusterView, OriginalAnswer } from './identity-families.js';

/**
 * Identity proof, MC canon §27 and IC §40–§41. Statistical uniqueness is
 * never identity: a column proves identity only when it is unique, populated
 * on every row AND an authoritative identifier names it — the record id
 * column the project declares for the file, or a target the contract flags
 * externalId/idLookup whose name the header matches exactly. A unique email,
 * phone or name is an IDENTITY_SIGNAL: something to point at, never a proof.
 */
export type IdentityProof = 'PROVEN_UNIQUE_IDENTIFIER' | 'IDENTITY_SIGNAL' | 'UNIQUE_BUT_UNPROVEN' | 'NOT_UNIQUE' | 'NO_EVIDENCE';

export interface ResolvedDecision {
  readonly decisionRef: string;
  readonly kind: 'FIELD_MAPPING' | 'SEMANTIC_TYPE' | 'NO_OP' | 'IDENTITY_PROOF' | 'PRESERVE_UNMAPPED' | 'RECORD_ID_DECLARED';
  readonly fieldRef: string;
  readonly targetRef: string | null;
  readonly semanticType: string | null;
  readonly identityProof: IdentityProof | null;
  readonly rule: string;
  readonly evidenceRefs: readonly string[];
  /** Where the decision came from: the draft projects these alongside the model's PROPOSED items. */
  readonly origin: 'DETERMINISTIC';
  /** The record mapping the decision belongs to — `${fileId}-${object}` — the scope inside which a target is claimed once. */
  readonly recordId: string | null;
  readonly sourceFieldRef: string;
  readonly destinationField: string | null;
  readonly impactRows: number;
}

export interface ResolveOptions {
  readonly declaredObjects?: Readonly<Record<string, string>>;
  /** The source record id column each file declares (by path or file id) — the project's authoritative identifier, never inferred. */
  readonly recordIdColumns?: Readonly<Record<string, string>>;
  /**
   * The object of each file an accepted MAP_OBJECT decided, by file id
   * (phase two of D3-CAP-01). A declaration of the project outranks it; a
   * file with neither is resolved from its headers as before.
   */
  readonly decidedObjects?: Readonly<Record<string, string>>;
  /** The host's categorical summaries: the only values a value question may be about (D3-CAP-05). */
  readonly categoricalSummaries?: CategoricalSummaries;
  /** The project's declared locale: the only evidence a date format or a phone region stands on (D3-CAP-04). A member outside its domain is no evidence. */
  readonly localeEvidence?: LocaleEvidence;
}

/**
 * One value candidate of a VALUE_MAP (D3-CAP-05), as the core keeps it:
 * the column, the ENUM target and the value exactly as the host's
 * categorical summary gives it — the `from` of the value map. The value
 * never rides in the candidate: it travels only as the L1 exemplar the
 * candidate's evidence names.
 */
export interface ValueCandidate {
  readonly candidateRef: string;
  readonly fieldRef: string;
  readonly targetRef: string;
  readonly value: string;
}

export interface OpenQuestion {
  readonly questionRef: string;
  readonly taskType: TaskType;
  readonly fieldRefs: readonly string[];
  readonly candidateRefs: readonly string[];
  readonly reason: string;
  /** Semantic complexity, for partitioning: the number of plausible answers, not the number of rows. */
  readonly complexity: number;
  /** The record mapping the question is about (null while the file's object is undecided), so the planner keeps one record mapping's questions together (D3-PART-1). */
  readonly recordMappingId?: string | null;
}

export interface Resolution {
  readonly decisions: readonly ResolvedDecision[];
  readonly openQuestions: readonly OpenQuestion[];
  /**
   * Decision candidates derived for the open questions, with explicit
   * allowed targets — and, for a file whose object is not decided yet, one
   * per populated column of it that waits for the object (no question, no
   * target) and is answered once a second resolution knows the object.
   */
  readonly derivedCandidates: readonly DeterministicCandidate[];
  /** The value each value candidate stands for (D3-CAP-05): the assembly takes a value map's `from` from here, never from a proposal. */
  readonly valueCandidates: readonly ValueCandidate[];
  /**
   * How the originals the identity families route are answered (D3-ACC-2,
   * B03-CAP-IDENTITY): a KEY_CANDIDATE by the record id the project declared,
   * by the identity question about its column, or IDENTITY_WITHOUT_PROOF; a
   * DUPLICATE_CLUSTER by the duplicate question about its files.
   */
  readonly originalAnswers?: ReadonlyMap<string, OriginalAnswer>;
  /** Migration Core's duplicate clusters, the question that answers each, and the rows its review group names (D3-CAP-07). */
  readonly duplicateClusters?: readonly DuplicateClusterView[];
}

/** The candidate types the resolver derives, by the decision each stands for. */
export const DERIVED_CANDIDATE_TYPES = Object.freeze({
  /** The object of a file (OBJECT_MAPPING). */
  OBJECT: 'DERIVED_OBJECT_DECISION',
  /** What becomes of a column: a target (FIELD_MAPPING), or the wait for its file's object. */
  FIELD: 'DERIVED_FIELD_DECISION',
  /** How a column mapped on facts is read (SEMANTIC_TYPE). */
  SEMANTIC_TYPE: 'DERIVED_SEMANTIC_TYPE_DECISION',
  /** A column no target of its record mapping can hold (UNMAPPED_HANDLING). */
  UNMAPPED: 'DERIVED_UNMAPPED_DECISION',
} as const);

const normalise = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '');

const SHAPE_TO_SEMANTIC: Readonly<Record<string, string>> = Object.freeze({
  emailLike: 'EMAIL',
  phoneInternational: 'PHONE',
  phoneLocalDigits: 'PHONE',
  isoDate: 'DATE',
  slashDateAmbiguous: 'DATE',
  booleanLike: 'BOOLEAN',
  integer: 'NUMBER',
  decimalPoint: 'NUMBER',
  decimalComma: 'NUMBER',
  groupedNumber: 'NUMBER',
  urlLike: 'URL',
});

/**
 * The type each full-data shape reads a value as, for the type question
 * (D3-CAP-03): the shapes above, and digits with a leading zero, which only
 * an IDENTIFIER keeps whole (Migration Core's own IDENTIFIER_SEMANTIC_TYPE
 * candidate on such a column).
 */
export const TYPE_OF_SHAPE: Readonly<Record<string, string>> = Object.freeze({ ...SHAPE_TO_SEMANTIC, leadingZeroDigits: 'IDENTIFIER' });

/** The types a column's full-data shapes read its values as. */
export function typesOfShapes(field: Pick<SourceFieldFact, 'shapeCandidates'>): ReadonlySet<string> {
  return new Set(field.shapeCandidates.map((shape) => TYPE_OF_SHAPE[shape]).filter((type): type is string => type !== undefined));
}

/** The semantic type a target field's contract type implies, for exact compatibility. */
function targetSemantic(type: string, options: readonly string[]): string {
  const token = type.toLowerCase();
  if (options.length > 0) return 'ENUM';
  if (token.includes('email')) return 'EMAIL';
  if (token.includes('phone')) return 'PHONE';
  if (token === 'date') return 'DATE';
  if (token.includes('datetime') || token === 'date_time' || token === 'timestamp') return 'DATETIME';
  if (token.includes('bool') || token === 'checkbox') return 'BOOLEAN';
  if (token.includes('number') || token.includes('double') || token.includes('int') || token.includes('currency') || token.includes('percent')) return 'NUMBER';
  if (token.includes('url')) return 'URL';
  return 'TEXT';
}

/** One target of the contract, as the resolver compares a header and a shape with it. */
export interface TargetEntry {
  readonly targetRef: string;
  readonly semantic: string;
  readonly options: readonly string[];
  readonly required: boolean;
  readonly writable: boolean;
  readonly object: string;
  readonly destinationField: string;
  readonly identityAuthority: boolean;
}

export interface TargetIndex {
  readonly targets: readonly TargetEntry[];
  /** Targets by normalised label, api name (and, in CLEAN_ONLY, canonical name and description): only targets the support envelope delivers. */
  readonly byName: ReadonlyMap<string, readonly TargetEntry[]>;
}

const indexes = new WeakMap<AdaptedContracts, TargetIndex>();

/** Targets, by normalised label and api name, with the semantic type each implies: the one reading of the contract the resolver, the object facts and the compiler share. */
export function targetIndexOf(contracts: AdaptedContracts): TargetIndex {
  const known = indexes.get(contracts);
  if (known !== undefined) return known;
  const { contractView, refs } = contracts;
  const targets: TargetEntry[] = [];
  const byName = new Map<string, TargetEntry[]>();
  const add = (key: string, entry: TargetEntry): void => {
    const list = byName.get(key) ?? [];
    if (!list.some((existing) => existing.targetRef === entry.targetRef)) list.push(entry);
    byName.set(key, list);
  };
  if (contractView.mode === 'CLEAN_ONLY') {
    for (const name of contractView.canonicalFields) {
      const definition = CANONICAL_FIELDS[name as keyof typeof CANONICAL_FIELDS];
      const entry: TargetEntry = { targetRef: cleanOnlyTargetRef(name), semantic: name.endsWith('email') ? 'EMAIL' : name.endsWith('phone') ? 'PHONE' : name.endsWith('website') || name.endsWith('domain') ? 'URL' : 'TEXT', options: [], required: false, writable: true, object: (name.split('.')[0] ?? '').toUpperCase(), destinationField: name, identityAuthority: false };
      targets.push(entry);
      add(normalise(name.split('.')[1] ?? name), entry);
      add(normalise(name), entry);
      if (definition !== undefined) add(normalise(definition.description.replace(/\.$/u, '')), entry);
    }
  } else {
    for (const field of contractView.fields) {
      const info = refs.targetByRef.get(field.targetRef);
      const delivered = info?.destinationField ?? '';
      const entry: TargetEntry = { targetRef: field.targetRef, semantic: targetSemantic(field.type, field.options), options: field.options, required: field.required, writable: field.createable || field.updateable, object: (delivered.split('.')[0] ?? '').toUpperCase(), destinationField: delivered, identityAuthority: info?.identityAuthority ?? false };
      targets.push(entry);
      if (delivered === '') continue; // outside the support envelope: not a target a proposal may name
      add(normalise(field.label), entry);
      add(normalise(field.apiName), entry);
    }
  }
  const index: TargetIndex = { targets, byName };
  indexes.set(contracts, index);
  return index;
}

/** The semantic type a target implies, by ref: the compiler's view of a destination. */
export function targetSemanticOf(contracts: AdaptedContracts, targetRef: string): string | null {
  return targetIndexOf(contracts).targets.find((entry) => entry.targetRef === targetRef)?.semantic ?? null;
}

/**
 * The objects the support envelope delivers in this run, with the refs an
 * OBJECT_MAPPING candidate names them by (D3-CAP-01): every canonical object
 * one of whose fields Migration Core's adapter delivers — the four canonical
 * objects in CLEAN_ONLY, the vendor objects it maps in a vendor mode.
 */
export function supportedObjects(contracts: AdaptedContracts): readonly { readonly object: string; readonly objectRef: string }[] {
  const objects = new Set<string>();
  for (const info of contracts.refs.targetByRef.values()) {
    const object = (info.destinationField.split('.')[0] ?? '').toUpperCase();
    if (object !== '') objects.add(object);
  }
  return [...objects].sort().map((object) => ({ object, objectRef: objectRefOf(contracts.mode, object) }));
}

/** The file-level facts of one object for a set of columns (D3-CAP-01). */
export interface ObjectFact {
  readonly object: string;
  readonly objectRef: string;
  /** Columns whose header names a field of the object. */
  readonly headerMatches: number;
  /** Columns whose full-data shape reads as a type a writable field of the object holds. */
  readonly shapeHolds: number;
  /** Verified memory entries that point a header of the columns at a field of the object. */
  readonly memoryMatches: number;
}

/**
 * The facts of every object the support envelope delivers, counted over the
 * given columns alone — the same header reading the resolver ties files by,
 * the dominant full-data shape of each column against the writable fields
 * of the object, and the memory evidence as the envelope carries it (its
 * patterns against the headers as the envelope carries them). Counts only.
 */
export function objectFactsOf(contracts: AdaptedContracts, fieldRefs: readonly string[], memory: { readonly evidence: readonly MemoryEvidenceItem[]; readonly headerOf: (fieldRef: string) => string } | null): readonly ObjectFact[] {
  const index = targetIndexOf(contracts);
  const wanted = new Set(fieldRefs);
  const fields = contracts.profileView.fields.filter((field) => wanted.has(field.fieldRef));
  const objectOfTarget = (targetRef: string): string | null => index.targets.find((entry) => entry.targetRef === targetRef && entry.destinationField !== '')?.object ?? null;
  return supportedObjects(contracts).map(({ object, objectRef }) => {
    const writable = index.targets.filter((entry) => entry.writable && entry.object === object && entry.destinationField !== '');
    const headerMatches = fields.filter((field) => (index.byName.get(normalise(field.header)) ?? []).some((entry) => entry.object === object)).length;
    const shapeHolds = fields.filter((field) => {
      const implied = field.shapeCandidates[0] === undefined ? undefined : SHAPE_TO_SEMANTIC[field.shapeCandidates[0]];
      return implied !== undefined && writable.some((entry) => entry.semantic === implied);
    }).length;
    const memoryMatches = memory === null ? 0 : memory.evidence.filter((item) => item.rule.targetRef !== null && objectOfTarget(item.rule.targetRef) === object && fields.some((field) => memory.headerOf(field.fieldRef).toLowerCase().includes(item.rule.sourceHeaderPattern.toLowerCase()))).length;
    return { object, objectRef, headerMatches, shapeHolds, memoryMatches };
  });
}

/** Whether the facts decide the object: its facts strictly outweigh every other object's — the one condition under which a MAP_OBJECT may stand. */
export function objectDecides(facts: readonly ObjectFact[], object: string): boolean {
  const weight = (fact: ObjectFact): number => fact.headerMatches + fact.shapeHolds + fact.memoryMatches;
  const chosen = facts.find((fact) => fact.object === object);
  return chosen !== undefined && facts.every((fact) => fact.object === object || weight(fact) < weight(chosen));
}

const SIGNAL_SHAPES = new Set(['emailLike', 'phoneInternational', 'phoneLocalDigits']);
const SIGNAL_HEADER = /email|e-mail|mail|phone|tel|mobile|name|nombre|correo/iu;

/**
 * Identity proof from facts, strictest rule the available facts allow:
 * uniqueness and population come from the profile; authority comes from the
 * declared record id column or from a target the contract flags as an
 * external id, and from nowhere else. A well-formed shape is not authority.
 */
function identityProof(field: SourceFieldFact, authority: { declaredRecordId: boolean; contractExternalId: boolean }): IdentityProof {
  if (field.nonEmptyCount === 0) return 'NO_EVIDENCE';
  if (field.uniqueAmongNonEmpty !== true) return 'NOT_UNIQUE';
  const populatedEverywhere = field.nonEmptyCount === field.rowCount;
  const signal = field.shapeCandidates.some((shape) => SIGNAL_SHAPES.has(shape)) || SIGNAL_HEADER.test(field.header);
  // The record id column the project declares is the identity Migration Core
  // itself runs the file on; a contract's externalId/idLookup flag is the
  // other authority. Neither lends authority to a contact signal: a project
  // that names its Email column as the record id, or a vendor that looks
  // contacts up by email, does not make an email an identity (MC §27, IC-07).
  const authoritative = (authority.declaredRecordId || authority.contractExternalId) && !signal;
  if (authoritative && populatedEverywhere) return 'PROVEN_UNIQUE_IDENTIFIER';
  return signal ? 'IDENTITY_SIGNAL' : 'UNIQUE_BUT_UNPROVEN';
}

/** The ref of a column's decision candidate: one per column, whichever question it ends up in, and the same while it waits for its file's object. */
export const fieldCandidateRefOf = (candidateSetHash: string, fieldRef: string): string => `cand_${digestOf(['derived', candidateSetHash, fieldRef]).slice(0, 16)}`;
/** The ref of a column's type candidate (D3-CAP-03). */
export const typeCandidateRefOf = (candidateSetHash: string, fieldRef: string): string => `cand_${digestOf(['derived-type', candidateSetHash, fieldRef]).slice(0, 16)}`;

/**
 * The targets a column may plausibly name inside its record mapping: the
 * writable fields of the object the support envelope delivers, not claimed
 * in the same output scope, of a type the column's dominant full-data shape
 * is compatible with. None is CAP09's question, not CAP02's (D3-CAP-02,
 * D3-CAP-09); the compiler reads the same rule to check NO_TARGET_IN_ENVELOPE.
 */
export function plausibleTargetsOf(contracts: AdaptedContracts, field: Pick<SourceFieldFact, 'shapeCandidates'>, object: string, claimed: (target: TargetEntry) => boolean): readonly TargetEntry[] {
  const shape = field.shapeCandidates[0] ?? null;
  const impliedSemantic = shape === null ? null : (SHAPE_TO_SEMANTIC[shape] ?? null);
  return targetIndexOf(contracts).targets.filter((entry) => entry.writable && entry.object === object && entry.destinationField !== '' && !claimed(entry) && (impliedSemantic === null || entry.semantic === impliedSemantic || entry.semantic === 'TEXT'));
}

export function resolve(contracts: AdaptedContracts, options: ResolveOptions = {}): Resolution {
  const decisions: ResolvedDecision[] = [];
  const questions: OpenQuestion[] = [];
  const derived: DeterministicCandidate[] = [];
  const { profileView, contractView, refs } = contracts;
  const { targets, byName } = targetIndexOf(contracts);
  // Only a declared member inside its closed domain is evidence; the run refuses a malformed declaration before it resolves anything (D3-CAP-04).
  const locale = declaredLocale(options.localeEvidence).locale;
  /** Migration Core's original candidates on a column. */
  const originalsOn = (fieldRef: string): readonly DeterministicCandidate[] => contracts.candidates.filter((candidate) => candidate.sourceRefs.includes(fieldRef));
  const candidateOf = (field: SourceFieldFact, candidateType: string, allowedTargetRefs: readonly string[], allowedPrimitiveRefs: readonly string[], rule: string, original: DeterministicCandidate | null, candidateRef: string = fieldCandidateRefOf(contracts.candidateSetHash, field.fieldRef)): DeterministicCandidate => ({
    candidateRef,
    candidateType,
    sourceRefs: [field.fieldRef],
    allowedTargetRefs,
    allowedPrimitiveRefs,
    // The evidence the question stands on: the column's profile facts, and those of the original it answers.
    evidenceRefs: [...new Set([...field.evidenceRefs, ...(original?.evidenceRefs ?? [])])],
    impactCounts: { rows: field.nonEmptyCount, distinct: field.distinctCount },
    constraints: { destructiveAllowed: false, identityAutoMergeAllowed: false },
    derivedFrom: { candidateSetHash: contracts.candidateSetHash, candidateRef: original?.candidateRef ?? null, rule },
  });

  // The object of each file: declared by the project, decided by an accepted
  // MAP_OBJECT, or the object whose fields the headers name strictly most
  // often; a tie is an OBJECT_MAPPING question over the objects the support
  // envelope delivers, and the file's columns wait, preserved, for the answer.
  const objectOfFile = new Map<string, string | null>();
  const fileIds = [...new Set(profileView.fields.map((field) => field.fileId))];
  const objects = supportedObjects(contracts);
  for (const fileId of fileIds) {
    const path = [...refs.fieldByRef.values()].find((entry) => entry.fileId === fileId)?.filePath ?? fileId;
    const declared = options.declaredObjects?.[path] ?? options.declaredObjects?.[fileId] ?? options.decidedObjects?.[fileId];
    if (declared !== undefined) {
      objectOfFile.set(fileId, declared);
      continue;
    }
    const counts = new Map<string, number>();
    for (const field of profileView.fields.filter((entry) => entry.fileId === fileId)) {
      const fieldObjects = new Set((byName.get(normalise(field.header)) ?? []).map((entry) => entry.object));
      for (const object of fieldObjects) counts.set(object, (counts.get(object) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const best = ranked[0];
    const second = ranked[1];
    if (best !== undefined && (second === undefined || best[1] > second[1])) objectOfFile.set(fileId, best[0]);
    else {
      objectOfFile.set(fileId, null);
      const fileFields = profileView.fields.filter((entry) => entry.fileId === fileId);
      const objectCandidateRef = `cand_${digestOf(['derived-object', contracts.candidateSetHash, fileId]).slice(0, 16)}`;
      derived.push({ candidateRef: objectCandidateRef, candidateType: DERIVED_CANDIDATE_TYPES.OBJECT, sourceRefs: fileFields.map((entry) => entry.fieldRef), allowedTargetRefs: objects.map((entry) => entry.objectRef), allowedPrimitiveRefs: [], evidenceRefs: fileFields.flatMap((entry) => entry.evidenceRefs), impactCounts: { rows: fileFields[0]?.rowCount ?? 0, distinct: null }, constraints: { destructiveAllowed: false, identityAutoMergeAllowed: false }, derivedFrom: { candidateSetHash: contracts.candidateSetHash, candidateRef: null, rule: 'RESOLVER_OBJECT_DECISION' } });
      questions.push({ questionRef: `q_${digestOf(['object', fileId]).slice(0, 16)}`, taskType: 'OBJECT_MAPPING', fieldRefs: fileFields.map((entry) => entry.fieldRef), candidateRefs: [objectCandidateRef], reason: ranked.length === 0 ? 'no header names any object' : `headers name ${ranked.slice(0, 3).map(([object, count]) => `${object}x${String(count)}`).join(', ')}`, complexity: Math.max(1, ranked.length), recordMappingId: null });
      // Each populated column waits for the object with its own decision candidate: the expected set names it before any request, and the second resolution answers it (D3-CAP-01, D3-ACC-1).
      for (const field of fileFields) if (field.nonEmptyCount > 0) derived.push(candidateOf(field, DERIVED_CANDIDATE_TYPES.FIELD, [], [], 'RESOLVER_WAITS_FOR_OBJECT', null));
    }
  }

  // A target is claimed once per output scope — one destination of one
  // record mapping, the file and its object (D3-SCOPE-1) — never once per
  // run: two files that both hold CONTACT each map their own Email to
  // contact.email, while two columns of one file competing for one target
  // remain a conflict the agency decides.
  const claimed = new Map<string, string>(); // output scope → fieldRef, to see double claims inside one record mapping
  const recordIdOf = (fileId: string, object: string | null): string | null => (object === null ? null : recordMappingIdOf(fileId, object));
  const claimKey = (recordId: string | null, target: string): string => outputScopeOf(recordId, target);
  const declaredRecordIdHeader = (fileId: string): string | null => {
    const path = refs.fieldByRef.get([...refs.fieldByRef.keys()].find((ref) => refs.fieldByRef.get(ref)?.fileId === fileId) ?? '')?.filePath;
    const header = options.recordIdColumns?.[path ?? ''] ?? options.recordIdColumns?.[fileId];
    return header === undefined ? null : normalise(header);
  };
  const facts = profileView.fields.map((field) => {
    const object = objectOfFile.get(field.fileId) ?? null;
    const key = normalise(field.header);
    const matches = key === '' || object === null ? [] : (byName.get(key) ?? []).filter((entry) => entry.writable && entry.object === object);
    const shape = field.shapeCandidates[0] ?? null;
    const impliedSemantic = shape === null ? null : (SHAPE_TO_SEMANTIC[shape] ?? null);
    // Identity authority is a declared fact: the file's record id column, or a field of the file's object the contract flags externalId/idLookup whose label or api name the header names exactly — delivered as a field or not, since an identity column is read, not delivered (D3-CAP-06).
    const declaredId = declaredRecordIdHeader(field.fileId);
    const authority = { declaredRecordId: declaredId !== null && key !== '' && declaredId === key, contractExternalId: object !== null && externalIdAuthorityOf(contracts, object, field.header).length > 0 };
    return { field, object, recordId: recordIdOf(field.fileId, object), matches, shape, impliedSemantic, authority };
  });
  // First pass: the exact matches claim their targets, in field order, so the
  // second pass never offers a claimed target as a plausible answer.
  const decidedFields = new Set<string>();
  for (const { field, recordId, matches, impliedSemantic } of facts) {
    if (field.nonEmptyCount === 0 || matches.length !== 1) continue;
    const target = matches[0] as TargetEntry;
    const compatible = impliedSemantic === null || impliedSemantic === target.semantic || target.semantic === 'TEXT' || (target.semantic === 'ENUM' && impliedSemantic === null);
    if (compatible && !claimed.has(claimKey(recordId, target.destinationField))) {
      claimed.set(claimKey(recordId, target.destinationField), field.fieldRef);
      decidedFields.add(field.fieldRef);
      // Full-data shapes that read the column as more than one type leave its type open (D3-CAP-03): the destination keeps its own type — which reads nothing into a value — until a SEMANTIC_TYPE answer the shapes support replaces it.
      const typeOpen = target.semantic !== 'ENUM' && typesOfShapes(field).size >= 2;
      const semanticType = target.semantic === 'ENUM' ? 'ENUM' : typeOpen ? target.semantic : (impliedSemantic ?? target.semantic);
      decisions.push({ decisionRef: `dec_${digestOf(['map', field.fieldRef, target.targetRef]).slice(0, 16)}`, kind: 'FIELD_MAPPING', fieldRef: field.fieldRef, targetRef: target.targetRef, semanticType, identityProof: null, rule: 'EXACT_HEADER_MATCH_AND_COMPATIBLE_SHAPE', evidenceRefs: field.evidenceRefs, origin: 'DETERMINISTIC', recordId, sourceFieldRef: field.fieldRef, destinationField: target.destinationField, impactRows: field.nonEmptyCount });
      if (typeOpen) {
        const original = originalsOn(field.fieldRef).find((candidate) => candidate.candidateType === 'AMBIGUOUS_SHAPE_COLUMN' && candidate.allowedPrimitiveRefs.includes('IDENTIFIER_SEMANTIC_TYPE')) ?? null;
        const typeCandidate = candidateOf(field, DERIVED_CANDIDATE_TYPES.SEMANTIC_TYPE, [target.targetRef], [], 'RESOLVER_SEMANTIC_TYPE_DECISION', original, typeCandidateRefOf(contracts.candidateSetHash, field.fieldRef));
        derived.push(typeCandidate);
        questions.push({ questionRef: `q_${digestOf(['type', field.fieldRef]).slice(0, 16)}`, taskType: 'SEMANTIC_TYPE', fieldRefs: [field.fieldRef], candidateRefs: [typeCandidate.candidateRef], reason: `the full-data shapes read the column as ${String(typesOfShapes(field).size)} types`, complexity: typesOfShapes(field).size, recordMappingId: recordId });
      }
    }
  }
  for (const { field, object, recordId, matches, authority } of facts) {

    // Identity proof is classified for every field; a proposal may point at it, never grant it.
    const proof = identityProof(field, authority);
    decisions.push({ decisionRef: `dec_${digestOf(['identity', field.fieldRef]).slice(0, 16)}`, kind: 'IDENTITY_PROOF', fieldRef: field.fieldRef, targetRef: null, semanticType: null, identityProof: proof, rule: 'AUTHORITATIVE_IDENTIFIER_UNIQUE_AND_POPULATED', evidenceRefs: field.evidenceRefs, origin: 'DETERMINISTIC', recordId, sourceFieldRef: field.fieldRef, destinationField: null, impactRows: field.nonEmptyCount });

    if (field.nonEmptyCount === 0) {
      decisions.push({ decisionRef: `dec_${digestOf(['noop', field.fieldRef]).slice(0, 16)}`, kind: 'NO_OP', fieldRef: field.fieldRef, targetRef: null, semanticType: null, identityProof: null, rule: 'EMPTY_COLUMN_HAS_NO_IMPACT', evidenceRefs: field.evidenceRefs, origin: 'DETERMINISTIC', recordId, sourceFieldRef: field.fieldRef, destinationField: null, impactRows: 0 });
      continue;
    }

    if (decidedFields.has(field.fieldRef)) continue;

    // A material semantic question: which target, if any.
    if (object === null) continue; // waits for the object decision; preserved below
    const plausible = plausibleTargetsOf(contracts, field, object, (entry) => claimed.has(claimKey(recordId, entry.destinationField)));
    const originals = originalsOn(field.fieldRef);
    if (plausible.length === 0) {
      // No target of the record mapping can hold the column: whether it is preserved is UNMAPPED_HANDLING's question, carrying the unmapped material Migration Core reported on it (D3-CAP-09).
      const unmapped = originals.find((candidate) => candidate.candidateType === 'UNMAPPED_MATERIAL') ?? null;
      // The primitives any column admits: a preserved column keeps its values as they are, and an answer that names one of them changes nothing.
      const candidate = candidateOf(field, DERIVED_CANDIDATE_TYPES.UNMAPPED, [], ['PRESERVE_AS_IS', 'TRIM_WHITESPACE'], 'RESOLVER_UNMAPPED_DECISION', unmapped);
      derived.push(candidate);
      questions.push({ questionRef: `q_${digestOf(['unmapped', field.fieldRef]).slice(0, 16)}`, taskType: 'UNMAPPED_HANDLING', fieldRefs: [field.fieldRef], candidateRefs: [candidate.candidateRef], reason: 'no target of the record mapping can hold the column', complexity: 1, recordMappingId: recordId });
      continue;
    }
    const impliedSemantic = field.shapeCandidates[0] === undefined ? null : (SHAPE_TO_SEMANTIC[field.shapeCandidates[0]] ?? null);
    const primitives = primitivesFor(impliedSemantic);
    const params = allowedParamValuesOf(primitives, field.shapeCandidates, locale);
    const candidate = candidateOf(field, DERIVED_CANDIDATE_TYPES.FIELD, plausible.map((entry) => entry.targetRef), primitives, 'RESOLVER_FIELD_DECISION', originals[0] ?? null);
    derived.push({ ...candidate, ...(params === undefined ? {} : { allowedParamValues: params }), evidenceRefs: field.evidenceRefs });
    questions.push({ questionRef: `q_${digestOf(['question', field.fieldRef]).slice(0, 16)}`, taskType: 'FIELD_MAPPING', fieldRefs: [field.fieldRef], candidateRefs: [candidate.candidateRef], reason: matches.length > 1 ? `header matches ${String(matches.length)} targets` : matches.length === 1 ? 'header matches a target of an incompatible type' : 'no target matches the header', complexity: Math.max(1, plausible.length), recordMappingId: recordId });
  }

  // TRANSFORMATION_SELECTION (D3-CAP-04) and VALUE_MAP (D3-CAP-05): questions
  // about a column this resolver mapped, whose destination needs what
  // Migration Core may not infer — a parameter its full-data shape leaves
  // open, or source values that are not options of the ENUM it is delivered
  // into. They change the field; they never decide whether it is mapped.
  const factOf = new Map(facts.map((fact) => [fact.field.fieldRef, fact]));
  const targetOf = new Map(targets.map((entry) => [entry.targetRef, entry]));
  const summaries = options.categoricalSummaries ?? new Map<string, readonly string[]>();
  const valueCandidates: ValueCandidate[] = [];
  const constraints = { destructiveAllowed: false, identityAutoMergeAllowed: false } as const;
  for (const decision of decisions.filter((entry) => entry.kind === 'FIELD_MAPPING' && entry.targetRef !== null)) {
    const fact = factOf.get(decision.fieldRef);
    const target = targetOf.get(decision.targetRef ?? '');
    if (fact === undefined || target === undefined) continue;
    const { field, recordId } = fact;
    // A parameter: the candidate offers the one primitive the shape admits, and the values of its parameter the evidence admits.
    for (const [primitive, spec] of Object.entries(PARAMETERISED_PRIMITIVES)) {
      if (!spec.semanticTypes.includes(decision.semanticType ?? '') || !field.shapeCandidates.some((shape) => spec.shapes.includes(shape))) continue;
      const originals = contracts.candidates.filter((candidate) => candidate.candidateType === 'AMBIGUOUS_SHAPE_COLUMN' && candidate.sourceRefs.includes(field.fieldRef));
      const candidateRef = `cand_${digestOf(['derived-transform', contracts.candidateSetHash, field.fieldRef, primitive]).slice(0, 16)}`;
      derived.push({ candidateRef, candidateType: TRANSFORM_CANDIDATE_TYPE, sourceRefs: [field.fieldRef], allowedTargetRefs: [target.targetRef], allowedPrimitiveRefs: [primitive], allowedParamValues: allowedParamValuesOf([primitive], field.shapeCandidates, locale) ?? {}, evidenceRefs: [...new Set([...field.evidenceRefs, ...originals.flatMap((candidate) => candidate.evidenceRefs)])].slice(0, 64), impactCounts: { rows: field.nonEmptyCount, distinct: field.distinctCount }, constraints, derivedFrom: { candidateSetHash: contracts.candidateSetHash, candidateRef: originals[0]?.candidateRef ?? null, rule: 'RESOLVER_TRANSFORMATION_DECISION' } });
      questions.push({ questionRef: `q_${digestOf(['transform', field.fieldRef, primitive]).slice(0, 16)}`, taskType: 'TRANSFORMATION_SELECTION', fieldRefs: [field.fieldRef], candidateRefs: [candidateRef], reason: `the destination needs ${spec.param}, which Migration Core does not infer`, complexity: 1, recordMappingId: recordId });
    }
    // A value map: one candidate per L1 value of the column that is not an option, and only over the whole column.
    if (target.semantic !== 'ENUM') continue;
    const values = valueCandidateValues(field, contracts, target.targetRef, summaries);
    if (values === null || values.length !== field.distinctCount) continue;
    const unmatched = values.filter((value) => !target.options.includes(value));
    if (unmatched.length === 0) continue;
    const refs = unmatched.map((value) => {
      const candidateRef = `cand_${digestOf(['derived-value', contracts.candidateSetHash, field.fieldRef, value]).slice(0, 16)}`;
      derived.push({ candidateRef, candidateType: VALUE_CANDIDATE_TYPE, sourceRefs: [field.fieldRef], allowedTargetRefs: [target.targetRef], allowedPrimitiveRefs: ['MAP_ENUM_VALUE'], evidenceRefs: [l1ExemplarRef(field.fieldRef, value), ...field.evidenceRefs], impactCounts: { rows: field.nonEmptyCount, distinct: 1 }, constraints, derivedFrom: { candidateSetHash: contracts.candidateSetHash, candidateRef: null, rule: 'RESOLVER_VALUE_DECISION' } });
      valueCandidates.push({ candidateRef, fieldRef: field.fieldRef, targetRef: target.targetRef, value });
      return candidateRef;
    });
    questions.push({ questionRef: `q_${digestOf(['values', field.fieldRef]).slice(0, 16)}`, taskType: 'VALUE_MAP', fieldRefs: [field.fieldRef], candidateRefs: refs, reason: `${String(unmatched.length)} source values are not options of the destination`, complexity: unmatched.length, recordMappingId: recordId });
  }

  // TARGET_REQUIREMENT (D3-CAP-10): a required target — not nillable, not
  // defaulted — that is writable and deliverable, of the object of a record
  // mapping, which no decision of that record mapping satisfies. One question
  // per requirement; one candidate per plausible column of the record
  // mapping. A requirement no column could hold is no question: it blocks on
  // facts alone, and the draft names it.
  if (contractView.mode !== 'CLEAN_ONLY') {
    for (const [fileId, object] of objectOfFile) {
      const recordId = recordIdOf(fileId, object);
      if (recordId === null || object === null) continue;
      for (const target of targets.filter((entry) => entry.required && entry.writable && entry.destinationField !== '' && entry.object === object && !claimed.has(claimKey(recordId, entry.destinationField)))) {
        // The plausible columns, those whose header shares a word with the target's names first, at most MAX_REQUIREMENT_COLUMNS of them: a requirement is one bounded question, never one candidate per column of a wide file.
        const view = contractView.fields.find((entry) => entry.targetRef === target.targetRef);
        const names = [view?.label ?? '', view?.apiName ?? '', target.destinationField.split('.')[1] ?? ''].flatMap(wordsOf);
        const plausible = facts
          .filter((fact) => fact.field.fileId === fileId && fact.field.nonEmptyCount > 0 && !decidedFields.has(fact.field.fieldRef) && (fact.impliedSemantic === null || fact.impliedSemantic === target.semantic || target.semantic === 'TEXT'))
          .map((fact, order) => ({ fact, order, named: wordsOf(fact.field.header).some((word) => names.includes(word)) }))
          .sort((a, b) => Number(b.named) - Number(a.named) || a.order - b.order)
          .slice(0, MAX_REQUIREMENT_COLUMNS)
          .map((entry) => entry.fact);
        if (plausible.length === 0) continue;
        const refs = plausible.map(({ field, impliedSemantic }) => {
          const candidateRef = `cand_${digestOf(['derived-requirement', contracts.candidateSetHash, recordId, target.targetRef, field.fieldRef]).slice(0, 16)}`;
          const primitives = primitivesFor(impliedSemantic);
          const params = allowedParamValuesOf(primitives, field.shapeCandidates, locale);
          derived.push({ candidateRef, candidateType: REQUIREMENT_CANDIDATE_TYPE, sourceRefs: [field.fieldRef], allowedTargetRefs: [target.targetRef], allowedPrimitiveRefs: primitives, ...(params === undefined ? {} : { allowedParamValues: params }), evidenceRefs: field.evidenceRefs, impactCounts: { rows: field.nonEmptyCount, distinct: field.distinctCount }, constraints, derivedFrom: { candidateSetHash: contracts.candidateSetHash, candidateRef: null, rule: 'RESOLVER_REQUIREMENT_DECISION' } });
          return candidateRef;
        });
        questions.push({ questionRef: `q_${digestOf(['requirement', recordId, target.targetRef]).slice(0, 16)}`, taskType: 'TARGET_REQUIREMENT', fieldRefs: plausible.map((fact) => fact.field.fieldRef), candidateRefs: refs, reason: `a required target of ${object} no decision satisfies`, complexity: plausible.length, recordMappingId: recordId });
      }
    }
  }

  // Preservation default for every open column: abstention preserves, never drops. A type question is about a column already mapped, which nothing preserves; nor does any other question about a column this resolver mapped, whatever is asked about it.
  const preserved = new Set<string>();
  const fieldsByRef = new Map(profileView.fields.map((field) => [field.fieldRef, field]));
  for (const question of questions) {
    if (question.taskType === 'SEMANTIC_TYPE') continue;
    for (const fieldRef of question.fieldRefs) {
      if (preserved.has(fieldRef) || decidedFields.has(fieldRef)) continue;
      preserved.add(fieldRef);
      decisions.push({ decisionRef: `dec_${digestOf(['preserve', fieldRef]).slice(0, 16)}`, kind: 'PRESERVE_UNMAPPED', fieldRef, targetRef: null, semanticType: null, identityProof: null, rule: 'UNMAPPED_IS_PRESERVED', evidenceRefs: [], origin: 'DETERMINISTIC', recordId: recordIdOf(fieldsByRef.get(fieldRef)?.fileId ?? '', objectOfFile.get(fieldsByRef.get(fieldRef)?.fileId ?? '') ?? null), sourceFieldRef: fieldRef, destinationField: null, impactRows: fieldsByRef.get(fieldRef)?.nonEmptyCount ?? 0 });
    }
  }
  void SEMANTIC_TYPES;
  // The identity families (B03-CAP-IDENTITY): read the decisions above, never decide whether a column is preserved, so they come after the preservation default.
  const families = identityFamilies(contracts, options, objectOfFile, decisions);
  decisions.push(...families.decisions);
  questions.push(...families.questions);
  derived.push(...families.derived);
  return { decisions, openQuestions: questions, derivedCandidates: derived, valueCandidates, originalAnswers: families.answers, duplicateClusters: families.duplicateClusters };
}

/** The plausible columns a requirement question offers at most (D3-CAP-10). */
export const MAX_REQUIREMENT_COLUMNS = 32;

/** The words of a name, lower-cased, of three characters or more: what a header and a target's names share. */
const wordsOf = (text: string): string[] => text.normalize('NFKC').toLowerCase().split(/[^a-z0-9]+/u).filter((word) => word.length >= 3);

/** The primitives a column may carry into a destination, by the semantic type its full-data shape implies: preservation and trimming always, the type's own normalisation when there is one. */
function primitivesFor(impliedSemantic: string | null): string[] {
  return ['PRESERVE_AS_IS', 'TRIM_WHITESPACE', ...(impliedSemantic === 'EMAIL' ? ['NORMALISE_EMAIL_CASE'] : []), ...(impliedSemantic === 'PHONE' ? ['PARSE_PHONE_E164'] : []), ...(impliedSemantic === 'DATE' ? ['PARSE_DATE_ISO'] : []), ...(impliedSemantic === 'BOOLEAN' ? ['NORMALISE_BOOLEAN'] : []), ...(impliedSemantic === 'NUMBER' ? ['NORMALISE_NUMBER'] : [])];
}
