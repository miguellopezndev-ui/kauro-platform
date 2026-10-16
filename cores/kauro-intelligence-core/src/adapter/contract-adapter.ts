/**
 * The Contract Adapter: Migration Core's frozen objects, read through its
 * own loaders, projected into the views the envelope carries.
 *
 * Nothing here recomputes a statistic. Every fact in a view is copied from a
 * field of the profile, the candidate set or the target contract, and every
 * ref this core mints is derived from the locator it stands for, so the same
 * profile yields the same refs. The adapter keeps the table from minted refs
 * back to the locators and evidence strings, because the compiler has to
 * check that a proposal's refs name things that exist.
 */
import { CANONICAL_FIELD_LIST, RELATIONSHIP_TYPES, getAdapter } from 'kauro-migration-core';
import type { CandidateSetV1, HashedCandidateSet, HashedSourceProfile, HashedTargetContract, SourceProfileV1, TargetMode } from 'kauro-migration-core';

import { digestOf } from '../contracts/canonical.js';
import { cleanOnlyTargetRef } from '../contracts/envelope.js';
import type { CleanOnlyContractView, DeterministicCandidate, SourceFieldFact, SourceProfileView, TargetContractView, TargetFieldView } from '../contracts/envelope.js';
import { IntelligenceError } from '../contracts/errors.js';
import { ENVELOPE_SCHEMA_VERSION, compatibilityProblems } from '../contracts/versions.js';

/**
 * The header as the facts carry it: the profile's raw header without a byte-order
 * mark or a zero-width space, which a spreadsheet export or a paste leaves in
 * front of or inside a name and which make the privacy layer treat the whole
 * header as suspicious. Only these two are dropped; every other control or
 * bidirectional character stays and keeps the header masked, and what remains
 * is classified like any header, so a secret or an address split by one of the
 * two is read for what it is. The raw header stays in the profile, which the
 * field's evidence names, and in the table's `headerRaw`.
 */
export function displayHeader(raw: string | null): string {
  return (raw ?? '').replace(/[\u200b\ufeff]/gu, '');
}

export interface RefTable {
  /** fieldRef → Migration Core column locator */
  readonly fieldByRef: ReadonlyMap<string, { locator: string; fileId: string; filePath: string; sheetId: string; header: string; headerRaw: string; columnIndex: number }>;
  readonly refByLocator: ReadonlyMap<string, string>;
  /** evidenceRef → Migration Core evidence string */
  readonly evidenceByRef: ReadonlyMap<string, string>;
  /**
   * targetRef → destination field (canonical name for CLEAN_ONLY; contract
   * field for a vendor), its label, and whether the contract declares the
   * field an authoritative identifier (externalId or idLookup). That flag is
   * the only identity authority a vendor contract lends a source column;
   * CLEAN_ONLY's canonical fields lend none.
   */
  readonly targetByRef: ReadonlyMap<string, TargetInfo>;
}

export interface TargetInfo {
  readonly destinationField: string;
  readonly apiName: string;
  readonly objectApiName: string;
  readonly label: string;
  readonly identityAuthority: boolean;
}

export interface AdaptedContracts {
  readonly mode: TargetMode;
  readonly profileView: SourceProfileView;
  readonly contractView: TargetContractView | CleanOnlyContractView;
  readonly candidates: readonly DeterministicCandidate[];
  readonly candidateSetHash: string;
  readonly profileHash: string;
  readonly targetContractHash: string | null;
  readonly refs: RefTable;
  readonly candidateSet: CandidateSetV1;
}

/** The canonical object each vendor object of the contract is delivered as; anything else is outside the support envelope. */
const CANONICAL_OBJECT_OF: Readonly<Record<'HUBSPOT' | 'SALESFORCE', Readonly<Record<string, string>>>> = Object.freeze({
  HUBSPOT: Object.freeze({ contact: 'CONTACT', contacts: 'CONTACT', company: 'COMPANY', companies: 'COMPANY', deal: 'DEAL', deals: 'DEAL' }),
  SALESFORCE: Object.freeze({ contact: 'CONTACT', account: 'COMPANY', lead: 'LEAD', opportunity: 'DEAL' }),
});
const normaliseName = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/gu, '');

/** The canonical object a vendor object of the contract is delivered as, or null outside the support envelope; CLEAN_ONLY's objects are canonical already. */
export function canonicalObjectOf(mode: TargetMode, objectApiName: string): string | null {
  if (mode === 'CLEAN_ONLY') return objectApiName.toUpperCase();
  return CANONICAL_OBJECT_OF[mode][objectApiName.toLowerCase()] ?? null;
}

export const fieldRefFor = (locator: string): string => `fld_${digestOf(`field:${locator}`).slice(0, 16)}`;
export const evidenceRefFor = (evidence: string): string => `ev_${digestOf(`evidence:${evidence}`).slice(0, 16)}`;
export const vendorTargetRefFor = (mode: string, objectApiName: string, apiName: string): string => `tgt_${digestOf(`${mode}:${objectApiName}:${apiName}`).slice(0, 16)}`;

function fieldFacts(profile: SourceProfileV1, profileHash: string, table: { fieldByRef: Map<string, { locator: string; fileId: string; filePath: string; sheetId: string; header: string; headerRaw: string; columnIndex: number }>; refByLocator: Map<string, string>; evidenceByRef: Map<string, string> }): SourceFieldFact[] {
  const facts: SourceFieldFact[] = [];
  for (const file of profile.files) {
    for (const sheet of file.sheets) {
      for (const column of sheet.columns) {
        const locator = column.columnLocatorId;
        const fieldRef = fieldRefFor(locator);
        const evidence = `profile:${profileHash}#${locator}`;
        const evidenceRef = evidenceRefFor(evidence);
        table.fieldByRef.set(fieldRef, { locator, fileId: file.fileId, filePath: file.path, sheetId: sheet.sheetId, header: displayHeader(column.headerRaw), headerRaw: column.headerRaw ?? '', columnIndex: column.columnIndex });
        table.refByLocator.set(locator, fieldRef);
        table.evidenceByRef.set(evidenceRef, evidence);
        const shapes = Object.entries(column.shapes)
          .filter(([, count]) => count > 0)
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
          .map(([name]) => name);
        facts.push({
          fieldRef,
          fileId: file.fileId,
          sheet: sheet.sheetId,
          header: displayHeader(column.headerRaw),
          rowCount: sheet.dataRowCount,
          // `populated` counts cells holding at least one character; blank
          // cells are counted separately, not inside it.
          nonEmptyCount: column.populated,
          distinctCount: column.distinctValues,
          uniqueAmongNonEmpty: column.uniqueAcrossPopulatedRows,
          shapeCandidates: shapes,
          lengthMin: null,
          lengthMax: column.maxValueLength,
          evidenceRefs: [evidenceRef],
        });
      }
    }
  }
  return facts;
}

function vendorView(contract: HashedTargetContract, table: Map<string, TargetInfo>): TargetContractView {
  const mode = contract.contract.instance.mode;
  if (mode !== 'HUBSPOT' && mode !== 'SALESFORCE') throw new IntelligenceError('CONTRACT_VIOLATION', `a target contract for ${String(mode)} is not a vendor contract`);
  const adapter = getAdapter(mode);
  const fields: TargetFieldView[] = [];
  for (const object of contract.contract.objects) {
    for (const field of object.fields) {
      const targetRef = vendorTargetRefFor(mode, object.apiName, field.apiName);
      // The destination field this vendor field is delivered through, from
      // Migration Core's own adapter — the support envelope: a vendor field
      // no adapter object delivers has no destination field and cannot be
      // mapped, whatever its label suggests.
      const canonicalObject = CANONICAL_OBJECT_OF[mode][object.apiName.toLowerCase()] ?? null;
      const spec = canonicalObject === null ? undefined : adapter.objects.find((entry) => entry.object === canonicalObject);
      const names = new Set([normaliseName(field.apiName), normaliseName(field.label)]);
      const deliverable = spec?.fields.find((entry) => names.has(normaliseName(entry.header)) || names.has(normaliseName(entry.canonicalField.split('.')[1] ?? entry.canonicalField)));
      table.set(targetRef, { destinationField: deliverable?.canonicalField ?? '', apiName: field.apiName, objectApiName: object.apiName, label: field.label, identityAuthority: field.externalId === 'TRUE' || field.idLookup === 'TRUE' });
      fields.push({
        targetRef,
        objectApiName: object.apiName,
        apiName: field.apiName,
        label: field.label,
        type: field.type,
        createable: field.createable === 'TRUE',
        updateable: field.updateable === 'TRUE',
        required: field.nillable === 'FALSE' && field.defaultedOnCreate !== 'TRUE',
        unique: field.unique === 'TRUE',
        options: field.picklistValues.map((value) => value.value),
      });
    }
  }
  return {
    targetContractVersion: contract.contract.contractVersion,
    contractHash: contract.contractHash,
    mode,
    instanceId: contract.contract.instance.instanceId,
    fields,
    relationshipTypes: [...RELATIONSHIP_TYPES],
  };
}

function cleanOnlyView(table: Map<string, TargetInfo>): CleanOnlyContractView {
  for (const name of CANONICAL_FIELD_LIST) table.set(cleanOnlyTargetRef(name), { destinationField: name, apiName: name, objectApiName: name.split('.')[0] ?? name, label: name.split('.')[1] ?? name, identityAuthority: false });
  return { mode: 'CLEAN_ONLY', canonicalFields: [...CANONICAL_FIELD_LIST], relationshipTypes: [...RELATIONSHIP_TYPES] };
}

/**
 * Project the frozen objects. Refuses a candidate set that is not the
 * profile's, a profile or contract at a version this core does not accept,
 * and a vendor contract handed to a CLEAN_ONLY run or none handed to a vendor
 * run: a CLEAN_ONLY run has no pseudo vendor truth.
 */
export function adaptContracts(input: { mode: TargetMode; profile: HashedSourceProfile; candidateSet: HashedCandidateSet; targetContract: HashedTargetContract | null }): AdaptedContracts {
  const { mode, profile, candidateSet, targetContract } = input;
  const versionProblems = compatibilityProblems({
    envelopeSchemaVersion: ENVELOPE_SCHEMA_VERSION,
    sourceProfileVersion: profile.profile.profileVersion,
    candidateSetVersion: candidateSet.candidateSet.candidateSetVersion,
    targetContractVersion: targetContract?.contract.contractVersion ?? null,
    coreVersion: candidateSet.candidateSet.refs.coreVersion,
    configSchemaVersion: candidateSet.candidateSet.refs.configSchemaVersion,
  });
  if (versionProblems.length > 0) throw new IntelligenceError('INCOMPATIBLE_CONTRACT_VERSION', versionProblems.join('; '), { problems: versionProblems });
  if (candidateSet.candidateSet.refs.profileHash !== profile.profileHash) throw new IntelligenceError('STALE_INPUT', `the candidate set was built over profile ${candidateSet.candidateSet.refs.profileHash.slice(0, 12)}, the profile is ${profile.profileHash.slice(0, 12)}`);
  if (candidateSet.candidateSet.refs.bundleId !== profile.profile.bundleId) throw new IntelligenceError('STALE_INPUT', 'the candidate set names another bundle');
  if (mode === 'CLEAN_ONLY' && targetContract !== null) throw new IntelligenceError('CONTRACT_VIOLATION', 'CLEAN_ONLY addresses no vendor instance; a target contract for it describes something the run is not doing');
  if (mode !== 'CLEAN_ONLY' && targetContract === null) throw new IntelligenceError('CONTRACT_VIOLATION', `${mode} addresses a real instance and needs its attested target contract`);
  if (targetContract !== null && targetContract.contract.instance.mode !== mode) throw new IntelligenceError('CONTRACT_VIOLATION', `the target contract is for ${targetContract.contract.instance.mode}, the run is ${mode}`);

  const fieldByRef = new Map<string, { locator: string; fileId: string; filePath: string; sheetId: string; header: string; headerRaw: string; columnIndex: number }>();
  const refByLocator = new Map<string, string>();
  const evidenceByRef = new Map<string, string>();
  const targetByRef = new Map<string, TargetInfo>();
  const fields = fieldFacts(profile.profile, profile.profileHash, { fieldByRef, refByLocator, evidenceByRef });
  const contractView = targetContract === null ? cleanOnlyView(targetByRef) : vendorView(targetContract, targetByRef);

  const candidates: DeterministicCandidate[] = candidateSet.candidateSet.candidates.map((candidate) => {
    for (const evidence of candidate.evidenceRefs) evidenceByRef.set(evidenceRefFor(evidence), evidence);
    return {
      candidateRef: candidate.candidateRef,
      candidateType: candidate.candidateType,
      sourceRefs: candidate.sourceRefs.map((locator) => refByLocator.get(locator) ?? fieldRefFor(locator)),
      // Migration Core's producers leave allowedTargetRefs empty: an empty list
      // is not a wildcard. The resolver derives decision candidates with
      // explicit targets under its own rule; this one decides no destination.
      allowedTargetRefs: [],
      allowedPrimitiveRefs: [...candidate.allowedPrimitiveRefs],
      evidenceRefs: candidate.evidenceRefs.map(evidenceRefFor),
      impactCounts: { rows: candidate.impactCounts['rows'] ?? 0, distinct: candidate.impactCounts['distinct'] ?? null },
      constraints: { destructiveAllowed: false, identityAutoMergeAllowed: false },
      derivedFrom: { candidateSetHash: candidateSet.candidateSetHash, candidateRef: candidate.candidateRef, rule: 'MIGRATION_CORE_CANDIDATE' },
    };
  });

  return {
    mode,
    profileView: { sourceProfileVersion: profile.profile.profileVersion, profileHash: profile.profileHash, bundleId: profile.profile.bundleId, dataRowCount: profile.profile.totals.dataRowCount, fields },
    contractView,
    candidates,
    candidateSetHash: candidateSet.candidateSetHash,
    profileHash: profile.profileHash,
    targetContractHash: targetContract?.contractHash ?? null,
    refs: { fieldByRef, refByLocator, evidenceByRef, targetByRef },
    candidateSet: candidateSet.candidateSet,
  };
}
