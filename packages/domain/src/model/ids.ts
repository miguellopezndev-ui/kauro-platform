/**
 * Aggregate identity (07 "Database representation": internal IDs are server-generated UUIDv7 or a compatible opaque scheme
 * fixed in the contract registry; embedded time never establishes business ordering — aggregate versions and event sequence
 * numbers do). This module fixes the scheme:
 *
 * - every aggregate id is a UUIDv7 (RFC 9562) minted by the server through the IdGenerator port; the database checks the
 *   version nibble (kauro.is_uuid_v7) so a client-supplied or foreign-scheme id can never become an aggregate identity;
 * - the identity reference of an authenticated person (identities.user_id) is a UUIDv5 derived from the identity provider and
 *   its subject (03 "Shared representations": opaque, collision resistant, never a customer-provided value). Deriving it makes
 *   identity sync a write under the caller's own row policy without a privileged lookup.
 *
 * Branded id types make a ClientId unusable where an AgencyId is required at compile time; at runtime all ids are strings.
 */
import { createHash } from "node:crypto";
import type { Id } from "@kauro/contracts";

declare const brandSymbol: unique symbol;
export type Branded<T, B extends string> = T & { readonly [brandSymbol]: B };

export type AgencyId = Branded<Id, "AgencyId">;
export type UserId = Branded<Id, "UserId">;
export type MembershipId = Branded<Id, "MembershipId">;
export type InvitationId = Branded<Id, "InvitationId">;
export type ProcessingAuthorityId = Branded<Id, "ProcessingAuthorityId">;
export type ClientId = Branded<Id, "ClientId">;
export type ProjectId = Branded<Id, "ProjectId">;
export type SupportCaseId = Branded<Id, "SupportCaseId">;
export type RevisionId = Branded<Id, "RevisionId">;
export type TargetContractId = Branded<Id, "TargetContractId">;
export type PlanId = Branded<Id, "PlanId">;
export type ValidationReceiptId = Branded<Id, "ValidationReceiptId">;
export type ApprovalId = Branded<Id, "ApprovalId">;
export type AssuranceProofId = Branded<Id, "AssuranceProofId">;
export type CapabilityId = Branded<Id, "CapabilityId">;
export type EventId = Branded<Id, "EventId">;
export type OutboxId = Branded<Id, "OutboxId">;
export type InboxId = Branded<Id, "InboxId">;
export type CorrelationId = Branded<Id, "CorrelationId">;
export type CausationId = Branded<Id, "CausationId">;
export type JournalEntryId = Branded<Id, "JournalEntryId">;
export type RequestId = Branded<Id, "RequestId">;
export type TaskId = Branded<Id, "TaskId">;
export type LeaseOwnerId = Branded<Id, "LeaseOwnerId">;
export type ResourceId = Branded<Id, "ResourceId">;
export type ArtifactRef = Branded<Id, "ArtifactRef">;
export type TargetInstanceRef = Branded<Id, "TargetInstanceRef">;

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(value: unknown): value is Id {
  return typeof value === "string" && UUID_V7.test(value);
}

export function isUuidV5(value: unknown): value is Id {
  return typeof value === "string" && UUID_V5.test(value);
}

/** Any lowercase RFC 9562 UUID (used for external references such as a target instance the platform did not mint). */
export function isUuid(value: unknown): value is Id {
  return typeof value === "string" && UUID_ANY.test(value);
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Encodes a UUIDv7 from a millisecond Unix timestamp and 10 random bytes (RFC 9562 §5.7): 48-bit timestamp, version 7,
 * 12 random bits (rand_a), variant 10, 62 random bits (rand_b). Pure: the IdGenerator adapter supplies clock and entropy.
 */
export function encodeUuidV7(timestampMs: number, random: Uint8Array): string {
  if (!Number.isInteger(timestampMs) || timestampMs < 0 || timestampMs > 0xffffffffffff) throw new RangeError("timestampMs must be a 48-bit non-negative integer");
  if (random.length < 10) throw new RangeError("encodeUuidV7 needs 10 random bytes");
  const out = new Uint8Array(16);
  let t = timestampMs;
  for (let i = 5; i >= 0; i--) {
    out[i] = t % 256;
    t = Math.floor(t / 256);
  }
  out[6] = 0x70 | ((random[0] as number) & 0x0f);
  out[7] = random[1] as number;
  out[8] = 0x80 | ((random[2] as number) & 0x3f);
  for (let i = 0; i < 7; i++) out[9 + i] = random[3 + i] as number;
  return formatUuid(out);
}

/** The millisecond timestamp embedded in a UUIDv7 — diagnostic only, never business ordering (07). */
export function uuidV7Timestamp(id: string): number {
  if (!isUuidV7(id)) throw new TypeError("not a UUIDv7");
  return Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}

/** Kauro identity namespace (a fixed UUIDv4 chosen once for this platform; the R2 registry fixes the scheme, not the value). */
export const IDENTITY_NAMESPACE = "6f1b0d2e-3c4a-4b5c-9d6e-7f8091a2b3c4";

/**
 * Deterministic identity reference for an authenticated person: UUIDv5(namespace, `${provider}:${subject}`).
 * The provider subject is never stored in a tenant row and never appears in a DTO; only this opaque id does.
 */
export function identityUserId(provider: string, subject: string): UserId {
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(provider)) throw new TypeError("identity provider label must be a short lowercase token");
  if (subject.length === 0 || subject.length > 512) throw new TypeError("identity subject must be 1..512 characters");
  const ns = Buffer.from(IDENTITY_NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(Buffer.from(`${provider}:${subject}`, "utf8")).digest();
  const bytes = Uint8Array.prototype.slice.call(hash, 0, 16);
  bytes[6] = 0x50 | ((bytes[6] as number) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] as number) & 0x3f);
  return formatUuid(bytes) as UserId;
}
