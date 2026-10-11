/**
 * Closed request schemas (JSON Schema 2020-12) of the payment commands CMD028..CMD034 (10 "Version and validation": closed
 * objects, no coercion, no defaults, unknown fields reject; COMMAND_CATALOGUE "Request fields ... Extra fields reject").
 * Property names are exactly the registry field names (a test proves it against commands.json). Scalar shapes follow the field
 * vocabulary of the B06 request schemas: id = lowercase RFC 9562 UUID, version = positive safe integer, hash = lowercase
 * SHA-256, label = 1..200 characters without a Unicode Cc code point (B06 D-LABEL-1; CMD031 reasonCode is a registry `label`,
 * never narrowed to a token — B06 D-API-1), money = the MoneyMinorUnits decimal string inside 0..2^53-1 (never a JSON number,
 * so no amount depends on number precision; D-MONEY-B1), text = a bounded provider reference token.
 *
 * CMD030's schema is the normalized inbox command the ingress builds after the provider-specific raw signature verification
 * (COMMAND_CATALOGUE "Shared execution contract": "its schema is not the vendor's public payload schema"); the provider's raw
 * body is admitted by the webhook route's own bounded-body policy, never by this schema.
 *
 * Implementation mandate M3 registers these beside REQUEST_SCHEMAS (widening the validator's known schema ids) when it serves
 * the routes, and updates the count the B06 command-contracts test asserts.
 */
import { LABEL_PATTERN, REQUEST_SCHEMA_PREFIX, type RequestSchema } from "../api/request-schemas.js";
import { MONEY_PATTERN } from "./response-schemas.js";

const ID = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" } as const;
const VERSION = { type: "integer", minimum: 1, maximum: 9007199254740991 } as const;
const HASH = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;
const MONEY = { type: "string", pattern: MONEY_PATTERN } as const;
const LABEL = { type: "string", minLength: 1, maxLength: 200, pattern: LABEL_PATTERN } as const;
/** A provider's opaque reference as the browser echoes it back (never trusted: the server compares it with the stored order). */
const PROVIDER_REF = { type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9._:-]+$" } as const;

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
  /** CreatePaymentOrder: the accepted terms, named by their hash (10 "Checkout names quoteId and its immutable version"). */
  // Payments V1 (lane L-ROUTE): routeKind BANK_TRANSFER with routeId names the bank-transfer route (the handler refuses one without the
  // other as SCHEMA_VIOLATION); absent, the provider checkout
  CMD028: schema("CMD028", ["termsHash"], { termsHash: HASH, routeKind: { type: "string", enum: ["BANK_TRANSFER"] }, routeId: { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" } }),
  /** CapturePayment: the browser's echo of the provider approval — compared with the stored order, never evidence of payment. */
  CMD029: schema("CMD029", ["providerApprovalRef"], { providerApprovalRef: PROVIDER_REF }),
  /** ReceivePaymentWebhook: the normalized inbox command built by the ingress after signature verification. */
  CMD030: schema("CMD030", ["providerEventArtifactRef"], { providerEventArtifactRef: ID }),
  /** RequestRefund: the agency's reason (a label) and its evidence reference. */
  CMD031: schema("CMD031", ["reasonCode", "evidenceRef"], { reasonCode: LABEL, evidenceRef: ID }),
  /** ApproveRefund: the approved service and tax components and the authorization (a fresh step-up or a standing policy). */
  CMD032: schema("CMD032", ["expectedVersion", "serviceCents", "taxCents", "authorizationRef"], {
    expectedVersion: VERSION,
    serviceCents: MONEY,
    taxCents: MONEY,
    authorizationRef: ID,
  }),
  /** ExecuteRefund. */
  CMD033: schema("CMD033", ["expectedVersion"], { expectedVersion: VERSION }),
  /** ReconcilePayment: a stored, authenticated provider observation of this order. */
  CMD034: schema("CMD034", ["observationRef"], { observationRef: ID }),
} as const);

export type CommerceRequestSchemaCommand = keyof typeof COMMERCE_REQUEST_SCHEMAS;
