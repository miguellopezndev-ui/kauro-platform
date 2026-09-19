/**
 * Execution context and actors (08 "Database isolation": tenant context is set transaction-locally and cleared on pool
 * return; a request without valid context fails closed. 08 "Role and capability model": a service account has only its
 * technical role and cannot act as a human owner by putting an owner id in a request).
 *
 * Exactly one context kind is bound to a unit of work:
 * - TENANT: one agency (the selector resolved from the path or the active-agency header) and the authenticated user; the
 *   database session variables kauro.agency_id and kauro.user_id are set with SET LOCAL and row-level security keys on them;
 * - IDENTITY: an authenticated user without an agency (CreateAgency, own memberships, own identity sync); only rows keyed
 *   on kauro.user_id are visible;
 * - SYSTEM: the control plane (outbox dispatch, sweeper, capability changes) under the kauro_control database role; it never
 *   carries a user id and never runs a browser command.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { AgencyId, CorrelationId, MembershipId, UserId } from "./ids.js";

export type ActorRef =
  | { readonly kind: "USER"; readonly userId: UserId }
  | { readonly kind: "SERVICE"; readonly serviceId: string }
  | { readonly kind: "SYSTEM" };

export interface TenantContext {
  readonly kind: "TENANT";
  readonly agencyId: AgencyId;
  readonly userId: UserId;
  readonly correlationId: CorrelationId;
}

export interface IdentityContext {
  readonly kind: "IDENTITY";
  readonly userId: UserId;
  readonly correlationId: CorrelationId;
}

export interface SystemContext {
  readonly kind: "SYSTEM";
  readonly serviceId: string;
  readonly correlationId: CorrelationId;
}

export type ExecutionContext = TenantContext | IdentityContext | SystemContext;

export function actorOf(context: ExecutionContext): ActorRef {
  switch (context.kind) {
    case "TENANT":
    case "IDENTITY":
      return { kind: "USER", userId: context.userId };
    case "SYSTEM":
      return { kind: "SERVICE", serviceId: context.serviceId };
  }
}

/** Identity facts the authenticator produced (08 "Authentication and assurance"); never a permission by themselves. */
export interface IdentityFacts {
  readonly userId: UserId;
  readonly emailVerifiedAt: UtcInstant | null;
  readonly mfaEnrolledAt: UtcInstant | null;
  readonly state: "ACTIVE" | "DISABLED";
}

/** The launch policy (08): agency data access requires verified email and enrolled MFA. */
export function isVerifiedIdentity(facts: IdentityFacts): boolean {
  return facts.state === "ACTIVE" && facts.emailVerifiedAt !== null && facts.mfaEnrolledAt !== null;
}

/** The resolved authority of a caller inside one agency, produced by the authorizer, consumed by command handlers. */
export interface ResolvedMembership {
  readonly membershipId: MembershipId;
  readonly agencyId: AgencyId;
  readonly userId: UserId;
  readonly role: "OWNER" | "ADMIN" | "OPERATOR" | "APPROVER" | "VIEWER" | "BILLING";
  readonly version: number;
  readonly assurancePolicy: string;
}
