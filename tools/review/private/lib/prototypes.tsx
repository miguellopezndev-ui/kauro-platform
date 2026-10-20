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
import { Projects, UI11_STATES } from "../prototypes/ui11-projects.tsx";
import { Overview, UI13_STATES } from "../prototypes/ui13-overview.tsx";
import { Clients, UI12_STATES } from "../prototypes/ui12-clients.tsx";
import { TargetSetup, UI17_STATES } from "../prototypes/ui17-target.tsx";
import { Mapping, UI19_STATES } from "../prototypes/ui19-mapping.tsx";
import { Identity, UI20_STATES } from "../prototypes/ui20-identity.tsx";
import { Relationships, UI21_STATES } from "../prototypes/ui21-relationships.tsx";
import { Approval, UI22_STATES } from "../prototypes/ui22-approval.tsx";
import { Delivery, UI26_STATES } from "../prototypes/ui26-delivery.tsx";
import { ImportSteps, UI27_STATES } from "../prototypes/ui27-import.tsx";
import { ImportResults, UI28_STATES } from "../prototypes/ui28-results.tsx";
import { Lifecycle, UI29_STATES } from "../prototypes/ui29-lifecycle.tsx";
import { P01_STATES, PersonalSettings } from "../prototypes/p01-personal.tsx";
import { OrganisationSettings, P02_STATES } from "../prototypes/p02-organisation.tsx";
import { P03_STATES, SellerSettings } from "../prototypes/p03-seller.tsx";
import { OwnerSettings, P04_STATES } from "../prototypes/p04-owner.tsx";
import { P05_STATES, SignUp } from "../prototypes/p05-sign-up.tsx";
import { P06_STATES, ResetPassword } from "../prototypes/p06-reset.tsx";
import { HealthResults, P07_STATES } from "../prototypes/p07-results.tsx";
import { PrivateHome, UI33_STATES } from "../prototypes/ui33-home.tsx";
import { Prospects, UI34_STATES } from "../prototypes/ui34-prospects.tsx";
import { AgencyRelationship, UI35_STATES } from "../prototypes/ui35-relationship.tsx";
import { Commissions, UI36_STATES } from "../prototypes/ui36-commissions.tsx";
import { SellerLifecycle, UI37_STATES } from "../prototypes/ui37-seller.tsx";
import { OwnerActions, UI38_STATES } from "../prototypes/ui38-owner-actions.tsx";
import { Jobs, UI40_STATES } from "../prototypes/ui40-jobs.tsx";
import { Deletion, UI41_STATES } from "../prototypes/ui41-deletion.tsx";
import { Incidents, UI42_STATES } from "../prototypes/ui42-incidents.tsx";
import { Releases, UI43_STATES } from "../prototypes/ui43-releases.tsx";
import { OperatingReview, UI44_STATES } from "../prototypes/ui44-review.tsx";
import { Resources, UI53_STATES } from "../prototypes/ui53-resources.tsx";
import { Outreach, UI54_STATES } from "../prototypes/ui54-outreach.tsx";
import { SupportOperations, UI55_STATES } from "../prototypes/ui55-support.tsx";
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
  UI11: { Component: Projects, states: UI11_STATES, contexts: ["agency", "company", "admin", "operator"] },
  UI12: { Component: Clients, states: UI12_STATES, contexts: ["agency", "company", "admin", "operator"] },
  UI17: { Component: TargetSetup, states: UI17_STATES },
  UI19: { Component: Mapping, states: UI19_STATES },
  UI20: { Component: Identity, states: UI20_STATES },
  UI21: { Component: Relationships, states: UI21_STATES },
  UI22: { Component: Approval, states: UI22_STATES, contexts: ["agency", "company", "operator"] },
  UI26: { Component: Delivery, states: UI26_STATES },
  UI27: { Component: ImportSteps, states: UI27_STATES },
  UI28: { Component: ImportResults, states: UI28_STATES },
  UI29: { Component: Lifecycle, states: UI29_STATES, contexts: ["agency", "company", "operator"] },
  UI13: { Component: Overview, states: UI13_STATES, contexts: ["agency", "company", "admin", "operator", "newcomer"] },
  UI33: { Component: PrivateHome, states: UI33_STATES, contexts: ["owner", "seller"] },
  UI34: { Component: Prospects, states: UI34_STATES, contexts: ["seller", "owner"] },
  UI35: { Component: AgencyRelationship, states: UI35_STATES, contexts: ["owner"] },
  UI36: { Component: Commissions, states: UI36_STATES, contexts: ["seller", "owner"] },
  UI37: { Component: SellerLifecycle, states: UI37_STATES, contexts: ["owner"] },
  UI38: { Component: OwnerActions, states: UI38_STATES, contexts: ["owner"] },
  UI40: { Component: Jobs, states: UI40_STATES, contexts: ["owner"] },
  UI41: { Component: Deletion, states: UI41_STATES, contexts: ["owner"] },
  UI42: { Component: Incidents, states: UI42_STATES, contexts: ["owner"] },
  UI43: { Component: Releases, states: UI43_STATES, contexts: ["owner"] },
  UI44: { Component: OperatingReview, states: UI44_STATES, contexts: ["owner"] },
  UI53: { Component: Resources, states: UI53_STATES, contexts: ["seller"] },
  UI54: { Component: Outreach, states: UI54_STATES, contexts: ["seller", "owner"] },
  UI55: { Component: SupportOperations, states: UI55_STATES, contexts: ["owner"] },
  "P-01": { Component: PersonalSettings, states: P01_STATES, contexts: ["agency", "company", "operator"] },
  "P-02": { Component: OrganisationSettings, states: P02_STATES, contexts: ["agency", "company", "admin", "operator"] },
  "P-03": { Component: SellerSettings, states: P03_STATES, contexts: ["seller"] },
  "P-04": { Component: OwnerSettings, states: P04_STATES, contexts: ["owner"] },
  "P-05": { Component: SignUp, states: P05_STATES, contexts: ["newcomer"] },
  "P-06": { Component: ResetPassword, states: P06_STATES, contexts: ["agency"] },
  "P-07": { Component: HealthResults, states: P07_STATES, contexts: ["agency", "company", "operator"] },
};
