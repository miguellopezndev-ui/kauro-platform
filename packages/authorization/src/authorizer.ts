/**
 * The Authorizer of the Kauro platform (08 "Identity is not permission": the backend checks identity status, active
 * membership, agency scope, resource relationship, capability, state/version and required assurance; default is deny; the
 * decision includes a safe reason code and policy version). Implements design §6.1 steps 1–8 inside the unit of work; steps 9
 * (resource relationship under RLS) and 10 (state/version preconditions) are the command handler's, on the locked row.
 *
 * `authorize` — access, first failure wins, before anything tenant-scoped is written (review record
 * docs/design/B06-review/A-pipeline-authorization.md):
 *  1. an authenticated subject is present and the unit of work runs for it → AUTHENTICATION_REQUIRED / SUBJECT_UNAUTHENTICATED
 *  2. identity ACTIVE — by the token's facts and by the stored identity row, since Identity owns the security status (07
 *     "Aggregate ownership") — email verified and MFA enrolled               → NOT_AUTHORIZED / IDENTITY_DISABLED, IDENTITY_UNVERIFIED
 *  3. VERIFIED_USER commands need no membership                            → ALLOW (membership null)
 *  4. an agency selector is present and bound as the context               → NOT_FOUND / TENANT_CONTEXT_MISSING
 *  5. a live membership of the caller in the selected agency, share-locked until the unit of work ends, so a concurrent
 *     suspension, revocation or role change is ordered before or after the command (07 "Agency and membership states":
 *     revocation is effective server-side immediately for new commands) → NOT_FOUND / NOT_A_MEMBER (foreign and nonexistent alike, D-AUTHZ-4)
 *  6. the membership is ACTIVE                                             → NOT_AUTHORIZED / MEMBERSHIP_SUSPENDED, MEMBERSHIP_NOT_ACTIVE
 *  7. the membership role satisfies the command role                       → NOT_AUTHORIZED / ROLE_INSUFFICIENT (D-AUTHZ-1)
 * `assure` — step 8, for a new execution only (a replay performs no effect):
 *  8. a fresh step-up when the command names a proof                       → ASSURANCE_REQUIRED / STEP_UP_MISSING, STEP_UP_NOT_OWNED, STEP_UP_STALE
 * A membership is never cached across requests: SUSPENDED → ACTIVE re-checks everything (07 "do not reuse stale cached grants").
 * The stored identity row is read, not locked: CreateAgency rewrites the caller's own row in the same unit of work
 * (identities.syncOwn), and a share lock taken here would deadlock two concurrent duplicates of it.
 */
import type { CommandId } from "@kauro/contracts";
import { COMMANDS } from "@kauro/contracts";
import type { AllowDecision, AuthorizationDecision, AuthorizationRequest, Authorizer, AssuranceVerifier } from "@kauro/application";
import { AUTHORIZATION_POLICY_VERSION, B06_COMMANDS } from "@kauro/application";
import type { Clock, FailureReason, UnitOfWork } from "@kauro/domain";
import { isAgencyCommandRole, isUuidV5, isVerifiedIdentity, roleSatisfies } from "@kauro/domain";

export interface AuthorizerDependencies {
  readonly clock: Clock;
  readonly assurance: AssuranceVerifier;
}

/** Commands whose spec names a step-up proof in the body (CMD025 in B06); read from the command contracts, never duplicated. */
const STEP_UP_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>(Object.values(B06_COMMANDS).filter((c) => c.stepUpRequired).map((c) => c.id));

function deny(code: Extract<AuthorizationDecision, { kind: "DENY" }>["code"], reason: FailureReason): AuthorizationDecision {
  return { kind: "DENY", code, reason, policyVersion: AUTHORIZATION_POLICY_VERSION };
}

export function createAuthorizer(deps: AuthorizerDependencies): Authorizer {
  const roleOf = new Map<string, string>(COMMANDS.map((c) => [c.id, c.role]));
  return {
    async authorize(uow: UnitOfWork, request: AuthorizationRequest): Promise<AuthorizationDecision> {
      const commandRole = roleOf.get(request.command);
      if (commandRole === undefined) return deny("NOT_AUTHORIZED", "ROLE_INSUFFICIENT");
      // 1. subject present (the transport already refused an unauthenticated request; the identity reference must be a v5 id)
      //    and the unit of work bound to exactly that subject — its own identity row is then the one the self policy shows
      if (!isUuidV5(request.identity.userId)) return deny("AUTHENTICATION_REQUIRED", "SUBJECT_UNAUTHENTICATED");
      if (uow.userId !== request.identity.userId) return deny("AUTHENTICATION_REQUIRED", "SUBJECT_UNAUTHENTICATED");
      // 2. identity status and launch policy (08 "Agency data access requires verified email and enrolled MFA"): the token's
      //    facts, and the stored row, whose DISABLED refuses whatever the token says (the token is younger for verification,
      //    which the platform only copies from it; the platform itself can disable an identity)
      const stored = await uow.identities.getOwn(request.identity.userId);
      if (request.identity.state !== "ACTIVE" || stored?.state === "DISABLED") return deny("NOT_AUTHORIZED", "IDENTITY_DISABLED");
      if (!isVerifiedIdentity(request.identity)) return deny("NOT_AUTHORIZED", "IDENTITY_UNVERIFIED");
      // 3. verified-identity commands (CreateAgency) carry no membership
      if (commandRole === "VERIFIED_USER") {
        return { kind: "ALLOW", membership: null, assuranceClass: "SESSION", policyVersion: AUTHORIZATION_POLICY_VERSION };
      }
      // corporate and service roles are not memberships; their authorizers arrive with their packages (default deny)
      if (!isAgencyCommandRole(commandRole)) return deny("NOT_AUTHORIZED", "ROLE_INSUFFICIENT");
      // 4. agency selector
      if (request.agencyId === null) return deny("NOT_FOUND", "TENANT_CONTEXT_MISSING");
      if (uow.context.kind !== "TENANT" || uow.context.agencyId !== request.agencyId) {
        // the unit of work must be bound to exactly the selected agency (server-derived scope)
        return deny("NOT_FOUND", "TENANT_CONTEXT_MISSING");
      }
      // 5. live membership under the bound context, share-locked to the end of the unit of work
      const membership = await uow.memberships.findLive(request.agencyId, request.identity.userId);
      if (!membership) return deny("NOT_FOUND", "NOT_A_MEMBER");
      // 6. ACTIVE
      if (membership.state === "SUSPENDED") return deny("NOT_AUTHORIZED", "MEMBERSHIP_SUSPENDED");
      if (membership.state !== "ACTIVE") return deny("NOT_AUTHORIZED", "MEMBERSHIP_NOT_ACTIVE");
      // 7. role
      if (!roleSatisfies(commandRole, membership.role)) return deny("NOT_AUTHORIZED", "ROLE_INSUFFICIENT");
      // the membership the command then uses is the one read in this transaction (D-PORT-1; 07 "do not reuse stale cached grants")
      uow.resolveMembership(membership.membershipId);
      return {
        kind: "ALLOW",
        membership: {
          membershipId: membership.membershipId,
          agencyId: membership.agencyId,
          userId: membership.userId,
          role: membership.role,
          version: membership.version,
          assurancePolicy: membership.assurancePolicy,
        },
        assuranceClass: "SESSION",
        policyVersion: AUTHORIZATION_POLICY_VERSION,
      };
    },

    async assure(uow: UnitOfWork, request: AuthorizationRequest, access: AllowDecision): Promise<AuthorizationDecision> {
      // 8. step-up (08 "High-impact actions require recent step-up"; D-ASSUR-1)
      if (!STEP_UP_COMMANDS.has(request.command)) return access;
      const outcome = await deps.assurance.verifyStepUp(uow, request.identity.userId, request.assuranceProofRef, deps.clock.now());
      if (outcome.kind !== "FRESH") return deny("ASSURANCE_REQUIRED", outcome.reason);
      return { ...access, assuranceClass: "STEP_UP" };
    },
  };
}
