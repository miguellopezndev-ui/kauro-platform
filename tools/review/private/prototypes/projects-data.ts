// The review's projects (Order 11, rebuilt in round 2), shaped as the api's project board answers them (ListProjects → ProjectDashboardItem),
// plus what the board needs that no read serves yet: the stage in words, the date that matters, the next step and who takes it. Northwind
// Data works for four clients; Halden Outdoor prepares its own data. Client names are the public site's synthetic companies; every value
// is synthetic.
//
// One rule for the date that matters (research agency-workspace.md §5.3): the earliest of the dates that end something (the files of an
// unpaid check, the quote's price, the package, an unfinished upload), labelled with what ends. The main project's dates come from
// timeline.ts; the other projects' are derived the same way, from the policy's own numbers, from one anchor each.
import type { ProjectDashboardItem } from "@web/api/generated.ts";
import { POLICY_SNAPSHOT } from "@web/public/policy-snapshot.ts";
import { formatMoney } from "@kauro/ui";
import { bandIndexOf, priceOf } from "@web/public/pricing-bands.ts";
import { QUOTE_CENTS, REPEAT_BPS } from "./money.ts";
import type { ServiceMode } from "@web/screens.ts";
import { IDS } from "../lib/ids.ts";
import { EXAMPLE } from "./example.ts";
import type { Duty } from "./people.ts";
import { TIMELINE } from "./timeline.ts";

const id = (n: number): string => `0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e7${String(n).padStart(3, "0")}`;
export const CLIENT = { larch: id(101), osprey: id(102), tidewell: id(103), harbor: id(104) } as const;

const DAY = 86_400_000;
const R = POLICY_SNAPSHOT.retention;
const plus = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString().replace(".000Z", "Z");
const days = (iso: string, n: number): string => plus(iso, n * DAY);
const earliest = (...dates: readonly string[]): string => dates.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));

/** What ends on the date that matters, in the words a row and a card use. */
export type Ending = "FILES" | "QUOTE" | "PACKAGE" | "UPLOAD" | "RESULTS" | "DELETED";
export const ENDING_LABEL: Readonly<Record<Ending, string>> = {
  FILES: "Files deleted on",
  QUOTE: "Quote expires on",
  PACKAGE: "Package deleted on",
  UPLOAD: "Upload expires on",
  RESULTS: "Results by",
  DELETED: "Files deleted on",
};

export interface Matters {
  readonly ending: Ending;
  readonly at: string;
}

export type BoardGroup = "work" | "kauro" | "completed";

export interface BoardProject {
  readonly item: ProjectDashboardItem;
  readonly name: string;
  /** The stage the project is at, 0 to 5 (How it works's six stages). */
  readonly stage: number;
  /** The next step as a verb, the page it opens, and who may take it; null when Kauro is working or the project is completed. */
  readonly next: { readonly label: string; readonly screen: string; readonly duty: Duty } | null;
  /** What Kauro is doing, when it is Kauro's turn; the way to see it. */
  readonly kauro: { readonly label: string; readonly screen: string } | null;
  readonly matters: Matters | null;
  /** Why there is no date, when there is none. */
  readonly noDate?: string;
  readonly group: BoardGroup;
}

const item = (overrides: Partial<ProjectDashboardItem> & Pick<ProjectDashboardItem, "projectId" | "clientId" | "clientLabel" | "mode" | "phase" | "requiredAction">): ProjectDashboardItem => ({
  revision: { revisionId: id(900 + Number(overrides.projectId.slice(-3))), state: "SEALED" },
  deadline: null,
  lastActivityAt: "2026-10-20T15:00:00Z",
  version: 3,
  ...overrides,
});

// the main project: its quote is issued and its payment order waits for the transfer (timeline.ts); the files go first
const mainMatters: Matters = Date.parse(TIMELINE.filesKeptUntil) <= Date.parse(TIMELINE.quoteExpiresAt) ? { ending: "FILES", at: TIMELINE.filesKeptUntil } : { ending: "QUOTE", at: TIMELINE.quoteExpiresAt };

// Osprey's accounts: checked on Oct 19; an unpaid check's files stay 7 days, never past 14 days from sealing
const ospreySealed = "2026-10-19T13:40:00Z";
const ospreyChecked = "2026-10-19T15:10:00Z";
const ospreyFiles = earliest(days(ospreyChecked, R.unpaidDaysFromReady), days(ospreySealed, R.unpaidDaysHardFromSeal));
// Tidewell's customer list: the check started this morning; a full check takes up to 24 hours (policy auditAbsoluteSeconds)
const tidewellCheckStarted = "2026-10-21T08:30:00Z";
// Harbor Mill: an unfinished upload is kept 24 hours from its start (policy uploadReservationSeconds)
const harborUploadStarted = "2026-10-21T08:05:00Z";
// Tidewell's contacts: paid Oct 20, the package ready the same afternoon; stage 1 waits for its result
const tidewellPaid = "2026-10-20T09:00:00Z";
const tidewellReady = "2026-10-20T16:00:00Z";
const tidewellPackage = earliest(days(tidewellReady, R.paidDaysFromFirstPackage), days(tidewellPaid, R.paidDaysHardFromCapture));
// Larch's newsletter list: delivered on Oct 12 and finished; its files went 7 days after the package
const larchNewsletterReady = "2026-10-12T09:30:00Z";

export const AGENCY_BOARD: readonly BoardProject[] = [
  {
    item: item({ projectId: IDS.project, clientId: CLIENT.larch, clientLabel: "Larch Studio", mode: "HUBSPOT", phase: "PURCHASE", requiredAction: "PAY_QUOTE", deadline: mainMatters.at, lastActivityAt: TIMELINE.orderCreatedAt }),
    name: "Contacts and companies",
    stage: 3,
    next: { label: "Pay the quote", screen: "UI23", duty: "pay" },
    kauro: null,
    matters: mainMatters,
    group: "work",
  },
  {
    item: item({ projectId: id(202), clientId: CLIENT.osprey, clientLabel: "Osprey Freight", mode: "SALESFORCE", phase: "PLAN", requiredAction: "APPROVE_PLAN", deadline: ospreyFiles, lastActivityAt: "2026-10-20T11:40:00Z" }),
    name: "Accounts and contacts",
    stage: 2,
    next: { label: "Approve revision 3", screen: "UI22", duty: "approve" },
    kauro: null,
    matters: { ending: "FILES", at: ospreyFiles },
    group: "work",
  },
  {
    item: item({ projectId: id(204), clientId: CLIENT.harbor, clientLabel: "Harbor Mill", mode: "HUBSPOT", phase: "SOURCES", requiredAction: "UPLOAD_SOURCES", lastActivityAt: harborUploadStarted, revision: { revisionId: id(904), state: "UPLOADING" } }),
    name: "Spring contacts",
    stage: 0,
    next: { label: "Finish the upload", screen: "UI14", duty: "operate" },
    kauro: null,
    matters: { ending: "UPLOAD", at: plus(harborUploadStarted, R.uploadReservationSeconds * 1000) },
    group: "work",
  },
  {
    item: item({ projectId: id(207), clientId: CLIENT.tidewell, clientLabel: "Tidewell", mode: "HUBSPOT", phase: "DELIVERED", requiredAction: "NONE", lastActivityAt: tidewellReady }),
    name: "Contacts",
    stage: 5,
    next: { label: "Return the stage 1 result", screen: "UI28", duty: "operate" },
    kauro: null,
    matters: { ending: "PACKAGE", at: tidewellPackage },
    group: "work",
  },
  {
    item: item({ projectId: id(203), clientId: CLIENT.tidewell, clientLabel: "Tidewell", mode: "CLEAN", phase: "HEALTH_CHECK", requiredAction: "NONE", lastActivityAt: tidewellCheckStarted, revision: { revisionId: id(903), state: "SEALED" } }),
    name: "Customer list",
    stage: 1,
    next: null,
    kauro: { label: "Kauro is checking the files", screen: "UI18" },
    matters: { ending: "RESULTS", at: plus(tidewellCheckStarted, DAY) },
    group: "kauro",
  },
  {
    item: item({ projectId: id(205), clientId: CLIENT.osprey, clientLabel: "Osprey Freight", mode: "SALESFORCE", phase: "PROCESSING", requiredAction: "NONE", lastActivityAt: "2026-10-20T15:30:00Z" }),
    name: "Opportunities",
    stage: 4,
    next: null,
    kauro: { label: "Kauro is preparing the package", screen: "UI25" },
    matters: null,
    noDate: "No date until the package is verified: we email you then",
    group: "kauro",
  },
  {
    item: item({ projectId: id(206), clientId: CLIENT.larch, clientLabel: "Larch Studio", mode: "CLEAN", phase: "DELIVERED", requiredAction: "NONE", lastActivityAt: larchNewsletterReady }),
    name: "Newsletter list",
    stage: 5,
    next: null,
    kauro: null,
    matters: { ending: "DELETED", at: days(larchNewsletterReady, R.paidDaysFromFirstPackage) },
    group: "completed",
  },
];

/** Halden Outdoor's projects: a company buying for its own data, so the client is the company itself. Its main project waits for approval. */
export const COMPANY_BOARD: readonly BoardProject[] = [
  {
    item: item({ projectId: IDS.project, clientId: id(110), clientLabel: "Halden Outdoor", mode: "HUBSPOT", phase: "PLAN", requiredAction: "APPROVE_PLAN", deadline: TIMELINE.filesKeptUntil, lastActivityAt: TIMELINE.planProposedAt }),
    name: "Customer records",
    stage: 2,
    next: { label: "Approve revision 6", screen: "UI22", duty: "approve" },
    kauro: null,
    matters: { ending: "FILES", at: TIMELINE.filesKeptUntil },
    group: "work",
  },
  {
    item: item({ projectId: id(212), clientId: id(110), clientLabel: "Halden Outdoor", mode: "CLEAN", phase: "DELIVERED", requiredAction: "NONE", lastActivityAt: "2026-09-28T10:00:00Z" }),
    name: "Dealer list",
    stage: 5,
    next: null,
    kauro: null,
    matters: { ending: "DELETED", at: days("2026-09-28T10:00:00Z", R.paidDaysFromFirstPackage) },
    group: "completed",
  },
];

/** The api's own board items, for anything that reads the read's shape. */
export const AGENCY_PROJECTS: readonly ProjectDashboardItem[] = AGENCY_BOARD.map((one) => one.item);
export const COMPANY_PROJECTS: readonly ProjectDashboardItem[] = COMPANY_BOARD.map((one) => one.item);

// ---------------------------------------------------------------- money, as Billing and Clients show it

const units = EXAMPLE.units;
/** A project's list price at the review's unit count (every review project has the example's units). */
export const listPriceOf = (mode: ServiceMode): number => priceOf(bandIndexOf(units) ?? 0, mode);
/** The repeat discount in force for a project with `prior` paid projects before it (policy repeatTiers). */
const repeatPercent = (prior: number): number => [...POLICY_SNAPSHOT.repeatTiers].reverse().find((tier) => prior >= tier.minimum)?.percent ?? 0;
export const usd = (cents: number): string => formatMoney(String(cents), "USD");
/** A quote's total for a workspace that already has paid projects: the list price less the 5% repeat discount (prototypes/money.ts). */
export const quotedPriceOf = (mode: ServiceMode): number => listPriceOf(mode) - Math.round((listPriceOf(mode) * REPEAT_BPS) / 10_000);

export type MoneyKind = "WAITING" | "QUOTE" | "PAID" | "REFUNDED";

export interface MoneyLine {
  readonly projectId: string;
  readonly kind: MoneyKind;
  readonly cents: number;
  /** The percent of repeat discount the line carries (0: none). */
  readonly discount: number;
  readonly document: string | null;
  readonly dateLabel: string;
  readonly at: string;
}

/** One paid project after another: the first at the list price, each later one with the repeat discount its place earns. */
function paidLine(projectId: string, mode: ServiceMode, prior: number, paidAt: string, invoice: string): MoneyLine {
  const percent = repeatPercent(prior);
  const list = listPriceOf(mode);
  return { projectId, kind: "PAID", cents: list - Math.round((list * percent) / 100), discount: percent, document: `Invoice ${invoice}`, dateLabel: "Paid", at: paidAt };
}

/**
 * Northwind Data's quotes and orders, as of the morning of Oct 21, 2026: the main project's order waits for the transfer (the quote and
 * payment pages draw the same order); three projects were paid before it, in order.
 */
export const AGENCY_MONEY: readonly MoneyLine[] = [
  { projectId: IDS.project, kind: "WAITING", cents: QUOTE_CENTS, discount: REPEAT_BPS / 100, document: null, dateLabel: "Send by", at: TIMELINE.sendBy },
  paidLine(id(205), "SALESFORCE", 2, "2026-10-20T14:50:00Z", "KAU-2026-000121"),
  paidLine(id(207), "HUBSPOT", 1, tidewellPaid, "KAU-2026-000117"),
  paidLine(id(206), "CLEAN", 0, "2026-10-09T15:20:00Z", "KAU-2026-000104"),
];

export const COMPANY_MONEY: readonly MoneyLine[] = [paidLine(id(212), "CLEAN", 0, "2026-09-24T11:00:00Z", "KAU-2026-000097")];

/** How many paid projects each workspace has in the last 365 days (the repeat discount's count; no read serves it yet). */
export const PAID_PROJECTS = { agency: AGENCY_MONEY.filter((line) => line.kind === "PAID").length, company: COMPANY_MONEY.filter((line) => line.kind === "PAID").length } as const;

/** The next quote's repeat discount and how far the next step of the ladder is. */
export function repeatProgress(paid: number): { readonly percent: number; readonly nextPercent: number | null; readonly toNext: number } {
  const percent = repeatPercent(paid);
  const next = POLICY_SNAPSHOT.repeatTiers.find((tier) => paid < tier.minimum && tier.percent > percent);
  return { percent, nextPercent: next?.percent ?? null, toNext: next === undefined ? 0 : next.minimum - paid };
}
