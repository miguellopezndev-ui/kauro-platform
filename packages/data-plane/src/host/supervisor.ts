/**
 * The attempt's supervisor (B14-A; docs/design/B14-A-worker-executor.md §5): a small process the local host starts beside each worker,
 * outside the worker's confinement and holding no customer data, that ends the worker's whole tree without the worker's cooperation:
 *
 *   - when the host dies (its pipe to the supervisor closes) — even a worker stuck in synchronous work, whose own disconnect handler
 *     cannot run, is ended;
 *   - at the attempt's deadline plus a grace, whether or not the host still lives;
 *   - when the attempt's resident memory passes its hard memory (Linux: the VmRSS from /proc of the worker's tree, of every process
 *     seen in it before and of every process the attempt's directories mark; Chromium and every native
 *     allocation included), or the attempt's directories pass its hard scratch (any write, the browser's profile and temporary files
 *     included, and on Linux the files the tree still holds open after removing their names).
 *
 * It records its one verdict exclusively in the job's directory (`supervisor.json`), which the host reads to classify the worker's end
 * and a later host instance reads as proof that the tree was ended. It reads no clock: every bound is a duration it was handed.
 * Run as `node supervisor.js <config JSON>`; its stdin is the host's pipe ("EXITED\n": the worker ended).
 *
 * The worker's end is not the attempt's: whenever the worker is gone (it exited, the host said so, or the supervisor ended it), the
 * supervisor sweeps what the worker left — on Linux its process group, every process it saw in the worker's tree (by pid and start),
 * and every process the attempt's directories mark (sweepAttemptProcesses) — and leaves only once none is left, or after a bounded
 * number of sweeps.
 */
import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { killProcessTree, linuxAttemptProcesses, linuxDescendantsOf, linuxStartOf, processExists, processRunning, sweepAttemptProcesses } from "./process-tree.js";

export const SUPERVISOR_VERDICTS = ["HOST_LOST", "DEADLINE", "MEMORY_EXHAUSTED", "SCRATCH_EXHAUSTED"] as const;
export type SupervisorVerdict = (typeof SUPERVISOR_VERDICTS)[number];
export const SUPERVISOR_FILE = "supervisor.json";
/** What the supervisor writes on its stdout once it watches: the host gives the worker its ticket only then. */
export const SUPERVISOR_READY = "SUPERVISING\n";

export interface SupervisorConfig {
  readonly workerPid: number;
  /** The worker's start (Linux, recorded by the host at spawn): the pid is the worker's only while it matches (review R4-2). */
  readonly workerStart: string | null;
  readonly jobDir: string;
  /** The attempt's directory and the browser's temporary one: their bytes together are the attempt's scratch. */
  readonly scratchDirs: readonly string[];
  /** From the supervisor's start to the attempt's deadline, plus the grace (milliseconds). */
  readonly deadlineInMs: number;
  readonly hardMemoryBytes: number;
  readonly hardScratchBytes: number;
  readonly pollMs: number;
}

/** The resident memory of processes on Linux (the sum of their VmRSS); null elsewhere. */
export function residentBytesOf(pids: readonly number[], platform: NodeJS.Platform = process.platform): number | null {
  if (platform !== "linux") return null;
  let total = 0;
  for (const p of new Set(pids)) {
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

/**
 * Linux: the bytes of files the tree holds open after their names were removed (review round 3, R3-3). They still take the disk, and
 * no directory walk finds them. Memory-backed ones (/dev/shm, memfd) are the memory's, which the tree's resident memory counts.
 */
export function openDeletedBytes(pids: readonly number[], platform: NodeJS.Platform = process.platform): number {
  if (platform !== "linux") return 0;
  const seen = new Set<string>();
  let total = 0;
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        if (!target.startsWith("/") || !target.endsWith(" (deleted)") || target.startsWith("/dev/shm/")) continue;
        const st = statSync(`/proc/${pid}/fd/${fd}`);
        const key = `${st.dev}:${st.ino}`;
        if (!st.isFile() || seen.has(key)) continue;
        seen.add(key);
        total += Math.max(st.size, st.blocks * 512);
      } catch {
        // closed meanwhile
      }
    }
  }
  return total;
}

/**
 * Writes the supervisor's one verdict, exclusively: true when it was written. The file is also the host's standing down
 * (standDownOrVerdict): of a verdict and the host's reading of the worker's end, the first written decides, and a supervisor whose
 * verdict came second ends nothing.
 */
export function recordVerdict(jobDir: string, verdict: SupervisorVerdict, detail: Record<string, number>): boolean {
  try {
    writeFileSync(join(jobDir, SUPERVISOR_FILE), JSON.stringify({ verdict, ...detail }), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/** The host stands its supervisor down for good, unless a verdict came first: then that verdict (null when the host's came first). */
export function standDownOrVerdict(jobDir: string): SupervisorVerdict | null {
  try {
    writeFileSync(join(jobDir, SUPERVISOR_FILE), JSON.stringify({ verdict: "STOOD_DOWN" }), { flag: "wx" });
    return null;
  } catch {
    return readVerdict(jobDir)?.verdict ?? null;
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

/** How many sweeps, a poll apart, the supervisor makes before it leaves with processes it could not end. */
const SWEEPS = 20;

export function supervise(config: SupervisorConfig, input: NodeJS.ReadableStream, exit: (code: number) => void, ready: () => void = () => undefined): void {
  let done = false;
  const pid = config.workerPid;
  // the pid is the worker's while it runs and (Linux) its start is the one recorded at the spawn; a reused pid is never signalled
  const isWorker = (): boolean => processRunning(pid) && (process.platform !== "linux" || config.workerStart === null || linuxStartOf(pid) === config.workerStart);
  // the worker's group is swept while the pid is the worker's or names no process at all (a pid in use as a group id is not reused)
  const groupOf = (): number | null => (isWorker() || !processExists(pid) ? pid : null);
  // every process seen in the worker's tree, with its start (Linux): one re-parented after its parent died is still the attempt's
  const known = new Map<number, string>();
  const sweep = (left: number): void => {
    if (sweepAttemptProcesses(groupOf(), config.scratchDirs, known).length === 0 || left <= 1) return exit(0);
    setTimeout(() => sweep(left - 1), config.pollMs);
  };
  const end = (verdict: SupervisorVerdict | null, detail: Record<string, number> = {}): void => {
    if (done) return;
    done = true;
    // a verdict ends the tree only when it was written first (the host may have stood the supervisor down already)
    if (verdict !== null && recordVerdict(config.jobDir, verdict, detail) && isWorker()) killProcessTree(pid);
    sweep(SWEEPS);
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
    if (!isWorker()) return void setTimeout(() => end(hostGone ? "HOST_LOST" : null), 1_000);
    // the attempt's processes (Linux): the worker's tree as it stands, every process seen in it before whose start still matches (one
    // re-parented when its parent ended), and every process the attempt's directories mark (review round 5, R5-3)
    const owned = new Set<number>();
    if (process.platform === "linux") {
      for (const p of linuxDescendantsOf(pid)) {
        owned.add(p);
        const start = linuxStartOf(p);
        if (p !== pid && start !== null && !known.has(p)) known.set(p, start);
      }
      for (const [p, start] of known) if (linuxStartOf(p) === start) owned.add(p);
      for (const p of linuxAttemptProcesses(config.scratchDirs)) owned.add(p);
    }
    const rss = residentBytesOf([...owned]);
    if (rss !== null && rss > config.hardMemoryBytes) return end("MEMORY_EXHAUSTED", { residentBytes: rss });
    const scratch = config.scratchDirs.reduce((sum, dir) => sum + directoryBytes(dir), 0) + openDeletedBytes([...owned]);
    if (scratch > config.hardScratchBytes) return end("SCRATCH_EXHAUSTED", { scratchBytes: scratch });
    return undefined;
  }, config.pollMs);
  // every watch is set: the host may now give the worker its ticket
  ready();
}

// run as a process
const argument = process.argv[2];
if (argument !== undefined && process.argv[1] !== undefined && /supervisor\.js$/.test(process.argv[1])) {
  supervise(
    JSON.parse(argument) as SupervisorConfig,
    process.stdin,
    (code) => process.exit(code),
    () => void process.stdout.write(SUPERVISOR_READY),
  );
}
