// The owner's review state of each screen (Order 11 §8). docs/design/ORDER11-REVIEW-LOG.md is the record; this mirrors its status column
// so the index can show it. Only the owner's unequivocal approval may set OWNER_APPROVED.
import type { Review } from "./inventory.ts";

export const REVIEW_STATUS: Readonly<Record<string, Review>> = {};

export function reviewOf(id: string): Review {
  return REVIEW_STATUS[id] ?? "NOT_PRESENTED";
}
