// Planned stand-ins for the ContractFakeAgencyApi's own tests (design D-E2E-2): the three session descriptors W3 declared as planned before
// W2 served the session routes (the stage-1 integration replaced them in the runtime with the generated operations, D-INT1-5). The fake's
// rules are exercised with them here because they are a realistic mix — a POST that opens without a CSRF token and answers 201, a GET,
// and a POST that answers 204 without a body. They are test data of the fake, never a descriptor any screen calls, and their operation
// ids are not the served ones (openSession, getCurrentSession, revokeCurrentSession), so nothing here can shadow a served route.
import { SCHEMAS } from "../../src/api/generated.ts";
import type { SchemaNode } from "../../src/api/schema-guard.ts";
import type { WireDescriptor } from "../../src/client/api-client.ts";

const DATE_TIME: SchemaNode = { type: "string", format: "date-time", pattern: "Z$" };
const NULLABLE_DATE_TIME: SchemaNode = { type: ["string", "null"], format: "date-time", pattern: "Z$" };

/** The generated schemas and the stand-ins' own two. */
export const STAND_IN_SCHEMAS: Readonly<Record<string, SchemaNode>> = {
  ...(SCHEMAS as unknown as Readonly<Record<string, SchemaNode>>),
  CreateSessionRequest: {
    type: "object",
    additionalProperties: false,
    required: ["idToken"],
    properties: { idToken: { type: "string", minLength: 1, maxLength: 16384 } },
  },
  SessionView: {
    type: "object",
    additionalProperties: false,
    required: ["userId", "emailVerified", "mfaEnrolled", "idleExpiresAt", "absoluteExpiresAt", "csrfToken"],
    properties: {
      userId: { type: "string", minLength: 1, maxLength: 128 },
      emailVerified: { type: "boolean" },
      mfaEnrolled: { type: "boolean" },
      mfaAt: NULLABLE_DATE_TIME,
      stepUpFreshUntil: NULLABLE_DATE_TIME,
      idleExpiresAt: DATE_TIME,
      absoluteExpiresAt: DATE_TIME,
      csrfToken: { type: "string", minLength: 16, maxLength: 256, pattern: "^[A-Za-z0-9_-]+$" },
    },
  },
};

export const CREATE_SESSION: WireDescriptor = {
  operationId: "CreateSession",
  method: "post",
  path: "/api/v1/sessions",
  command: null,
  role: null,
  idempotency: "NONE",
  headers: ["X-Correlation-Id"],
  pathParameters: [],
  queryParameters: [],
  request: "CreateSessionRequest",
  replies: { "201": "SessionView", "401": "Problem", "403": "Problem", default: "Problem" },
  planned: true,
};

export const GET_CURRENT_SESSION: WireDescriptor = {
  operationId: "GetCurrentSession",
  method: "get",
  path: "/api/v1/sessions/current",
  command: null,
  role: null,
  idempotency: "NONE",
  headers: ["X-Correlation-Id"],
  pathParameters: [],
  queryParameters: [],
  request: null,
  replies: { "200": "SessionView", "401": "Problem", default: "Problem" },
  planned: true,
};

export const REVOKE_CURRENT_SESSION: WireDescriptor = {
  operationId: "RevokeCurrentSession",
  method: "post",
  path: "/api/v1/sessions/current/revoke",
  command: null,
  role: null,
  idempotency: "NONE",
  headers: ["X-Correlation-Id"],
  pathParameters: [],
  queryParameters: [],
  request: null,
  replies: { "204": null, "401": "Problem", default: "Problem" },
  planned: true,
};
