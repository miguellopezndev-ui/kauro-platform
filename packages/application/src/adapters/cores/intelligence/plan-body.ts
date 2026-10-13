/**
 * A drafted CandidateConfiguration as the platform's PlanBody (B05 D5-16; HASHING "Hash domain separation"). The plan body is the
 * agency-facing, closed semantic summary of the draft: one FieldMapping per configuration field, one IdentityDecision per record, one
 * TransformStep per primitive, one RelationshipDecision per association. It is not what executes: execution translates a plan only through
 * the stored binding (planHash -> the Migration Core configuration document and its core-native hash), so nothing here can widen what
 * runs. Every id and hash is a pure function of the configuration (a replayed compile is byte-identical); every value the platform hashes
 * structurally passes `assertCanonicalAgreement` first (a disagreement between the two serializers fails closed).
 */
import type { Sha256Hex } from "@kauro/contracts";
import type { DecisionEvidence, FieldMapping, IdentityDecision, RelationshipDecision, TransformStep } from "@kauro/contracts";
import type { PlanBody } from "@kauro/domain";
import type { CandidateConfiguration, ConfigFragmentField, DraftEvidence, DraftMigrationPlan } from "@kauro/intelligence-core";
import { platformDigestOfAgreed } from "@kauro/intelligence-core";

const HEX64 = /^[0-9a-f]{64}$/u;

export class MalformedDraft extends Error {
  constructor(detail: string) {
    super(`malformed draft: ${detail}`);
    this.name = "MalformedDraft";
  }
}

function digest(value: unknown): Sha256Hex {
  return platformDigestOfAgreed(value);
}

/** A fragment hash cited from the core: stored verbatim as a 64-hex string, never re-hashed (CORE_NATIVE). */
function cited(hash: string, what: string): Sha256Hex {
  if (!HEX64.test(hash)) throw new MalformedDraft(`${what} is not a 64-hex core-native identity`);
  return hash;
}

function provenanceOf(origin: DraftEvidence["origin"]): DecisionEvidence["provenance"] {
  return origin === "DETERMINISTIC" ? "RULE" : "MODEL_ASSISTED";
}

function evidenceFor(field: ConfigFragmentField, entry: DraftEvidence | undefined, ruleVersion: string): DecisionEvidence {
  const refs = entry?.evidenceRefs ?? [];
  return {
    evidenceId: `ev-${field.fragmentHash}`,
    candidateId: field.decisionRef,
    provenance: entry === undefined ? "RULE" : provenanceOf(entry.origin),
    factHashes: refs.map((ref) => (HEX64.test(ref) ? ref : digest({ evidenceRef: ref }))),
    ruleVersion,
    comparisonHash: digest({ decisionRef: field.decisionRef, rationaleCode: entry?.rationaleCode ?? null, destinationField: field.destinationField, semanticType: field.semanticType }),
    fragmentHash: cited(field.fragmentHash, "a field fragment hash"),
  };
}

/** The policy the plan was drafted under: the pinned model policy and prompt bundle, bound by hash. */
export function policyHashOf(draft: DraftMigrationPlan, policy: { readonly modelPolicyHash: string; readonly promptBundleHash: string }): Sha256Hex {
  return digest({ kind: "KAURO_IC_POLICY_V1", planVersion: draft.planVersion, modelPolicyHash: policy.modelPolicyHash, promptBundleHash: policy.promptBundleHash });
}

export interface PlanBodyInputs {
  readonly draft: DraftMigrationPlan;
  readonly configuration: CandidateConfiguration;
  readonly revisionHash: Sha256Hex;
  readonly targetContractHash: Sha256Hex;
  readonly policyHash: Sha256Hex;
}

export function planBodyOf(i: PlanBodyInputs): PlanBody {
  const ruleVersion = `kauro-intelligence-core ${i.draft.planVersion}`;
  const entries = new Map<string, DraftEvidence>();
  for (const e of i.draft.evidence) if (!entries.has(e.candidateRef)) entries.set(e.candidateRef, e);
  const byFragment = (a: { readonly fragmentHash: string }, b: { readonly fragmentHash: string }): number => (a.fragmentHash < b.fragmentHash ? -1 : a.fragmentHash > b.fragmentHash ? 1 : 0);
  const fields = [...i.configuration.fields].sort(byFragment);
  const objectOfRecord = new Map(i.configuration.records.map((r) => [r.recordId, r.object] as const));

  const mappings: FieldMapping[] = fields.map((f) => {
    const evidence = evidenceFor(f, entries.get(f.decisionRef), ruleVersion);
    return {
      mappingId: `map-${f.fragmentHash}`,
      sourceTableId: f.fileId,
      sourceFieldId: f.columnLocator,
      targetObject: f.object,
      targetField: f.destinationField,
      intent: { kind: "KEEP", reasonCode: entries.get(f.decisionRef)?.rationaleCode ?? "MAPPED" },
      evidence,
    };
  });

  const transforms: TransformStep[] = fields
    .filter((f) => f.transformPrimitive !== null)
    .map((f) => ({
      stepId: `step-${f.fragmentHash}`,
      primitive: f.transformPrimitive as string,
      inputFieldIds: [f.columnLocator],
      outputFieldId: `map-${f.fragmentHash}`,
      parameterSchemaId: `kauro.ic.transform.${f.transformPrimitive as string}`,
      parametersHash: digest({ primitive: f.transformPrimitive, params: f.typedTransformParams ?? {}, valueMap: f.valueMap ?? null, allowedValues: f.allowedValues ?? null }),
      dependsOn: [],
      evidenceId: `ev-${f.fragmentHash}`,
    }));

  // the audit never merges rows (D3-CAP-07): every record keeps its occurrences; the authoritative key columns live in the binding
  const identities: IdentityDecision[] = [...i.configuration.records].sort(byFragment).map((r) => ({
    decisionId: `id-${r.fragmentHash}`,
    objectScope: r.object,
    strategy: "PRESERVE_OCCURRENCES" as const,
    memberSetHash: digest({ recordId: r.recordId, fileId: r.fileId, filePath: r.filePath }),
    survivorRuleHash: digest({ rule: "NO_SURVIVOR_PRESERVE_OCCURRENCES" }),
    fieldConflictPolicyHash: digest({ policy: "NO_FIELD_CONFLICT_PRESERVE_OCCURRENCES" }),
  }));

  const relationships: RelationshipDecision[] = [...i.configuration.associations].sort(byFragment).map((a) => ({
    relationshipId: `rel-${a.fragmentHash}`,
    relationType: a.relationshipType,
    sourceObject: objectOfRecord.get(a.recordId) ?? "",
    targetObject: objectOfRecord.get(a.targetRecordId) ?? "",
    edgeSetHash: digest({ associationId: a.associationId, recordId: a.recordId, keyColumn: a.keyColumn.columnLocator, targetRecordId: a.targetRecordId, ownerSide: a.ownerSide }),
    resolution: "SOURCE_KEY" as const,
    identityEvidenceHash: digest({ targetMatchKey: a.targetMatchKey, targetRecordId: a.targetRecordId }),
    approvalHash: digest({ decisionRef: a.decisionRef, fragmentHash: cited(a.fragmentHash, "an association fragment hash") }),
  }));
  for (const r of relationships) if (r.sourceObject === "" || r.targetObject === "") throw new MalformedDraft("an association names a record mapping the configuration does not hold");

  return { revisionHash: i.revisionHash, targetContractHash: i.targetContractHash, policyHash: i.policyHash, mappings, identities, transforms, relationships };
}
