/**
 * The bound of a collaborator call a B10 command makes (D10-GAP-6, B10G-R4): PROVIDER_CALL_TIMEOUT_MS on the application's own Clock.
 * `clockProviderCallTimer` elapses once the Clock reads `ms` past the instant it started, polled on the runtime's timers; a deployment's
 * Clock is the wall clock, so it is a plain timeout there, and a fault cell that owns the Clock crosses the bound by moving it.
 */
import { PROVIDER_CALL_TIMEOUT_MS } from "@kauro/domain";
import type { Clock } from "@kauro/domain";
import type { ProviderCallTimer } from "./ports.js";

/** How often the timer reads the Clock (real milliseconds). */
const CLOCK_POLL_MS = 20;

/** The call bound of a Clock (see the file comment). */
export function clockProviderCallTimer(clock: Clock): ProviderCallTimer {
  return {
    start(ms: number) {
      const startedAt = clock.nowMs();
      let poll: ReturnType<typeof setInterval> | undefined;
      const elapsed = new Promise<void>((resolve) => {
        poll = setInterval(() => {
          if (clock.nowMs() - startedAt >= ms) {
            clearInterval(poll);
            resolve();
          }
        }, CLOCK_POLL_MS);
        poll.unref();
      });
      return { elapsed, cancel: () => clearInterval(poll) };
    },
  };
}

export type Bounded<T> = { readonly timedOut: false; readonly value: T } | { readonly timedOut: true };

/**
 * `call` within PROVIDER_CALL_TIMEOUT_MS on `clock`: its value, or `{ timedOut: true }` once the bound elapsed first. A call that fails
 * within the bound rethrows; one that fails after the bound was given up is swallowed (nobody awaits it).
 */
export async function withinCallBound<T>(clock: Clock, call: () => Promise<T>): Promise<Bounded<T>> {
  const bound = clockProviderCallTimer(clock).start(PROVIDER_CALL_TIMEOUT_MS);
  const running = call();
  running.catch(() => undefined);
  try {
    return await Promise.race([running.then((value): Bounded<T> => ({ timedOut: false, value })), bound.elapsed.then((): Bounded<T> => ({ timedOut: true }))]);
  } finally {
    bound.cancel();
  }
}
