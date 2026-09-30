/**
 * The commercial authorizer (design §2 principals, D10-CTX-1, D10-CTX-2): the access decisions of the three principals the B06 and
 * B09 authorizers do not cover — the active seller, the corporate owner of the commercial commands and the two commission services.
 * Default deny, a safe reason and the policy version on every decision; the runtime records every DENY as a durable security fact
 * (B06 D-FACT-1) exactly as it does for B09's.
 *
 *  authorizeSeller          the unit of work runs for the caller (OPERATOR context of its own user) → the identity ACTIVE and verified
 *                           by the token and by the stored row → the caller's own seller row, read after its transition lock in this
 *                           unit of work, in state ACTIVE. A missing row, another person's row and any other state (CANDIDATE, SUSPENDED,
 *                           TERMINATED) are refused with the same reason, so a refusal reveals nothing about a seller's state.
 *  authorizeCorporateOwner  the same identity checks → the caller's own ACTIVE KAURO_OWNER grant, read after its transition lock.
 *  authorizeCommercialService the verified service identity holds the command's role in the code-owned SERVICE_ROLE_TABLE
 *                           (COMMISSION_SERVICE or FINANCE_SERVICE) and was issued for this deployment's environment.
 *
 * Only reasons that B06 and B09 already define are used (D10-CTX-1): a seller who may not act is CORPORATE_ROLE_MISSING, like an owner
 * without a grant; the design's own SELLER_NOT_ACTIVE reason belongs to the B10 domain model and is mapped by the command lanes that
 * need to name it. The authorizer holds no state and caches nothing: the seller row and the grant are read for each decision.
 * Commands that admit two principals (CMD045: a seller or the owner; GetCommissionStatement: the statement's own seller or the
 * owner) compose these methods in their handlers.
 */
import type { CommerceUnitOfWork, IdentityFacts, ServiceIdentity } from "@kauro/domain";
import { COMMERCE_POLICY_VERSION, isUuidV5, isVerifiedIdentity, serviceHoldsRole } from "@kauro/domain";
import type { CommerceDenial, OperatorDecision, ServiceDecision } from "../commerce/ports.js";
import type { CommercialPrincipalReader } from "./ports.js";

/** The two technical roles a commercial service command is admitted under (08 "a service account has only its technical role"). */
export type CommercialServiceRole = "COMMISSION_SERVICE" | "FINANCE_SERVICE";

/** An admitted active seller: the caller's own identity and the seller row the decision was made on. */
export type SellerDecision = { readonly kind: "ALLOW"; readonly userId: string; readonly sellerId: string; readonly policyVersion: string } | CommerceDenial;

export interface CommercialAuthorizer {
  authorizeSeller(uow: CommerceUnitOfWork, request: { readonly identity: IdentityFacts }): Promise<SellerDecision>;
  authorizeCorporateOwner(uow: CommerceUnitOfWork, request: { readonly identity: IdentityFacts }): Promise<OperatorDecision>;
  authorizeCommercialService(request: {
    readonly identity: ServiceIdentity;
    readonly role: CommercialServiceRole;
    readonly deploymentEnvironment: "LOCAL" | "SANDBOX" | "LIVE";
  }): ServiceDecision;
}

export interface CommercialAuthorizerDependencies {
  /** The seller row and the corporate grant, read inside the decision's own unit of work (B10-ADAPTERS-SALES implements it). */
  readonly principals: CommercialPrincipalReader;
}

function deny(code: CommerceDenial["code"], reason: CommerceDenial["reason"]): CommerceDenial {
  return { kind: "DENY", code, reason, policyVersion: COMMERCE_POLICY_VERSION };
}

/**
 * The checks every person-principal shares, in the B09 order: the subject is present and the unit of work runs for exactly it, the
 * identity is ACTIVE by the token and by the stored row, and it is verified. Returns the denial, or null when the caller may go on
 * to the role check — which is where the seller row or the grant is first read.
 */
async function refuseUnadmittedPerson(uow: CommerceUnitOfWork, identity: IdentityFacts): Promise<CommerceDenial | null> {
  if (!isUuidV5(identity.userId) || uow.context.kind !== "OPERATOR" || uow.userId !== identity.userId) return deny("AUTHENTICATION_REQUIRED", "SUBJECT_UNAUTHENTICATED");
  const stored = await uow.identities.getOwn(identity.userId);
  if (identity.state !== "ACTIVE" || stored?.state === "DISABLED") return deny("NOT_AUTHORIZED", "IDENTITY_DISABLED");
  if (!isVerifiedIdentity(identity)) return deny("NOT_AUTHORIZED", "IDENTITY_UNVERIFIED");
  return null;
}

export function createCommercialAuthorizer(deps: CommercialAuthorizerDependencies): CommercialAuthorizer {
  return {
    async authorizeSeller(uow, request) {
      const identity = request.identity;
      const refused = await refuseUnadmittedPerson(uow, identity);
      if (refused !== null) return refused;
      const seller = await deps.principals.sellerOf(uow, identity.userId);
      if (seller === null || seller.state !== "ACTIVE" || seller.userId !== identity.userId) return deny("NOT_AUTHORIZED", "CORPORATE_ROLE_MISSING");
      return { kind: "ALLOW", userId: identity.userId, sellerId: seller.sellerId, policyVersion: COMMERCE_POLICY_VERSION };
    },

    async authorizeCorporateOwner(uow, request) {
      const identity = request.identity;
      const refused = await refuseUnadmittedPerson(uow, identity);
      if (refused !== null) return refused;
      const grant = await deps.principals.ownerGrantOf(uow, identity.userId);
      if (grant === null || grant.state !== "ACTIVE" || grant.userId !== identity.userId) return deny("NOT_AUTHORIZED", "CORPORATE_ROLE_MISSING");
      return { kind: "ALLOW", userId: identity.userId, policyVersion: COMMERCE_POLICY_VERSION };
    },

    authorizeCommercialService(request) {
      const { identity, role, deploymentEnvironment } = request;
      if (!serviceHoldsRole(identity.serviceId, role)) return deny("NOT_AUTHORIZED", "SERVICE_NOT_PERMITTED");
      if (identity.environment !== deploymentEnvironment) return deny("NOT_AUTHORIZED", "SERVICE_ENVIRONMENT_MISMATCH");
      return { kind: "ALLOW", serviceId: identity.serviceId, role, policyVersion: COMMERCE_POLICY_VERSION };
    },
  };
}
