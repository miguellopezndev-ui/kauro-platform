// The delivery of the review's project (Order 11), shared by Delivery (UI26), Import steps (UI27), Import results (UI28) and Data
// lifecycle (UI29). The files are the public sample delivery's (sample-data.ts: contacts-clean.csv 12,266 rows from 12,480, companies-clean.csv
// 2,951 from 3,204) and the associations the importer guide imports third; the dates follow the review's job (queued 20 Oct 2026 14:00 UTC)
// and the vendored policy: the package stays 7 days after it is ready and goes no later than 14 days after the payment, one soft extension
// of at most 3 days never crosses that limit, and a download link works for 15 minutes. The api shapes are ImportStageView, DownloadView
// and RetentionView; these pages have no read in the web yet (VISUAL PROTOTYPE).
import { POLICY_SNAPSHOT } from "@web/public/policy-snapshot.ts";
import { MANIFEST_FILES, SAMPLE } from "@web/public/sample-data.ts";
import { PLAN } from "./plan.tsx";

const r = POLICY_SNAPSHOT.retention;
const DAY = 86_400_000;
const at = (iso: string, days: number): string => new Date(Date.parse(iso) + days * DAY).toISOString();

const contacts = MANIFEST_FILES.find((file) => file.name === SAMPLE.contactsFile);
const companies = MANIFEST_FILES.find((file) => file.name !== SAMPLE.contactsFile);
if (contacts === undefined || companies === undefined) throw new Error("the public sample data lost a file");

export const PAID_AT = "2026-10-20T13:40:00Z";
export const READY_AT = "2026-10-20T16:20:00Z";
export const SOFT_DEADLINE = at(READY_AT, r.paidDaysFromFirstPackage);
export const HARD_DEADLINE = at(PAID_AT, r.paidDaysHardFromCapture);
export const EXTENSION_DAYS = 259_200 / 86_400;
export const EXTENDED_DEADLINE = at(SOFT_DEADLINE, EXTENSION_DAYS);
export const LINK_MINUTES = r.signedDownloadSeconds / 60;
export const RECEIPT_DAYS = r.importReceiptDaysFromTerminal;
export const TARGET_DAYS = r.targetMetadataDaysFromLastUse;

export interface PackageFile {
  readonly name: string;
  readonly role: string;
  readonly rows: number | null;
  readonly bytes: number;
  readonly sha: string;
}
export const PACKAGE_FILES: readonly PackageFile[] = [
  { name: companies.name, role: "Companies to import, stage 1", rows: companies.rows, bytes: 412_806, sha: "4f1c9a2e" },
  { name: contacts.name, role: "Contacts to import, stage 2", rows: contacts.rows, bytes: 2_184_330, sha: "b72e05d1" },
  { name: "associations.csv", role: "Contact to company links, stage 3", rows: PLAN.links, bytes: 690_548, sha: "0d93be47" },
  { name: "exceptions.csv", role: "Values left out or left empty, each with its row", rows: PLAN.noCompany + PLAN.emailsInvalid + 12, bytes: 38_914, sha: "e6a4f210" },
  { name: "manifest.json", role: "Every output row and the source rows it came from", rows: null, bytes: 1_906_221, sha: "9c0b7d3a" },
  { name: "report.pdf", role: "What was found, decided and changed, with exact counts", rows: null, bytes: 486_112, sha: "71f2c8e9" },
  { name: "import-steps.pdf", role: "The steps for HubSpot, with the settings you confirmed", rows: null, bytes: 204_770, sha: "a35d6b02" },
];

export const OUTPUT = Object.freeze({
  contacts: contacts.rows,
  companies: companies.rows,
  contactsUnified: contacts.unified,
  companiesUnified: companies.unified,
  source: contacts.source + companies.source,
});

export interface Stage {
  readonly sequence: number;
  readonly name: string;
  readonly file: string;
  readonly rows: number;
  readonly operation: string;
  readonly after: string | null;
  readonly settings: readonly string[];
}
export const STAGES: readonly Stage[] = [
  {
    sequence: 1,
    name: "Companies",
    file: companies.name,
    rows: companies.rows,
    operation: "Create new companies only",
    after: null,
    settings: ["HubSpot importer: one file, one object, Companies", "Create new companies only; do not update existing ones", "Company domain name identifies each company"],
  },
  {
    sequence: 2,
    name: "Contacts",
    file: contacts.name,
    rows: contacts.rows,
    operation: "Create new contacts only",
    after: "Companies",
    settings: ["HubSpot importer: one file, one object, Contacts", "Create new contacts only; do not update existing ones", "Email identifies each contact; marketing consent is imported as given"],
  },
  {
    sequence: 3,
    name: "Links between records",
    file: "associations.csv",
    rows: PLAN.links,
    operation: "Associate only",
    after: "Companies and Contacts",
    settings: ["HubSpot importer: one file, two objects, Contacts and Companies, associate only", "Each row pairs a contact's email with its company's domain", "No record is created or changed by this stage"],
  },
];

export const bytes = (value: number): string => (value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} MB` : `${Math.round(value / 1000)} KB`);
