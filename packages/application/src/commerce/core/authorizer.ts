/**
 * The commerce authorizer (design §3.4; D-AUTHZ-B1..B3, D-CORP-B1): the access decisions of the principals the B06 Authorizer
 * denies by default — the corporate operator (KAURO_OWNER) and the service identities (PAYMENT_SERVICE, AUTHENTICATED_PROVIDER) —
 * and the operator's assurance (08 "Identity is not permission"; "a service account has only its technical role"; "High-impact
 * actions require recent step-up ... significant refund"). Default deny, a safe reason and the policy version on every decision;
 * the runtime records every DENY as a durable security fact (B06 D-FACT-1, D-FACT-B1). The database repeats what it can see: the
 * finance policies admit rows only while the grant is ACTIVE, a review needs the grant (KP007), a cited policy must apply (KP010).
 *
 *  authorizeService  the verified service identity holds the command's role in the code-owned SERVICE_ROLE_TABLE (D-AUTHZ-B3) and
 *                    was issued for this deployment's environment → SERVICE_NOT_PERMITTED / SERVICE_ENVIRONMENT_MISMATCH
 *  authorizeOperator the unit of work runs for the caller (OPERATOR context) → the identity ACTIVE and verified by the token and by
 *                    the stored row → the caller's own ACTIVE KAURO_OWNER grant, read after its transition lock → CORPORATE_ROLE_MISSING;
 *                    then the stored operation resolved and adopted through the scope index → NOT_FOUND alike for foreign and unknown
 *  assureOperator    `authorizationRef` is a standing refund policy that covers the refund (policyCovers, D-REF-B4) — a policy that
 *                    does not cover it is POLICY_NOT_APPLICABLE, never a silent fallback —, else a fresh step-up proof of the operator
 *                    (the B06 verifier: STEP_UP_MISSING / STEP_UP_NOT_OWNED / STEP_UP_STALE)
 */
import type { AssuranceProofId, Clock, RefundPolicyId, UserId } from "@kauro/domain";
import { COMMERCE_POLICY_VERSION, isUuidV5, isUuidV7, isVerifiedIdentity, serviceHoldsRole } from "@kauro/domain";
import { assureStepUpAtCommit, type AssuranceVerifier } from "../../ports/assurance-and-admission.js";
import type { CommerceAuthorizer, CommerceDenial } from "../ports.js";

export interface CommerceAuthorizerDependencies {
  readonly clock: Clock;
  /** The B06 step-up verifier (@kauro/authorization createAssuranceVerifier; freshness D-ASSUR-1). */
  readonly assurance: AssuranceVerifier;
}

function deny(code: CommerceDenial["code"], reason: CommerceDenial["reason"]): CommerceDenial {
  return { kind: "DENY", code, reason, policyVersion: COMMERCE_POLICY_VERSION };
}

export function createCommerceAuthorizer(deps: CommerceAuthorizerDependencies): CommerceAuthorizer {
  return {
    authorizeService(request) {
      const { identity, role, deploymentEnvironment } = request;
      if (!serviceHoldsRole(identity.serviceId, role)) return deny("NOT_AUTHORIZED", "SERVICE_NOT_PERMITTED");
      if (identity.environment !== deploymentEnvironment) return deny("NOT_AUTHORIZED", "SERVICE_ENVIRONMENT_MISMATCH");
      return { kind: "ALLOW", serviceId: identity.serviceId, role, policyVersion: COMMERCE_POLICY_VERSION };
    },

    async authorizeOperator(uow, request) {
      const identity = request.identity;
      // the subject is present and the unit of work runs for exactly it (an OPERATOR context of its own user)
      if (!isUuidV5(identity.userId) || uow.context.kind !== "OPERATOR" || uow.userId !== identity.userId) return deny("AUTHENTICATION_REQUIRED", "SUBJECT_UNAUTHENTICATED");
      const stored = await uow.identities.getOwn(identity.userId);
      if (identity.state !== "ACTIVE" || stored?.state === "DISABLED") return deny("NOT_AUTHORIZED", "IDENTITY_DISABLED");
      if (!isVerifiedIdentity(identity)) return deny("NOT_AUTHORIZED", "IDENTITY_UNVERIFIED");
      // the caller's own ACTIVE grant, after its transition lock: a revocation in flight is ordered before or after (D-CORP-B1)
      const grant = await uow.commerce.corporateGrants.activeGrant(identity.userId, request.role);
      if (grant === null || grant.state !== "ACTIVE" || grant.userId !== identity.userId) return deny("NOT_AUTHORIZED", "CORPORATE_ROLE_MISSING");
      if (request.storedOperation !== undefined) {
        const adopted = await uow.adoptScope(request.storedOperation.kind, request.storedOperation.key);
        if (adopted === null) return deny("NOT_FOUND", null);
      }
      return { kind: "ALLOW", userId: identity.userId, policyVersion: COMMERCE_POLICY_VERSION };
    },

    async assureOperator(uow, request) {
      const ref = request.authorizationRef;
      if (isUuidV7(ref)) {
        const policy = await uow.commerce.refundPolicies.get(ref as RefundPolicyId);
        if (policy !== null) {
          if (await request.covers(policy.policyId)) return { kind: "ALLOW", assuranceClass: "STANDING_POLICY", policyId: policy.policyId, policyVersion: COMMERCE_POLICY_VERSION };
          // a policy that does not cover this refund is refused as such: a standing policy is referenced, never invented (CMD032)
          return deny("ASSURANCE_REQUIRED", "POLICY_NOT_APPLICABLE");
        }
      }
      const outcome = await assureStepUpAtCommit(uow, deps.assurance, request.userId as UserId, isUuidV7(ref) ? (ref as AssuranceProofId) : undefined, deps.clock);
      if (outcome.kind !== "FRESH") return deny("ASSURANCE_REQUIRED", outcome.reason);
      return { kind: "ALLOW", assuranceClass: "STEP_UP", proofRef: outcome.proofId, policyVersion: COMMERCE_POLICY_VERSION };
    },
  };
}
