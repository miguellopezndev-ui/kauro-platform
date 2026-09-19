/**
 * Request envelope and command results (10 "Request envelope", "Concurrency and preconditions", "Responses and safe errors";
 * 07 "Command outcomes": COMPLETED, ACCEPTED, CONFLICT, REJECTED, UNAVAILABLE).
 *
 * Every mutating request carries an opaque correlation id (echoed), an Idempotency-Key (required on every catalogue command:
 * idempotency is REQUIRED for all 64), the agency selector (path agencyId, or the X-Kauro-Agency header for routes whose path
 * names a client/plan/project) and, for edits, expectedVersion in the body. Limits come from the R2 policy registry
 * (api.jsonBytes = 1 MiB, api.batchItems = 100, api.pageDefault = 25, api.pageMaximum = 100).
 */
import type { CommandId, Sha256Hex } from "@kauro/contracts";
import type { AgencyId, CorrelationId, Environment, IdentityFacts, UserId } from "@kauro/domain";
import type { Problem } from "./problems.js";

export const HEADERS = Object.freeze({
  correlationId: "x-correlation-id",
  idempotencyKey: "idempotency-key",
  /** Active agency context for routes whose path does not carry agencyId (decision D-SCOPE-1). */
  agency: "x-kauro-agency",
  contentType: "application/json",
  problemContentType: "application/problem+json",
});

export const REQUEST_LIMITS = Object.freeze({
  jsonBytes: 1_048_576,
  batchItems: 100,
  pageDefault: 25,
  pageMaximum: 100,
  /** Parser bounds (10: bounded depth and string lengths; the reverse proxy is not the only guard). */
  maxDepth: 16,
  maxStringLength: 40_000,
  /** Correlation ids are opaque tokens the platform echoes; a bound keeps them out of log-injection and header-size games. */
  correlationIdPattern: /^[A-Za-z0-9._:-]{1,128}$/,
});

/**
 * What authentication established about the caller (08 "Identity is not permission": authentication produces an identity
 * reference and assurance facts; membership and capabilities are resolved server-side afterwards). The provider subject itself
 * never travels further than the authenticator: only its SHA-256 (identity sync) and the derived user id do.
 */
export interface AuthenticatedSubject {
  readonly identity: IdentityFacts;
  readonly provider: string;
  readonly subjectHash: Sha256Hex;
}

/** Everything the transport established before application execution (10: validate content type, size, syntax, schema, subject, authorization). */
export interface CommandEnvelope<Body> {
  readonly command: CommandId;
  readonly environment: Environment;
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: string;
  /** Authenticated subject; a request without one never reaches a handler (AUTHENTICATION_REQUIRED at the edge). */
  readonly userId: UserId;
  readonly subject: AuthenticatedSubject;
  /** Agency selector: from the path or the header; null only for commands without a tenant (CMD001). */
  readonly agencyId: AgencyId | null;
  /** Path-bound aggregate ids in route order; validated as ids before use. */
  readonly path: Readonly<Record<string, string>>;
  /** The body after structural validation against the closed request schema; never a raw parse result. */
  readonly body: Body;
  readonly receivedAt: string;
}

export type CommandResult<View> =
  | { readonly kind: "COMPLETED"; readonly status: 200 | 201; readonly view: View; readonly version: number; readonly replayed: boolean }
  | { readonly kind: "ACCEPTED"; readonly status: 202; readonly operationId: string; readonly state: string; readonly statusPath: string; readonly pollAfterSeconds: number }
  | { readonly kind: "CONFLICT"; readonly problem: Problem }
  | { readonly kind: "REJECTED"; readonly problem: Problem }
  | { readonly kind: "UNAVAILABLE"; readonly problem: Problem };

export function isSuccess<V>(r: CommandResult<V>): r is Extract<CommandResult<V>, { kind: "COMPLETED" | "ACCEPTED" }> {
  return r.kind === "COMPLETED" || r.kind === "ACCEPTED";
}

/** The wire body of a COMPLETED command (10 "Synchronous success returns a validated DTO and version"). */
export interface CompletedResponse<View> {
  readonly kind: "COMPLETED";
  readonly version: number;
  /** True when the idempotent replay returned the journaled result of the first execution (10 "Idempotency contract"). */
  readonly replayed: boolean;
  readonly data: View;
}

/** The wire body of an ACCEPTED command (10: 202 with operationId, current state, status URL and polling guidance). */
export interface AcceptedResponse {
  readonly kind: "ACCEPTED";
  readonly operationId: string;
  readonly state: string;
  readonly statusPath: string;
  readonly pollAfterSeconds: number;
}
