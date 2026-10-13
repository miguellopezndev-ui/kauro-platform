// One read of a screen (design D-STATE-1): a load that REJECTS (the api client refuses to send a request that does not fit its descriptor) is an
// ERROR state with a decision, never a LOADING that no answer will ever replace.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as UseRead from "../src/screens/shared/use-read.ts";

type Settle = (load: (signal: AbortSignal) => Promise<never>, signal: AbortSignal) => Promise<{ readonly kind: string; readonly decision: { readonly state: string } } | null>;

test("a read whose load rejects settles as an ERROR state, not as LOADING forever", async () => {
  const settle = (UseRead as Record<string, unknown>)["settleRead"] as Settle | undefined;
  assert.equal(typeof settle, "function", "use-read exports settleRead");
  const state = await settle!(() => Promise.reject(new RangeError("path parameter orderId of x is missing or malformed")), new AbortController().signal);
  assert.equal(state?.kind, "ERROR");
  assert.notEqual(state?.decision.state, "LOADING");
  const controller = new AbortController();
  controller.abort();
  assert.equal(await settle!(() => Promise.reject(new Error("late")), controller.signal), null, "an unmounted read drops even a rejection");
});
