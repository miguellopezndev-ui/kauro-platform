"use client";
// Every private screen as the review shows it (Order 11): where it lives in the application, which synthetic people may look at it, its
// states, and, for a screen not built yet, the prototype that draws it. Real screens draw themselves from the state's api answers.
import type { ComponentType } from "react";
import { pathOf } from "@web/screens.ts";
import { AGENCY_ID, COMPANY_ID, CONTEXTS, type ContextKey, CONTEXTS_FOR, type ReviewContext } from "./contexts.ts";
import { IDS } from "./ids.ts";
import { screenOf } from "./inventory.ts";
import { PROTOTYPES } from "./prototypes.tsx";
import { proposalOf } from "./proposals.ts";
import { NOT_MEMBER, PENDING, READ, type StateDef, UNAVAILABLE, withShared } from "./scenario.ts";
import { agencyFor } from "./world.ts";
import { UI14_STATES, UI15_STATES, UI16_STATES } from "./fixtures/sources-states.ts";

export interface PrototypeProps {
  readonly ctx: ReviewContext;
  readonly state: string;
}

export interface ScreenDef {
  readonly states: readonly StateDef[];
  readonly contexts: readonly ContextKey[];
  readonly Prototype?: ComponentType<PrototypeProps>;
}

const agencyOf = (ctx: ReviewContext): string => ctx.agency?.agencyId ?? (ctx.key === "company" ? COMPANY_ID : AGENCY_ID);

/** The screen's address in the application for this person (the shell decides from it, exactly as in production). */
export function appPathOf(id: string, ctx: ReviewContext, project: string = IDS.project): string {
  const screen = screenOf(id);
  if (screen === undefined) throw new RangeError(id);
  const agencyId = agencyOf(ctx);
  // a proposal has no route of its own: it is drawn where it would live (the settings of the agency, or a path no screen owns yet)
  const proposal = proposalOf(id);
  if (proposal !== undefined) {
    if (proposal.key === "P-02") return pathOf("UI32", { agencyId });
    if (proposal.key === "P-05") return "/signup";
    if (proposal.key === "P-06") return "/login/reset";
    return proposal.origin === "OPS" ? "/ops/settings" : "/account";
  }
  switch (id) {
    case "UI09":
    case "UI10":
    case "UI50":
      return pathOf(id);
    case "UI51":
      return pathOf(id, { id: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e7b01" });
    case "UI24":
      return pathOf(id, { agencyId, orderId: IDS.order });
    case "UI35":
    case "UI37":
      return pathOf(id, { id: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e7c01" });
    default: {
      if (screen.origin === "OPS") return pathOf(id);
      return screen.route.includes("{id}") ? pathOf(id, { agencyId, id: project }) : pathOf(id, { agencyId });
    }
  }
}

const REAL: Readonly<Record<string, readonly StateDef[]>> = {
  UI14: UI14_STATES,
  UI15: UI15_STATES,
  UI16: UI16_STATES,
  UI32: [
    { key: "normal", label: "Normal", note: "The settings as this person sees them: the closure is offered to an owner only." },
    {
      key: "closing",
      label: "Closure requested",
      note: "The agency asked to close: the page says so and offers nothing more.",
      script: (ctx) => ({ GetAgency: (call) => {
        const agency = agencyFor(ctx.key, call.params["agencyId"] ?? "");
        return agency === null ? NOT_MEMBER : READ({ ...agency, state: "CLOSING" });
      } }),
    },
    { key: "loading", label: "Loading", note: "The agency has not been read yet: the shell holds the page and says so.", script: () => ({ GetAgency: PENDING }) },
    { key: "error", label: "Recoverable error", note: "The agency could not be read for a moment: the page offers to try again.", script: () => ({ GetAgency: UNAVAILABLE }) },
    { key: "denied", label: "Not a member", note: "A signed-in person who is not a member of this agency: the shell refuses before anything is read.", base: "AGENCY_REFUSED" },
  ],
};

const PROTOTYPE_STATES: readonly StateDef[] = [{ key: "normal", label: "Normal", note: "The designed screen with synthetic data." }];

export function screenDef(id: string): ScreenDef {
  const screen = screenOf(id);
  if (screen === undefined) throw new RangeError(id);
  const contexts = [...CONTEXTS_FOR[screen.origin === "OPS" ? "OPS" : "APP"]];
  const real = REAL[id];
  if (real !== undefined) return { states: withShared(real), contexts };
  const prototype = PROTOTYPES[id];
  // the sign-in and the invitation are drawn without a session: the shell's session states do not apply to them
  const anonymous = id === "UI50" || id === "UI51" || id === "P-05" || id === "P-06";
  const states = prototype?.states ?? PROTOTYPE_STATES;
  return { states: anonymous ? states : withShared(states), contexts: prototype?.contexts ?? contexts, ...(prototype === undefined ? {} : { Prototype: prototype.Component }) };
}

export { CONTEXTS };
