// B10 stage 1 is one implementation (the `b10/stage-1` integrator; docs/design/B10-commercial-domain.md §8, §11, D10-STAGE-2):
// B10-SCHEMA-RECURRENCE declared the platform machines (commercial/machines.ts) while B10-MODEL declared the records' state
// vocabularies (commercial/vocabulary.ts); merged, every platform machine and the registry's CommissionLine have exactly the states the
// domain's vocabulary gives the state column of their records, so a record never holds a state its machine cannot reach.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMERCIAL_PLATFORM_MACHINES, COMMERCIAL_VOCABULARY, statesOf, type MachineName } from "../src/index.js";

/** Each machine B10 performs and the vocabulary of its record's state column. */
const STATE_COLUMNS = {
  FoundingReservation: COMMERCIAL_VOCABULARY.foundingReservationStates,
  Seller: COMMERCIAL_VOCABULARY.sellerStates,
  Prospect: COMMERCIAL_VOCABULARY.prospectStates,
  AttributionClaim: COMMERCIAL_VOCABULARY.attributionClaimStates,
  CommissionEntitlement: COMMERCIAL_VOCABULARY.entitlementStates,
  CommissionStatement: COMMERCIAL_VOCABULARY.statementStates,
  PayoutIntent: COMMERCIAL_VOCABULARY.payoutIntentStates,
  PayoutDestination: COMMERCIAL_VOCABULARY.payoutDestinationStates,
  CommissionHold: COMMERCIAL_VOCABULARY.holdStates,
  CommissionPeriod: COMMERCIAL_VOCABULARY.periodStates,
  CommissionLine: COMMERCIAL_VOCABULARY.lineStates,
} as const;

test("B10 stage 1 is one state vocabulary: each platform machine of section 8.2 and the registry's CommissionLine have exactly the states COMMERCIAL_VOCABULARY gives their record's state column", () => {
  assert.deepEqual(
    [...COMMERCIAL_PLATFORM_MACHINES.map((m) => m.contract), "CommissionLine"].sort(),
    Object.keys(STATE_COLUMNS).sort(),
    "every machine B10 performs is compared",
  );
  for (const [name, vocabulary] of Object.entries(STATE_COLUMNS)) {
    assert.deepEqual([...statesOf(name as MachineName)].sort(), [...vocabulary].sort(), `${name}: its states are its record's`);
  }
});
