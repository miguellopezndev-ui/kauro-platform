// The canonical world's projects: twenty, so that each of the sixteen steps of the project path is the current step of at least one
// project, across the three services, and so that the sellers' paid, held and offset commission lines rest on real, finished projects.
// Every count is a literal; reconcile.ts re-derives each one (units from the sealed files, delivered rows from source rows less unified
// rows, unified rows from the approved groups, every date that matters from the policy), so a typo fails the check instead of reaching a
// screen. The public sample project is built from apps/web/src/public/sample-data.ts itself, never retyped.
import { MANIFEST_FILES, REPORT_ROWS, SAMPLE, SAMPLE_GROUPS, SAMPLE_SOURCES } from "../../../../../apps/web/src/public/sample-data.ts";
import { CLIENT, uid, WS } from "./people.ts";
import type { BoardStage, DuplicateResult, ImportStage, Matters, ObjectKind, OutputFile, Project, ProjectDates, Service, SourceFile, Step } from "./types.ts";

/** Project ids. The main HubSpot project keeps the web fixtures' PROJECT id (apps/web/test/support/fixtures.ts) and lib/ids.ts IDS.project. */
export const PRJ = {
  nwSpring: uid("7204"),
  fjEvents: uid("7252"),
  lkStore: uid("7242"),
  juRenewals: uid("7231"),
  nwCustomerList: uid("7203"),
  quDeals: uid("7261"),
  hoRecords: uid("7211"),
  coPartners: uid("7223"),
  nwAccounts: uid("7202"),
  rfMembers: uid("7271"),
  nwMain: uid("5fa2"),
  boCustomers: uid("7281"),
  lkCustomerList: uid("7241"),
  coQ4: uid("7222"),
  nwOpportunities: uid("7205"),
  nwTidewellContacts: uid("7207"),
  coAccounts: uid("7221"),
  fjContacts: uid("7251"),
  hoDealers: uid("7212"),
  example: uid("7e01"),
} as const;

const BOARD: Readonly<Record<Step, BoardStage>> = {
  SOURCES: "files",
  SELECTION: "files",
  SEAL: "files",
  TARGET: "check",
  CHECK: "check",
  MAPPING: "plan",
  DUPLICATES: "plan",
  RELATIONSHIPS: "plan",
  APPROVAL: "plan",
  QUOTE: "purchase",
  PAYMENT: "purchase",
  PROCESSING: "preparation",
  DELIVERY: "delivery",
  IMPORT: "delivery",
  RECEIPT: "delivery",
  RETENTION: "delivery",
};
/** The board's stage of a step (How it works's six stages). */
export const boardStage = (step: Step): BoardStage => BOARD[step];

const NO_DATES: Omit<ProjectDates, "createdAt" | "lastProgressAt"> = {
  uploadStartedAt: null,
  sealedAt: null,
  checkStartedAt: null,
  checkReadyAt: null,
  planApprovedAt: null,
  preparationStartedAt: null,
  packageReadyAt: null,
  packageDeletedAt: null,
  importTerminalAt: null,
  receiptAt: null,
  completedAt: null,
  deletedAt: null,
};
const dates = (given: Partial<ProjectDates> & Pick<ProjectDates, "createdAt" | "lastProgressAt">): ProjectDates => ({ ...NO_DATES, ...given });

const src = (name: string, object: ObjectKind, rows: number | null, selected = true): SourceFile => ({ name, object, rows, selected });
const groups = (object: ObjectKind, pairs: number, triples: number, keptApartPairs: number, keptApartTriples: number, decided: boolean, demonstrated: number | null = null): DuplicateResult => ({
  object,
  groups: { pairs, triples, keptApartPairs, keptApartTriples, demonstrated, decided },
  unifiedRows: decided ? pairs - keptApartPairs + 2 * (triples - keptApartTriples) : null,
});
const unifiedOnly = (object: ObjectKind, unifiedRows: number): DuplicateResult => ({ object, groups: null, unifiedRows });
const out = (name: string, object: ObjectKind, sourceRows: number, unifiedRows: number, rows: number): OutputFile => ({ name, object, sourceRows, unifiedRows, rows });
const stage = (order: number, object: ObjectKind, rows: number, state: ImportStage["state"], succeeded: number | null = null, failed: number | null = null, returnedAt: string | null = null): ImportStage => ({ order, object, rows, state, succeeded, failed, returnedAt });
const at = (ends: Matters["ends"], when: string): Matters => ({ ends, at: when });

interface Base {
  readonly id: string;
  readonly workspaceId: string;
  readonly clientId: string;
  readonly name: string;
  readonly service: Service;
  readonly step: Step;
  readonly dates: ProjectDates;
}
const project = (base: Base, rest: Partial<Omit<Project, keyof Base>>): Project => ({
  example: false,
  revision: 1,
  sources: [],
  units: null,
  check: null,
  mapping: null,
  duplicates: [],
  relationships: null,
  outputs: [],
  importStages: [],
  matters: null,
  ...base,
  ...rest,
});

// ---- the public sample project, from the public site's own data -------------------------------------------------------------------------

const sampleContacts = MANIFEST_FILES.find((file) => file.name === SAMPLE.contactsFile);
const sampleCompanies = MANIFEST_FILES.find((file) => file.name !== SAMPLE.contactsFile);
if (sampleContacts === undefined || sampleCompanies === undefined) throw new Error("the public sample data lost a file");
const [sampleContactsSource, sampleCompaniesSource] = SAMPLE_SOURCES;
if (sampleContactsSource === undefined || sampleCompaniesSource === undefined) throw new Error("the public sample data lost a source");

/** The contacts the public sample's report counts in duplicate candidate groups (428). */
export const SAMPLE_IN_GROUPS = REPORT_ROWS.find((row) => row.label === "sample.report.duplicates")?.count ?? -1;

const EXAMPLE_PROJECT = project(
  {
    id: PRJ.example,
    workspaceId: WS.example,
    clientId: CLIENT.exampleLarch,
    name: "Example project",
    service: "HUBSPOT",
    step: "DELIVERY",
    dates: dates({
      createdAt: "2026-10-01T09:00:00Z",
      uploadStartedAt: "2026-10-01T09:00:00Z",
      sealedAt: "2026-10-01T09:30:00Z",
      checkStartedAt: "2026-10-01T09:35:00Z",
      checkReadyAt: "2026-10-01T10:20:00Z",
      planApprovedAt: "2026-10-01T11:00:00Z",
      preparationStartedAt: "2026-10-01T11:30:00Z",
      packageReadyAt: "2026-10-01T15:00:00Z",
      lastProgressAt: "2026-10-01T15:00:00Z",
    }),
  },
  {
    example: true,
    sources: [src(sampleContactsSource, "CONTACTS", sampleContacts.source), src(sampleCompaniesSource, "COMPANIES", sampleCompanies.source)],
    units: sampleContacts.source + sampleCompanies.source,
    check: { state: "READY", deadline: "2026-10-02T09:35:00Z", failure: null },
    duplicates: [
      { object: "CONTACTS", groups: { pairs: SAMPLE_GROUPS.pairs, triples: SAMPLE_GROUPS.triples, keptApartPairs: SAMPLE_GROUPS.pairsKeptApart, keptApartTriples: 0, demonstrated: null, decided: true }, unifiedRows: sampleContacts.unified },
      unifiedOnly("COMPANIES", sampleCompanies.unified),
    ],
    outputs: [
      out(sampleContacts.name, "CONTACTS", sampleContacts.source, sampleContacts.unified, sampleContacts.rows),
      out(sampleCompanies.name, "COMPANIES", sampleCompanies.source, sampleCompanies.unified, sampleCompanies.rows),
    ],
  },
);

// ---- the projects, step by step ---------------------------------------------------------------------------------------------------------

export const PROJECTS: readonly Project[] = [
  // SOURCES: Northwind's operator is uploading; the companies file is still arriving (an unfinished upload is kept 24 hours)
  project(
    { id: PRJ.nwSpring, workspaceId: WS.northwind, clientId: CLIENT.harbor, name: "Spring contacts", service: "HUBSPOT", step: "SOURCES", dates: dates({ createdAt: "2026-10-22T13:00:00Z", uploadStartedAt: "2026-10-22T13:05:00Z", lastProgressAt: "2026-10-22T13:05:00Z" }) },
    { sources: [src("spring-contacts.csv", "CONTACTS", 8_912), src("spring-companies.csv", "COMPANIES", null)], matters: at("UPLOAD", "2026-10-23T13:05:00Z") },
  ),
  // SELECTION: Fjordline chooses the files; an old export was uploaded by mistake and its deletion is requested (pending)
  project(
    { id: PRJ.fjEvents, workspaceId: WS.fjordline, clientId: CLIENT.wexford, name: "Event leads", service: "HUBSPOT", step: "SELECTION", dates: dates({ createdAt: "2026-10-22T08:55:00Z", uploadStartedAt: "2026-10-22T09:00:00Z", lastProgressAt: "2026-10-22T10:15:00Z" }) },
    { sources: [src("event-leads-2026.xlsx", "CONTACTS", 4_388), src("event-venues.csv", "COMPANIES", 612), src("old-leads-2024.csv", "CONTACTS", 2_015, false)], matters: at("UPLOAD", "2026-10-23T09:00:00Z") },
  ),
  // SEAL: one file selected, waiting for Larkspur to seal it
  project(
    { id: PRJ.lkStore, workspaceId: WS.larkspur, clientId: CLIENT.larkspurSelf, name: "Store contacts", service: "CLEAN", step: "SEAL", dates: dates({ createdAt: "2026-10-22T09:50:00Z", uploadStartedAt: "2026-10-22T10:00:00Z", lastProgressAt: "2026-10-22T11:20:00Z" }) },
    { sources: [src("store-contacts.csv", "CONTACTS", 6_240)], matters: at("UPLOAD", "2026-10-23T10:00:00Z") },
  ),
  // TARGET: sealed; Juniper describes its Salesforce org before the check
  project(
    { id: PRJ.juRenewals, workspaceId: WS.juniper, clientId: CLIENT.bluefin, name: "Renewals", service: "SALESFORCE", step: "TARGET", dates: dates({ createdAt: "2026-10-21T13:50:00Z", uploadStartedAt: "2026-10-21T14:00:00Z", sealedAt: "2026-10-21T16:00:00Z", lastProgressAt: "2026-10-21T16:30:00Z" }) },
    { sources: [src("accounts.csv", "ACCOUNTS", 2_140), src("contacts.csv", "CONTACTS", 9_870), src("opportunities.csv", "OPPORTUNITIES", 3_315)], units: 15_325, matters: at("FILES", "2026-11-04T16:00:00Z") },
  ),
  // CHECK: the free data health check is running (results within 24 hours)
  project(
    { id: PRJ.nwCustomerList, workspaceId: WS.northwind, clientId: CLIENT.tidewell, name: "Customer list", service: "CLEAN", step: "CHECK", dates: dates({ createdAt: "2026-10-22T12:45:00Z", uploadStartedAt: "2026-10-22T12:50:00Z", sealedAt: "2026-10-22T13:20:00Z", checkStartedAt: "2026-10-22T13:30:00Z", lastProgressAt: "2026-10-22T13:30:00Z" }) },
    { sources: [src("customers.xlsx", "CONTACTS", 18_604)], units: 18_604, check: { state: "RUNNING", deadline: "2026-10-23T13:30:00Z", failure: null }, matters: at("RESULTS", "2026-10-23T13:30:00Z") },
  ),
  // MAPPING: Quillon maps its columns to HubSpot's properties
  project(
    { id: PRJ.quDeals, workspaceId: WS.quillon, clientId: CLIENT.marisol, name: "Deals cleanup", service: "HUBSPOT", step: "MAPPING", dates: dates({ createdAt: "2026-10-20T13:55:00Z", uploadStartedAt: "2026-10-20T14:00:00Z", sealedAt: "2026-10-20T14:40:00Z", checkStartedAt: "2026-10-20T14:45:00Z", checkReadyAt: "2026-10-20T16:10:00Z", lastProgressAt: "2026-10-21T15:00:00Z" }) },
    {
      sources: [src("contacts.csv", "CONTACTS", 7_450), src("companies.csv", "COMPANIES", 1_980), src("deals.csv", "DEALS", 2_610)],
      units: 12_040,
      check: { state: "READY", deadline: "2026-10-21T14:45:00Z", failure: null },
      mapping: { mapped: 31, columns: 44 },
      matters: at("FILES", "2026-10-27T16:10:00Z"),
    },
  ),
  // DUPLICATES: Halden decides its candidate groups; the 138 demonstrated groups are applied, 61 probable groups wait
  project(
    { id: PRJ.hoRecords, workspaceId: WS.halden, clientId: CLIENT.haldenSelf, name: "Customer records", service: "HUBSPOT", step: "DUPLICATES", dates: dates({ createdAt: "2026-10-20T14:55:00Z", uploadStartedAt: "2026-10-20T15:00:00Z", sealedAt: "2026-10-20T15:30:00Z", checkStartedAt: "2026-10-20T15:35:00Z", checkReadyAt: "2026-10-20T16:40:00Z", lastProgressAt: "2026-10-22T11:05:00Z" }) },
    {
      revision: 6,
      sources: [src("customers.csv", "CONTACTS", 24_310), src("dealers.csv", "COMPANIES", 1_145)],
      units: 25_455,
      check: { state: "READY", deadline: "2026-10-21T15:35:00Z", failure: null },
      mapping: { mapped: 27, columns: 27 },
      duplicates: [groups("CONTACTS", 171, 28, 3, 0, false, 138)],
      matters: at("FILES", "2026-10-27T16:40:00Z"),
    },
  ),
  // RELATIONSHIPS: Coastline links contacts to accounts for a staged Salesforce load
  project(
    { id: PRJ.coPartners, workspaceId: WS.coastline, clientId: CLIENT.atlas, name: "Partner accounts", service: "SALESFORCE", step: "RELATIONSHIPS", dates: dates({ createdAt: "2026-10-19T12:55:00Z", uploadStartedAt: "2026-10-19T13:00:00Z", sealedAt: "2026-10-19T13:45:00Z", checkStartedAt: "2026-10-19T13:50:00Z", checkReadyAt: "2026-10-19T15:20:00Z", lastProgressAt: "2026-10-22T09:40:00Z" }) },
    {
      revision: 2,
      sources: [src("accounts.csv", "ACCOUNTS", 3_860), src("contacts.csv", "CONTACTS", 14_920)],
      units: 18_780,
      check: { state: "READY", deadline: "2026-10-20T13:50:00Z", failure: null },
      mapping: { mapped: 38, columns: 38 },
      duplicates: [groups("ACCOUNTS", 44, 3, 2, 0, true), groups("CONTACTS", 310, 12, 5, 0, true)],
      relationships: { child: "CONTACTS", parent: "ACCOUNTS", linked: 13_773, unlinked: 818 },
      matters: at("FILES", "2026-10-26T15:20:00Z"),
    },
  ),
  // APPROVAL: Osprey's revision 3 waits for Samuel Osei (Approver) or Lena Ortiz (Owner)
  project(
    { id: PRJ.nwAccounts, workspaceId: WS.northwind, clientId: CLIENT.osprey, name: "Accounts and contacts", service: "SALESFORCE", step: "APPROVAL", dates: dates({ createdAt: "2026-10-19T12:55:00Z", uploadStartedAt: "2026-10-19T13:00:00Z", sealedAt: "2026-10-19T13:40:00Z", checkStartedAt: "2026-10-19T13:45:00Z", checkReadyAt: "2026-10-19T15:10:00Z", lastProgressAt: "2026-10-20T11:40:00Z" }) },
    {
      revision: 3,
      sources: [src("accounts.csv", "ACCOUNTS", 4_215), src("contacts.csv", "CONTACTS", 21_330)],
      units: 25_545,
      check: { state: "READY", deadline: "2026-10-20T13:45:00Z", failure: null },
      mapping: { mapped: 41, columns: 41 },
      duplicates: [groups("ACCOUNTS", 52, 3, 0, 0, true), groups("CONTACTS", 402, 37, 12, 0, true)],
      relationships: { child: "CONTACTS", parent: "ACCOUNTS", linked: 20_401, unlinked: 465 },
      matters: at("FILES", "2026-10-26T15:10:00Z"),
    },
  ),
  // QUOTE: issued, not ordered; Ridge & Fennel is restricted, so it cannot order until its billing details are confirmed
  project(
    { id: PRJ.rfMembers, workspaceId: WS.ridge, clientId: CLIENT.hollowPine, name: "Member list", service: "CLEAN", step: "QUOTE", dates: dates({ createdAt: "2026-10-17T09:25:00Z", uploadStartedAt: "2026-10-17T09:30:00Z", sealedAt: "2026-10-17T10:00:00Z", checkStartedAt: "2026-10-17T10:05:00Z", checkReadyAt: "2026-10-17T12:00:00Z", planApprovedAt: "2026-10-18T13:00:00Z", lastProgressAt: "2026-10-18T14:00:00Z" }) },
    {
      sources: [src("members.csv", "CONTACTS", 11_092)],
      units: 11_092,
      check: { state: "READY", deadline: "2026-10-18T10:05:00Z", failure: null },
      mapping: { mapped: 12, columns: 12 },
      duplicates: [groups("CONTACTS", 120, 6, 4, 0, true)],
      matters: at("FILES", "2026-10-24T12:00:00Z"),
    },
  ),
  // PAYMENT, waiting for the transfer: the review's main project (prototypes/timeline.ts), the public sample's files and counts
  project(
    { id: PRJ.nwMain, workspaceId: WS.northwind, clientId: CLIENT.larch, name: "Contacts and companies", service: "HUBSPOT", step: "PAYMENT", dates: dates({ createdAt: "2026-10-20T09:10:00Z", uploadStartedAt: "2026-10-20T09:14:00Z", sealedAt: "2026-10-20T09:58:00Z", checkStartedAt: "2026-10-20T10:02:00Z", checkReadyAt: "2026-10-20T10:58:00Z", planApprovedAt: "2026-10-20T12:40:00Z", lastProgressAt: "2026-10-20T13:10:00Z" }) },
    {
      revision: 4,
      sources: [src(sampleContactsSource, "CONTACTS", sampleContacts.source), src(sampleCompaniesSource, "COMPANIES", sampleCompanies.source)],
      units: sampleContacts.source + sampleCompanies.source,
      check: { state: "READY", deadline: "2026-10-20T12:02:00Z", failure: null },
      mapping: { mapped: 24, columns: 24 },
      duplicates: [groups("CONTACTS", SAMPLE_GROUPS.pairs, SAMPLE_GROUPS.triples, SAMPLE_GROUPS.pairsKeptApart, 0, true), unifiedOnly("COMPANIES", sampleCompanies.unified)],
      matters: at("FILES", "2026-10-27T10:58:00Z"),
    },
  ),
  // PAYMENT, held: Brindle & Oak proved an initiated transfer; its files are held (not paid) until the hold ends
  project(
    { id: PRJ.boCustomers, workspaceId: WS.brindle, clientId: CLIENT.brindleSelf, name: "Customer file", service: "HUBSPOT", step: "PAYMENT", dates: dates({ createdAt: "2026-10-14T14:50:00Z", uploadStartedAt: "2026-10-14T15:00:00Z", sealedAt: "2026-10-14T16:00:00Z", checkStartedAt: "2026-10-14T16:05:00Z", checkReadyAt: "2026-10-14T17:30:00Z", planApprovedAt: "2026-10-15T18:00:00Z", lastProgressAt: "2026-10-20T15:00:00Z" }) },
    {
      revision: 2,
      sources: [src("contactos.csv", "CONTACTS", 33_410), src("empresas.csv", "COMPANIES", 5_120)],
      units: 38_530,
      check: { state: "READY", deadline: "2026-10-15T16:05:00Z", failure: null },
      mapping: { mapped: 29, columns: 29 },
      duplicates: [groups("CONTACTS", 610, 22, 10, 0, true), unifiedOnly("COMPANIES", 71)],
      matters: at("HOLD", "2026-10-27T15:00:00Z"),
    },
  ),
  // PROCESSING: paid this morning; the first preparation attempt failed (lease expired), the second is running
  project(
    { id: PRJ.lkCustomerList, workspaceId: WS.larkspur, clientId: CLIENT.larkspurSelf, name: "Customer list", service: "CLEAN", step: "PROCESSING", dates: dates({ createdAt: "2026-10-21T14:55:00Z", uploadStartedAt: "2026-10-21T15:00:00Z", sealedAt: "2026-10-21T15:30:00Z", checkStartedAt: "2026-10-21T15:35:00Z", checkReadyAt: "2026-10-21T16:40:00Z", planApprovedAt: "2026-10-21T17:30:00Z", preparationStartedAt: "2026-10-22T12:45:00Z", lastProgressAt: "2026-10-22T13:12:00Z" }) },
    {
      sources: [src("customers.csv", "CONTACTS", 9_120)],
      units: 9_120,
      check: { state: "READY", deadline: "2026-10-22T15:35:00Z", failure: null },
      mapping: { mapped: 15, columns: 15 },
      duplicates: [groups("CONTACTS", 140, 9, 2, 0, true)],
    },
  ),
  // DELIVERY: Coastline's package is ready to download (7 days, never past 14 days from the payment)
  project(
    { id: PRJ.coQ4, workspaceId: WS.coastline, clientId: CLIENT.pemberton, name: "Q4 contacts", service: "HUBSPOT", step: "DELIVERY", dates: dates({ createdAt: "2026-10-18T13:55:00Z", uploadStartedAt: "2026-10-18T14:00:00Z", sealedAt: "2026-10-18T14:30:00Z", checkStartedAt: "2026-10-18T14:35:00Z", checkReadyAt: "2026-10-18T16:00:00Z", planApprovedAt: "2026-10-19T14:00:00Z", preparationStartedAt: "2026-10-20T16:10:00Z", packageReadyAt: "2026-10-21T15:00:00Z", lastProgressAt: "2026-10-21T15:00:00Z" }) },
    {
      revision: 2,
      sources: [src("contacts.csv", "CONTACTS", 22_640), src("companies.csv", "COMPANIES", 4_075)],
      units: 26_715,
      check: { state: "READY", deadline: "2026-10-19T14:35:00Z", failure: null },
      mapping: { mapped: 26, columns: 26 },
      duplicates: [groups("CONTACTS", 540, 40, 9, 0, true), unifiedOnly("COMPANIES", 96)],
      outputs: [out("contacts-hubspot.csv", "CONTACTS", 22_640, 611, 22_029), out("companies-hubspot.csv", "COMPANIES", 4_075, 96, 3_979)],
      matters: at("PACKAGE", "2026-10-28T15:00:00Z"),
    },
  ),
  // IMPORT: a staged Salesforce import; stage 1 returned in full, stage 2 waits for the team
  project(
    { id: PRJ.nwOpportunities, workspaceId: WS.northwind, clientId: CLIENT.osprey, name: "Opportunities", service: "SALESFORCE", step: "IMPORT", dates: dates({ createdAt: "2026-10-14T09:55:00Z", uploadStartedAt: "2026-10-14T10:00:00Z", sealedAt: "2026-10-14T10:30:00Z", checkStartedAt: "2026-10-14T10:35:00Z", checkReadyAt: "2026-10-14T11:40:00Z", planApprovedAt: "2026-10-15T12:30:00Z", preparationStartedAt: "2026-10-16T15:10:00Z", packageReadyAt: "2026-10-16T20:00:00Z", lastProgressAt: "2026-10-19T16:00:00Z" }) },
    {
      revision: 2,
      sources: [src("opportunities.csv", "OPPORTUNITIES", 1_840), src("contact-roles.csv", "CONTACT_ROLES", 2_310)],
      units: 4_150,
      check: { state: "READY", deadline: "2026-10-15T10:35:00Z", failure: null },
      mapping: { mapped: 19, columns: 19 },
      duplicates: [unifiedOnly("OPPORTUNITIES", 0), unifiedOnly("CONTACT_ROLES", 0)],
      outputs: [out("opportunities-salesforce.csv", "OPPORTUNITIES", 1_840, 0, 1_840), out("contact-roles-salesforce.csv", "CONTACT_ROLES", 2_310, 0, 2_310)],
      importStages: [stage(1, "OPPORTUNITIES", 1_840, "SUCCEEDED", 1_840, 0, "2026-10-19T16:00:00Z"), stage(2, "CONTACT_ROLES", 2_310, "WAITING")],
      matters: at("STAGED_PACKAGE", "2026-11-06T20:00:00Z"),
    },
  ),
  // RECEIPT: Tidewell's team imported on Oct 16; the import's result is due back within 7 days for the receipt
  project(
    { id: PRJ.nwTidewellContacts, workspaceId: WS.northwind, clientId: CLIENT.tidewell, name: "Contacts", service: "HUBSPOT", step: "RECEIPT", dates: dates({ createdAt: "2026-10-07T12:55:00Z", uploadStartedAt: "2026-10-07T13:00:00Z", sealedAt: "2026-10-07T13:30:00Z", checkStartedAt: "2026-10-07T13:35:00Z", checkReadyAt: "2026-10-07T15:00:00Z", planApprovedAt: "2026-10-08T14:00:00Z", preparationStartedAt: "2026-10-09T14:10:00Z", packageReadyAt: "2026-10-09T19:00:00Z", packageDeletedAt: "2026-10-16T19:00:00Z", importTerminalAt: "2026-10-16T21:00:00Z", lastProgressAt: "2026-10-20T10:00:00Z" }) },
    {
      sources: [src("contacts.csv", "CONTACTS", 10_350), src("companies.csv", "COMPANIES", 1_602)],
      units: 11_952,
      check: { state: "READY", deadline: "2026-10-08T13:35:00Z", failure: null },
      mapping: { mapped: 22, columns: 22 },
      duplicates: [groups("CONTACTS", 170, 9, 0, 0, true), unifiedOnly("COMPANIES", 41)],
      outputs: [out("contacts-hubspot.csv", "CONTACTS", 10_350, 188, 10_162), out("companies-hubspot.csv", "COMPANIES", 1_602, 41, 1_561)],
      importStages: [stage(1, "COMPANIES", 1_561, "WAITING"), stage(2, "CONTACTS", 10_162, "WAITING")],
      matters: at("RECEIPT", "2026-10-23T21:00:00Z"),
    },
  ),
  // RETENTION, deleted on the customer's request (receipt DR-2026-0031); a verified defect was later refunded in part
  project(
    { id: PRJ.coAccounts, workspaceId: WS.coastline, clientId: CLIENT.atlas, name: "Accounts and contacts", service: "SALESFORCE", step: "RETENTION", dates: dates({ createdAt: "2026-08-24T12:55:00Z", uploadStartedAt: "2026-08-24T13:00:00Z", sealedAt: "2026-08-24T14:00:00Z", checkStartedAt: "2026-08-24T14:05:00Z", checkReadyAt: "2026-08-24T16:00:00Z", planApprovedAt: "2026-08-25T15:00:00Z", preparationStartedAt: "2026-08-26T15:10:00Z", packageReadyAt: "2026-08-26T21:00:00Z", importTerminalAt: "2026-08-28T12:00:00Z", receiptAt: "2026-08-28T18:00:00Z", completedAt: "2026-08-28T18:00:00Z", packageDeletedAt: "2026-08-30T10:40:00Z", deletedAt: "2026-08-30T10:40:00Z", lastProgressAt: "2026-08-30T10:40:00Z" }) },
    {
      sources: [src("accounts.csv", "ACCOUNTS", 9_980), src("contacts.csv", "CONTACTS", 61_400)],
      units: 71_380,
      check: { state: "READY", deadline: "2026-08-25T14:05:00Z", failure: null },
      duplicates: [unifiedOnly("ACCOUNTS", 212), unifiedOnly("CONTACTS", 1_734)],
      outputs: [out("accounts-salesforce.csv", "ACCOUNTS", 9_980, 212, 9_768), out("contacts-salesforce.csv", "CONTACTS", 61_400, 1_734, 59_666)],
      importStages: [stage(1, "ACCOUNTS", 9_768, "SUCCEEDED", 9_768, 0, "2026-08-28T10:00:00Z"), stage(2, "CONTACTS", 59_666, "SUCCEEDED", 59_666, 0, "2026-08-28T18:00:00Z")],
    },
  ),
  // RETENTION, deleted on schedule; a defect report (case 115) is open and holds Amara Okafor's line
  project(
    { id: PRJ.fjContacts, workspaceId: WS.fjordline, clientId: CLIENT.wexford, name: "Contacts", service: "HUBSPOT", step: "RETENTION", dates: dates({ createdAt: "2026-08-31T13:55:00Z", uploadStartedAt: "2026-08-31T14:00:00Z", sealedAt: "2026-08-31T14:30:00Z", checkStartedAt: "2026-08-31T14:35:00Z", checkReadyAt: "2026-08-31T16:00:00Z", planApprovedAt: "2026-09-01T13:00:00Z", preparationStartedAt: "2026-09-02T15:10:00Z", packageReadyAt: "2026-09-03T10:00:00Z", importTerminalAt: "2026-09-08T17:00:00Z", receiptAt: "2026-09-10T09:00:00Z", completedAt: "2026-09-10T09:00:00Z", packageDeletedAt: "2026-09-10T10:00:00Z", deletedAt: "2026-09-10T10:00:00Z", lastProgressAt: "2026-09-10T10:00:00Z" }) },
    {
      sources: [src("contacts.csv", "CONTACTS", 28_700), src("companies.csv", "COMPANIES", 6_010)],
      units: 34_710,
      check: { state: "READY", deadline: "2026-09-01T14:35:00Z", failure: null },
      duplicates: [unifiedOnly("CONTACTS", 720), unifiedOnly("COMPANIES", 133)],
      outputs: [out("contacts-hubspot.csv", "CONTACTS", 28_700, 720, 27_980), out("companies-hubspot.csv", "COMPANIES", 6_010, 133, 5_877)],
      importStages: [stage(1, "COMPANIES", 5_877, "SUCCEEDED", 5_877, 0, "2026-09-10T09:00:00Z"), stage(2, "CONTACTS", 27_980, "PARTIAL", 27_601, 379, "2026-09-10T09:00:00Z")],
    },
  ),
  // RETENTION, deleted on schedule; a Colombian company (IVA 19%), partly refunded after support case 109
  project(
    { id: PRJ.hoDealers, workspaceId: WS.halden, clientId: CLIENT.haldenSelf, name: "Dealer list", service: "CLEAN", step: "RETENTION", dates: dates({ createdAt: "2026-09-24T13:55:00Z", uploadStartedAt: "2026-09-24T14:00:00Z", sealedAt: "2026-09-24T14:30:00Z", checkStartedAt: "2026-09-24T14:35:00Z", checkReadyAt: "2026-09-24T15:30:00Z", planApprovedAt: "2026-09-25T13:00:00Z", preparationStartedAt: "2026-09-26T14:10:00Z", packageReadyAt: "2026-09-26T19:00:00Z", completedAt: "2026-09-26T19:00:00Z", packageDeletedAt: "2026-10-03T19:00:00Z", deletedAt: "2026-10-03T19:00:00Z", lastProgressAt: "2026-10-03T19:00:00Z" }) },
    {
      sources: [src("dealers.csv", "COMPANIES", 3_980)],
      units: 3_980,
      check: { state: "READY", deadline: "2026-09-25T14:35:00Z", failure: null },
      duplicates: [unifiedOnly("COMPANIES", 57)],
      outputs: [out("dealers-clean.csv", "COMPANIES", 3_980, 57, 3_923)],
    },
  ),
  EXAMPLE_PROJECT,
];
