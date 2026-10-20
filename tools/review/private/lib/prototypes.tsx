"use client";
// The prototypes of the private screens not built yet (Order 11 §2: VISUAL PROTOTYPE — NOT FUNCTIONAL). Each is a view of synthetic data
// shaped like the api's own views, drawn with the web's components and stylesheets, so the design can move into the application later
// without being redrawn. None of them calls anything: their states are chosen by the review.
import type { ComponentType } from "react";
import type { ContextKey } from "./contexts.ts";
import type { StateDef } from "./scenario.ts";
import { SignIn, UI50_STATES } from "../prototypes/ui50-sign-in.tsx";
import { Invitation, UI51_STATES } from "../prototypes/ui51-invitation.tsx";
import { AgencySetup, UI09_STATES } from "../prototypes/ui09-setup.tsx";
import { AgencySwitcher, UI10_STATES } from "../prototypes/ui10-switcher.tsx";
import { Team, UI31_STATES } from "../prototypes/ui31-team.tsx";
import { P01_STATES, PersonalSettings } from "../prototypes/p01-personal.tsx";
import { OrganisationSettings, P02_STATES } from "../prototypes/p02-organisation.tsx";
import { P03_STATES, SellerSettings } from "../prototypes/p03-seller.tsx";
import { OwnerSettings, P04_STATES } from "../prototypes/p04-owner.tsx";
import { P05_STATES, SignUp } from "../prototypes/p05-sign-up.tsx";
import { P06_STATES, ResetPassword } from "../prototypes/p06-reset.tsx";
import type { PrototypeProps } from "./screens.tsx";

export interface PrototypeEntry {
  readonly Component: ComponentType<PrototypeProps>;
  readonly states: readonly StateDef[];
  readonly contexts?: readonly ContextKey[];
}

export const PROTOTYPES: Readonly<Record<string, PrototypeEntry>> = {
  UI50: { Component: SignIn, states: UI50_STATES, contexts: ["agency"] },
  UI51: { Component: Invitation, states: UI51_STATES, contexts: ["operator"] },
  UI09: { Component: AgencySetup, states: UI09_STATES, contexts: ["newcomer", "company", "agency"] },
  UI10: { Component: AgencySwitcher, states: UI10_STATES, contexts: ["agency", "company", "newcomer"] },
  UI31: { Component: Team, states: UI31_STATES },
  "P-01": { Component: PersonalSettings, states: P01_STATES, contexts: ["agency", "company", "operator"] },
  "P-02": { Component: OrganisationSettings, states: P02_STATES, contexts: ["agency", "company", "admin", "operator"] },
  "P-03": { Component: SellerSettings, states: P03_STATES, contexts: ["seller"] },
  "P-04": { Component: OwnerSettings, states: P04_STATES, contexts: ["owner"] },
  "P-05": { Component: SignUp, states: P05_STATES, contexts: ["newcomer"] },
  "P-06": { Component: ResetPassword, states: P06_STATES, contexts: ["agency"] },
};
