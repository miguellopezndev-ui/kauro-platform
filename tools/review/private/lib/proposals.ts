// Designs the owner asked for that the registry does not hold yet (Order 11 §4): shown for visual approval only. None of them is a route,
// a contract or a command; each names the screen it would extend and what it would need.
import type { GroupKey } from "./inventory.ts";

export interface Proposal {
  readonly key: string;
  readonly group: GroupKey;
  readonly title: string;
  readonly why: string;
  readonly href: string;
}

export const PROPOSALS: readonly Proposal[] = [];
