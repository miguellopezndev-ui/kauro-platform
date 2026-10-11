/**
 * The parent side of the core child (B05 D5-2, D5-2b): spawns the core child under the Node permission model with the isolation
 * preload (network refused and observed) and the fs preload (metered), an empty environment, the call directory as its only
 * writable directory and a bounded heap, feeds it one job line, follows its progress points, and ends it with SIGKILL when the
 * caller's signal aborts (cancellation, fence, deadline). The child's result record is read only after the child has exited; a
 * kill drops it (late results are dropped).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RESULT_MARK, type IsolationObservers, type SandboxFailure, type SandboxRecord } from "../sandbox/observers.js";
import { SANDBOX_CODE_ROOT, sandboxFlags } from "../sandbox/runner.js";
import { PROGRESS_MARK, type CoreChildJob } from "./child-protocol.js";

const CORE_CHILD_ENTRY = join(SANDBOX_CODE_ROOT, "cores", "core-child.js");
const FS_PRELOAD = join(SANDBOX_CODE_ROOT, "cores", "child-preload-fs.js");
const STDOUT_LIMIT = 256 * 1024 * 1024;
const STDERR_TAIL = 8 * 1024;

export interface CoreChildHandle {
  readonly pid: number | undefined;
  kill(): void;
}

export interface CoreChildRequest {
  /** Absolute path of the task module (ESM) exporting `run(payload, context)`. */
  readonly task: string;
  readonly payload: unknown;
  /** Extra read-only paths (the attempt's inputs). */
  readonly readPaths: readonly string[];
  /** The call directory: the only writable directory, the working directory. */
  readonly callDir: string;
  readonly quotaBytes: number;
  readonly heapMegabytes: number;
  readonly pausePoints?: readonly string[];
  /** Called for every progress point; the child is released when the returned promise settles (a rejection is swallowed). */
  readonly onProgress?: (point: string, child: CoreChildHandle) => Promise<void> | void;
  readonly signal?: AbortSignal;
}

export interface CoreChildResult {
  readonly outcome: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: SandboxFailure } | undefined;
  readonly observers: IsolationObservers;
  /** True when the caller's signal ended the child. */
  readonly killed: boolean;
  readonly memoryExhausted: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly flags: readonly string[];
  readonly progress: readonly string[];
}

function packageRootOf(file: string): string {
  let dir = dirname(realpathSync.native(file));
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package.json above ${file}`);
    dir = parent;
  }
}

let cachedCodePaths: readonly string[] | undefined;

/**
 * The read-only code paths the core child needs beyond this package's dist: the Migration Core wrapper, the core it wraps, and the
 * workspace packages the platform scratch store imports at run time (resolved to their real directories, never a link).
 */
export function coreChildCodePaths(): readonly string[] {
  if (cachedCodePaths !== undefined) return cachedCodePaths;
  const roots = new Set<string>();
  for (const specifier of ["@kauro/migration-core", "@kauro/domain", "@kauro/contracts"]) roots.add(packageRootOf(fileURLToPath(import.meta.resolve(specifier))));
  const wrapperRoot = packageRootOf(fileURLToPath(import.meta.resolve("@kauro/migration-core")));
  const rawRoot = packageRootOf(createRequire(join(wrapperRoot, "package.json")).resolve("kauro-migration-core"));
  // the raw core and its own dependencies sit side by side in its pnpm virtual-store node_modules directory
  roots.add(rawRoot);
  roots.add(dirname(rawRoot));
  const rawManifest = JSON.parse(readFileSync(join(rawRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const fromRaw = createRequire(join(rawRoot, "package.json"));
  for (const dependency of Object.keys(rawManifest.dependencies ?? {})) roots.add(packageRootOf(fromRaw.resolve(dependency)));
  // the permission model checks the path Node opened, which may be the workspace link: grant the link directories too
  const own = packageRootOf(fileURLToPath(import.meta.url));
  for (const specifier of ["@kauro/migration-core", "@kauro/domain", "@kauro/contracts"]) {
    const link = join(own, "node_modules", ...specifier.split("/"));
    if (existsSync(link)) roots.add(link);
  }
  cachedCodePaths = [...roots];
  return cachedCodePaths;
}

/** The exact command-line flags of a core child (exported so a test can show what the isolation is). */
export function coreChildFlags(request: Pick<CoreChildRequest, "readPaths" | "callDir" | "heapMegabytes">): string[] {
  return [
    ...sandboxFlags({ task: CORE_CHILD_ENTRY, readPaths: [...coreChildCodePaths(), ...request.readPaths], workDir: request.callDir, heapMegabytes: request.heapMegabytes }),
    "--import",
    pathToFileURL(FS_PRELOAD).href,
  ];
}

export function runCoreChild(request: CoreChildRequest): Promise<CoreChildResult> {
  const flags = coreChildFlags(request);
  const env: Record<string, string> = {};
  const systemRoot = process.env["SystemRoot"];
  if (systemRoot !== undefined) env["SystemRoot"] = systemRoot;
  const child = spawn(process.execPath, [...flags, CORE_CHILD_ENTRY], { cwd: request.callDir, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const handle: CoreChildHandle = { pid: child.pid, kill: () => void child.kill("SIGKILL") };
  const job: CoreChildJob = { task: request.task, payload: request.payload, workDir: request.callDir, quotaBytes: request.quotaBytes, pausePoints: request.pausePoints ?? [] };
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    let killed = false;
    let overflow = false;
    let pending = "";
    const progress: string[] = [];
    const kill = (): void => {
      killed = true;
      child.kill("SIGKILL");
    };
    if (request.signal !== undefined) {
      if (request.signal.aborted) kill();
      else request.signal.addEventListener("abort", kill, { once: true });
    }
    const follow = (text: string): void => {
      pending += text;
      for (;;) {
        const at = pending.indexOf("\n");
        if (at < 0) break;
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        if (!line.startsWith(PROGRESS_MARK)) continue;
        const point = line.slice(PROGRESS_MARK.length);
        progress.push(point);
        void Promise.resolve(request.onProgress?.(point, handle))
          .catch(() => undefined)
          .then(() => {
            if (!killed && child.stdin.writable) child.stdin.write("ACK\n");
          });
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > STDOUT_LIMIT) {
        overflow = true;
        kill();
        return;
      }
      out.push(chunk);
      follow(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err = (err + chunk.toString("utf8")).slice(-STDERR_TAIL);
    });
    child.on("error", (error) => {
      request.signal?.removeEventListener("abort", kill);
      reject(error);
    });
    child.stdin.on("error", () => {
      // the child may exit before reading (killed or refused); its exit is reported below
    });
    child.on("close", (exitCode, signal) => {
      request.signal?.removeEventListener("abort", kill);
      const text = Buffer.concat(out).toString("utf8");
      const line = text.split("\n").find((l) => l.startsWith(RESULT_MARK));
      const record = line !== undefined && !overflow && !killed ? (JSON.parse(line.slice(RESULT_MARK.length)) as SandboxRecord) : undefined;
      resolve({
        outcome: record?.outcome as CoreChildResult["outcome"],
        observers: record?.observers ?? { outsideWriteAttempts: 0, networkAttempts: 0, processAttempts: 0, network: [] },
        killed,
        memoryExhausted: /heap out of memory|Allocation failed/i.test(err),
        exitCode,
        signal,
        flags,
        progress,
      });
    });
    child.stdin.write(`${JSON.stringify(job)}\n`);
  });
}
