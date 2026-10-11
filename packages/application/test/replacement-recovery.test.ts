// CMD027 identity recovery (D10-GAP-6a, Codex F1): a refusal is never answered before the replacement's identity is observed, and the
// completion derives its outcome from the durable facts under the quote's lock. Each hunk has its own test.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { UtcInstant } from "@kauro/contracts";
import { concludeReplacement, settleReplacement } from "../src/commercial/quotes/replacement.js";
import type { ProviderCallTimer } from "../src/commercial/ports.js";

const NOW = "2026-10-06T12:00:00.000Z" as UtcInstant;
const never: ProviderCallTimer = { start: () => ({ elapsed: new Promise<void>(() => undefined), cancel: () => undefined }) };

/** The payment service's unit as a double: `quotes.get` answers the states in order (the last one repeats), rebindings.findTo the recorded re-binding. */
function serviceUnit(quoteStates: string[], rebinding: object | null): { readonly factory: { run: (context: unknown, work: (svc: never) => Promise<unknown>) => Promise<unknown> }; readonly reads: () => number } {
  let reads = 0;
  const svc = {
    adoptScope: async () => "scope",
    commerce: {
      quotes: { get: async () => ({ state: quoteStates[Math.min(reads++, quoteStates.length - 1)] }) },
      rebindings: { findTo: async () => rebinding },
    },
  };
  return { factory: { run: (_context, work) => work(svc as never) }, reads: () => reads };
}

const settleContext = { orderId: "order", toQuoteId: "to", fromQuoteId: "from", captureId: "capture", membershipId: "membership", entryId: "entry" } as never;
const runtime = { clock: { now: () => NOW } } as never;

function collaborators(factory: unknown, refusal: object): never {
  return {
    request: { payment: factory, paymentServiceId: "payment-service" },
    rebinder: { rebind: async () => refusal },
    providerTimer: never,
  } as never;
}

test("settle: a normal REFUSED reply over a replacement a late COMMIT re-bound is answered REBOUND by identity", async () => {
  // the unit reads the replacement ISSUED, its rebinder refuses (the allowance was spent meanwhile), the observation then finds it accepted with its re-binding
  const { factory } = serviceUnit(["ISSUED", "ACCEPTED_FOR_CHECKOUT"], { rebindingId: "r1" });
  const settled = await settleReplacement(runtime, collaborators(factory, { kind: "REFUSED", blockers: ["ALLOWANCE_USED"] }), settleContext, "corr");
  assert.deepEqual(settled, { kind: "REBOUND" });
});

test("settle: a genuine refusal (nothing was re-bound) stays REFUSED with its blockers", async () => {
  const { factory } = serviceUnit(["ISSUED", "ISSUED"], null);
  const settled = await settleReplacement(runtime, collaborators(factory, { kind: "REFUSED", blockers: ["ALLOWANCE_USED"] }), settleContext, "corr");
  assert.deepEqual(settled, { kind: "REFUSED", blockers: ["ALLOWANCE_USED"] });
});

/** The request unit's repositories as a double for the completion's derivation. */
function requestRepositories(states: { read: string; locked: string }, rebinding: object | null): { readonly c: never; readonly transitions: string[] } {
  const transitions: string[] = [];
  const c = {
    quotes: {
      get: async () => ({ state: states.read, version: 1 }),
      lock: async () => ({ state: states.locked, version: 2 }),
      transition: async (_id: string, _version: number, to: { state: string }) => {
        transitions.push(to.state);
        return { kind: "APPLIED", record: { state: to.state, version: 3 } };
      },
    },
    rebindings: { findTo: async () => rebinding },
  };
  return { c: c as never, transitions };
}

test("complete: a REFUSED settlement over a quote the abandoned unit accepted while the lock was awaited is not withdrawn and is REBOUND", async () => {
  // read ISSUED, but ACCEPTED_FOR_CHECKOUT once the lock is held and its re-binding is recorded
  const { c, transitions } = requestRepositories({ read: "ISSUED", locked: "ACCEPTED_FOR_CHECKOUT" }, { rebindingId: "r1" });
  const concluded = await concludeReplacement(c, { toQuoteId: "to" } as never, { kind: "REFUSED", blockers: ["ALLOWANCE_USED"] }, NOW);
  assert.deepEqual(transitions, [], "an accepted replacement is never withdrawn");
  assert.equal(concluded.rebound, true);
  assert.equal(concluded.quote.state, "ACCEPTED_FOR_CHECKOUT");
});

test("complete: a REFUSED settlement over a quote already accepted with its re-binding is REBOUND, with no lock taken", async () => {
  const { c, transitions } = requestRepositories({ read: "ACCEPTED_FOR_CHECKOUT", locked: "ACCEPTED_FOR_CHECKOUT" }, { rebindingId: "r1" });
  const concluded = await concludeReplacement(c, { toQuoteId: "to" } as never, { kind: "REFUSED", blockers: ["PURCHASE_NOT_INTACT"] }, NOW);
  assert.deepEqual(transitions, []);
  assert.equal(concluded.rebound, true);
});

test("complete: a genuine refusal over a quote still ISSUED under the lock is withdrawn and is not REBOUND", async () => {
  const { c, transitions } = requestRepositories({ read: "ISSUED", locked: "ISSUED" }, null);
  const concluded = await concludeReplacement(c, { toQuoteId: "to" } as never, { kind: "REFUSED", blockers: ["NOT_A_REPLACEMENT"] }, NOW);
  assert.deepEqual(transitions, ["WITHDRAWN"]);
  assert.equal(concluded.rebound, false);
  assert.equal(concluded.quote.state, "WITHDRAWN");
});
