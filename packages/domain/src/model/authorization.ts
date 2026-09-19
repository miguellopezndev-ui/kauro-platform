/**
 * Authorization kernel (08 "Identity is not permission": the backend checks identity status, active membership or operator
 * assignment, agency scope, resource relationship, capability, state/version and required assurance; default is deny; the
 * decision includes a safe reason code. 08 "Role and capability model". Design §6.1 fixes the order; decisions D-AUTHZ-1..4).
 *
 * This is the pure decision over facts the caller read inside the unit of work: the identity facts of the authenticated
 * subject, the agency selector, the live membership of that person in that agency (as the row-level policies returned it)
 * and, when the command names assuranceProofRef, the referenced proof. The Authorizer adapter (@kauro/authorization) reads
 * those facts, calls `decideCommandAccess`, records the security event of a DENY and returns the decision; nothing here is
 * cached across requests (07 "authorized_reactivation": do not reuse stale cached grants).
 *
 * The first failing check answers. NOT_FOUND, not NOT_AUTHORIZED, is the answer for a caller without a live membership in
 * the selected agency (D-AUTHZ-4: foreign and nonexistent look alike). Resource relationship (step 9 of the design) and
 * state/version preconditions (step 10) are decided by the aggregate operations on the resource the handler locked.
 */
import type { CommandId, CommandRole, UtcInstant } from "@kauro/contracts";
import { COMMANDS } from "@kauro/contracts";
import type { MembershipRecord } from "./aggregates.js";
import type { FailureCode, FailureReason } from "./errors.js";
import { type AssuranceProof, evaluateStepUp } from "./identity.js";
import type { AgencyId } from "./ids.js";
import { isLiveMembership } from "./membership.js";
import { commandRole, isAgencyCommandRole, roleSatisfies } from "./roles.js";
import { type IdentityFacts, type ResolvedMembership, isVerifiedIdentity } from "./tenant.js";

export interface StepUpFacts {
  /** The proof the request referenced, read under the self policy (null when absent, foreign or unknown). */
  readonly proof: AssuranceProof | null;
  readonly now: UtcInstant;
  readonly freshnessSeconds: number;
}

export interface AccessRequest {
  readonly command: CommandId;
  /** null when no authenticated subject is present (edge: AUTHENTICATION_REQUIRED). */
  readonly identity: IdentityFacts | null;
  /** The agency selector (path agencyId or active-agency header); null when the request carries none. */
  readonly agencyId: AgencyId | null;
  /** The live membership of `identity` in `agencyId` as the tenant policies returned it; null when there is none. */
  readonly membership: MembershipRecord | null;
  /** Present when the command names assuranceProofRef; absent means no proof was referenced. */
  readonly stepUp?: StepUpFacts;
}

export type AccessDenial = {
  readonly kind: "DENY";
  readonly code: Extract<FailureCode, "AUTHENTICATION_REQUIRED" | "ASSURANCE_REQUIRED" | "NOT_AUTHORIZED" | "NOT_FOUND" | "INVALID_REQUEST">;
  readonly reason: FailureReason;
};

export type AccessDecision =
  | { readonly kind: "ALLOW"; readonly membership: ResolvedMembership | null; readonly assuranceClass: "SESSION" | "STEP_UP"; readonly commandRole: CommandRole }
  | AccessDenial;

/** True when the catalogue entry of the command carries an assuranceProofRef field (step-up is part of its contract). */
export function commandRequiresStepUp(command: CommandId): boolean {
  const c = COMMANDS.find((x) => x.id === command);
  if (!c) throw new TypeError(`unknown command ${command}`);
  return c.fields.some((f) => f.name === "assuranceProofRef");
}

function deny(code: AccessDenial["code"], reason: FailureReason): AccessDenial {
  return { kind: "DENY", code, reason };
}

export function decideCommandAccess(request: AccessRequest): AccessDecision {
  const role = commandRole(request.command);
  // 1. authenticated subject present
  const identity = request.identity;
  if (identity === null) return deny("AUTHENTICATION_REQUIRED", "NOT_AUTHENTICATED");
  // 2. identity active and verified under the launch policy (08 "Authentication and assurance")
  if (identity.state === "DISABLED") return deny("NOT_AUTHORIZED", "IDENTITY_DISABLED");
  if (!isVerifiedIdentity(identity)) return deny("NOT_AUTHORIZED", "IDENTITY_UNVERIFIED");

  let membership: ResolvedMembership | null = null;
  if (role !== "VERIFIED_USER") {
    // 3. only agency-bound roles are decided by membership; corporate and service roles have their own authorizers (default deny)
    if (!isAgencyCommandRole(role)) return deny("NOT_AUTHORIZED", "ROLE_INSUFFICIENT");
    // 4. agency selector present
    if (request.agencyId === null) return deny("INVALID_REQUEST", "TENANT_CONTEXT_MISSING");
    // 5. live membership of this person in this agency
    const m = request.membership;
    if (m === null || !isLiveMembership(m) || m.agencyId !== request.agencyId || m.userId !== identity.userId) return deny("NOT_FOUND", "NOT_A_MEMBER");
    // 6. membership ACTIVE
    if (m.state === "SUSPENDED") return deny("NOT_AUTHORIZED", "MEMBERSHIP_SUSPENDED");
    if (m.state !== "ACTIVE") return deny("NOT_AUTHORIZED", "MEMBERSHIP_NOT_ACTIVE");
    // 7. role satisfies the command role (D-AUTHZ-1)
    if (!roleSatisfies(role, m.role)) return deny("NOT_AUTHORIZED", "ROLE_INSUFFICIENT");
    membership = { membershipId: m.membershipId, agencyId: m.agencyId, userId: m.userId, role: m.role, version: m.version, assurancePolicy: m.assurancePolicy };
  }
  // 8. step-up when the command names assuranceProofRef
  if (commandRequiresStepUp(request.command)) {
    if (request.stepUp === undefined) return deny("ASSURANCE_REQUIRED", "STEP_UP_MISSING");
    const outcome = evaluateStepUp({ proof: request.stepUp.proof, userId: identity.userId, now: request.stepUp.now, freshnessSeconds: request.stepUp.freshnessSeconds });
    if (outcome.kind !== "FRESH") return deny("ASSURANCE_REQUIRED", outcome.reason);
    return { kind: "ALLOW", membership, assuranceClass: "STEP_UP", commandRole: role };
  }
  return { kind: "ALLOW", membership, assuranceClass: "SESSION", commandRole: role };
}
