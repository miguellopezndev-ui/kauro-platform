// Runs the Next.js command line with its anonymous telemetry switched off for this process only (B11 design D-STACK-3: no
// build or run of this repository sends data to a third party, and no global Next.js setting of the host is changed).
// After `build`, the immutable build assets are copied into the standalone server (output: "standalone" leaves them out), so
// .next/standalone/apps/web is the complete deployable server that the container and the browser suite both run.
import { spawn } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const bin = require.resolve("next/dist/bin/next");
const app = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const child = spawn(process.execPath, [bin, ...args], {
  cwd: app,
  stdio: "inherit",
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  if (code === 0 && args[0] === "build") {
    const server = join(app, ".next", "standalone", "apps", "web");
    if (!existsSync(join(server, "server.js"))) {
      console.error("next build produced no standalone server at .next/standalone/apps/web/server.js");
      process.exit(1);
    }
    const target = join(server, ".next", "static");
    rmSync(target, { recursive: true, force: true });
    cpSync(join(app, ".next", "static"), target, { recursive: true });
  }
  process.exit(code ?? 1);
});
