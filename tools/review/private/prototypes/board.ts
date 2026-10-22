// Words the board pages share (Order 11 round 2): the stage in words, the date that matters, and the person a step waits on. Projects,
// Clients and the Overview read them from here, so a project is described the same way on each.
import { stageLabel, type ProjectStage } from "@web/screens/shared/project-header.tsx";
import type { ServiceMode } from "@web/screens.ts";
import type { ReviewContext } from "../lib/contexts.ts";
import { moment } from "./kit.tsx";
import type { Duty } from "./people.ts";
import { teamOf } from "./people.ts";
import { ENDING_LABEL, type Matters } from "./projects-data.ts";

export const STAGES: readonly ProjectStage[] = ["files", "check", "plan", "purchase", "preparation", "delivery"];

/** "4 of 6 · Quote and payment" */
export function stageText(stage: number, mode: ServiceMode): string {
  const key = STAGES[stage] ?? "files";
  return `${stage + 1} of ${STAGES.length} · ${stageLabel(key, mode)}`;
}

/** "Files deleted on Oct 27, 2026, 10:58 AM UTC" */
export function mattersText(matters: Matters): string {
  return `${ENDING_LABEL[matters.ending]} ${moment(matters.at)}`;
}

const ROLES: Readonly<Record<Duty, readonly string[]>> = {
  operate: ["OPERATOR", "ADMIN", "OWNER"],
  approve: ["APPROVER", "OWNER"],
  pay: ["BILLING", "OWNER"],
  team: ["ADMIN", "OWNER"],
  delete: ["ADMIN", "OWNER"],
  settings: ["ADMIN", "OWNER"],
  close: ["OWNER"],
};

const ROLE_WORD: Readonly<Record<string, string>> = { OWNER: "Owner", ADMIN: "Admin", OPERATOR: "Operator", APPROVER: "Approver", BILLING: "Billing", VIEWER: "Viewer" };

/** The one person a step waits on: the specialist who holds the role, else an owner ("Samuel Osei (Approver)"). */
export function waitingOn(ctx: ReviewContext, duty: Duty): string {
  const team = teamOf(ctx);
  for (const role of ROLES[duty]) {
    const person = team.find((one) => one.role === role);
    if (person !== undefined) return `${person.name} (${ROLE_WORD[person.role] ?? person.role})`;
  }
  return "An owner";
}

/** The person who did something in the project's history, by role: the specialist, or the owner in a one-person company. */
export function actor(ctx: ReviewContext, role: string): string {
  const team = teamOf(ctx);
  const person = team.find((one) => one.role === role) ?? team.find((one) => one.role === "OWNER");
  return person === undefined ? "Your team" : `${person.name} (${ROLE_WORD[person.role] ?? person.role})`;
}
