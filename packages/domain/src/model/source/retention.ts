/**
 * Deadline arithmetic of the source lifecycle (09 "Retention schedule"; reference/HASHING_AND_ACCOUNTING_RULES "Retention formulas":
 * UTC instants, day intervals are exact 86 400-second durations; the effective deadline is the minimum of the active deadlines;
 * retries, polling, a new quote id or a display change never move an anchor; the hard cap never extends).
 *
 * Pure functions: the caller supplies the anchor instants (committed facts) and receives instants; nothing here reads a clock.
 */
import type { UtcInstant } from "@kauro/contracts";
import { toUtcInstant } from "../../ports/clock.js";
import { instantMs } from "../fields.js";
import { SOURCE_RETENTION } from "./policy.js";

const DAY_MS = 86_400_000;

/** UploadSession.applicationExpiresAt: initiation + 24 h (09 "Upload reservation"; the hard boundary of quarantine data). */
export function uploadApplicationDeadline(initiatedAt: UtcInstant): UtcInstant {
  return toUtcInstant(instantMs(initiatedAt) + SOURCE_RETENTION.uploadReservationSeconds * 1000);
}

/** Provider-side session horizon: issuance + the lifetime the storage adapter reports (09: up to a week for Cloud Storage). */
export function providerSessionHorizon(issuedAt: UtcInstant, lifetimeSeconds: number): UtcInstant {
  if (!Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds <= 0) throw new RangeError("provider session lifetime must be a positive number of seconds");
  return toUtcInstant(instantMs(issuedAt) + lifetimeSeconds * 1000);
}

/** The effective deadline of a record: the minimum of the soft deadline (when one is set) and the hard deadline. */
export function effectiveDeadline(hard: UtcInstant, soft?: UtcInstant): UtcInstant {
  if (soft === undefined) return hard;
  return instantMs(soft) < instantMs(hard) ? soft : hard;
}

/**
 * The UNPAID retention record a seal creates (09: unpaid audit sources are available seven days after DRAFT_READY or terminal
 * failure and no later than fourteen days from sealing). At seal the ready/terminal anchor does not exist yet, so the record has
 * only its hard deadline; the audit package sets the soft deadline from its own anchor, and the effective deadline can then only
 * move earlier.
 *
 * The argument is the first seal of the BYTES (decision D-RET-3, B07-F5): for new bytes this seal, for reused bytes the earliest
 * seal that ever included any of the included files (firstSealOfBytes) — a re-seal never starts a new fourteen days (HASHING
 * "Retention formulas": extensions never revive an expired source or reset a hard clock). The database checks the same formula
 * at commit (dataset_revisions_sealed_subject).
 */
export function unpaidSealedDeadlines(firstSealOfBytes: UtcInstant): { readonly hardDeadline: UtcInstant; readonly effectiveDeadline: UtcInstant } {
  const hard = toUtcInstant(instantMs(firstSealOfBytes) + SOURCE_RETENTION.unpaidDaysHardFromSeal * DAY_MS);
  return { hardDeadline: hard, effectiveDeadline: hard };
}

/**
 * D-RET-3: the first seal of a revision's bytes — the earliest of this seal and every earlier seal that included any of its included
 * files. A seal whose bytes' hard cap is already behind it is refused (unpaidSealedDeadlines(first).hardDeadline <= this seal).
 */
export function firstSealOfBytes(thisSeal: UtcInstant, earlierSealsOfIncludedFiles: ReadonlyArray<UtcInstant>): UtcInstant {
  return earlierSealsOfIncludedFiles.reduce<UtcInstant>((min, s) => (instantMs(s) < instantMs(min) ? s : min), thisSeal);
}

/** The soft deadline an unpaid source gets from its ready or terminal anchor, never beyond the hard cap. */
export function unpaidSoftDeadline(readyOrTerminalAt: UtcInstant, hardDeadline: UtcInstant): UtcInstant {
  return effectiveDeadline(hardDeadline, toUtcInstant(instantMs(readyOrTerminalAt) + SOURCE_RETENTION.unpaidDaysFromReady * DAY_MS));
}

/**
 * Decision D-RET-1: an admitted input that is part of no sealed revision is unsealed intake data and follows the session/inspection
 * cleanup policy of its upload (HASHING "Abandoned unsealed upload data follows its independent session/inspection cleanup policy
 * rather than waiting forever for a seal"): it expires at the upload's application deadline. Sealing moves the data under the
 * sealed record (unpaidSealedDeadlines) instead.
 */
export function unsealedIntakeDeadline(applicationExpiresAt: UtcInstant): UtcInstant {
  return applicationExpiresAt;
}

export function isPast(deadline: UtcInstant, now: UtcInstant): boolean {
  return instantMs(now) >= instantMs(deadline);
}
