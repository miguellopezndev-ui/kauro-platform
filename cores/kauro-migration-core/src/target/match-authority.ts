import { MigrationError } from '../domain/errors.js';
import type { DestinationMatchConfig, MigrationConfig, TargetMode } from '../domain/config.js';
import { ALL_ADAPTERS } from '../adapters/specs.js';
import type { DestinationAdapter } from '../adapters/adapter.js';
import type { CanonicalObject } from '../domain/canonical.js';
import type { HashedTargetContract, TargetFieldContract, TargetObjectContract } from './contract.js';
import { findField, findObject, isDefinitely } from './contract.js';

/**
 * Destination match authority.
 *
 * The engine will not match a record against a destination on anything it
 * cannot show evidence for. That evidence is a captured target contract, and
 * this module is the single place that decides whether a declared match
 * satisfies it.
 *
 * Three rules do most of the work here, and each exists because breaking it
 * loses somebody's data:
 *
 *   A key Kauro made up is never a match key. Kauro's own keys -- the trace key
 *   that follows a delivered record back to its source rows, and the
 *   import-scoped association key that lets a destination join two files --
 *   say nothing about what already exists in an instance. Matching on one
 *   would mean asking the agency to create a unique property or an External ID
 *   inside their own instance purely so that Kauro can work, and would then
 *   match on a value a later export can change.
 *
 *   External ID is not Unique. Salesforce documents them as separate attributes.
 *   An upsert on an External ID field that is not unique can match two records,
 *   and the caller finds out by losing one of them.
 *
 *   Unknown is not false, and it is not true either. A contract that does not
 *   establish an attribute has not established it, and a match that needs that
 *   attribute is refused rather than attempted.
 */

/**
 * A decision this engine cannot make and will not fake.
 *
 * The agency creates the field outside Kauro, recaptures the target schema, and
 * comes back. Kauro does not create fields inside a customer's instance, so
 * there is no path here that resolves this by acting.
 */
export const REQUIRES_AGENCY_DECISION = 'REQUIRES_AGENCY_DECISION';

export interface MatchAuthorityDecision {
  readonly recordMappingId: string;
  readonly matchAuthority: DestinationMatchConfig['matchAuthority'];
  readonly targetField: string | null;
  readonly sourceField: string | null;
  /** The contract field the authority resolved to, for the audit trail. Null for RECORD_ID and NONE. */
  readonly resolvedField: TargetFieldContract | null;
  readonly contractHash: string;
}

/**
 * The field each destination uses to name an existing record by its own id.
 *
 * These are the vendor's own identifiers rather than anything Kauro introduces,
 * which is why they are the one authority that needs no captured field.
 */
const RECORD_ID_FIELD: Readonly<Record<TargetMode, string | null>> = {
  HUBSPOT: 'hs_object_id',
  SALESFORCE: 'Id',
  CLEAN_ONLY: null,
};

function fail(message: string, remedy: string, details: Record<string, string | number | boolean | null>): never {
  throw new MigrationError('DESTINATION_MATCH_UNSATISFIED', message, remedy, details);
}

/**
 * Check every declared match against the captured contract.
 *
 * Returns one decision per declaration so the package can record what was
 * matched on and why it was allowed, rather than leaving the reader to infer it
 * from the import file.
 */
export function resolveMatchAuthority(
  config: MigrationConfig,
  adapter: DestinationAdapter,
  hashed: HashedTargetContract | null,
): readonly MatchAuthorityDecision[] {
  const mode = config.target.mode;
  const importMode = config.target.importMode;
  const matches = config.destinationMatching;

  // A contract that describes a different destination than the one this run
  // is addressed to is refused before anything else is decided, in every
  // import mode. It used to be checked only on the matching path, so a
  // CREATE_ONLY run never compared the two and a HUBSPOT plan ran against a
  // SALESFORCE contract (audit MC-01).
  if (hashed !== null && hashed.contract.instance.mode !== mode) {
    fail(
      `the supplied target contract describes ${hashed.contract.instance.mode}, but this run targets ${mode}`,
      'Supply the target contract captured from the instance this run is addressed to.',
      { contractMode: hashed.contract.instance.mode, mode, importMode },
    );
  }

  // CREATE_ONLY matches nothing, so a declaration would be a claim about
  // behaviour that never happens.
  if (importMode === 'CREATE_ONLY') {
    for (const declaration of matches) {
      if (declaration.matchAuthority !== 'NONE') {
        fail(
          `record mapping "${declaration.recordMappingId}" declares match authority ${declaration.matchAuthority} under CREATE_ONLY`,
          'A create-only import never matches an existing record. Remove the declaration, or choose UPDATE_ONLY or UPSERT.',
          { recordMappingId: declaration.recordMappingId, importMode },
        );
      }
    }
    return matches.map((declaration) => ({
      recordMappingId: declaration.recordMappingId,
      matchAuthority: 'NONE' as const,
      targetField: null,
      sourceField: null,
      resolvedField: null,
      contractHash: hashed?.contractHash ?? '',
    }));
  }

  // CLEAN_ONLY has no instance, so there is nothing to match against and no
  // contract that could authorise it.
  if (mode === 'CLEAN_ONLY') {
    fail(
      `CLEAN_ONLY cannot run in ${importMode}`,
      'CLEAN_ONLY has no destination instance, so there is no record to update. Use CREATE_ONLY, or choose HUBSPOT or SALESFORCE.',
      { mode, importMode },
    );
  }

  if (hashed === null) {
    fail(
      `${importMode} needs a captured target contract and none was supplied`,
      'Capture the target schema from the destination instance and supply it with the run. Matching an existing record on an uncaptured instance would be a guess about somebody’s account.',
      { mode, importMode },
    );
  }

  if (hashed.contract.instance.mode !== mode) {
    fail(
      `the supplied target contract describes ${hashed.contract.instance.mode}, but this run targets ${mode}`,
      'Supply the target contract captured from the instance this run is addressed to.',
      { contractMode: hashed.contract.instance.mode, mode },
    );
  }

  const declared = new Map(matches.map((entry) => [entry.recordMappingId, entry]));
  const decisions: MatchAuthorityDecision[] = [];

  for (const mapping of config.records) {
    const declaration = declared.get(mapping.id);
    if (declaration === undefined || declaration.matchAuthority === 'NONE') {
      fail(
        `record mapping "${mapping.id}" is delivered in ${importMode} but declares no destination match authority`,
        'Declare destinationMatching for this mapping: what the destination matches on, which field carries it, and what happens when it finds nothing or finds two.',
        { recordMappingId: mapping.id, importMode },
      );
    }
    decisions.push(resolveOne(declaration, mapping.object, adapter, hashed, importMode));
  }

  for (const declaration of matches) {
    if (!config.records.some((mapping) => mapping.id === declaration.recordMappingId)) {
      fail(
        `destinationMatching names record mapping "${declaration.recordMappingId}", which does not exist`,
        'Remove the declaration or correct the recordMappingId.',
        { recordMappingId: declaration.recordMappingId },
      );
    }
  }

  return decisions;
}

function resolveOne(
  declaration: DestinationMatchConfig,
  canonicalObject: CanonicalObject,
  adapter: DestinationAdapter,
  hashed: HashedTargetContract,
  importMode: MigrationConfig['target']['importMode'],
): MatchAuthorityDecision {
  const { recordMappingId, matchAuthority, targetField, sourceField } = declaration;

  if (sourceField === null || sourceField === '') {
    fail(
      `record mapping "${recordMappingId}" declares ${matchAuthority} but names no source field to match on`,
      'Set destinationMatching.sourceField to the mapped field whose value the destination should match.',
      { recordMappingId, matchAuthority },
    );
  }

  if (declaration.onMissingMatch === 'CREATE' && importMode !== 'UPSERT') {
    fail(
      `record mapping "${recordMappingId}" says to create on a missing match, but ${importMode} does not create`,
      'Use UPSERT if an unmatched row should be created, or set onMissingMatch to ISOLATE or FAIL_RUN.',
      { recordMappingId, importMode, onMissingMatch: declaration.onMissingMatch },
    );
  }

  // The guard that gives the whole separation its teeth. It is checked before
  // the contract lookup so that it holds even for an instance that really does
  // carry a field with this name.
  // Every adapter's internal key, not just this run's, and the spellings V1
  // packages used before the column became an association key.
  //
  // Checking only the running adapter's spelling left the others open: a
  // HubSpot run naming `kauro_trace_key__c` — the Salesforce spelling — was
  // accepted, because it matches no HubSpot header. It is still a key Kauro
  // made up, and matching on one is the thing this refuses; which destination
  // the run happens to target does not change what the column is.
  //
  // The V1 spellings stay on the list because a portal that imported a 1.1.0
  // package may well carry a property created to hold that column. The column
  // is gone from 01_IMPORT; a property somebody already made is not, and
  // matching on it would be the same mistake under an older name.
  const associationKeyHeaders = [
    ...LEGACY_INTERNAL_KEY_HEADERS,
    adapter.associationKeyHeader,
    adapter.associationFromHeader,
    adapter.associationToHeader,
    ...ALL_ADAPTERS.flatMap((known) => [known.associationKeyHeader, known.associationFromHeader, known.associationToHeader]),
  ];
  if (targetField !== null && associationKeyHeaders.some((header) => sameInternalKeyName(header, targetField))) {
    fail(
      `record mapping "${recordMappingId}" declares the Kauro-made column "${targetField}" as its destination match authority`,
      "That column is one Kauro made up: the association key exists so this destination can join two import files, and the trace key exists so a delivered record can be followed back to its source rows. Neither is evidence about your instance, and Kauro does not ask you to create a field to hold either. Match on the destination record id, or on a field your instance already carries.",
      { recordMappingId, targetField },
    );
  }

  if (matchAuthority === 'RECORD_ID') {
    const expected = RECORD_ID_FIELD[hashed.contract.instance.mode];
    if (targetField !== null && expected !== null && !sameName(targetField, expected)) {
      fail(
        `record mapping "${recordMappingId}" matches on RECORD_ID but names "${targetField}" rather than "${expected}"`,
        `The destination record id for ${hashed.contract.instance.mode} is "${expected}". Name it, or leave targetField unset.`,
        { recordMappingId, targetField, expected },
      );
    }
    return {
      recordMappingId,
      matchAuthority,
      targetField: expected,
      sourceField,
      resolvedField: null,
      contractHash: hashed.contractHash,
    };
  }

  if (targetField === null || targetField === '') {
    fail(
      `record mapping "${recordMappingId}" declares ${matchAuthority} but names no destination field`,
      'Set destinationMatching.targetField to the name the instance answers to, and make sure the captured target contract carries it.',
      { recordMappingId, matchAuthority },
    );
  }

  // The field is looked up on the object this mapping delivers to, and on no
  // other. A name that resolves on two objects is two fields to the instance:
  // External_Key__c unique on Account says nothing about External_Key__c on
  // Contact, and the first object in the capture used to decide which one
  // answered (audit MC-02).
  const object = resolveContractObject(hashed, canonicalObject, recordMappingId);
  const objectApiName = object.apiName;
  const field = findField(object, targetField);
  if (field === null) {
    // This is the REQUIRES_AGENCY_DECISION case. Kauro does not create the field
    // and does not proceed without it.
    fail(
      `${REQUIRES_AGENCY_DECISION}: the captured target contract carries no field "${targetField}" on ${objectApiName}`,
      'Either the field does not exist on this object in the destination instance, or the capture predates it. A field of the same name on another object is a different field. Create it on this object yourself if it is missing, recapture the target schema, and run again. Kauro does not create fields inside your account.',
      { recordMappingId, targetField, objectApiName, contractHash: hashed.contractHash },
    );
  }

  if (!isDefinitely(field.updateable)) {
    fail(
      `record mapping "${recordMappingId}" matches on "${targetField}", which the target contract does not establish as updateable`,
      'Choose a field the instance reports as updateable. A field whose updateability nobody established is not a field to write through.',
      { recordMappingId, targetField, updateable: field.updateable },
    );
  }

  if (isDefinitely(field.calculated) || isDefinitely(field.autoNumber)) {
    fail(
      `record mapping "${recordMappingId}" matches on "${targetField}", which the instance computes rather than accepts`,
      'A formula or auto-number field is read-only. Choose a field the instance accepts a value for.',
      { recordMappingId, targetField, calculated: field.calculated, autoNumber: field.autoNumber },
    );
  }

  if (matchAuthority === 'EXTERNAL_ID') {
    // HubSpot has no External ID. Falling through to the check below would
    // refuse this anyway — nothing establishes an attribute HubSpot does not
    // have — but it would refuse it by telling the agency to go and mark the
    // property External ID in their portal, which is an instruction they cannot
    // carry out. Refusing here says the true thing instead.
    if (hashed.contract.instance.mode === 'HUBSPOT') {
      fail(
        `record mapping "${recordMappingId}" matches on EXTERNAL_ID, which HubSpot does not have`,
        'External ID is a Salesforce attribute. In HubSpot, match on the destination record id, or on a property the portal reports as requiring unique values with TARGET_UNIQUE_FIELD.',
        { recordMappingId, targetField, mode: hashed.contract.instance.mode },
      );
    }
    if (!isDefinitely(field.externalId)) {
      fail(
        `${REQUIRES_AGENCY_DECISION}: "${targetField}" is not established as an External ID by the captured contract`,
        'Upsert matches on a field marked External ID. Mark it in the destination instance yourself, recapture the target schema, and run again.',
        { recordMappingId, targetField, externalId: field.externalId },
      );
    }
    // External ID and Unique are separate attributes and this is the reason the
    // engine models them separately: an upsert against a non-unique external id
    // can match two records, and one of them loses.
    if (!isDefinitely(field.unique)) {
      fail(
        `${REQUIRES_AGENCY_DECISION}: "${targetField}" is an External ID but the captured contract does not establish it as unique`,
        'Marking a field External ID does not make it unique. Two records sharing this value would both match one upsert row, and which one is written is not something this engine can promise. Mark the field unique in the destination instance, recapture the target schema, and run again.',
        { recordMappingId, targetField, externalId: field.externalId, unique: field.unique },
      );
    }
    // idLookup is what upsert actually consults. A field can be External ID and
    // Unique and still not be usable to name a record.
    if (hashed.contract.instance.mode === 'SALESFORCE' && !isDefinitely(field.idLookup)) {
      fail(
        `${REQUIRES_AGENCY_DECISION}: "${targetField}" is not established as usable to name a record in an upsert`,
        'Salesforce reports this as idLookup, and it is what an upsert consults. Recapture the target schema with a describe that reports it, or choose a field that carries it.',
        { recordMappingId, targetField, idLookup: field.idLookup },
      );
    }
  }

  if (matchAuthority === 'TARGET_UNIQUE_FIELD' && !isDefinitely(field.unique)) {
    fail(
      `${REQUIRES_AGENCY_DECISION}: "${targetField}" is not established as requiring unique values`,
      'Matching on a property that is not unique would let two different records answer to one value. Mark the property as requiring unique values in the destination instance, recapture the target schema, and run again.',
      { recordMappingId, targetField, unique: field.unique, evidence: field.evidence },
    );
  }

  return {
    recordMappingId,
    matchAuthority,
    targetField,
    sourceField,
    resolvedField: field,
    contractHash: hashed.contractHash,
  };
}

/**
 * The contract object a record mapping delivers to.
 *
 * Salesforce names its objects one way and HubSpot spells its several ways, so
 * the canonical object is folded onto the contract's spelling per mode rather
 * than compared as text. Exactly one object has to answer: none is an instance
 * the capture does not describe, and two is a capture that contradicts itself.
 */
const SALESFORCE_OBJECT_API_NAMES: Readonly<Record<CanonicalObject, string>> = {
  CONTACT: 'Contact',
  COMPANY: 'Account',
  DEAL: 'Opportunity',
  LEAD: 'Lead',
};

const HUBSPOT_OBJECT_SPELLINGS: Readonly<Record<string, CanonicalObject>> = {
  contact: 'CONTACT',
  contacts: 'CONTACT',
  company: 'COMPANY',
  companies: 'COMPANY',
  deal: 'DEAL',
  deals: 'DEAL',
};

export function contractObjectMatches(mode: TargetMode, apiName: string, canonicalObject: CanonicalObject): boolean {
  if (mode === 'SALESFORCE') return sameName(apiName, SALESFORCE_OBJECT_API_NAMES[canonicalObject]);
  if (mode === 'HUBSPOT') return HUBSPOT_OBJECT_SPELLINGS[apiName.trim().toLowerCase()] === canonicalObject;
  return false;
}

export function resolveContractObject(
  hashed: HashedTargetContract,
  canonicalObject: CanonicalObject,
  recordMappingId: string,
): TargetObjectContract {
  const mode = hashed.contract.instance.mode;
  const candidates = hashed.contract.objects.filter((object) =>
    contractObjectMatches(mode, object.apiName, canonicalObject),
  );
  const only = candidates[0];
  if (candidates.length === 1 && only !== undefined) return only;
  if (candidates.length === 0) {
    fail(
      `${REQUIRES_AGENCY_DECISION}: the captured target contract describes no ${canonicalObject} object for record mapping "${recordMappingId}"`,
      'Recapture the target schema so that it covers the object this mapping delivers to. A field found on some other object is not evidence about this one.',
      { recordMappingId, canonicalObject, mode, objects: hashed.contract.objects.map((object) => object.apiName).join(', ') },
    );
  }
  fail(
    `the captured target contract describes ${canonicalObject} ${String(candidates.length)} times for record mapping "${recordMappingId}"`,
    'A capture that describes one object twice contradicts itself. Recapture the target schema and supply the result.',
    { recordMappingId, canonicalObject, mode, objects: candidates.map((object) => object.apiName).join(', ') },
  );
}

/**
 * Names are compared without case, because both destinations resolve a field
 * name without case and a match that depended on the caller's spelling would be
 * a difference the destination does not make.
 */
function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The column names V1 packages carried, before 01_IMPORT stopped carrying
 * traceability at all. Kept because a property an agency created to hold one
 * outlives the package that asked for it.
 */
const LEGACY_INTERNAL_KEY_HEADERS = [
  'kauro_trace_key',
  'from_kauro_trace_key',
  'to_kauro_trace_key',
  'Kauro Trace Key',
  'Associated Kauro Trace Key',
  'Kauro_Trace_Key__c',
  'Related_Kauro_Trace_Key__c',
] as const;

/**
 * Whether two names are the same Kauro-made key, however a destination spells it.
 *
 * Case folding alone is not enough here, and a real portal showed why. Kauro
 * wrote the HubSpot column as "Kauro Trace Key", but a HubSpot
 * property's internal name is lower-case with underscores, so the property an
 * agency creates to hold it is called `kauro_trace_key` — and a case-insensitive
 * comparison does not see those as the same name. Declaring that spelling as
 * the match authority walked straight past the guard, and if the portal carried
 * the property and a supplement stated it unique, it would have been authorized:
 * the one thing this module exists to make impossible.
 *
 * So separators are folded away as well as case. This only ever broadens a
 * refusal. A destination field that normalizes onto the trace key is refused,
 * and the remedy names the two other things to match on instead.
 */
function sameInternalKeyName(a: string, b: string): boolean {
  const fold = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/gu, '');
  return fold(a) === fold(b);
}

export { findObject };
