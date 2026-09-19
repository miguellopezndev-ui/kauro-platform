/**
 * Role and capability model (08 "Role and capability model"; registry commands.json `role`).
 *
 * A membership carries exactly one least-privilege role (Membership.role). The command catalogue names a command role such as
 * AGENCY_OPERATOR; this table fixes which membership roles satisfy each command role. The mapping is the authorization
 * authority for every agency-bound command; browser claims, JWT custom claims and hidden fields never enter it
 * (08 "Identity is not permission"). Decisions D-AUTHZ-1..4 in the design document record the choices the manual leaves open
 * (an OWNER satisfies every agency role; ADMIN does not approve plans or execute billing; APPROVER and BILLING are not operators).
 */
import type { CommandId, CommandRole, Membership } from "@kauro/contracts";
import { COMMANDS } from "@kauro/contracts";

export type MembershipRole = Membership["role"];
export const MEMBERSHIP_ROLES: ReadonlyArray<MembershipRole> = ["OWNER", "ADMIN", "OPERATOR", "APPROVER", "VIEWER", "BILLING"];

/** Command roles whose authority is an agency membership (as opposed to a corporate, service or verified-identity role). */
export const AGENCY_COMMAND_ROLES = [
  "AGENCY_OWNER",
  "AGENCY_OWNER_OR_ADMIN",
  "AGENCY_ADMIN",
  "AGENCY_OPERATOR",
  "AGENCY_APPROVER",
  "AGENCY_BILLING",
  "AGENCY_READER",
  "AGENCY_MEMBER",
] as const satisfies ReadonlyArray<CommandRole>;
export type AgencyCommandRole = (typeof AGENCY_COMMAND_ROLES)[number];

/** Which membership roles satisfy each agency command role. */
export const COMMAND_ROLE_MEMBERS: Readonly<Record<AgencyCommandRole, ReadonlySet<MembershipRole>>> = Object.freeze({
  AGENCY_OWNER: new Set<MembershipRole>(["OWNER"]),
  AGENCY_OWNER_OR_ADMIN: new Set<MembershipRole>(["OWNER", "ADMIN"]),
  AGENCY_ADMIN: new Set<MembershipRole>(["OWNER", "ADMIN"]),
  AGENCY_OPERATOR: new Set<MembershipRole>(["OWNER", "ADMIN", "OPERATOR"]),
  AGENCY_APPROVER: new Set<MembershipRole>(["OWNER", "APPROVER"]),
  AGENCY_BILLING: new Set<MembershipRole>(["OWNER", "BILLING"]),
  AGENCY_READER: new Set<MembershipRole>(MEMBERSHIP_ROLES),
  AGENCY_MEMBER: new Set<MembershipRole>(MEMBERSHIP_ROLES),
});

/**
 * Capabilities are the vocabulary of "permitted actions" a DTO exposes (10 "Responses": the frontend receives the allowed next
 * actions). They are derived from the role, never stored per membership in this edition (CMD005 changes the role).
 */
export const AGENCY_CAPABILITIES = [
  "MANAGE_AGENCY",
  "MANAGE_TEAM",
  "MANAGE_CLIENTS",
  "CREATE_CLIENTS",
  "OPERATE_PROJECTS",
  "APPROVE_PLANS",
  "MANAGE_BILLING",
  "REQUEST_DELETION",
  "MANAGE_BRANDING",
  "VIEW",
] as const;
export type AgencyCapability = (typeof AGENCY_CAPABILITIES)[number];

export const ROLE_CAPABILITIES: Readonly<Record<MembershipRole, ReadonlySet<AgencyCapability>>> = Object.freeze({
  OWNER: new Set<AgencyCapability>(AGENCY_CAPABILITIES),
  ADMIN: new Set<AgencyCapability>(["MANAGE_TEAM", "MANAGE_CLIENTS", "CREATE_CLIENTS", "OPERATE_PROJECTS", "REQUEST_DELETION", "MANAGE_BRANDING", "VIEW"]),
  OPERATOR: new Set<AgencyCapability>(["CREATE_CLIENTS", "OPERATE_PROJECTS", "VIEW"]),
  APPROVER: new Set<AgencyCapability>(["APPROVE_PLANS", "VIEW"]),
  VIEWER: new Set<AgencyCapability>(["VIEW"]),
  BILLING: new Set<AgencyCapability>(["MANAGE_BILLING", "VIEW"]),
});

export function isAgencyCommandRole(role: string): role is AgencyCommandRole {
  return (AGENCY_COMMAND_ROLES as ReadonlyArray<string>).includes(role);
}

/** True when a membership with `membershipRole` satisfies the command role. Unknown command roles never match (default deny). */
export function roleSatisfies(commandRole: string, membershipRole: MembershipRole): boolean {
  if (!isAgencyCommandRole(commandRole)) return false;
  return COMMAND_ROLE_MEMBERS[commandRole].has(membershipRole);
}

/** The registry role of a command (throws for an unknown id: the catalogue is closed). */
export function commandRole(id: CommandId): CommandRole {
  const c = COMMANDS.find((x) => x.id === id);
  if (!c) throw new TypeError(`unknown command ${id}`);
  return c.role as CommandRole;
}

/** Capabilities of a role, for DTO permittedActions projections. */
export function capabilitiesOf(role: MembershipRole): ReadonlyArray<AgencyCapability> {
  return [...ROLE_CAPABILITIES[role]];
}
