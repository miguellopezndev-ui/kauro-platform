// Migration Core 3.0.0 in the canonical world (2026-10-22): the package's own file names, and the figures of the three projects the
// engine actually ran on synthetic input built from this world (Kauro.archive/Deliveries/Visual/order11/research/round3-docs-canon,
// CANON-PACKAGES.md). The engine is the truth for every package figure: these literals were read from each package's summary.json and
// tools/test/canon.test.mjs compares them with it whenever the archive is present. Other projects never ran; they use the same names.
import type { AssociationKind, EngineRun, ObjectKind, PackageFile, Service } from "./types.ts";

export const CORE_VERSION = "3.0.0" as const;

/** The adapter folder of each service under 01_IMPORT/ (and 04_DOCUMENTATION/data-view/). */
export const ADAPTER: Readonly<Record<Service, "clean-only" | "hubspot" | "salesforce">> = { CLEAN: "clean-only", HUBSPOT: "hubspot", SALESFORCE: "salesforce" };

/** The core's record object of each kind the canon names (COMPANY, CONTACT, DEAL); contact roles have none in 3.0.0. */
export const CORE_OBJECT: Readonly<Record<ObjectKind, "COMPANY" | "CONTACT" | "DEAL" | null>> = {
  CONTACTS: "CONTACT",
  COMPANIES: "COMPANY",
  ACCOUNTS: "COMPANY",
  DEALS: "DEAL",
  OPPORTUNITIES: "DEAL",
  CONTACT_ROLES: null,
};

/** Each adapter's fixed import file name per core object (contract §0): HubSpot and Clean name by object, Salesforce by Data Loader object. */
const IMPORT_NAME: Readonly<Record<Service, Readonly<Record<"COMPANY" | "CONTACT" | "DEAL", string>>>> = {
  HUBSPOT: { COMPANY: "companies.csv", CONTACT: "contacts.csv", DEAL: "deals.csv" },
  SALESFORCE: { COMPANY: "Account.csv", CONTACT: "Contact.csv", DEAL: "Opportunity.csv" },
  CLEAN: { COMPANY: "companies.csv", CONTACT: "contacts.csv", DEAL: "deals.csv" },
};

/** The import file the core writes for one object of one service, or null when 3.0.0 cannot write that object (contact roles). */
export function importPath(service: Service, object: ObjectKind): string | null {
  const core = CORE_OBJECT[object];
  return core === null ? null : `01_IMPORT/${ADAPTER[service]}/${IMPORT_NAME[service][core]}`;
}

/** The relationship import file of one kind; Clean your data writes none, and Salesforce refuses CONTACT_TO_DEAL (not an AssociationKind). */
export function associationPath(service: Service, kind: AssociationKind): string | null {
  return service === "CLEAN" ? null : `01_IMPORT/${ADAPTER[service]}/associations/${kind.toLowerCase()}.csv`;
}

/** The last part of a package path. */
export const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * Every path a 3.0.0 package can hold (manifest.json aside): the adapters' fixed import names, the fixed exception, traceability and
 * documentation files, and the data-view copies of import files. A path outside it is a name the core never writes.
 */
export const PACKAGE_PATH =
  /^(?:01_IMPORT\/(?:hubspot\/(?:contacts|companies|deals)\.csv|salesforce\/(?:Account|Contact|Lead|Opportunity)\.csv|clean-only\/(?:contacts|companies|deals|leads)\.csv|(?:hubspot|salesforce)\/associations\/(?:contact_to_company|contact_to_deal|company_to_deal)\.csv)|02_EXCEPTIONS\/(?:destination-conflicts|duplicate-candidates|formula-risk|isolated|leftovers|rejected-input|unmapped-fields|unresolved-associations)\.csv|03_TRACEABILITY\/(?:(?:associations|changes|destination-matching|flags|import-crosswalk|instance-verification|source-lineage)\.csv|(?:config\.normalized|merges|reconciliation)\.json)|04_DOCUMENTATION\/(?:audit\.md|import-instructions\.md|data-view\/(?:hubspot\/(?:contacts|companies|deals)\.csv|salesforce\/(?:Account|Contact|Lead|Opportunity)\.csv|clean-only\/(?:contacts|companies|deals|leads)\.csv|(?:hubspot|salesforce)\/associations\/[a-z_]+\.csv)))$/;

const f = (path: string, kind: PackageFile["kind"], rows: number | null): PackageFile => ({ path, kind, rows });

/** The public sample, "Example project" (…7e01): run_3b9567f72e0bba6cb9ef7b89, 24 artifacts, 15,684 source rows, 65 checks. */
export const RUN_EXAMPLE: EngineRun = {
  coreVersion: CORE_VERSION,
  runId: "run_3b9567f72e0bba6cb9ef7b89",
  manifestSha256: "150eda026057a7ea19ab671a0d0d4d9cf27373d177add49e61b611217ab055c0",
  checksPassed: 65,
  files: [
    f("01_IMPORT/hubspot/associations/contact_to_company.csv", "MACHINE_IMPORT_CSV", 11_129),
    f("01_IMPORT/hubspot/companies.csv", "MACHINE_IMPORT_CSV", 2_951),
    f("01_IMPORT/hubspot/contacts.csv", "MACHINE_IMPORT_CSV", 12_266),
    f("02_EXCEPTIONS/destination-conflicts.csv", "MACHINE_EXCEPTION_CSV", 0),
    f("02_EXCEPTIONS/duplicate-candidates.csv", "MACHINE_EXCEPTION_CSV", 14),
    f("02_EXCEPTIONS/formula-risk.csv", "HUMAN_VIEW_CSV", 11_288),
    f("02_EXCEPTIONS/isolated.csv", "MACHINE_EXCEPTION_CSV", 0),
    f("02_EXCEPTIONS/leftovers.csv", "MACHINE_EXCEPTION_CSV", 0),
    f("02_EXCEPTIONS/rejected-input.csv", "MACHINE_EXCEPTION_CSV", 0),
    f("02_EXCEPTIONS/unmapped-fields.csv", "MACHINE_EXCEPTION_CSV", 0),
    f("02_EXCEPTIONS/unresolved-associations.csv", "MACHINE_EXCEPTION_CSV", 0),
    f("03_TRACEABILITY/associations.csv", "MACHINE_EVIDENCE_CSV", 11_343),
    f("03_TRACEABILITY/changes.csv", "MACHINE_EVIDENCE_CSV", 11_688),
    f("03_TRACEABILITY/config.normalized.json", "DOCUMENT", null),
    f("03_TRACEABILITY/destination-matching.csv", "MACHINE_EVIDENCE_CSV", 0),
    f("03_TRACEABILITY/flags.csv", "MACHINE_EVIDENCE_CSV", 191),
    f("03_TRACEABILITY/import-crosswalk.csv", "MACHINE_EVIDENCE_CSV", 15_217),
    f("03_TRACEABILITY/instance-verification.csv", "MACHINE_EVIDENCE_CSV", 10),
    f("03_TRACEABILITY/merges.json", "DOCUMENT", null),
    f("03_TRACEABILITY/reconciliation.json", "DOCUMENT", null),
    f("03_TRACEABILITY/source-lineage.csv", "MACHINE_EVIDENCE_CSV", 15_684),
    f("04_DOCUMENTATION/audit.md", "DOCUMENT", null),
    f("04_DOCUMENTATION/data-view/hubspot/contacts.csv", "HUMAN_VIEW_CSV", 12_266),
    f("04_DOCUMENTATION/import-instructions.md", "DOCUMENT", null),
  ],
  reportVariant: null,
};

/** "Accounts and contacts" (…7221): run_d5ec68c7e07cb8f7c90fb377, 25 artifacts, 71,380 source rows, 65 checks; report from the variant. */
export const RUN_CO_ACCOUNTS: EngineRun = {
  coreVersion: CORE_VERSION,
  runId: "run_d5ec68c7e07cb8f7c90fb377",
  manifestSha256: "581d2ea5c8e0f1d31d08faee7c844cb4d06b1adad3901af8d21cd94fd6c2f0d2",
  checksPassed: 65,
  files: [
    f("01_IMPORT/salesforce/Account.csv", "MACHINE_IMPORT_CSV", 9_761),
    f("01_IMPORT/salesforce/Contact.csv", "MACHINE_IMPORT_CSV", 59_654),
    f("01_IMPORT/salesforce/associations/contact_to_company.csv", "MACHINE_IMPORT_CSV", 56_009),
    f("02_EXCEPTIONS/destination-conflicts.csv", "MACHINE_EXCEPTION_CSV", 0),
    f("02_EXCEPTIONS/duplicate-candidates.csv", "MACHINE_EXCEPTION_CSV", 10),
    f("02_EXCEPTIONS/formula-risk.csv", "HUMAN_VIEW_CSV", 60_404),
    f("02_EXCEPTIONS/isolated.csv", "MACHINE_EXCEPTION_CSV", 11),
    f("02_EXCEPTIONS/leftovers.csv", "MACHINE_EXCEPTION_CSV", 0),
    f("02_EXCEPTIONS/rejected-input.csv", "MACHINE_EXCEPTION_CSV", 8),
    f("02_EXCEPTIONS/unmapped-fields.csv", "MACHINE_EXCEPTION_CSV", 42_553),
    f("02_EXCEPTIONS/unresolved-associations.csv", "MACHINE_EXCEPTION_CSV", 53),
    f("03_TRACEABILITY/associations.csv", "MACHINE_EVIDENCE_CSV", 57_675),
    f("03_TRACEABILITY/changes.csv", "MACHINE_EVIDENCE_CSV", 61_707),
    f("03_TRACEABILITY/config.normalized.json", "DOCUMENT", null),
    f("03_TRACEABILITY/destination-matching.csv", "MACHINE_EVIDENCE_CSV", 0),
    f("03_TRACEABILITY/flags.csv", "MACHINE_EVIDENCE_CSV", 0),
    f("03_TRACEABILITY/import-crosswalk.csv", "MACHINE_EVIDENCE_CSV", 69_415),
    f("03_TRACEABILITY/instance-verification.csv", "MACHINE_EVIDENCE_CSV", 7),
    f("03_TRACEABILITY/merges.json", "DOCUMENT", null),
    f("03_TRACEABILITY/reconciliation.json", "DOCUMENT", null),
    f("03_TRACEABILITY/source-lineage.csv", "MACHINE_EVIDENCE_CSV", 71_380),
    f("04_DOCUMENTATION/audit.md", "DOCUMENT", null),
    f("04_DOCUMENTATION/data-view/salesforce/Account.csv", "HUMAN_VIEW_CSV", 9_761),
    f("04_DOCUMENTATION/data-view/salesforce/Contact.csv", "HUMAN_VIEW_CSV", 59_654),
    f("04_DOCUMENTATION/import-instructions.md", "DOCUMENT", null),
  ],
  reportVariant: { runId: "run_325c19a659493c1e8468f588", sourceRows: 71_372 },
};

/** "Dealer list" (…7212): run_b04e17cbf39f3809cebee937, 22 artifacts, 3,980 source rows, 60 checks; report from the variant. */
export const RUN_HO_DEALERS: EngineRun = {
  coreVersion: CORE_VERSION,
  runId: "run_b04e17cbf39f3809cebee937",
  manifestSha256: "a5bc2e830a1b0071d897928a9222ed8175d908533cb3e75761a19cca50efb81a",
  checksPassed: 60,
  files: [
    f("01_IMPORT/clean-only/companies.csv", "MACHINE_IMPORT_CSV", 3_917),
    f("02_EXCEPTIONS/destination-conflicts.csv", "MACHINE_EXCEPTION_CSV", 0),
    f("02_EXCEPTIONS/duplicate-candidates.csv", "MACHINE_EXCEPTION_CSV", 4),
    f("02_EXCEPTIONS/formula-risk.csv", "HUMAN_VIEW_CSV", 3_917),
    f("02_EXCEPTIONS/isolated.csv", "MACHINE_EXCEPTION_CSV", 4),
    f("02_EXCEPTIONS/leftovers.csv", "MACHINE_EXCEPTION_CSV", 0),
    f("02_EXCEPTIONS/rejected-input.csv", "MACHINE_EXCEPTION_CSV", 2),
    f("02_EXCEPTIONS/unmapped-fields.csv", "MACHINE_EXCEPTION_CSV", 2_649),
    f("02_EXCEPTIONS/unresolved-associations.csv", "MACHINE_EXCEPTION_CSV", 0),
    f("03_TRACEABILITY/associations.csv", "MACHINE_EVIDENCE_CSV", 0),
    f("03_TRACEABILITY/changes.csv", "MACHINE_EVIDENCE_CSV", 4_091),
    f("03_TRACEABILITY/config.normalized.json", "DOCUMENT", null),
    f("03_TRACEABILITY/destination-matching.csv", "MACHINE_EVIDENCE_CSV", 0),
    f("03_TRACEABILITY/flags.csv", "MACHINE_EVIDENCE_CSV", 3),
    f("03_TRACEABILITY/import-crosswalk.csv", "MACHINE_EVIDENCE_CSV", 3_917),
    f("03_TRACEABILITY/instance-verification.csv", "MACHINE_EVIDENCE_CSV", 0),
    f("03_TRACEABILITY/merges.json", "DOCUMENT", null),
    f("03_TRACEABILITY/reconciliation.json", "DOCUMENT", null),
    f("03_TRACEABILITY/source-lineage.csv", "MACHINE_EVIDENCE_CSV", 3_980),
    f("04_DOCUMENTATION/audit.md", "DOCUMENT", null),
    f("04_DOCUMENTATION/data-view/clean-only/companies.csv", "HUMAN_VIEW_CSV", 3_917),
    f("04_DOCUMENTATION/import-instructions.md", "DOCUMENT", null),
  ],
  reportVariant: { runId: "run_25f889238c3b90ec5ddd5973", sourceRows: 3_978 },
};

/** The archive folder of each run, under round3-docs-canon/packages/ (the test reads its summary.json when the archive is present). */
export const RUN_FOLDERS: Readonly<Record<string, { readonly main: string; readonly variant: string | null }>> = {
  [RUN_EXAMPLE.runId]: { main: "sample-hubspot-7e01", variant: null },
  [RUN_CO_ACCOUNTS.runId]: { main: "salesforce-7221-accounts-contacts", variant: "salesforce-7221-accounts-contacts-no-unreadable-rows" },
  [RUN_HO_DEALERS.runId]: { main: "clean-7212-dealer-list", variant: "clean-7212-dealer-list-no-unreadable-rows" },
};
