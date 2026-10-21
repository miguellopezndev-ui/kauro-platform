// The people of the review's workspaces (Order 11 round 2), and who may do what, named as people rather than role theory (research
// agency-workspace.md §3.8, §6; app-shell-settings.md §9.11). Roles follow the code (kauro-baseline.md §2.2): only an owner or an approver
// approves a plan or continues an import stage; only an owner or a billing member requests a quote, pays or asks for a refund; an admin does
// neither. A control the viewer cannot use is not drawn: one line says who can, by name. Every person is synthetic; addresses use the
// reserved .example domain.
import type { ReviewContext } from "../lib/contexts.ts";
import { COMPANY_ID } from "../lib/contexts.ts";
import type { Role } from "./kit.tsx";

export interface Person {
  readonly name: string;
  readonly role: Role;
  readonly email: string;
}

const AGENCY_TEAM: readonly Person[] = [
  { name: "Lena Ortiz", role: "OWNER", email: "lena.ortiz@northwind.example" },
  { name: "Marco Bianchi", role: "ADMIN", email: "marco.bianchi@northwind.example" },
  { name: "Priya Nair", role: "OPERATOR", email: "priya.nair@northwind.example" },
  { name: "Samuel Osei", role: "APPROVER", email: "samuel.osei@northwind.example" },
  { name: "Ines Duarte", role: "BILLING", email: "ines.duarte@northwind.example" },
  { name: "Ruth Okafor", role: "VIEWER", email: "ruth.okafor@northwind.example" },
];

/** A company buying for itself, run by one person who holds every role: pages skip "waiting on" lines and show the next action. */
const COMPANY_TEAM: readonly Person[] = [{ name: "Tomas Reyes", role: "OWNER", email: "tomas.reyes@halden.example" }];

export function teamOf(ctx: ReviewContext): readonly Person[] {
  return ctx.agency?.agencyId === COMPANY_ID ? COMPANY_TEAM : AGENCY_TEAM;
}

/** What a member may do, in the code's terms (roles.ts, commands.json). */
export type Duty = "operate" | "approve" | "pay" | "team" | "delete" | "settings" | "close";

const ROLES_FOR: Readonly<Record<Duty, readonly Role[]>> = {
  operate: ["OWNER", "ADMIN", "OPERATOR"],
  approve: ["OWNER", "APPROVER"],
  pay: ["OWNER", "BILLING"],
  team: ["OWNER", "ADMIN"],
  delete: ["OWNER", "ADMIN"],
  settings: ["OWNER", "ADMIN"],
  close: ["OWNER"],
};

const ACTION_FOR: Readonly<Record<Duty, string>> = {
  operate: "OPERATE_PROJECTS",
  approve: "APPROVE_PLANS",
  pay: "MANAGE_BILLING",
  team: "MANAGE_TEAM",
  delete: "REQUEST_DELETION",
  settings: "MANAGE_BRANDING",
  close: "MANAGE_AGENCY",
};

/** Whether the person the review shows may do this here (the agency's permitted actions, as the api lists them). */
export function can(ctx: ReviewContext, duty: Duty): boolean {
  return (ctx.agency?.permittedActions ?? []).includes(ACTION_FOR[duty] as never);
}

/** The people who may do it, specialists first, then owners: "Samuel Osei (Approver) or Lena Ortiz (Owner)". */
export function whoCan(ctx: ReviewContext, duty: Duty): string {
  const roles = ROLES_FOR[duty];
  const people = teamOf(ctx)
    .filter((person) => roles.includes(person.role))
    .sort((a, b) => (a.role === "OWNER" ? 1 : 0) - (b.role === "OWNER" ? 1 : 0));
  const names = people.map((person) => `${person.name} (${ROLE_LABEL[person.role]})`);
  return names.length <= 1 ? (names[0] ?? "An owner") : `${names.slice(0, -1).join(", ")} or ${names.at(-1) ?? ""}`;
}

/** The one line a limited role reads instead of a control it cannot use. */
export function onlyLine(ctx: ReviewContext, duty: Duty, what: string): string {
  return `Only ${whoCan(ctx, duty)} can ${what}.`;
}

const ROLE_LABEL: Readonly<Record<Role, string>> = { OWNER: "Owner", ADMIN: "Admin", OPERATOR: "Operator", APPROVER: "Approver", BILLING: "Billing", VIEWER: "Viewer" };

/** True in a workspace where one person holds every role: there is nobody else to wait on. */
export function soloWorkspace(ctx: ReviewContext): boolean {
  return teamOf(ctx).length === 1;
}
