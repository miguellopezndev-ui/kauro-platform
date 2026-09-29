/**
 * The provider half of the seal holds, shared by the two runtimes that carry it out (B07-R1, second and third re-checks; decisions
 * D-HOLD-2..D-HOLD-4): the seal's request handler (its own refused attempt's release, its re-assertion after the commit) and the control
 * plane (RETENTION's releases, OBJECT_INVENTORY's re-assertions).
 *
 * - A release claim (D-HOLD-3). The database records one claim per decided release, and only its claimant may carry that release out
 *   and record its answer. The claimant issues its call only while its claim holds — `claimStillHeld`, measured on its own monotonic
 *   clock from before the unit of work that took the claim — and bounds it by PROVIDER_CALL_TIMEOUT_MS; the database intends no hold of
 *   the object while a claim is live or its in-flight bound has not passed. A timed-out call is not cancelled, though, and may land
 *   later still: those time bounds are defense in depth only.
 * - The incarnation fence (D-HOLD-4). The provider fences the call itself: every release names the metageneration of the hold
 *   incarnation it clears (`releaseUnderClaim`: ifGenerationMatch and ifMetagenerationMatch), and every newer hold placement increments
 *   the metageneration, so a release that lands after a newer hold was placed fails its precondition (412) and clears nothing. A 412
 *   means that incarnation is already superseded or released: the claimant re-observes, answers ABSENT or NOT_HELD, and releases again
 *   only under a metageneration it re-observed held AND recorded under its live claim first (the record proves the hold observed is no
 *   newer seal's: no hold of the object is intended while its claim is live) — never a blind retry.
 * - A re-assertion (D-HOLD-2). After the seal's commit every sealed hold is re-asserted: the idempotent placement under the generation
 *   precondition, then a re-observation of the generation and its hold flag; a hold found missing on the live generation is placed
 *   again, up to HOLD_REASSERTION_ROUNDS; a generation that is not live any more is GENERATION_NOT_LIVE, which the caller records and
 *   OBJECT_INVENTORY turns into the file's revocation — never a silent success. A HELD finding carries the metageneration observed
 *   with the hold, which the caller records (the hold's latest incarnation, D-HOLD-4).
 */
import { HOLD_REASSERTION_ROUNDS, HOLD_RELEASE_CLAIM_SECONDS, HOLD_RELEASE_ROUNDS, PROVIDER_CALL_TIMEOUT_MS, type HoldReassertionResult, type HoldReleaseAnswer } from "@kauro/domain";
import type { ObjectStoragePort, StorageLocation } from "../ports/source-providers.js";

/** A reading of the process's monotonic clock in milliseconds (never the wall clock: a claim is measured on the claimant's own clock). */
export function monotonicMs(): number {
  return performance.now();
}

/**
 * Whether the claimant of a release claim may still issue its provider call: less than HOLD_RELEASE_CLAIM_SECONDS have passed on its
 * monotonic clock since `startedMs`, read before it began the unit of work that took the claim (D-HOLD-3).
 */
export function claimStillHeld(startedMs: number, nowMs: number = monotonicMs()): boolean {
  return nowMs - startedMs < HOLD_RELEASE_CLAIM_SECONDS * 1000;
}

/** What a bounded provider call came to: its answer, or none (it failed, or did not answer within the timeout). */
export type BoundedAnswer<T> = { readonly answered: true; readonly value: T } | { readonly answered: false; readonly cause: string };

/**
 * A provider call bounded by `timeoutMs` (PROVIDER_CALL_TIMEOUT_MS by default): its answer, or why there is none. The bound ends the
 * wait, not the call: a call that did not answer in time may still take effect at the provider later (D-HOLD-4).
 */
export async function boundedProviderCall<T>(call: Promise<T>, timeoutMs: number = PROVIDER_CALL_TIMEOUT_MS): Promise<BoundedAnswer<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BoundedAnswer<T>>((resolve) => {
    timer = setTimeout(() => resolve({ answered: false, cause: "TIMEOUT" }), timeoutMs);
  });
  try {
    return await Promise.race([call.then((value): BoundedAnswer<T> => ({ answered: true, value })), timeout]);
  } catch (e) {
    return { answered: false, cause: e instanceof Error ? e.name : "PROVIDER_FAILURE" };
  } finally {
    clearTimeout(timer);
  }
}

/** The generation a release claim releases, and the hold incarnation it names (the claim's metageneration, when one was recorded). */
export interface ReleaseTarget {
  readonly location: StorageLocation;
  readonly objectName: string;
  readonly generation: string;
  /** The greatest metageneration recorded for the releasing holds (HoldReleaseDecision); absent: none recorded, observed first. */
  readonly metageneration?: string;
}

/** The claimant's side of its release claim while it carries the release out (D-HOLD-3, D-HOLD-4). */
export interface ReleaseClaim {
  /** Whether the claimant may still issue a provider call under its claim (its monotonic clock, `claimStillHeld`). */
  stillHeld(): boolean;
  /**
   * Records a re-observed metageneration under the claim (`ObjectHoldRepository.rebaseRelease`) in a unit of work of its own: true only
   * when the claim was the object's latest, unanswered and live, and the metageneration newer — the proof that the hold observed is
   * this release's to clear.
   */
  rebase(metageneration: string): Promise<boolean>;
}

/**
 * Carries out one claimed release (D-HOLD-3, D-HOLD-4), outside any transaction: the provider release of exactly the claim's
 * generation at exactly the metageneration it names, each call bounded by `timeoutMs` and issued only while the claim holds. The
 * answer to record: RELEASED (cleared under that metageneration), ABSENT (the generation is not live), NOT_HELD (the release failed its
 * precondition, 412, and the generation is live without a hold — an earlier release cleared it; this one cleared nothing). A 412 on a
 * generation still live and held means a newer metageneration than the claim names — a placement or re-assertion of the releasing holds
 * whose answer was never recorded — and only then, once the claimant recorded it under its live claim (`rebase`), is the release issued
 * again, under it; likewise when the claim names none. At most HOLD_RELEASE_ROUNDS release calls; no answer otherwise (the next claim
 * carries it on).
 */
export async function releaseUnderClaim(storage: ObjectStoragePort, target: ReleaseTarget, claim: ReleaseClaim, timeoutMs: number = PROVIDER_CALL_TIMEOUT_MS): Promise<BoundedAnswer<HoldReleaseAnswer>> {
  let metageneration = target.metageneration;
  for (let round = 0; round < HOLD_RELEASE_ROUNDS; round += 1) {
    if (metageneration !== undefined) {
      if (!claim.stillHeld()) return { answered: false, cause: "CLAIM_LAPSED" };
      const released = await boundedProviderCall(storage.releaseHold(target.location, target.objectName, target.generation, metageneration), timeoutMs);
      if (!released.answered) return released;
      if (released.value !== "PRECONDITION_FAILED") return { answered: true, value: released.value };
    }
    // the incarnation named is superseded or released (412), or none was recorded: re-observe — never a blind retry
    const seen = await boundedProviderCall(storage.stat(target.location, target.objectName), timeoutMs);
    if (!seen.answered) return seen;
    const live = seen.value;
    if (live === null || live.generation !== target.generation) return { answered: true, value: "ABSENT" };
    if (live.temporaryHold === false) return { answered: true, value: "NOT_HELD" };
    if (live.temporaryHold !== true || live.metageneration === undefined) return { answered: false, cause: "HOLD_UNREPORTED" };
    if (live.metageneration === metageneration) return { answered: false, cause: "METAGENERATION_UNCHANGED" };
    if (!claim.stillHeld()) return { answered: false, cause: "CLAIM_LAPSED" };
    if (!(await claim.rebase(live.metageneration))) return { answered: false, cause: "CLAIM_NOT_REBASED" };
    metageneration = live.metageneration;
  }
  return { answered: false, cause: "METAGENERATION_CHANGED" };
}

/** What one re-assertion of a sealed hold found (D-HOLD-2), with the metageneration observed with the hold when HELD (D-HOLD-4). */
export type HoldReassertion = { readonly result: "HELD"; readonly metageneration?: string } | { readonly result: Exclude<HoldReassertionResult, "HELD"> };

/**
 * Re-asserts the provider hold of a sealed generation (D-HOLD-2): HELD (with the metageneration the provider reported with it) when the
 * provider holds exactly that generation live and reports it held; GENERATION_NOT_LIVE when the placement's precondition failed or the
 * re-observation found another generation or none; null when the provider did not answer or did not confirm the hold within
 * HOLD_REASSERTION_ROUNDS (left unconfirmed: OBJECT_INVENTORY re-asserts it).
 */
export async function reassertHold(storage: ObjectStoragePort, location: StorageLocation, objectName: string, generation: string, timeoutMs: number = PROVIDER_CALL_TIMEOUT_MS): Promise<HoldReassertion | null> {
  for (let round = 0; round < HOLD_REASSERTION_ROUNDS; round += 1) {
    const placed = await boundedProviderCall(storage.placeHold(location, objectName, generation), timeoutMs);
    if (!placed.answered) return null;
    if (placed.value.outcome === "GENERATION_NOT_LIVE") return { result: "GENERATION_NOT_LIVE" };
    const seen = await boundedProviderCall(storage.stat(location, objectName), timeoutMs);
    if (!seen.answered) return null;
    if (seen.value === null || seen.value.generation !== generation) return { result: "GENERATION_NOT_LIVE" };
    if (seen.value.temporaryHold === true) {
      const metageneration = seen.value.metageneration ?? placed.value.metageneration;
      return { result: "HELD", metageneration };
    }
    // the live generation without its hold: a release landed after the placement — placed again in the next round
  }
  return null;
}
