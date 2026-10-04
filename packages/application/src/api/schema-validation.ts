/**
 * The SchemaValidator adapter over the strict compiler (api/json-schema): closed over exactly the registry contract names,
 * the request schema ids of this package (B06's and the source lifecycle's, with the selection manifest document of its intake),
 * the response schema ids of this package (api/response-schemas: the COMPLETED envelope of every served command, the ACCEPTED
 * envelope, the READ envelope of every served read, the STORED envelope of the intake, the declared replies of the operational
 * routes) and the Problem schema (S093: "compile only reviewed application-owned schemas"). The contract bundle is the generated
 * `@kauro/contracts/schemas.json`; the transport reads that file once at start-up and hands the parsed object here, so this
 * module needs no file system access.
 */
import { CONTRACT_NAMES } from "@kauro/contracts";
import { DomainFailure, FAILURE_CODES, FAILURE_REASONS } from "@kauro/domain";
import type { KnownSchemaId, SchemaValidator, ValidationOutcome } from "../ports/schema-validator.js";
import { compileSchemaBundle, type CompiledSchemaSet } from "./json-schema.js";
import { PROBLEM_TYPE_PREFIX } from "./problems.js";
import { REQUEST_SCHEMAS, REQUEST_SCHEMA_PREFIX, type RequestSchemaCommand } from "./request-schemas.js";
import { OPERATIONAL_ROUTES, buildResponseSchemas, type OperationalRoute } from "./response-schemas.js";
import { SELECTION_MANIFEST_SCHEMA, SELECTION_MANIFEST_SCHEMA_ID, SOURCE_REQUEST_SCHEMAS } from "../sources/request-schemas.js";
import { AUDIT_REQUEST_SCHEMAS, DECISION_ARTIFACT_SCHEMA, DECISION_ARTIFACT_SCHEMA_ID } from "../audit/request-schemas.js";
import { EXECUTION_REQUEST_SCHEMAS } from "../execution/request-schemas.js";
import { COMMERCE_REQUEST_SCHEMAS } from "../commerce/request-schemas.js";
import { buildCommerceResponseSchemas } from "../commerce/response-schemas.js";
import { COMMERCIAL_REQUEST_SCHEMAS } from "../commercial/request-schemas.js";
import { buildCommercialResponseSchemas } from "../commercial/response-schemas.js";

/** The generated contract bundle as @kauro/contracts/schemas.json ships it. */
export interface ContractSchemaBundle {
  readonly $schema: string;
  readonly $id: string;
  readonly $defs: Readonly<Record<string, unknown>>;
}

const FIELD_ERROR_CODES = ["REQUIRED", "UNKNOWN_FIELD", "TYPE", "FORMAT", "RANGE", "UNKNOWN_REFERENCE", "ENUM", "PATCH_UNKNOWN_CANDIDATE", "PATCH_UNKNOWN_FIELD", "PATCH_EFFECT_NOT_PERMITTED", "PATCH_MALFORMED"] as const;
const NEXT_ACTION_TOKENS = ["RELOAD", "COMPARE_VERSIONS", "REAUTHENTICATE", "STEP_UP", "RETRY_LATER", "RETRY_SAME_KEY", "REQUEST_NEW_REVIEW", "CONTACT_SUPPORT", "CHOOSE_ANOTHER_MODE"] as const;

/**
 * Wire schema of a Problem (10 "Responses and safe errors"): closed, so a response can never carry a stack, SQL text, a raw
 * value or an unlisted member. `errors[].field` is a field path, `current` is the safe version/state on STALE_VERSION.
 */
export const PROBLEM_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:kauro:api:v1:problem",
  type: "object",
  additionalProperties: false,
  required: ["type", "title", "status", "code", "correlationId", "retryable", "nextActions"],
  properties: {
    type: { type: "string", pattern: `^${PROBLEM_TYPE_PREFIX}[A-Z_]+$` },
    title: { type: "string", minLength: 1, maxLength: 200 },
    status: { type: "integer", minimum: 400, maximum: 599 },
    code: { type: "string", enum: [...FAILURE_CODES] },
    reason: { type: "string", enum: [...FAILURE_REASONS] },
    correlationId: { type: "string", minLength: 1, maxLength: 128 },
    errors: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "code"],
        properties: { field: { type: "string", maxLength: 512 }, code: { type: "string", enum: [...FIELD_ERROR_CODES] } },
      },
    },
    retryable: { type: "boolean" },
    retryAfterSeconds: { type: "integer", minimum: 0, maximum: 86400 },
    nextActions: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: { action: { type: "string", enum: [...NEXT_ACTION_TOKENS] }, href: { type: "string", pattern: "^/[^\\s]*$", maxLength: 512 } },
      },
    },
    current: {
      type: "object",
      additionalProperties: false,
      required: ["version", "state"],
      properties: {
        version: { type: "integer", minimum: 0, maximum: 9007199254740991 },
        state: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" },
        successorId: { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" },
        mismatch: { type: "array", maxItems: 10, items: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9]{0,63}$" } },
      },
    },
  },
} as const);

/**
 * Builds the closed validator: every registry contract, every request schema, every response schema and the Problem schema,
 * nothing else. The response views are compiled as definitions beside the registry's (`#/$defs/<View>`), derived from that
 * same bundle (api/response-schemas); `operational` is the list of operational routes whose replies are declared (the
 * application-owned OPERATIONAL_ROUTES unless a caller names the list explicitly).
 */
export function createSchemaValidator(bundle: ContractSchemaBundle, operational: ReadonlyArray<OperationalRoute> = OPERATIONAL_ROUTES): SchemaValidator {
  const roots: Record<string, unknown> = {};
  for (const name of CONTRACT_NAMES) {
    const def = bundle.$defs[name];
    if (def === undefined) throw new DomainFailure("INTEGRITY_FAILURE", `contract bundle has no definition for ${name}`);
    roots[name] = def;
  }
  for (const [command, schema] of Object.entries(REQUEST_SCHEMAS)) roots[`${REQUEST_SCHEMA_PREFIX}${command as RequestSchemaCommand}`] = schema;
  // the source lifecycle's served command schemas and the document its intake stores (B07; design §9.2, D-SEL-2)
  for (const [command, schema] of Object.entries(SOURCE_REQUEST_SCHEMAS)) {
    const id = `${REQUEST_SCHEMA_PREFIX}${command}`;
    if (id in roots) throw new DomainFailure("INTEGRITY_FAILURE", `request schema ${id} is declared twice`);
    roots[id] = schema;
  }
  roots[SELECTION_MANIFEST_SCHEMA_ID] = SELECTION_MANIFEST_SCHEMA;
  // package B08: the execution commands' closed request schemas (design §12); a collision would be an integrity failure
  for (const [command, schema] of Object.entries(EXECUTION_REQUEST_SCHEMAS)) {
    const id = `${REQUEST_SCHEMA_PREFIX}${command}`;
    if (id in roots) throw new DomainFailure("INTEGRITY_FAILURE", `request schema ${id} is declared twice`);
    roots[id] = schema;
  }
  // package B08: the audit commands' closed request schemas and the envelope of the decision-artifact intake (design §12, D8-CMA-7)
  for (const [command, schema] of Object.entries(AUDIT_REQUEST_SCHEMAS)) {
    const id = `${REQUEST_SCHEMA_PREFIX}${command}`;
    if (id in roots) throw new DomainFailure("INTEGRITY_FAILURE", `request schema ${id} is declared twice`);
    roots[id] = schema;
  }
  roots[DECISION_ARTIFACT_SCHEMA_ID] = DECISION_ARTIFACT_SCHEMA;
  // package B09: the payment commands' closed request schemas and the envelopes of their replies and reads (D-REQ-B7), derived
  // under the same rules; an id or a view that collided with a B06 or B07 one would be an integrity failure
  for (const [command, schema] of Object.entries(COMMERCE_REQUEST_SCHEMAS)) {
    const id = `${REQUEST_SCHEMA_PREFIX}${command}`;
    if (id in roots) throw new DomainFailure("INTEGRITY_FAILURE", `the B09 request schema ${id} collides with a B06 or B07 one`);
    roots[id] = schema;
  }
  const responses = buildResponseSchemas(bundle, operational);
  Object.assign(roots, responses.roots);
  const defs: Record<string, unknown> = { ...bundle.$defs, ...responses.defs };
  const commerce = buildCommerceResponseSchemas(bundle);
  for (const [id, schema] of Object.entries(commerce.roots)) {
    if (id in roots) throw new DomainFailure("INTEGRITY_FAILURE", `the B09 response schema ${id} collides with a B06 or B07 one`);
    roots[id] = schema;
  }
  for (const [name, schema] of Object.entries(commerce.defs)) {
    if (name in defs) throw new DomainFailure("INTEGRITY_FAILURE", `the B09 view ${name} collides with a B06, B07 or registry definition`);
    defs[name] = schema;
  }
  // package B10: the commercial commands' closed request schemas and the envelopes of their replies, derived under the same rules and
  // referencing the B06 and B09 views they answer (AgencyView, QuoteView) without redeclaring them
  for (const [command, schema] of Object.entries(COMMERCIAL_REQUEST_SCHEMAS)) {
    const id = `${REQUEST_SCHEMA_PREFIX}${command}`;
    if (id in roots) throw new DomainFailure("INTEGRITY_FAILURE", `the B10 request schema ${id} collides with an earlier package's`);
    roots[id] = schema;
  }
  const commercial = buildCommercialResponseSchemas(bundle, defs as Readonly<Record<string, Readonly<Record<string, unknown>>>>);
  for (const [id, schema] of Object.entries(commercial.roots)) {
    if (id in roots) throw new DomainFailure("INTEGRITY_FAILURE", `the B10 response schema ${id} collides with an earlier package's`);
    roots[id] = schema;
  }
  for (const [name, schema] of Object.entries(commercial.defs)) {
    if (name in defs) throw new DomainFailure("INTEGRITY_FAILURE", `the B10 view ${name} collides with an earlier package's or a registry definition`);
    defs[name] = schema;
  }
  roots["Problem"] = PROBLEM_SCHEMA;
  const compiled: CompiledSchemaSet = compileSchemaBundle({ defs, roots });
  const known = compiled.ids as ReadonlyArray<KnownSchemaId>;
  return {
    knownSchemaIds: known,
    validate<T = unknown>(schemaId: KnownSchemaId, input: unknown): ValidationOutcome<T> {
      if (!compiled.has(schemaId)) {
        // S093: an id outside the closed set is an integrity failure before any input is inspected
        throw new DomainFailure("INTEGRITY_FAILURE", `schema ${String(schemaId)} is not a known application-owned schema`);
      }
      const fields = compiled.validate(schemaId, input);
      return fields.length === 0 ? { kind: "VALID", value: input as T } : { kind: "INVALID", fields };
    },
  };
}
