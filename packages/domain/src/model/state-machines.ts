/**
 * State-machine guards over the vendored registry (registry/state_transitions.json via @kauro/contracts STATE_MACHINES;
 * reference/TRANSITIONS_AND_EVENT_EFFECTS.md: "An unlisted edge is rejected rather than inferred from a UI label").
 *
 * The domain never invents a transition: a command names the registry event it performs and this module answers whether the
 * current state of the aggregate lists that edge. The database additionally checks the state vocabulary of each column against
 * the same registry (persistence tests use the registry as the oracle).
 *
 * Two aggregates of B06 have no registry machine (and SupportCase, B11 D-SUP-6): EndClient (the contract has a state but no machine; decision D-AGG-2 fixes
 * the single edge ACTIVE -> ARCHIVED, CMD010) and Project (no registry contract; decision D-AGG-1 fixes OPEN, CLOSED,
 * DELETION_REQUESTED, DELETED). They are declared here in the registry's own shape with the registry's unlisted-transition
 * policy so the same guard applies; the persistence migrations seed the same edges (migration 0003).
 */
import { STATE_MACHINES, type StateMachine, type StateTransition } from "@kauro/contracts";
import { COMMERCE_PLATFORM_MACHINES, type CommercePlatformMachineName } from "../commerce/machines.js";
import { COMMERCIAL_PLATFORM_MACHINES, type CommercialPlatformMachineName } from "../commercial/machines.js";
import { PreconditionFailure } from "./errors.js";
import { EXECUTION_PLATFORM_MACHINES, type ExecutionPlatformMachineName } from "./execution/machines.js";
import { SOURCE_LIFECYCLE_STATE_MACHINES } from "./source/machines.js";

export type RegistryMachineName =
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

/**
 * EndClient and Project are B06's (D-AGG-1, D-AGG-2); UploadSession, StoredObject, SourceFile and RetentionRecord are B07's
 * (D-UP-1, D-OBJ-1, D-FILE-1, D-RET-2; @kauro/domain SOURCE_LIFECYCLE_STATE_MACHINES); the commerce machines are package B09's
 * (commerce/machines.ts); ProcessingAttempt and PackageVersion are package B08's (model/execution/machines.ts, design §8.2); the
 * commercial machines are package B10's (commercial/machines.ts, kept apart from this list as B07's are, so neither package rewrites
 * the other's); SupportCase is package B11's (W4, D-SUP-6).
 */
export type PlatformMachineName = "EndClient" | "Project" | "UploadSession" | "StoredObject" | "SourceFile" | "RetentionRecord" | CommercePlatformMachineName | ExecutionPlatformMachineName | CommercialPlatformMachineName | "SupportCase";

export type MachineName = RegistryMachineName | PlatformMachineName;

export const UNLISTED_TRANSITION_POLICY = "REJECT_UNLESS_A_NEW_VERSIONED_CONTRACT_IS_ACCEPTED";

/** Machines the platform declares because the registry has no entry (D-AGG-1, D-AGG-2, D-SUP-6). */
export const PLATFORM_STATE_MACHINES: ReadonlyArray<StateMachine> = Object.freeze([
  {
    contract: "EndClient",
    initial: "ACTIVE",
    terminal: ["ARCHIVED"],
    transitions: [
      {
        from: "ACTIVE",
        event: "archive_client",
        to: "ARCHIVED",
        guard: "The workspace belongs to the caller's agency and active paid work has been reviewed (CMD010).",
        effect: "Stop new project creation while retaining active work and lawful history; never an implicit deletion or refund.",
      },
    ],
    unlistedTransition: UNLISTED_TRANSITION_POLICY,
  },
  {
    contract: "Project",
    initial: "OPEN",
    terminal: ["DELETED"],
    transitions: [
      { from: "OPEN", event: "close_project", to: "CLOSED", guard: "Delivery or the owner closes the project under expected version.", effect: "Stop new revisions and plans; history and packages remain." },
      { from: "OPEN", event: "request_deletion", to: "DELETION_REQUESTED", guard: "Explicit deletion capability and step-up (08).", effect: "Schedule managed-scope deletion; nothing is removed by the request itself." },
      { from: "CLOSED", event: "request_deletion", to: "DELETION_REQUESTED", guard: "Same deletion authority.", effect: "Same managed deletion schedule." },
      { from: "DELETION_REQUESTED", event: "deletion_verified", to: "DELETED", guard: "Every active customer-data class is verified removed; residuals recorded.", effect: "Leave a safe tombstone and a deletion receipt." },
    ],
    unlistedTransition: UNLISTED_TRANSITION_POLICY,
  },
  ...COMMERCE_PLATFORM_MACHINES,
  // D-SUP-6: the registry contract SupportCase has a state enum and no machine. A case is born OPEN (CMD044); the triage edges belong
  // to the package that triages cases, so this edition lists none and an unlisted edge is rejected.
  {
    contract: "SupportCase",
    initial: "OPEN",
    terminal: ["CLOSED"],
    transitions: [],
    unlistedTransition: UNLISTED_TRANSITION_POLICY,
  },
]);

export function machine(name: MachineName): StateMachine {
  const m =
    STATE_MACHINES.find((x) => x.contract === name) ??
    PLATFORM_STATE_MACHINES.find((x) => x.contract === name) ??
    SOURCE_LIFECYCLE_STATE_MACHINES.find((x) => x.contract === name) ??
    // package B08's ProcessingAttempt and PackageVersion (model/execution/machines.ts), kept apart from B06's and B09's list as
    // B07 keeps its own, so no package rewrites another's
    EXECUTION_PLATFORM_MACHINES.find((x) => x.contract === name) ??
    COMMERCIAL_PLATFORM_MACHINES.find((x) => x.contract === name);
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

/** Every event name a machine lists. */
export function eventsOf(name: MachineName): ReadonlyArray<string> {
  return [...new Set(machine(name).transitions.map((t) => t.event))];
}

export function findTransition(name: MachineName, from: string, event: string): StateTransition | null {
  return machine(name).transitions.find((t) => t.from === from && t.event === event) ?? null;
}

export function isListed(name: MachineName, from: string, event: string): boolean {
  return findTransition(name, from, event) !== null;
}

export function isTerminal(name: MachineName, state: string): boolean {
  return machine(name).terminal.includes(state);
}

/** Returns the target state of a listed edge or raises PRECONDITION_FAILED / UNLISTED_TRANSITION. */
export function transition(name: MachineName, from: string, event: string): string {
  const t = findTransition(name, from, event);
  if (!t) throw new PreconditionFailure("UNLISTED_TRANSITION", `${name}: no listed transition from ${from} on ${event}`, { currentState: from });
  return t.to;
}
