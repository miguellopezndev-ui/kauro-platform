/**
 * State-machine guards over the vendored registry (registry/state_transitions.json via @kauro/contracts STATE_MACHINES;
 * reference/TRANSITIONS_AND_EVENT_EFFECTS.md: "An unlisted edge is rejected rather than inferred from a UI label").
 *
 * The domain never invents a transition: a command names the registry event it performs and this module answers whether the
 * current state of the aggregate lists that edge. The database additionally checks the state vocabulary of each column against
 * the same registry (persistence tests use the registry as the oracle).
 */
import { STATE_MACHINES, type StateMachine, type StateTransition } from "@kauro/contracts";
import { DomainFailure } from "./errors.js";

export type MachineName =
  | "Agency"
  | "Membership"
  | "DatasetRevision"
  | "Audit"
  | "Plan"
  | "Job"
  | "PaymentAttempt"
  | "ImportStage"
  | "Capability"
  | "CostGrant"
  | "TaxDocument"
  | "CommissionLine";

export function machine(name: MachineName): StateMachine {
  const m = STATE_MACHINES.find((x) => x.contract === name);
  if (!m) throw new TypeError(`state machine ${name} is not in the registry`);
  return m;
}

/** Every state the registry names for a machine (initial, every edge endpoint, every terminal). */
export function statesOf(name: MachineName): ReadonlyArray<string> {
  const m = machine(name);
  const out = new Set<string>([m.initial]);
  for (const t of m.transitions) {
    out.add(t.from);
    out.add(t.to);
  }
  for (const t of m.terminal) out.add(t);
  return [...out];
}

export function findTransition(name: MachineName, from: string, event: string): StateTransition | null {
  return machine(name).transitions.find((t) => t.from === from && t.event === event) ?? null;
}

export function isTerminal(name: MachineName, state: string): boolean {
  return machine(name).terminal.includes(state);
}

/** Returns the target state of a listed edge or raises PRECONDITION_FAILED / UNLISTED_TRANSITION. */
export function transition(name: MachineName, from: string, event: string): string {
  const t = findTransition(name, from, event);
  if (!t) {
    throw new DomainFailure("PRECONDITION_FAILED", `${name}: no listed transition from ${from} on ${event}`, {
      reason: "UNLISTED_TRANSITION",
      currentState: from,
    });
  }
  return t.to;
}
