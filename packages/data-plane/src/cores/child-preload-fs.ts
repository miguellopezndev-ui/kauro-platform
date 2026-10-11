/**
 * The fs preload of the core child (B05 D5-2c (2)): loaded with `--import` after the isolation preload, it replaces every function
 * export of node:fs and node:fs/promises by the metered, controlled, credited or refusing version of fs-meter.ts and syncs the ESM
 * named exports, so `import { writeSync } from "node:fs"` anywhere in the child (the platform AttemptScratchStore's device, the
 * core's own writers) is the metered one. The ledger starts with a zero budget: nothing is writable until the child entry calls
 * `configure` with its quota. Loaded inside the child: node built-ins and this package's own modules only.
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { FS_METER_KEY } from "./child-protocol.js";
import { installFsMeter } from "./fs-meter.js";

const meter = installFsMeter(fs as unknown as Record<string, unknown>, fsPromises as unknown as Record<string, unknown>);
Object.defineProperty(globalThis, FS_METER_KEY, { value: meter, enumerable: false, configurable: false, writable: false });
syncBuiltinESMExports();
