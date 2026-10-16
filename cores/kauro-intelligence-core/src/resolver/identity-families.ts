/**
 * The identity families of the resolver (B03-CAP-IDENTITY; closure plan
 * D3-CAP-06, D3-CAP-07, D3-CAP-08): what a record is keyed by, which records
 * the agency should look at as possible duplicates, and which column of one
 * record mapping names the records of another.
 *
 * - IDENTITY_STRATEGY (D3-CAP-06): identity comes only from proven authority —
 *   the record id column the project declares for a file, decided here, or a
 *   column the attested contract flags as an external id and the header names
 *   exactly, unique and populated on every row, which a proposal may adopt.
 *   A record mapping with such a column is asked one question, carrying it
 *   and every other unique, fully populated column of the file (an email, a
 *   name, an undeclared id) the model might be tempted to name; a record
 *   mapping without one is asked nothing, and its key candidates are
 *   IDENTITY_WITHOUT_PROOF on facts.
 * - DUPLICATE_SIGNAL_STRATEGY (D3-CAP-07): Migration Core's duplicate clusters
 *   of the dry run, grouped by the files their rows are in, are one question
 *   per group carrying the columns mapped on facts to a signal destination
 *   (email, phone, name, domain). Row refs are addresses, and they stay here:
 *   neither a cluster's rows, its ref nor its evidence — a digest over the
 *   shared value — ever enters an envelope; the question carries the columns
 *   and the counts.
 * - ASSOCIATION_MAPPING (D3-CAP-08): a column whose header names another
 *   object is one question when a record mapping of that object declares its
 *   record id and the contract offers a relationship between the two; one
 *   association ref per (key column, relationship, target record mapping).
 *
 * Nothing here reads a row or a value: profile facts, the contract, the
 * project's declarations and Migration Core's candidate set.
 */
import { RELATIONSHIP_SHAPES, RELATIONSHIP_TYPES, getAdapter } from 'kauro-migration-core';

import { canonicalObjectOf } from '../adapter/contract-adapter.js';
import type { AdaptedContracts } from '../adapter/contract-adapter.js';
import { clusterRowsDigest } from '../adapter/migration-effects.js';
import { digestOf } from '../contracts/canonical.js';
import { ASSOCIATION_CANDIDATE_TYPE, DUPLICATE_CANDIDATE_TYPE, IDENTITY_CANDIDATE_TYPE, associationRefOf, recordRefOf } from '../contracts/envelope.js';
import type { DeterministicCandidate, SourceFieldFact } from '../contracts/envelope.js';
import { recordMappingIdOf } from '../contracts/output-scope.js';
import type { OpenQuestion, ResolvedDecision, ResolveOptions } from './deterministic-resolver.js';

/** One of Migration Core's relationship types. */
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

const normalise = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '');
const tokensOf = (text: string): string[] => text.normalize('NFKC').toLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length >= 3);

/** The canonical object a header token names: a column that names another object refers to it (the compiler's foreign-key fact reads the same table). */
export const OBJECT_OF_TOKEN: Readonly<Record<string, string>> = Object.freeze({ contact: 'CONTACT', contacts: 'CONTACT', contacto: 'CONTACT', person: 'CONTACT', company: 'COMPANY', companies: 'COMPANY', account: 'COMPANY', accounts: 'COMPANY', organisation: 'COMPANY', organization: 'COMPANY', empresa: 'COMPANY', cuenta: 'COMPANY', deal: 'DEAL', deals: 'DEAL', opportunity: 'DEAL', opportunities: 'DEAL', negocio: 'DEAL', lead: 'LEAD', leads: 'LEAD' });

/** The canonical objects a header names. */
export function objectsNamedBy(header: string): ReadonlySet<string> {
  return new Set(tokensOf(header).flatMap((token) => (OBJECT_OF_TOKEN[token] === undefined ? [] : [OBJECT_OF_TOKEN[token] as string])));
}

/** The destinations Migration Core reads duplicate signals from: an email, an international phone, a full name, a company domain. */
export const SIGNAL_DESTINATIONS: ReadonlySet<string> = new Set(['contact.email', 'contact.phone', 'contact.firstName', 'contact.lastName', 'company.domain']);

/** How an original a family answers is answered (D3-ACC-2): by a derived candidate's disposition, or on facts alone. */
export type OriginalAnswer = { readonly by: string } | { readonly disposition: 'DETERMINISTIC' | 'PRESERVED'; readonly code: string };

/** One record mapping of the run: the file, the object it is delivered as, and the record id column the project declares for it. */
export interface RecordMappingView {
  readonly recordId: string;
  readonly fileId: string;
  readonly object: string;
  readonly declaredIdFieldRef: string | null;
}

/** Why an association is or is not offered (D3-CAP-08). */
export type AssociationStatus = 'OFFERED' | 'ASSOCIATION_ENDPOINT_UNDECLARED' | 'RELATIONSHIP_NOT_SUPPORTED' | 'KEY_DOES_NOT_NAME_TARGET';

/** One association a key column could stand for, and whether it is offered. */
export interface AssociationOption {
  readonly associationRef: string;
  readonly keyFieldRef: string;
  readonly ownerRecordId: string;
  readonly relationshipType: RelationshipType;
  readonly ownerSide: 'FROM' | 'TO';
  readonly targetObject: string;
  readonly targetRecordId: string;
  readonly targetRecordRef: string;
  readonly targetIdFieldRef: string | null;
  readonly status: AssociationStatus;
}

/** One duplicate cluster of Migration Core's candidate set, the question that answers it, and its rows as the review group names them. */
export interface DuplicateClusterView {
  /** Migration Core's DUPLICATE_CLUSTER candidate ref. */
  readonly clusterRef: string;
  /** The derived DUPLICATE_SIGNAL_STRATEGY candidate that answers it. */
  readonly candidateRef: string;
  readonly fileIds: readonly string[];
  readonly recordMappingIds: readonly string[];
  /** The columns of those files mapped on facts to a signal destination, by field ref. */
  readonly signalFieldRefs: readonly string[];
  /** Rows in the cluster, as Migration Core counted them. */
  readonly rows: number;
  /** The row addresses the set carried, sorted: all of them unless the cluster has more than a candidate may hold. */
  readonly rowLocators: readonly string[];
  /** clusterRowsDigest of the rows when the set carried every one; null when it could not. */
  readonly rowsDigest: string | null;
}

export interface IdentityFamilies {
  /** RECORD_ID_DECLARED, one per record mapping whose file the project declares a record id column for. */
  readonly decisions: readonly ResolvedDecision[];
  readonly questions: readonly OpenQuestion[];
  readonly derived: readonly DeterministicCandidate[];
  /** How each KEY_CANDIDATE and DUPLICATE_CLUSTER original is answered. */
  readonly answers: ReadonlyMap<string, OriginalAnswer>;
  readonly duplicateClusters: readonly DuplicateClusterView[];
}

/**
 * The contract fields a header names exactly that the attested contract flags
 * as an external id or an id lookup, on the given object — delivered by
 * Migration Core's adapter or not: identity authority is the contract's, and
 * an external id column is read for identity, not delivered as a field.
 * CLEAN_ONLY has no contract and lends no authority.
 */
export function externalIdAuthorityOf(contracts: AdaptedContracts, object: string, header: string): readonly string[] {
  if (contracts.contractView.mode === 'CLEAN_ONLY') return [];
  const key = normalise(header);
  if (key === '') return [];
  const mode = contracts.contractView.mode;
  return contracts.contractView.fields
    .filter((field) => contracts.refs.targetByRef.get(field.targetRef)?.identityAuthority === true && canonicalObjectOf(mode, field.objectApiName) === object && (normalise(field.label) === key || normalise(field.apiName) === key))
    .map((field) => field.targetRef);
}

/** The objects whose fields Migration Core's adapter delivers in this run: all four in CLEAN_ONLY, the contract's objects it maps in a vendor mode. */
function deliveredObjects(contracts: AdaptedContracts): ReadonlySet<string> {
  const objects = new Set<string>();
  for (const info of contracts.refs.targetByRef.values()) {
    const object = (info.destinationField.split('.')[0] ?? '').toUpperCase();
    if (object !== '') objects.add(object);
  }
  return objects;
}

/**
 * The relationship types the run offers (D3-CAP-08, the envelope's
 * allowedAssociationTypes): those Migration Core's adapter for the mode
 * supports, between two objects the support envelope delivers. A Salesforce
 * contact on an opportunity is an OpportunityContactRole the adapter does not
 * claim; a relationship to an object the contract does not carry is none.
 */
export function offeredRelationshipTypes(contracts: AdaptedContracts): readonly RelationshipType[] {
  const adapter = getAdapter(contracts.mode);
  const delivered = deliveredObjects(contracts);
  return RELATIONSHIP_TYPES.filter((type) => adapter.relationships[type].kind === 'SUPPORTED' && delivered.has(RELATIONSHIP_SHAPES[type].from) && delivered.has(RELATIONSHIP_SHAPES[type].to));
}

/** The record mappings of a run, from the resolver's own decisions: one per file whose object is decided, with the record id column the project declared for it. */
export function recordMappingsOf(contracts: AdaptedContracts, decisions: readonly ResolvedDecision[]): readonly RecordMappingView[] {
  const declared = new Map(decisions.filter((decision) => decision.kind === 'RECORD_ID_DECLARED' && decision.recordId !== null).map((decision) => [decision.recordId as string, decision.fieldRef]));
  const mappings = new Map<string, RecordMappingView>();
  for (const decision of decisions) {
    if (decision.kind !== 'IDENTITY_PROOF' || decision.recordId === null || mappings.has(decision.recordId)) continue;
    const fileId = contracts.refs.fieldByRef.get(decision.fieldRef)?.fileId;
    if (fileId === undefined) continue;
    const object = decision.recordId.slice(fileId.length + 1).toUpperCase();
    mappings.set(decision.recordId, { recordId: decision.recordId, fileId, object, declaredIdFieldRef: declared.get(decision.recordId) ?? null });
  }
  return [...mappings.values()].sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0));
}

/**
 * Every association a key column of an owner record mapping could stand for:
 * each relationship type toward each other record mapping of the run, with
 * why it is or is not offered — the shape of the relationship must join the
 * two objects and the run must offer it (else RELATIONSHIP_NOT_SUPPORTED),
 * the target must declare its record id, which the key's values name (else
 * ASSOCIATION_ENDPOINT_UNDECLARED), and the key's header must name the
 * target's object. The resolver offers the OFFERED ones; the compiler reads
 * the same universe to refuse any other by name.
 */
export function associationUniverse(key: Pick<SourceFieldFact, 'fieldRef' | 'header'>, owner: RecordMappingView, recordMappings: readonly RecordMappingView[], offered: readonly string[]): readonly AssociationOption[] {
  const named = objectsNamedBy(key.header);
  const options: AssociationOption[] = [];
  for (const target of recordMappings) {
    if (target.recordId === owner.recordId) continue;
    const targetRecordRef = recordRefOf(target.recordId);
    for (const relationshipType of RELATIONSHIP_TYPES) {
      const shape = RELATIONSHIP_SHAPES[relationshipType];
      const ownerSide = shape.from === owner.object && shape.to === target.object ? 'FROM' : shape.from === target.object && shape.to === owner.object ? 'TO' : null;
      const status: AssociationStatus = ownerSide === null || !offered.includes(relationshipType) ? 'RELATIONSHIP_NOT_SUPPORTED' : target.declaredIdFieldRef === null ? 'ASSOCIATION_ENDPOINT_UNDECLARED' : !named.has(target.object) ? 'KEY_DOES_NOT_NAME_TARGET' : 'OFFERED';
      options.push({ associationRef: associationRefOf(key.fieldRef, relationshipType, targetRecordRef), keyFieldRef: key.fieldRef, ownerRecordId: owner.recordId, relationshipType, ownerSide: ownerSide ?? 'FROM', targetObject: target.object, targetRecordId: target.recordId, targetRecordRef, targetIdFieldRef: target.declaredIdFieldRef, status });
    }
  }
  return options;
}

/** The association a ref names for a key column, in the run's universe; undefined when it names none of them. */
export function associationOptionOf(contracts: AdaptedContracts, decisions: readonly ResolvedDecision[], keyFieldRef: string, associationRef: string): AssociationOption | undefined {
  const field = contracts.profileView.fields.find((entry) => entry.fieldRef === keyFieldRef);
  if (field === undefined) return undefined;
  const mappings = recordMappingsOf(contracts, decisions);
  const recordId = decisions.find((decision) => decision.kind === 'IDENTITY_PROOF' && decision.fieldRef === keyFieldRef)?.recordId ?? null;
  const owner = mappings.find((mapping) => mapping.recordId === recordId);
  if (owner === undefined) return undefined;
  return associationUniverse(field, owner, mappings, offeredRelationshipTypes(contracts)).find((option) => option.associationRef === associationRef);
}

/** The ref of an identity candidate, a duplicate candidate and an association candidate: stable, from structure alone. */
const identityCandidateRefOf = (candidateSetHash: string, fieldRef: string): string => `cand_${digestOf(['derived-identity', candidateSetHash, fieldRef]).slice(0, 16)}`;
const duplicateCandidateRefOf = (candidateSetHash: string, fileIds: readonly string[]): string => `cand_${digestOf(['derived-duplicate', candidateSetHash, fileIds]).slice(0, 16)}`;
const associationCandidateRefOf = (candidateSetHash: string, fieldRef: string): string => `cand_${digestOf(['derived-association', candidateSetHash, fieldRef]).slice(0, 16)}`;

const NO_AUTHORITY = { destructiveAllowed: false, identityAutoMergeAllowed: false } as const;

/**
 * The identity families of one resolution, from the file objects and the
 * decisions the resolver made: the record id declarations, the identity,
 * duplicate and association questions with their candidates, and how each
 * KEY_CANDIDATE and DUPLICATE_CLUSTER original is answered.
 */
export function identityFamilies(contracts: AdaptedContracts, options: ResolveOptions, objectOfFile: ReadonlyMap<string, string | null>, resolved: readonly ResolvedDecision[]): IdentityFamilies {
  const { profileView, refs } = contracts;
  const setHash = contracts.candidateSetHash;
  const decisions: ResolvedDecision[] = [];
  const questions: OpenQuestion[] = [];
  const derived: DeterministicCandidate[] = [];
  const answers = new Map<string, OriginalAnswer>();
  const fieldsOf = (fileId: string): readonly SourceFieldFact[] => profileView.fields.filter((field) => field.fileId === fileId);
  const pathOf = (fileId: string): string => [...refs.fieldByRef.values()].find((entry) => entry.fileId === fileId)?.filePath ?? fileId;
  const proofOf = new Map(resolved.filter((decision) => decision.kind === 'IDENTITY_PROOF').map((decision) => [decision.fieldRef, decision.identityProof]));
  const originalsOn = (fieldRef: string, type: string): readonly DeterministicCandidate[] => contracts.candidates.filter((candidate) => candidate.candidateType === type && candidate.sourceRefs.includes(fieldRef));

  // ------------------------------------------------------------------- the record id each file declares
  const declaredIdOf = new Map<string, string>(); // fileId → fieldRef
  const fileIds = [...new Set(profileView.fields.map((field) => field.fileId))];
  for (const fileId of fileIds) {
    const header = options.recordIdColumns?.[pathOf(fileId)] ?? options.recordIdColumns?.[fileId];
    if (header === undefined || normalise(header) === '') continue;
    // The first column of the file under the declared header, as the configuration's record mapping names it.
    const column = [...fieldsOf(fileId)].filter((field) => normalise(field.header) === normalise(header)).sort((a, b) => (refs.fieldByRef.get(a.fieldRef)?.columnIndex ?? 0) - (refs.fieldByRef.get(b.fieldRef)?.columnIndex ?? 0))[0];
    if (column === undefined) continue;
    declaredIdOf.set(fileId, column.fieldRef);
    const object = objectOfFile.get(fileId) ?? null;
    const recordId = object === null ? null : recordMappingIdOf(fileId, object);
    decisions.push({ decisionRef: `dec_${digestOf(['record-id', fileId, column.fieldRef]).slice(0, 16)}`, kind: 'RECORD_ID_DECLARED', fieldRef: column.fieldRef, targetRef: null, semanticType: null, identityProof: proofOf.get(column.fieldRef) ?? null, rule: 'DECLARED_RECORD_ID_COLUMN', evidenceRefs: column.evidenceRefs, origin: 'DETERMINISTIC', recordId, sourceFieldRef: column.fieldRef, destinationField: null, impactRows: column.nonEmptyCount });
  }

  // ------------------------------------------------------------------- IDENTITY_STRATEGY (D3-CAP-06)
  for (const fileId of fileIds) {
    const object = objectOfFile.get(fileId) ?? null;
    const declared = declaredIdOf.get(fileId) ?? null;
    // Unique among its values and populated on every row: what Migration Core lists as a key candidate, read off the same profile.
    const keyLike = fieldsOf(fileId).filter((field) => field.fieldRef !== declared && field.nonEmptyCount > 0 && field.nonEmptyCount === field.rowCount && field.uniqueAmongNonEmpty === true);
    const proven = object === null ? [] : keyLike.filter((field) => proofOf.get(field.fieldRef) === 'PROVEN_UNIQUE_IDENTIFIER');
    const asked = new Set<string>();
    if (object !== null && proven.length > 0) {
      const recordId = recordMappingIdOf(fileId, object);
      const candidates = keyLike.map((field): DeterministicCandidate => {
        const key = originalsOn(field.fieldRef, 'KEY_CANDIDATE')[0] ?? null;
        return {
          candidateRef: identityCandidateRefOf(setHash, field.fieldRef),
          candidateType: IDENTITY_CANDIDATE_TYPE,
          sourceRefs: [field.fieldRef],
          allowedTargetRefs: [],
          // What the column may become: an authoritative external id only where the contract's authority proves it; nothing otherwise.
          allowedPrimitiveRefs: proofOf.get(field.fieldRef) === 'PROVEN_UNIQUE_IDENTIFIER' ? ['AUTHORITATIVE_EXTERNAL_ID_COLUMN'] : [],
          evidenceRefs: [...new Set([...field.evidenceRefs, ...(key?.evidenceRefs ?? [])])],
          impactCounts: { rows: field.nonEmptyCount, distinct: field.distinctCount },
          constraints: NO_AUTHORITY,
          derivedFrom: { candidateSetHash: setHash, candidateRef: key?.candidateRef ?? null, rule: 'RESOLVER_IDENTITY_DECISION' },
        };
      });
      for (const candidate of candidates) {
        derived.push(candidate);
        asked.add(candidate.sourceRefs[0] ?? '');
      }
      questions.push({ questionRef: `q_${digestOf(['identity', recordId]).slice(0, 16)}`, taskType: 'IDENTITY_STRATEGY', fieldRefs: keyLike.map((field) => field.fieldRef), candidateRefs: candidates.map((candidate) => candidate.candidateRef), reason: `${String(proven.length)} column(s) the contract names as an external id are unique and populated on every row`, complexity: Math.max(1, candidates.length), recordMappingId: recordId });
    }
    // Every key candidate Migration Core listed on a column of the file keeps one disposition: the declaration, the question about it, or no proof.
    for (const field of fieldsOf(fileId)) {
      for (const key of originalsOn(field.fieldRef, 'KEY_CANDIDATE')) {
        if (field.fieldRef === declared) answers.set(key.candidateRef, { disposition: 'DETERMINISTIC', code: 'DECLARED_RECORD_ID' });
        else if (asked.has(field.fieldRef)) answers.set(key.candidateRef, { by: identityCandidateRefOf(setHash, field.fieldRef) });
        else answers.set(key.candidateRef, { disposition: 'DETERMINISTIC', code: 'IDENTITY_WITHOUT_PROOF' });
      }
    }
  }
  // A key candidate on a column the profile view does not carry has no file to be read in.
  for (const key of contracts.candidates.filter((candidate) => candidate.candidateType === 'KEY_CANDIDATE')) if (!answers.has(key.candidateRef)) answers.set(key.candidateRef, { disposition: 'DETERMINISTIC', code: 'IDENTITY_WITHOUT_PROOF' });

  // ------------------------------------------------------------------- DUPLICATE_SIGNAL_STRATEGY (D3-CAP-07)
  const recordIdOfFile = (fileId: string): string | null => {
    const object = objectOfFile.get(fileId) ?? null;
    return object === null ? null : recordMappingIdOf(fileId, object);
  };
  const signalColumnsOf = (fileId: string): readonly string[] =>
    resolved
      .filter((decision) => decision.kind === 'FIELD_MAPPING' && decision.destinationField !== null && SIGNAL_DESTINATIONS.has(decision.destinationField) && refs.fieldByRef.get(decision.fieldRef)?.fileId === fileId)
      .map((decision) => decision.fieldRef);
  const duplicateClusters: DuplicateClusterView[] = [];
  const scopes = new Map<string, { fileIds: readonly string[]; clusters: { clusterRef: string; rows: number; rowLocators: readonly string[] }[] }>();
  for (const original of contracts.candidateSet.candidates) {
    if (original.candidateType !== 'DUPLICATE_CLUSTER') continue;
    // A row address names its file: `<fileId>:<sheetId>:R<row>`. The addresses stay in this process.
    const rowLocators = [...new Set(original.sourceRefs)].sort();
    const scopeFiles = [...new Set(rowLocators.map((locator) => locator.slice(0, locator.indexOf(':'))))].filter((fileId) => fileId !== '').sort();
    const key = scopeFiles.join('|');
    const scope = scopes.get(key) ?? { fileIds: scopeFiles, clusters: [] };
    scope.clusters.push({ clusterRef: original.candidateRef, rows: original.impactCounts['rows'] ?? rowLocators.length, rowLocators });
    scopes.set(key, scope);
  }
  for (const { fileIds: scopeFiles, clusters } of [...scopes.values()].sort((a, b) => (a.fileIds.join('|') < b.fileIds.join('|') ? -1 : 1))) {
    const signalFieldRefs = [...new Set(scopeFiles.flatMap(signalColumnsOf))].sort().slice(0, 64);
    const fields = signalFieldRefs.map((fieldRef) => profileView.fields.find((field) => field.fieldRef === fieldRef)).filter((field): field is SourceFieldFact => field !== undefined);
    const candidateRef = duplicateCandidateRefOf(setHash, scopeFiles);
    const recordMappingIds = scopeFiles.map(recordIdOfFile).filter((recordId): recordId is string => recordId !== null);
    derived.push({
      candidateRef,
      candidateType: DUPLICATE_CANDIDATE_TYPE,
      sourceRefs: signalFieldRefs,
      allowedTargetRefs: [],
      // What a proposal may do with a cluster the engine refused to merge: ask a person to look at it.
      allowedPrimitiveRefs: ['REVIEW_ONLY'],
      evidenceRefs: [...new Set(fields.flatMap((field) => field.evidenceRefs))],
      impactCounts: { rows: clusters.reduce((total, cluster) => total + cluster.rows, 0), distinct: clusters.length },
      constraints: NO_AUTHORITY,
      // The cluster's own ref is a digest over the value its rows share: it answers this question from here, and never travels.
      derivedFrom: { candidateSetHash: setHash, candidateRef: null, rule: 'RESOLVER_DUPLICATE_SIGNAL' },
    });
    questions.push({ questionRef: `q_${digestOf(['duplicate', scopeFiles]).slice(0, 16)}`, taskType: 'DUPLICATE_SIGNAL_STRATEGY', fieldRefs: signalFieldRefs, candidateRefs: [candidateRef], reason: `Migration Core reported ${String(clusters.length)} duplicate cluster(s)`, complexity: 1, recordMappingId: recordMappingIds[0] ?? null });
    for (const cluster of clusters) {
      answers.set(cluster.clusterRef, { by: candidateRef });
      duplicateClusters.push({ clusterRef: cluster.clusterRef, candidateRef, fileIds: scopeFiles, recordMappingIds, signalFieldRefs, rows: cluster.rows, rowLocators: cluster.rowLocators, rowsDigest: cluster.rows === cluster.rowLocators.length ? clusterRowsDigest(cluster.rowLocators) : null });
    }
  }

  // ------------------------------------------------------------------- ASSOCIATION_MAPPING (D3-CAP-08)
  const allDecisions = [...resolved, ...decisions];
  const mappings = recordMappingsOf(contracts, allDecisions);
  const offered = offeredRelationshipTypes(contracts);
  for (const owner of mappings) {
    for (const field of fieldsOf(owner.fileId)) {
      if (field.nonEmptyCount === 0 || field.fieldRef === owner.declaredIdFieldRef) continue;
      const named = objectsNamedBy(field.header);
      if (named.size === 0 || [...named].every((object) => object === owner.object)) continue;
      const options = associationUniverse(field, owner, mappings, offered).filter((option) => option.status === 'OFFERED');
      if (options.length === 0) continue;
      const targetIds = [...new Set(options.map((option) => option.targetIdFieldRef).filter((ref): ref is string => ref !== null))];
      const targetFields = targetIds.map((fieldRef) => profileView.fields.find((entry) => entry.fieldRef === fieldRef)).filter((entry): entry is SourceFieldFact => entry !== undefined);
      const candidateRef = associationCandidateRefOf(setHash, field.fieldRef);
      derived.push({
        candidateRef,
        candidateType: ASSOCIATION_CANDIDATE_TYPE,
        // The key column first — what the item is about — then the target record mappings' declared id columns its values would name.
        sourceRefs: [field.fieldRef, ...targetIds],
        allowedTargetRefs: options.map((option) => option.associationRef),
        allowedPrimitiveRefs: [],
        evidenceRefs: [...new Set([...field.evidenceRefs, ...targetFields.flatMap((entry) => entry.evidenceRefs)])],
        impactCounts: { rows: field.nonEmptyCount, distinct: field.distinctCount },
        constraints: NO_AUTHORITY,
        derivedFrom: { candidateSetHash: setHash, candidateRef: null, rule: 'RESOLVER_ASSOCIATION_DECISION' },
      });
      questions.push({ questionRef: `q_${digestOf(['association', field.fieldRef]).slice(0, 16)}`, taskType: 'ASSOCIATION_MAPPING', fieldRefs: [field.fieldRef], candidateRefs: [candidateRef], reason: `the header names ${[...named].sort().join(', ')}, a record mapping of which declares its record id`, complexity: options.length, recordMappingId: owner.recordId });
    }
  }
  return { decisions, questions, derived, answers, duplicateClusters };
}
