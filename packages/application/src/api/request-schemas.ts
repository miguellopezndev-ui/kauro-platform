/**
 * Closed request schemas (JSON Schema 2020-12) for the B06 commands (10 "Version and validation": closed objects, no
 * coercion, no defaults, unknown fields reject — R2-058, R2-059; reference/COMMAND_CATALOGUE.md: "Request fields: ...
 * Path IDs are resolved with server-owned tenant scope. Extra fields reject.").
 *
 * Property names are exactly the registry field names of each command (a test proves it against commands.json). Scalar shapes
 * follow the field vocabulary of @kauro/contracts: id = lowercase RFC 9562 UUID, label = 1..200 characters without control
 * characters, version = positive safe integer, hash = lowercase SHA-256 hex. CMD026 reasonCode is typed `label` by the
 * registry and reference/FIELD_CONTRACTS (every reasonCode field of the catalogue is a label), so it is a label here too
 * (decision D-API-1). These are wire input contracts only: server-owned
 * state, hashes derived from bytes, tenant membership and qualification flags are never request members.
 */
export const REQUEST_SCHEMA_PREFIX = "urn:kauro:api:v1:request:";

const ID = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" } as const;
/**
 * A label: 1..200 characters with no control character, a control character being a code point of Unicode General Category Cc
 * (C0 U+0000..U+001F, DEL U+007F and C1 U+0080..U+009F) — exactly what kauro.is_label (migration 0001) and the domain's isLabel
 * refuse, so the closed schema is the whole contract of the field (re-check finding N6).
 */
export const LABEL_PATTERN = "^[^\\u0000-\\u001f\\u007f-\\u009f]+$";
const LABEL = { type: "string", minLength: 1, maxLength: 200, pattern: LABEL_PATTERN } as const;
const VERSION = { type: "integer", minimum: 1, maximum: 9007199254740991 } as const;
/** requestedSeconds of CMD060: 1..259200 (registry: at most 259200 seconds; 09: seventy-two hours). */
const EXTENSION_SECONDS = { type: "integer", minimum: 1, maximum: 259200 } as const;
const HASH = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;
const MODE = { type: "string", enum: ["CLEAN", "HUBSPOT", "SALESFORCE"] } as const;
const SUPPORT_CATEGORY = { type: "string", enum: ["PRODUCT_DEFECT", "IMPORT_GUIDANCE", "BILLING", "PRIVACY", "SECURITY", "GENERAL"] } as const;
/** The raw single-use invitation token: 32 random bytes in base64url is 43 characters; the bound admits nothing but that alphabet (CMD004). */
const INVITATION_TOKEN = { type: "string", minLength: 16, maxLength: 512, pattern: "^[A-Za-z0-9_-]+$" } as const;
/**
 * A text: at least one visible character, and no control character but the tab, the line feed and the carriage return (the
 * Unicode Cc set minus U+0009, U+000A and U+000D; U+0000 is refused with the rest), which is what the support_cases summary
 * check of migration 0026 keeps (PostgreSQL refuses NUL before any check). The lookahead scans the text once.
 */
export const TEXT_PATTERN = "^(?=[\\s\\S]*\\S)[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]+$";
/** A support summary is 20..4000 characters (design section 5, W4 row). */
const SUPPORT_SUMMARY = { type: "string", minLength: 20, maxLength: 4000, pattern: TEXT_PATTERN } as const;

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
  CMD026: schema("CMD026", ["expectedVersion", "reasonCode"], { expectedVersion: VERSION, reasonCode: LABEL }),
  /**
   * CreateSupportCase (B11 W4): the requester names the category and the summary only; the severity, the state and the next
   * review are the server's. evidenceRefs is an empty list until the upload package (B07) serves upload ids the case may
   * cite (D-SUP-2): a non-empty list is a schema violation, and the column keeps the registry bound of ten.
   */
  CMD044: schema("CMD044", ["category", "summary"], { category: SUPPORT_CATEGORY, summary: SUPPORT_SUMMARY, evidenceRefs: { type: "array", maxItems: 0, items: ID } }),
  /**
   * The team commands of B16 (G-TENANT). CMD003 names the intended identity (an id) and the role (a label: the closed role set is
   * the domain's, so a client-invented role is an ENUM refusal of the handler, not a schema accident). CMD004 carries the raw
   * single-use token and nothing else: the agency is the one the caller's own invitation names. CMD005/CMD007 carry the step-up
   * proof; CMD006 the reason.
   */
  CMD003: schema("CMD003", ["expectedVersion", "intendedIdentityRef", "role"], { expectedVersion: VERSION, intendedIdentityRef: ID, role: LABEL }),
  CMD004: schema("CMD004", ["invitationToken"], { invitationToken: INVITATION_TOKEN }),
  CMD005: schema("CMD005", ["expectedVersion", "role", "assuranceProofRef"], { expectedVersion: VERSION, role: LABEL, assuranceProofRef: ID }),
  CMD006: schema("CMD006", ["expectedVersion", "reasonCode"], { expectedVersion: VERSION, reasonCode: LABEL }),
  CMD007: schema("CMD007", ["expectedVersion", "newOwnerMembershipId", "assuranceProofRef"], { expectedVersion: VERSION, newOwnerMembershipId: ID, assuranceProofRef: ID }),
  /** RequestRetentionExtension (B16 L2): the one explicit extension, at most 72 h; the hard cap is not a request member and never moves. */
  CMD060: schema("CMD060", ["expectedVersion", "requestedSeconds", "purpose", "termsVersion"], { expectedVersion: VERSION, requestedSeconds: EXTENSION_SECONDS, purpose: LABEL, termsVersion: LABEL }),
} as const);

export type RequestSchemaCommand = keyof typeof REQUEST_SCHEMAS;
export type RequestSchemaId = `${typeof REQUEST_SCHEMA_PREFIX}${RequestSchemaCommand}`;

export const REQUEST_SCHEMA_IDS: ReadonlyArray<RequestSchemaId> = Object.keys(REQUEST_SCHEMAS).map((k) => `${REQUEST_SCHEMA_PREFIX}${k as RequestSchemaCommand}` as const);

export function requestSchemaId(command: RequestSchemaCommand): RequestSchemaId {
  return `${REQUEST_SCHEMA_PREFIX}${command}`;
}
