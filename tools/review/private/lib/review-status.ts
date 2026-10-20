// The owner's review state of each screen (Order 11 §8). docs/design/ORDER11-REVIEW-LOG.md is the record; this mirrors its status column
// so the index can show it. Only the owner's unequivocal approval may set OWNER_APPROVED.
import type { Review } from "./inventory.ts";

export const REVIEW_STATUS: Readonly<Record<string, Review>> = {
  // Group A: presented on 2026-10-20; the owner asked for full navigable experiences and a redesign to perfection; revised the same day
  UI50: "REVISED_AWAITING_REVIEW",
  UI51: "REVISED_AWAITING_REVIEW",
  UI09: "REVISED_AWAITING_REVIEW",
  UI10: "REVISED_AWAITING_REVIEW",
  UI31: "REVISED_AWAITING_REVIEW",
  UI32: "REVISED_AWAITING_REVIEW",
  "P-01": "REVISED_AWAITING_REVIEW",
  "P-05": "NOT_PRESENTED",
  "P-06": "NOT_PRESENTED",
  "P-02": "REVISED_AWAITING_REVIEW",
};

export function reviewOf(id: string): Review {
  return REVIEW_STATUS[id] ?? "NOT_PRESENTED";
}
