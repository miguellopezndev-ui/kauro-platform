// The bound of a collaborator call inside a unit of work (D10-GAP-6a): the database limit on the whole transaction stands one margin after
// the bound, is armed before the call starts and is lifted only when the call answered in time (an abandoned unit keeps it).
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDER_CALL_TIMEOUT_MS, isDomainFailure } from "@kauro/domain";
import { LIMIT_MARGIN_MS, withinCallBound } from "../src/commercial/call-bound.js";
import type { ProviderCallTimer } from "../src/commercial/ports.js";

function timerElapsing(): { readonly timer: ProviderCallTimer; readonly elapse: () => void } {
  let elapse: () => void = () => undefined;
  const timer: ProviderCallTimer = {
    start: () => ({
      elapsed: new Promise<void>((resolve) => {
        elapse = resolve;
      }),
      cancel: () => undefined,
    }),
  };
  return { timer, elapse: () => elapse() };
}

test("a call that answers in time: the limit is armed to the bound plus the margin before the call starts, then lifted", async () => {
  const events: string[] = [];
  const { timer } = timerElapsing();
  const bounded = await withinCallBound(
    timer,
    async () => {
      events.push("call");
      return 7;
    },
    { call: "T.call", limit: async (ms) => void events.push(`limit ${String(ms)}`), abandon: () => void events.push("abandon") },
  );
  assert.deepEqual(bounded, { timedOut: false, value: 7 });
  assert.deepEqual(events, [`limit ${PROVIDER_CALL_TIMEOUT_MS + LIMIT_MARGIN_MS}`, "call", "limit null"]);
});

test("a call that outlives its bound: the unit is abandoned and the limit stays armed, so the database ends the session at the bound plus the margin", async () => {
  const events: string[] = [];
  const { timer, elapse } = timerElapsing();
  const never = new Promise<number>(() => undefined);
  const pending = withinCallBound(timer, () => never, { call: "T.call", limit: async (ms) => void events.push(`limit ${String(ms)}`), abandon: () => void events.push("abandon") });
  await new Promise((resolve) => setImmediate(resolve));
  elapse();
  assert.deepEqual(await pending, { timedOut: true });
  assert.deepEqual(events, [`limit ${PROVIDER_CALL_TIMEOUT_MS + LIMIT_MARGIN_MS}`, "abandon"], "no lifting after an abandonment");
});

test("an in-time answer whose limit can no longer be lifted (the database ended the session after the margin) is the retriable CAPACITY_UNAVAILABLE, never an internal error", async () => {
  const { timer } = timerElapsing();
  const ended = Object.assign(new Error("terminating connection due to transaction timeout"), { code: "25P04" });
  await assert.rejects(
    withinCallBound(timer, async () => 1, { call: "T.call", limit: async (ms) => (ms === null ? Promise.reject(ended) : undefined) }),
    (e: unknown) => isDomainFailure(e) && e.code === "CAPACITY_UNAVAILABLE" && e.retryable && e.cause === ended,
  );
});
