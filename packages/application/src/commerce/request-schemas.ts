/**
 * Closed request schemas (JSON Schema 2020-12) of the payment commands CMD028..CMD034 (10 "Version and validation": closed
 * objects, no coercion, no defaults, unknown fields reject; COMMAND_CATALOGUE "Request fields ... Extra fields reject").
 * Property names are exactly the registry field names (a test proves it against commands.json). Scalar shapes follow the field
 * vocabulary: id = lowercase RFC 9562 UUID, version = positive safe integer, hash = lowercase SHA-256, money = the
 * MoneyMinorUnits decimal string (never a JSON number, so no amount depends on number precision), text = a bounded provider
 * reference token, reason code = uppercase token (the B06 CMD026 shape; the handler narrows it to the closed vocabulary).
 *
 * These schemas are compiled by the same closed validator as the B06 request schemas; registering them beside
 * REQUEST_SCHEMAS (and widening KnownSchemaId) is part of implementation mandate M3, which also updates the count asserted by
 * the B06 command-contracts test.
 */
import { REQUEST_SCHEMA_PREFIX, type RequestSchema } from "../api/request-schemas.js";

const ID = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" } as const;
const VERSION = { type: "integer", minimum: 1, maximum: 9007199254740991 } as const;
const HASH = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;
const MONEY = { type: "string", pattern: "^(0|[1-9][0-9]{0,15})$" } as const;
const PROVIDER_REF = { type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9._:-]+$" } as const;
const REASON_CODE = { type: "string", pattern: "^[A-Z][A-Z0-9_]{2,63}$" } as const;

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

export const COMMERCE_REQUEST_SCHEMAS = Object.freeze({
  /** CreatePaymentOrder. */
  CMD028: schema("CMD028", ["termsHash"], { termsHash: HASH }),
  /** CapturePayment. */
  CMD029: schema("CMD029", ["providerApprovalRef"], { providerApprovalRef: PROVIDER_REF }),
  /** ReceivePaymentWebhook: the normalized inbox command built by the ingress after signature verification. */
  CMD030: schema("CMD030", ["providerEventArtifactRef"], { providerEventArtifactRef: ID }),
  /** RequestRefund. */
  CMD031: schema("CMD031", ["reasonCode", "evidenceRef"], { reasonCode: REASON_CODE, evidenceRef: ID }),
  /** ApproveRefund. */
  CMD032: schema("CMD032", ["expectedVersion", "serviceCents", "taxCents", "authorizationRef"], {
    expectedVersion: VERSION,
    serviceCents: MONEY,
    taxCents: MONEY,
    authorizationRef: ID,
  }),
  /** ExecuteRefund. */
  CMD033: schema("CMD033", ["expectedVersion"], { expectedVersion: VERSION }),
  /** ReconcilePayment. */
  CMD034: schema("CMD034", ["observationRef"], { observationRef: ID }),
} as const);

export type CommerceRequestSchemaCommand = keyof typeof COMMERCE_REQUEST_SCHEMAS;
