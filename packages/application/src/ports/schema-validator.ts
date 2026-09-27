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
import type { CommerceRequestSchemaCommand } from "../commerce/request-schemas.js";
import type { CommerceReadOperationId, CommerceServedCommandId } from "../commerce/response-schemas.js";

/**
 * The request and response schemas of the payments workflow (package B09; commerce/request-schemas, commerce/response-schemas): the
 * closed request schema of each of its seven commands, the COMPLETED envelope of each and the READ envelope of each of its reads,
 * compiled by the same validator as the B06 ones (decision D-REQ-B7 of docs/design/B09-payments-fiscal.md).
 */
export type CommerceSchemaId =
  | `urn:kauro:api:v1:request:${CommerceRequestSchemaCommand}`
  | `urn:kauro:api:v1:response:${CommerceServedCommandId}`
  | `urn:kauro:api:v1:response:read:${CommerceReadOperationId}`;

export type KnownSchemaId = ContractName | RequestSchemaId | ResponseSchemaId | CommerceSchemaId | "Problem";

export type ValidationOutcome<T> =
  | { readonly kind: "VALID"; readonly value: T }
  | { readonly kind: "INVALID"; readonly fields: ReadonlyArray<FieldError> };

export interface SchemaValidator {
  /** Structural validation of untrusted input against a known schema; never mutates, never coerces, never defaults. */
  validate<T = unknown>(schemaId: KnownSchemaId, input: unknown): ValidationOutcome<T>;
  /** The closed set of ids this validator compiled (adapters expose it so a test can prove nothing else was compiled). */
  readonly knownSchemaIds: ReadonlyArray<KnownSchemaId>;
}
