/**
 * The RowCounts of an issued package (lane ROWCOUNTS-PRODUCER, package B05; registry contract RowCounts, owner manual 03 "Counters
 * have named denominators and cannot be substituted for one another"; docs/design/B13-report-model.md §3, Q-B13-1).
 *
 * The four populations are the sealed revision's, frozen before capture (03 "Count the correct population"); the six execution
 * counts are the Migration Core's ValidationReceipt.counts, which only the validator establishes (D8-CAU-6). The platform's
 * validator hands the core the sealed revision's generations and its billable units (PlanValidator, CoreCallControls source and
 * billableSourceUnits), so the four populations the receipt names are the core's count of the same source: a receipt whose populations
 * differ from the sealed revision's in any member is COUNTS_MISMATCH and nothing is issued (03 "cannot be substituted for one
 * another"). A receipt that is not exactly the ten RowCounts members as non-negative safe integers, or a revision without
 * populations, is COUNTS_UNAVAILABLE; a positive `unresolved` blocks final acceptance (COUNTS_UNRESOLVED). The verdict is fail
 * closed: only a COUNTS answer names counts.
 */
import type { RowCounts } from "@kauro/contracts";
import type { SourcePopulations } from "../source/records.js";

/** The registry RowCounts members, in the registry's order. */
export const ROW_COUNT_KEYS: ReadonlyArray<keyof RowCounts> = Object.freeze([
  "physicalSourceRows",
  "logicalSourceRecords",
  "billableSourceUnits",
  "associationEdges",
  "emittedRepresentatives",
  "mergedNonSurvivors",
  "rejected",
  "withheld",
  "unresolved",
  "emittedArtifactRows",
] as const);

const POPULATION_KEYS = Object.freeze(["physicalSourceRows", "logicalSourceRecords", "billableSourceUnits", "associationEdges"] as const);

/** What the publication reads in its own transaction: the sealed revision's populations and its validation receipt's counts. */
export interface DeliveryCountFacts {
  /** The populations of the revision the job binds (null when the revision row or its populations are absent). */
  readonly populations: SourcePopulations | null;
  /** The validation receipt's `counts` exactly as stored (null when the receipt is not visible). */
  readonly receiptCounts: unknown;
}

export type DeliveryCountsVerdict =
  | { readonly kind: "COUNTS"; readonly counts: RowCounts }
  | { readonly kind: "REFUSED"; readonly reason: "COUNTS_UNAVAILABLE" | "COUNTS_MISMATCH" | "COUNTS_UNRESOLVED" };

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export function deliveryRowCountsOf(facts: DeliveryCountFacts): DeliveryCountsVerdict {
  const { populations, receiptCounts } = facts;
  if (populations === null || !POPULATION_KEYS.every((k) => isCount(populations[k]))) return { kind: "REFUSED", reason: "COUNTS_UNAVAILABLE" };
  if (receiptCounts === null || typeof receiptCounts !== "object" || Array.isArray(receiptCounts)) return { kind: "REFUSED", reason: "COUNTS_UNAVAILABLE" };
  const receipt = receiptCounts as Readonly<Record<string, unknown>>;
  const keys = Object.keys(receipt);
  if (keys.length !== ROW_COUNT_KEYS.length || !ROW_COUNT_KEYS.every((k) => Object.prototype.hasOwnProperty.call(receipt, k) && isCount(receipt[k]))) {
    return { kind: "REFUSED", reason: "COUNTS_UNAVAILABLE" };
  }
  if (!POPULATION_KEYS.every((k) => receipt[k] === populations[k])) return { kind: "REFUSED", reason: "COUNTS_MISMATCH" };
  if (receipt["unresolved"] !== 0) return { kind: "REFUSED", reason: "COUNTS_UNRESOLVED" };
  const counts: Record<string, number> = {};
  for (const k of ROW_COUNT_KEYS) counts[k] = (POPULATION_KEYS as ReadonlyArray<string>).includes(k) ? populations[k as (typeof POPULATION_KEYS)[number]] : (receipt[k] as number);
  return { kind: "COUNTS", counts: Object.freeze(counts) as unknown as RowCounts };
}
