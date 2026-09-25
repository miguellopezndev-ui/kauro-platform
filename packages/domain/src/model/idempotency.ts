/**
 * Idempotency identity and request digest (10 "Idempotency contract"; reference/COMMAND_CATALOGUE.md "Shared execution
 * contract": hash identity includes tenant, actor authority class, operation, path-bound aggregate and normalized body).
 *
 * The identity is (environment, actor, agency, operation, key). The digest covers every material command field: the
 * operation, the path-bound aggregate ids and the validated body, serialized under the canonical JSON profile inside a
 * domain-separated wrapper (decision D-IDEM-1: domain KAURO_COMMAND_REQUEST_V1, a platform domain the authority list does not
 * name because the request digest is not one of its hashed subjects). Reusing the key with another digest is
 * IDEMPOTENCY_CONFLICT; an identical replay recovers the stored result without a second effect.
 */
import type { CommandId, Sha256Hex, UtcInstant } from "@kauro/contracts";
import { canonicalBytes, rawDigest } from "@kauro/contracts";
import type { AgencyId, JournalEntryId } from "./ids.js";
import type { ActorRef } from "./tenant.js";

export type Environment = "LOCAL" | "SANDBOX" | "LIVE";
export const ENVIRONMENTS: ReadonlyArray<Environment> = ["LOCAL", "SANDBOX", "LIVE"];

/** Idempotency-Key header shape: 16..128 characters of a safe alphabet (the client generates it once per logical request). */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;

export interface IdempotencyIdentity {
  readonly environment: Environment;
  readonly actor: ActorRef;
  /** Tenant scope of the operation; null for CreateAgency, whose tenant does not exist yet. */
  readonly agencyId: AgencyId | null;
  readonly operation: CommandId;
  readonly key: string;
}

export const COMMAND_REQUEST_DOMAIN = "KAURO_COMMAND_REQUEST_V1";

export interface CommandRequestSubject {
  readonly operation: CommandId;
  /** Path-bound aggregate ids in route order (e.g. { agencyId } or { planId }). */
  readonly aggregate: Readonly<Record<string, string>>;
  /** The structurally validated body exactly as accepted (closed object, no defaults applied). */
  readonly body: unknown;
}

export function commandRequestDigest(subject: CommandRequestSubject): Sha256Hex {
  return rawDigest(canonicalBytes({ domain: COMMAND_REQUEST_DOMAIN, version: 1, payload: subject }));
}

export type JournalState = "RESERVED" | "COMMITTED" | "UNCERTAIN" | "FAILED";

/** The durable record of one logical command (table kauro.command_journal). */
export interface CommandJournalEntry {
  readonly entryId: JournalEntryId;
  readonly identity: IdempotencyIdentity;
  readonly requestDigest: Sha256Hex;
  readonly state: JournalState;
  readonly correlationId: string;
  /** Present once COMMITTED: the HTTP status and the exact response body the first execution produced. */
  readonly responseStatus?: number;
  readonly responseBody?: unknown;
  /** The durable business object the command produced or changed (10: records are linked to durable business objects). */
  readonly resourceKind?: string;
  readonly resourceId?: string;
  readonly reservedAt: UtcInstant;
  readonly committedAt?: UtcInstant;
}
