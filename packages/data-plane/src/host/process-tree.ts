/**
 * Ending a worker and everything it started (B14-A; docs/design/B14-A-worker-executor.md §5). A worker starts the core's isolated child
 * and a sandboxed Chromium; a termination by identity must leave none of them running. The tree is collected before anything is
 * killed, because a killed parent's children are re-parented and their link to it is lost:
 *
 * - Linux: the descendants of the pid from /proc (each process's parent), killed with SIGKILL, collected twice to catch a process
 *   started meanwhile, then the worker's process group (the host starts it as a group leader), which still holds a child the tree
 *   walk lost to re-parenting. Playwright starts the browser in a process group of its own, so the group kill alone would miss it;
 *   the browser also ends by itself when its pipe to the dead worker closes.
 * - Windows: `taskkill /PID <pid> /T /F`, which walks the same parent links.
 * - elsewhere: the process group, then the process.
 *
 * In a cloud task the container is the tree (stopping the task ends every process in it); this is the local host's equivalent.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

/** The pid and its descendants on Linux, children before their parents' kill matters not (all receive SIGKILL). */
export function linuxDescendantsOf(pid: number): number[] {
  const parentOf = new Map<number, number>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      // /proc/<pid>/stat: "pid (comm) state ppid ..." — comm may hold spaces and parentheses; the last ")" ends it
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      parentOf.set(Number(name), ppid);
    } catch {
      // the process ended while it was read
    }
  }
  const tree = new Set<number>([pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [child, parent] of parentOf) {
      if (!tree.has(child) && tree.has(parent)) {
        tree.add(child);
        grew = true;
      }
    }
  }
  return [...tree];
}

function systemTool(name: string): string {
  const root = process.env["SystemRoot"] ?? "C:\\Windows";
  return join(root, "System32", name);
}

/** Kills `pid` and its descendants; never throws (a process already gone is the goal reached). */
export function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (platform === "win32") {
    spawnSync(systemTool("taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  if (platform === "linux") {
    for (let pass = 0; pass < 2; pass++) {
      for (const p of linuxDescendantsOf(pid)) {
        try {
          process.kill(p, "SIGKILL");
        } catch {
          // gone already
        }
      }
    }
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // not a group leader, or gone
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // gone already
  }
}

/**
 * A worker ending itself and what it started, from inside its confinement (no /proc): its own process group on POSIX (it was started
 * as the group's leader), its tree through taskkill on Windows.
 */
export function killOwnTree(): void {
  if (process.platform === "win32") {
    spawnSync(systemTool("taskkill.exe"), ["/PID", String(process.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    // not a group leader: the process alone
  }
  process.kill(process.pid, "SIGKILL");
}

/** Whether a process with this pid exists (signal 0); a pid can be reused, so the host never relies on this alone. */
export function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

/** Linux: the fields of /proc/<pid>/stat after the command's name (state first); null when the process is gone. */
function linuxStatOf(pid: number): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}

/**
 * Linux: what /proc says of a pid, telling a process that is gone (no such entry, or a zombie) from one that could not be read
 * (any other failure): RUNNING with its start, GONE, or UNKNOWN — never taken for GONE.
 */
export function linuxProcessOf(pid: number): { readonly state: "RUNNING"; readonly start: string } | { readonly state: "GONE" | "UNKNOWN" } {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { state: code === "ENOENT" || code === "ESRCH" ? "GONE" : "UNKNOWN" };
  }
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const state = fields[0];
  const start = fields[19];
  if (state === "Z" || state === "X") return { state: "GONE" };
  return state === undefined || start === undefined || !/^\d+$/.test(start) ? { state: "UNKNOWN" } : { state: "RUNNING", start };
}

/** Linux: a process's start (clock ticks since boot, stat field 22): with the pid, its identity. Null when it is gone. */
export function linuxStartOf(pid: number): string | null {
  return linuxStatOf(pid)?.[19] ?? null;
}

/** Linux: whether a process runs (exists and is not a zombie waiting for its parent). */
function linuxRunning(pid: number): boolean {
  const state = linuxStatOf(pid)?.[0];
  return state !== undefined && state !== "Z" && state !== "X";
}

const within = (dir: string, path: string): boolean => path === dir || path.startsWith(`${dir}/`);

/**
 * Linux: the processes of this user that belong to an attempt wherever they now sit in the tree (a child re-parented when its parent
 * died, a browser in a session of its own): a working directory inside one of the attempt's directories, or an environment value
 * naming one (the browser's temporary directory, its home inside the attempt). A process this one cannot read is not counted.
 */
export function linuxAttemptProcesses(dirs: readonly string[]): number[] {
  const found: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const cwd = readlinkSync(`/proc/${name}/cwd`);
      if (dirs.some((d) => within(d, cwd))) {
        found.push(Number(name));
        continue;
      }
    } catch {
      // gone, or not this user's
    }
    try {
      const values = readFileSync(`/proc/${name}/environ`, "utf8").split("\0").map((pair) => pair.slice(pair.indexOf("=") + 1));
      if (values.some((v) => dirs.some((d) => within(d, v)))) found.push(Number(name));
    } catch {
      // gone, or not readable
    }
  }
  return found;
}

/**
 * Linux: kills what remains of an attempt's processes once its worker is gone — the worker's process group (when `workerPid` is
 * known to be the worker's: just after its exit, or proved by its command line), every process seen in its
 * tree before (when its start still matches: a pid is reused), and every process marked by the attempt's directories — and answers
 * those still alive afterwards. Elsewhere it answers nothing: on Windows every child of the worker is in the worker's kill-on-close
 * job (the allowlist starts nothing detached), and the browser's own children end with the browser.
 */
export function sweepAttemptProcesses(workerPid: number | null, dirs: readonly string[], known: ReadonlyMap<number, string> = new Map()): number[] {
  if (process.platform !== "linux") return [];
  // the group only when the pid is known to be the worker's (null: a pid that may now be another process's)
  if (workerPid !== null) {
    try {
      process.kill(-workerPid, "SIGKILL");
    } catch {
      // no member of the group is left
    }
  }
  const doomed = new Set<number>(linuxAttemptProcesses(dirs));
  for (const [pid, start] of known) if (linuxStartOf(pid) === start) doomed.add(pid);
  for (const pid of doomed) killProcessTree(pid);
  const left = new Set(linuxAttemptProcesses(dirs).filter(linuxRunning));
  for (const [pid, start] of known) if (linuxStartOf(pid) === start && linuxRunning(pid)) left.add(pid);
  return [...left];
}

/** Whether a process with this pid runs: it exists and, on Linux, is not a zombie its parent has yet to reap. */
export function processRunning(pid: number): boolean {
  return process.platform === "linux" ? Number.isSafeInteger(pid) && pid > 0 && linuxRunning(pid) : processExists(pid);
}

/** Whether any process of the group led by `pid` is alive (POSIX); false elsewhere. */
export function groupAlive(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

/**
 * A process's command line, to tell a worker from whatever process reuses its pid: Linux from /proc, Windows through CIM. Null when no
 * such process exists; undefined when it cannot be read (the caller then knows nothing).
 */
export function processCommandLine(pid: number): string | null | undefined {
  if (!processRunning(pid)) return null;
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
    } catch {
      return processRunning(pid) ? undefined : null;
    }
  }
  if (process.platform === "win32") {
    const r = spawnSync(systemTool(join("WindowsPowerShell", "v1.0", "powershell.exe")), ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { windowsHide: true, encoding: "utf8", timeout: 30_000 });
    if (r.status !== 0) return undefined;
    const line = r.stdout.trim();
    return line === "" ? (processExists(pid) ? undefined : null) : line;
  }
  return undefined;
}
