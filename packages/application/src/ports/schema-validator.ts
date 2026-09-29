/**
 * Schema validation port (10 "Version and validation": JSON Schema 2020-12, closed objects, Ajv strict with coerceTypes=false,
 * removeAdditional=false, useDefaults=false; customer-supplied target metadata is data validated by trusted schemas, never a
 * schema compiled as code).
 *
 * The port is closed by construction: a validator can be asked for a schema only by a KnownSchemaId — a registry contract name
 * (urn:kauro:r2:contracts#/$defs/<Name>), a request or response schema of this package, or the Problem document. There is no
 * `compile(schema)` entry; an adapter that receives an unknown id fails with INTEGRITY_FAILURE before touching any input
 * (S093). Calendar format assertions (date-time with at most three fractional digits, real Gregorian instants) must be enabled
 * and tested by the adapter; a regex or a missing format package must not create silent acceptance (10 "Schema format
 * execution").
 */
import type { ContractName } from "@kauro/contracts";
import type { FieldError } from "@kauro/domain";
import type { RequestSchemaId } from "../api/request-schemas.js";
import type { ResponseSchemaId } from "../api/response-schemas.js";
import type { SELECTION_MANIFEST_SCHEMA_ID, SourceRequestSchemaId } from "../sources/request-schemas.js";

/**
 * B07 adds its six command schemas and the selection manifest document schema to the closed set (application-owned, reviewed
 * schemas only — S093).
 */
export type KnownSchemaId =
  | ContractName
  | RequestSchemaId
  | ResponseSchemaId
  | SourceRequestSchemaId
  | typeof SELECTION_MANIFEST_SCHEMA_ID
  | "Problem";

export type ValidationOutcome<T> =
  | { readonly kind: "VALID"; readonly value: T }
  | { readonly kind: "INVALID"; readonly fields: ReadonlyArray<FieldError> };

export interface SchemaValidator {
  /** Structural validation of untrusted input against a known schema; never mutates, never coerces, never defaults. */
  validate<T = unknown>(schemaId: KnownSchemaId, input: unknown): ValidationOutcome<T>;
  /** The closed set of ids this validator compiled (adapters expose it so a test can prove nothing else was compiled). */
  readonly knownSchemaIds: ReadonlyArray<KnownSchemaId>;
}
