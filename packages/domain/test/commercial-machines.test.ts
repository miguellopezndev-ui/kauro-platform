// The platform machines of package B10 (docs/design/B10-commercial-domain.md §8.2) and the registry machine CommissionLine it
// performs (§8.1), through the domain's own guard (machine, transition): the design's tables are the oracle, written here and never
// read back from the module under test; an unlisted edge is rejected rather than inferred (reference/TRANSITIONS_AND_EVENT_EFFECTS;
// registry state_transitions unlistedTransition). Migration 0028 seeds FoundingReservation from the same declaration and 0029..0031
// seed the others (b10-recurrence-migrations.test.ts compares the seed).
import assert from "node:assert/strict";
import { test } from "node:test";
import { STATE_MACHINES, registryJson } from "@kauro/contracts";
import {
  COMMERCIAL_EVENT_PAYLOAD_ALLOWLIST,
  COMMERCIAL_EVENT_SUBSCRIPTIONS,
  COMMERCIAL_EVENT_TYPES,
  COMMERCIAL_PLATFORM_MACHINES,
  COMMERCE_PLATFORM_MACHINES,
  EVENT_PAYLOAD_ALLOWLIST,
  EVENT_SUBSCRIPTIONS,
  EVENT_TYPES,
  PLATFORM_STATE_MACHINES,
  SOURCE_LIFECYCLE_STATE_MACHINES,
  assertAllowlistedPayload,
  consumersOf,
  isTerminal,
  machine,
  statesOf,
  transition,
  type MachineName,
} from "../src/index.js";

type Edge = readonly [from: string, event: string, to: string];

interface DesignMachine {
  readonly initial: string;
  readonly terminal: ReadonlyArray<string>;
  readonly states: ReadonlyArray<string>;
  readonly edges: ReadonlyArray<Edge>;
}

const fanIn = (froms: ReadonlyArray<string>, event: string, to: string): Edge[] => froms.map((from) => [from, event, to] as const);

/** Design §8.2: each machine's initial, terminal and state lists and every edge of its table, in the design's order. */
const DESIGN: Readonly<Record<string, DesignMachine>> = {
  FoundingReservation: {
    initial: "RESERVED",
    terminal: ["CONSUMED", "RELEASED"],
    states: ["RESERVED", "RECONCILIATION_HOLD", "CONSUMED", "RELEASED"],
    edges: [
      ["RESERVED", "slot_consumed", "CONSUMED"],
      ["RESERVED", "reservation_released", "RELEASED"],
      ["RESERVED", "end_with_payment_in_flight", "RECONCILIATION_HOLD"],
      ["RECONCILIATION_HOLD", "slot_consumed", "CONSUMED"],
      ["RECONCILIATION_HOLD", "reservation_released", "RELEASED"],
    ],
  },
  Seller: {
    initial: "CANDIDATE",
    terminal: ["TERMINATED"],
    states: ["CANDIDATE", "ACTIVE", "SUSPENDED", "TERMINATED"],
    edges: [
      ["CANDIDATE", "seller_activated", "ACTIVE"],
      ["ACTIVE", "seller_suspended", "SUSPENDED"],
      ["SUSPENDED", "seller_reinstated", "ACTIVE"],
      ["ACTIVE", "seller_terminated", "TERMINATED"],
      ["SUSPENDED", "seller_terminated", "TERMINATED"],
      ["CANDIDATE", "candidate_not_engaged", "TERMINATED"],
    ],
  },
  Prospect: {
    initial: "RESEARCHED",
    terminal: ["SUPPRESSED"],
    states: ["RESEARCHED", "QUALIFIED", "CONTACTED", "ENGAGED", "OPPORTUNITY", "WON", "LOST", "SUPPRESSED"],
    edges: [
      ["RESEARCHED", "qualification_recorded", "QUALIFIED"],
      ["QUALIFIED", "contact_recorded", "CONTACTED"],
      ["CONTACTED", "engagement_recorded", "ENGAGED"],
      ["ENGAGED", "opportunity_recorded", "OPPORTUNITY"],
      ["OPPORTUNITY", "won_recorded", "WON"],
      ...fanIn(["RESEARCHED", "QUALIFIED", "CONTACTED", "ENGAGED", "OPPORTUNITY"], "lost_recorded", "LOST"),
      ["LOST", "new_signal_recorded", "RESEARCHED"],
      ...fanIn(["RESEARCHED", "QUALIFIED", "CONTACTED", "ENGAGED", "OPPORTUNITY", "LOST", "WON"], "suppression_recorded", "SUPPRESSED"),
    ],
  },
  AttributionClaim: {
    initial: "SUBMITTED",
    terminal: ["REJECTED", "EXPIRED", "CONVERTED"],
    states: ["SUBMITTED", "ACCEPTED", "DISPUTED", "REJECTED", "EXPIRED", "CONVERTED"],
    edges: [
      ["SUBMITTED", "claim_conflict_found", "DISPUTED"],
      ...fanIn(["SUBMITTED", "DISPUTED"], "claim_accepted", "ACCEPTED"),
      ...fanIn(["SUBMITTED", "DISPUTED"], "claim_rejected", "REJECTED"),
      ...fanIn(["SUBMITTED", "DISPUTED", "ACCEPTED"], "claim_lapsed", "EXPIRED"),
      ["ACCEPTED", "first_purchase_confirmed", "CONVERTED"],
    ],
  },
  CommissionEntitlement: {
    initial: "ACTIVE",
    terminal: ["EXPIRED"],
    states: ["ACTIVE", "EXPIRED", "DISPUTED", "TERMINATED_WITH_RESIDUAL"],
    edges: [
      ["ACTIVE", "window_ended", "EXPIRED"],
      ["ACTIVE", "seller_terminated", "TERMINATED_WITH_RESIDUAL"],
      ["ACTIVE", "attribution_disputed", "DISPUTED"],
      ["DISPUTED", "dispute_resolved", "ACTIVE"],
      ["DISPUTED", "seller_terminated", "TERMINATED_WITH_RESIDUAL"],
      ["DISPUTED", "window_ended", "EXPIRED"],
      ["TERMINATED_WITH_RESIDUAL", "window_ended", "EXPIRED"],
    ],
  },
  CommissionStatement: {
    initial: "DRAFT",
    terminal: ["PAID", "CORRECTED"],
    states: ["DRAFT", "ISSUED", "DISPUTED", "APPROVED", "PAID", "CORRECTED"],
    edges: [
      ["DRAFT", "statement_issued", "ISSUED"],
      ["ISSUED", "payout_approved", "APPROVED"],
      ["APPROVED", "payout_settled", "PAID"],
      ["APPROVED", "payout_not_settled", "ISSUED"],
      ["ISSUED", "statement_disputed", "DISPUTED"],
      ["DISPUTED", "dispute_scoped", "ISSUED"],
      ...fanIn(["DISPUTED", "ISSUED"], "correction_issued", "CORRECTED"),
    ],
  },
  PayoutIntent: {
    initial: "AUTHORIZED",
    terminal: ["SETTLED", "FAILED", "RETURNED"],
    states: ["AUTHORIZED", "SUBMITTED", "UNCERTAIN", "SETTLED", "FAILED", "RETURNED"],
    edges: [
      ["AUTHORIZED", "transfer_submitted", "SUBMITTED"],
      ["SUBMITTED", "transfer_ambiguous", "UNCERTAIN"],
      ...fanIn(["AUTHORIZED", "SUBMITTED", "UNCERTAIN"], "settled_evidence", "SETTLED"),
      ...fanIn(["AUTHORIZED", "SUBMITTED", "UNCERTAIN"], "failed_evidence", "FAILED"),
      ...fanIn(["AUTHORIZED", "SUBMITTED", "UNCERTAIN"], "returned_evidence", "RETURNED"),
    ],
  },
  PayoutDestination: {
    initial: "PENDING_VERIFICATION",
    terminal: ["REJECTED", "SUPERSEDED"],
    states: ["PENDING_VERIFICATION", "VERIFIED", "REJECTED", "SUPERSEDED"],
    edges: [
      ["PENDING_VERIFICATION", "destination_verified", "VERIFIED"],
      ["PENDING_VERIFICATION", "destination_rejected", "REJECTED"],
      ["VERIFIED", "destination_superseded", "SUPERSEDED"],
    ],
  },
  CommissionHold: {
    initial: "OPEN",
    terminal: ["RELEASED", "UPHELD"],
    states: ["OPEN", "RELEASED", "UPHELD"],
    edges: [
      ["OPEN", "hold_released", "RELEASED"],
      ["OPEN", "hold_upheld", "UPHELD"],
    ],
  },
  CommissionPeriod: {
    initial: "OPEN",
    terminal: ["CLOSED"],
    states: ["OPEN", "CLOSED"],
    edges: [["OPEN", "period_closed", "CLOSED"]],
  },
};

/** Design §8.1: the CommissionLine edges B10 performs, each the registry's own. */
const COMMISSION_LINE_EDGES: ReadonlyArray<Edge> = [
  ["ACCRUED_PENDING", "eligibility_conditions_met", "ELIGIBLE"],
  ["ACCRUED_PENDING", "justified_dispute_or_funds_hold", "HELD"],
  ["HELD", "hold_resolved_and_eligible", "ELIGIBLE"],
  ["ELIGIBLE", "statement_closed", "PAYABLE"],
  ["PAYABLE", "settled_payout_evidence", "PAID"],
  ["PAYABLE", "payout_blocked", "HELD"],
  ["PAID", "reconciled_refund_adjustment", "ADJUSTED"],
  ["ACCRUED_PENDING", "full_service_reversal", "VOID"],
  ["HELD", "full_service_reversal", "VOID"],
  ["ELIGIBLE", "full_service_reversal", "VOID"],
  ["ADJUSTED", "further_reconciled_adjustment", "ADJUSTED"],
];

const edgeKey = (e: Edge): string => `${e[0]} -${e[1]}-> ${e[2]}`;
const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

interface RegistryContract {
  readonly name: string;
  readonly fields: ReadonlyArray<{ readonly name: string; readonly type: string }>;
}

/** The state vocabulary of a registry contract, when the contract has one. */
function contractStates(contract: string): string[] | null {
  const f = registryJson<RegistryContract[]>("contracts.json").find((c) => c.name === contract)?.fields.find((x) => x.name === "state");
  return f === undefined ? null : f.type.slice("enum:".length).split(",");
}

test("the platform machines FoundingReservation, Seller, Prospect, AttributionClaim, CommissionEntitlement, CommissionStatement, PayoutIntent, PayoutDestination, CommissionHold and CommissionPeriod admit exactly the edges of design section 8.2 from their initial states, every other edge rejected, and CommissionLine is the registry's machine unchanged", () => {
  // exactly the ten machines of §8.2, in the design's order, each under the registry's unlisted-transition policy
  assert.deepEqual(COMMERCIAL_PLATFORM_MACHINES.map((m) => m.contract), Object.keys(DESIGN));
  const elsewhere = new Set([...STATE_MACHINES, ...PLATFORM_STATE_MACHINES, ...SOURCE_LIFECYCLE_STATE_MACHINES, ...COMMERCE_PLATFORM_MACHINES].map((m) => m.contract));
  for (const [name, design] of Object.entries(DESIGN)) {
    assert.equal(elsewhere.has(name), false, `${name} is declared once, by B10`);
    const declared = COMMERCIAL_PLATFORM_MACHINES.find((m) => m.contract === name);
    assert.ok(declared !== undefined, name);
    // the domain's guard resolves the machine to this very declaration
    assert.equal(machine(name as MachineName), declared, `${name}: machine() resolves B10's declaration`);
    assert.equal(declared.initial, design.initial, `${name}: initial`);
    assert.deepEqual(sorted(declared.terminal), sorted(design.terminal), `${name}: terminal`);
    assert.deepEqual(sorted(statesOf(name as MachineName)), sorted(design.states), `${name}: states`);
    assert.equal(declared.unlistedTransition, "REJECT_UNLESS_A_NEW_VERSIONED_CONTRACT_IS_ACCEPTED", `${name}: unlisted policy`);
    const contract = contractStates(name);
    if (contract !== null) assert.deepEqual(sorted(design.states), sorted(contract), `${name}: the registry contract's state vocabulary`);

    // exactly the design's edges, each once, each with its guard and effect
    const listed = declared.transitions.map((t) => [t.from, t.event, t.to] as const);
    assert.deepEqual(sorted(listed.map(edgeKey)), sorted(design.edges.map(edgeKey)), `${name}: the edges of design §8.2`);
    assert.equal(new Set(listed.map(edgeKey)).size, listed.length, `${name}: each edge once`);
    for (const t of declared.transitions) {
      assert.ok(t.guard.length > 10 && t.effect.length > 10, `${name} ${t.from} -${t.event}->: guard and effect`);
      assert.equal(transition(name as MachineName, t.from, t.event), t.to, `${name} ${t.from} -${t.event}-> admitted`);
    }

    // every state is reached from the initial one along the listed edges; a terminal state has no edge out, every other one has
    const reached = new Set([design.initial]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [from, , to] of design.edges) if (reached.has(from) && !reached.has(to)) {
        reached.add(to);
        grew = true;
      }
    }
    assert.deepEqual(sorted(reached), sorted(design.states), `${name}: every state reachable from ${design.initial}`);
    for (const s of design.states) {
      const out = design.edges.filter(([from]) => from === s).length;
      assert.equal(isTerminal(name as MachineName, s), design.terminal.includes(s), `${name}: ${s} terminal or not`);
      if (design.terminal.includes(s)) assert.equal(out, 0, `${name}: terminal ${s} has no edge out`);
      else assert.ok(out > 0, `${name}: ${s} has an edge out`);
    }

    // every other edge is rejected: each event of the machine from every state it does not leave by that event, an event of
    // another machine, and a state the machine does not know
    const events = [...new Set(design.edges.map(([, event]) => event))];
    for (const from of design.states) {
      for (const event of events) {
        if (design.edges.some(([f, e]) => f === from && e === event)) continue;
        assert.throws(() => transition(name as MachineName, from, event), /no listed transition/, `${name} ${from} -${event}-> is unlisted`);
      }
      assert.throws(() => transition(name as MachineName, from, "issue_quote"), /no listed transition/, `${name}: a foreign event`);
    }
    assert.throws(() => transition(name as MachineName, "NOT_A_STATE", events[0]!), /no listed transition/, `${name}: an unknown state`);
  }

  // CommissionLine is the registry's machine, used exactly as vendored (§8.1), never redeclared by the platform
  const vendored = STATE_MACHINES.find((m) => m.contract === "CommissionLine");
  assert.ok(vendored !== undefined);
  assert.equal(machine("CommissionLine"), vendored);
  assert.equal(COMMERCIAL_PLATFORM_MACHINES.some((m) => m.contract === "CommissionLine"), false);
  assert.deepEqual(sorted(vendored.transitions.map((t) => edgeKey([t.from, t.event, t.to]))), sorted(COMMISSION_LINE_EDGES.map(edgeKey)));
  for (const [from, event, to] of COMMISSION_LINE_EDGES) assert.equal(transition("CommissionLine", from, event), to);
  assert.equal(vendored.initial, "ACCRUED_PENDING");
  assert.deepEqual([...vendored.terminal], ["VOID"]);
  assert.deepEqual(sorted(statesOf("CommissionLine")), sorted(contractStates("CommissionLine") ?? []));
  assert.throws(() => transition("CommissionLine", "PAID", "full_service_reversal"), /no listed transition/, "a paid line is adjusted, never voided");
  assert.throws(() => transition("CommissionLine", "PAYABLE", "full_service_reversal"), /no listed transition/, "a payable line keeps its state; the adjustment goes to the next statement");
});

test("B10 events: agency.first_purchase_designated.v1 is registered once with an ids-only payload and no subscriber, and COMMISSIONS is appended as a subscriber of capture.funds_observed.v1 and commercial_authorization.delivered.v1 beside their B09 destinations", () => {
  assert.deepEqual([...COMMERCIAL_EVENT_TYPES], ["agency.first_purchase_designated.v1"]);
  for (const t of COMMERCIAL_EVENT_TYPES) {
    assert.equal(EVENT_TYPES.filter((x) => x === t).length, 1, `${t} is registered once`);
    assert.deepEqual(EVENT_PAYLOAD_ALLOWLIST[t], COMMERCIAL_EVENT_PAYLOAD_ALLOWLIST[t]);
    assert.deepEqual(consumersOf(t), [], `${t} reaches no consumer`);
  }
  assert.deepEqual([...COMMERCIAL_EVENT_PAYLOAD_ALLOWLIST["agency.first_purchase_designated.v1"]].sort(), ["agencyId", "firstAuthorizationId", "firstProjectId", "firstQualifyingCaptureId"]);
  const ids = { agencyId: "01920000-0000-7000-8000-0000000e0001", firstQualifyingCaptureId: "01920000-0000-7000-8000-0000000e0002", firstAuthorizationId: "01920000-0000-7000-8000-0000000e0003", firstProjectId: "01920000-0000-7000-8000-0000000e0004" };
  assertAllowlistedPayload("agency.first_purchase_designated.v1", ids);
  assert.throws(() => assertAllowlistedPayload("agency.first_purchase_designated.v1", { ...ids, confirmationSeq: 1 }), /not allowlisted/, "ids only");
  assert.throws(() => assertAllowlistedPayload("agency.first_purchase_designated.v1", { ...ids, agencyId: "Acme Agency" }), /not a safe reference/);

  assert.deepEqual(
    COMMERCIAL_EVENT_SUBSCRIPTIONS.map((s) => `${s.eventType} -> ${s.consumer}`),
    ["capture.funds_observed.v1 -> COMMISSIONS", "commercial_authorization.delivered.v1 -> COMMISSIONS"],
  );
  for (const s of COMMERCIAL_EVENT_SUBSCRIPTIONS) assert.equal(EVENT_SUBSCRIPTIONS.filter((x) => x.eventType === s.eventType && x.consumer === s.consumer).length, 1, `${s.eventType} -> ${s.consumer} once`);
  assert.deepEqual(consumersOf("capture.funds_observed.v1"), ["FINANCE", "COMMISSIONS"]);
  // B08 (on main before B10) routes the delivery to NOTIFICATIONS; B10 appends COMMISSIONS after it (D10-SYNC-3)
  assert.deepEqual(consumersOf("commercial_authorization.delivered.v1"), ["NOTIFICATIONS", "COMMISSIONS"]);
});
