// The five dates that can end something in a project, kept apart everywhere they appear (owner decision of 2026-10-21, Orders 11–12,
// design only; docs/design/ORDER11-ROUND2-WORKSPACE.md "Design decisions of 2026-10-21"):
//   1. the quote's expiry (the price);
//   2. the free check's retention (the files of a check nothing was bought after);
//   3. the one voluntary extension (now also for the free check: up to 72 hours, and only then past the ordinary 14 days from sealing, to an
//      exceptional maximum of 17 days from sealing);
//   4. the pending-payment hold (proposed): a separate, transitional retention for an order whose bank transfer was really initiated and
//      is waiting to be confirmed: one per quote and per sealed set, only with proof of the initiated transfer, never renewed, never added
//      to the extension, never past a stated ceiling; preparation never starts on it;
//   5. the paid project's retention (in force: 7 days after the package is ready, never past 14 days from the payment).
// Every date is computed here from the main project's timeline and the policy's own numbers; the proposed values (17 days, five business
// days, the 24-day ceiling) are named as proposals and wait for the checks the decision asks for (F-19 to F-24).
import { POLICY_SNAPSHOT } from "@web/public/policy-snapshot.ts";
import { TIMELINE } from "./timeline.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const R = POLICY_SNAPSHOT.retention;
const at = (iso: string): number => Date.parse(iso);
const iso = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");
const earliest = (...dates: readonly string[]): string => dates.reduce((a, b) => (at(a) <= at(b) ? a : b));

/** Proposed by the owner's decision: the exceptional ceiling of a free check's files, reached only through a requested extension. */
export const EXTENDED_CEILING_DAYS = 17;
/** Proposed initial value of the pending-payment hold, to be checked against the enabled payment method and its evidence. */
export const HOLD_BUSINESS_DAYS = 5;
/** Proposed ceiling of everything an unpaid project's files can be held for, whatever happens: 24 days from sealing. */
export const UNPAID_CEILING_DAYS = 24;
/** The one soft extension (policy softExtensionMaximumSeconds 259200, one per project). */
const EXTENSION_HOURS = 72;

/** The Bogotá public holidays of the review's weeks (the same calendar the seller statements use: Nov 2 and Nov 16, 2026). */
const HOLIDAYS: ReadonlySet<string> = new Set(["2026-11-02", "2026-11-16"]);

/** n business days after an instant: Monday to Friday, skipping the holidays above (the real rule takes the payment method's calendar, F-21). */
function plusBusinessDays(from: string, days: number): string {
  let ms = at(from);
  let left = days;
  while (left > 0) {
    ms += DAY;
    const weekday = new Date(ms).getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !HOLIDAYS.has(new Date(ms).toISOString().slice(0, 10))) left -= 1;
  }
  return iso(ms);
}

const ordinaryCeiling = TIMELINE.filesHardLimit;
const extendedCeiling = iso(at(TIMELINE.sealedAt) + EXTENDED_CEILING_DAYS * DAY);
const unpaidCeiling = iso(at(TIMELINE.sealedAt) + UNPAID_CEILING_DAYS * DAY);
/** The extension asks for 72 hours from the files' current date; with it the limit is 17 days from sealing, not 14. */
const extendedUntil = earliest(iso(at(TIMELINE.filesKeptUntil) + EXTENSION_HOURS * HOUR), extendedCeiling);
const extensionRequestedAt = "2026-10-26T09:05:00Z";
/** The proof of an initiated transfer, given the day before the files would go. */
const proofAt = "2026-10-26T15:00:00Z";
const holdUntil = earliest(plusBusinessDays(proofAt, HOLD_BUSINESS_DAYS), unpaidCeiling);
/** A payment confirmed while the files were held: the paid project's retention starts from it. */
const paidWhileHeld = "2026-10-29T10:00:00Z";

export const RETENTION = Object.freeze({
  ordinaryCeiling,
  extendedCeiling,
  unpaidCeiling,
  extendedUntil,
  extensionRequestedAt,
  proofAt,
  holdUntil,
  paidWhileHeld,
  paidHardLimit: iso(at(paidWhileHeld) + R.paidDaysHardFromCapture * DAY),
});

/** The moments the review shows the five dates in. */
export type RetentionMoment = "check" | "extended" | "held" | "hold-expired" | "paid";
