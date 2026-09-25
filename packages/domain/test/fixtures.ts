// Deterministic fixtures for the pure aggregate tests: a fixed clock, a seeded id generator and records at known versions.
// Nothing here touches a database; the persistence package runs the same operations against PostgreSQL.
import { createHash } from "node:crypto";
import type { Id } from "@kauro/contracts";
import {
  type AgencyId,
  type AgencyRecord,
  type CapabilityRecord,
  type ClientId,
  type DomainFailure,
  type EndClientRecord,
  type IdentityFacts,
  type InvitationId,
  type InvitationRecord,
  type MembershipId,
  type MembershipRecord,
  type MembershipRole,
  type ProcessingAuthorityId,
  type ProcessingAuthorityRecord,
  type UserId,
  createIdGenerator,
  identityUserId,
  isDomainFailure,
  toUtcInstant,
} from "../src/index.js";

export const T0 = Date.parse("2026-09-19T12:00:00.000Z");
export const NOW = toUtcInstant(T0);
export const at = (offsetMs: number) => toUtcInstant(T0 + offsetMs);

let counter = 0;
const gen = createIdGenerator(
  { now: () => NOW, nowMs: () => T0 },
  (n) => {
    const out = new Uint8Array(n);
    const h = createHash("sha256").update(String(counter++)).digest();
    for (let i = 0; i < n; i++) out[i] = h[i % h.length] as number;
    return out;
  },
);
export const id = (): Id => gen.next();

export const users = {
  owner: identityUserId("identity-platform", "owner"),
  second: identityUserId("identity-platform", "second-owner"),
  admin: identityUserId("identity-platform", "admin"),
  operator: identityUserId("identity-platform", "operator"),
  approver: identityUserId("identity-platform", "approver"),
  viewer: identityUserId("identity-platform", "viewer"),
  billing: identityUserId("identity-platform", "billing"),
  stranger: identityUserId("identity-platform", "stranger"),
};

export function verified(userId: UserId): IdentityFacts {
  return { userId, emailVerifiedAt: at(-86_400_000), mfaEnrolledAt: at(-3_600_000), state: "ACTIVE" };
}

export function agency(overrides: Partial<AgencyRecord> = {}): AgencyRecord {
  const agencyId = (overrides.agencyId ?? id()) as AgencyId;
  return {
    agencyId,
    version: 1,
    displayName: "Acme Agency",
    state: "DRAFT",
    createdByUserId: users.owner,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function activeAgency(overrides: Partial<AgencyRecord> = {}): AgencyRecord {
  return agency({ state: "ACTIVE", version: 2, termsVersion: "TERMS-2026-01", privacyAgreementVersion: "DPA-2026-01", legalProfileRef: id(), ...overrides });
}

export function membership(agencyId: AgencyId, role: MembershipRole, userId: UserId, overrides: Partial<MembershipRecord> = {}): MembershipRecord {
  return {
    membershipId: id() as MembershipId,
    agencyId,
    userId,
    role,
    state: "ACTIVE",
    version: 1,
    assurancePolicy: "MFA_REQUIRED",
    acceptedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function invited(agencyId: AgencyId, role: MembershipRole, userId: UserId, invitedBy: MembershipId, tokenHash: string, expiresAt = at(7 * 86_400_000)): { membership: MembershipRecord; invitation: InvitationRecord } {
  const m = membership(agencyId, role, userId, { state: "INVITED" });
  const { acceptedAt: _accepted, ...withoutAcceptance } = m;
  const invitation: InvitationRecord = {
    invitationId: id() as InvitationId,
    agencyId,
    membershipId: m.membershipId,
    tokenHash,
    role,
    invitedByMembershipId: invitedBy,
    expiresAt,
    createdAt: NOW,
  };
  return { membership: withoutAcceptance, invitation };
}

export function authority(agencyId: AgencyId, recordedBy: MembershipId): ProcessingAuthorityRecord {
  return {
    processingAuthorityId: id() as ProcessingAuthorityId,
    agencyId,
    recordedByMembershipId: recordedBy,
    recordedAt: NOW,
  };
}

export function client(agencyId: AgencyId, createdBy: MembershipId, overrides: Partial<EndClientRecord> = {}): EndClientRecord {
  return {
    clientId: id() as ClientId,
    agencyId,
    displayName: "Client One",
    state: "ACTIVE",
    processingAuthorityRef: id() as ProcessingAuthorityId,
    version: 1,
    createdByMembershipId: createdBy,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function capability(mode: CapabilityRecord["mode"], state: CapabilityRecord["state"] = "AVAILABLE_LIMITED", overrides: Partial<CapabilityRecord> = {}): CapabilityRecord {
  return {
    capabilityId: id() as CapabilityRecord["capabilityId"],
    version: "R2-INITIAL",
    kind: "MODE",
    ...(mode !== undefined ? { mode } : {}),
    state,
    profileHash: createHash("sha256").update(`profile-${mode ?? "none"}`).digest("hex"),
    qualificationEvidenceHashes: [createHash("sha256").update("evidence").digest("hex")],
    reviewTrigger: "VENDOR_OR_ENVELOPE_CHANGE",
    ...overrides,
  };
}

/** Runs `fn`, expecting a DomainFailure with the given code (and reason when given); returns it for further assertions. */
export function refused(fn: () => unknown, code: DomainFailure["code"], reason?: DomainFailure["reason"]): DomainFailure {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  if (!isDomainFailure(caught)) throw new Error(`expected DomainFailure ${code}${reason ? "/" + reason : ""}, got ${caught instanceof Error ? caught.stack : String(caught)}`);
  if (caught.code !== code) throw new Error(`expected ${code}${reason ? "/" + reason : ""}, got ${caught.code}/${caught.reason ?? "-"}: ${caught.message}`);
  if (reason !== undefined && caught.reason !== reason) throw new Error(`expected ${code}/${reason}, got ${caught.code}/${caught.reason ?? "-"}: ${caught.message}`);
  return caught;
}
