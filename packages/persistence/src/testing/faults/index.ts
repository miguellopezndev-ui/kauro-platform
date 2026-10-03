/**
 * The common fault harness (docs/design/FAULT-HARNESS.md): a controlled clock, named crash and pause points, deterministic
 * two-actor interleavings observed in pg_stat_activity, duplicates and retries, and failure-matrix cells as tests that can never
 * pass unless their fault demonstrably happened at the boundary they name. Exported from the test-only subpath
 * @kauro/persistence/testing.
 */
export { controlledClock } from "./clock.js";
export type { ControlledClock, ClockMove, ClockUse, InstantLike } from "./clock.js";
export { FaultPoints, SimulatedCrash, simulatedCrashOf, crashedAt, FaultPointNotReached, crashableFactory, instrumentPort, connectionPid, terminateBackend } from "./points.js";
export type { Pause, ArmedCrash, CommitCrash } from "./points.js";
export { InterleavingNotObserved, TransactionNotCommitted, mustWait, inOrder, bothOrders, concurrently, sequentially, partition } from "./interleave.js";
export type { Waiting, WaitProbe, TxActor, ActorOutcome, RaceRun, RaceScenario } from "./interleave.js";
export { FAULT_KINDS, FaultNotInjected, cellTitle, cellKey, runCell, faultCell, faultMatrix } from "./matrix.js";
export type { FaultKind, MatrixCell, FaultContext, CellOptions, CellBody } from "./matrix.js";
