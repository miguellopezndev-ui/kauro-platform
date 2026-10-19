/**
 * Ending a worker and everything it started (B14-A; docs/design/B14-A-recovery.md §7). Only the host that spawned a worker ends it, and
 * only while the worker is that host's unreaped child: then its pid, and the process group it leads, belong to it and to nothing else
 * (the kernel reuses neither while the process is unreaped), so no identity has to be proved from outside. The tree is collected
 * before anything is killed, because a killed parent's children are re-parented and their link to it is lost:
 *
 * - Linux: the descendants of the pid from /proc (each process's parent), killed with SIGKILL, collected twice to catch a process
 *   started meanwhile, then the worker's process group (the host starts it as a group leader), which still holds a child the tree
 *   walk lost to re-parenting. Playwright starts the browser in a process group of its own, so the group kill alone would miss it;
 *   the browser also ends by itself when its pipe to the dead worker closes.
 * - Windows: `taskkill /PID <pid> /T /F`, which walks the same parent links; the worker's own children are also in its kill-on-close
 *   job object (libuv's), which ends them with the worker.
 *
 * In a cloud task the container is the tree (stopping the task ends every process in it); this is the local host's equivalent.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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

/** How long a tree kill may hold its caller (taskkill is synchronous); the job object still ends the worker's own children. */
const TASKKILL_MS = 10_000;

function systemTool(name: string): string {
  const root = process.env["SystemRoot"] ?? "C:\\Windows";
  return join(root, "System32", name);
}

/** Kills `pid` and its descendants — only ever a pid its caller pins (its own unreaped child, or itself); never throws. */
export function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (platform === "win32") {
    spawnSync(systemTool("taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: TASKKILL_MS });
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
    spawnSync(systemTool("taskkill.exe"), ["/PID", String(process.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: TASKKILL_MS });
    return;
  }
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    // not a group leader: the process alone
  }
  process.kill(process.pid, "SIGKILL");
}

/** Whether a process with this pid exists (signal 0): evidence for tests; the host never signals a pid it has only read. */
export function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}
