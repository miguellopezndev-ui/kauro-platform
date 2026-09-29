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
 *   carries a user id and never runs a browser command;
 * - ANONYMOUS: the edge recording the denial of a request that carried no authenticated subject (08 "Threat model and
 *   assets": an unauthenticated visitor is a threat actor and every trust boundary has an audit event). It binds neither an
 *   agency nor a user, so it sees no row, and the only thing it can write is an anonymous DENY security fact (migration 0007).
 */
import type { Id, UtcInstant } from "@kauro/contracts";
import { NotFoundFailure } from "./errors.js";
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
  /**
   * Decision D-CTRL-1 (B07): a control-plane unit of work that acts on one tenant's rows binds that agency (kauro.agency_id), and
   * the source-lifecycle tables admit control-plane writes only for the bound agency. Absent, the unit of work may only discover
   * work across tenants through the columns granted to kauro_control (never customer text). The agency comes from the durable
   * work item (the outbox event's agency_id), never from a request.
   */
  readonly agencyId?: AgencyId;
}

export interface AnonymousContext {
  readonly kind: "ANONYMOUS";
  readonly correlationId: CorrelationId;
}

export type ExecutionContext = TenantContext | IdentityContext | SystemContext | AnonymousContext;

/** The contexts that act as someone: every context but ANONYMOUS, which records denials and never acts. */
export type ActingContext = TenantContext | IdentityContext | SystemContext;

/** Who a security fact is about: an actor, or nobody (the denial of a request without an authenticated subject). */
export type SecurityActor = ActorRef | { readonly kind: "ANONYMOUS" };

export function actorOf(context: ActingContext): ActorRef {
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

/**
 * Scope checks over records the handler read (contract TenantScope, FIELD_CONTRACTS "The server derives agency membership and
 * client/project ownership; callers cannot self-assert access"; 08 "Database isolation": a row-level filter cannot prevent a
 * child row from linking to another tenant if the relationship permits it — so the domain compares scopes explicitly and the
 * database binds them with composite foreign keys).
 */
export interface TenantScope {
  readonly agencyId: AgencyId;
  readonly clientId?: Id;
  readonly projectId?: Id;
}

export function tenantScopeOf(context: TenantContext): TenantScope {
  return { agencyId: context.agencyId };
}

/**
 * A record that is absent or belongs to another agency is NOT_FOUND under this context: the caller learns nothing about a
 * foreign resource (COMMAND_CATALOGUE "NOT_FOUND is used where revealing a foreign resource would leak existence"; D-AUTHZ-4).
 */
export function assertInScope<T extends { readonly agencyId: AgencyId }>(scope: Pick<TenantScope, "agencyId">, resourceKind: string, record: T | null): T {
  if (record === null || record.agencyId !== scope.agencyId) throw new NotFoundFailure(resourceKind);
  return record;
}

/** A child whose scope does not equal the parent's is a cross-tenant link: never followed, reported as not found. */
export function assertSameScope(resourceKind: string, parent: { readonly agencyId: AgencyId }, child: { readonly agencyId: AgencyId }): void {
  if (parent.agencyId !== child.agencyId) throw new NotFoundFailure(resourceKind, "CROSS_AGENCY");
}
