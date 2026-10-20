// Rebuilds the private-screen review (Order 11) after a change: node tools/review/private/build.mjs. The running review edge must be
// restarted afterwards (it serves the build it started with).
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { linkModules } from "./link.mjs";

linkModules();
const next = join(import.meta.dirname, "..", "..", "..", "apps", "web", "node_modules", "next", "dist", "bin", "next");
const run = spawnSync(process.execPath, [next, "build", import.meta.dirname], { stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
process.exit(run.status ?? 1);
