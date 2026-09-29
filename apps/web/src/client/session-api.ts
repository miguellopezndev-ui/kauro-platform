// The session routes of the browser edge (design D-AUTH-4), as the browser calls them. They are declared here, not read from the
// generated client, because the generated client is built from the api's OpenAPI document and the branch that serves these routes (W2)
// has not landed when this runtime is written; the integration mandate replaces this file's descriptors and schema with the generated
// ones (the wire shape below is D-AUTH-4 word for word). Every call goes through the same ApiClient as any other operation, so the
// request envelope, the no-store rule and the four-way answer classification are not repeated.
import { SCHEMAS } from "../api/generated.ts";
import type { SchemaNode } from "../api/schema-guard.ts";
import type { ApiAnswer } from "./answer.ts";
import type { ApiClient, WireDescriptor } from "./api-client.ts";
import type { IdentityCredential } from "./identity/port.ts";

/** What `GET /api/v1/sessions/current` answers (D-AUTH-4). The CSRF token is the only secret in it and never leaves the runtime. */
export interface SessionView {
  readonly userId: string;
  readonly emailVerified: boolean;
  readonly mfaEnrolled: boolean;
  readonly mfaAt?: string | null;
  readonly stepUpFreshUntil?: string | null;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly csrfToken: string;
}

/** The session as the rest of the page may see it: no token. */
export type SessionSummary = Omit<SessionView, "csrfToken">;

const DATE_TIME: SchemaNode = { type: "string", format: "date-time", pattern: "Z$" };
const NULLABLE_DATE_TIME: SchemaNode = { type: ["string", "null"], format: "date-time", pattern: "Z$" };

export const SESSION_SCHEMAS: Readonly<Record<string, SchemaNode>> = {
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

/** The two session calls the page makes. The runtime depends on this shape, so a test can stand in for the api without a network. */
export interface SessionApi {
  current(): Promise<ApiAnswer<SessionView>>;
  revoke(): Promise<ApiAnswer<undefined>>;
}

/**
 * Exchanges a provider credential for a session (D-AUTH-4): the credential's token is taken here, sent once, and not kept. A person
 * signs in on a page that is then replaced by a new document, so the runtime of the sign-in page reads no session back from this call.
 */
export function createSession(client: ApiClient, credential: IdentityCredential): Promise<ApiAnswer<SessionView>> {
  if (credential.purpose !== "SESSION") throw new RangeError("only a sign-in credential opens a session");
  return client.send<SessionView>(CREATE_SESSION, { body: { idToken: credential.takeToken() } }, SESSION_SCHEMAS);
}

export function sessionApi(client: ApiClient): SessionApi {
  return {
    current: () => client.send<SessionView>(GET_CURRENT_SESSION, {}, SESSION_SCHEMAS),
    revoke: () => client.send<undefined>(REVOKE_CURRENT_SESSION, {}, SESSION_SCHEMAS),
  };
}
