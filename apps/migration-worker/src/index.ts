/**
 * @kauro/migration-worker — the worker of one processing attempt (B14-A; docs/design/B14-A-worker-executor.md). `src/main.ts` is the
 * process entry a host starts (the local process host of @kauro/data-plane, or a container's command); this module exports what a
 * composition needs to find and describe it.
 */
import { fileURLToPath } from "node:url";

export { parseWorkerArguments, type WorkerArguments } from "./arguments.js";

/** The absolute path of the worker's entry module (what a host passes as `workerEntry`). */
export const MIGRATION_WORKER_ENTRY = fileURLToPath(new URL("./main.js", import.meta.url));
