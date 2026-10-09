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
import type { RequestAuthority } from "./authority.js";
import type { Problem } from "./problems.js";

export const HEADERS = Object.freeze({
  correlationId: "x-correlation-id",
  idempotencyKey: "idempotency-key",
  /** Active agency context for routes whose path does not carry agencyId (decision D-SCOPE-1). */
  agency: "x-kauro-agency",
  contentType: "application/json",
  problemContentType: "application/problem+json",
  cacheControl: "cache-control",
});

/**
 * The cache policy of every reply (08 "Browser, API and cache isolation": "Private responses use an explicit no-shared-cache
 * policy"; re-check finding N15): tenant views, problems and probes are never stored by a shared or a private cache.
 */
export const PRIVATE_CACHE_POLICY = "no-store";

export const REQUEST_LIMITS = Object.freeze({
  jsonBytes: 1_048_576,
  batchItems: 100,
  pageDefault: 25,
  pageMaximum: 100,
  /** Parser bounds (10: bounded depth and string lengths; the reverse proxy is not the only guard). */
  maxDepth: 16,
  maxStringLength: 40_000,
  /**
   * A client-supplied correlation id is adopted only when it is an `id` (lowercase RFC 9562 UUID, the request-schema id
   * shape): the registry types DomainEvent.correlationId as `id`, and the command journal, the domain events and the security
   * events store it as a uuid. Any other value — a proxy's own request id, an uppercase UUID, a token with spaces — is
   * ignored, never refused and never echoed: the server mints a UUIDv7 instead, exactly as for an absent header (10
   * "Every request receives an opaque correlation ID"; review finding R28, which supersedes the refusal of I-INT-4).
   */
  correlationIdPattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
});

/**
 * Envelope header fields that carry one value and are refused when a request repeats them (review finding R41). Node keeps
 * the first Content-Type and Authorization and joins the others, so a repetition would otherwise be decided silently — a
 * second bearer token could even pick the acting subject. The transport reports repetitions from its raw header list.
 */
export const SINGLE_VALUED_HEADERS: ReadonlySet<string> = new Set(["authorization", "content-type", HEADERS.correlationId, HEADERS.idempotencyKey, HEADERS.agency]);

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
  /**
   * Keyed SHA-256 of the client address the transport established (08 "Abuse controls": rate limiting combines IP,
   * verified identity, agency and operation; review finding R34). The address itself never enters the application; null
   * only when the transport has no client address (an in-process caller).
   */
  readonly clientAddressHash: Sha256Hex | null;
  /** Path-bound aggregate ids in route order; validated as ids before use. */
  readonly path: Readonly<Record<string, string>>;
  /** The body after structural validation against the closed request schema; never a raw parse result. */
  readonly body: Body;
  readonly receivedAt: string;
  /**
   * The request's credential as the transport holds it (FAILURE-MATRIX-TEMPLATE rule 16): an effect that must not outlive its session's
   * revocation judges it under the session row's lock at its COMMIT. Absent for an in-process caller; never part of the request digest.
   */
  readonly authority?: RequestAuthority;
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
