/**
 * The served operations a caller may issue on a resource (re-check finding N16; 07 "Acceptance obligations": "The handoff to
 * UI includes every state, safe field, permitted action and error"; 10 "Resource reads return a version or ETag where edits are
 * supported"). A resource view carries them as `permittedActions`, derived server-side from exactly three facts: the caller's
 * membership role against each command's registry role (D-AUTHZ-1), the resource's state against the registry edge the command
 * performs, and — for an approval and an approved plan — whether the caller controls the approval (the approving actor or an
 * OWNER, D-AUTHZ-3). A permitted action is informative, never authority: every command re-checks its role, its state, its
 * version and its guards inside its own transaction, and a guard the view cannot see (a reconciliation, a step-up) still decides.
 *
 * The vocabulary is the operation ids of the served commands that act on an existing resource; a command that acts on a
 * resource of a later package's aggregate (a project's revisions, quotes or deletion) is that package's action and is not
 * offered by this edition, so a project view offers none.
 */
import type { AgencyRecord, ApprovalRecord, EndClientRecord, MembershipRole, PlanRecord, ResolvedMembership } from "@kauro/domain";
import { AGENCY_OPEN_STATES, findTransition, roleSatisfies } from "@kauro/domain";
import { B06_COMMANDS, type B06CommandId } from "../commands/contracts.js";

export const RESOURCE_ACTIONS = ["ArchiveClient", "CreateProject", "RevisePlan", "ApprovePlan", "WithdrawApproval"] as const;
export type ResourceAction = (typeof RESOURCE_ACTIONS)[number];

function admits(command: B06CommandId, role: MembershipRole): boolean {
  return roleSatisfies(B06_COMMANDS[command].role, role);
}

/** Whether the membership controls an approval (D-AUTHZ-3: its approving actor, or any OWNER). */
export function controlsApproval(approval: Pick<ApprovalRecord, "actorMembershipId">, membership: Pick<ResolvedMembership, "membershipId" | "role">): boolean {
  return approval.actorMembershipId === membership.membershipId || membership.role === "OWNER";
}

/**
 * A client: ArchiveClient (CMD010, ACTIVE -> ARCHIVED), CreateProject (CMD011, an ACTIVE client of an open agency). `agency` is
 * null when the caller did not read it (an archived client offers nothing either way); CreateProject is then not offered.
 */
export function clientActions(role: MembershipRole, client: Pick<EndClientRecord, "state">, agency: Pick<AgencyRecord, "state"> | null): ReadonlyArray<ResourceAction> {
  if (client.state !== "ACTIVE") return [];
  const out: ResourceAction[] = [];
  if (admits("CMD010", role)) out.push("ArchiveClient");
  if (admits("CMD011", role) && agency !== null && AGENCY_OPEN_STATES.has(agency.state)) out.push("CreateProject");
  return out;
}

/** A project: no served command of this edition acts on an existing project (its revisions, quotes and deletion are later packages'). */
export function projectActions(): ReadonlyArray<ResourceAction> {
  return [];
}

/**
 * A plan revision: RevisePlan (CMD023, a state that lists new_plan_revision; an APPROVED plan only for its approval's
 * controller), ApprovePlan (CMD025, VALIDATED), WithdrawApproval (CMD026, APPROVED, the approval's controller).
 */
export function planActions(role: MembershipRole, plan: Pick<PlanRecord, "state">, controlsLiveApproval: boolean): ReadonlyArray<ResourceAction> {
  const out: ResourceAction[] = [];
  if (admits("CMD023", role) && findTransition("Plan", plan.state, "new_plan_revision") !== null && (plan.state !== "APPROVED" || controlsLiveApproval)) out.push("RevisePlan");
  if (admits("CMD025", role) && plan.state === "VALIDATED") out.push("ApprovePlan");
  if (admits("CMD026", role) && plan.state === "APPROVED" && controlsLiveApproval) out.push("WithdrawApproval");
  return out;
}

/** An approval: WithdrawApproval while it is live, for its controller with an approving role (CMD026). */
export function approvalActions(membership: Pick<ResolvedMembership, "membershipId" | "role">, approval: Pick<ApprovalRecord, "withdrawnAt" | "actorMembershipId">): ReadonlyArray<ResourceAction> {
  if (approval.withdrawnAt !== undefined) return [];
  return admits("CMD026", membership.role) && controlsApproval(approval, membership) ? ["WithdrawApproval"] : [];
}
