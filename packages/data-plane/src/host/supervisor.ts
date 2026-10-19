/**
 * The attempt's supervisor (B14-A; docs/design/B14-A-worker-executor.md §5): a small process the local host starts beside each worker,
 * outside the worker's confinement and holding no customer data, that ends the worker's whole tree without the worker's cooperation:
 *
 *   - when the host dies (its pipe to the supervisor closes) — even a worker stuck in synchronous work, whose own disconnect handler
 *     cannot run, is ended;
 *   - at the attempt's deadline plus a grace, whether or not the host still lives;
 *   - when the tree's resident memory passes the attempt's hard memory (Linux: the tree's VmRSS from /proc, Chromium and every native
 *     allocation included), or the attempt's directories pass its hard scratch (any write, the browser's profile and temporary files
 *     included).
 *
 * It records its one verdict exclusively in the job's directory (`supervisor.json`), which the host reads to classify the worker's end
 * and a later host instance reads as proof that the tree was ended. It reads no clock: every bound is a duration it was handed.
 * Run as `node supervisor.js <config JSON>`; its stdin is the host's pipe ("EXITED\n": the worker ended, stand down).
 */
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { killProcessTree, linuxDescendantsOf, processExists } from "./process-tree.js";

export const SUPERVISOR_VERDICTS = ["HOST_LOST", "DEADLINE", "MEMORY_EXHAUSTED", "SCRATCH_EXHAUSTED"] as const;
export type SupervisorVerdict = (typeof SUPERVISOR_VERDICTS)[number];
export const SUPERVISOR_FILE = "supervisor.json";

export interface SupervisorConfig {
  readonly workerPid: number;
  readonly jobDir: string;
  /** The attempt's directory and the browser's temporary one: their bytes together are the attempt's scratch. */
  readonly scratchDirs: readonly string[];
  /** From the supervisor's start to the attempt's deadline, plus the grace (milliseconds). */
  readonly deadlineInMs: number;
  readonly hardMemoryBytes: number;
  readonly hardScratchBytes: number;
  readonly pollMs: number;
}

/** The tree's resident memory on Linux (VmRSS of the worker and its descendants); null elsewhere. */
export function treeResidentBytes(pid: number, platform: NodeJS.Platform = process.platform): number | null {
  if (platform !== "linux") return null;
  let total = 0;
  for (const p of linuxDescendantsOf(pid)) {
    try {
      const kb = /^VmRSS:\s+(\d+)\s+kB/m.exec(readFileSync(`/proc/${p}/status`, "utf8"))?.[1];
      if (kb !== undefined) total += Number(kb) * 1024;
    } catch {
      // gone
    }
  }
  return total;
}

/** The bytes under a directory, never following a link. */
export function directoryBytes(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const path = join(dir, name);
    try {
      const st = lstatSync(path);
      if (st.isDirectory()) total += directoryBytes(path);
      else total += st.size;
    } catch {
      // removed meanwhile
    }
  }
  return total;
}

/** Writes the supervisor's one verdict; the first verdict stands. */
export function recordVerdict(jobDir: string, verdict: SupervisorVerdict, detail: Record<string, number>): void {
  try {
    writeFileSync(join(jobDir, SUPERVISOR_FILE), JSON.stringify({ verdict, ...detail }), { flag: "wx" });
  } catch {
    // a verdict exists already
  }
}

export function readVerdict(jobDir: string): { readonly verdict: SupervisorVerdict } | null {
  try {
    const v = JSON.parse(readFileSync(join(jobDir, SUPERVISOR_FILE), "utf8")) as { verdict?: unknown };
    return (SUPERVISOR_VERDICTS as readonly unknown[]).includes(v.verdict) ? (v as { verdict: SupervisorVerdict }) : null;
  } catch {
    return null;
  }
}

export function supervise(config: SupervisorConfig, input: NodeJS.ReadableStream, exit: (code: number) => void): void {
  let done = false;
  const end = (verdict: SupervisorVerdict | null, detail: Record<string, number> = {}): void => {
    if (done) return;
    done = true;
    if (verdict !== null) {
      recordVerdict(config.jobDir, verdict, detail);
      killProcessTree(config.workerPid);
    }
    exit(0);
  };
  let hostGone = false;
  let buffered = "";
  input.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    if (buffered.includes("EXITED\n")) end(null);
  });
  // the host's pipe closed without its word: the host is gone, and so must its worker be
  const lost = (): void => {
    hostGone = true;
    end("HOST_LOST");
  };
  input.on("end", lost);
  input.on("close", lost);
  input.on("error", lost);
  setTimeout(() => end("DEADLINE"), Math.max(0, Math.min(config.deadlineInMs, 2_147_483_647)));
  setInterval(() => {
    // the worker is gone: a host that died with it (on Windows its job object ends the tree with the host) is still recorded
    if (!processExists(config.workerPid)) return void setTimeout(() => end(hostGone ? "HOST_LOST" : null), 1_000);
    const rss = treeResidentBytes(config.workerPid);
    if (rss !== null && rss > config.hardMemoryBytes) return end("MEMORY_EXHAUSTED", { residentBytes: rss });
    const scratch = config.scratchDirs.reduce((sum, dir) => sum + directoryBytes(dir), 0);
    if (scratch > config.hardScratchBytes) return end("SCRATCH_EXHAUSTED", { scratchBytes: scratch });
    return undefined;
  }, config.pollMs);
}

// run as a process
const argument = process.argv[2];
if (argument !== undefined && process.argv[1] !== undefined && /supervisor\.js$/.test(process.argv[1])) {
  supervise(JSON.parse(argument) as SupervisorConfig, process.stdin, (code) => process.exit(code));
}
