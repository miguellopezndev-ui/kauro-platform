/**
 * Processing authority over `pg` (package B08, mandate B08-PERSISTENCE-EXECUTION): the execution store of the execution unit of
 * work and the readings other packages' ports bind.
 */
export { PgExecutionStore } from "./store.js";
export type { ExecutionWriteContext } from "./store.js";
export { PgExecutionReads, EXECUTION_CAPACITY_DOMAIN } from "./reads.js";
// the control plane's discovery of execution work (mandate B08-CONTROL-EXECUTION)
export { PgExecutionDiscovery } from "./discovery.js";
export type { CheckoutCapacity } from "./reads.js";
