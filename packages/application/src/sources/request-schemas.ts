/**
 * Closed request schemas of the six B07 commands and the selection manifest document (10 "Version and validation": JSON Schema
 * 2020-12, closed objects, no coercion, no defaults; reference/COMMAND_CATALOGUE "Request fields: ... Extra fields reject").
 *
 * Kept apart from B06's REQUEST_SCHEMAS (whose test counts its seven members) under the same id prefix, so admission resolves
 * `urn:kauro:api:v1:request:CMDnnn` the same way for every command once the validator compiles both sets (mandate
 * B07-COMMANDS, design §13). Scalar shapes follow the B06 field vocabulary; `count` is a non-negative safe integer and `text` a
 * bounded string without control characters. Only the keyword vocabulary of the strict compiler is used (no oneOf/anyOf):
 * dependent requirements (a CSV table's dialect, an exclusion's reason) are checked by the domain validator of CMD016.
 */
import type { RequestSchema } from "../api/request-schemas.js";
import { LABEL_PATTERN, REQUEST_SCHEMA_PREFIX } from "../api/request-schemas.js";

const ID = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" } as const;
/** B06 label: 1..200 characters, no Unicode Cc code point (C0, DEL, C1) — the rule of kauro.is_label (B06 D-LABEL-1, N6). */
const LABEL = { type: "string", minLength: 1, maxLength: 200, pattern: LABEL_PATTERN } as const;
const VERSION = { type: "integer", minimum: 1, maximum: 9007199254740991 } as const;
const HASH = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;
const COUNT = { type: "integer", minimum: 0, maximum: 9007199254740991 } as const;
/**
 * CMD014 providerCompletionRef (registry type text): an opaque provider completion token the browser forwards, bounded, with the
 * label control-character rule (decision D-SAPI-2).
 */
const TEXT = { type: "string", minLength: 1, maxLength: 4096, pattern: LABEL_PATTERN } as const;
/** CMD013 declaredFormat: a catalogue label narrowed to the supported formats (FileManifest.format), as B06 narrows CMD011 mode (D-SAPI-4). */
const DECLARED_FORMAT = { type: "string", enum: ["CSV", "XLSX"] } as const;
const TOKEN = { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" } as const;
const ORDINAL = { type: "integer", minimum: 0, maximum: 16383 } as const;

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

export const SOURCE_REQUEST_SCHEMAS = Object.freeze({
  /** CreateRevision. */
  CMD012: schema("CMD012", ["expectedVersion", "supersedesRevisionId"], { expectedVersion: VERSION, supersedesRevisionId: ID }),
  /** ReserveUpload. */
  CMD013: schema("CMD013", ["expectedVersion", "declaredBytes", "declaredFormat", "displayName"], {
    expectedVersion: VERSION,
    declaredBytes: COUNT,
    declaredFormat: DECLARED_FORMAT,
    displayName: LABEL,
  }),
  /** CompleteUpload. */
  CMD014: schema("CMD014", ["providerCompletionRef"], { providerCompletionRef: TEXT }),
  /** CancelUpload. */
  CMD015: schema("CMD015", ["expectedVersion"], { expectedVersion: VERSION }),
  /** SelectInputTables. */
  CMD016: schema("CMD016", ["expectedVersion", "selectionManifestRef"], { expectedVersion: VERSION, selectionManifestRef: ID }),
  /** SealRevision. */
  CMD017: schema("CMD017", ["expectedVersion", "selectionHash"], { expectedVersion: VERSION, selectionHash: HASH }),
} as const);

export type SourceRequestSchemaCommand = keyof typeof SOURCE_REQUEST_SCHEMAS;
export type SourceRequestSchemaId = `${typeof REQUEST_SCHEMA_PREFIX}${SourceRequestSchemaCommand}`;

export const SOURCE_REQUEST_SCHEMA_IDS: ReadonlyArray<SourceRequestSchemaId> = Object.keys(SOURCE_REQUEST_SCHEMAS).map(
  (k) => `${REQUEST_SCHEMA_PREFIX}${k as SourceRequestSchemaCommand}` as const,
);

/** Document schema id of the selection manifest intake (auxiliary route, decision D-SEL-2). */
export const SELECTION_MANIFEST_SCHEMA_ID = "urn:kauro:api:v1:document:SelectionManifest" as const;

const PARSER = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { type: "string", enum: ["CSV", "WORKSHEET"] },
    encoding: { type: "string", enum: ["UTF_8", "UTF_16LE", "UTF_16BE", "WINDOWS_1252", "LATIN_1"] },
    delimiter: { type: "string", enum: ["COMMA", "SEMICOLON", "TAB", "PIPE"] },
    quote: { type: "string", enum: ["DOUBLE_QUOTE", "NONE"] },
    header: {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: { mode: { type: "string", enum: ["FIRST_RECORD", "ROW", "NONE"] }, rowIndex: { type: "integer", minimum: 0, maximum: 1048575 } },
    },
    blankLines: { type: "string", enum: ["COUNT_AS_RECORDS", "SKIP"] },
    formulas: { type: "string", enum: ["NOT_PRESENT", "REJECT_FORMULAS", "USE_PRESENT_CACHED_VALUES_WITH_DISCLOSURE"] },
    hiddenRows: { type: "string", enum: ["INCLUDE", "EXCLUDE"] },
    hiddenColumns: { type: "string", enum: ["INCLUDE", "EXCLUDE"] },
    mergedCells: { type: "string", enum: ["AS_OBSERVED"] },
  },
} as const;

/**
 * The closed selection manifest document (domain SelectionManifestDocument). Bounds: 50 files, 4096 tables, 800 selected
 * columns per table, 1024 projections and associations. Ids, digests, tokens and positions only — no customer text.
 */
export const SELECTION_MANIFEST_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: SELECTION_MANIFEST_SCHEMA_ID,
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "revisionId", "inventoryHash", "files", "tables", "projections", "associations"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    revisionId: ID,
    inventoryHash: HASH,
    files: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fileId", "origin", "disposition"],
        properties: {
          fileId: ID,
          origin: { type: "string", enum: ["THIS_REVISION", "REUSED"] },
          disposition: { type: "string", enum: ["INCLUDE", "EXCLUDE"] },
          exclusionReason: TOKEN,
        },
      },
    },
    tables: {
      type: "array",
      maxItems: 4096,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tableId", "fileId", "structureHash", "disposition"],
        properties: {
          tableId: ID,
          fileId: ID,
          structureHash: HASH,
          disposition: { type: "string", enum: ["INCLUDE", "EXCLUDE"] },
          exclusionReason: TOKEN,
          hiddenSheetAcknowledged: { type: "boolean", const: true },
          parser: PARSER,
          selectedColumns: { type: "array", minItems: 1, maxItems: 800, items: ORDINAL },
        },
      },
    },
    projections: {
      type: "array",
      maxItems: 1024,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["projectionKey", "tableId", "objectKind", "kind", "fieldOrdinals"],
        properties: {
          projectionKey: TOKEN,
          tableId: ID,
          objectKind: TOKEN,
          kind: { type: "string", enum: ["ROW", "REFERENCED_ENTITY"] },
          fieldOrdinals: { type: "array", minItems: 1, maxItems: 800, items: ORDINAL },
          keyOrdinals: { type: "array", minItems: 1, maxItems: 16, items: ORDINAL },
          keyConfirmed: { type: "boolean", const: true },
        },
      },
    },
    associations: {
      type: "array",
      maxItems: 1024,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["associationKey", "tableId", "fromProjectionKey", "toProjectionKey", "relationType"],
        properties: {
          associationKey: TOKEN,
          tableId: ID,
          fromProjectionKey: TOKEN,
          toProjectionKey: TOKEN,
          relationType: TOKEN,
        },
      },
    },
  },
} as const);
