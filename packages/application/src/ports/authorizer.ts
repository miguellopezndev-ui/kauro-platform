/**
 * Authorization decision port (08 "Identity is not permission": the backend checks identity status, active membership,
 * agency scope, resource relationship, capability, state/version and required assurance; default is deny; the decision
 * includes a safe reason code and policy version). Implemented by @kauro/authorization inside the unit of work so the
 * membership it resolves is the one the command then uses (no cached grant, 07 "authorized_reactivation" effect).
 *
 * Two decisions, in the pipeline order of 10 "Request envelope" (authenticated subject, then authorization, then execution)
 * and 10 "Idempotency contract" (review record docs/design/B06-review/A-pipeline-authorization.md):
 *   - `authorize` (design §6.1 steps 1–7): may this subject act in the selected scope with this command's role? It runs first,
 *     before anything tenant-scoped is written, so a nonexistent and a foreign agency look alike, and a journaled replay, a
 *     conflict or a pending entry is answered only to a caller it allows;
 *   - `assure` (step 8): the assurance a new execution requires — a fresh step-up for a command that names assuranceProofRef.
 *     A replay performs no effect and is answered without it (a response lost after commit stays recoverable by its key once
 *     the proof has aged; a new proof would change the request digest and could never recover it).
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

export type AllowDecision = Extract<AuthorizationDecision, { kind: "ALLOW" }>;

/** The access request of a manual-10 read (re-check finding N16). */
export interface ReadAuthorizationRequest {
  readonly identity: IdentityFacts;
  /** The agency the read selects (path agencyId or active-agency header); null for the caller's own memberships (GET /agencies). */
  readonly agencyId: AgencyId | null;
}

export interface Authorizer {
  /**
   * Access, steps 1–7: subject, identity status (the token's facts and the stored identity row), agency selector, live
   * membership (read with a share lock held to the end of the unit of work, so a concurrent suspension, revocation or role
   * change of it serializes with the command), ACTIVE, role. NOT_FOUND, not NOT_AUTHORIZED, when the caller holds no live
   * membership in the selected agency (08: foreign and nonexistent resources look the same). Writes nothing; the runtime
   * records every DENY as a durable security fact.
   */
  authorize(uow: UnitOfWork, request: AuthorizationRequest): Promise<AuthorizationDecision>;
  /**
   * Assurance, step 8, for a new execution the access decision allowed: ASSURANCE_REQUIRED unless the command's step-up proof
   * is the caller's and fresh; otherwise the access decision with its assurance class (STEP_UP when a proof was verified).
   */
  assure(uow: UnitOfWork, request: AuthorizationRequest, access: AllowDecision): Promise<AuthorizationDecision>;
  /**
   * Access of a read (N16), steps 1–6 of `authorize` with the role every membership holds (AGENCY_READER: a read's projection,
   * not its admission, differs by role): subject, identity status, and — for an agency read — the selector and an ACTIVE live
   * membership read after its transition lock. The same NOT_FOUND for a foreign and a nonexistent agency. Writes nothing; the
   * read runtime records every DENY as a durable security fact.
   */
  authorizeRead(uow: UnitOfWork, request: ReadAuthorizationRequest): Promise<AuthorizationDecision>;
}
