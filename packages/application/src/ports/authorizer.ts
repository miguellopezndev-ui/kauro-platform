/**
 * Authorization decision port (08 "Identity is not permission": the backend checks identity status, active membership,
 * agency scope, resource relationship, capability, state/version and required assurance; default is deny; the decision
 * includes a safe reason code and policy version). Implemented by @kauro/authorization inside the unit of work so the
 * membership it resolves is the one the command then uses (no cached grant, 07 "authorized_reactivation" effect).
 */
import type { CommandId } from "@kauro/contracts";
import type { AgencyId, AssuranceProofId, FailureCode, FailureReason, IdentityFacts, ResolvedMembership, UnitOfWork } from "@kauro/domain";

/** Version of the authorization policy the decision applied (08 "Audit events": policy version is recorded). */
export const AUTHORIZATION_POLICY_VERSION = "B06-1";

export interface AuthorizationRequest {
  readonly command: CommandId;
  readonly identity: IdentityFacts;
  /** The agency selector (path agencyId or active-agency header); null for commands without a tenant (CMD001). */
  readonly agencyId: AgencyId | null;
  /** Step-up proof reference when the command names one (assuranceProofRef). */
  readonly assuranceProofRef?: AssuranceProofId;
}

export type AuthorizationDecision =
  | {
      readonly kind: "ALLOW";
      readonly membership: ResolvedMembership | null;
      readonly assuranceClass: "SESSION" | "STEP_UP";
      readonly policyVersion: string;
    }
  | {
      readonly kind: "DENY";
      readonly code: Extract<FailureCode, "AUTHENTICATION_REQUIRED" | "ASSURANCE_REQUIRED" | "NOT_AUTHORIZED" | "NOT_FOUND">;
      readonly reason: FailureReason;
      readonly policyVersion: string;
    };

export interface Authorizer {
  /**
   * Decides inside the unit of work (reads the membership under the tenant context that was just bound) and appends the
   * security event for a DENY of a consequential command. NOT_FOUND is returned, not NOT_AUTHORIZED, when the caller holds no
   * live membership in the selected agency (08: foreign and nonexistent resources look the same).
   */
  authorize(uow: UnitOfWork, request: AuthorizationRequest): Promise<AuthorizationDecision>;
}
