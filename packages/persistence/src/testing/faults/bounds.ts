/** Test-only timing configuration for transactions whose lock holder the harness deliberately pauses. */
export const LOCK_WAIT_POLL_ATTEMPTS = 400;
export const LOCK_WAIT_POLL_INTERVAL_MS = 25;
export const LOCK_WAIT_OBSERVATION_MS = LOCK_WAIT_POLL_ATTEMPTS * LOCK_WAIT_POLL_INTERVAL_MS;

/**
 * One observation allowance, one for oracle round trips / runner scheduling, and one for releasing the holder and committing.
 * waitForLockWait's polling sleeps alone consume 10 s; its SQL probes add wall time. Some races observe two waits before release.
 * mustWait / observeBlocked also allow 10 s. Their evidence and rejection bounds stay unchanged; a test statement must outlive them.
 * This config is exported only through /testing. Production units keep their own defaults and explicit timeout cells override it.
 */
/**
 * The statement bound a TIMEOUT cell injects to make a waiter fail at the bound (57014): long enough that the harness observes the
 * wait under CPU load before it fires (the B10 timeout cells measured 1.5 s), far below RACE_STATEMENT_TIMEOUT_MS. A cell asserts the
 * bound fired within [INJECTED_STATEMENT_TIMEOUT_MS, INJECTED_STATEMENT_TIMEOUT_MS + LOCK_WAIT_OBSERVATION_MS).
 */
export const INJECTED_STATEMENT_TIMEOUT_MS = 1_500;

export const RACE_STATEMENT_TIMEOUT_MS = 3 * LOCK_WAIT_OBSERVATION_MS; // >= 2x every harness window: tools/test/race-timeout-bounds.test.mjs

/** Reproduction-only override: restore the old 10 s test config while delaying the holder's release. */
export function raceStatementTimeoutMs(): number {
  const value = process.env["KAURO_TEST_RACE_STATEMENT_TIMEOUT_MS"];
  if (value === undefined) return RACE_STATEMENT_TIMEOUT_MS;
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new RangeError("KAURO_TEST_RACE_STATEMENT_TIMEOUT_MS must be a positive integer");
  return ms;
}
