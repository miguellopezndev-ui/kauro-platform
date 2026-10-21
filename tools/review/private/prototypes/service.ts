// The words of each service (Order 11, the owner's decision of 2026-10-20 on names): "Clean your data", "Prepare for HubSpot", "Prepare for
// Salesforce" are the buyer-facing names; CLEAN, HUBSPOT and SALESFORCE stay internal identifiers. Each service carries one line of what it
// produces, who does what, and its limits; "Clean your data" never suggests external enrichment, irreversible deletion of records, or
// compatibility with any CRM. The destination words (the importer, the objects) are the ones each CRM uses, so a page can be written once
// and read right for its service. Sources: copy/public.ts (services.*), research/kauro-baseline.md §1.2 and §3.
import type { ServiceMode } from "@web/screens.ts";

export interface ServiceWords {
  readonly name: string;
  /** One line: what the team receives, who does what, and the limit. */
  readonly line: string;
  /** The destination CRM, or null for "Clean your data". */
  readonly destination: string | null;
  /** The tool the team imports with, or null. */
  readonly importer: string | null;
  /** The object the destination calls a company. */
  readonly companies: string;
}

export const SERVICE: Readonly<Record<ServiceMode, ServiceWords>> = {
  CLEAN: {
    name: "Clean your data",
    line: "Cleaned files and a record of every change, ready for any tool you choose. No enrichment from outside sources, nothing deleted without a trace, no promise about a particular CRM.",
    destination: null,
    importer: null,
    companies: "Companies",
  },
  HUBSPOT: {
    name: "Prepare for HubSpot",
    line: "Files prepared for HubSpot's importer, with the steps and settings for your account. Your team imports them; Kauro never connects to HubSpot.",
    destination: "HubSpot",
    importer: "HubSpot's importer",
    companies: "Companies",
  },
  SALESFORCE: {
    name: "Prepare for Salesforce",
    line: "Files prepared for Salesforce Data Loader, with the steps and settings for your org. Your team imports them; Kauro never connects to Salesforce.",
    destination: "Salesforce",
    importer: "Data Loader",
    companies: "Accounts",
  },
};

export const SERVICE_ORDER: readonly ServiceMode[] = ["CLEAN", "HUBSPOT", "SALESFORCE"];
