/**
 * The execution handlers (design B08 §12): CMD036 ExecuteProject and CMD037 CancelJob on B06's pipeline and the GetJob read. The
 * composition root builds them once over the same runtime B06's handlers use (its unit-of-work factory also opens execution units
 * of work).
 */
import type { ExecutionHandlers } from "../contracts.js";
import { cancelJobHandler } from "./cancel-job.js";
import { executeProjectHandler } from "./execute-project.js";
import type { ExecutionRuntime } from "./shared.js";

export function createExecutionHandlers(runtime: ExecutionRuntime): ExecutionHandlers {
  return Object.freeze({
    CMD036: executeProjectHandler(runtime),
    CMD037: cancelJobHandler(runtime),
  });
}

export type { ExecutionRuntime } from "./shared.js";
export { createExecutionReadHandlers, type ExecutionReadHandlers, type ExecutionReadRuntime } from "./reads.js";
