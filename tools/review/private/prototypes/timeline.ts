// One source for every date of the review's main project (Order 11 round 2, research agency-workspace.md §1.3 C-1 and §5.3). Every page
// that names a date of this project (Projects, Overview, the health check results, the quote, the payment, the processing, the delivery,
// the import, Data and deletion, Activity, Billing) reads it from here, and every derived date is computed from the policy's own numbers,
// never typed twice: a quote valid 14 days after it is issued, files of an unpaid check kept 7 days after the check is ready and never past
// 14 days from sealing, a purchased package kept 7 days after it is ready and never past 14 days from the payment, one extension of up to
// 72 hours. The date that matters on a page is the earliest of the dates that end something (the files, the quote, the package).
import { POLICY_SNAPSHOT } from "@web/public/policy-snapshot.ts";

const DAY = 86_400_000;
const R = POLICY_SNAPSHOT.retention;
const at = (iso: string): number => Date.parse(iso);
const iso = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");
const plusDays = (from: string, days: number): string => iso(at(from) + days * DAY);
const earliest = (...dates: readonly string[]): string => dates.reduce((a, b) => (at(a) <= at(b) ? a : b));

const uploadedAt = "2026-10-20T09:14:00Z";
const sealedAt = "2026-10-20T09:58:00Z";
const checkStartedAt = "2026-10-20T10:02:00Z";
const checkReadyAt = "2026-10-20T10:58:00Z";
const planProposedAt = "2026-10-20T11:20:00Z";
const approvedAt = "2026-10-20T12:40:00Z";
const quoteIssuedAt = "2026-10-20T13:00:00Z";
const orderCreatedAt = "2026-10-20T13:10:00Z";
const paidAt = "2026-10-21T09:30:00Z";
const preparationStartedAt = "2026-10-21T10:00:00Z";
const packageReadyAt = "2026-10-21T16:20:00Z";

/** Files and results of a check not followed by a purchase: 7 days after the check, 14 days from sealing at the latest. */
const filesKeptUntil = earliest(plusDays(checkReadyAt, R.unpaidDaysFromReady), plusDays(sealedAt, R.unpaidDaysHardFromSeal));
const filesHardLimit = plusDays(sealedAt, R.unpaidDaysHardFromSeal);
/** The one extension: up to 72 hours more, never past the hard limit. */
const filesExtendedUntil = earliest(iso(at(filesKeptUntil) + 72 * 3_600_000), filesHardLimit);
const quoteExpiresAt = plusDays(quoteIssuedAt, POLICY_SNAPSHOT.quoteDays);
/** A payment order closes with whichever ends first: the quote or the files it would prepare. */
const orderClosesAt = earliest(quoteExpiresAt, filesKeptUntil);
/** The send-by date the api states on the transfer instructions (a review value, before the order closes; Kauro does not compute it). */
const sendBy = `${plusDays(orderClosesAt, -4).slice(0, 10)}T23:59:59Z`;
const packageAvailableUntil = earliest(plusDays(packageReadyAt, R.paidDaysFromFirstPackage), plusDays(paidAt, R.paidDaysHardFromCapture));
const packageHardLimit = plusDays(paidAt, R.paidDaysHardFromCapture);

export const TIMELINE = Object.freeze({
  uploadedAt,
  sealedAt,
  checkStartedAt,
  /** The check's own deadline (the api's absoluteDeadline): one hour of interpretation, then the whole check within two. */
  checkDeadline: "2026-10-20T12:02:00Z",
  checkReadyAt,
  planProposedAt,
  approvedAt,
  quoteIssuedAt,
  quoteExpiresAt,
  orderCreatedAt,
  orderClosesAt,
  sendBy,
  filesKeptUntil,
  filesExtendedUntil,
  filesHardLimit,
  paidAt,
  preparationStartedAt,
  packageReadyAt,
  packageAvailableUntil,
  packageHardLimit,
});

/** True when the quote's price outlives the files: the page must say to pay before the files go. */
export const FILES_END_FIRST = at(TIMELINE.filesKeptUntil) < at(TIMELINE.quoteExpiresAt);
