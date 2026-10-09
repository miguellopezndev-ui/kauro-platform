// Payments V1, lane KIT: the dispatch of planPostings to the bank-transfer families (core/bank-postings, core/return-postings) is in place and
// inert. Until L-INBOUND and L-REFUND replace the skeleton bodies every bank event is NOT_APPLICABLE exactly like any unknown type, and no
// existing family changes. The bodies' own cells are the lanes'.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BANK_POSTING_EVENT_TYPES, RETURN_POSTING_EVENT_TYPES, toUtcInstant, type AgencyId, type EventId, type EventPayload } from "@kauro/domain";
import { ownsBankCreditPosting, ownsReturnPosting, planBankCreditPostings, planPostings, planReturnPostings, type PostingSource } from "../src/commerce/core/index.js";

const source = (eventType: string, payload: EventPayload = {}): PostingSource => ({
  eventId: "01920000-0000-7000-8000-00000000b001" as EventId,
  eventType,
  aggregateId: "01920000-0000-7000-8000-00000000b002",
  agencyId: "01920000-0000-7000-8000-00000000b003" as AgencyId,
  payload,
  recordedAt: toUtcInstant(Date.parse("2026-10-07T12:00:00.000Z")),
});

test("OK dispatch: every bank-transfer event type is owned by exactly one skeleton, plans nothing yet (NOT_APPLICABLE) and never reaches the B09 families", () => {
  for (const t of BANK_POSTING_EVENT_TYPES) {
    assert.deepEqual([ownsBankCreditPosting(t), ownsReturnPosting(t)], [true, false], t);
    assert.equal(planBankCreditPostings(source(t)), null);
    assert.deepEqual(planPostings(source(t)), { kind: "NOT_APPLICABLE", eventType: t });
  }
  for (const t of RETURN_POSTING_EVENT_TYPES) {
    assert.deepEqual([ownsBankCreditPosting(t), ownsReturnPosting(t)], [false, true], t);
    assert.equal(planReturnPostings(source(t)), null);
    assert.deepEqual(planPostings(source(t)), { kind: "NOT_APPLICABLE", eventType: t });
  }
  assert.deepEqual(new Set([...BANK_POSTING_EVENT_TYPES, ...RETURN_POSTING_EVENT_TYPES]).size, BANK_POSTING_EVENT_TYPES.length + RETURN_POSTING_EVENT_TYPES.length);
});

test("OK dispatch: the B09 families are unchanged — a completed capture still plans its CAPTURE set, an unknown type is still NOT_APPLICABLE", () => {
  const completed = planPostings(source("capture.completed.v1", { allocatedServiceCents: 1000, allocatedTaxCents: 0, excessCents: 0, evidenceHash: "e".repeat(64) }));
  assert.equal(completed.kind, "POST");
  assert.deepEqual(planPostings(source("quote.issued.v1")), { kind: "NOT_APPLICABLE", eventType: "quote.issued.v1" });
});
