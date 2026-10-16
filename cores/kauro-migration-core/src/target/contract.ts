import { sha256Hex } from '../util/hash.js';
import { MigrationError } from '../domain/errors.js';
import { canonicalJsonText } from '../util/json.js';
import type { JsonObject, JsonValue } from '../util/json.js';
import type { TargetMode } from '../domain/config.js';

/**
 * The target contract.
 *
 * An adapter states what a vendor documents for everybody. A target contract
 * states what is true of one portal or one org: which properties exist, what
 * they are called internally, which values a picklist accepts, which field the
 * instance will match on. The two are different kinds of fact and the engine
 * must never substitute one for the other — a default pipeline, an assumed
 * unique property or a guessed stage is a claim about somebody's account that
 * nobody checked.
 *
 * A contract is captured, not queried. It is built from artifacts the agency
 * exported from their own instance, it records exactly which bytes it was built
 * from, and it is immutable once hashed. Nothing in this engine reaches the
 * network, so a contract is the only thing that can speak for an instance.
 */

export const TARGET_CONTRACT_VERSION = '1.0.0';

/** Version of the artifact-reading rules. A parser change that could read the same bytes differently changes this. */
export const TARGET_PARSER_VERSION = '1.0.0';

/**
 * Where a fact in the contract came from.
 *
 * `ARTIFACT` means an export the instance produced. `SUPPLEMENT` means the
 * agency stated it because the export does not carry it — HubSpot's property
 * export, for instance, does not say whether a property requires unique values.
 * A supplement is weaker evidence and is recorded as such rather than being
 * quietly promoted.
 */
export const TARGET_EVIDENCE_KINDS = ['ARTIFACT', 'SUPPLEMENT'] as const;
export type TargetEvidenceKind = (typeof TARGET_EVIDENCE_KINDS)[number];

/** A tri-state. `UNKNOWN` is not `false`: it is the absence of evidence, and it fails closed wherever the answer matters. */
export const TARGET_FLAGS = ['TRUE', 'FALSE', 'UNKNOWN'] as const;
export type TargetFlag = (typeof TARGET_FLAGS)[number];

export interface TargetPicklistValue {
  readonly value: string;
  readonly label: string;
  readonly active: boolean;
  readonly defaultValue: boolean;
}

export interface TargetFieldContract {
  /** The name the instance answers to. HubSpot calls it the internal name; Salesforce calls it the API name. */
  readonly apiName: string;
  /** What a person sees. Never used to address the field. */
  readonly label: string;
  /** The instance's own type token, recorded verbatim rather than mapped onto a type of ours. */
  readonly type: string;
  readonly createable: TargetFlag;
  readonly updateable: TargetFlag;
  readonly nillable: TargetFlag;
  readonly length: number | null;
  readonly precision: number | null;
  readonly scale: number | null;
  /**
   * Unique and externalId are separate facts and are modelled separately.
   * Marking a Salesforce field External ID does not make it Unique, and a field
   * that is External ID but not Unique can match two records on upsert.
   */
  readonly unique: TargetFlag;
  readonly externalId: TargetFlag;
  /** Salesforce: the field can name a record in an upsert. This, not externalId alone, is what upsert matching needs. */
  readonly idLookup: TargetFlag;
  readonly calculated: TargetFlag;
  readonly autoNumber: TargetFlag;
  readonly defaultedOnCreate: TargetFlag;
  readonly restrictedPicklist: TargetFlag;
  readonly picklistValues: readonly TargetPicklistValue[];
  readonly referenceTo: readonly string[];
  readonly relationshipName: string | null;
  readonly evidence: TargetEvidenceKind;
}

export interface TargetRecordType {
  /** The stable key. Record type ids differ between instances; the developer name does not. */
  readonly developerName: string;
  /** The translatable label. Never used to address a record type. */
  readonly name: string;
  readonly recordTypeId: string;
  readonly master: boolean;
  readonly available: boolean;
}

export interface TargetObjectContract {
  readonly apiName: string;
  readonly label: string;
  readonly createable: TargetFlag;
  readonly updateable: TargetFlag;
  readonly fields: readonly TargetFieldContract[];
  readonly recordTypes: readonly TargetRecordType[];
}

/** A HubSpot deal stage, addressed by the internal identifier the import actually matches on. */
export interface TargetPipelineStage {
  readonly stageLabel: string;
  readonly stageInternalName: string;
  readonly displayOrder: number | null;
}

export interface TargetPipeline {
  readonly objectApiName: string;
  readonly pipelineLabel: string;
  readonly pipelineInternalName: string;
  readonly stages: readonly TargetPipelineStage[];
}

/** Which instance this contract speaks for. A contract is bound to one instance and is not reusable across instances. */
export interface TargetInstanceIdentity {
  readonly mode: TargetMode;
  /** HubSpot portal id, or Salesforce org id. */
  readonly instanceId: string;
  /** Salesforce instance URL, or the HubSpot account name. Recorded as evidence, never as the key. */
  readonly instanceLabel: string;
  /** How the identity itself was established, so a contract cannot claim an instance nobody proved. */
  readonly evidence: TargetEvidenceKind;
}

/** One file the contract was built from, and the bytes it had when it was read. */
export interface TargetArtifactRef {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly kind: string;
}

export interface TargetContract {
  readonly contractVersion: string;
  readonly parserVersion: string;
  readonly instance: TargetInstanceIdentity;
  /** When the agency exported the artifacts, as they stated it. Not when this ran. */
  readonly capturedAt: string;
  readonly artifacts: readonly TargetArtifactRef[];
  readonly objects: readonly TargetObjectContract[];
  readonly pipelines: readonly TargetPipeline[];
}

/** A contract plus the digest that names it. The digest covers the contract exactly as written. */
export interface HashedTargetContract {
  readonly contract: TargetContract;
  readonly contractHash: string;
  /** The canonical bytes the hash was taken over, so a verifier can recompute rather than trust. */
  readonly canonicalJson: string;
}

/**
 * The contract as data, written out field by field.
 *
 * Deliberately not a cast. The digest names the contract, so what the digest
 * covers has to be a decision rather than whatever the type happened to carry
 * on the day: a field added to the interface and forgotten here would be a
 * field a tampered contract could change without changing its name. Every
 * property below is listed on purpose, and a new one has to be added here to
 * count.
 */
export function targetContractToJson(contract: TargetContract): JsonObject {
  return {
    contractVersion: contract.contractVersion,
    parserVersion: contract.parserVersion,
    capturedAt: contract.capturedAt,
    instance: {
      mode: contract.instance.mode,
      instanceId: contract.instance.instanceId,
      instanceLabel: contract.instance.instanceLabel,
      evidence: contract.instance.evidence,
    },
    artifacts: contract.artifacts.map(
      (artifact): JsonValue => ({
        path: artifact.path,
        sha256: artifact.sha256,
        byteLength: artifact.byteLength,
        kind: artifact.kind,
      }),
    ),
    objects: contract.objects.map(
      (object): JsonValue => ({
        apiName: object.apiName,
        label: object.label,
        createable: object.createable,
        updateable: object.updateable,
        fields: object.fields.map(
          (field): JsonValue => ({
            apiName: field.apiName,
            label: field.label,
            type: field.type,
            createable: field.createable,
            updateable: field.updateable,
            nillable: field.nillable,
            length: field.length,
            precision: field.precision,
            scale: field.scale,
            unique: field.unique,
            externalId: field.externalId,
            idLookup: field.idLookup,
            calculated: field.calculated,
            autoNumber: field.autoNumber,
            defaultedOnCreate: field.defaultedOnCreate,
            restrictedPicklist: field.restrictedPicklist,
            picklistValues: field.picklistValues.map(
              (option): JsonValue => ({
                value: option.value,
                label: option.label,
                active: option.active,
                defaultValue: option.defaultValue,
              }),
            ),
            referenceTo: [...field.referenceTo],
            relationshipName: field.relationshipName,
            evidence: field.evidence,
          }),
        ),
        recordTypes: object.recordTypes.map(
          (recordType): JsonValue => ({
            developerName: recordType.developerName,
            name: recordType.name,
            recordTypeId: recordType.recordTypeId,
            master: recordType.master,
            available: recordType.available,
          }),
        ),
      }),
    ),
    pipelines: contract.pipelines.map(
      (pipeline): JsonValue => ({
        objectApiName: pipeline.objectApiName,
        pipelineLabel: pipeline.pipelineLabel,
        pipelineInternalName: pipeline.pipelineInternalName,
        stages: pipeline.stages.map(
          (stage): JsonValue => ({
            stageLabel: stage.stageLabel,
            stageInternalName: stage.stageInternalName,
            displayOrder: stage.displayOrder,
          }),
        ),
      }),
    ),
  };
}

/**
 * Name a contract by its content.
 *
 * The digest covers every field, including the artifact hashes, so a contract
 * cannot be edited after capture without the name changing. The canonical
 * writer sorts keys and rejects anything non-finite, so two runs over the same
 * contract produce the same bytes on any platform.
 */
export function hashTargetContract(contract: TargetContract): HashedTargetContract {
  const json = canonicalJsonText(targetContractToJson(contract));
  return { contract, contractHash: `tc_${sha256Hex(json)}`, canonicalJson: json };
}

/**
 * A contract on disk: the contract itself, and the name it claims.
 *
 * The claimed name is written down so a reader can disagree with it. Nothing
 * trusts it: `loadTargetContract` recomputes the digest from the content and
 * refuses a file whose content and name have parted company, which is what a
 * contract edited after capture looks like.
 */
export function serializeTargetContract(hashed: HashedTargetContract): string {
  return canonicalJsonText({
    contractHash: hashed.contractHash,
    contract: targetContractToJson(hashed.contract),
  });
}

/**
 * Read a captured contract, and refuse one that has been edited since.
 *
 * The whole value of a target contract is that it is evidence about somebody's
 * instance. Evidence that can be edited on the way to the decision is not
 * evidence, so the digest is recomputed here rather than read.
 */
export function loadTargetContract(text: string, origin: string): HashedTargetContract {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text) as JsonValue;
  } catch {
    throw new MigrationError(
      'TARGET_CONTRACT_INVALID',
      `${origin} is not valid JSON`,
      'Supply the target contract exactly as it was captured. Do not edit it.',
      { origin },
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MigrationError(
      'TARGET_CONTRACT_INVALID',
      `${origin} is not a target contract`,
      'Supply the file the capture produced.',
      { origin },
    );
  }
  const claimed = (parsed as JsonObject)['contractHash'];
  const body = (parsed as JsonObject)['contract'];
  if (typeof claimed !== 'string' || body === undefined || body === null || typeof body !== 'object') {
    throw new MigrationError(
      'TARGET_CONTRACT_INVALID',
      `${origin} does not carry both a contract and the digest that names it`,
      'Supply the file the capture produced, with its contractHash intact.',
      { origin },
    );
  }

  const contract = body as unknown as TargetContract;
  let recomputed: HashedTargetContract;
  try {
    // Writing the contract out is also what checks its shape: a file missing an
    // array this walks is a file that cannot be named, and it fails here as a
    // refusal rather than further along as a type error.
    recomputed = hashTargetContract(contract);
  } catch (cause) {
    throw new MigrationError(
      'TARGET_CONTRACT_INVALID',
      `${origin} is not shaped like a target contract`,
      'Supply the file the capture produced. A contract this reader cannot write out is one it cannot name, and an unnamed contract is not evidence.',
      { origin, detail: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  if (recomputed.contractHash !== claimed) {
    throw new MigrationError(
      'TARGET_CONTRACT_INVALID',
      `${origin} does not hash to the digest it claims`,
      'The contract has changed since it was captured. Capture the target schema again rather than repairing this file: a contract whose content and name disagree is not evidence about anything.',
      { origin, claimed, recomputed: recomputed.contractHash },
    );
  }
  return recomputed;
}

export function findObject(contract: TargetContract, apiName: string): TargetObjectContract | null {
  return contract.objects.find((object) => object.apiName === apiName) ?? null;
}

export function findField(object: TargetObjectContract, apiName: string): TargetFieldContract | null {
  return object.fields.find((field) => field.apiName === apiName) ?? null;
}

export function findPipeline(contract: TargetContract, objectApiName: string, label: string): TargetPipeline | null {
  return (
    contract.pipelines.find(
      (pipeline) =>
        pipeline.objectApiName === objectApiName &&
        (pipeline.pipelineLabel === label || pipeline.pipelineInternalName === label),
    ) ?? null
  );
}

export function findStage(pipeline: TargetPipeline, label: string): TargetPipelineStage | null {
  return (
    pipeline.stages.find((stage) => stage.stageLabel === label || stage.stageInternalName === label) ?? null
  );
}

/**
 * A field's flag, read the way a decision has to read it.
 *
 * `UNKNOWN` answers `false` here on purpose. Every caller asks this to decide
 * whether it may do something — match on a field, load a value, trust a
 * picklist — and "nobody established it" must never authorise the action.
 */
export function isDefinitely(flag: TargetFlag): boolean {
  return flag === 'TRUE';
}
