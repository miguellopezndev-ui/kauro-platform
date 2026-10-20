// The review's projects (Order 11), shaped exactly as the api's project board answers them (ListProjects → ProjectDashboardItem), so the
// board designed here can be drawn from the real read without a change. Northwind Data works for four clients; Halden Outdoor prepares
// its own data. Client names are the public site's synthetic companies. Every value is synthetic.
import type { ProjectDashboardItem } from "@web/api/generated.ts";
import { IDS } from "../lib/ids.ts";

const id = (n: number): string => `0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e7${String(n).padStart(3, "0")}`;
export const CLIENT = { larch: id(101), osprey: id(102), tidewell: id(103), harbor: id(104) } as const;

const item = (overrides: Partial<ProjectDashboardItem> & Pick<ProjectDashboardItem, "projectId" | "clientId" | "clientLabel" | "mode" | "phase" | "requiredAction">): ProjectDashboardItem => ({
  revision: { revisionId: id(900 + Number(overrides.projectId.slice(-3))), state: "SEALED" },
  deadline: null,
  lastActivityAt: "2026-10-20T15:00:00Z",
  version: 3,
  ...overrides,
});

/** Northwind Data's projects, newest activity first. */
export const AGENCY_PROJECTS: readonly ProjectDashboardItem[] = [
  item({ projectId: IDS.project, clientId: CLIENT.larch, clientLabel: "Larch Studio", mode: "HUBSPOT", phase: "PURCHASE", requiredAction: "PAY_QUOTE", deadline: "2026-10-27T13:00:00Z", lastActivityAt: "2026-10-20T13:10:00Z" }),
  item({ projectId: id(202), clientId: CLIENT.osprey, clientLabel: "Osprey Freight", mode: "SALESFORCE", phase: "PLAN", requiredAction: "APPROVE_PLAN", lastActivityAt: "2026-10-20T11:40:00Z" }),
  item({ projectId: id(203), clientId: CLIENT.tidewell, clientLabel: "Tidewell", mode: "CLEAN", phase: "HEALTH_CHECK", requiredAction: "NONE", lastActivityAt: "2026-10-20T10:02:00Z", revision: { revisionId: id(903), state: "SEALED" } }),
  item({ projectId: id(204), clientId: CLIENT.harbor, clientLabel: "Harbor Mill", mode: "HUBSPOT", phase: "SOURCES", requiredAction: "UPLOAD_SOURCES", lastActivityAt: "2026-10-19T17:25:00Z", revision: { revisionId: id(904), state: "UPLOADING" } }),
  item({ projectId: id(205), clientId: CLIENT.osprey, clientLabel: "Osprey Freight", mode: "SALESFORCE", phase: "PROCESSING", requiredAction: "NONE", deadline: "2026-10-22T14:00:00Z", lastActivityAt: "2026-10-20T14:00:00Z" }),
  item({ projectId: id(206), clientId: CLIENT.larch, clientLabel: "Larch Studio", mode: "CLEAN", phase: "DELIVERED", requiredAction: "NONE", lastActivityAt: "2026-10-12T09:30:00Z" }),
  item({ projectId: id(207), clientId: CLIENT.tidewell, clientLabel: "Tidewell", mode: "HUBSPOT", phase: "DELIVERED", requiredAction: "NONE", lastActivityAt: "2026-10-03T16:45:00Z" }),
];

/** Halden Outdoor's projects: a company buying for its own data, so the client is the company itself. */
export const COMPANY_PROJECTS: readonly ProjectDashboardItem[] = [
  item({ projectId: IDS.project, clientId: id(110), clientLabel: "Halden Outdoor", mode: "SALESFORCE", phase: "PLAN", requiredAction: "APPROVE_PLAN", lastActivityAt: "2026-10-20T12:15:00Z" }),
  item({ projectId: id(212), clientId: id(110), clientLabel: "Halden Outdoor", mode: "CLEAN", phase: "DELIVERED", requiredAction: "NONE", lastActivityAt: "2026-09-28T10:00:00Z" }),
];

/** How many paid projects each workspace already has, for the repeat-discount line (proposed: no read serves it yet). */
export const PAID_PROJECTS: Readonly<Record<string, number>> = { agency: 6, admin: 6, operator: 6, company: 1 };
