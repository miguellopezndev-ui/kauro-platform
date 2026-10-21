// The review world's projects (Order 11): one name, one client and one service per project, read by the menu (which nests a project's areas
// under Projects), by the project's header and by every prototype that names a project, so no page names a project differently. A project's
// service decides its areas: a destination and an import for "Prepare for HubSpot" and "Prepare for Salesforce", neither for "Clean your
// data". Every name is synthetic; the client names are the public site's synthetic companies.
import type { ServiceMode } from "@web/screens.ts";
import { AGENCY_ID, COMPANY_ID } from "./contexts.ts";
import { IDS } from "./ids.ts";
import { EXAMPLE_ID } from "./world.ts";

export interface WorldProject {
  readonly projectId: string;
  readonly name: string;
  readonly clientLabel: string;
  readonly mode: ServiceMode;
}

const id = (n: number): string => `0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e7${String(n).padStart(3, "0")}`;
const p = (projectId: string, name: string, clientLabel: string, mode: ServiceMode): WorldProject => ({ projectId, name, clientLabel, mode });

/** The "Clean your data" project the review walks from the files to the delivery (no destination, no import). */
export const CLEAN_PROJECT = id(203);

export const WORLD_PROJECTS: Readonly<Record<string, readonly WorldProject[]>> = {
  [AGENCY_ID]: [
    p(IDS.project, "Contacts and companies", "Larch Studio", "HUBSPOT"),
    p(id(202), "Accounts and contacts", "Osprey Freight", "SALESFORCE"),
    p(CLEAN_PROJECT, "Customer list", "Tidewell", "CLEAN"),
    p(id(204), "Spring contacts", "Harbor Mill", "HUBSPOT"),
    p(id(205), "Opportunities", "Osprey Freight", "SALESFORCE"),
    p(id(206), "Newsletter list", "Larch Studio", "CLEAN"),
    p(id(207), "Contacts", "Tidewell", "HUBSPOT"),
  ],
  [COMPANY_ID]: [p(IDS.project, "Customer records", "Halden Outdoor", "HUBSPOT"), p(id(212), "Dealer list", "Halden Outdoor", "CLEAN")],
  [EXAMPLE_ID]: [p(IDS.project, "Example project", "Larch Studio (synthetic)", "HUBSPOT")],
};

/** The project an agency's page names, when the world has it. */
export function worldProject(agencyId: string, projectId: string): WorldProject | null {
  return WORLD_PROJECTS[agencyId]?.find((one) => one.projectId === projectId) ?? null;
}
