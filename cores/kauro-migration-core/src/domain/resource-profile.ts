/**
 * What a run is allowed to consume, in bytes.
 *
 * Bytes, and only bytes, because every other unit in this area has been used to
 * mean two things. A value named `peakRssMb` that is computed as
 * `bytes / 1024 / 1024` is mebibytes wearing the name of megabytes, and a gate
 * that compares one against a budget written the other way is comparing numbers
 * that do not mean the same thing. The machine contract is therefore an integer
 * count of bytes at every point, and a unit only appears when a number is being
 * shown to somebody.
 *
 * The names below come from the canonical resource profile and are not rounded,
 * derived or adjusted here. The budget is the ceiling times seven tenths, taken
 * as exact integer arithmetic rather than as a float that happens to land close.
 */

export const RESOURCE_PROFILE_ID = 'FOUNDING_V1';

/** The container's memory. Crossing this is not a failure to report; it is a process that is gone. */
export const HARD_MEMORY_LIMIT_BYTES = 8_589_934_592;

/** Seven tenths of the ceiling, exactly. What a qualifying run is allowed to reach. */
export const MEMORY_BUDGET_BYTES = 6_012_954_214;

/** The absolute limit on scratch for one job. */
export const HARD_SCRATCH_LIMIT_BYTES = 68_719_476_736;

/** What a qualifying run is allowed to spill. The gate fails before this, not at the hard limit. */
export const SCRATCH_BUDGET_BYTES = 51_539_607_552;

/** Eight hours, in milliseconds. */
export const WALL_CLOCK_LIMIT_MS = 8 * 60 * 60 * 1000;

/**
 * The largest set of rows the engine will hold together as one identity.
 *
 * Two structures in `src/identity/resolve-identity.ts` hold every member of one
 * group at once, and both had to: a merge is decided by comparing its members'
 * values against each other, and a duplicate cluster is reported member by
 * member. Both were unbounded, and the comment above the first said so — "a
 * component larger than memory is still a component larger than memory, and the
 * canonical document says so: it is a limit to declare, not a structure to
 * grow". The limit was never declared, so what the run did with one was exhaust
 * the heap.
 *
 * Reachable with ordinary data, and without any adversary. Grouping by a proving
 * key follows whatever column the operator marked as an authoritative external
 * id, and a legacy export fills the unassigned rows of such a column with `0`,
 * `UNKNOWN`, `TBD` or `NONE` — none of which is in the sentinel list, on
 * purpose. Duplicate clustering needs no configuration at all: one shared
 * mailbox, one switchboard number, or one repeated name puts every row that
 * carries it into a single bucket.
 *
 * A quarter of a million is far above any group that means anything — a real
 * proven merge is a handful of rows, and the largest legitimate duplicate
 * cluster anybody has produced here is in the hundreds — and far below what
 * would exhaust the budget above. A group past it is not a big merge; it is a
 * signal that does not identify anybody, and the run says so and stops rather
 * than dying with a heap trace that names nothing.
 */
export const MAX_IDENTITY_GROUP_MEMBERS = 250_000;

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

/**
 * Bytes as MiB, for showing a person.
 *
 * Never used to decide anything. A displayed value is rounded and a decision
 * made on a rounded value is a decision made on a different number than the one
 * the contract states.
 */
export function displayMib(bytes: number): string {
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

export function displayGib(bytes: number): string {
  return `${(bytes / GIB).toFixed(2)} GiB`;
}

/**
 * `process.resourceUsage().maxRSS`, converted to bytes.
 *
 * Node documents this field in **kibibytes**, and it is the one place in the
 * engine where a unit conversion is unavoidable. It is done here, once, named
 * for what it does, so that no caller has to remember — every caller downstream
 * receives bytes like everything else.
 *
 * The arithmetic never changed; the sentence above it did. It read "kilobytes"
 * from the first commit, which made the multiplication by 1024 look like a
 * rounding somebody had got away with rather than the exact conversion it is.
 * In a file whose entire subject is that a mebibyte is not a megabyte, a comment
 * that says kilo and multiplies by 1024 is the one mistake that costs the reader
 * their trust in every other number here. Node's process documentation states
 * the field in kibibytes on the platforms it supports; re-read 2026-09-04.
 */
export function maxRssToBytes(maxRss: number): number {
  return maxRss * KIB;
}

export interface ResourceProfile {
  readonly id: string;
  readonly hardMemoryLimitBytes: number;
  readonly memoryBudgetBytes: number;
  readonly hardScratchLimitBytes: number;
  readonly scratchBudgetBytes: number;
  readonly wallClockLimitMs: number;
}

export const FOUNDING_V1: ResourceProfile = {
  id: RESOURCE_PROFILE_ID,
  hardMemoryLimitBytes: HARD_MEMORY_LIMIT_BYTES,
  memoryBudgetBytes: MEMORY_BUDGET_BYTES,
  hardScratchLimitBytes: HARD_SCRATCH_LIMIT_BYTES,
  scratchBudgetBytes: SCRATCH_BUDGET_BYTES,
  wallClockLimitMs: WALL_CLOCK_LIMIT_MS,
};
