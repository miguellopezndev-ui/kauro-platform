// How long each kind of data stays, in the words a visitor reads (manual 09 "Retention schedule"; A3 3.5). The one statement of the windows: the
// Data handling page (UI06), the service terms and the privacy notice all take their rows from here, and the numbers come from the vendored
// policy snapshot, so a page can never state a window the policy does not hold. Pure: no environment, no file access.
import { formatCount } from "./pricing-bands.ts";
import { POLICY_SNAPSHOT } from "./policy-snapshot.ts";

export interface RetentionRow {
  /** What is kept. */
  readonly subject: string;
  /** For how long, and the hard boundary. */
  readonly rule: string;
}

const days = (value: number): string => `${formatCount(value)} ${value === 1 ? "day" : "days"}`;
const hours = (seconds: number): string => `${formatCount(seconds / 3600)} hours`;
const minutes = (seconds: number): string => `${formatCount(seconds / 60)} minutes`;

const r = POLICY_SNAPSHOT.retention;

/** The retention rows, in the order of the schedule. A "day" is an elapsed period of twenty-four hours. */
export const RETENTION_ROWS: readonly RetentionRow[] = Object.freeze([
  {
    subject: "An upload that is not completed",
    rule: `It is removed when its inspection ends or ${hours(r.uploadReservationSeconds)} after the upload started, whichever comes first.`,
  },
  {
    subject: "The files and results of a free data health check that is not followed by a purchase",
    rule: `They stay available for ${days(r.unpaidDaysFromReady)} after the check is ready or has failed, and are removed no later than ${days(r.unpaidDaysHardFromSeal)} after the files were sealed.`,
  },
  {
    subject: "The files and the delivery package of a purchased project",
    rule: `They stay available for ${days(r.paidDaysFromFirstPackage)} after the first package is ready, and are removed no later than ${days(r.paidDaysHardFromCapture)} after payment is confirmed.`,
  },
  {
    subject: "A project delivered in stages",
    rule: `Its workflow ends ${days(r.stagedDaysFromFirstRelease)} after the first stage is released and no later than ${days(r.stagedDaysHardFromCapture)} after payment is confirmed; the final delivery then stays available for at most ${days(r.stagedFinalDays)}. Each stage shows its own deadline and the date of deletion.`,
  },
  {
    subject: "Import receipt data",
    rule: `It is removed ${days(r.importReceiptDaysFromTerminal)} after its verification reaches a final state, or with the project when a staged project still needs it.`,
  },
  {
    subject: "Target settings your team confirmed",
    rule: `They are kept for up to ${days(r.targetMetadataDaysFromLastUse)} after the last confirmation or use. A saved setting is used to prepare a new delivery for ${days(r.targetExecutionFreshnessDays)} at most, and stops being used at once when the target changes in a material way.`,
  },
  {
    subject: "The limited context sent to a model provider",
    rule: "It is deleted together with the project data it came from.",
  },
  {
    subject: "Application logs",
    rule: `They are kept for ${days(r.ordinaryLogsDays)} and contain no CRM content and no secrets.`,
  },
  {
    subject: "Minimized security records",
    rule: `They are kept for ${days(r.securityLogsDays)}, and longer only under an explicit legal basis.`,
  },
  {
    subject: "Financial and legal records",
    rule: "They are kept for the period the applicable rules require and are stored apart from CRM contents.",
  },
]);

/** How long a download link works, as a phrase ("15 minutes"). */
export const DOWNLOAD_LINK_MINUTES: string = minutes(r.signedDownloadSeconds);

/** The defect claim window and the repair target of a verified Kauro defect (18 "defect claim window"). */
export const DEFECT_CLAIM_DAYS: string = days(POLICY_SNAPSHOT.support.defectReportDays);
export const DEFECT_REPAIR_BUSINESS_DAYS: string = days(POLICY_SNAPSHOT.support.defectRepairTargetBusinessDays).replace("day", "business day");

/** The reupload consequence of the schedule, stated wherever the windows are (13, 18: a later claim may need the exact source again). */
export const REUPLOAD_NOTICE =
  "Because files are removed on this schedule, a claim made after they are removed may need the exact source files to be uploaded again.";
