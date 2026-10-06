/**
 * The bound of a collaborator call a B10 command makes (D10-GAP-6, B10G-R4): PROVIDER_CALL_TIMEOUT_MS on the ProviderCallTimer the
 * command's collaborators bind (realProviderCallTimer in a deployment; a fault cell binds a timer its controlled clock drives).
 */
import { PROVIDER_CALL_TIMEOUT_MS } from "@kauro/domain";
import { realProviderCallTimer } from "./bindings.js";
import type { ProviderCallTimer } from "./ports.js";

export type Bounded<T> = { readonly timedOut: false; readonly value: T } | { readonly timedOut: true };

/**
 * `call` within PROVIDER_CALL_TIMEOUT_MS: its value, or `{ timedOut: true }` once the bound elapsed first. A call that fails within the
 * bound rethrows; one that fails after the bound was given up is swallowed (nobody awaits it).
 */
export async function withinCallBound<T>(timer: ProviderCallTimer | undefined, call: () => Promise<T>): Promise<Bounded<T>> {
  const bound = (timer ?? realProviderCallTimer).start(PROVIDER_CALL_TIMEOUT_MS);
  const running = call();
  running.catch(() => undefined);
  try {
    return await Promise.race([running.then((value): Bounded<T> => ({ timedOut: false, value })), bound.elapsed.then((): Bounded<T> => ({ timedOut: true }))]);
  } finally {
    bound.cancel();
  }
}
