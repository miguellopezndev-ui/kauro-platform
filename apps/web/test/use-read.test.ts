// One read of a screen (design D-STATE-1): a load that REJECTS (the api client refuses to send a request that does not fit its descriptor) is an
// ERROR state with a decision, never a LOADING that no answer will ever replace.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApiAnswer } from "../src/client/answer.ts";
import * as UseRead from "../src/screens/shared/use-read.ts";

type Settle = (load: () => Promise<ApiAnswer<never>>, signal: AbortSignal) => Promise<{ readonly kind: string; readonly decision: { readonly state: string } } | null>;
// read through the namespace so the file still compiles (and fails by assertion) on a base that has no settleRead
const settleRead = ((UseRead as Record<string, unknown>)["settleRead"] ?? (() => Promise.reject(new Error("use-read exports no settleRead")))) as Settle;

test("a read whose load rejects settles as an ERROR state, not as LOADING forever", async () => {
  const reject = (): Promise<ApiAnswer<never>> => Promise.reject(new RangeError("path parameter orderId of x is missing or malformed"));
  const state = await settleRead(reject, new AbortController().signal);
  assert.equal(state?.kind, "ERROR");
  assert.notEqual(state?.decision.state, "LOADING");
  assert.equal(state?.decision.state, "INTEGRITY_FAILURE");
  const controller = new AbortController();
  controller.abort();
  assert.equal(await settleRead(reject, controller.signal), null, "an unmounted read drops even a rejection");
  const answered = await settleRead(async () => ({ kind: "NO_ANSWER", reason: "NETWORK", status: null }) as ApiAnswer<never>, new AbortController().signal);
  assert.equal(answered?.kind, "ANSWERED");
});
