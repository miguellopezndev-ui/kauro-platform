/**
 * The worker's process allowlist (B14-A; docs/design/B14-A-worker-executor.md §5), loaded with `--import` after the network preload in
 * every worker the local host starts. The worker needs `--allow-child-process` for exactly two programs, so it may start exactly
 * those, and nothing else is spawned from it:
 *
 *   - Node itself under its own permission model (the core's isolated child): its arguments begin with `--permission`, every path it
 *     may read or write is one this worker may itself read or write (so a child never holds more than its parent), it gets no
 *     child-process, worker, addon, WASI or inspector permission, and no NODE_OPTIONS;
 *   - the one browser the host named (`--chromium`), driven over its pipe, never with a flag that turns a sandbox layer off or opens a
 *     debugging port;
 *   - on Windows, taskkill ending the worker's own tree (`/PID <its pid> /T /F`).
 *
 * The permission model refuses `process.binding`, workers, addons and WASI, so the child_process module is the only way to a process:
 * the class behind every asynchronous spawn (`ChildProcess.prototype.spawn`) and the three synchronous exports are wrapped, and a
 * refusal throws `KAURO_PROCESS_REFUSED`. It narrows, and does not replace, the operating-system boundary of a cloud task.
 */
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { basename, join, resolve } from "node:path";

const SANDBOX_OFF = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-seccomp-filter-sandbox", "--disable-gpu-sandbox", "--disable-namespace-sandbox", "--remote-debugging-port", "--remote-debugging-address", "--single-process", "--no-zygote"];

class ProcessRefused extends Error {
  readonly code = "KAURO_PROCESS_REFUSED";
  constructor(file: string) {
    super(`the worker may not start ${basename(file)}`);
    this.name = "ProcessRefused";
  }
}

function argumentOf(flag: string): string | null {
  const at = process.argv.indexOf(flag);
  return at < 0 ? null : (process.argv[at + 1] ?? null);
}

const same = (a: string, b: string): boolean => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

export interface ProcessContext {
  readonly chromium: string | null;
  readonly pid: number;
  readonly execPath: string;
  readonly systemRoot: string | null;
  /** What this process may itself read or write (Node's own permission model: `process.permission.has`). */
  readonly may: (scope: "fs.read" | "fs.write", path: string) => boolean;
}

/** A Node child holds no more than its parent: only fs grants, each within the parent's own. */
function nodeChildAllowed(args: readonly string[], context: ProcessContext): boolean {
  if (args[0] !== "--permission") return false;
  for (const a of args) {
    if (!a.startsWith("--allow-")) continue;
    const read = /^--allow-fs-read=(.+)$/.exec(a);
    const write = /^--allow-fs-write=(.+)$/.exec(a);
    if (read !== null && read[1] !== "*" && context.may("fs.read", read[1] as string)) continue;
    if (write !== null && write[1] !== "*" && context.may("fs.write", write[1] as string)) continue;
    return false;
  }
  return true;
}

/** Whether the worker may start `file` with `args` (args without the program's own name) and `env`. */
export function processAllowed(file: string, args: readonly string[], context: ProcessContext, env: readonly string[] = []): boolean {
  // NODE_OPTIONS would widen a Node child past its flags (a browser ignores it: Playwright hands the browser the worker's environment)
  if (same(file, context.execPath)) return !env.some((pair) => /^NODE_OPTIONS=/i.test(pair)) && nodeChildAllowed(args, context);
  if (context.chromium !== null && same(file, context.chromium)) {
    return args.includes("--remote-debugging-pipe") && !args.some((a) => SANDBOX_OFF.some((f) => a === f || a.startsWith(`${f}=`)) || /^(file|https?|ftp|data):/i.test(a));
  }
  if (process.platform === "win32" && context.systemRoot !== null && same(file, join(context.systemRoot, "System32", "taskkill.exe"))) {
    return args.length === 4 && args[0] === "/PID" && args[1] === String(context.pid) && args[2] === "/T" && args[3] === "/F";
  }
  return false;
}

const permission = (process as unknown as { permission?: { has(scope: string, reference?: string): boolean } }).permission;
const context: ProcessContext = {
  chromium: argumentOf("--chromium"),
  pid: process.pid,
  execPath: process.execPath,
  systemRoot: process.env["SystemRoot"] ?? null,
  may: (scope, path) => permission?.has(scope, path) ?? false,
};
const envPairsOf = (env: unknown): string[] => (env !== null && typeof env === "object" ? Object.entries(env as Record<string, unknown>).map(([k, v]) => `${k}=${String(v)}`) : []);

type Loose = Record<string, unknown>;
// the declarations below run when the module is loaded as the worker's preload; processAllowed is also imported by tests
const proto = (childProcess as unknown as { ChildProcess: { prototype: Loose } }).ChildProcess.prototype;
const originalSpawn = proto["spawn"] as (this: unknown, options: { file?: string; args?: string[] }) => unknown;
proto["spawn"] = function guardedSpawn(this: unknown, options: { file?: string; args?: string[]; envPairs?: string[] }): unknown {
  const file = String(options?.file ?? "");
  // options.args holds the program's own name first (argv0); envPairs the child's environment as KEY=value
  if (!processAllowed(file, (options?.args ?? []).slice(1), context, options?.envPairs ?? [])) throw new ProcessRefused(file);
  return originalSpawn.call(this, options);
};
const module_ = childProcess as unknown as Loose;
for (const name of ["spawnSync", "execFileSync"] as const) {
  const original = module_[name] as (file: string, args?: unknown, options?: unknown) => unknown;
  module_[name] = function guardedSync(file: string, args?: unknown, options?: unknown): unknown {
    const opts = (Array.isArray(args) ? options : args) as { env?: unknown } | undefined;
    if (!processAllowed(String(file), Array.isArray(args) ? (args as string[]) : [], context, envPairsOf(opts?.env))) throw new ProcessRefused(String(file));
    return original(file, args, options);
  };
}
// a shell command line is never one of the allowed programs
module_["execSync"] = function refusedExecSync(command: string): never {
  throw new ProcessRefused(String(command).split(" ")[0] ?? "");
};
syncBuiltinESMExports();
