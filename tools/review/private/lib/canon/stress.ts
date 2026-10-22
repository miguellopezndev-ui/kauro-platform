// Stress variants of the canonical world (master plan §2.1 and question bank §6.11): small, self-contained worlds a screen or a document
// is also drawn with, to prove its layout holds. Each is a whole World (so reconcile.ts checks it exactly like the canonical one), built
// deterministically (no randomness, no clock), and separate from the canonical world so no figure of the main story moves.
import { AS_OF, earliest, HOLIDAYS, plusDays, plusHours } from "./calendar.ts";
import { OWNER, P, uid } from "./people.ts";
import type { Client, Job, Membership, Person, Project, ProjectDates, Service, SourceFile, Step, World, Workspace } from "./types.ts";

const blank = (name: string): World => ({
  name,
  asOf: AS_OF,
  timezone: "America/Bogota",
  holidays: HOLIDAYS,
  owner: OWNER,
  people: [],
  workspaces: [],
  memberships: [],
  clients: [],
  projects: [],
  quotes: [],
  orders: [],
  holds: [],
  payments: [],
  refunds: [],
  refundClaims: [],
  sellers: [],
  claims: [],
  prospects: [],
  commissionLines: [],
  retainerLines: [],
  offsets: [],
  statements: [],
  payouts: [],
  jobs: [],
  incidents: [],
  deletions: [],
  releases: [],
  supportCases: [],
});

const workspace = (id: string, name: string, kind: Workspace["kind"], createdAt: string, country = "US"): Workspace => ({
  id,
  name,
  kind,
  state: "ACTIVE",
  restriction: null,
  createdAt,
  country,
  taxRateBps: country === "CO" ? 1900 : 0,
  acquiredBySellerId: null,
  servedBySellerId: null,
  claimId: null,
});
const owner = (personId: string, workspaceId: string, since: string): Membership => ({ personId, workspaceId, role: "OWNER", state: "ACTIVE", since });

const NO_DATES = {
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
} as const;

const bare = (id: string, workspaceId: string, clientId: string, name: string, service: Service, step: Step, dates: ProjectDates, sources: readonly SourceFile[]): Project => ({
  id,
  workspaceId,
  clientId,
  name,
  service,
  step,
  example: false,
  revision: 1,
  sources,
  units: null,
  check: null,
  mapping: null,
  duplicates: [],
  relationships: null,
  outputs: [],
  associations: [],
  importStages: [],
  engine: null,
  dates,
  matters: null,
});

/** An upload started at `at`, still within its 24 hours. */
function uploading(id: string, workspaceId: string, clientId: string, name: string, service: Service, step: "SOURCES" | "SELECTION" | "SEAL", at: string, sources: readonly SourceFile[]): Project {
  return { ...bare(id, workspaceId, clientId, name, service, step, { ...NO_DATES, createdAt: at, uploadStartedAt: at, lastProgressAt: at }, sources), matters: { ends: "UPLOAD", at: plusHours(at, 24) } };
}

/** Sealed, its check running (results within 24 hours) or ready (files kept 7 days after it, never past 14 days from sealing). */
function checked(id: string, workspaceId: string, clientId: string, name: string, service: Service, uploadAt: string, sources: readonly SourceFile[], state: "RUNNING" | "READY"): Project {
  const sealedAt = plusHours(uploadAt, 1 / 6);
  const checkStartedAt = plusHours(uploadAt, 0.25);
  const checkReadyAt = state === "READY" ? plusHours(uploadAt, 0.75) : null;
  const units = sources.filter((one) => one.selected).reduce((total, one) => total + (one.rows ?? 0), 0);
  const deadline = plusHours(checkStartedAt, 24);
  return {
    ...bare(id, workspaceId, clientId, name, service, state === "READY" ? "MAPPING" : "CHECK", { ...NO_DATES, createdAt: uploadAt, uploadStartedAt: uploadAt, sealedAt, checkStartedAt, checkReadyAt, lastProgressAt: checkReadyAt ?? checkStartedAt }, sources),
    units,
    check: { state, deadline, failure: null },
    mapping: state === "READY" ? { mapped: 0, columns: 18 } : null,
    matters: checkReadyAt === null ? { ends: "RESULTS", at: deadline } : { ends: "FILES", at: earliest(plusDays(checkReadyAt, 7), plusDays(sealedAt, 14)) },
  };
}

// ---- an empty, brand-new agency -------------------------------------------------------------------------------------------------------

const EMPTY_ID = uid("9a01");
/** Ana Silva has just created her agency: one owner, no clients, no projects, no money, nothing to alert. */
export const EMPTY_AGENCY: World = {
  ...blank("Stress: an empty, brand-new agency"),
  people: [{ id: P.ana, name: "Ana Silva", email: "ana.silva@example.com" }],
  workspaces: [workspace(EMPTY_ID, "Silva Data Studio", "AGENCY", "2026-10-22T13:40:00Z")],
  memberships: [owner(P.ana, EMPTY_ID, "2026-10-22")],
};

// ---- very long names (60 characters and more) ------------------------------------------------------------------------------------------

const LONG = { ws: uid("9b01"), person: uid("9b02"), client: uid("9b03"), project: uid("9b04") } as const;
export const LONG_NAMES = Object.freeze({
  workspace: "Northwind Data and Analytics Consulting Partners International Group",
  person: "Maximiliana Alejandra de la Concepción Fernández-Villavicencio Montenegro",
  client: "The Regional Cooperative of Independent Outdoor and Garden Retailers of the North",
  project: "Quarterly consolidation of contacts, companies and partner records",
  file: "contacts-export-from-the-old-crm-before-the-migration-final-version-2-really-final.csv",
});
export const LONG_NAMES_WORLD: World = {
  ...blank("Stress: very long names"),
  people: [{ id: LONG.person, name: LONG_NAMES.person, email: "maximiliana.fernandez-villavicencio.montenegro@a-very-long-agency-domain-name.example" }],
  workspaces: [workspace(LONG.ws, LONG_NAMES.workspace, "AGENCY", "2026-10-20T09:00:00Z")],
  memberships: [owner(LONG.person, LONG.ws, "2026-10-20")],
  clients: [{ id: LONG.client, workspaceId: LONG.ws, name: LONG_NAMES.client, self: false }],
  projects: [uploading(LONG.project, LONG.ws, LONG.client, LONG_NAMES.project, "SALESFORCE", "SELECTION", "2026-10-22T08:30:00Z", [{ name: LONG_NAMES.file, object: "CONTACTS", rows: 48_213, selected: true }])],
};

// ---- Unicode: right-to-left (Arabic, Hebrew), CJK and Latin diacritics --------------------------------------------------------------

interface UnicodeCase {
  readonly key: string;
  readonly dir: "rtl" | "ltr";
  readonly script: "Arabic" | "Hebrew" | "Han" | "Japanese" | "Latin";
  readonly workspace: string;
  readonly kind: "AGENCY" | "COMPANY";
  readonly country: string;
  readonly person: string;
  readonly client: string;
  readonly project: string;
  readonly file: string;
}
export const UNICODE_CASES: readonly UnicodeCase[] = [
  { key: "ar", dir: "rtl", script: "Arabic", workspace: "شركة بيانات الشمال للاستشارات", kind: "AGENCY", country: "AE", person: "ليلى حداد", client: "مؤسسة الواحة للتجارة", project: "تنظيف جهات الاتصال", file: "جهات-الاتصال.csv" },
  { key: "he", dir: "rtl", script: "Hebrew", workspace: "נתוני הצפון בע״מ", kind: "COMPANY", country: "IL", person: "נועה לוי", client: "נתוני הצפון בע״מ", project: "רשימת לקוחות", file: "אנשי-קשר.csv" },
  { key: "zh", dir: "ltr", script: "Han", workspace: "北风数据咨询有限公司", kind: "AGENCY", country: "CN", person: "王小明", client: "上海远航物流", project: "客户联系人整理", file: "联系人.csv" },
  { key: "ja", dir: "ltr", script: "Japanese", workspace: "株式会社ノースウィンド・データ", kind: "COMPANY", country: "JP", person: "佐藤 花子", client: "株式会社ノースウィンド・データ", project: "顧客名簿の整理", file: "連絡先.csv" },
  { key: "latin", dir: "ltr", script: "Latin", workspace: "Ærøskøbing Łódź Ñandú Datos", kind: "AGENCY", country: "ES", person: "Zoë Ødegård-Łukasiewicz", client: "Café Größe & Señoría", project: "Contactos de clientes (año 2026)", file: "contactos-año-2026.csv" },
];
export const UNICODE_WORLD: World = (() => {
  const people: Person[] = [];
  const workspaces: Workspace[] = [];
  const memberships: Membership[] = [];
  const clients: Client[] = [];
  const projects: Project[] = [];
  UNICODE_CASES.forEach((one, index) => {
    const tail = (n: number): string => uid(`9c${index}${n}`);
    people.push({ id: tail(1), name: one.person, email: `person${index + 1}@unicode.example` });
    workspaces.push(workspace(tail(2), one.workspace, one.kind, "2026-10-21T10:00:00Z", one.country));
    memberships.push(owner(tail(1), tail(2), "2026-10-21"));
    clients.push({ id: tail(3), workspaceId: tail(2), name: one.client, self: one.kind === "COMPANY" });
    projects.push(uploading(tail(4), tail(2), tail(3), one.project, "CLEAN", "SOURCES", `2026-10-22T0${index + 1}:00:00Z`, [{ name: one.file, object: "CONTACTS", rows: 1_000 + index * 111, selected: true }]));
  });
  return { ...blank("Stress: Unicode and right-to-left names"), people, workspaces, memberships, clients, projects };
})();

// ---- 9-digit counts --------------------------------------------------------------------------------------------------------------------

const NINE = { ws: uid("9d01"), person: uid("9d02"), client: uid("9d03"), project: uid("9d04") } as const;
/** Half a billion source units: beyond the price ladder and the launch envelope, so no quote can exist; the counts still reconcile. */
export const NINE_DIGIT_COUNTS: World = {
  ...blank("Stress: 9-digit counts"),
  people: [{ id: NINE.person, name: "Henrik Albers", email: "henrik.albers@volume.example" }],
  workspaces: [workspace(NINE.ws, "Volume Holdings", "AGENCY", "2026-10-21T08:00:00Z")],
  memberships: [owner(NINE.person, NINE.ws, "2026-10-21")],
  clients: [{ id: NINE.client, workspaceId: NINE.ws, name: "Continental Directory Services", self: false }],
  projects: [
    {
      ...checked(NINE.project, NINE.ws, NINE.client, "National directory", "HUBSPOT", "2026-10-22T06:00:00Z", [{ name: "directory-contacts.csv", object: "CONTACTS", rows: 412_345_678, selected: true }, { name: "directory-companies.csv", object: "COMPANIES", rows: 108_765_432, selected: true }], "READY"),
      duplicates: [{ object: "CONTACTS", groups: { pairs: 12_345_678, triples: 1_234_567, keptApartPairs: 0, keptApartTriples: 0, demonstrated: 9_876_543, decided: false }, unifiedRows: null }],
    },
  ],
};

// ---- a 200-row list --------------------------------------------------------------------------------------------------------------------

const LIST = { ws: uid("9e01"), person: uid("9e02") } as const;
const LIST_CLIENTS = ["Larch Studio", "Osprey Freight", "Tidewell", "Harbor Mill", "Atlas Logistics", "Bluefin Retail", "Pemberton Dental", "Marisol Travel"] as const;
const LIST_SERVICES: readonly Service[] = ["CLEAN", "HUBSPOT", "SALESFORCE"];
const listClientId = (index: number): string => uid(`9f${String(index).padStart(2, "0")}`);
const AS_OF_MS = Date.parse(AS_OF);
const minutesBefore = (minutes: number): string => new Date(AS_OF_MS - minutes * 60_000).toISOString().replace(".000Z", "Z");

/** Two hundred projects of one agency, generated from their index alone: same names, counts and dates on every run. */
export const LIST_200: World = (() => {
  const projects: Project[] = [];
  const jobs: Job[] = [];
  for (let index = 0; index < 200; index += 1) {
    const id = uid(`a${String(index).padStart(3, "0")}`);
    const client = listClientId(index % LIST_CLIENTS.length);
    const service = LIST_SERVICES[index % LIST_SERVICES.length] ?? "CLEAN";
    const name = `Batch ${String(index + 1).padStart(3, "0")}`;
    const rows = 1_000 + ((index * 7_919) % 48_000);
    const sources: readonly SourceFile[] = [{ name: `batch-${String(index + 1).padStart(3, "0")}.csv`, object: "CONTACTS", rows, selected: true }];
    const kind = index % 5;
    const startedMinutesAgo = (index + 1) * 5 + (kind >= 3 ? 60 : 0);
    const uploadAt = minutesBefore(startedMinutesAgo);
    if (kind === 0) projects.push(uploading(id, LIST.ws, client, name, service, "SOURCES", uploadAt, sources));
    else if (kind === 1) projects.push(uploading(id, LIST.ws, client, name, service, "SELECTION", uploadAt, sources));
    else if (kind === 2) projects.push(uploading(id, LIST.ws, client, name, service, "SEAL", uploadAt, sources));
    else {
      const one = checked(id, LIST.ws, client, name, service, uploadAt, sources, kind === 3 ? "RUNNING" : "READY");
      projects.push(one);
      const started = one.dates.checkStartedAt ?? uploadAt;
      if (kind === 3) jobs.push({ id: `job-l-${String(index + 1).padStart(3, "0")}`, kind: "HEALTH_CHECK", projectId: id, state: "RUNNING", attempt: 1, queuedAt: started, startedAt: started, endedAt: null, failure: null });
    }
  }
  return {
    ...blank("Stress: a 200-row list"),
    people: [{ id: LIST.person, name: "Priya Raman", email: "priya.raman@atlasvolume.example" }],
    workspaces: [workspace(LIST.ws, "Atlas Volume Agency", "AGENCY", "2026-10-01T09:00:00Z")],
    memberships: [owner(LIST.person, LIST.ws, "2026-10-01")],
    clients: LIST_CLIENTS.map((name, index) => ({ id: listClientId(index), workspaceId: LIST.ws, name, self: false })),
    projects,
    jobs,
  };
})();

// ---- a failed run ----------------------------------------------------------------------------------------------------------------------

const FAILED = { ws: uid("9001"), person: uid("9002"), client: uid("9003"), project: uid("9004") } as const;
/** A health check that failed twice on an unreadable file: no results, the files kept to their hard limit, two failed jobs. */
export const FAILED_RUN: World = {
  ...blank("Stress: a failed run"),
  people: [{ id: FAILED.person, name: "Oskar Brandt", email: "oskar.brandt@kestrel.example" }],
  workspaces: [workspace(FAILED.ws, "Kestrel Analytics", "AGENCY", "2026-10-20T08:00:00Z")],
  memberships: [owner(FAILED.person, FAILED.ws, "2026-10-20")],
  clients: [{ id: FAILED.client, workspaceId: FAILED.ws, name: "Greystone Clinics", self: false }],
  projects: [
    {
      ...bare(FAILED.project, FAILED.ws, FAILED.client, "Patient-free contact list", "CLEAN", "CHECK", { ...NO_DATES, createdAt: "2026-10-21T09:00:00Z", uploadStartedAt: "2026-10-21T09:00:00Z", sealedAt: "2026-10-21T09:20:00Z", checkStartedAt: "2026-10-21T09:25:00Z", lastProgressAt: "2026-10-21T11:40:00Z" }, [{ name: "contacts.csv", object: "CONTACTS", rows: 52_004, selected: true }]),
      units: 52_004,
      check: { state: "FAILED", deadline: "2026-10-22T09:25:00Z", failure: "The file could not be read: row 48,213 has a quotation mark that is never closed." },
      matters: { ends: "FILES", at: "2026-11-04T09:20:00Z" },
    },
  ],
  jobs: [
    { id: "job-f-1", kind: "HEALTH_CHECK", projectId: FAILED.project, state: "FAILED", attempt: 1, queuedAt: "2026-10-21T09:25:00Z", startedAt: "2026-10-21T09:25:00Z", endedAt: "2026-10-21T10:02:00Z", failure: "Unreadable input at row 48,213" },
    { id: "job-f-2", kind: "HEALTH_CHECK", projectId: FAILED.project, state: "FAILED", attempt: 2, queuedAt: "2026-10-21T10:05:00Z", startedAt: "2026-10-21T10:05:00Z", endedAt: "2026-10-21T11:40:00Z", failure: "Unreadable input at row 48,213; not retried again" },
  ],
};

// ---- a partial run ---------------------------------------------------------------------------------------------------------------------

const PARTIAL = { ws: uid("9101"), person: uid("9102"), client: uid("9103"), project: uid("9104") } as const;
/** A HubSpot import that came back partial: 9,412 of 10,000 contacts accepted, 588 refused; the receipt says which and why. */
export const PARTIAL_RUN: World = {
  ...blank("Stress: a partial run"),
  people: [{ id: PARTIAL.person, name: "Freya Lindqvist", email: "freya.lindqvist@lindqvist.example" }],
  workspaces: [workspace(PARTIAL.ws, "Lindqvist Garden Supply", "COMPANY", "2026-10-11T09:00:00Z")],
  memberships: [owner(PARTIAL.person, PARTIAL.ws, "2026-10-11")],
  clients: [{ id: PARTIAL.client, workspaceId: PARTIAL.ws, name: "Lindqvist Garden Supply", self: true }],
  projects: [
    {
      ...bare(PARTIAL.project, PARTIAL.ws, PARTIAL.client, "Garden club members", "HUBSPOT", "RECEIPT", {
        ...NO_DATES,
        createdAt: "2026-10-12T13:55:00Z",
        uploadStartedAt: "2026-10-12T14:00:00Z",
        sealedAt: "2026-10-12T14:30:00Z",
        checkStartedAt: "2026-10-12T14:35:00Z",
        checkReadyAt: "2026-10-12T15:30:00Z",
        planApprovedAt: "2026-10-13T13:00:00Z",
        preparationStartedAt: "2026-10-14T15:10:00Z",
        packageReadyAt: "2026-10-14T20:00:00Z",
        packageDeletedAt: "2026-10-21T20:00:00Z",
        importTerminalAt: "2026-10-20T18:00:00Z",
        receiptAt: "2026-10-21T12:00:00Z",
        completedAt: "2026-10-21T12:00:00Z",
        lastProgressAt: "2026-10-21T20:00:00Z",
      }, [{ name: "members.csv", object: "CONTACTS", rows: 10_000, selected: true }]),
      units: 10_000,
      check: { state: "READY", deadline: "2026-10-13T14:35:00Z", failure: null },
      mapping: { mapped: 14, columns: 14 },
      duplicates: [{ object: "CONTACTS", groups: null, unifiedRows: 0 }],
      outputs: [{ path: "01_IMPORT/hubspot/contacts.csv", name: "contacts.csv", object: "CONTACTS", sourceRows: 10_000, unifiedRows: 0, heldBackRows: 0, unreadableRows: 0, rows: 10_000 }],
      importStages: [{ order: 1, path: "01_IMPORT/hubspot/contacts.csv", object: "CONTACTS", rows: 10_000, state: "PARTIAL", succeeded: 9_412, failed: 588, returnedAt: "2026-10-21T12:00:00Z" }],
    },
  ],
  quotes: [{ id: "q-p-1", number: "Q-2026-0126", projectId: PARTIAL.project, service: "HUBSPOT", units: 10_000, band: 0, scheduleVersion: "R2-INITIAL", listMinor: 129_500, priorPaidProjects: 0, discountPercent: 0, discountMinor: 0, serviceMinor: 129_500, taxRateBps: 0, taxMinor: 0, totalMinor: 129_500, issuedAt: "2026-10-13T13:30:00Z", expiresAt: "2026-10-27T13:30:00Z", state: "PAID", illustrative: false }],
  orders: [{ id: "ord-p-1", reference: "KAU-PO-2026-0126", quoteId: "q-p-1", projectId: PARTIAL.project, amountMinor: 129_500, createdAt: "2026-10-13T13:40:00Z", sendBy: "2026-10-15T23:59:59Z", state: "PAID" }],
  payments: [{ id: "pay-p-1", orderId: "ord-p-1", projectId: PARTIAL.project, workspaceId: PARTIAL.ws, receivedAt: "2026-10-14T15:00:00Z", amountMinor: 129_500, serviceMinor: 129_500, taxMinor: 0, invoice: "KAU-2026-000116" }],
};

/** Every stress variant, by name, for a screen's state picker and for the reconciliation test. */
export const STRESS: Readonly<Record<"emptyAgency" | "longNames" | "unicode" | "nineDigitCounts" | "list200" | "failedRun" | "partialRun", World>> = {
  emptyAgency: EMPTY_AGENCY,
  longNames: LONG_NAMES_WORLD,
  unicode: UNICODE_WORLD,
  nineDigitCounts: NINE_DIGIT_COUNTS,
  list200: LIST_200,
  failedRun: FAILED_RUN,
  partialRun: PARTIAL_RUN,
};
