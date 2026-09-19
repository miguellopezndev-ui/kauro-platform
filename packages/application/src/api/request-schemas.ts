/**
 * Closed request schemas (JSON Schema 2020-12) for the B06 commands (10 "Version and validation": closed objects, no
 * coercion, no defaults, unknown fields reject — R2-058, R2-059; reference/COMMAND_CATALOGUE.md: "Request fields: ...
 * Path IDs are resolved with server-owned tenant scope. Extra fields reject.").
 *
 * Property names are exactly the registry field names of each command (a test proves it against commands.json). Scalar shapes
 * follow the field vocabulary of @kauro/contracts: id = lowercase RFC 9562 UUID, label = 1..200 characters without control
 * characters, version = positive safe integer, hash = lowercase SHA-256 hex. These are wire input contracts only: server-owned
 * state, hashes derived from bytes, tenant membership and qualification flags are never request members.
 */
export const REQUEST_SCHEMA_PREFIX = "urn:kauro:api:v1:request:";

const ID = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" } as const;
const LABEL = { type: "string", minLength: 1, maxLength: 200, pattern: "^[^\\u0000-\\u001f\\u007f]+$" } as const;
const VERSION = { type: "integer", minimum: 1, maximum: 9007199254740991 } as const;
const HASH = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;
const REASON_CODE = { type: "string", pattern: "^[A-Z][A-Z0-9_]{2,63}$" } as const;
const MODE = { type: "string", enum: ["CLEAN", "HUBSPOT", "SALESFORCE"] } as const;

export interface RequestSchema {
  readonly $schema: "https://json-schema.org/draft/2020-12/schema";
  readonly $id: string;
  readonly type: "object";
  readonly additionalProperties: false;
  readonly required: ReadonlyArray<string>;
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

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

export const REQUEST_SCHEMAS = Object.freeze({
  /** CreateAgency. */
  CMD001: schema("CMD001", ["displayName"], { displayName: LABEL }),
  /** CreateClient. */
  CMD009: schema("CMD009", ["displayName", "processingAuthorityRef"], { displayName: LABEL, processingAuthorityRef: ID }),
  /** ArchiveClient. */
  CMD010: schema("CMD010", ["expectedVersion"], { expectedVersion: VERSION }),
  /** CreateProject: targetInstanceRef is optional in the schema and required by the handler for HUBSPOT/SALESFORCE (D-CMD-4). */
  CMD011: schema("CMD011", ["mode", "purpose"], { mode: MODE, purpose: LABEL, targetInstanceRef: ID }),
  /** RevisePlan. */
  CMD023: schema("CMD023", ["expectedVersion", "decisionPatchArtifactRef"], { expectedVersion: VERSION, decisionPatchArtifactRef: ID }),
  /** ApprovePlan. */
  CMD025: schema("CMD025", ["expectedVersion", "planHash", "validationReceiptHash", "disclosuresHash", "assuranceProofRef"], {
    expectedVersion: VERSION,
    planHash: HASH,
    validationReceiptHash: HASH,
    disclosuresHash: HASH,
    assuranceProofRef: ID,
  }),
  /** WithdrawApproval. */
  CMD026: schema("CMD026", ["expectedVersion", "reasonCode"], { expectedVersion: VERSION, reasonCode: REASON_CODE }),
} as const);

export type RequestSchemaCommand = keyof typeof REQUEST_SCHEMAS;
export type RequestSchemaId = `${typeof REQUEST_SCHEMA_PREFIX}${RequestSchemaCommand}`;

export const REQUEST_SCHEMA_IDS: ReadonlyArray<RequestSchemaId> = Object.keys(REQUEST_SCHEMAS).map((k) => `${REQUEST_SCHEMA_PREFIX}${k as RequestSchemaCommand}` as const);

export function requestSchemaId(command: RequestSchemaCommand): RequestSchemaId {
  return `${REQUEST_SCHEMA_PREFIX}${command}`;
}
