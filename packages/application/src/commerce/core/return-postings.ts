/**
 * planReturnPostings — the FINANCE consumer's decision for the outbound-return events of the bank-transfer route (Payments V1,
 * docs/design/ACH-ROUTE.md D-ACH-18; lane KIT skeleton). The bodies belong to lane L-REFUND, which replaces this file's function and
 * keeps its signature: pure, every amount frozen in the event payload by the producing COMMIT, so the delivery order cannot change a
 * posting. Until then it answers null for every event, so planPostings answers NOT_APPLICABLE exactly as before.
 */
import { RETURN_POSTING_EVENT_TYPES } from "@kauro/domain";
import type { PostingPlan, PostingSource } from "./postings.js";

const OWNED: ReadonlySet<string> = new Set(RETURN_POSTING_EVENT_TYPES);

/** True when the event type is one this planner owns. */
export function ownsReturnPosting(eventType: string): boolean {
  return OWNED.has(eventType);
}

/** KIT skeleton: no behaviour. null means "not planned here". */
export function planReturnPostings(_source: PostingSource): PostingPlan | null {
  return null;
}
