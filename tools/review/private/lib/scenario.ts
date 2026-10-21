// What a screen's review state is (Order 11 §7): the answers the api gives in it. A state is only data for the fixture fetch, so a real
// screen draws it with its own code; a prototype reads the same state key to draw its matching variant. The states every private screen
// shares (the session and the agency the shell reads first) are built here once.
import type { OperationId } from "@web/api/generated.ts";
import type { WorldProject } from "./world-projects.ts";
import { type ContextKey, CONTEXTS, type ReviewContext, sessionFor } from "./contexts.ts";
import type { Reply, Script } from "./fixture-fetch.ts";
import { agencyFor, workspaceOf } from "./world.ts";

export interface StateDef {
  readonly key: string;
  readonly label: string;
  /** One line for the owner: what this state is and when a person meets it. */
  readonly note: string;
  /** The api's answers in this state, beyond the session and the agency (real screens only). */
  /** The replies of this state, for this person and the project the page names (a real screen read by id cannot tell). */
  readonly script?: (ctx: ReviewContext, project?: WorldProject) => Script;
  /** The session and agency answers are replaced (sign-in states, refusals). */
  readonly base?: "SIGNED_IN" | "SIGNED_OUT" | "SESSION_UNAVAILABLE" | "AGENCY_REFUSED";
}

export const READ = (data: unknown): Reply => ({ status: 200, body: { kind: "READ", data } });
export const PENDING: Reply = "PENDING";
export const UNAVAILABLE: Reply = { status: 503, problem: "INTERNAL_ERROR", retryable: true, nextActions: [{ action: "RETRY_LATER" }] } as Reply;
export const DENIED: Reply = { status: 403, problem: "NOT_AUTHORIZED", reason: "ROLE_INSUFFICIENT" };
export const NOT_MEMBER: Reply = { status: 403, problem: "NOT_AUTHORIZED", reason: "NOT_A_MEMBER" };

/** The answers the shell needs before any screen draws: the session, and the agency the address names. */
export function baseScript(ctx: ReviewContext, base: StateDef["base"] = "SIGNED_IN"): Script {
  const now = Date.now();
  if (base === "SIGNED_OUT") return { getCurrentSession: { status: 401, problem: "AUTHENTICATION_REQUIRED", reason: "SUBJECT_UNAUTHENTICATED" } };
  if (base === "SESSION_UNAVAILABLE") return { getCurrentSession: UNAVAILABLE };
  const script: Script = { getCurrentSession: { status: 200, body: sessionFor(now) } };
  // the agency the address names, as this person sees it in the review's world: their own role's actions, or a refusal
  script.GetAgency = (call) => {
    if (base === "AGENCY_REFUSED") return NOT_MEMBER;
    const agency = agencyFor(ctx.key, call.params["agencyId"] ?? "");
    return agency === null ? NOT_MEMBER : READ(agency);
  };
  script.GetBuyerType = (call) => {
    const workspace = workspaceOf(call.params["agencyId"] ?? "");
    return workspace === undefined ? NOT_MEMBER : READ({ agencyId: workspace.agencyId, buyerType: workspace.kind, forEconomicActivity: true, recordedAt: workspace.createdAt, version: 2 });
  };
  return script;
}

/** Every state a screen offers; the shared session states close the list for every private screen. */
export function withShared(states: readonly StateDef[]): readonly StateDef[] {
  return [
    ...states,
    { key: "signed-out", label: "Signed out", note: "The session ended: the shell replaces the screen with the sign-in step. No private content is drawn.", base: "SIGNED_OUT" },
    { key: "session-unavailable", label: "Session check unavailable", note: "The session could not be checked: the shell offers to check again and draws nothing private.", base: "SESSION_UNAVAILABLE" },
  ];
}

/** The script of one state, as the fixture fetch asks for it. */
export function scriptOf(state: StateDef, contextKey: ContextKey, project?: WorldProject): Script {
  const ctx = CONTEXTS[contextKey];
  return { ...baseScript(ctx, state.base), ...(state.script?.(ctx, project) ?? {}) };
}

/** A helper for a real screen whose reads are `ops`: normal, loading, recoverable error. */
export function readStates(ops: Readonly<Partial<Record<OperationId, (ctx: ReviewContext) => Reply>>>, extra: readonly StateDef[] = []): readonly StateDef[] {
  const all = (pick: (op: OperationId, make: (ctx: ReviewContext) => Reply, ctx: ReviewContext) => Reply) => (ctx: ReviewContext): Script =>
    Object.fromEntries(Object.entries(ops).map(([op, make]) => [op, pick(op as OperationId, make as (ctx: ReviewContext) => Reply, ctx)]));
  return [
    { key: "normal", label: "Normal", note: "The screen with its synthetic data, as the person would use it.", script: all((_, make, ctx) => make(ctx)) },
    ...extra,
    { key: "loading", label: "Loading", note: "The api has not answered yet: the screen holds its place and announces that it is loading.", script: all(() => PENDING) },
    { key: "error", label: "Recoverable error", note: "The api is unavailable for a moment: the screen says so and offers to try again.", script: all(() => UNAVAILABLE) },
    { key: "denied", label: "Not a member", note: "A signed-in person who is not a member of this agency: the shell refuses before the screen reads anything.", base: "AGENCY_REFUSED" },
  ];
}
