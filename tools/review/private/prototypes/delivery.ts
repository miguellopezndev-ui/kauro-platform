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
const SALESFORCE_ROWS_FOR_PACKAGE = Object.freeze({ opportunities: 1_840 });

export function packageFilesFor(mode: ServiceMode, route: IdRoute = "SALESFORCE_ID"): readonly PackageFile[] {
  const evidence: PackageFile[] = [
    file("exceptions.csv", "Values left out or left empty, each with its row", PLAN.noCompany + PLAN.emailsInvalid + 12, 38_914),
    file("manifest.json", "Every output row and the source rows it came from", null, 1_906_221),
    file("report.pdf", "What was found, decided and changed, with exact counts", null, 486_112),
  ];
  if (mode === "CLEAN") return [file(companies.name, "Companies, cleaned", companies.rows, 398_240), file(contacts.name, "Contacts, cleaned", contacts.rows, 2_101_884), ...evidence];
  if (mode === "SALESFORCE")
    return [
      file("accounts-clean.csv", "Accounts to import, stage 1, each with its source key", companies.rows, 405_118),
      ...(route === "EXTERNAL_ID"
        ? [
            file(contacts.name, "Contacts, stage 2, each naming its account by its key", contacts.rows, 2_240_512),
            file("opportunities-clean.csv", "Opportunities, stage 3, each naming its account by its key", SALESFORCE_ROWS_FOR_PACKAGE.opportunities, 512_330),
          ]
        : []),
      file("accounts-mapping.sdl", "Data Loader's field mapping for stage 1", null, 1_204),
      file("contacts-mapping.sdl", "Data Loader's field mapping for stage 2", null, 1_388),
      file("opportunities-mapping.sdl", "Data Loader's field mapping for stage 3", null, 1_296),
      file("contact-roles-mapping.sdl", "Data Loader's field mapping for stage 4", null, 642),
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

/** How a Salesforce record names its parent (owner's decision, Order 12): by an External ID field the org already has and that already
 * holds the source key (the file carries the key, Data Loader resolves it), or by the ID Salesforce gave the parent at import (Kauro reads
 * it from the parent stage's success file and writes it into a file it generates). Kauro never asks for a new field and never connects. */
export type IdRoute = "EXTERNAL_ID" | "SALESFORCE_ID";

/** The External ID field the review's Salesforce org has on Account in the external-ID state (a synthetic name, read from the org
 * metadata the team confirmed, never created for Kauro). */
export const ACCOUNT_KEY_FIELD = "Osprey_Account_Key__c";

/** One parent link of a stage: the parent's stage, the field the file writes, and where the value comes from. */
export interface ParentLink {
  readonly parent: number;
  readonly field: string;
  readonly from: string;
}

export interface Stage {
  readonly sequence: number;
  readonly name: string;
  /** The destination's own name for the object (Account, OpportunityContactRole; Companies in HubSpot). */
  readonly object: string;
  readonly file: string;
  readonly rows: number;
  /** The one setting that decides what the stage may do in the CRM. */
  readonly operation: string;
  /** The stages whose records must exist first. */
  readonly dependsOn: readonly number[];
  /** Kauro generates this stage's file from the success files of the stages it depends on (Salesforce IDs), once they are verified. */
  readonly generated: boolean;
  readonly links: readonly ParentLink[];
  /** The name the team gives the import in the CRM, so its result is found again (HubSpot's Details step); null for Data Loader. */
  readonly importName: string | null;
  readonly steps: readonly ImporterStep[];
}

const hubspotDetails = (importName: string): ImporterStep => ({
  name: "Details",
  what: `Name the import "${importName}" so its result is easy to find later, check the date and number formats against import-steps.pdf, then finish the import.`,
});

/** The review's Salesforce project also holds opportunities and their contact roles (review values, Osprey Freight's synthetic files). */
export const SALESFORCE_ROWS = Object.freeze({ accounts: companies.rows, contacts: contacts.rows, opportunities: SALESFORCE_ROWS_FOR_PACKAGE.opportunities, contactRoles: 2_310 });

/** The ID prefix Salesforce gives each standard object, which Kauro checks before writing an ID into a dependent file. */
export const ID_PREFIX: Readonly<Record<string, string>> = { Account: "001", Contact: "003", Opportunity: "006" };

function salesforceStages(route: IdRoute): readonly Stage[] {
  const external = route === "EXTERNAL_ID";
  const steps = (object: string, csv: string, map: string, operation: "Insert" | "Upsert", related: boolean): readonly ImporterStep[] => [
    operation === "Insert"
      ? { name: "Insert", what: "Open Data Loader and choose Insert. Nothing in this stage updates or deletes an existing record." }
      : {
          name: "Upsert",
          what:
            object === "Account"
              ? `Open Data Loader and choose Upsert. An account whose ${ACCOUNT_KEY_FIELD} already holds the key is updated; every other row is created.`
              : "Open Data Loader and choose Upsert. The rows carry no Salesforce ID, so every row is created.",
        },
    { name: "Log in", what: "Log in to your own org. Kauro never sees your credentials and never connects to Salesforce." },
    { name: "Select data objects", what: `Choose ${object} as the object, then choose the file.`, file: csv },
    ...(operation === "Upsert"
      ? [
          { name: "Matching", what: object === "Account" ? `Choose ${ACCOUNT_KEY_FIELD} as the field to match on.` : "Choose Id as the field to match on." },
          ...(related ? [{ name: "Related objects", what: `For Account, choose ${ACCOUNT_KEY_FIELD}: each row names its account by the key, not by an ID.` }] : []),
        ]
      : []),
    { name: "Mapping", what: "Choose an existing map and select the mapping file from the package; every column then has its field, and Kauro's source key column stays unmapped.", file: map },
    { name: "Directory", what: "Choose the folder where Data Loader saves its success and error files. Keep both: they are this stage's result." },
    { name: "Finish", what: "Finish, and wait for Data Loader to report how many rows succeeded and how many failed." },
  ];
  const fromStage = (stage: number, object: string): string => `the ${object} ID in stage ${stage}'s success file`;
  const accountLink: ParentLink = external ? { parent: 1, field: `Account, by ${ACCOUNT_KEY_FIELD}`, from: "the account's source key, already in the file" } : { parent: 1, field: "AccountId", from: fromStage(1, "Account") };
  const contactsFile = external ? contacts.name : "contacts-stage2.csv";
  const opportunitiesFile = external ? "opportunities-clean.csv" : "opportunities-stage3.csv";
  return [
    {
      sequence: 1,
      name: "Accounts",
      object: "Account",
      file: "accounts-clean.csv",
      rows: SALESFORCE_ROWS.accounts,
      operation: external ? `Upsert, matched on ${ACCOUNT_KEY_FIELD}` : "Insert",
      dependsOn: [],
      generated: false,
      links: [],
      importName: null,
      steps: steps("Account", "accounts-clean.csv", "accounts-mapping.sdl", external ? "Upsert" : "Insert", false),
    },
    {
      sequence: 2,
      name: "Contacts",
      object: "Contact",
      file: contactsFile,
      rows: SALESFORCE_ROWS.contacts,
      operation: external ? "Upsert, every row new" : "Insert",
      dependsOn: [1],
      generated: !external,
      links: [accountLink],
      importName: null,
      steps: steps("Contact", contactsFile, "contacts-mapping.sdl", external ? "Upsert" : "Insert", external),
    },
    {
      sequence: 3,
      name: "Opportunities",
      object: "Opportunity",
      file: opportunitiesFile,
      rows: SALESFORCE_ROWS.opportunities,
      operation: external ? "Upsert, every row new" : "Insert",
      dependsOn: [1],
      generated: !external,
      links: [accountLink],
      importName: null,
      steps: steps("Opportunity", opportunitiesFile, "opportunities-mapping.sdl", external ? "Upsert" : "Insert", external),
    },
    {
      sequence: 4,
      name: "Contact roles",
      object: "OpportunityContactRole",
      file: "contact-roles-stage4.csv",
      rows: SALESFORCE_ROWS.contactRoles,
      operation: "Insert",
      dependsOn: [2, 3],
      generated: true,
      links: [
        { parent: 2, field: "ContactId", from: fromStage(2, "Contact") },
        { parent: 3, field: "OpportunityId", from: fromStage(3, "Opportunity") },
      ],
      importName: null,
      steps: steps("OpportunityContactRole", "contact-roles-stage4.csv", "contact-roles-mapping.sdl", "Insert", false),
    },
  ];
}

/** The import stages of a CRM service, in order; "Clean your data" has none. HubSpot's four steps and Data Loader's own, by their names. */
export function stagesFor(mode: ServiceMode, route: IdRoute = "SALESFORCE_ID"): readonly Stage[] {
  if (mode === "CLEAN") return [];
  if (mode === "SALESFORCE") return salesforceStages(route);
  return [
    {
      sequence: 1,
      name: "Companies",
      object: "Companies",
      file: companies.name,
      rows: companies.rows,
      operation: "Create new companies only",
      dependsOn: [],
      generated: false,
      links: [],
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
      object: "Contacts",
      file: contacts.name,
      rows: contacts.rows,
      operation: "Create new contacts only",
      dependsOn: [1],
      generated: false,
      links: [],
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
      object: "Contacts and Companies",
      file: "associations.csv",
      rows: PLAN.links,
      operation: "Update existing records only",
      dependsOn: [1, 2],
      generated: false,
      links: [
        { parent: 2, field: "Email", from: "the contact's email, a value HubSpot already holds" },
        { parent: 1, field: "Company domain name", from: "the company's domain, a value HubSpot already holds" },
      ],
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

/**
 * Stage 1's result reconciled (owner's decision, Order 12): every planned row must end in exactly one proof. A row is proved when exactly one
 * success row carries its source key and a Salesforce ID of the right object; every other row is blocked with its reason and the action
 * it needs, and its dependents (contacts, opportunities) are held back instead of being written with a guessed ID. Review values: they add
 * up to the stage's planned rows (2,951 accounts), and the held-back dependents are the ones whose account is blocked.
 */
export interface Blocked {
  readonly key: "rejected-duplicate" | "rejected-validation" | "ambiguous" | "unmatched" | "duplicate-key";
  readonly reason: string;
  readonly rows: number;
  /** Salesforce's own status code from the error file, when the row is in it. */
  readonly code: string | null;
  /** What the returned files show, in plain words. */
  readonly evidence: string;
  readonly action: string;
  /** The example row the page shows (synthetic). */
  readonly example: { readonly sourceKey: string; readonly name: string };
}

export const STAGE1_BLOCKED: readonly Blocked[] = [
  {
    key: "rejected-duplicate",
    reason: "Rejected by Salesforce",
    rows: 9,
    code: "DUPLICATES_DETECTED",
    evidence: "A duplicate rule in your org matched an account it already holds.",
    action: "In Salesforce, decide for each: keep the existing account, or allow the new one. Then import the rows Kauro lists again and return the new result.",
    example: { sourceKey: "OSP-A-00418", name: "Brightwater Logistics (synthetic)" },
  },
  {
    key: "rejected-validation",
    reason: "Rejected by Salesforce",
    rows: 3,
    code: "FIELD_CUSTOM_VALIDATION_EXCEPTION",
    evidence: "A validation rule in your org refused a value.",
    action: "Correct the value the error names in the rows Kauro lists, import them again and return the new result.",
    example: { sourceKey: "OSP-A-01207", name: "Harlow & Pike (synthetic)" },
  },
  {
    key: "unmatched",
    reason: "No success or error row",
    rows: 4,
    code: null,
    evidence: "Neither file has a row with these source keys: the rows were not imported, or the files returned are not complete.",
    action: "Import the rows Kauro lists (one small file) and return both files, or return the complete files of the first import.",
    example: { sourceKey: "OSP-A-02233", name: "Cobalt Yard Supply (synthetic)" },
  },
  {
    key: "duplicate-key",
    reason: "Duplicate source key",
    rows: 2,
    code: null,
    evidence: "Two success rows carry the same source key, each with its own Account ID: the rows were imported twice.",
    action: "For each, choose which Account ID to keep; remove or merge the other one in Salesforce. Kauro then writes the one you chose.",
    example: { sourceKey: "OSP-A-00087", name: "Northgate Freightways (synthetic)" },
  },
  {
    key: "ambiguous",
    reason: "Ambiguous match",
    rows: 3,
    code: null,
    evidence: "The source key cell is empty in these success rows, and their name matches more than one account in your files.",
    action: "Return the success file exactly as Data Loader wrote it, with the source key column unchanged. Kauro never links a record by its name alone.",
    example: { sourceKey: "—", name: "Delta Marine (synthetic)" },
  },
];

const blockedRows = STAGE1_BLOCKED.reduce((sum, one) => sum + one.rows, 0);
/** The dependents of the blocked accounts, held back until each account is proved (review values). */
const HELD = Object.freeze({ contacts: 87, opportunities: 23 });

export const RECONCILED = Object.freeze({
  planned: SALESFORCE_ROWS.accounts,
  blocked: blockedRows,
  proved: SALESFORCE_ROWS.accounts - blockedRows,
  /** Records Salesforce created: every success row, the two imported twice counted twice and the three with an empty key included. */
  created: SALESFORCE_ROWS.accounts - blockedRows + 2 * 2 + 3,
  rejected: 9 + 3,
  noRow: 4,
  heldContacts: HELD.contacts,
  heldOpportunities: HELD.opportunities,
  generatedContacts: SALESFORCE_ROWS.contacts - HELD.contacts,
  generatedOpportunities: SALESFORCE_ROWS.opportunities - HELD.opportunities,
  /** The fingerprint of the success file the IDs were read from (a review value with SHA-256's shape). */
  evidence: fingerprint("stage-1-success.csv"),
});

/**
 * HubSpot's links (the owner asked whether they need the same reconciliation). HubSpot's importer links a contact to its company itself,
 * by a value both already hold (the contact's email, the company's domain name), so there is no ID for Kauro to read and write, and no
 * generated file. Kauro still checks the stage's result: the importer's error file, and the export of what the stage created. Review
 * values: links HubSpot could not make in stage 3.
 */
export const HUBSPOT_LINK_ERRORS = Object.freeze({
  rows: 14,
  notFoundCompany: 9,
  notFoundContact: 5,
});
