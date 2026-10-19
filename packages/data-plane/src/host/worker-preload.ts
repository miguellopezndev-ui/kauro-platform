/**
 * The worker's process allowlist (B14-A; docs/design/B14-A-worker-executor.md §5), loaded with `--import` after the network preload in
 * every worker the local host starts. The worker needs `--allow-child-process` for exactly two programs, so it may start exactly
 * those, and nothing else is spawned from it:
 *
 *   - Node itself, as exactly the core's isolated child (core-child-runner.ts) and nothing else: the closed command line
 *     `--permission`, read grants, one write grant, `--disallow-code-generation-from-strings`, a heap no larger than the worker's
 *     `--core-heap-mb`, the network preload, the fs preload and the core child's entry, in that order and with nothing after it. Every
 *     path it may read or write is one this worker may itself read or write (so a child never holds more than its parent); no other
 *     option of any kind (a negation such as `--no-permission`, an `-e` script, another entry), no environment but `SystemRoot`, no
 *     shell and no detached process;
 *   - the one browser the host named (`--chromium`), driven over its pipe, never with a flag that turns a sandbox layer off or opens a
 *     debugging port;
 *   - on Windows, taskkill ending the worker's own tree (`/PID <its pid> /T /F`).
 *
 * The permission model refuses `process.binding`, workers, addons and WASI, so the child_process module is the only way to a process:
 * the class behind every asynchronous spawn (`ChildProcess.prototype.spawn`, which sees a shell request already turned into the shell's
 * own command line) and the three synchronous exports are wrapped (a `shell` option refused outright), `process.execve` is removed, and
 * a refusal throws `KAURO_PROCESS_REFUSED`. On Windows no process is started detached, so every child stays in the worker's
 * kill-on-close job. It narrows, and does not replace, the operating-system boundary of a cloud task.
 */
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/** The data plane's compiled code (as sandbox/runner.ts's SANDBOX_CODE_ROOT) and, in it, the one Node child a worker may start. */
const CODE_ROOT = realpathSync.native(join(dirname(fileURLToPath(import.meta.url)), ".."));
export const CORE_CHILD_COMMAND = {
  networkPreload: pathToFileURL(join(CODE_ROOT, "sandbox", "preload.js")).href,
  fsPreload: pathToFileURL(join(CODE_ROOT, "cores", "child-preload-fs.js")).href,
  entry: join(CODE_ROOT, "cores", "core-child.js"),
} as const;

export interface SpawnRequest {
  readonly env: readonly string[];
  readonly shell: boolean;
  readonly detached: boolean;
}

export interface ProcessContext {
  readonly chromium: string | null;
  /** The largest heap a core child may have (the worker's `--core-heap-mb`). */
  readonly coreHeapMegabytes: number;
  readonly pid: number;
  readonly execPath: string;
  readonly systemRoot: string | null;
  /** What this process may itself read or write (Node's own permission model: `process.permission.has`). */
  readonly may: (scope: "fs.read" | "fs.write", path: string) => boolean;
}

/** The core child's closed command line (core-child-runner.ts's coreChildFlags and entry), its grants within the parent's own. */
function nodeChildAllowed(args: readonly string[], context: ProcessContext): boolean {
  let i = 0;
  if (args[i++] !== "--permission") return false;
  let reads = 0;
  for (let read = /^--allow-fs-read=(.+)$/.exec(args[i] ?? ""); read !== null; read = /^--allow-fs-read=(.+)$/.exec(args[++i] ?? "")) {
    if (read[1] === "*" || !context.may("fs.read", read[1] as string)) return false;
    reads += 1;
  }
  const write = /^--allow-fs-write=(.+)$/.exec(args[i++] ?? "");
  if (reads === 0 || write === null || write[1] === "*" || !context.may("fs.write", write[1] as string)) return false;
  if (args[i++] !== "--disallow-code-generation-from-strings") return false;
  const heap = /^--max-old-space-size=([1-9][0-9]*)$/.exec(args[i++] ?? "");
  if (heap === null || Number(heap[1]) > context.coreHeapMegabytes) return false;
  if (args[i++] !== "--import" || args[i++] !== CORE_CHILD_COMMAND.networkPreload) return false;
  if (args[i++] !== "--import" || args[i++] !== CORE_CHILD_COMMAND.fsPreload) return false;
  const entry = args[i++];
  return entry !== undefined && same(entry, CORE_CHILD_COMMAND.entry) && i === args.length;
}

/** Whether the worker may start `file` with `args` (args without the program's own name), as `request` asks. */
export function processAllowed(file: string, args: readonly string[], context: ProcessContext, request: SpawnRequest = { env: [], shell: false, detached: false }): boolean {
  // a shell runs whatever its command line says; a detached process leaves the worker's job (Windows) or its process group (POSIX)
  if (request.shell) return false;
  if (request.detached && process.platform === "win32") return false;
  // a Node child: nothing of the environment but SystemRoot (NODE_OPTIONS or any NODE_* variable would change what its flags say)
  if (same(file, context.execPath)) return !request.detached && request.env.every((pair) => /^SystemRoot=/i.test(pair)) && nodeChildAllowed(args, context);
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
  coreHeapMegabytes: Number(argumentOf("--core-heap-mb") ?? 0),
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
proto["spawn"] = function guardedSpawn(this: unknown, options: { file?: string; args?: string[]; envPairs?: string[]; detached?: boolean }): unknown {
  const file = String(options?.file ?? "");
  // options.args holds the program's own name first (argv0); envPairs the child's environment as KEY=value; a shell request has
  // already become the shell's own command line here, which no rule admits
  if (!processAllowed(file, (options?.args ?? []).slice(1), context, { env: options?.envPairs ?? [], shell: false, detached: options?.detached === true })) throw new ProcessRefused(file);
  return originalSpawn.call(this, options);
};
const module_ = childProcess as unknown as Loose;
for (const name of ["spawnSync", "execFileSync"] as const) {
  const original = module_[name] as (file: string, args?: unknown, options?: unknown) => unknown;
  module_[name] = function guardedSync(file: string, args?: unknown, options?: unknown): unknown {
    const opts = (Array.isArray(args) ? options : args) as { env?: unknown; shell?: unknown; detached?: unknown } | undefined;
    // no env option: the child gets this process's whole environment
    const request: SpawnRequest = { env: envPairsOf(opts?.env ?? process.env), shell: opts?.shell !== undefined && opts.shell !== false, detached: opts?.detached === true };
    if (!processAllowed(String(file), Array.isArray(args) ? (args as string[]) : [], context, request)) throw new ProcessRefused(String(file));
    return original(file, args, options);
  };
}
// a shell command line is never one of the allowed programs
module_["execSync"] = function refusedExecSync(command: string): never {
  throw new ProcessRefused(String(command).split(" ")[0] ?? "");
};
// replacing this process's own image (Node 23.11+) would run any program in the worker's place
Object.defineProperty(process, "execve", {
  value: function refusedExecve(file: string): never {
    throw new ProcessRefused(String(file));
  },
  writable: false,
  configurable: false,
});
syncBuiltinESMExports();
