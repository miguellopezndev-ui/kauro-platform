// The review's vocabulary (Order 11), in a module without imports so the inventory and the proposals can both use it.
export type Technical = "IMPLEMENTED" | "PROTOTYPE" | "BLOCKED_EXTERNAL" | "PROPOSED";
export type Review = "NOT_PRESENTED" | "PRESENTED" | "CHANGES_REQUESTED" | "REVISED_AWAITING_REVIEW" | "OWNER_APPROVED";
export type GroupKey = "A" | "B" | "C" | "D" | "E";
