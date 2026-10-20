// The review's synthetic world (Order 11): one consistent set of workspaces, memberships, clients and projects, so every page a person
// walks to agrees with the others (the agency they switch to has the name they chose, a project's stage is the same on every page). Every
// name is invented, every address uses a reserved domain, every figure is synthetic. Fixture answers and prototypes both read from here.
import type { AgencyView } from "@web/api/generated.ts";
import type { Role } from "../prototypes/kit.tsx";

/** What each role may do, as the api lists it on an agency (B06 D-AUTHZ-1). */
export const ROLE_ACTIONS: Readonly<Record<Role, AgencyView["permittedActions"]>> = {
  OWNER: ["MANAGE_AGENCY", "MANAGE_TEAM", "MANAGE_CLIENTS", "CREATE_CLIENTS", "OPERATE_PROJECTS", "APPROVE_PLANS", "MANAGE_BILLING", "REQUEST_DELETION", "MANAGE_BRANDING", "VIEW"],
  ADMIN: ["MANAGE_TEAM", "MANAGE_CLIENTS", "CREATE_CLIENTS", "OPERATE_PROJECTS", "REQUEST_DELETION", "MANAGE_BRANDING", "VIEW"],
  OPERATOR: ["CREATE_CLIENTS", "OPERATE_PROJECTS", "VIEW"],
  APPROVER: ["APPROVE_PLANS", "VIEW"],
  BILLING: ["MANAGE_BILLING", "VIEW"],
  VIEWER: ["VIEW"],
};

/** The example workspace: synthetic, read-only, open to anyone signed in, with the public site's worked example as its one project. */
export const EXAMPLE_ID = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fe0";

export interface Workspace {
  readonly agencyId: string;
  readonly name: string;
  readonly kind: "agency" | "in-house";
  readonly state: AgencyView["state"];
  readonly createdAt: string;
}

export const WORKSPACES: readonly Workspace[] = [
  { agencyId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fa1", name: "Northwind Data", kind: "agency", state: "ACTIVE", createdAt: "2026-09-02T14:20:00Z" },
  { agencyId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fb9", name: "Halden Outdoor", kind: "in-house", state: "ACTIVE", createdAt: "2026-09-20T10:05:00Z" },
  { agencyId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fc1", name: "Coastline Analytics", kind: "agency", state: "ACTIVE", createdAt: "2026-08-11T09:00:00Z" },
  { agencyId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fc2", name: "Ridge & Fennel Consulting", kind: "agency", state: "RESTRICTED", createdAt: "2026-07-30T15:45:00Z" },
  { agencyId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fc3", name: "Juniper Digital", kind: "agency", state: "ACTIVE", createdAt: "2026-06-18T12:10:00Z" },
  { agencyId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fc4", name: "Northwind Labs", kind: "agency", state: "DRAFT", createdAt: "2026-10-18T16:40:00Z" },
  { agencyId: EXAMPLE_ID, name: "Example workspace", kind: "agency", state: "ACTIVE", createdAt: "2026-10-01T00:00:00Z" },
];

export interface Membership {
  readonly agencyId: string;
  readonly role: Role;
  readonly state: "ACTIVE" | "SUSPENDED";
}

/** Who belongs where, for each person of the review. */
export const MEMBERSHIPS: Readonly<Record<string, readonly Membership[]>> = {
  agency: [
    { agencyId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fa1", role: "OWNER", state: "ACTIVE" },
    { agencyId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fc1", role: "OPERATOR", state: "ACTIVE" },
    { agencyId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fc2", role: "VIEWER", state: "ACTIVE" },
    { agencyId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fc3", role: "APPROVER", state: "SUSPENDED" },
    { agencyId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fc4", role: "OWNER", state: "ACTIVE" },
  ],
  company: [{ agencyId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fb9", role: "OWNER", state: "ACTIVE" }],
  admin: [{ agencyId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fa1", role: "ADMIN", state: "ACTIVE" }],
  operator: [{ agencyId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fa1", role: "OPERATOR", state: "ACTIVE" }],
  outsider: [],
  newcomer: [],
  owner: [],
  seller: [],
};

export function workspaceOf(agencyId: string): Workspace | undefined {
  return WORKSPACES.find((workspace) => workspace.agencyId === agencyId);
}

/** The api's answer for an agency, as one person sees it: their own permitted actions, or null when they are not an active member. */
export function agencyFor(person: string, agencyId: string): AgencyView | null {
  const workspace = workspaceOf(agencyId);
  // the example is read-only for everyone: it can be looked at, never changed
  const membership = agencyId === EXAMPLE_ID ? { agencyId, role: "VIEWER" as const, state: "ACTIVE" as const } : (MEMBERSHIPS[person] ?? []).find((candidate) => candidate.agencyId === agencyId);
  if (workspace === undefined || membership === undefined || membership.state !== "ACTIVE") return null;
  return {
    agencyId,
    version: 7,
    displayName: workspace.name,
    state: workspace.state,
    ...(workspace.state === "DRAFT" ? {} : { termsVersion: "TERMS_2026_10", privacyAgreementVersion: "DPA_2026_10" }),
    createdAt: workspace.createdAt,
    permittedActions: ROLE_ACTIONS[membership.role],
  };
}
