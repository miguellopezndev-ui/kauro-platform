/**
 * Closed request schemas of the four B08 audit commands (10 "Version and validation": JSON Schema 2020-12, closed objects, no
 * coercion, no defaults; reference/COMMAND_CATALOGUE "Request fields: ... Extra fields reject"): StartAudit names the target contract
 * and the audit policy version, CancelAudit the audit version, CreatePlan the candidate decision artifact and ValidatePlan the plan
 * version with the plan hash — and the closed envelope of the decision-artifact intake (D8-PLAN-1).
 *
 * Kept apart from B06's REQUEST_SCHEMAS, B07's SOURCE_REQUEST_SCHEMAS and the execution package's under the same id prefix, so admission
 * resolves `urn:kauro:api:v1:request:CMDnnn` the same way for every command once the validator compiles the sets. Only the keyword
 * vocabulary of the strict compiler is used (no oneOf/anyOf).
 */
import { LABEL_PATTERN, REQUEST_SCHEMA_PREFIX, type RequestSchema } from "../api/request-schemas.js";

const ID = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" } as const;
/** B06 label: 1..200 characters, no Unicode Cc code point (C0, DEL, C1) — the rule of kauro.is_label (B06 D-LABEL-1, N6). */
const LABEL = { type: "string", minLength: 1, maxLength: 200, pattern: LABEL_PATTERN } as const;
const VERSION = { type: "integer", minimum: 1, maximum: 9007199254740991 } as const;
const HASH = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;

function schema(command: string, required: ReadonlyArray<string>, properties: RequestSchema["properties"]): RequestSchema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: REQUEST_SCHEMA_PREFIX + command,
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
}

export const AUDIT_REQUEST_SCHEMAS = Object.freeze({
  /** CreateTargetContract. */
  CMD018: schema("CMD018", ["metadataArtifactRef", "importerProfileId"], { metadataArtifactRef: ID, importerProfileId: ID }),
  /** ConfirmTargetContract. */
  CMD019: schema("CMD019", ["expectedVersion", "bodyHash", "confirmationEvidenceRef"], { expectedVersion: VERSION, bodyHash: HASH, confirmationEvidenceRef: ID }),
  /** SubmitStageReceipt. */
  CMD040: schema("CMD040", ["receiptUploadRef", "sourcePackageHash"], { receiptUploadRef: ID, sourcePackageHash: HASH }),
  /** ContinueStage. */
  CMD041: schema("CMD041", ["expectedVersion", "validatedReceiptHash"], { expectedVersion: VERSION, validatedReceiptHash: HASH }),
  /** StartAudit. */
  CMD020: schema("CMD020", ["targetContractId", "auditPolicyVersion"], { targetContractId: ID, auditPolicyVersion: LABEL }),
  /** CancelAudit. */
  CMD021: schema("CMD021", ["expectedVersion"], { expectedVersion: VERSION }),
  /** CreatePlan. */
  CMD022: schema("CMD022", ["candidateDecisionArtifactRef"], { candidateDecisionArtifactRef: ID }),
  /** ValidatePlan. */
  CMD024: schema("CMD024", ["expectedVersion", "planHash"], { expectedVersion: VERSION, planHash: HASH }),
} as const);

export type AuditRequestSchemaCommand = keyof typeof AUDIT_REQUEST_SCHEMAS;
export type AuditRequestSchemaId = `${typeof REQUEST_SCHEMA_PREFIX}${AuditRequestSchemaCommand}`;

export const AUDIT_REQUEST_SCHEMA_IDS: ReadonlyArray<AuditRequestSchemaId> = Object.keys(AUDIT_REQUEST_SCHEMAS).map(
  (k) => `${REQUEST_SCHEMA_PREFIX}${k as AuditRequestSchemaCommand}` as const,
);

/** Document schema id of the decision-artifact intake (auxiliary route, decision D8-CMA-7). */
export const DECISION_ARTIFACT_SCHEMA_ID = "urn:kauro:api:v1:document:DecisionArtifact" as const;

/**
 * The closed envelope of a decision artifact: which of the two kinds it is (a CANDIDATE_DECISIONS document CMD022 compiles, a
 * DECISION_PATCH document CMD023 applies) and the document itself. The document's own shape belongs to the Intelligence core's
 * compiler, which the platform reaches only through its port (PlanCompilerPort); the envelope therefore states only that it is one
 * JSON object, and the compiler rejects anything else with its closed reasons (D8-CMA-7). The bound of the stored document is the
 * database's (256 KiB) and is checked by the handler before it is stored (BODY_TOO_LARGE).
 */
export const DECISION_ARTIFACT_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: DECISION_ARTIFACT_SCHEMA_ID,
  type: "object",
  additionalProperties: false,
  required: ["kind", "document"],
  properties: {
    kind: { type: "string", enum: ["CANDIDATE_DECISIONS", "DECISION_PATCH"] },
    document: { type: "object" },
  },
} as const);
