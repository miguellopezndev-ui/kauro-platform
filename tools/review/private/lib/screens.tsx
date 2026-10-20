"use client";
// Every private screen as the review shows it (Order 11): where it lives in the application, which synthetic people may look at it, its
// states, and, for a screen not built yet, the prototype that draws it. Real screens draw themselves from the state's api answers.
import type { ComponentType } from "react";
import { pathOf } from "@web/screens.ts";
import { AGENCY_ID, COMPANY_ID, CONTEXTS, type ContextKey, CONTEXTS_FOR, type ReviewContext } from "./contexts.ts";
import { IDS } from "./ids.ts";
import { screenOf } from "./inventory.ts";
import { PROTOTYPES } from "./prototypes.tsx";
import { READ, readStates, type StateDef, withShared } from "./scenario.ts";

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
export function appPathOf(id: string, ctx: ReviewContext): string {
  const screen = screenOf(id);
  if (screen === undefined) throw new RangeError(id);
  const agencyId = agencyOf(ctx);
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
      return screen.route.includes("{id}") ? pathOf(id, { agencyId, id: IDS.project }) : pathOf(id, { agencyId });
    }
  }
}

const REAL: Readonly<Record<string, readonly StateDef[]>> = {
  UI32: readStates({ GetAgency: (ctx) => READ(ctx.agency) }, [
    {
      key: "closing",
      label: "Closure requested",
      note: "The agency asked to close: the page says so and offers nothing more.",
      script: (ctx) => ({ GetAgency: READ(ctx.agency === null ? null : { ...ctx.agency, state: "CLOSING" }) }),
    },
  ]),
};

const PROTOTYPE_STATES: readonly StateDef[] = [{ key: "normal", label: "Normal", note: "The designed screen with synthetic data." }];

export function screenDef(id: string): ScreenDef {
  const screen = screenOf(id);
  if (screen === undefined) throw new RangeError(id);
  const contexts = [...CONTEXTS_FOR[screen.origin === "OPS" ? "OPS" : "APP"]];
  const real = REAL[id];
  if (real !== undefined) return { states: withShared(real), contexts };
  const prototype = PROTOTYPES[id];
  return { states: withShared(prototype?.states ?? PROTOTYPE_STATES), contexts: prototype?.contexts ?? contexts, ...(prototype === undefined ? {} : { Prototype: prototype.Component }) };
}

export { CONTEXTS };
