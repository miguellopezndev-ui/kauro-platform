/**
 * planBankCreditPostings — the FINANCE consumer's decision for the incoming-credit events of the bank-transfer route (Payments V1,
 * docs/design/ACH-ROUTE.md D-ACH-11; lane KIT skeleton). The bodies belong to lane L-INBOUND, which replaces this file's function and
 * keeps its signature: pure, amounts only from the event's frozen payload, the posting set sourced by the event (its id is the set's
 * idempotency identity). Until then it answers null for every event, so planPostings answers NOT_APPLICABLE exactly as before.
 */
import { BANK_POSTING_EVENT_TYPES } from "@kauro/domain";
import type { PostingPlan, PostingSource } from "./postings.js";

const OWNED: ReadonlySet<string> = new Set(BANK_POSTING_EVENT_TYPES);

/** True when the event type is one this planner owns (the dispatch in planPostings asks before it plans). */
export function ownsBankCreditPosting(eventType: string): boolean {
  return OWNED.has(eventType);
}

/** KIT skeleton: no behaviour. null means "not planned here". */
export function planBankCreditPostings(_source: PostingSource): PostingPlan | null {
  return null;
}
