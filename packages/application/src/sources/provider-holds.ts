/**
 * The provider half of the seal holds, shared by the two runtimes that carry it out (B07-R1, second re-check; decisions D-HOLD-2,
 * D-HOLD-3): the seal's request handler (its own refused attempt's release, its re-assertion after the commit) and the control plane
 * (RETENTION's releases, OBJECT_INVENTORY's re-assertions).
 *
 * - A release claim (D-HOLD-3). The database records one claim per decided release, and only its claimant may carry that release out
 *   and record its answer. A provider call cannot be fenced by the database, so the claimant issues its call only while its claim
 *   holds — `claimStillHeld`, measured on its own monotonic clock from before the unit of work that took the claim, which began
 *   before the claim's server instant — and bounds the call by PROVIDER_CALL_TIMEOUT_MS; the database then waits that timeout past
 *   the claim's bound before any hold of the object is intended, so no release of an earlier claim can land on a later hold.
 * - A re-assertion (D-HOLD-2). After the seal's commit every sealed hold is re-asserted: the idempotent placement under the generation
 *   precondition, then a re-observation of the generation and its hold flag; a hold found missing on the live generation (a release
 *   that landed against every expectation) is placed again, up to HOLD_REASSERTION_ROUNDS; a generation that is not live any more is
 *   GENERATION_NOT_LIVE, which the caller records and OBJECT_INVENTORY turns into the file's revocation — never a silent success.
 */
import { HOLD_REASSERTION_ROUNDS, HOLD_RELEASE_CLAIM_SECONDS, PROVIDER_CALL_TIMEOUT_MS, type HoldReassertionResult } from "@kauro/domain";
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

/** A provider call bounded by `timeoutMs` (PROVIDER_CALL_TIMEOUT_MS by default): its answer, or why there is none. */
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

/**
 * Re-asserts the provider hold of a sealed generation (D-HOLD-2): HELD when the provider holds exactly that generation live and
 * reports it held; GENERATION_NOT_LIVE when the placement's precondition failed or the re-observation found another generation or
 * none; null when the provider did not answer or did not confirm the hold within HOLD_REASSERTION_ROUNDS (left unconfirmed:
 * OBJECT_INVENTORY re-asserts it).
 */
export async function reassertHold(storage: ObjectStoragePort, location: StorageLocation, objectName: string, generation: string, timeoutMs: number = PROVIDER_CALL_TIMEOUT_MS): Promise<HoldReassertionResult | null> {
  for (let round = 0; round < HOLD_REASSERTION_ROUNDS; round += 1) {
    const placed = await boundedProviderCall(storage.placeHold(location, objectName, generation), timeoutMs);
    if (!placed.answered) return null;
    if (placed.value.outcome === "GENERATION_NOT_LIVE") return "GENERATION_NOT_LIVE";
    const seen = await boundedProviderCall(storage.stat(location, objectName), timeoutMs);
    if (!seen.answered) return null;
    if (seen.value === null || seen.value.generation !== generation) return "GENERATION_NOT_LIVE";
    if (seen.value.temporaryHold === true) return "HELD";
    // the live generation without its hold: a release landed after the placement — placed again in the next round
  }
  return null;
}
