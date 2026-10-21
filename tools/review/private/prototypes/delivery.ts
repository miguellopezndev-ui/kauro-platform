// The delivery of the review's project (Order 11 round 2), shared by Delivery (UI26) and the import (UI27 and UI28, one stage list). The
// files are the public sample delivery's (sample-data.ts: contacts-clean.csv 12,266 rows from 12,480, companies-clean.csv 2,951 from 3,204)
// and the links the plan keeps; every date is the project's own (timeline.ts) and every period the vendored policy's: the package stays 7
// days after it is ready and goes no later than 14 days after the payment, one extension of at most 72 hours never crosses that limit, a
// download link works for 15 minutes, a stage's returned result is kept 7 days after its check is final. The api shapes are ImportStageView,
// DownloadView and RetentionView; these pages have no read in the web yet (VISUAL PROTOTYPE).
import { POLICY_SNAPSHOT } from "@web/public/policy-snapshot.ts";
import type { ServiceMode } from "@web/screens.ts";
import { MANIFEST_FILES, SAMPLE } from "@web/public/sample-data.ts";
import { PLAN } from "./plan.tsx";
import { TIMELINE } from "./timeline.ts";

const r = POLICY_SNAPSHOT.retention;

function fileOf(contactsFile: boolean): (typeof MANIFEST_FILES)[number] {
  const found = MANIFEST_FILES.find((file) => (file.name === SAMPLE.contactsFile) === contactsFile);
  if (found === undefined) throw new Error("the public sample data lost a file");
  return found;
}
const contacts = fileOf(true);
const companies = fileOf(false);

export const READY_AT = TIMELINE.packageReadyAt;
export const AVAILABLE_UNTIL = TIMELINE.packageAvailableUntil;
export const HARD_LIMIT = TIMELINE.packageHardLimit;
export const LINK_MINUTES = r.signedDownloadSeconds / 60;
export const RECEIPT_DAYS = r.importReceiptDaysFromTerminal;
const HOUR = 3_600_000;
const later = (iso: string, hours: number): string => new Date(Date.parse(iso) + hours * HOUR).toISOString().replace(".000Z", "Z");

/** When a corrected version 2 was verified (a review value): its dates still count from the first package, as the policy says. */
export const CORRECTED_AT = later(READY_AT, 17.75);

/**
 * The import's own moments (review values after the package, before it goes): the team confirms the prerequisite, returns stage 1's result,
 * Kauro checks it, an approver continues. A returned result is kept 7 days after its check is final (importReceiptDaysFromTerminal).
 */
export const IMPORT_TIMES = Object.freeze({
  acknowledgedAt: later(READY_AT, 0.75),
  resultAt: later(READY_AT, 16.9),
  verifiedAt: later(READY_AT, 17),
  resultKeptUntil: later(READY_AT, 17 + RECEIPT_DAYS * 24),
  continuedAt: later(READY_AT, 18),
});

/** A synthetic SHA-256 shape (64 hex characters) derived from a file's name: a review value, never the hash of a real file. */
function fingerprint(name: string): string {
  let hash = 0x811c9dc5;
  let out = "";
  for (let round = 0; out.length < 64; round += 1) {
    for (const char of `${name}:${round}`) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
    out += hash.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

export interface PackageFile {
  readonly name: string;
  readonly role: string;
  readonly rows: number | null;
  readonly bytes: number;
  readonly sha: string;
}
const file = (name: string, role: string, rows: number | null, bytes: number): PackageFile => ({ name, role, rows, bytes, sha: fingerprint(name) });

/**
 * The package's files for the project's service. "Prepare for HubSpot" imports in three stages (companies, contacts, then the links);
 * "Prepare for Salesforce" in two with Data Loader (accounts, then contacts, each carrying its account's Salesforce ID from the first stage's
 * success file), with a Data Loader mapping file a stage; "Clean your data" has cleaned files and their evidence, and no import.
 */
export function packageFilesFor(mode: ServiceMode): readonly PackageFile[] {
  const evidence: PackageFile[] = [
    file("exceptions.csv", "Values left out or left empty, each with its row", PLAN.noCompany + PLAN.emailsInvalid + 12, 38_914),
    file("manifest.json", "Every output row and the source rows it came from", null, 1_906_221),
    file("report.pdf", "What was found, decided and changed, with exact counts", null, 486_112),
  ];
  if (mode === "CLEAN") return [file(companies.name, "Companies, cleaned", companies.rows, 398_240), file(contacts.name, "Contacts, cleaned", contacts.rows, 2_101_884), ...evidence];
  if (mode === "SALESFORCE")
    return [
      file("accounts-clean.csv", "Accounts to import, stage 1", companies.rows, 405_118),
      file("accounts-mapping.sdl", "Data Loader's field mapping for stage 1", null, 1_204),
      file("contacts-mapping.sdl", "Data Loader's field mapping for stage 2", null, 1_388),
      ...evidence,
      file("import-steps.pdf", "The steps for Data Loader, with the settings you confirmed", null, 198_406),
    ];
  return [
    file(companies.name, "Companies to import, stage 1", companies.rows, 412_806),
    file(contacts.name, "Contacts to import, stage 2", contacts.rows, 2_184_330),
    file("associations.csv", "Contact to company links, stage 3", PLAN.links, 690_548),
    ...evidence,
    file("import-steps.pdf", "The steps for HubSpot, with the settings you confirmed", null, 204_770),
  ];
}

export const OUTPUT = Object.freeze({
  contacts: contacts.rows,
  companies: companies.rows,
  contactsUnified: contacts.unified,
  companiesUnified: companies.unified,
  source: contacts.source + companies.source,
});

/** One step of the destination's own importer, in its own words: what to choose there, and which of Kauro's files goes in. */
export interface ImporterStep {
  readonly name: string;
  readonly what: string;
  /** The package's file this step takes, when it takes one. */
  readonly file?: string;
}

export interface Stage {
  readonly sequence: number;
  readonly name: string;
  readonly file: string;
  readonly rows: number;
  /** The one setting that decides what the stage may do in the CRM. */
  readonly operation: string;
  readonly after: string | null;
  /** The file is released by Kauro once the stage before is verified (it carries IDs the CRM gave in that stage). */
  readonly releasedAfter: boolean;
  /** The name the team gives the import in the CRM, so its result is found again (HubSpot's Details step); null for Data Loader. */
  readonly importName: string | null;
  readonly steps: readonly ImporterStep[];
}

const hubspotDetails = (importName: string): ImporterStep => ({
  name: "Details",
  what: `Name the import "${importName}" so its result is easy to find later, check the date and number formats against import-steps.pdf, then finish the import.`,
});

/** The import stages of a CRM service, in order; "Clean your data" has none. HubSpot's four steps and Data Loader's own, by their names. */
export function stagesFor(mode: ServiceMode): readonly Stage[] {
  if (mode === "CLEAN") return [];
  if (mode === "SALESFORCE") {
    const loader = (object: string, csv: string, map: string): readonly ImporterStep[] => [
      { name: "Insert", what: "Open Data Loader and choose Insert. Nothing in this stage updates or deletes an existing record." },
      { name: "Log in", what: "Log in to your own org. Kauro never sees your credentials and never connects to Salesforce." },
      { name: "Select data objects", what: `Choose ${object} as the object, then choose the file.`, file: csv },
      { name: "Mapping", what: "Choose an existing map and select the mapping file from the package; every column then has its field.", file: map },
      { name: "Directory", what: "Choose the folder where Data Loader saves its success and error files. Keep both: they are this stage's result." },
      { name: "Finish", what: "Finish, and wait for Data Loader to report how many rows succeeded and how many failed." },
    ];
    return [
      { sequence: 1, name: "Accounts", file: "accounts-clean.csv", rows: companies.rows, operation: "Insert", after: null, releasedAfter: false, importName: null, steps: loader("Account", "accounts-clean.csv", "accounts-mapping.sdl") },
      { sequence: 2, name: "Contacts", file: contacts.name, rows: contacts.rows, operation: "Insert", after: "Accounts", releasedAfter: true, importName: null, steps: loader("Contact", contacts.name, "contacts-mapping.sdl") },
    ];
  }
  return [
    {
      sequence: 1,
      name: "Companies",
      file: companies.name,
      rows: companies.rows,
      operation: "Create new companies only",
      after: null,
      releasedAfter: false,
      importName: "Kauro stage 1 Companies",
      steps: [
        { name: "Type", what: "Choose to import one file with one object, and choose Companies." },
        { name: "Upload", what: "Upload the file. Where HubSpot asks whether to create or update records, choose to create new companies only.", file: companies.name },
        { name: "Map", what: "Each column already carries HubSpot's property name: confirm each match. Company domain name identifies each company." },
        hubspotDetails("Kauro stage 1 Companies"),
      ],
    },
    {
      sequence: 2,
      name: "Contacts",
      file: contacts.name,
      rows: contacts.rows,
      operation: "Create new contacts only",
      after: "Companies",
      releasedAfter: false,
      importName: "Kauro stage 2 Contacts",
      steps: [
        { name: "Type", what: "Choose to import one file with one object, and choose Contacts." },
        { name: "Upload", what: "Upload the file. Where HubSpot asks whether to create or update records, choose to create new contacts only.", file: contacts.name },
        { name: "Map", what: "Confirm each column's property. Email identifies each contact; marketing consent is imported exactly as your files give it." },
        { name: "Details", what: 'Name the import "Kauro stage 2 Contacts" so its result is easy to find later. Answer HubSpot\'s consent question for your own contacts (Kauro cannot answer it), leave the marketing contact setting as your team confirmed it, then finish the import.' },
      ],
    },
    {
      sequence: 3,
      name: "Links between records",
      file: "associations.csv",
      rows: PLAN.links,
      operation: "Update existing records only",
      after: "Companies and Contacts",
      releasedAfter: false,
      importName: "Kauro stage 3 Links",
      steps: [
        { name: "Type", what: "Choose to import one file with two objects, and choose Contacts and Companies, so each row links a contact to its company." },
        { name: "Upload", what: "Upload the file. Choose to update existing records only, for both objects: this stage creates nothing.", file: "associations.csv" },
        { name: "Map", what: "Email goes to the contact, Company domain name to the company. No other column is imported." },
        hubspotDetails("Kauro stage 3 Links"),
      ],
    },
  ];
}

export const bytes = (value: number): string => (value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} MB` : value >= 1000 ? `${Math.round(value / 1000)} KB` : `${value} bytes`);
