/**
 * One live local host per host root (B14-A; docs/design/B14-A-recovery.md §7): an exclusive name the operating system holds for the
 * process that bound it and releases when that process ends, however it ends. Windows: a named pipe, created with first-instance
 * semantics (libuv's FILE_FLAG_FIRST_PIPE_INSTANCE), so a second server of the same name is refused. Linux: a socket in the abstract
 * namespace, which has no file to go stale and is freed by the kernel with its last descriptor (one machine, one network namespace).
 *
 * So whoever holds the lock is the only process deciding anything about the root's jobs, and a host that acquires it knows the previous
 * holder is gone: no heartbeat, no stamp and no inference of another process's liveness.
 */
import { createHash } from "node:crypto";
import net from "node:net";

export class HostRootInUse extends Error {
  readonly code = "HOST_ROOT_IN_USE";
  constructor(root: string) {
    super(`another live local host holds ${root}`);
    this.name = "HostRootInUse";
  }
}

/** The lock's name for a root (its real path): the same root always names the same lock. */
export function rootLockNameOf(realRoot: string, platform: NodeJS.Platform = process.platform): string {
  const tag = createHash("sha256").update(platform === "win32" ? realRoot.toLowerCase() : realRoot).digest("hex").slice(0, 32);
  if (platform === "win32") return `\\\\.\\pipe\\kauro-local-host-${tag}`;
  if (platform === "linux") return `\0kauro-local-host-${tag}`;
  throw new TypeError(`the local host's root lock needs Windows or Linux, not ${platform}`);
}

export interface HostRootLock {
  /** Releases the lock (the process's end releases it too). */
  release(): Promise<void>;
}

/** Takes the root's lock, or throws HostRootInUse while another live process holds it. */
export async function acquireHostRootLock(realRoot: string): Promise<HostRootLock> {
  const name = rootLockNameOf(realRoot);
  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => reject(error.code === "EADDRINUSE" ? new HostRootInUse(realRoot) : error));
    server.listen(name, () => resolve());
  });
  // the lock never keeps the process alive by itself
  server.unref();
  return {
    release: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
