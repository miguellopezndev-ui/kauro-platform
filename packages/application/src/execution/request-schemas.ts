/**
 * Closed request schemas of the two B08 request commands (10 "Version and validation": JSON Schema 2020-12, closed objects, no
 * coercion, no defaults; reference/COMMAND_CATALOGUE "Request fields: ... Extra fields reject"): ExecuteProject names the
 * commercial authorization it spends and CancelJob the job version it cancels with its reason label.
 *
 * Kept apart from B06's REQUEST_SCHEMAS and B07's SOURCE_REQUEST_SCHEMAS under the same id prefix, so admission resolves
 * `urn:kauro:api:v1:request:CMDnnn` the same way for every command once the validator compiles the sets (mandate
 * B08-COMMANDS-EXECUTION, design §13). Only the keyword vocabulary of the strict compiler is used (no oneOf/anyOf).
 */
import { LABEL_PATTERN, REQUEST_SCHEMA_PREFIX, type RequestSchema } from "../api/request-schemas.js";

const ID = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" } as const;
/** B06 label: 1..200 characters, no Unicode Cc code point (C0, DEL, C1) — the rule of kauro.is_label (B06 D-LABEL-1, N6). */
const LABEL = { type: "string", minLength: 1, maxLength: 200, pattern: LABEL_PATTERN } as const;
const VERSION = { type: "integer", minimum: 1, maximum: 9007199254740991 } as const;

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

export const EXECUTION_REQUEST_SCHEMAS = Object.freeze({
  /** ExecuteProject. */
  CMD036: schema("CMD036", ["commercialAuthorizationId"], { commercialAuthorizationId: ID }),
  /** CancelJob. */
  CMD037: schema("CMD037", ["expectedVersion", "reasonCode"], { expectedVersion: VERSION, reasonCode: LABEL }),
} as const);

export type ExecutionRequestSchemaCommand = keyof typeof EXECUTION_REQUEST_SCHEMAS;
export type ExecutionRequestSchemaId = `${typeof REQUEST_SCHEMA_PREFIX}${ExecutionRequestSchemaCommand}`;

export const EXECUTION_REQUEST_SCHEMA_IDS: ReadonlyArray<ExecutionRequestSchemaId> = Object.keys(EXECUTION_REQUEST_SCHEMAS).map(
  (k) => `${REQUEST_SCHEMA_PREFIX}${k as ExecutionRequestSchemaCommand}` as const,
);
