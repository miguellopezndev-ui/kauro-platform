/**
 * The isolation of the platform's own parsers (decision D-ISO-1, B07-F6; S024; 09 "Scanner coverage" and "Derived data and worker
 * scratch"). Every inspection, counting pass and preview of an untrusted file runs in a child process started with the Node
 * permission model:
 *
 *   node --permission
 *        --allow-fs-read=<this package's code> [--allow-fs-read=<the task's directory>]
 *        --allow-fs-read=<each attempt input> --allow-fs-read=<the attempt scratch> --allow-fs-write=<the attempt scratch>
 *        --disallow-code-generation-from-strings --max-old-space-size=<heap>
 *        --import <preload> <child entry>
 *
 * No --allow-child-process, --allow-worker, --allow-addons, --allow-wasi or --allow-inspector: Node itself refuses those
 * (ERR_ACCESS_DENIED), as it refuses a write outside the scratch; the preload counts every such refusal and records and refuses
 * every network entry point, which the permission model does not govern. The child gets an empty environment (no credential can
 * be inherited), the scratch as its working directory, a bounded heap and a wall-clock limit, and returns one result record.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RESULT_MARK, type IsolationObservers, type SandboxFailure, type SandboxJob, type SandboxRecord } from "./observers.js";

/** This package's compiled sources (dist/src): the code the child may read. */
export const SANDBOX_CODE_ROOT = realpathSync.native(join(dirname(fileURLToPath(import.meta.url)), ".."));
const CHILD_ENTRY = join(SANDBOX_CODE_ROOT, "sandbox", "child.js");
const PRELOAD = join(SANDBOX_CODE_ROOT, "sandbox", "preload.js");
const STDOUT_LIMIT = 256 * 1024 * 1024;
const STDERR_TAIL = 8 * 1024;

export interface SandboxRequest {
  /** Absolute path of the task module (ESM) exporting `run(payload, { workDir })`. */
  readonly task: string;
  /** JSON payload handed to the task. */
  readonly payload: unknown;
  /** The attempt inputs (files or directories) the child may read. */
  readonly readPaths: ReadonlyArray<string>;
  /** The attempt scratch: the only directory the child may write (and read back). */
  readonly workDir: string;
  readonly timeoutMs: number;
  readonly heapMegabytes: number;
}

export interface SandboxResult<T> {
  readonly outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: SandboxFailure } | undefined;
  readonly observers: IsolationObservers;
  readonly timedOut: boolean;
  readonly memoryExhausted: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** The permission flags the child ran under (evidence of the isolation). */
  readonly flags: ReadonlyArray<string>;
}

function isInside(root: string, path: string): boolean {
  const r = relative(root, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/** The exact command-line flags of an isolated child (exported so tests can show what the isolation is). */
export function sandboxFlags(request: Pick<SandboxRequest, "task" | "readPaths" | "workDir" | "heapMegabytes">): string[] {
  const reads = [SANDBOX_CODE_ROOT];
  const taskDir = dirname(request.task);
  if (!isInside(SANDBOX_CODE_ROOT, taskDir)) reads.push(taskDir);
  for (const p of request.readPaths) reads.push(p);
  reads.push(request.workDir);
  return [
    "--permission",
    ...reads.map((p) => `--allow-fs-read=${p}`),
    `--allow-fs-write=${request.workDir}`,
    "--disallow-code-generation-from-strings",
    `--max-old-space-size=${request.heapMegabytes}`,
    "--import",
    pathToFileURL(PRELOAD).href,
  ];
}

/** Runs one task in an isolated child and returns its record, the observers and how the child ended. */
export function runIsolated<T>(request: SandboxRequest): Promise<SandboxResult<T>> {
  const flags = sandboxFlags(request);
  const env: Record<string, string> = {};
  // Windows resolves its system libraries through SystemRoot; nothing else of the parent's environment reaches the child
  const systemRoot = process.env["SystemRoot"];
  if (systemRoot !== undefined) env["SystemRoot"] = systemRoot;
  const child = spawn(process.execPath, [...flags, CHILD_ENTRY], { cwd: request.workDir, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const job: SandboxJob = { task: request.task, payload: request.payload, workDir: request.workDir };
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = "";
    let timedOut = false;
    let overflow = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, request.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > STDOUT_LIMIT) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err = (err + chunk.toString("utf8")).slice(-STDERR_TAIL);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.on("error", () => {
      // the child may exit before reading its job (it is killed or refused); its exit is reported below
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString("utf8");
      const line = text.split("\n").find((l) => l.startsWith(RESULT_MARK));
      const record = line !== undefined && !overflow ? (JSON.parse(line.slice(RESULT_MARK.length)) as SandboxRecord) : undefined;
      resolve({
        outcome: record?.outcome as SandboxResult<T>["outcome"],
        observers: record?.observers ?? { outsideWriteAttempts: 0, networkAttempts: 0, processAttempts: 0, network: [] },
        timedOut,
        memoryExhausted: /heap out of memory|Allocation failed/i.test(err),
        exitCode,
        signal,
        flags,
      });
    });
    child.stdin.end(JSON.stringify(job));
  });
}
