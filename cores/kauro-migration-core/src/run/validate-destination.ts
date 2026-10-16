import { MigrationError } from '../domain/errors.js';
import type { MigrationConfig } from '../domain/config.js';
import { isCanonicalField, isCustomField } from '../domain/canonical.js';
import type { CanonicalFieldName, SemanticType } from '../domain/canonical.js';
import type { DestinationAdapter, VendorObjectSpec } from '../adapters/adapter.js';
import { requireObjectSpec, vendorHeader } from '../adapters/adapter.js';
import type {
  HashedTargetContract,
  TargetContract,
  TargetFieldContract,
  TargetObjectContract,
  TargetPicklistValue,
  TargetPipeline,
} from '../target/contract.js';
import { isDefinitely } from '../target/contract.js';
import { contractObjectMatches } from '../target/match-authority.js';
import { instanceFieldNames, resolveInstanceField } from '../target/instance-fields.js';
import type { ResolvedRecord } from '../identity/resolve-identity.js';
import type { DestinationConflictEntry, FormulaRiskEntry, InstanceVerificationEntry } from '../reconcile/truth.js';
import { by, onString, sorted } from '../util/sorting.js';
import { compareCodeUnits } from '../util/json.js';
import type { ScratchStore } from '../scratch/scratch-store.js';
import type { SpooledFamily } from './spool.js';
import { mapFamily, openFamily, orderKey, orderText } from './spool.js';
import { carriesValue, intendedValue, omit } from '../domain/value-intent.js';

export interface DestinationValidationResult {
  /**
   * The records this stage was given, in the migration-key order they arrived
   * in, seen through what it decided about them.
   *
   * A projection over the family identity wrote, not a family of its own: this
   * stage changes one field of some records and changes no record's key, so a
   * second copy in the same order would be the same bytes under a different
   * name. Reading it walks the records segment and applies the decisions on the
   * way past.
   */
  readonly records: SpooledFamily<ResolvedRecord>;
  readonly conflicts: readonly DestinationConflictEntry[];
  readonly instanceVerification: readonly InstanceVerificationEntry[];
  readonly formulaRisks: readonly FormulaRiskEntry[];
}

/**
 * Offline destination validation.
 *
 * Everything checked here is decidable from files alone. Anything that depends
 * on the customer's own account is reported as requiring verification rather
 * than asserted, because a guarantee the engine cannot see is not a guarantee.
 */
export function validateDestination(
  records: SpooledFamily<ResolvedRecord>,
  config: MigrationConfig,
  adapter: DestinationAdapter,
  scratch: ScratchStore,
  targetContract: HashedTargetContract | null = null,
): DestinationValidationResult {
  assertMappingsAreDeliverable(config, adapter);

  const mode = config.target.importMode;
  const creates = mode === 'CREATE_ONLY' || mode === 'UPSERT';
  const updates = mode === 'UPDATE_ONLY' || mode === 'UPSERT';

  // What the attested instance says about every field the plan delivers.
  //
  // The adapter above states what the vendor documents for everybody; the
  // contract states what is true of this one portal or org. The audit (MC-04)
  // found that only the first was consulted: a field the instance reported
  // createable=FALSE and updateable=FALSE, a field the capture did not carry, a
  // custom property nobody had created and a field declaring length=3 were all
  // delivered and verified. The plan-level facts are settled here, once, before
  // any record is read; the value-level ones (length, vocabulary, a required
  // value) are applied per record below. CLEAN_ONLY has no instance and no
  // contract, and keeps the adapter rules alone.
  const instance = targetContract === null ? null : instancePlan(config, adapter, targetContract, creates, updates);

  // Applied as the records are read, and not written down again.
  //
  // This stage used to spill a 'records-validated' family: every record read
  // from the family identity had just sealed, validated, and written back out
  // under `record.migrationKey` -- the key it had already been written under.
  // The instrumentation caught it: 'records', 'records-validated' and
  // 'records-after-conflicts' were three families of exactly the same byte
  // length, 26.4% of everything the run spilled, holding the same records in
  // the same order.
  //
  // A re-spill earns its bytes when it changes the order. This one cannot:
  // validation never touches the migration key, so re-sorting by that key
  // reproduces the order it was given (the external sort's tie-break is input
  // position, and the input was already in key order). What it changes is one
  // field of some records, and a projection says that without a second copy of
  // the family.
  //
  // The cost, stated: the projection is lazy, so `validateOne` runs once per
  // record per pass over the result rather than once in total. It is a pure
  // function of the record, the config and the adapter, so every pass produces
  // the same answer; what it buys is that the records are read from the one
  // segment that holds them instead of from a third copy of it.
  const validateOne = (record: ResolvedRecord): ResolvedRecord => {
    if (record.isolation !== null) return record;
    const spec = requireObjectSpec(adapter, record.object, `record ${record.migrationKey}`);

    // Can this destination be told to empty a field it already holds?
    //
    // Only asked where the import may touch an existing record. Creating a
    // record has no previous value to remove, so an authorized clear is
    // satisfied by the field simply having no value — and the traceability
    // still records that the plan asked for it.
    const clearMayApply = mode !== 'CREATE_ONLY';
    if (clearMayApply && adapter.clearRepresentation.kind === 'NOT_REPRESENTABLE') {
      const cleared = sorted(
        [...record.values.entries()]
          .filter(([, resolved]) => resolved.intent.kind === 'CLEAR')
          .map(([fieldName]) => fieldName),
        compareCodeUnits,
      );
      if (cleared.length > 0) {
        return withIsolation(
          record,
          'TARGET_CLEAR_NOT_REPRESENTABLE',
          `the plan authorizes clearing ${cleared.map((name) => `"${name}"`).join(', ')} and ${adapter.mode} cannot express that through this import path: ${adapter.clearRepresentation.reason}`,
          cleared[0] ?? null,
        );
      }
    }

    // Where a clear is expressed by a token, no delivered value may be that
    // token, or the file would say "remove this" when the source said the
    // token. Refusing is exact; escaping would make the format depend on the
    // data it carries.
    if (adapter.clearRepresentation.kind === 'EXPLICIT_TOKEN') {
      const token = adapter.clearRepresentation.token;
      for (const [fieldName, resolved] of sorted([...record.values.entries()], by(onString(([name]) => name)))) {
        if (intendedValue(resolved.intent) === token) {
          return withIsolation(
            record,
            'TARGET_CLEAR_TOKEN_COLLISION',
            `"${fieldName}" holds exactly ${token}, which this format reserves for an authorized clear; delivering it would be indistinguishable from an instruction to empty the field`,
            fieldName,
          );
        }
      }
    }

    for (const [fieldName, resolved] of record.values) {
      if (!isCanonicalField(fieldName)) continue;
      const header = vendorHeader(spec, fieldName);
      if (header?.maxLength == null) continue;
      const value = intendedValue(resolved.intent);
      if (value !== null && value.length > header.maxLength) {
        return withIsolation(
          record,
          'DESTINATION_VALUE_TOO_LONG',
          `"${fieldName}" holds ${String(value.length)} characters; ${adapter.mode} accepts at most ${String(header.maxLength)} in ${header.header}`,
        );
      }
    }

    if (creates) {
      for (const required of spec.requiredForCreate) {
        if (!carriesValue(record.values.get(required)?.intent ?? omit('NO_VALUE_PRODUCED'))) {
          return withIsolation(
            record,
            'DESTINATION_REQUIRED_FIELD_MISSING',
            `${adapter.mode} requires ${required} to create a ${record.object}, and this record has no value for it`,
            required,
          );
        }
      }
      for (const group of spec.requiredAnyOf) {
        const satisfied = group.some((field) => carriesValue(record.values.get(field)?.intent ?? omit('NO_VALUE_PRODUCED')));
        if (!satisfied) {
          return withIsolation(
            record,
            'DESTINATION_REQUIRED_FIELD_MISSING',
            `${adapter.mode} requires at least one of ${group.join(' or ')} to create a ${record.object}`,
            group[0] ?? null,
          );
        }
      }
    }

    if (instance !== null) {
      const plan = instance.get(record.recordMappingId);
      if (plan !== undefined) {
        const finding = instanceFinding(record, plan, creates);
        if (finding !== null) return withIsolation(record, finding.reasonCode, finding.detail, finding.field);
      }
    }

    return record;
  };
  const validated = mapFamily(records, validateOne);

  const { records: afterConflicts, conflicts } = applyDestinationKeyConflicts(
    validated,
    config,
    adapter,
    scratch,
  );

  const formulaRisks: FormulaRiskEntry[] = [];
  for (const record of afterConflicts) {
    if (record.isolation !== null) continue;
    for (const [fieldName, resolved] of sorted([...record.values.entries()], by(onString(([name]) => name)))) {
      const value = intendedValue(resolved.intent);
      if (value === null || !startsLikeFormula(value)) continue;
      formulaRisks.push({
        target: adapter.mode,
        object: record.object,
        migrationKey: record.migrationKey,
        destinationField: fieldName,
        value,
        reasonCode: 'DESTINATION_FORMULA_RISK_VALUE',
      });
    }
  }

  return {
    records: afterConflicts,
    conflicts,
    instanceVerification: adapter.instanceVerification.map((item) => ({
      scope: item.scope,
      detail: item.detail,
      sourceUrl: item.sourceUrl,
      reasonCode: 'DESTINATION_INSTANCE_VERIFICATION_REQUIRED' as const,
    })),
    formulaRisks: sorted(
      formulaRisks,
      by(onString((entry) => entry.migrationKey), onString((entry) => entry.destinationField)),
    ),
  };
}

/**
 * Every mapped destination field must have somewhere to go. A canonical field
 * the destination does not define is a configuration error, not something to drop.
 */
function assertMappingsAreDeliverable(config: MigrationConfig, adapter: DestinationAdapter): void {
  for (const mapping of config.records) {
    const spec = requireObjectSpec(
      adapter,
      mapping.object,
      `record mapping "${mapping.id}"`,
    );

    if (!spec.supportedModes.includes(config.target.importMode)) {
      throw new MigrationError(
        'DESTINATION_MODE_UNSUPPORTED',
        `${adapter.mode} does not support ${config.target.importMode} for ${mapping.object}`,
        `Supported modes are: ${spec.supportedModes.join(', ')}. ${spec.notes.join(' ')}`,
        {
          mode: adapter.mode,
          recordMappingId: mapping.id,
          importMode: config.target.importMode,
          supportedModes: [...spec.supportedModes],
          reasonCode: 'DESTINATION_MODE_UNSUPPORTED',
        },
      );
    }

    const targets = [
      ...mapping.fields.map((field) => field.destinationField),
      ...mapping.fields
        .map((field) => field.options.extensionDestinationField)
        .filter((value): value is string => value !== null),
    ];

    for (const target of targets) {
      if (isCustomField(target)) continue;
      if (!isCanonicalField(target)) continue;
      if (vendorHeader(spec, target as CanonicalFieldName) === null) {
        throw new MigrationError(
          'DESTINATION_FIELD_UNKNOWN',
          `${adapter.mode} has no documented import column for "${target}"`,
          `Map this column to a "custom:" field whose header matches a property you have created in the destination, or remove the mapping. Fields this adapter can deliver: ${spec.fields
            .map((entry) => entry.canonicalField)
            .join(', ')}.`,
          { mode: adapter.mode, recordMappingId: mapping.id, destinationField: target },
        );
      }
    }
  }
}

// ------------------------------------------------------- instance facts (MC-04)

export type InstanceFindingCode =
  | 'DESTINATION_INSTANCE_VALUE_TOO_LONG'
  | 'DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN'
  | 'DESTINATION_INSTANCE_REQUIRED_FIELD_MISSING';

interface InstanceFinding {
  readonly reasonCode: InstanceFindingCode;
  readonly detail: string;
  readonly field: string;
}

/** A delivered field of one mapping, resolved to the contract field the instance answers to. */
interface InstanceFieldPlan {
  readonly destinationField: string;
  readonly field: TargetFieldContract;
  /** Where the field's vocabulary is the contract's pipelines rather than its own options (`pipelineVocabulary`). */
  readonly pipelines?: PipelineVocabulary | null;
}

/** One record mapping seen through the attested contract: the object it lands on and every field it writes. */
export interface InstanceMappingPlan {
  readonly object: TargetObjectContract;
  readonly fields: readonly InstanceFieldPlan[];
  /** Fields the instance requires a value for on create, as far as the plan maps them. */
  readonly requiredOnCreate: readonly InstanceFieldPlan[];
}

export type InstanceTypeFamily = 'TEXT' | 'NUMBER' | 'BOOLEAN' | 'DATE' | 'DATETIME';

/**
 * The instance type tokens this engine can place in a family, lowercased.
 *
 * The contract records the vendor's own token verbatim. A token in no family
 * is not a fact this engine can read, and it authorises nothing: what it must
 * not do is call a `bool` a text field because it did not recognise the word,
 * and what it must not do either is deliver text into a `time`, a `location`
 * or a token nobody here has implemented because it did not recognise the
 * word. The reinicio audit (R-MC-TYPE) found the second: a token outside this
 * table returned without validation, and an arbitrary TEXT value was written
 * into it and verified. A type this engine has not implemented is refused
 * before any record is read; the tokens below are the implemented paths.
 */
const INSTANCE_TYPE_FAMILIES: Readonly<Record<string, InstanceTypeFamily>> = {
  string: 'TEXT',
  text: 'TEXT',
  textarea: 'TEXT',
  email: 'TEXT',
  phone: 'TEXT',
  phone_number: 'TEXT',
  url: 'TEXT',
  id: 'TEXT',
  reference: 'TEXT',
  picklist: 'TEXT',
  multipicklist: 'TEXT',
  combobox: 'TEXT',
  enumeration: 'TEXT',
  encryptedstring: 'TEXT',
  number: 'NUMBER',
  double: 'NUMBER',
  int: 'NUMBER',
  integer: 'NUMBER',
  long: 'NUMBER',
  currency: 'NUMBER',
  percent: 'NUMBER',
  bool: 'BOOLEAN',
  boolean: 'BOOLEAN',
  date: 'DATE',
  datetime: 'DATETIME',
};

/**
 * Which instance families a plan-declared semantic type may be written into.
 *
 * A typed value may always go to a text field, which stores it as written. A
 * text-shaped value may not go to a typed field: the plan said nothing about
 * it being a number, a date or a boolean, and the destination would either
 * refuse the row or coerce it, and neither is something this engine promised.
 *
 * A calendar date and an instant are different things, and a date is not
 * written into an instant field on the strength of a comment. The one
 * cross-family widening kept is DATE into a DATETIME field on HUBSPOT, and it
 * rests on evidence rather than on reasoning: the HubSpot import qualification
 * delivered the deals mapping's DATE `Close Date` into the portal's
 * `closedate`, which the captured contract reports as `datetime`, and read it
 * back (corpus Q1-create). Nothing establishes the same for a Salesforce
 * DateTime field, and this engine does not invent the time or the time zone
 * that would make one, so there it stays refused, as does the reverse (a
 * DATETIME into a DATE field drops the time) everywhere.
 */
const COMPATIBLE_FAMILIES: Readonly<Record<SemanticType, readonly InstanceTypeFamily[]>> = {
  TEXT: ['TEXT'],
  EMAIL: ['TEXT'],
  PHONE: ['TEXT'],
  URL: ['TEXT'],
  ENUM: ['TEXT'],
  IDENTIFIER: ['TEXT'],
  NUMBER: ['NUMBER', 'TEXT'],
  BOOLEAN: ['BOOLEAN', 'TEXT'],
  DATE: ['DATE', 'TEXT'],
  DATETIME: ['DATETIME', 'TEXT'],
};

/** The modes in which a DATE may be written into a DATETIME field, each on the evidence stated above. */
const DATE_INTO_DATETIME_QUALIFIED: ReadonlySet<string> = new Set(['HUBSPOT']);

/** Whether an instance family can hold a value of a plan-declared semantic type, in this mode. */
export function familyAdmits(mode: string, family: InstanceTypeFamily, semanticType: SemanticType): boolean {
  if (COMPATIBLE_FAMILIES[semanticType].includes(family)) return true;
  return semanticType === 'DATE' && family === 'DATETIME' && DATE_INTO_DATETIME_QUALIFIED.has(mode);
}

/**
 * The instance type tokens whose values come from a vocabulary the instance
 * holds, lowercased. A field of one of these types has an eligibility set,
 * whether or not the capture carried it.
 */
const INSTANCE_ENUMERATED_TYPES: ReadonlySet<string> = new Set(['picklist', 'multipicklist', 'combobox', 'enumeration']);

/**
 * What the attested contract establishes about the values one field accepts.
 *
 * - `NONE`: not a vocabulary field, and the capture declares no options. Length
 *   and type decide what it takes; nothing here does.
 * - `KNOWN`: the capture carries the options. A value is eligible when it is an
 *   active option's value or label, and only then; an inactive option admits
 *   nothing, and a list of nothing but inactive options admits nothing.
 * - `OPEN`: a vocabulary field the instance states is not restricted, with no
 *   captured options. The instance itself takes a value outside its list, so
 *   there is no list to hold the plan to.
 * - `EMPTY`: a restricted vocabulary the capture establishes as having no
 *   option. Known and empty is not unrestricted: nothing nonempty is eligible.
 * - `UNKNOWN`: a vocabulary field whose options the capture did not carry and
 *   whose restriction nobody established. An unknown is not a yes.
 *
 * The reinicio audit (R-MC-ENUM) found `picklistValues.length === 0` read as
 * "nothing to check": a restricted target with no eligible option took every
 * value the source vocabulary offered and its package verified. The source
 * mapping's allowedValues describe what the source says; only the contract can
 * say what the target takes, and it is read here and nowhere else.
 */
export type InstanceVocabulary =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'KNOWN'; readonly active: readonly TargetFieldContract['picklistValues'][number][] }
  | { readonly kind: 'OPEN' }
  | { readonly kind: 'EMPTY' }
  | { readonly kind: 'UNKNOWN' };

/**
 * A field whose options the instance keeps outside the field: HubSpot's deal
 * pipeline and deal stage.
 *
 * HubSpot marks both properties `externalOptions`: the property carries no
 * option and states no restriction, and the portal defines the values as
 * pipelines and the stages inside them, which a capture carries in the
 * pipelines artifact (`TargetContract.pipelines`). Read as a property each is
 * an enumeration nobody established, so the rule below calls it UNKNOWN and
 * refuses the plan -- and the HubSpot adapter requires both to create a deal,
 * so every HubSpot deal plan was refused (R-MC-PIPELINE, found by the import
 * qualification against a real portal on the 2.0.3 candidate).
 *
 * The captured pipelines are the vocabulary: a pipeline's internal name for
 * `pipeline`, a stage's internal name for `dealstage`, and a stage only inside
 * the pipeline the record names (`stageOutsideItsPipeline`). A label admits
 * nothing, as for any other option. A contract that captured no pipeline for
 * the object leaves both fields where the property rule puts them: not
 * established, refused.
 */
export interface PipelineVocabulary {
  readonly role: 'PIPELINE' | 'STAGE';
  /** The captured pipelines of the object the field belongs to, in capture order. */
  readonly pipelines: readonly TargetPipeline[];
}

const HUBSPOT_PIPELINE_FIELDS: Readonly<Record<string, PipelineVocabulary['role']>> = { pipeline: 'PIPELINE', dealstage: 'STAGE' };

export function pipelineVocabulary(
  contract: TargetContract,
  canonicalObject: MigrationConfig['records'][number]['object'],
  field: TargetFieldContract,
): PipelineVocabulary | null {
  if (contract.instance.mode !== 'HUBSPOT' || canonicalObject !== 'DEAL') return null;
  const role = Object.prototype.hasOwnProperty.call(HUBSPOT_PIPELINE_FIELDS, field.apiName) ? HUBSPOT_PIPELINE_FIELDS[field.apiName] : undefined;
  if (role === undefined) return null;
  const pipelines = contract.pipelines.filter((pipeline) => contractObjectMatches('HUBSPOT', pipeline.objectApiName, canonicalObject));
  return pipelines.length === 0 ? null : { role, pipelines };
}

/** The options a pipeline vocabulary declares, as active options: the internal name is the value, the label only a label. */
function pipelineOptions(vocabulary: PipelineVocabulary): TargetPicklistValue[] {
  const options: TargetPicklistValue[] = [];
  const seen = new Set<string>();
  const add = (value: string, label: string): void => {
    if (seen.has(value)) return;
    seen.add(value);
    options.push({ value, label, active: true, defaultValue: false });
  };
  for (const pipeline of vocabulary.pipelines) {
    if (vocabulary.role === 'PIPELINE') add(pipeline.pipelineInternalName, pipeline.pipelineLabel);
    else for (const stage of pipeline.stages) add(stage.stageInternalName, stage.stageLabel);
  }
  return options;
}

export function instanceVocabulary(field: TargetFieldContract, pipelines: PipelineVocabulary | null = null): InstanceVocabulary {
  if (pipelines !== null) {
    const options = pipelineOptions(pipelines);
    return options.length > 0 ? { kind: 'KNOWN', active: options } : { kind: 'EMPTY' };
  }
  if (field.picklistValues.length > 0) {
    return { kind: 'KNOWN', active: field.picklistValues.filter((option) => option.active) };
  }
  const enumerated = INSTANCE_ENUMERATED_TYPES.has(field.type.trim().toLowerCase()) || field.restrictedPicklist === 'TRUE';
  if (!enumerated) return { kind: 'NONE' };
  if (field.restrictedPicklist === 'FALSE') return { kind: 'OPEN' };
  if (field.restrictedPicklist === 'TRUE') return { kind: 'EMPTY' };
  return { kind: 'UNKNOWN' };
}

/**
 * Whether the contract's vocabulary for `field` admits `value`: null when it
 * does, otherwise the reason, phrased to follow the value in a sentence.
 *
 * One rule for the producer and the verifier. Only an active option's value
 * is eligible; a display label that happens to equal the value is a different
 * string from the one the instance stores and admits nothing on its own.
 */
export function vocabularyAdmits(field: TargetFieldContract, value: string, pipelines: PipelineVocabulary | null = null): string | null {
  const vocabulary = instanceVocabulary(field, pipelines);
  if (vocabulary.kind === 'NONE' || vocabulary.kind === 'OPEN') return null;
  if (vocabulary.kind === 'EMPTY') return 'and the attested contract declares no option';
  if (vocabulary.kind === 'UNKNOWN') return 'and the attested contract does not establish which values are eligible';
  if (vocabulary.active.some((option) => option.value === value)) return null;
  const byLabel = vocabulary.active.find((option) => option.label === value);
  if (byLabel !== undefined) {
    // A stage label repeats in every pipeline that has the stage ("Closed
    // Won"), so one label can name several values; each is named.
    const named = vocabulary.active.filter((option) => option.label === value);
    if (named.length > 1) {
      return `which is the display label of the options whose values are ${named.map((option) => `"${option.value}"`).join(', ')}; the instance stores the value, so map the source value onto the one it means explicitly`;
    }
    return `which is the display label of the option whose value is "${byLabel.value}"; the instance stores the value, so map the source value onto it explicitly`;
  }
  if (pipelines !== null) {
    return `which is not among the ${String(vocabulary.active.length)} ${pipelines.role === 'STAGE' ? 'stage' : 'pipeline'} internal names the attested contract's pipelines declare`;
  }
  return `which is not among the ${String(vocabulary.active.length)} active option values the attested contract declares${field.restrictedPicklist === 'TRUE' ? ' (restricted)' : ''}`;
}

/**
 * Settle, per record mapping, what the attested instance says about the object
 * and every field the plan writes to it. Everything here is decidable from the
 * plan and the contract alone, so a contradiction is refused before a record is
 * read: Kauro does not create fields, enable operations or widen a limit inside
 * somebody's account, and a plan the instance cannot take is a plan to change
 * rather than a dataset to trim.
 *
 * `UNKNOWN` never authorises. A field whose createability nobody established
 * is not a field to create through.
 */
export function instancePlan(
  config: MigrationConfig,
  adapter: DestinationAdapter,
  hashed: HashedTargetContract,
  creates: boolean,
  updates: boolean,
): ReadonlyMap<string, InstanceMappingPlan> {
  const contract = hashed.contract;
  const instanceName = `${contract.instance.mode} instance ${contract.instance.instanceId}`;
  const importMode = config.target.importMode;
  const plans = new Map<string, InstanceMappingPlan>();

  for (const mapping of config.records) {
    const spec = requireObjectSpec(adapter, mapping.object, `record mapping "${mapping.id}"`);
    const object = resolveInstanceObject(hashed, mapping.object, mapping.id, instanceName);

    if (creates && !isDefinitely(object.createable)) {
      throw new MigrationError(
        'DESTINATION_MODE_UNSUPPORTED',
        `the attested contract for ${instanceName} does not establish ${object.apiName} as createable (reports ${object.createable}), and record mapping "${mapping.id}" runs in ${importMode}`,
        'Enable creating this object in the destination instance, recapture the target schema and run again, or choose UPDATE_ONLY. Kauro does not change what an instance allows.',
        { recordMappingId: mapping.id, objectApiName: object.apiName, importMode, createable: object.createable, contractHash: hashed.contractHash },
      );
    }
    if (updates && !isDefinitely(object.updateable)) {
      throw new MigrationError(
        'DESTINATION_MODE_UNSUPPORTED',
        `the attested contract for ${instanceName} does not establish ${object.apiName} as updateable (reports ${object.updateable}), and record mapping "${mapping.id}" runs in ${importMode}`,
        'Enable updating this object in the destination instance, recapture the target schema and run again, or choose CREATE_ONLY. Kauro does not change what an instance allows.',
        { recordMappingId: mapping.id, objectApiName: object.apiName, importMode, updateable: object.updateable, contractHash: hashed.contractHash },
      );
    }

    const fields: InstanceFieldPlan[] = [];
    const seen = new Set<string>();
    for (const declared of mapping.fields) {
      const targets: readonly { name: string; semanticType: SemanticType | null }[] = [
        { name: declared.destinationField, semanticType: declared.semanticType },
        ...(declared.options.extensionDestinationField === null
          ? []
          : [{ name: declared.options.extensionDestinationField, semanticType: null }]),
      ];
      for (const target of targets) {
        if (seen.has(target.name)) continue;
        seen.add(target.name);
        const field = resolveInstanceFieldOrRefuse(hashed, spec, object, target.name, mapping.id, instanceName);
        assertFieldWriteable(hashed, object, field, target.name, mapping.id, instanceName, importMode, creates, updates);
        const family = requireTypeFamily(hashed, object, field, target.name, mapping.id, instanceName);
        if (target.semanticType !== null) {
          assertTypeCompatible(hashed, object, field, family, target.name, target.semanticType, mapping.id, instanceName);
        }
        const pipelines = pipelineVocabulary(contract, mapping.object, field);
        assertVocabularyDeliverable(hashed, object, field, target.name, mapping.id, instanceName, pipelines);
        fields.push({ destinationField: target.name, field, pipelines });
      }
    }

    // Fields the instance requires on create. A required field the plan maps
    // is checked per record; one the plan does not map at all can never be
    // satisfied, and is a plan to change rather than a dataset to isolate.
    const requiredOnCreate: InstanceFieldPlan[] = [];
    if (creates) {
      for (const field of object.fields) {
        if (!isInstanceRequiredOnCreate(field)) continue;
        const mapped = fields.find((entry) => entry.field === field);
        if (mapped !== undefined) {
          requiredOnCreate.push(mapped);
          continue;
        }
        throw new MigrationError(
          'MAPPING_INVALID',
          `the attested contract for ${instanceName} requires a value for ${object.apiName}.${field.apiName} to create a record (nillable ${field.nillable}, no default on create), and record mapping "${mapping.id}" maps nothing to it`,
          `Map a source column to this field, or supply a default in the destination instance and recapture the target schema. Delivering ${importMode} rows without it would have every one of them refused by the instance.`,
          { recordMappingId: mapping.id, objectApiName: object.apiName, fieldApiName: field.apiName, importMode, contractHash: hashed.contractHash },
        );
      }
    }

    plans.set(mapping.id, { object, fields, requiredOnCreate });
  }

  return plans;
}

/**
 * The contract object a mapping delivers to, found by the same fold match
 * authority uses (audit MC-02), refused under the codes destination validation
 * speaks in.
 */
function resolveInstanceObject(
  hashed: HashedTargetContract,
  canonicalObject: MigrationConfig['records'][number]['object'],
  recordMappingId: string,
  instanceName: string,
): TargetObjectContract {
  const mode = hashed.contract.instance.mode;
  const candidates = hashed.contract.objects.filter((object) => contractObjectMatches(mode, object.apiName, canonicalObject));
  const only = candidates[0];
  if (candidates.length === 1 && only !== undefined) return only;
  if (candidates.length === 0) {
    throw new MigrationError(
      'DESTINATION_OBJECT_UNSUPPORTED',
      `the attested contract for ${instanceName} describes no ${canonicalObject} object, and record mapping "${recordMappingId}" delivers to it`,
      'Recapture the target schema so that it covers the object this mapping delivers to. An object the capture does not describe is one nothing here can say is there, let alone writeable.',
      {
        recordMappingId,
        canonicalObject,
        mode,
        objects: hashed.contract.objects.map((object) => object.apiName).join(', '),
        contractHash: hashed.contractHash,
      },
    );
  }
  throw new MigrationError(
    'TARGET_CONTRACT_INVALID',
    `the attested contract for ${instanceName} describes ${canonicalObject} ${String(candidates.length)} times (${candidates.map((object) => object.apiName).join(', ')})`,
    'A capture that describes one object twice contradicts itself. Recapture the target schema and supply the result.',
    { recordMappingId, canonicalObject, mode, contractHash: hashed.contractHash },
  );
}

function resolveInstanceFieldOrRefuse(
  hashed: HashedTargetContract,
  spec: VendorObjectSpec,
  object: TargetObjectContract,
  destinationField: string,
  recordMappingId: string,
  instanceName: string,
): TargetFieldContract {
  const names = instanceFieldNames(hashed.contract.instance.mode, spec, destinationField);
  if (names === null) {
    // The adapter refusal above already covers a canonical field with no
    // column; this is the mode with no instance, which never gets here.
    throw new MigrationError(
      'DESTINATION_FIELD_UNKNOWN',
      `"${destinationField}" cannot be looked up in the contract for ${instanceName}`,
      'Map a canonical field the adapter delivers, or a "custom:" field the instance defines.',
      { recordMappingId, destinationField, contractHash: hashed.contractHash },
    );
  }
  const resolved = resolveInstanceField(object, names);
  if (resolved.kind === 'FOUND') return resolved.field;
  const lookedFor = [...new Set([...names.apiNames, ...names.labels])].map((name) => `"${name}"`).join(' or ');
  if (resolved.kind === 'AMBIGUOUS') {
    throw new MigrationError(
      'TARGET_CONTRACT_INVALID',
      `the attested contract for ${instanceName} answers to ${lookedFor} with ${String(resolved.fields.length)} fields on ${object.apiName} (${resolved.fields.map((field) => field.apiName).join(', ')}), so "${destinationField}" resolves to no single field`,
      'A capture in which two fields of one object answer to the same name contradicts itself. Recapture the target schema and supply the result.',
      { recordMappingId, destinationField, objectApiName: object.apiName, contractHash: hashed.contractHash },
    );
  }
  const custom = isCustomField(destinationField);
  throw new MigrationError(
    'DESTINATION_FIELD_UNKNOWN',
    custom
      ? `the attested contract for ${instanceName} declares no ${object.apiName} property answering to ${lookedFor}, and record mapping "${recordMappingId}" delivers "${destinationField}" to it`
      : `the attested contract for ${instanceName} carries no ${object.apiName} field answering to ${lookedFor}, and record mapping "${recordMappingId}" delivers "${destinationField}" to it`,
    custom
      ? 'Create the property in the destination instance yourself, recapture the target schema, and run again. A custom column the instance does not define is not deliverable, and Kauro does not create fields inside your account.'
      : 'Either the field does not exist on this object in the destination instance, or the capture predates it. Recapture the target schema, or remove the mapping. Kauro does not create fields inside your account.',
    {
      recordMappingId,
      destinationField,
      objectApiName: object.apiName,
      fields: object.fields.map((field) => field.apiName).join(', '),
      contractHash: hashed.contractHash,
    },
  );
}

function assertFieldWriteable(
  hashed: HashedTargetContract,
  object: TargetObjectContract,
  field: TargetFieldContract,
  destinationField: string,
  recordMappingId: string,
  instanceName: string,
  importMode: MigrationConfig['target']['importMode'],
  creates: boolean,
  updates: boolean,
): void {
  const where = `${object.apiName}.${field.apiName}`;
  const details = {
    recordMappingId,
    destinationField,
    objectApiName: object.apiName,
    fieldApiName: field.apiName,
    importMode,
    createable: field.createable,
    updateable: field.updateable,
    calculated: field.calculated,
    autoNumber: field.autoNumber,
    contractHash: hashed.contractHash,
  };
  if (isDefinitely(field.calculated) || isDefinitely(field.autoNumber)) {
    throw new MigrationError(
      'DESTINATION_FIELD_UNKNOWN',
      `the attested contract for ${instanceName} reports ${where} as ${isDefinitely(field.calculated) ? 'a formula field' : 'an auto-number field'}, which the instance computes rather than accepts, and record mapping "${recordMappingId}" delivers "${destinationField}" to it`,
      'Map the column to a field the instance accepts a value for, or remove the mapping.',
      details,
    );
  }
  if (creates && !isDefinitely(field.createable)) {
    throw new MigrationError(
      'DESTINATION_FIELD_UNKNOWN',
      `the attested contract for ${instanceName} does not establish ${where} as createable (reports ${field.createable}), and record mapping "${recordMappingId}" delivers "${destinationField}" to it in ${importMode}`,
      field.createable === 'UNKNOWN'
        ? 'Nobody established that this field can be written on create, and an unknown is not a yes. Recapture the target schema with an export that reports it, or map the column elsewhere.'
        : 'The instance will not accept a value for this field on create. Make it createable in the destination instance and recapture the target schema, or map the column elsewhere.',
      details,
    );
  }
  if (updates && !isDefinitely(field.updateable)) {
    throw new MigrationError(
      'DESTINATION_FIELD_UNKNOWN',
      `the attested contract for ${instanceName} does not establish ${where} as updateable (reports ${field.updateable}), and record mapping "${recordMappingId}" delivers "${destinationField}" to it in ${importMode}`,
      field.updateable === 'UNKNOWN'
        ? 'Nobody established that this field can be written on update, and an unknown is not a yes. Recapture the target schema with an export that reports it, or map the column elsewhere.'
        : 'The instance will not accept a value for this field on update. Make it updateable in the destination instance and recapture the target schema, or map the column elsewhere.',
      details,
    );
  }
}

/**
 * The family the instance's type token belongs to, or a refusal.
 *
 * A token this engine has not implemented is not a text field: nothing here
 * knows what the instance would do with the value, so nothing here can promise
 * it was delivered. This holds for every field the plan writes, an extension
 * field included, because it is the destination's type that is unknown, not
 * the plan's.
 */
function requireTypeFamily(
  hashed: HashedTargetContract,
  object: TargetObjectContract,
  field: TargetFieldContract,
  destinationField: string,
  recordMappingId: string,
  instanceName: string,
): InstanceTypeFamily {
  const family = INSTANCE_TYPE_FAMILIES[field.type.trim().toLowerCase()];
  if (family !== undefined) return family;
  throw new MigrationError(
    'DESTINATION_FIELD_UNKNOWN',
    `the attested contract for ${instanceName} reports ${object.apiName}.${field.apiName} as type "${field.type}", which this engine has not implemented a delivery path for, and record mapping "${recordMappingId}" delivers "${destinationField}" to it`,
    `Map the column to a field of a type this engine delivers (${Object.keys(INSTANCE_TYPE_FAMILIES).join(', ')}), or remove the mapping. A type nobody here can read is not a text field; a value written into it is one the instance may coerce, refuse or misread, and none of those is a delivery this engine can promise.`,
    {
      recordMappingId,
      destinationField,
      objectApiName: object.apiName,
      fieldApiName: field.apiName,
      instanceType: field.type,
      contractHash: hashed.contractHash,
    },
  );
}

/**
 * A field whose eligibility set admits nothing, or that nobody established,
 * cannot take a value from any record: the plan is refused before one is read,
 * the way an unmapped required field is. A field with a known vocabulary is
 * checked per record in `instanceFinding`, so a partly eligible column keeps
 * the records the instance would take.
 */
function assertVocabularyDeliverable(
  hashed: HashedTargetContract,
  object: TargetObjectContract,
  field: TargetFieldContract,
  destinationField: string,
  recordMappingId: string,
  instanceName: string,
  pipelines: PipelineVocabulary | null,
): void {
  const vocabulary = instanceVocabulary(field, pipelines);
  if (vocabulary.kind !== 'EMPTY' && vocabulary.kind !== 'UNKNOWN') return;
  const where = `${object.apiName}.${field.apiName}`;
  // HubSpot keeps a deal's pipeline and stage options in its pipelines, so the
  // capture that establishes them is the pipelines artifact, not the property.
  const pipelineBacked = pipelines !== null || (hashed.contract.instance.mode === 'HUBSPOT' && Object.prototype.hasOwnProperty.call(HUBSPOT_PIPELINE_FIELDS, field.apiName));
  throw new MigrationError(
    'DESTINATION_FIELD_UNKNOWN',
    vocabulary.kind === 'EMPTY'
      ? `the attested contract for ${instanceName} declares ${where} as a restricted "${field.type}" field with no option, so no value is eligible for it, and record mapping "${recordMappingId}" delivers "${destinationField}" to it`
      : `the attested contract for ${instanceName} declares ${where} as a "${field.type}" field but carries none of its options and does not establish whether it is restricted (reports ${field.restrictedPicklist}), so which values it accepts is not established, and record mapping "${recordMappingId}" delivers "${destinationField}" to it`,
    pipelineBacked
      ? 'Recapture the target schema together with its pipelines artifact, or map the column elsewhere. HubSpot keeps the values of a deal\'s pipeline and stage in its pipelines rather than on the property, and a capture without them establishes none; the options a source mapping allows say what the source holds, not what the target takes.'
      : vocabulary.kind === 'EMPTY'
      ? 'Add the options to the field in the destination instance and recapture the target schema, or map the column elsewhere. An empty restricted vocabulary is a known fact and it admits nothing; the options a source mapping allows say what the source holds, not what the target takes. Kauro does not add options inside your account.'
      : 'Recapture the target schema with an export that carries the field\'s options, or map the column elsewhere. Nobody established which values this field takes, and an unknown is not a yes; the options a source mapping allows say what the source holds, not what the target takes.',
    {
      recordMappingId,
      destinationField,
      objectApiName: object.apiName,
      fieldApiName: field.apiName,
      instanceType: field.type,
      restrictedPicklist: field.restrictedPicklist,
      picklistValues: field.picklistValues.length,
      contractHash: hashed.contractHash,
    },
  );
}

function assertTypeCompatible(
  hashed: HashedTargetContract,
  object: TargetObjectContract,
  field: TargetFieldContract,
  family: InstanceTypeFamily,
  destinationField: string,
  semanticType: SemanticType,
  recordMappingId: string,
  instanceName: string,
): void {
  if (familyAdmits(hashed.contract.instance.mode, family, semanticType)) return;
  throw new MigrationError(
    'DESTINATION_FIELD_UNKNOWN',
    `the attested contract for ${instanceName} reports ${object.apiName}.${field.apiName} as type "${field.type}", and record mapping "${recordMappingId}" delivers "${destinationField}" to it as ${semanticType}`,
    'Declare the column with a semantic type the destination field can hold, or map it to a field of that type. A value the instance would coerce or refuse is not a value this engine can promise was delivered.',
    {
      recordMappingId,
      destinationField,
      objectApiName: object.apiName,
      fieldApiName: field.apiName,
      instanceType: field.type,
      semanticType,
      contractHash: hashed.contractHash,
    },
  );
}

/** A field the instance will not create a record without: not nillable, not defaulted, and createable at all. */
function isInstanceRequiredOnCreate(field: TargetFieldContract): boolean {
  return (
    field.nillable === 'FALSE' &&
    !isDefinitely(field.defaultedOnCreate) &&
    isDefinitely(field.createable) &&
    !isDefinitely(field.calculated) &&
    !isDefinitely(field.autoNumber)
  );
}

const PLAIN_NUMBER = /^-?([0-9]+)(?:\.([0-9]+))?$/u;

/**
 * The value-level facts of the attested instance, applied to one record.
 *
 * The first finding isolates the record, in the order the plan's fields were
 * declared, then the required fields. Nothing is trimmed, truncated or mapped
 * onto a nearby option to make the record pass: the record is set aside with
 * the value it carried, and the finding names the field and the limit.
 */
export function instanceFinding(record: Pick<ResolvedRecord, 'values'>, plan: InstanceMappingPlan, creates: boolean): InstanceFinding | null {
  const where = plan.object.apiName;
  for (const { destinationField, field, pipelines } of plan.fields) {
    const resolved = record.values.get(destinationField);
    if (resolved === undefined) continue;
    const value = intendedValue(resolved.intent);
    if (value === null) continue;

    if (field.length !== null && value.length > field.length) {
      return {
        reasonCode: 'DESTINATION_INSTANCE_VALUE_TOO_LONG',
        detail: `"${destinationField}" holds ${String(value.length)} characters; the attested contract declares ${where}.${field.apiName} with length ${String(field.length)}`,
        field: destinationField,
      };
    }

    if (field.precision !== null) {
      const parts = PLAIN_NUMBER.exec(value);
      if (parts !== null) {
        const integer = (parts[1] ?? '').replace(/^0+(?=[0-9])/u, '');
        const fraction = parts[2] ?? '';
        const scale = field.scale ?? 0;
        if (fraction.length > scale || integer.length > field.precision - scale) {
          return {
            reasonCode: 'DESTINATION_INSTANCE_VALUE_TOO_LONG',
            detail: `"${destinationField}" holds ${value}, which has ${String(integer.length)} integer and ${String(fraction.length)} decimal digits; the attested contract declares ${where}.${field.apiName} with precision ${String(field.precision)} and scale ${String(scale)}`,
            field: destinationField,
          };
        }
      }
    }

    // The eligibility set is the contract's, never the source mapping's: an
    // allowedValues list says what the source holds. A known vocabulary admits
    // an active option's value and nothing else. An option's display label is
    // not its value: delivering the label writes a different string from the
    // one the instance stores, so a label admits nothing, and a plan that
    // means the option maps the source value onto the option's value
    // explicitly. An empty or unestablished vocabulary is refused at plan time
    // above; should a plan carry one anyway, it admits nothing here either, so
    // the two layers state one rule.
    const eligibility = vocabularyAdmits(field, value, pipelines ?? null);
    if (eligibility !== null) {
      return {
        reasonCode: 'DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN',
        detail: `"${destinationField}" holds "${value}", ${eligibility} for ${where}.${field.apiName}`,
        field: destinationField,
      };
    }
  }

  const misplaced = stageOutsideItsPipeline(record, plan);
  if (misplaced !== null) return misplaced;

  if (creates) {
    for (const { destinationField, field } of plan.requiredOnCreate) {
      if (carriesValue(record.values.get(destinationField)?.intent ?? omit('NO_VALUE_PRODUCED'))) continue;
      return {
        reasonCode: 'DESTINATION_INSTANCE_REQUIRED_FIELD_MISSING',
        detail: `the attested contract requires a value for ${where}.${field.apiName} to create a record (nillable ${field.nillable}, no default on create), and this record has no value for "${destinationField}"`,
        field: destinationField,
      };
    }
  }

  return null;
}

/**
 * A deal stage the contract declares, delivered with a pipeline that does not
 * contain it.
 *
 * Each value is eligible on its own -- both are checked above -- but HubSpot
 * places a deal's stage inside its pipeline, and a stage of another pipeline
 * is one the portal refuses for this record. Decided only where the record
 * carries both; a stage delivered without a pipeline is placed by the portal
 * in the record's existing pipeline, which no file here can see, so the
 * captured vocabulary is all that can be held to.
 */
function stageOutsideItsPipeline(record: Pick<ResolvedRecord, 'values'>, plan: InstanceMappingPlan): InstanceFinding | null {
  const stage = plan.fields.find((entry) => entry.pipelines?.role === 'STAGE');
  const pipeline = plan.fields.find((entry) => entry.pipelines?.role === 'PIPELINE');
  if (stage === undefined || pipeline === undefined || stage.pipelines === undefined || stage.pipelines === null) return null;
  const stageResolved = record.values.get(stage.destinationField);
  const pipelineResolved = record.values.get(pipeline.destinationField);
  const stageValue = stageResolved === undefined ? null : intendedValue(stageResolved.intent);
  const pipelineValue = pipelineResolved === undefined ? null : intendedValue(pipelineResolved.intent);
  if (stageValue === null || pipelineValue === null) return null;
  const owner = stage.pipelines.pipelines.find((entry) => entry.pipelineInternalName === pipelineValue);
  // A pipeline the contract does not declare was withheld above by its own field.
  if (owner === undefined) return null;
  if (owner.stages.some((entry) => entry.stageInternalName === stageValue)) return null;
  return {
    reasonCode: 'DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN',
    detail: `"${stage.destinationField}" holds "${stageValue}", which is not a stage of pipeline "${pipelineValue}" in the attested contract for ${plan.object.apiName}.${stage.field.apiName}; the instance places a deal's stage inside the pipeline the record names`,
    field: stage.destinationField,
  };
}

/**
 * Records that would land on the same destination record, found without an
 * index of every record.
 *
 * For each key the destination matches on, every record that carries a value
 * for it is written down under that value and read back in value order, so the
 * records that collide arrive together and only a colliding group is held.
 */
function applyDestinationKeyConflicts(
  records: SpooledFamily<ResolvedRecord>,
  config: MigrationConfig,
  adapter: DestinationAdapter,
  scratch: ScratchStore,
): { records: SpooledFamily<ResolvedRecord>; conflicts: readonly DestinationConflictEntry[] } {
  const conflicts: DestinationConflictEntry[] = [];
  const isolateKeys = new Map<string, DestinationConflictEntry>();

  for (const spec of adapter.objects) {
    for (const keyField of spec.destinationMatchingKeys) {
      const shared = openFamily<{ folded: string; migrationKey: string; rowLocatorIds: string[] }>(scratch, {
        schema: `conflict-${spec.object.toLowerCase()}-${keyField.replace(/[^A-Za-z0-9]+/gu, "-")}`,
        key: (entry) => orderKey(orderText(entry.folded), entry.migrationKey),
      });
      for (const record of records) {
        if (record.isolation !== null) continue;
        if (record.object !== spec.object) continue;
        const value = intendedValue(record.values.get(keyField)?.intent ?? omit('NO_VALUE_PRODUCED'));
        if (isBlank(value)) continue;
        // Destination matching on these keys is case-insensitive at both CRM destinations.
        shared.add({
          folded: (value as string).toLowerCase(),
          migrationKey: record.migrationKey,
          rowLocatorIds: record.members.map((member) => member.address.rowLocatorId),
        });
      }

      for (const [value, bucket] of collisionsOf(shared.seal())) {
        if (bucket.length < 2) continue;
        const entry: DestinationConflictEntry = {
          object: spec.object,
          keyField,
          keyValue: value,
          migrationKeys: sorted(bucket.map((entry) => entry.migrationKey), compareCodeUnits),
          rowLocatorIds: sorted(
            bucket.flatMap((entry) => entry.rowLocatorIds),
            compareCodeUnits,
          ),
          reasonCode: 'DESTINATION_KEY_CONFLICT',
          detail: `${adapter.mode} matches ${spec.object} records on ${keyField}; ${String(bucket.length)} records the source proves to be different share the value "${value}", so importing them would merge them`,
        };
        conflicts.push(entry);
        if (config.policies.destinationKeyConflict === 'ISOLATE') {
          for (const entryOf of bucket) isolateKeys.set(entryOf.migrationKey, entry);
        }
      }
    }
  }

  // Applied as the records are read, for the same reason the validation is.
  //
  // This wrote a 'records-after-conflicts' family: one entry per record, keyed
  // by the migration key the record was already sorted under, differing from
  // its input only in the isolation carried by whichever records collided.
  // `isolateKeys` is bounded by the collisions it found rather than by the run,
  // and it is complete before the first record is read back, so the same answer
  // is a lookup on the way past.
  const applyConflict = (record: ResolvedRecord): ResolvedRecord => {
    const conflict = isolateKeys.get(record.migrationKey);
    return conflict === undefined || record.isolation !== null
      ? record
      : withIsolation(record, 'DESTINATION_KEY_CONFLICT', conflict.detail);
  };

  return {
    records: mapFamily(records, applyConflict),
    conflicts: sorted(
      conflicts,
      by(onString((entry) => entry.object), onString((entry) => entry.keyField), onString((entry) => entry.keyValue)),
    ),
  };
}

function withIsolation(
  record: ResolvedRecord,
  reasonCode:
    | DestinationConflictEntry['reasonCode']
    | 'DESTINATION_REQUIRED_FIELD_MISSING'
    | 'DESTINATION_VALUE_TOO_LONG'
    | InstanceFindingCode
    | 'TARGET_CLEAR_NOT_REPRESENTABLE'
    | 'TARGET_CLEAR_TOKEN_COLLISION',
  detail: string,
  field: string | null = null,
): ResolvedRecord {
  return { ...record, isolation: { reasonCode, detail, field } };
}

function isBlank(value: string | null): boolean {
  return value === null || value.length === 0;
}

/**
 * Values a spreadsheet application would treat as a formula when the file is
 * double-clicked. The import file keeps the exact value; this only feeds a
 * warning artifact so the operator knows not to open it in Excel first.
 */
export function startsLikeFormula(value: string): boolean {
  const first = value[0];
  if (first === undefined) return false;
  if (first === '=' || first === '+' || first === '@' || first === '\t' || first === '\r') return true;
  if (first === '-') {
    const second = value[1];
    return second !== undefined && !/[0-9.]/u.test(second);
  }
  return false;
}

/**
 * The records sharing each destination key value, one group at a time.
 *
 * The family arrives in value order, so a group is the run of entries with the
 * same value and only that run is held.
 */
function* collisionsOf(
  shared: SpooledFamily<{ folded: string; migrationKey: string; rowLocatorIds: string[] }>,
): IterableIterator<[string, { migrationKey: string; rowLocatorIds: string[] }[]]> {
  let folded: string | null = null;
  let held: { migrationKey: string; rowLocatorIds: string[] }[] = [];
  for (const entry of shared) {
    if (entry.folded !== folded) {
      if (folded !== null && held.length > 0) yield [folded, held];
      folded = entry.folded;
      held = [];
    }
    held.push({ migrationKey: entry.migrationKey, rowLocatorIds: entry.rowLocatorIds });
  }
  if (folded !== null && held.length > 0) yield [folded, held];
}
